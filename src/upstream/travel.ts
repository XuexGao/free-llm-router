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
export async function travelDepart(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ departed: boolean; detail: string }> {
  const r = await growthCall(ctx, env, 'POST', '/activity/growth/buddy/travel/depart', '{}')
  if (r.ok) return { departed: true, detail: '已派出旅行' }
  // 「已达上限」不是失败：今天已经派过了
  if (/limit|already|上限/i.test(r.msg) || r.code === 10001) {
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
  if (/not|arriv|未|还没/i.test(r.msg) || r.code === 10001) {
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
