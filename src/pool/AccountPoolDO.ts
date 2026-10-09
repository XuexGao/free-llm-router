/**
 * AccountPool Durable Object：账号池的**唯一权威状态**。
 *
 * ## 为什么必须是一个 DO，而不是 Worker 内存
 *
 * 账号池的冷却/熔断/降权/租约是**必须跨请求共享且必须串行修改**的状态。
 * Workers 会水平扩展 + 随时回收 isolate，模块级变量等于「每个 isolate 一份」，
 * 状态必然撕裂（AGENTS.md §4.2）。
 *
 * DO 提供三件这里正需要的东西：
 * 1. **单点串行** —— 无需自己实现锁；
 * 2. **持久化存储** —— 替代 Go 侧的 `data/state.json`；
 * 3. **alarm** —— 替代进程内 ticker（本 DO 暂不需要，见下）。
 *
 * 按 realm（`cn` / `global`）**分片**而不是全局单例：避免单 DO 的
 * ~1000 req/s 软上限成为瓶颈。
 *
 * ## 分层纪律（重要）
 *
 * 本 DO **只做状态读写与选号**，不做上游网络请求。
 * 理由：DO 的每次调用都消耗 10ms CPU 预算（Free 计划），
 * 把上游 fetch 放进 DO 会把 I/O 等待与状态修改耦合在一起，
 * 让「一次调用 = 一步」的纪律失效。上游请求由 Worker 侧发起。
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.js'
import {
  type AccountState,
  createAccountState,
  healthy,
  healthyForModel,
  isActive,
  modelExempt,
  normalizeAccountState,
  pruneExpired,
} from './state.js'
import {
  deleteAccount,
  deleteSession,
  listAccounts,
  listCredentialUids,
  migrate,
  pruneLoginSessions,
  pruneSessions,
  readAccount,
  readCredential,
  readLoginSession,
  readSession,
  writeAccount,
  writeCredential,
  writeLoginSession,
  writeSession,
  deleteCredential,
  deleteLoginSession,
} from '../store/db.js'
import { decryptCredential, encryptCredential, requireCredentialKey } from '../store/crypto.js'
import { cstDay } from '../upstream/travel.js'
import {
  summarizeUsage,
  trimUsageRing,
  type UsageRecord,
  type UsageSummary,
} from '../store/usage.js'

/** 模型成本账本的存活时长：6h 外的价格不再采信（Go 侧 `modelCostTTL` 同口径）。 */
const MODEL_COST_TTL_MS = 6 * 60 * 60 * 1000

/** 会话粘性默认 TTL。 */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * 防惊群的「冷却窗口」：{@link SPREAD_WINDOW_MS} 内刚被选中过的账号，
 * 下次选号会被**优先排除**（除非排除后一个不剩）。
 *
 * ## 为什么需要（实测缺陷）
 *
 * 上游对**同一账号的并发流**不友好：后来者会把先前的流**踢掉** ⇒
 * 用户看到「长回答中途突然停止、没有任何输出」。
 * 纯加权随机每次都独立掷骰，完全可能连中同一账号。
 *
 * 值取 3 秒：足够把「并发几秒内到达的请求」摊开，
 * 又不至于让账号在半天内被闲置（长回答动辄几十秒，
 * 窗口太长会让后续单发请求也被迫换号，反而丢 prompt cache）。
 */
export const SPREAD_WINDOW_MS = 3_000


/**
 * IP 级 WAF 拦截的判定窗口与阈值。
 *
 * ## 为什么需要「IP 级」这一层（Go 侧 `internal/server/wafip.go` 的教训）
 *
 * 实测记录：**3 个账号在 1 秒内全部命中 403** —— 那不是账号问题，是**出口 IP 被拦**。
 * 若只有账号级冷却，轮转逻辑会把一次客户端请求**放大 MaxRotate 倍**：
 * 每个号都去撞一次同一堵墙，反而加重风控。
 *
 * ⇒ 判据是「**短窗内多个不同账号**接连命中」，而不是「同一账号反复命中」：
 * - 同一个号反复 403 → 账号级偶发，交给软冷却（已有的逻辑）；
 * - **不同号**在 60 秒内接连 403 → 已有 IP 级证据 ⇒ fail-fast，不再轮转。
 *
 * 阈值取 2：「多号」的最小定义。Go 侧同值（实测 3 号 1s 全拦，阈值 2 更早止损）。
 */
const WAF_IP_WINDOW_MS = 60_000
const WAF_IP_THRESHOLD = 2

/** 选号候选上限（Go 侧 top5）。 */
const TOP_N = 5

/**
 * 选号输入。
 *
 * ⚠️ `model` 必须**真的传**：传空串会让模型级冷却过滤整体短路
 * （Go 侧 `account-pool.ts:917` 记录过的缺陷）。
 */
export interface PickRequest {
  realm: string
  /**
   * 只要该供应商的账号（空串 = 不限）。
   *
   * ⚠️ 过滤必须在这里做，**不能**在 `pick()` 返回之后再筛（实测踩到）：
   * 后者会先选中一个别家的账号、再把它丢掉，于是
   * 「池里有账号但当前供应商没账号」时表现为 `pick()` 返回了号、
   * 调用方却拿不到人 → 直接被当成「没有可用账号」。
   */
  provider?: string
  /** 目标模型；空串表示「还没定模型」——此时不做模型级过滤。 */
  model: string
  /**
   * **优先**使用的账号（会话粘性）。
   *
   * ⚠️ 语义是「优先」不是「只要」：它在候选集里**排到最前**，
   * 但若它已不可用（冷却/熔断/模型限流/被 exclude），
   * 会**自然回落到**其余候选 —— 绝不能因为「粘性的那个挂了」就报「没有可用账号」。
   *
   * ## 为什么值得做（上游 prompt cache）
   *
   * 同一会话若每次都落不同账号，上游的 prompt cache **永远不命中**：
   * 每一轮都要重新处理整个上下文 ⇒ **更慢、更贵**（按 token 计费时尤其明显）。
   * 绑定会话到账号后，第二轮起就能命中缓存。
   *
   * ⚠️ 只在**候选集内**提升优先级，不绕过任何健康检查 ——
   * 粘性不该让一个正在冷却的账号被强行使用。
   */
  preferred?: string
  /** 已尝试过的 uid，必须排除（跨重试保留，否则会在账号间无限来回）。 */
  exclude: string[]
  now: number
}

/** 选号结果。 */
export interface PickResult {
  uid: string
  state: AccountState
}

/** 账号池的对外 RPC 面（Worker 通过 stub 调用）。 */
export class AccountPoolDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 建表必须完成后再放行任何请求，否则首次调用会撞上不存在的表。
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
  }

  /** 写入 / 覆盖一个账号的完整状态。 */
  async upsertAccount(state: AccountState, now: number): Promise<void> {
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /** 读取一个账号。 */
  async getAccount(uid: string): Promise<AccountState | undefined> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    return raw === undefined ? undefined : normalizeAccountState(JSON.parse(raw))
  }

  /**
   * 一次性数据迁移：把 `provider: 'workbuddy'`（当时指**国内版**）改成 `'buddy'`。
   *
   * ## ⚠️ 为什么必须做（否则是静默的数据错误）
   *
   * 本项目早期只有国内版，它当时的 id 就是 `workbuddy`。
   * 接入国际版后 `workbuddy` 的含义**变成了国际版** ——
   * 若不迁移，既有的国内账号会被当成国际账号，
   * 于是拿国内凭据去打 `www.workbuddy.ai`，**必然 401**，
   * 且用户看到的是「凭据失效」，真实原因（id 语义变了）完全看不出来。
   *
   * 判据：`provider === 'workbuddy'` **且**凭据里的 domain 不含 `workbuddy.ai`。
   * 幂等：跑第二次时已经是 `buddy`，不再命中。
   */
  private async migrateBuddyIds(realm: string, now: number): Promise<number> {
    const raws = listAccounts(this.ctx.storage.sql, realm)
    let migrated = 0
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined || state.provider !== 'workbuddy') continue

      // 读凭据看 domain —— 国际版凭据的 domain 含 workbuddy.ai
      const stored = readCredential(this.ctx.storage.sql, state.uid)
      let domain = ''
      if (stored !== undefined) {
        try {
          const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
          const cred = (await decryptCredential(key, stored)) as { extras?: { domain?: string } } | undefined
          domain = cred?.extras?.domain ?? ''
        } catch {
          // 凭据解不开（如换了 CREDENTIAL_KEY）→ 不猜，保持原样
          continue
        }
      }

      // 是国际账号就保留 workbuddy；否则迁到 buddy
      if (domain.includes('workbuddy.ai')) continue
      state.provider = 'buddy'
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
      migrated += 1
    }
    return migrated
  }

  /** 列出某 realm 的全部账号（惰性剪枝过期条目）。 */
  async listAccounts(realm: string, now: number): Promise<AccountState[]> {
    // ⚠️ 惰性跑一次 id 迁移（幂等 + 用 storage 标志保证只跑一次）。
    // 放在这里而不是启动钩子：DO 没有可靠的「启动」时机，而 listAccounts
    // 是所有读路径的必经之处，天然覆盖「老数据第一次被访问」。
    const migrated = await this.ctx.storage.get<boolean>('buddyIdMigrated')
    if (migrated !== true) {
      await this.migrateBuddyIds(realm, now).catch(() => 0)
      await this.ctx.storage.put('buddyIdMigrated', true)
    }

    const raws = listAccounts(this.ctx.storage.sql, realm)
    const out: AccountState[] = []
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      if (pruneExpired(state, now, MODEL_COST_TTL_MS)) {
        // 剪枝结果不回写：过期条目不影响判定，回写反而多一次 SQLite 往返。
        // 下次真实状态变更时会一并落盘。
      }
      out.push(state)
    }
    return out
  }

  /** 删除账号（连带其会话绑定）。 */
  async removeAccount(uid: string): Promise<void> {
    deleteAccount(this.ctx.storage.sql, uid)
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE uid = ?', uid)
  }

  /**
   * 选号。
   *
   * 严格照 Go 侧 `pick.go` 的**顺序**（顺序即语义，不可调换）：
   * 1. 健康过滤（含模型级）
   * 2. 排除已尝试
   * 3. 在途过滤（**本实现暂不做租约**，见下方注记）
   * 4. 权重计算 → 加权随机
   *
   * ⚠️ **有意未实现**：Go 侧的 `costTier` 三层硬分层与「积分保底拦截」依赖
   * 实测扣费账本（`modelCosts`）。第一版账号数少（1–3 个），分层收益低于
   * 实现复杂度，故只保留**积分保底**所需的账本字段，不做分层选号。
   * 这是**刻意**的范围裁剪，不是遗漏（AGENTS.md §3.2）。
   */
  async pick(request: PickRequest): Promise<PickResult | undefined> {
    const { realm, model, exclude, now } = request
    const wantProvider = request.provider ?? ''
    const excludeSet = new Set(exclude)

    // ⚠️ IP 级拦截激活期内**直接放弃**，连一个号都不试。
    // 理由见 WAF_IP_WINDOW_MS 的注释：继续轮转只会把一次请求放大成 N 次撞墙。
    if (await this.wafGateActive(now)) return undefined

    const raws = listAccounts(this.ctx.storage.sql, realm)
    const candidates: AccountState[] = []
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      if (wantProvider !== '' && (state.provider ?? 'workbuddy') !== wantProvider) continue
      if (excludeSet.has(state.uid)) continue
      pruneExpired(state, now, MODEL_COST_TTL_MS)
      if (!healthyForModel(state, now, model)) continue
      candidates.push(state)
    }

    if (candidates.length === 0) return undefined

    // 权重：积分越多越优先（温和偏好，不是硬门槛）。
    // ⚠️ 刻意**不**用 `Math.random()` 之外的全局状态：DO 单线程，无需防并发。
    // ⚠️ **会话粘性**：把 `preferred` 提到候选集最前，**直接返回**。
    //
    // 为什么直接返回而不是「加权倾斜」：加权仍会**随机落到别的账号**，
    // 那样 prompt cache 照样不命中 —— 粘性就失去意义了。
    // 而「优先账号挂了怎么办」已由上游的候选过滤解决：
    // 它不可用时压根不在 `candidates` 里，自然回落到其余候选。
    const preferred = request.preferred ?? ''
    if (preferred !== '') {
      const hit = candidates.find((s) => s.uid === preferred)
      if (hit !== undefined) {
        this.notePicked(hit.uid, now)
        return { uid: hit.uid, state: hit }
      }
    }

    // ⚠️ **防惊群：并发请求要摊到不同账号**（实测踩到的严重缺陷）。
    //
    // ## 为什么必须做（用户报「思考 78 秒又断了」）
    //
    // 上游对**同一账号的并发流**不友好：后来者会把先前的流**踢掉**，
    // 表现为「长回答中途突然停止、没有任何输出」。
    //
    // 实测对照（3 个相同 prompt 并发）：
    // - 加粘性前/未摊开 ⇒ **1 个被切断**；
    // - 强制落到不同账号 ⇒ **3/3 全部完整**。
    //
    // ⇒ 纯加权随机不够：它**每次都独立掷骰**，完全可能连中同一个账号。
    //
    // ## 做法：优先选「最近没被选中」的账号
    //
    // 在 `pick()` 时给账号打一个时间戳，下次选号**优先排除**
    // 「{@link SPREAD_WINDOW_MS} 内刚被选中过」的账号。
    // 若排除后一个都不剩，**就回落到全部候选**（绝不因此报「无可用账号」）。
    //
    // ⚠️ **刻意放在 `preferred` 之后**：显式声明了会话的客户端
    //（`user` / `conversation_id`）**优先保 prompt cache**，不参与摊开。
    // 只有「没声明会话」的请求才摊 —— 它们本来就没有缓存可命中。
    const fresh = candidates.filter((s) => now - this.notePickedAt(s.uid) >= SPREAD_WINDOW_MS)
    const pool = fresh.length > 0 ? fresh : candidates

    const weights = pool.map((s) => 1 + Math.max(0, s.credits) / 100)
    const total = weights.reduce((a, b) => a + b, 0)
    let roll = Math.random() * total
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i] ?? 0
      if (roll <= 0) {
        const chosen = pool[i]
        if (chosen !== undefined) {
          this.notePicked(chosen.uid, now)
          return { uid: chosen.uid, state: chosen }
        }
      }
    }

    // 浮点误差兜底：取最后一个候选（而不是返回 undefined —— 那会被上层误判为「无可用账号」）。
    const last = pool[pool.length - 1]
    if (last === undefined) return undefined
    this.notePicked(last.uid, now)
    return { uid: last.uid, state: last }
  }

  /**
   * 最近一次选中该账号的时刻（**进程内**，不落存储）。
   *
   * ⚠️ 刻意只在内存里：① 每个 pick 都写存储会白烧 Free 计划的 DO 行写入配额；
   * ② DO 实例被回收后重置「只是少摊开一次」，不是正确性问题
   *（最坏情形退化成原来的加权随机）。
   */
  private recentlyPicked = new Map<string, number>()

  /** 读某账号最近被选中的时刻（从未选中过返回 0 ⇒ 视为「很久没用」）。 */
  private notePickedAt(uid: string): number {
    return this.recentlyPicked.get(uid) ?? 0
  }

  /** 记录该账号刚被选中。 */
  private notePicked(uid: string, now: number): void {
    this.recentlyPicked.set(uid, now)
  }

  /**
   * 读**供应商面板设置**（顺序 + 是否启用）。
   *
   * ## 语义（用户 2026-10-07 明确）
   *
   * - **关闭供应商 = 彻底关掉**：该家的模型从 `/v1/models` 消失、
   *   `/v1/chat/completions` 也拒绝路由到它（故这里是**服务端**状态，
   *   不是浏览器 localStorage —— 后者只在面板生效，API 仍可调用）。
   * - **排序只影响面板展示顺序**，**不**改变默认供应商
   *   （裸模型名仍回落到 `DEFAULT_PROVIDER`）—— 那会悄悄改掉既有请求的路由。
   *
   * ⚠️ 存在 `cn` 分片的 DO 里当**全局**设置用：它描述的是「面板怎么显示」，
   * 与 realm 无关；按 realm 各存一份会让两个分片显示不一致。
   */
  async getProviderSettings(): Promise<{ order: string[]; disabled: string[] }> {
    const raw = await this.ctx.storage.get<{ order?: unknown; disabled?: unknown }>('providerSettings')
    const order = Array.isArray(raw?.order) ? raw!.order.filter((x): x is string => typeof x === 'string') : []
    const disabled = Array.isArray(raw?.disabled)
      ? raw!.disabled.filter((x): x is string => typeof x === 'string')
      : []
    return { order, disabled }
  }

  /** 写供应商面板设置（整体覆盖，调用方负责传完整值）。 */
  async setProviderSettings(input: { order: string[]; disabled: string[] }): Promise<void> {
    await this.ctx.storage.put('providerSettings', {
      order: input.order.filter((x) => typeof x === 'string'),
      disabled: input.disabled.filter((x) => typeof x === 'string'),
    })
  }

  /** 账号池计数摘要（供 `/healthz` 与面板）。 */
  async counts(realm: string, now: number): Promise<{
    total: number
    healthy: number
    disabled: number
    cooling: number
    modelExempt: number
  }> {
    const raws = listAccounts(this.ctx.storage.sql, realm)
    let healthyCount = 0
    let disabled = 0
    let cooling = 0
    let exempt = 0

    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      // ⚠️ 解析失败（数据损坏）时跳过该条，而不是让整个列表 500
      if (state === undefined) continue
      // 供应商不匹配的直接跳过（不同家的凭据/协议完全不同）
      pruneExpired(state, now, MODEL_COST_TTL_MS)
      if (state.disabled) {
        disabled += 1
        continue
      }
      // ⚠️ 判定顺序有语义：**先判模型级限流**，再判整体健康。
      //
      // 根因（线上实测踩到）：`healthy()` 只看账号级的四个维度
      // （until / breakerUntil / degradeUntil / disabled），**不看** modelCooldowns。
      // 而 `modelExempt()` 要求「账号级健康 且 存在未过期的模型冷却」。
      // 于是「账号健康但有模型在冷却」时**两个都返回 true** ——
      // 若先判 healthy，模型限流就永远统计不到（面板恒为 0）。
      //
      // 语义上正确：该账号对**部分模型**不可用，不该算「完全健康」。
      if (modelExempt(state, now)) {
        exempt += 1
      } else if (healthy(state, now)) {
        healthyCount += 1
      } else {
        cooling += 1
      }
    }

    return { total: raws.length, healthy: healthyCount, disabled, cooling, modelExempt: exempt }
  }

  /** 读会话粘性绑定。 */
  async getSession(key: string, now: number): Promise<string | undefined> {
    return readSession(this.ctx.storage.sql, key, now)
  }

  /** 写会话粘性绑定（滚动续期）。 */
  async bindSession(key: string, uid: string, now: number, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<void> {
    writeSession(this.ctx.storage.sql, key, uid, now + ttlMs)
  }

  /** 解绑会话（绑定的账号失败时调用）。 */
  async unbindSession(key: string): Promise<void> {
    deleteSession(this.ctx.storage.sql, key)
  }

  /** 清理过期会话。 */
  async pruneSessions(now: number): Promise<number> {
    return pruneSessions(this.ctx.storage.sql, now)
  }

  /**
   * 记录一次失败，按**错误类别**落到正确的维度。
   *
   * ⚠️ 这里刻意做成**一个显式入参的入口**，而不是「一个通用的 punish()」：
   * 错误分类（AGENTS.md §6.7）决定罚哪个维度，混在一起必然误伤。
   */
  async applyFailure(input: {
    uid: string
    kind: 'soft' | 'hard' | 'breaker' | 'degrade' | 'session_dead' | 'model'
    now: number
    /** `kind === 'model'` 时的目标模型。 */
    model?: string
    /** 上游给出的重置时刻（epoch ms），优先于本地退避计算。 */
    resetAt?: number
    reason?: string
  }): Promise<{ disabled: boolean }> {
    const raw = readAccount(this.ctx.storage.sql, input.uid)
    if (raw === undefined) return { disabled: false }
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return { disabled: false }
    const { now } = input

    switch (input.kind) {
      case 'hard': {
        // 余额耗尽：冷却到次日 04:00（UTC+8）。签到后余额恢复会自动解冻。
        state.until = nextDay4AmUtc8(now)
        state.coolKind = 'hard'
        state.reason = input.reason ?? 'credit exhausted'
        break
      }
      case 'soft': {
        state.coolKind = 'soft'
        state.reason = input.reason ?? 'rate limited'
        // 有上游重置墙钟就对齐它，否则按连续次数指数退避（封顶 2h）。
        if (input.resetAt !== undefined && input.resetAt > now) {
          state.until = input.resetAt
        } else if (!isActive(state.until, now)) {
          state.softStreak += 1
          const backoff = Math.min(600_000 * 2 ** (state.softStreak - 1), 2 * 60 * 60 * 1000)
          state.until = now + backoff
        }
        // ⚠️ 「已在冷却中」时**不推进不延长**（Go 侧 `cooldown.go:321`）——
        // 那会让一个持续失败的号被无限推远。
        break
      }
      case 'breaker': {
        state.fails += 1
        if (state.fails >= 3) {
          state.breakerUntil = now + Math.min(30 * 60 * 1000 * 2 ** state.retryCount, 6 * 60 * 60 * 1000)
          state.retryCount += 1
          state.fails = 0
        }
        break
      }
      case 'degrade': {
        state.consecutiveFails += 1
        if (state.consecutiveFails >= 5) {
          state.degradeUntil = now + 10 * 60 * 1000
          state.consecutiveFails = 0
        }
        break
      }
      case 'session_dead': {
        // ⚠️ 连续 3 次才禁用：单次 12153 多为网络抖动，一次就杀号会误杀健康账号
        // （Go 侧 `state.go:27-40` 记录过 P0 事故：13 个 disabled 号 refresh 全部成功）。
        state.sessionDeadFails += 1
        if (state.sessionDeadFails >= 3) {
          state.sessionDeadFails = 0
          state.disabled = true
          state.reason = 'session dead (12153 ×3)'
        }
        break
      }
      case 'model': {
        const model = input.model ?? ''
        if (model === '') break
        const prev = state.modelCooldowns[model]
        const hits = (prev?.hits ?? 0) + 1
        // 6004：对齐上游重置墙钟。11102：6h 起指数退避，封顶 24h。
        const until =
          input.resetAt !== undefined && input.resetAt > now
            ? input.resetAt
            : now + Math.min(6 * 60 * 60 * 1000 * 2 ** Math.min(hits - 1, 2), 24 * 60 * 60 * 1000)
        state.modelCooldowns[model] = {
          until,
          resetAt: input.resetAt ?? 0,
          reason: input.reason ?? 'model cooldown',
          hits,
          auditOnly: false,
        }
        break
      }
    }

    state.errTotal += 1
    state.lastErr = now
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return { disabled: state.disabled }
  }

  /**
   * 记录一次成功：清熔断与降权，**不碰 `modelCooldowns`**。
   *
   * ⚠️ 不清模型级冷却是**刻意的**：一次成功不能证明某个模型已解除限流
   * （Go 侧 `state.go:141-144`）。
   */
  async noteSuccess(uid: string, now: number, usage?: { input: number; output: number }): Promise<void> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return
    const state = JSON.parse(raw) as AccountState

    state.successCount += 1
    state.lastSuccess = now
    state.fails = 0
    state.retryCount = 0
    state.breakerUntil = 0
    state.softStreak = 0
    state.sessionDeadFails = 0
    state.consecutiveFails = 0
    state.degradeUntil = 0

    if (usage !== undefined) {
      state.tokenUsage.input += usage.input
      state.tokenUsage.output += usage.output
    }

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /** 解冻账号（面板「解冻」/ 签到后余额恢复）。清全部惩罚态，但不动 `disabled`。 */
  async revive(uid: string, now: number, credits?: number): Promise<boolean> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return false
    const state = JSON.parse(raw) as AccountState

    state.until = 0
    state.coolKind = ''
    state.reason = ''
    state.softStreak = 0
    state.breakerUntil = 0
    state.retryCount = 0
    state.fails = 0
    state.degradeUntil = 0
    state.consecutiveFails = 0
    state.sessionDeadFails = 0
    state.modelCooldowns = {}
    if (credits !== undefined) state.credits = credits

    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return true
  }

  /**
   * 记录「**今天已签到**」（首次成功与幂等命中都要调）。
   *
   * ## ⚠️ 为什么必须有这个方法
   *
   * `AccountState.lastCheckinDay` 早就存在（`state.ts:133`），面板也在读它
   *（`src/panel/assets/app.js.txt:307` 的「签到 YYYY-MM-DD」）——
   * 但**从来没有代码写过它**，于是那个标签永远不显示。
   *
   * 这与 Go 侧的能力不对等：Go 在签到成功与幂等两条分支后都调
   * `Pool.NoteCheckinDone`（`internal/panel/panel.go:494,499`、
   * `internal/scheduler/scheduler.go:445,453`）。本项目漏了这一步。
   *
   * 「幂等命中也算今天已签」的理由同 Go 侧（`panel.go:491-493`）：
   * 上游对重复签到回的是业务码而不是错误，用户看到的状态就该是「已签」。
   *
   * ⚠️ 日期用**固定 UTC+8**（复用 `upstream/travel.ts:45` 的 `cstDay`，
   * 与签到活动的日界口径一致），不取本机时区 —— Workerd 恒为 UTC。
   */
  async noteCheckinDone(uid: string, now: number): Promise<void> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return
    const state = JSON.parse(raw) as AccountState
    state.lastCheckinDay = cstDay(now)
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /**
   * **人工**启用/停用某个账号（面板的「停用 / 启用」按钮）。
   *
   * ## ⚠️ 与 `disable()` / `applyFailure` 的区别（不要混用）
   *
   * | 入口 | 语义 | 谁能解除 |
   * |---|---|---|
   * | {@link setAccountDisabled} | **用户显式**停用 | 只有用户再点「启用」 |
   * | {@link disable} | 上游强信号（如 11140）判死 | 重新登录 / 人工清状态 |
   * | `applyFailure` | 失败累积到阈值后的自动熔断 | 时间到期自动恢复 |
   *
   * ⚠️ 故这里**同时清掉自动熔断/冷却**：
   * 用户说「启用」，意思是「我要用这个号」—— 若留着旧的 `until` /
   * `breakerUntil`，号虽然 `disabled=false` 但**仍然选不到**，
   * 面板上看起来「启用了却没用」。那是本项目反复踩到的
   * 「状态看着对、行为不对」型缺陷。
   *
   * ⚠️ 也清 `reason`：那是上一次失败的原因，留着会让面板显示
   * 「正常」却带着一条旧错误，误导排查。
   */
  async setAccountDisabled(uid: string, disabled: boolean, now: number): Promise<boolean> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return false
    const state = normalizeAccountState(JSON.parse(raw))
    if (state === undefined) return false
    state.disabled = disabled
    if (disabled) {
      state.reason = '已被手动停用'
    } else {
      // ⚠️ 启用时**必须一并清掉自动惩罚状态**，否则「启用了仍选不到」。
      state.reason = ''
      state.until = 0
      state.breakerUntil = 0
      state.degradeUntil = 0
      state.coolKind = ''
      state.fails = 0
      state.retryCount = 0
      state.softStreak = 0
      state.consecutiveFails = 0
      state.sessionDeadFails = 0
    }
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return true
  }

  /** 显式禁用（人工或 11140 这类强信号）。 */
  async disable(uid: string, reason: string, now: number): Promise<void> {
    const raw = readAccount(this.ctx.storage.sql, uid)
    if (raw === undefined) return
    const state = JSON.parse(raw) as AccountState
    state.disabled = true
    state.reason = reason
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
  }

  /** 创建账号（供导入 / 登录流程调用）。已存在则覆盖凭证以外的状态。 */
  async createAccount(
    input: { uid: string; nickname: string; realm: string; provider?: string },
    now: number,
  ): Promise<AccountState> {
    const existing = readAccount(this.ctx.storage.sql, input.uid)
    if (existing !== undefined) {
      const parsed = normalizeAccountState(JSON.parse(existing))
      if (parsed !== undefined) return parsed
    }
    const state = createAccountState(input)
    writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), now)
    return state
  }

  // ─────────────────────── 凭据（加密存储） ───────────────────────

  /**
   * 写入凭据（**自动加密**）。
   *
   * ⚠️ 未配置 `CREDENTIAL_KEY` 时**抛错**，不静默明文落盘（AGENTS.md §7.1）。
   * 静默降级是最糟的选择 —— 用户会以为已经加密了。
   */
  async putCredential(uid: string, credential: unknown, now: number): Promise<void> {
    const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    const ciphertext = await encryptCredential(key, credential)
    writeCredential(this.ctx.storage.sql, uid, ciphertext, now)
  }

  /**
   * 读取并解密凭据。不存在返回 undefined；解密失败抛错（GCM 认证保证不返回垃圾）。
   *
   * ⚠️ 返回 `unknown` 而不是泛型：**DO RPC 的类型映射不支持把泛型参数透传**
   * （写成 `getCredential<T>()` 会在调用点报 `Expected 0 type arguments`）。
   * 由调用方在边界处断言一次具体类型。
   */
  async getCredential(uid: string): Promise<unknown | undefined> {
    const ciphertext = readCredential(this.ctx.storage.sql, uid)
    if (ciphertext === undefined) return undefined
    const key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    return await decryptCredential(key, ciphertext)
  }

  /**
   * 批量取「各账号凭据的过期时刻」（一次 RPC，不是 N 次）。
   *
   * ## 为什么需要它
   *
   * 用户报「动不动就掉登录」时，面板要能回答「是凭据过期了，还是账号被限流」——
   * 这两者的处置**完全不同**（前者等自动续期，后者要重新登录）。
   * 而 `expiresAt` 是加密存在凭据里的，逐账号 `getCredential` 会产生 N 次
   * DO RPC（账号多时开销明显）。
   *
   * ⚠️ **解密失败/DTO 异常一律记 `null`**，绝不让一个坏凭据把整个列表打成 500
   *（与 `listAccounts` 里「解析失败就跳过该条」同一取舍）。
   *
   * @returns `uid → 过期时刻(ms)`；未知/读不到为 `null`。
   */
  async listCredentialExpiry(now: number): Promise<Record<string, number | null>> {
    void now
    const out: Record<string, number | null> = {}
    // ⚠️ `requireCredentialKey` 返回的是**字符串密钥**（内部再派生），
    // 而 `decryptCredential(secret: string, stored: string)` 收的也是字符串 ——
    // 我第一版误标成 `CryptoKey` 并传给 `decryptCredential`，两处类型都不对。
    let key: string
    try {
      key = requireCredentialKey(this.env.CREDENTIAL_KEY)
    } catch {
      // 未配密钥 ⇒ 全部无从判断（不是错误，是「读不到」）。
      return out
    }
    // ⚠️ `listCredentialUids()` 是 **async**（DO 方法），必须 await。
    for (const uid of await this.listCredentialUids()) {
      const ciphertext = readCredential(this.ctx.storage.sql, uid)
      if (ciphertext === undefined) {
        out[uid] = null
        continue
      }
      try {
        const credential = (await decryptCredential(key, ciphertext)) as { expiresAt?: unknown }
        const e = credential?.expiresAt
        out[uid] = typeof e === 'number' && Number.isFinite(e) && e > 0 ? e : null
      } catch {
        // 解密失败（密钥换了 / 数据损坏）⇒ 如实记 null，不让整表失败。
        out[uid] = null
      }
    }
    return out
  }

  /** 删除凭据。 */
  async removeCredential(uid: string): Promise<void> {
    deleteCredential(this.ctx.storage.sql, uid)
  }

  /** 列出持有凭据的 uid（**不返回密文**）。 */
  async listCredentialUids(): Promise<string[]> {
    return listCredentialUids(this.ctx.storage.sql)
  }

  // ─────────────────────── 登录会话（设备码） ───────────────────────

  /**
   * 保存登录会话。
   *
   * ⚠️ 必须持久化：isolate 随时可能被回收，「发起登录」与「轮询结果」
   * 会落到不同 isolate。放内存会表现为「state 永远未知」。
   */
  async saveLoginSession(state: string, payload: unknown, expiresAt: number): Promise<void> {
    writeLoginSession(this.ctx.storage.sql, state, JSON.stringify(payload), expiresAt)
  }

  /**
   * 读登录会话（已过期视为不存在）。
   *
   * ⚠️ 同 `getCredential`：返回 `unknown`，泛型不透传 DO RPC。
   */
  async getLoginSession(state: string, now: number): Promise<unknown | undefined> {
    const raw = readLoginSession(this.ctx.storage.sql, state, now)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  /** 删除登录会话（完成或放弃后清理）。 */
  async removeLoginSession(state: string): Promise<void> {
    deleteLoginSession(this.ctx.storage.sql, state)
  }

  /** 清理过期登录会话。 */
  async pruneLoginSessions(now: number): Promise<number> {
    return pruneLoginSessions(this.ctx.storage.sql, now)
  }

  // ─────────────────────── 模型开关 ───────────────────────

  /**
   * 读某供应商被**停用**的模型 id 列表。
   *
   * ⚠️ 这是「面板层」的开关，与「模型级冷却」（上游限流）是两回事：
   * - 冷却：上游说这个模型暂时不可用，**自动**恢复；
   * - 停用：用户**手动**选择不用它，只有手动才能恢复。
   *
   * 两者不能混用一个字段 —— 混了会导致「手动停用的模型在冷却到期后
   * 自动复活」，或「被限流的模型被误认为用户停用」。
   */
  async getDisabledModels(provider: string): Promise<string[]> {
    const all = (await this.ctx.storage.get<Record<string, string[]>>('disabledModels')) ?? {}
    return all[provider] ?? []
  }

  /** 设置某供应商的停用模型列表。 */
  /**
   * 清账号级冷却与熔断（`until` / `breakerUntil` / `degradeUntil` / 连续失败计数）。
   *
   * ⚠️ 运维入口：排查「账号明明健康却选不到号」时用 ——
   * 实测踩到：codearts 账号因连续失败进了熔断（`breakerUntil` 未来 7 分钟），
   * 面板显示 disabled=false、until=0，但 pick 就是不返回它，
   * 报的是「没有可用账号」—— 完全看不出是熔断。
   *
   * 与 `clearModelCooldowns` 分开：那个清**模型级**，这个清**账号级**。
   */
  async clearCooldowns(realm: string, uid?: string): Promise<number> {
    const states: Array<AccountState | undefined> = uid === undefined
      ? listAccounts(this.ctx.storage.sql, realm).map((r) => normalizeAccountState(JSON.parse(r)))
      : [normalizeAccountState(JSON.parse(readAccount(this.ctx.storage.sql, uid) ?? 'null'))]
    let n = 0
    for (const state of states) {
      if (state === undefined) continue
      if (state.until !== 0 || state.breakerUntil !== 0 || state.degradeUntil !== 0 || state.fails !== 0) {
        state.until = 0
        state.breakerUntil = 0
        state.degradeUntil = 0
        state.coolKind = ''
        state.fails = 0
        state.retryCount = 0
        state.softStreak = 0
        state.consecutiveFails = 0
        state.sessionDeadFails = 0
        writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
        n += 1
      }
    }
    return n
  }

  async setDisabledModels(provider: string, models: string[]): Promise<void> {
    const all = (await this.ctx.storage.get<Record<string, string[]>>('disabledModels')) ?? {}
    all[provider] = models
    await this.ctx.storage.put('disabledModels', all)
  }

  // ─────────────────────── 用量统计 ───────────────────────

  /**
   * 记录一次请求的用量。
   *
   * ⚠️ 整条环形缓冲存在**一个 storage key** 里（`usage:ring`），而不是一行一条记录。
   * 理由：Free 计划 DO 行写入配额 100,000/天，一次对话写一行会在正常使用下撞配额；
   * 而我们要的是**近期趋势**，不是审计账本。
   *
   * 单次读改写：DO 是单线程的，不存在并发写覆盖问题。
   */
  async recordUsage(record: UsageRecord): Promise<void> {
    const ring = (await this.ctx.storage.get<UsageRecord[]>('usage:ring')) ?? []
    ring.push(record)
    await this.ctx.storage.put('usage:ring', trimUsageRing(ring))
  }

  /** 读取用量概览（聚合在内存里做）。 */
  async usageSummary(): Promise<UsageSummary> {
    const ring = (await this.ctx.storage.get<UsageRecord[]>('usage:ring')) ?? []
    return summarizeUsage(ring)
  }

  /** 清空用量记录。 */
  async clearUsage(): Promise<void> {
    await this.ctx.storage.put('usage:ring', [])
  }

  // ─────────────────────── 请求日志（环形缓冲） ───────────────────────

  /**
   * 追加一条请求日志。
   *
   * ⚠️ 与用量分开存：日志条目更大（含 UA、IP 等），且只用于排查，
   * 不应挤占用量统计的空间。上限更小（200 条）。
   */
  async appendLog(entry: Record<string, unknown>): Promise<void> {
    const ring = (await this.ctx.storage.get<Array<Record<string, unknown>>>('log:ring')) ?? []
    ring.push(entry)
    // 只保留最近 200 条（按插入顺序，日志天然有序）
    await this.ctx.storage.put('log:ring', ring.slice(-200))
  }

  /** 读日志（最新的在前）。 */
  async readLogs(limit = 100): Promise<Array<Record<string, unknown>>> {
    const ring = (await this.ctx.storage.get<Array<Record<string, unknown>>>('log:ring')) ?? []
    return ring.slice(-Math.max(1, Math.min(limit, 200))).reverse()
  }

  /** 清空日志。 */
  async clearLogs(): Promise<void> {
    await this.ctx.storage.put('log:ring', [])
  }

    /**
   * 清除模型级冷却（面板「解冻」用）。
   *
   * ## 为什么必须有这个入口
   *
   * 模型级冷却的退避是 **6 小时起步、封顶 24 小时**（对齐上游语义：11102 =
   * 该后端没有这个模型）。但有些失败**并不是上游真的没有这个模型**，
   * 而是我方请求有问题（实测：模型名带了 `provider/` 前缀，
   * 上游回 `model [...] service info not found`，被记成 11102）。
   *
   * 那种情况下用户会看到「这个模型选不到号」并**只能等 6 小时** ——
   * 而真实原因是我们的 bug 已经修好了。故必须留人工纠正入口。
   *
   * @param model 指定模型则只清它；不传则清全部。
   */
  async clearModelCooldowns(realm: string, uid: string | undefined, model?: string): Promise<number> {
    // ⚠️ 只有传了 uid 时才需要读单条；不传就扫整个 realm。
    // （DO 本身按 realm 分片，故 realm 只是过滤条件，不是路由信息。）
    if (uid !== undefined) {
      const raw = readAccount(this.ctx.storage.sql, uid)
      if (raw === undefined) return 0
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined) return 0
      const keys = model === undefined ? Object.keys(state.modelCooldowns) : (state.modelCooldowns[model] === undefined ? [] : [model])
      if (keys.length === 0) return 0
      for (const k of keys) delete state.modelCooldowns[k]
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
      return keys.length
    }

    const raws = listAccounts(this.ctx.storage.sql, realm)
    let cleared = 0
    for (const raw of raws) {
      const state = normalizeAccountState(JSON.parse(raw))
      if (state === undefined) continue
      const keys = model === undefined ? Object.keys(state.modelCooldowns) : (state.modelCooldowns[model] === undefined ? [] : [model])
      if (keys.length === 0) continue
      for (const k of keys) delete state.modelCooldowns[k]
      writeAccount(this.ctx.storage.sql, state.uid, state.realm, JSON.stringify(state), Date.now())
      cleared += keys.length
    }
    return cleared
  }

  // ─────────────────────── IP 级 WAF 拦截护栏 ───────────────────────

  /**
   * 记录一次**某个账号**命中 WAF 403，返回记账后 IP 级拦截是否激活。
   *
   * ## 语义（逐条对齐 Go 侧 `wafip.go:50-72`）
   *
   * - **已激活期内**新命中：不续期、不记账 —— 保守地「自然解除」，
   *   而不是被持续命中无限延长；
   * - **未激活**：记 `hits[uid] = now`（同号重复命中**覆盖**而不累计 ——
   *   判据是「不同号数」），剪掉窗外的旧命中；
   * - 不同 uid 数达阈值 → 激活到 `now + window`，并**清空判定窗**
   *   （解除后需要全新命中重新判定，不叠旧账）。
   */
  async noteWaf(uid: string, now: number): Promise<boolean> {
    const gate = await this.loadWafGate()

    if (gate.until > now) {
      // 激活期内：不续期、不记账
      return true
    }

    gate.hits[uid] = now
    // 剪枝：删掉窗口外的
    for (const [u, t] of Object.entries(gate.hits)) {
      if (now - t > WAF_IP_WINDOW_MS) delete gate.hits[u]
    }

    if (Object.keys(gate.hits).length >= WAF_IP_THRESHOLD) {
      gate.until = now + WAF_IP_WINDOW_MS
      gate.hits = {} // 清空：解除后需全新命中重新判定
      await this.saveWafGate(gate)
      // 面板与日志都需要看到「这是 IP 级，不是账号级」
      console.warn(
        `[waf] IP 级拦截激活：${WAF_IP_WINDOW_MS / 1000}s 内 ${WAF_IP_THRESHOLD} 个不同账号命中 403，` +
          `暂停轮转至 +${WAF_IP_WINDOW_MS / 1000}s`,
      )
      return true
    }

    await this.saveWafGate(gate)
    return false
  }

  /** IP 级拦截是否激活（只读，不记账）。 */
  async wafGateActive(now: number): Promise<boolean> {
    const gate = await this.loadWafGate()
    return gate.until > now
  }

  /** 查询 gate 完整状态（供面板展示「是不是 IP 被拦了」）。 */
  async wafGateStatus(now: number): Promise<{ active: boolean; until: number; recentUids: number }> {
    const gate = await this.loadWafGate()
    let recent = 0
    for (const t of Object.values(gate.hits)) {
      if (now - t <= WAF_IP_WINDOW_MS) recent += 1
    }
    return { active: gate.until > now, until: gate.until, recentUids: recent }
  }

  /**
   * 人工解除 IP 级拦截（面板「解冻」用）。
   *
   * ⚠️ 刻意提供这个入口：gate 是**保守的推测**，接受人工纠正。
   * 若实际是账号级问题却被误判成 IP 级，用户需要能立刻恢复。
   */
  async clearWafGate(): Promise<void> {
    await this.ctx.storage.put('wafGate', { until: 0, hits: {} })
  }

  /** 读 gate 状态（不存在时返回空表）。 */
  private async loadWafGate(): Promise<{ until: number; hits: Record<string, number> }> {
    const raw = await this.ctx.storage.get<{ until?: unknown; hits?: unknown }>('wafGate')
    const until = typeof raw?.until === 'number' ? raw.until : 0
    const hits: Record<string, number> = {}
    if (raw?.hits !== null && typeof raw?.hits === 'object' && !Array.isArray(raw?.hits)) {
      for (const [k, v] of Object.entries(raw.hits as Record<string, unknown>)) {
        if (typeof v === 'number') hits[k] = v
      }
    }
    return { until, hits }
  }

  /** 写 gate 状态（**必须持久化**：DO 随时可能被回收）。 */
  private async saveWafGate(gate: { until: number; hits: Record<string, number> }): Promise<void> {
    await this.ctx.storage.put('wafGate', gate)
  }
}

/**
 * 次日 04:00（UTC+8）。
 *
 * 用**固定 +8 偏移**而不是 `Intl` / 本机时区：Workers 恒为 UTC，
 * 且 Go 侧明确记录「不依赖容器 tzdata」（`travel.go:36`）。
 *
 * 边界语义：04:00 **之前**返回当天 04:00（此时当日签到还没跑，等当天签到即可），
 * 04:00 之后返回次日 04:00。与 Go 侧 `cooldown.go:409-418` 逐字一致。
 */
export function nextDay4AmUtc8(now: number): number {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const shifted = now + CST_OFFSET
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000
  const today4am = dayStart + 4 * 60 * 60 * 1000
  const target = shifted < today4am ? today4am : today4am + 86_400_000
  return target - CST_OFFSET
}
