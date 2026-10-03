/**
 * 账号状态模型：四维**正交**的惩罚状态机。
 *
 * ## 为什么是「四维正交」而不是一个统一的「不可用」标志
 *
 * 移植自 Go 侧 `internal/pool/entry.go` + `transition.go` 的实测设计。四个维度
 * 由**不同的现实原因**驱动，混在一起会导致误伤：
 *
 * | 维度 | 触发原因 | 语义 | 恢复条件 |
 * |---|---|---|---|
 * | `until` / `coolKind` | 402 余额耗尽、429 限流、403 WAF | 「近期被限流/没钱」 | 到期，或余额恢复（仅 CoolHard） |
 * | `modelCooldowns` | 429 `code=6004`、`11102` | 「仅对**某几个模型**不可用」 | 各模型自己的重置墙钟 |
 * | `breakerUntil` | 连续 5xx/网络失败 | 「这个号反复失败，先别打」 | 指数退避到期 |
 * | `degradeUntil` | 连续业务失败 | 「降权，别当首选」 | 固定时长到期 |
 *
 * **关键正交性**（Go 侧 `transition.go:9-26` 明确记录）：
 * - `disableLocked`（禁用）只清**冷却域**，**不动熔断** —— 禁用是授权/session
 *   终态，不应覆盖熔断观测；
 * - `NoteSuccess` 清熔断与降权，**不碰 `modelCooldowns`** —— 一次成功不能证明
 *   某个模型已解除限流。
 *
 * `healthy()` 是**并列或门**（任一未到期即不可选），天然「取最远者」，不需要
 * 显式比较长短。
 */

/** 冷却种类。`hard` 是余额耗尽（到次日 04:00），`soft` 是可恢复的限流。 */
export type CoolKind = '' | 'soft' | 'hard'

/**
 * 单个 (账号, 模型) 的独立冷却记录。
 *
 * 承载**两种语义**（Go 侧 `entry.go:141-160`）：
 * - **6004 限流**：`until` 对齐上游重置墙钟（`resetAt` 保留原始值供展示）；
 * - **11102 该后端无此模型**：指数退避（6h 起，封顶 24h）。
 */
export interface ModelCooldown {
  /** 冷却截止（epoch ms）。 */
  until: number
  /** 上游给出的原始重置时刻（epoch ms）；0 表示无。 */
  resetAt: number
  /** 原因标签，用于区分 6004 与 11102（清理由此判定，不可混淆）。 */
  reason: string
  /**
   * 已连续命中次数，驱动 11102 的指数退避。
   * ⚠️ 刻意**不落盘**（Go 侧同口径）：重启后从基数重新学习，避免陈旧计数永久放大。
   */
  hits: number
  /**
   * 仅审计用途，**不参与**可用性判定。
   * ⚠️ `healthyForModel` / `modelExempt` 必须忽略它，否则审计条目会误伤选号。
   */
  auditOnly: boolean
}

/** 实测扣费账本条目（用于判断某模型是否免费，决定积分保底是否拦截）。 */
export interface ModelCost {
  /** 每 1k token 的实测单价。 */
  per1k: number
  /** 最近一次观测时间（epoch ms）。 */
  lastSeen: number
}

/** 令牌用量统计（纯观测，不影响调度）。 */
export interface TokenUsage {
  input: number
  output: number
}

/**
 * 账号的完整持久化状态。
 *
 * ⚠️ 与 Go 侧 `stateAccount` 的差异：Go 用 `*time.Time` + `omitempty` 实现
 * 「过期不落盘」。这里用 `number`（epoch ms）+ `0` 表示「无」——
 * `0` 在 JS 里是 falsy 但**语义明确**，且 JSON 里可省略。
 * 判据统一走 {@link isActive}，不靠 truthiness。
 */
export interface AccountState {
  /** 上游 uid（账号主键）。 */
  uid: string
  /**
   * 供应商 id（`workbuddy` / `cline` / …）。
   *
   * ⚠️ 加这一维是**必须**的，不是锦上添花：不同供应商的 uid 空间互相独立，
   * 且同一份凭据在不同供应商下语义完全不同（端点、鉴权、错误分类都不同）。
   * 没有它就无法回答「这个号该用哪套协议」。
   *
   * 缺省值 `workbuddy` 是为了兼容升级前已存的账号（它们只可能是 WorkBuddy）。
   */
  provider: string
  /** 昵称（仅展示）。 */
  nickname: string
  /** 域：`cn` / `global`。 */
  realm: string
  /** 是否被禁用（终态，需人工或余额恢复解冻）。 */
  disabled: boolean
  /** 禁用原因。 */
  reason: string

  // ── 冷却域 ──
  /** 账号级冷却截止（epoch ms，0 = 无）。 */
  until: number
  /** 冷却种类。 */
  coolKind: CoolKind
  /** 连续软冷却次数，驱动指数退避。`NoteSuccess` 清零。 */
  softStreak: number
  /** 模型级冷却表。 */
  modelCooldowns: Record<string, ModelCooldown>

  // ── 熔断域 ──
  /** 熔断截止（epoch ms，0 = 无）。 */
  breakerUntil: number
  /** 已熔断次数（指数退避的指数）。 */
  retryCount: number
  /** 连续失败计数（喂熔断器）。**唯一**权威连续失败计数。 */
  fails: number

  // ── 降权域 ──
  /** 降权截止（epoch ms，0 = 无）。 */
  degradeUntil: number
  /** 连败降权进度。 */
  consecutiveFails: number

  // ── session 死亡计数 ──
  /** 连续 12153 计数。达阈值（3）才禁用 —— 单次多为网络抖动。 */
  sessionDeadFails: number

  // ── 观测与账本 ──
  successCount: number
  errTotal: number
  lastSuccess: number
  lastErr: number
  /** 最近一次签到成功的 UTC+8 日期（`YYYY-MM-DD`）。 */
  lastCheckinDay: string
  tokenUsage: TokenUsage
  modelCosts: Record<string, ModelCost>

  // ── 积分快照 ──
  credits: number
  /** 快过期积分子集（`credits` 的子集）。 */
  creditsExpiring: number
  /** 最早到期时刻（epoch ms）。 */
  creditsEarliestExpiry: number
}

/** 连续 12153 达此值才禁用（Go 侧 `entry.go:516`）。 */
export const SESSION_DEAD_THRESHOLD = 3

/** 创建一个空白账号状态（所有计数字段显式归零，不依赖 undefined）。 */
export function createAccountState(input: {
  uid: string
  nickname: string
  realm: string
  /** 供应商 id。缺省 `workbuddy`（兼容升级前只可能是它）。 */
  provider?: string
}): AccountState {
  return {
    uid: input.uid,
    provider: input.provider ?? 'workbuddy',
    nickname: input.nickname,
    realm: input.realm,
    disabled: false,
    reason: '',
    until: 0,
    coolKind: '',
    softStreak: 0,
    modelCooldowns: {},
    breakerUntil: 0,
    retryCount: 0,
    fails: 0,
    degradeUntil: 0,
    consecutiveFails: 0,
    sessionDeadFails: 0,
    successCount: 0,
    errTotal: 0,
    lastSuccess: 0,
    lastErr: 0,
    lastCheckinDay: '',
    tokenUsage: { input: 0, output: 0 },
    modelCosts: {},
    credits: 0,
    creditsExpiring: 0,
    creditsEarliestExpiry: 0,
  }
}

/**
 * 把已存的 JSON 归一成完整 `AccountState`。
 *
 * ## 为什么需要它（而不是直接 `as AccountState`）
 *
 * 账号状态是**跨版本持久化**的：升级前存的记录里没有后来新增的字段。
 * 直接断言类型会让那些字段变成 `undefined` —— 而 `undefined` 在布尔语境里
 * 是 falsy、在算术里是 `NaN`，会在**很远的地方**引发难以定位的故障。
 *
 * 故每次从存储读出都过一遍这里，显式补默认值。
 * 这与本项目「不静默接受坏数据」的纪律一致：宁可在这里补，也不要在业务逻辑里猜。
 */
export function normalizeAccountState(raw: unknown): AccountState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const uid = typeof o.uid === 'string' ? o.uid : ''
  if (uid === '') return undefined

  const base = createAccountState({
    uid,
    nickname: typeof o.nickname === 'string' ? o.nickname : '',
    realm: typeof o.realm === 'string' ? o.realm : 'cn',
    // ⚠️ 升级前存的账号只可能是 WorkBuddy，故缺省值就是它
    provider: typeof o.provider === 'string' && o.provider !== '' ? o.provider : 'workbuddy',
  })

  // 逐字段合并（只认类型正确的值，其余保留默认）
  const num = (k: string, d: number): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d)
  const str = (k: string, d: string): string => (typeof o[k] === 'string' ? (o[k] as string) : d)
  const bool = (k: string, d: boolean): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  const obj = <T>(k: string, d: T): T =>
    o[k] !== null && typeof o[k] === 'object' && !Array.isArray(o[k]) ? (o[k] as T) : d

  return {
    ...base,
    disabled: bool('disabled', base.disabled),
    reason: str('reason', base.reason),
    until: num('until', base.until),
    coolKind: str('coolKind', base.coolKind) as AccountState['coolKind'],
    softStreak: num('softStreak', base.softStreak),
    modelCooldowns: obj('modelCooldowns', base.modelCooldowns),
    breakerUntil: num('breakerUntil', base.breakerUntil),
    retryCount: num('retryCount', base.retryCount),
    fails: num('fails', base.fails),
    degradeUntil: num('degradeUntil', base.degradeUntil),
    consecutiveFails: num('consecutiveFails', base.consecutiveFails),
    sessionDeadFails: num('sessionDeadFails', base.sessionDeadFails),
    successCount: num('successCount', base.successCount),
    errTotal: num('errTotal', base.errTotal),
    lastSuccess: num('lastSuccess', base.lastSuccess),
    lastErr: num('lastErr', base.lastErr),
    lastCheckinDay: str('lastCheckinDay', base.lastCheckinDay),
    tokenUsage: obj('tokenUsage', base.tokenUsage),
    modelCosts: obj('modelCosts', base.modelCosts),
    credits: num('credits', base.credits),
    creditsExpiring: num('creditsExpiring', base.creditsExpiring),
    creditsEarliestExpiry: num('creditsEarliestExpiry', base.creditsEarliestExpiry),
  }
}

/** 该时刻是否仍在未来（`0` = 无，恒为 false）。 */
export function isActive(deadline: number, now: number): boolean {
  return deadline > 0 && now < deadline
}

/**
 * 账号当前是否可选。
 *
 * ⚠️ 这是**并列或门**，不是加权叠加：任一维度未到期即不可选。
 * 因此天然「取最远者」，无需显式比较三个截止时间的长短。
 */
export function healthy(state: AccountState, now: number): boolean {
  if (state.disabled) return false
  if (isActive(state.until, now)) return false
  if (isActive(state.breakerUntil, now)) return false
  if (isActive(state.degradeUntil, now)) return false
  return true
}

/**
 * 该账号对指定模型是否可用。
 *
 * 只有**该模型的**冷却未过期才拦截；其他模型的冷却不影响本模型 ——
 * 这正是「6004 不该罚整个账号」的实现。
 */
export function healthyForModel(state: AccountState, now: number, model: string): boolean {
  if (!healthy(state, now)) return false
  if (model === '') return true
  const mc = state.modelCooldowns[model]
  if (mc === undefined) return true
  // ⚠️ 审计条目不参与判定，否则会误伤选号。
  if (mc.auditOnly) return true
  return !isActive(mc.until, now)
}

/**
 * 是否处于「6004 模型级软冷却」形态：账号本身健康，但存在某模型的独立冷却。
 *
 * 此形态下账号**仅对限流中的模型不可用**，其他模型仍可选。
 * 供 `/healthz` 探活与选号共用，保证两者口径一致（Go 侧 issue #31 的教训）。
 */
export function modelExempt(state: AccountState, now: number): boolean {
  if (state.disabled) return false
  if (isActive(state.until, now)) return false
  if (isActive(state.degradeUntil, now)) return false
  if (isActive(state.breakerUntil, now)) return false
  for (const mc of Object.values(state.modelCooldowns)) {
    if (!mc.auditOnly && mc.until > 0) return true
  }
  return false
}

/**
 * 清理已过期的模型冷却与陈旧成本账本（惰性剪枝）。
 *
 * ⚠️ 必须**在每次读取前**调用，否则过期条目会一直留在表里，
 * 让 `modelExempt` 误报「有模型在冷却」。
 */
export function pruneExpired(state: AccountState, now: number, costTtlMs: number): boolean {
  let changed = false

  for (const [model, mc] of Object.entries(state.modelCooldowns)) {
    if (mc.until > 0 && now >= mc.until) {
      delete state.modelCooldowns[model]
      changed = true
    }
  }

  for (const [model, cost] of Object.entries(state.modelCosts)) {
    if (cost.lastSeen <= 0 || now - cost.lastSeen > costTtlMs) {
      delete state.modelCosts[model]
      changed = true
    }
  }

  return changed
}
