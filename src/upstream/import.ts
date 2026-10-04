/**
 * 账号导入：兼容 Go 侧 `auths/*.json` 的**双形态**格式。
 *
 * ## 为什么必须兼容这个格式
 *
 * 用户可能已经在跑 Go 版 `workbuddy2api-panel`，账号都在 `auths/` 目录里。
 * 如果导入不兼容，用户就得**重新登录每个账号**（每个都要在浏览器点授权）——
 * 这是最影响迁移意愿的摩擦点（AGENTS.md §8.3 C1）。
 *
 * ## 两种形态（逐字对齐 Go 侧 `auth.go:210-266`）
 *
 * 嵌套形（插件 OAuth 输出，**当前主形态**）：
 * ```json
 * {
 *   "auth":    { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000, "domain": "...", "realm": "cn" },
 *   "account": { "uid": "...", "enterpriseId": "...", "nickname": "..." },
 *   "device_token": "..."
 * }
 * ```
 *
 * 扁平形（手写 / 旧版）：
 * ```json
 * { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000,
 *   "domain": "...", "realm": "cn", "uid": "...", "enterpriseId": "...",
 *   "nickname": "...", "device_token": "..." }
 * ```
 *
 * ⚠️ 判据是**顶层有没有 `auth` 键**，不是猜字段。猜会误判（扁平形也含 `domain` 等字段）。
 *
 * ## `expiresAt` 的单位陷阱
 *
 * Go 侧存的是 **Unix 秒**（`auth.go:302-305` 写入时用 `.Unix()`）。
 * 而本项目的 `expiresAt` 用 **epoch 毫秒**。⇒ 导入时必须 ×1000，
 * 否则过期时间会落到 1970 年，续期逻辑会立刻判定「需要续期」并反复打上游。
 */

import type { LoginCredential } from './auth.js'

/** 导入结果（区分「成功」「跳过」两类，便于报告）。 */
export interface ImportOutcome {
  imported: Array<{ uid: string; nickname: string; realm: string; expiresAt: number }>
  /** 跳过的条目及原因（**不静默丢弃** —— 用户需要知道为什么没进来）。 */
  skipped: Array<{ reason: string; source?: string }>
}

/** 导入错误。 */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** 宽松读字符串（缺字段返回空串，不返回 undefined）。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 读数字（接受字符串数字）。 */
function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 读字段：**同时接受 camelCase 与 snake_case**。
 *
 * 为什么需要两种：不同来源的凭据文件命名风格不同 ——
 * - Go 侧 `auths/*.json`：camelCase（`accessToken` / `enterpriseId`）；
 * - DSH 插件 `~/.dsh/.credentials.yaml`：**snake_case**
 *   （`access_token` / `user_id` / `enterprise_id` / `expires_at`）。
 *
 * 只认一种会导致「导入成功但字段全空」，很难排查 —— 故两种都认。
 */
function pick(obj: Record<string, unknown>, camel: string, snake: string): string {
  const v = obj[camel] ?? obj[snake]
  return typeof v === 'string' ? v : ''
}

function pickNum(obj: Record<string, unknown>, camel: string, snake: string): number {
  return num(obj[camel] ?? obj[snake])
}

/**
 * 把 Go 侧的 `expiresAt`（Unix **秒**）转成 epoch **毫秒**。
 *
 * 启发式：值 < 1e12 视为秒（1e12 毫秒 ≈ 2001 年，1e12 秒 ≈ 33658 年 ——
 * 所以这个分界足够安全）。同时兼容已经是毫秒的值（避免二次 ×1000）。
 *
 * ⚠️ 实测两种来源都用不同单位：
 * - Go 侧 `auths/*.json`：**秒**；
 * - DSH 插件 `.credentials.yaml`：**毫秒**。
 * 本函数同时兼容两者。
 */
export function normalizeExpiresAt(raw: number): number {
  if (raw <= 0) return 0
  return raw < 1e12 ? raw * 1000 : raw
}

/**
 * 解析一条 auth 文档（双形态）。
 *
 * @throws {ImportError} 缺 accessToken 或 uid 时抛错（这两个字段缺一不可）
 */
export function parseAuthDocument(raw: unknown, source?: string): LoginCredential {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportError(`不是合法的 JSON 对象${source === undefined ? '' : `（${source}）`}`)
  }
  const doc = raw as Record<string, unknown>

  // ⚠️ 判据：顶层有 `auth` 键 ⇒ 嵌套形
  const isNested = doc.auth !== null && typeof doc.auth === 'object' && !Array.isArray(doc.auth)

  let accessToken: string
  let refreshToken: string
  let expiresAtRaw: number
  let domain: string
  let realm: string
  let uid: string
  let enterpriseId: string
  let nickname: string

  if (isNested) {
    const auth = doc.auth as Record<string, unknown>
    const account =
      doc.account !== null && typeof doc.account === 'object' && !Array.isArray(doc.account)
        ? (doc.account as Record<string, unknown>)
        : {}

    accessToken = pick(auth, 'accessToken', 'access_token')
    refreshToken = pick(auth, 'refreshToken', 'refresh_token')
    expiresAtRaw = pickNum(auth, 'expiresAt', 'expires_at')
    domain = pick(auth, 'domain', 'domain')
    realm = pick(auth, 'realm', 'realm')
    uid = pick(account, 'uid', 'uid')
    enterpriseId = pick(account, 'enterpriseId', 'enterprise_id')
    nickname = pick(account, 'nickname', 'nickname')
  } else {
    // ⚠️ 扁平形同时接受 snake_case：DSH 插件 `.credentials.yaml` 的凭据就是
    // 「扁平 + snake_case」形态（`access_token` / `user_id` / `enterprise_id`）。
    // 若只认 camelCase，导入会「成功」但 uid 为空 → 被下面的校验拦下，
    // 用户看到的是「缺少 uid」，而真实原因是字段命名风格不同。
    accessToken = pick(doc, 'accessToken', 'access_token')
    refreshToken = pick(doc, 'refreshToken', 'refresh_token')
    expiresAtRaw = pickNum(doc, 'expiresAt', 'expires_at')
    domain = pick(doc, 'domain', 'domain')
    realm = pick(doc, 'realm', 'realm')
    // uid 有多个别名：Go 侧叫 uid，DSH 侧叫 user_id
    uid = pick(doc, 'uid', 'user_id') || pick(doc, 'uid', 'uid')
    enterpriseId = pick(doc, 'enterpriseId', 'enterprise_id')
    nickname = pick(doc, 'nickname', 'nickname')
  }

  if (accessToken.trim() === '') {
    throw new ImportError(`缺少 accessToken${source === undefined ? '' : `（${source}）`}`)
  }
  if (uid.trim() === '') {
    // ⚠️ 没有 uid 就无法定位账号（它同时是 storage key 与面板标识）
    throw new ImportError(`缺少 uid${source === undefined ? '' : `（${source}）`}`)
  }

  // realm 缺省按 domain 后缀/取值回落（Go 侧 `Realm()` 同口径）
  const resolvedRealm = realm !== '' ? realm : domain.includes('workbuddy.ai') ? 'global' : 'cn'

  return {
    accessToken,
    refreshToken,
    expiresAt: normalizeExpiresAt(expiresAtRaw),
    domain,
    uid,
    enterpriseId,
    nickname,
    realm: resolvedRealm,
  }
}

/**
 * 批量导入。
 *
 * 逐条独立：**单条失败不影响其他条**（用户的账号文件里混一个坏文件是常见的），
 * 但失败原因必须回报，不能静默丢弃。
 */
export function importAuthDocuments(inputs: Array<{ raw: unknown; source?: string }>): ImportOutcome {
  const imported: ImportOutcome['imported'] = []
  const skipped: ImportOutcome['skipped'] = []
  const seen = new Set<string>()

  for (const input of inputs) {
    try {
      const credential = parseAuthDocument(input.raw, input.source)

      // 去重：同一 uid 重复导入取第一条（后到的可能更旧）
      if (seen.has(credential.uid)) {
        skipped.push({ reason: `uid ${credential.uid} 重复，已保留首次出现的条目`, source: input.source })
        continue
      }
      seen.add(credential.uid)

      imported.push({
        uid: credential.uid,
        nickname: credential.nickname,
        realm: credential.realm,
        expiresAt: credential.expiresAt,
      })
      // 注意：这里不返回 credential 本身（含 token），由调用方按需再次解析 —— 
      // 避免 token 在报告对象里流转（报告会被打日志）。
    } catch (error) {
      skipped.push({
        reason: error instanceof Error ? error.message : String(error),
        source: input.source,
      })
    }
  }

  return { imported, skipped }
}

/**
 * 从「一个包含多条 auth 的 JSON 数组」或「单条 auth」解析。
 *
 * 方便一次性粘贴：既接受 `[{...},{...}]`，也接受单个 `{...}`。
 */
/**
 * 宽容地把字符串解析成对象。
 *
 * ## ⚠️ 为什么需要（实测踩到）
 *
 * 凭据文件（如 DSH 的 `.credentials.yaml`）里，字符串字段可能含**裸控制字符**：
 * 实测某条 WORKBUDDY 凭据的 `scope` 值是
 * `"openid\n    profile offline_access\n    email"` —— YAML 折行把换行写成了
 * **真实的 0x0A**，而 JSON 规范不允许字符串里出现裸控制字符。
 * 于是 `JSON.parse` 报 `Invalid control character at ...`，整条凭据导入失败。
 *
 * 修法：把**字符串字面量内部**的裸控制字符转义后再解析。
 * 只处理 0x00–0x1F（JSON 禁止的裸控制字符），不动其它字符。
 *
 * ⚠️ 只在**首次解析失败**时兜底，正常路径仍走标准 `JSON.parse` ——
 * 不因为个别脏数据让所有凭据都走宽容路径（那会掩盖真实的格式错误）。
 */
export function parseJsonLenient(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') throw new ImportError('凭据字符串为空')
  try {
    return JSON.parse(trimmed)
  } catch (first) {
    // 把字符串字面量内部的裸控制字符转义（用状态机跟踪是否在字符串内）
    let out = ''
    let inString = false
    let escaped = false
    for (const ch of trimmed) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { inString = !inString; out += ch; continue }
      const code = ch.charCodeAt(0)
      if (inString && code < 0x20) {
        // 转义成 \n / \r / \t，其余用 \uXXXX
        if (code === 0x0a) out += '\\n'
        else if (code === 0x0d) out += '\\r'
        else if (code === 0x09) out += '\\t'
        else out += '\\u' + code.toString(16).padStart(4, '0')
        continue
      }
      out += ch
    }
    try {
      return JSON.parse(out)
    } catch {
      // ⚠️ 宽容解析也失败 → 抛 `ImportError`（而不是原始的 SyntaxError）。
      // 调用方（导入端点）按 `ImportError` 分类处理，抛别的类型会变成 500。
      throw new ImportError(
        `凭据不是合法 JSON：${first instanceof Error ? first.message : String(first)}`,
      )
    }
  }
}

export function parseAuthPayload(payload: unknown): Array<{ raw: unknown; source?: string }> {
  // ⚠️ 字符串输入：先宽容解析成对象再继续。
  // 用户从凭据文件里复制的值常常是「被引号包住的 JSON 字符串」，
  // 且可能含裸控制字符（见 parseJsonLenient 的说明）。
  if (typeof payload === 'string') {
    return [{ raw: parseJsonLenient(payload), source: '(string)' }]
  }
  if (Array.isArray(payload)) {
    return payload.map((raw, i) => ({ raw, source: `[${i}]` }))
  }
  if (payload !== null && typeof payload === 'object') {
    // 兼容 `{accounts: [...]}` 包裹形态
    const wrapped = (payload as Record<string, unknown>).accounts
    if (Array.isArray(wrapped)) {
      return wrapped.map((raw, i) => ({ raw, source: `accounts[${i}]` }))
    }
    return [{ raw: payload }]
  }
  throw new ImportError('导入载荷必须是 auth 对象、auth 数组，或 {accounts:[...]}')
}
