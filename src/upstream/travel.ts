/**
 * 猫猫旅行 / 连登兑换 / 抽奖（growth 域，走 chat base）。
 *
 * ## 幂等策略：靠**上游状态**而不是本地标记
 *
 * 这几个动作的上游状态机本身就是幂等的：
 * - 旅行：`TravelState.State`（idle/traveling/arrived）+ `DailyLimitReached`；
 * - 连登兑换：`status == "locked" | "claimed"` 即跳过；
 * - 抽奖：按 `chances` 抽完为止。
 *
 * ⇒ 每次执行前**先读状态**，再决定做什么。这样天然抗重放，
 * 也不需要本地维护「今天做过了」的标记（那反而会与上游状态不一致）。
 *
 * ## 时区
 *
 * 用**固定 +8 偏移**，不依赖 `Intl` / 本机时区（Workers 恒 UTC）。
 * Go 侧明确记录「不依赖容器 tzdata」（`travel.go:36`）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { desktopHeaders } from './headers.js'

/** 旅行状态。 */
export interface TravelStatus {
  /** `idle` / `traveling` / `arrived`。 */
  state: string
  /** 今日已达上限。 */
  dailyLimitReached: boolean
  /** 目的地（展示用）。 */
  destination: string
}

/** 连登状态。 */
export interface StreakStatus {
  days: number
  monthTotalDays: number
  /** 已解锁但未兑换的档位（如 `7` / `14` / `28`）。 */
  redeemableTiers: string[]
  /** 可抽奖次数。 */
  lotteryChances: number
}

/** 用固定 +8 偏移算「今天」（`YYYY-MM-DD`）。 */
export function cstDay(now: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  return new Date(now + CST_OFFSET).toISOString().slice(0, 10)
}

/** 生成幂等令牌（前端 `randomUUID` 同款语义）。 */
export function clientToken(): string {
  return crypto.randomUUID()
}

/** growth 域通用请求。 */
async function growthCall(
  ctx: { uid: string; accessToken: string },
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: string,
): Promise<{ ok: boolean; httpStatus: number; data: unknown; raw: string; code: number | undefined; msg: string }> {
  const bases = resolveUpstream(env)
  const res = await callUpstream({
    method,
    url: `${bases.chat}${path}`,
    headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body,
  })
  const c = classify(res.httpStatus, res.raw)
  return {
    ok: res.ok,
    httpStatus: res.httpStatus,
    data: res.envelope?.data,
    raw: res.raw,
    code: res.envelope?.code,
    msg: c.msg,
  }
}

/** 读旅行状态。 */
export async function travelStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<TravelStatus> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/buddy/travel/status')
  if (!r.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: r.httpStatus,
      code: r.code,
      message: `旅行状态查询失败：${r.msg || r.raw.slice(0, 120)}`,
      detail: r.raw.slice(0, 400),
    })
  }
  const d = (r.data ?? {}) as Record<string, unknown>
  return {
    state: typeof d.state === 'string' ? d.state : '',
    dailyLimitReached: d.daily_limit_reached === true,
    destination: typeof d.destination === 'string' ? d.destination : '',
  }
}

/**
 * 派猫猫出门旅行。
 *
 * 幂等：上游按 `DailyLimitReached` 保护，重复调用不会重复派出。
 * 故调用前不必查状态（但查了更省一次请求 —— 由调用方决定）。
 */
/**
 * 「没有可领的旅行奖励」算不算正常？
 *
 * ## ⚠️ 为什么抽成纯函数（实测踩到）
 *
 * 上游对「还没到领的时候」回的是 `no unclaimed travel`，
 * 而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
 *（`unclaimed` 不含 `not`、`travel` 不含 `arriv`）⇒ 被当成未知错误抛出，
 * 面板上那一步显示**红色 ERR** —— 而真实情况是**正常**。
 *
 * 抽成纯函数是为了**能单测**：判据散在 async 函数里时只能做脆弱的源码正则断言，
 * 那种测试既容易误报也锁不住行为。
 */
export function isNoUnclaimedTravel(code: number | undefined, msg: string): boolean {
  if (code === 10001) return true
  return /unclaim|not|arriv|none|empty|未|还没|没有/i.test(msg)
}

/**
 * 「今天已经派过旅行」算不算正常？
 *
 * ⚠️ 同样抽成纯函数以便单测 —— 判据要覆盖上游会回的多种文案，
 * 漏一个就会把正常状态报成红色错误。
 */
export function isAlreadyDeparted(code: number | undefined, msg: string): boolean {
  if (code === 10001) return true
  return /limit|already|traveling|in ?progress|上限|已在|进行中/i.test(msg)
}

export async function travelDepart(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ departed: boolean; detail: string }> {
  const r = await growthCall(ctx, env, 'POST', '/activity/growth/buddy/travel/depart', '{}')
  if (r.ok) return { departed: true, detail: '已派出旅行' }
  // 「已达上限 / 已在旅行中」都不是失败：今天已经派过了。
  // ⚠️ 判据同 `travelClaim`：要覆盖上游实际会回的多种文案
  //（`limit` / `already` / `traveling` / `in progress` / 中文），
  // 漏一个就会把「正常状态」报成红色错误。
  if (isAlreadyDeparted(r.code, r.msg)) {
    return { departed: false, detail: '今日已派出过（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `派出旅行失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 领旅行奖励（猫猫回来了才有）。 */
export async function travelClaim(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ claimed: boolean; detail: string }> {
  const r = await growthCall(ctx, env, 'POST', '/activity/growth/buddy/travel/claim', '{}')
  if (r.ok) return { claimed: true, detail: '旅行奖励已领取' }
  // ⚠️ 判据要**宽**，且必须覆盖实测遇到的文案。
  //
  // 实测（2026-10-04，线上任务运行）：上游对「没有可领奖励」回的是
  // `no unclaimed travel` —— 而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
  //（`unclaimed` 不含 `not`，`travel` 不含 `arriv`），于是被当成未知错误抛出去。
  // 表现为面板上旅行那一步**显示红色 ERR**，而真实情况是「正常，只是还没到领的时候」。
  //
  // ⇒ 补上 `unclaim` / `no ` / `none` / `empty`；业务码 `10001` 是既有的幂等码。
  if (isNoUnclaimedTravel(r.code, r.msg)) {
    return { claimed: false, detail: '尚无可领奖励（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `领旅行奖励失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 读连登状态（含可兑换档位与抽奖次数）。 */
export async function streakStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<StreakStatus> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/streak')
  if (!r.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: r.httpStatus,
      code: r.code,
      message: `连登状态查询失败：${r.msg || r.raw.slice(0, 120)}`,
      detail: r.raw.slice(0, 400),
    })
  }
  const d = (r.data ?? {}) as Record<string, unknown>
  const streak = (d.streak ?? {}) as Record<string, unknown>

  // 档位列表：上游下发数组，元素含 tier/status
  const tiers = Array.isArray(d.tiers) ? d.tiers : []
  const redeemableTiers: string[] = []
  for (const raw of tiers) {
    if (raw === null || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const status = typeof t.status === 'string' ? t.status : ''
    const tier = typeof t.tier === 'string' ? t.tier : ''
    // ⚠️ 跳过 locked 与 claimed（Go 侧 `streak.go:60-61` 同口径）
    if (tier !== '' && status !== 'locked' && status !== 'claimed') {
      redeemableTiers.push(tier)
    }
  }

  return {
    days: typeof streak.days === 'number' ? streak.days : 0,
    monthTotalDays: typeof streak.month_total_days === 'number' ? streak.month_total_days : 0,
    redeemableTiers,
    lotteryChances: typeof d.lottery_chances === 'number' ? d.lottery_chances : 0,
  }
}

/** 兑换连登档位。幂等：已兑换/未解锁由上游拒绝，不视为失败。 */
export async function redeemTier(
  ctx: { uid: string; accessToken: string },
  env: Env,
  tier: string,
): Promise<{ redeemed: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/redeem',
    JSON.stringify({ tier, client_token: clientToken() }),
  )
  if (r.ok) return { redeemed: true, detail: `档位 ${tier} 已兑换` }
  if (/locked|claimed|已|未解锁/i.test(r.msg) || r.code === 10001) {
    return { redeemed: false, detail: `档位 ${tier} 不可兑换（幂等命中）` }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `兑换档位 ${tier} 失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/**
 * 抽奖一次。
 *
 * 幂等：调用方应先读 `lotteryChances`，按次数抽完即停
 * （Go 侧 `streak.go:72-84` 同口径）。
 */
export async function lotteryDraw(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ drawn: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/lottery/draw',
    JSON.stringify({ client_token: clientToken() }),
  )
  if (r.ok) return { drawn: true, detail: '抽奖成功' }
  if (/chance|次数|已用完/i.test(r.msg) || r.code === 10001) {
    return { drawn: false, detail: '没有可抽次数（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `抽奖失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 按可用次数把抽奖抽完（有界：最多 maxDraws 次，防上游返回异常大的次数）。 */
export async function drawAllLottery(
  ctx: { uid: string; accessToken: string },
  env: Env,
  chances: number,
  maxDraws = 20,
): Promise<{ drawn: number; details: string[] }> {
  const limit = Math.min(Math.max(0, chances), maxDraws)
  const details: string[] = []
  let drawn = 0
  for (let i = 0; i < limit; i += 1) {
    const r = await lotteryDraw(ctx, env)
    details.push(r.detail)
    if (!r.drawn) break
    drawn += 1
  }
  return { drawn, details }
}
