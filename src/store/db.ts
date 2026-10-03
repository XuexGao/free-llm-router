/**
 * 存储抽象：DO SQLite 之上的极薄封装。
 *
 * ## 为什么不用 KV
 *
 * AGENTS.md §8.2.3 定案：**Free 计划的 KV 只有 1,000 写/天**，且是**最终一致**
 * （≤60s 全局同步）。账号冷却/熔断/租约需要**强一致 + 高频写**，KV 两条都不满足。
 * 故全部状态落在 **DO SQLite**（天然强一致 + 单线程串行）。
 *
 * ## 设计纪律
 *
 * 1. **一次调用 = 一步**（AGENTS.md §8.2.2）：这里的每个方法都只做**一次**
 *    SQLite 往返，不做批量循环。批量遍历由调用方在多次 alarm 里分片完成。
 * 2. **不整包读写**：账号状态按 uid 逐条存取，不把整池序列化成一个大 JSON
 *    （那样每次选号都要反序列化全池，10ms CPU 预算吃不消）。
 */

/**
 * DO SQLite 的类型别名。
 *
 * ⚠️ **不要自己手写这个接口**：最初版本为了让单测能提供替身而自定义了一个
 * `exec<T>(...): SqlCursor<T>`，结果与平台真实签名（`exec<T extends
 * Record<string, SqlStorageValue>>`）**不兼容**，所有调用点都报类型错误。
 * 平台类型本身已经是结构化接口，单测替身照它的形状实现即可。
 */
export type SqlStorage = DurableObjectStorage['sql']

/** 创建表结构。幂等，可在构造时安全重复调用。 */
export function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      uid       TEXT PRIMARY KEY,
      realm     TEXT NOT NULL DEFAULT 'cn',
      state     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_realm ON accounts(realm)`)

  // 会话粘性：会话键 → uid 绑定。带过期时间，由 GC 惰性清理。
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      key       TEXT PRIMARY KEY,
      uid       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`)

  // 任务执行进度：每账号一份（TaskRunner DO 用）。
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task_progress (
      uid        TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // 凭据：**加密后**的密文（见 store/crypto.ts）。
  // ⚠️ 绝不存明文 —— Go 侧明文存盘是已知弱点，本项目不继承（AGENTS.md §7.1）。
  sql.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      uid        TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // 登录会话：设备码流程的中间状态。
  // ⚠️ 必须持久化（不能放 Worker 内存）：isolate 随时可能被回收，
  // 「发起登录」与「轮询结果」会落到不同 isolate，表现为「state 永远未知」。
  sql.exec(`
    CREATE TABLE IF NOT EXISTS login_sessions (
      state      TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_login_expires ON login_sessions(expires_at)`)
}

// ─────────────────────────── 凭据 ───────────────────────────

/** 读凭据密文。 */
export function readCredential(sql: SqlStorage, uid: string): string | undefined {
  return firstRow(sql.exec<{ ciphertext: string }>('SELECT ciphertext FROM credentials WHERE uid = ?', uid))
    ?.ciphertext
}

/** 写凭据密文（**入参必须是已加密的密文**，本层不做加密）。 */
export function writeCredential(sql: SqlStorage, uid: string, ciphertext: string, now: number): void {
  sql.exec(
    `INSERT INTO credentials (uid, ciphertext, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
    uid,
    ciphertext,
    now,
  )
}

/** 删凭据。 */
export function deleteCredential(sql: SqlStorage, uid: string): void {
  sql.exec('DELETE FROM credentials WHERE uid = ?', uid)
}

/** 列出所有持有凭据的 uid（不返回密文本身 —— 调用方按需逐条解密）。 */
export function listCredentialUids(sql: SqlStorage): string[] {
  return sql
    .exec<{ uid: string }>('SELECT uid FROM credentials')
    .toArray()
    .map((r) => r.uid)
}

// ─────────────────────────── 登录会话 ───────────────────────────

/** 写登录会话（幂等 upsert）。 */
export function writeLoginSession(sql: SqlStorage, state: string, payload: string, expiresAt: number): void {
  sql.exec(
    `INSERT INTO login_sessions (state, payload, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(state) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
    state,
    payload,
    expiresAt,
  )
}

/** 读登录会话；已过期视为不存在（并顺手删除）。 */
export function readLoginSession(sql: SqlStorage, state: string, now: number): string | undefined {
  const row = firstRow(
    sql.exec<{ payload: string; expires_at: number }>(
      'SELECT payload, expires_at FROM login_sessions WHERE state = ?',
      state,
    ),
  )
  if (row === undefined) return undefined
  if (row.expires_at <= now) {
    sql.exec('DELETE FROM login_sessions WHERE state = ?', state)
    return undefined
  }
  return row.payload
}

/** 删登录会话（登录完成后清理）。 */
export function deleteLoginSession(sql: SqlStorage, state: string): void {
  sql.exec('DELETE FROM login_sessions WHERE state = ?', state)
}

/** 清理过期登录会话。 */
export function pruneLoginSessions(sql: SqlStorage, now: number): number {
  const before = firstRow(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM login_sessions'))?.n ?? 0
  sql.exec('DELETE FROM login_sessions WHERE expires_at <= ?', now)
  const after = firstRow(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM login_sessions'))?.n ?? 0
  return before - after
}

/**
 * 安全读单行。
 *
 * ⚠️ **不要直接用 `.one()`**：0 行它会**抛异常**
 * （`Expected exactly one result from SQL query, but got no results.`），
 * 而「查不到」在本项目里是完全正常的路径（账号不存在、会话未绑定、进度未创建）。
 *
 * 这个坑是**实测踩到的**：`/admin/tasks/start` 对不存在的账号返回
 * `error code: 1101`（Worker 抛异常），根因就是 `.one()`，
 * 而代码本意是想返回「账号不存在 → 404」。
 * 改用 `toArray()` 取首元素，把「查不到」变成 `undefined` 而不是异常。
 */
function firstRow<T extends Record<string, SqlStorageValue>>(cursor: { toArray(): T[] }): T | undefined {
  const rows = cursor.toArray()
  return rows.length === 0 ? undefined : rows[0]
}

/** 读单条账号状态（JSON 文本）。不存在返回 undefined。 */
export function readAccount(sql: SqlStorage, uid: string): string | undefined {
  return firstRow(sql.exec<{ state: string }>('SELECT state FROM accounts WHERE uid = ?', uid))?.state
}

/** 列出某 realm 的全部账号状态（**只取 state 列**，不取多余的）。 */
export function listAccounts(sql: SqlStorage, realm: string): string[] {
  return sql
    .exec<{ state: string }>('SELECT state FROM accounts WHERE realm = ?', realm)
    .toArray()
    .map((row) => row.state)
}

/** 写入（upsert）单条账号状态。 */
export function writeAccount(sql: SqlStorage, uid: string, realm: string, state: string, now: number): void {
  sql.exec(
    `INSERT INTO accounts (uid, realm, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET state = excluded.state, realm = excluded.realm, updated_at = excluded.updated_at`,
    uid,
    realm,
    state,
    now,
  )
}

/** 删除单条账号。 */
export function deleteAccount(sql: SqlStorage, uid: string): void {
  sql.exec('DELETE FROM accounts WHERE uid = ?', uid)
}

/** 读会话绑定；已过期视为不存在。 */
export function readSession(sql: SqlStorage, key: string, now: number): string | undefined {
  const row = firstRow(
    sql.exec<{ uid: string; expires_at: number }>(
      'SELECT uid, expires_at FROM sessions WHERE key = ?',
      key,
    ),
  )
  if (row === undefined) return undefined
  if (row.expires_at <= now) return undefined
  return row.uid
}

/** 写会话绑定（含 TTL）。 */
export function writeSession(sql: SqlStorage, key: string, uid: string, expiresAt: number): void {
  sql.exec(
    `INSERT INTO sessions (key, uid, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET uid = excluded.uid, expires_at = excluded.expires_at`,
    key,
    uid,
    expiresAt,
  )
}

/** 删除会话绑定。 */
export function deleteSession(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM sessions WHERE key = ?', key)
}

/** 清理过期会话，返回清理条数（用于观测）。 */
export function pruneSessions(sql: SqlStorage, now: number): number {
  const before = firstRow(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n ?? 0
  sql.exec('DELETE FROM sessions WHERE expires_at <= ?', now)
  const after = firstRow(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n ?? 0
  return before - after
}

/** 读任务进度（TaskRunner 用）。 */
export function readProgress(sql: SqlStorage, uid: string): string | undefined {
  return firstRow(sql.exec<{ payload: string }>('SELECT payload FROM task_progress WHERE uid = ?', uid))?.payload
}

/** 写任务进度。 */
export function writeProgress(sql: SqlStorage, uid: string, payload: string, now: number): void {
  sql.exec(
    `INSERT INTO task_progress (uid, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    uid,
    payload,
    now,
  )
}
