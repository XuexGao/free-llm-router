/**
 * 签到与余额（billing 域）。
 *
 * ## 两个实测要点
 *
 * 1. **必须用 `checkin-activity-status` 查签到状态**，不能用 `checkin-status`。
 *    后者返回占位数据（`active:false`、`checkin_dates:null`），会被误判成
 *    「活动未开启」而放弃签到（Go 侧 `credits.ts:11-13` 记录）。
 * 2. **幂等判据是服务端业务码** `10001`/`1001`（`credits.ts:57-59`），
 *    **不是 HTTP 状态码** —— 重复签到同样返回 200，但 code 非 0。
 *
 * ## 与 DSH 插件的差异（已实测）
 *
 * `deepseek-harness-codearts` 的 `credits.ts:15-17` 记录：**不需要 `X-Device-Token`**（图灵盾）。
 * 三种头组合实测都 200。本项目沿用其请求头形状，不注入 device token。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { billingHeaders } from './headers.js'

/** 签到结果。 */
export interface CheckinResult {
  /** 是否本次真的签到成功（false 表示之前已签，或本次无领取资格）。 */
  claimed: boolean
  /** 幂等命中（今天已签过）。 */
  alreadyDone: boolean
  /** 服务端返回的本次到账积分（可能为 0）。 */
  credit: number
  /**
   * **本次无领取资格**（上游明确说了「当前领不了」）—— 与「失败」**不同**。
   *
   * ## ⚠️ 为什么必须与失败分开（真实缺陷）
   *
   * 国际版（`www.workbuddy.ai`）的每日奖励**挂在活动上**：活动没开时
   * `/daily-checkin` 回 **`41000`**（活动未开始或已结束），另外还有
   * **`40901`**（任务不可用）、**`1002`**（无资格）、**`1003`**（活动已结束）。
   *
   * 这四个都是**正常状态**，不是故障。把它们归成失败会：
   * - 在面板上显示「签到失败」，用户以为服务坏了；
   * - 而自动签到会**反复重试**（`inactive` 与 `failed` 的重试策略不同）。
   *
   * ⚠️ 与「幂等命中」也不同：`alreadyDone` 是「今天已领过」，
   * `inactive` 是「今天压根没有可领的东西」。两者对用户的话术不同。
   */
  inactive?: boolean
  /** `inactive` 时的可读原因（上游原文优先）。 */
  inactiveReason?: string
}

/**
 * 「无领取资格」的业务码 —— **不是失败**。
 *
 * 全部来自参考实现 `src/credits.ts:57-73` 的常量表（已用真实账号验证）：
 *
 * | 码 | 含义 |
 * |---|---|
 * | `1002` | 无领取资格 |
 * | `1003` | 活动已结束 |
 * | `41000` | 国际版：活动未开始 / 已结束 |
 * | `40901` | 国际版：任务不可用 |
 */
export const CHECKIN_INACTIVE_CODES: readonly number[] = [1002, 1003, 41000, 40901]

/**
 * 「今天已签到」的**整句**文案（**只在未知业务码上兜底**）。
 *
 * ## 🔴 为什么必须是「整句」，不能是子串（真实缺陷）
 *
 * 早期用的是子串正则（`/已签|已领|already/i` 之类）。参考实现用 13 条真实
 * 失败报文实测：**9 条被误判成「今天已签到」**（独立探针误判 30/42）。
 *
 * 后果链比「误判成无资格」**严格更糟**：
 *
 * ```
 * already-claimed
 *   → 汇总里 alreadyClaimed+1、coversToday+1
 *   → 自动签到把该家标记为「今天已处理完」
 *   → 当天**整天不再重试** + 反向告诉用户「已领到」
 * ```
 *
 * 也就是说：一次**真实的失败**被翻成「已成功」，并且让后面的重试全部消失。
 *
 * 本项目当前的正则虽已收窄（要求完整 `already checked in`），但仍是**子串**
 * 匹配 —— 实测这三条会被误判：
 *
 * - 「今日已签到记录写入失败」
 * - 「更新已签到状态失败，请重试」
 * - 「已签到用户信息同步超时」
 *
 * ⇒ 改为**整句锚定**（`^…$`），只认「这句话就是在说已签到」的形态。
 *
 * ⚠️ 新增形态时必须**同时**加一条对立面用例（「含该词但实为失败」），
 * 否则下次又会悄悄放宽成子串。
 */
export const ALREADY_CHECKED_IN_TEXT: readonly RegExp[] = [
  /^(今天|今日)?已(经)?签到(过|了|过了|过的)?[。.!！]?$/i,
  /^(今天|今日)?已(经)?领取(过|了|过了|过的)?[。.!！]?$/i,
  /^already\s+(?:checked\s+in|claimed)(\s+today)?[.!]?$/i,
]

/**
 * 把上游下发的 `code` 归一成数字。
 *
 * ⚠️ **上游有时把它下发成字符串**（`"41000"` / `"0"`）。只认 `number` 会让
 * 新登记的 41000/40901 **全部失效**（落到 -1 ⇒ 判成失败 ⇒ 一天里反复重试），
 * 也会把成功的 `"0"` 判成失败。这在本项目是已知的同型缺陷（参考实现为此
 * 专门写了一条注释）。非数值一律回 `-1`。
 */
export function normalizeBusinessCode(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10)
  }
  return -1
}

/** 余额包（billing 域的 `get-user-resource` 是**双层嵌套**响应）。 */
export interface BalancePackage {
  /** 本周期剩余额度（上游 `CycleCapacityRemain`）。 */
  cycleRemain: number
  /** 终身剩余额度（上游 `CapacityRemain`）。 */
  totalRemain: number
  /** 到期时刻（epoch ms；0 = 无/永久）。 */
  expiresAt: number
  /** 该包是否已失效。 */
  expired: boolean
}

/**
 * 解析 `get-user-resource` 的双层嵌套响应。
 *
 * 结构：`data.Response.Data.Accounts[]`
 *
 * ⚠️ 余额取 **`CycleCapacityRemain`**（本周期口径）而不是 `CapacityRemain`（终身口径）。
 * 实测同一响应里两者差异巨大（`TotalDosage=655` 而 IDE 显示 `155.67`），
 * 取错会让人以为余额比实际多。
 */
export function parseBalance(data: unknown, now: number): BalancePackage[] {
  if (data === null || typeof data !== 'object') return []
  const outer = data as Record<string, unknown>
  // 双层信封：data.Response.Data.Accounts
  const response = outer.Response
  if (response === null || typeof response !== 'object') return []
  const inner = (response as Record<string, unknown>).Data
  if (inner === null || typeof inner !== 'object') return []
  const accounts = (inner as Record<string, unknown>).Accounts
  if (!Array.isArray(accounts)) return []

  const out: BalancePackage[] = []
  for (const raw of accounts) {
    if (raw === null || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>

    const cycleRemain = typeof a.CycleCapacityRemain === 'number' ? a.CycleCapacityRemain : 0
    const totalRemain = typeof a.CapacityRemain === 'number' ? a.CapacityRemain : 0

    // 到期时刻：优先 DeductionEndTime，回落 ExpiredTime
    const expiryRaw = a.DeductionEndTime ?? a.ExpiredTime
    const expiresAt = parseTimeToMs(expiryRaw)

    // 失效判定：Status === 3 或 已过期
    const status = typeof a.Status === 'number' ? a.Status : 0
    const expired = status === 3 || (expiresAt > 0 && expiresAt <= now)

    out.push({ cycleRemain, totalRemain, expiresAt, expired })
  }
  return out
}

/** 把上游的时间字段（可能是 ISO 字符串、秒、毫秒）统一成 epoch ms。 */
function parseTimeToMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒级时间戳（< 1e12）→ 毫秒
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/** 查签到状态（**权威状态端点**）。 */
export async function checkinStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<boolean> {
  const bases = resolveUpstream(env)
  const res = await callUpstream<{ today_checked_in?: unknown }>({
    method: 'POST',
    // ⚠️ 必须是 checkin-activity-status，不是 checkin-status
    url: `${bases.billing}/v2/billing/meter/checkin-activity-status`,
    headers: billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: '{}',
  })
  if (!res.ok) return false
  return res.envelope?.data?.today_checked_in === true
}

/**
 * 执行每日签到。
 *
 * 幂等：已签到时上游返回业务码 `10001`/`1001`，本函数把它映射为
 * `{claimed:false, alreadyDone:true}` —— **不算失败**。
 */
export async function dailyCheckin(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<CheckinResult> {
  const bases = resolveUpstream(env)
  const res = await callUpstream<{ credit?: unknown }>({
    method: 'POST',
    url: `${bases.billing}/v2/billing/meter/daily-checkin`,
    headers: billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: '{}',
  })

  // ⚠️ 必须归一（上游可能下发字符串 `"41000"`）—— 见 normalizeBusinessCode
  const code = normalizeBusinessCode(res.envelope?.code)

  // 幂等命中：已签到。
  //
  // ⚠️ 判据比初版**多两路**，两条都来自协议权威（Go 侧），不是我方猜测：
  // 1. **`14001` 也是「今日已签到」** —— Go 侧 `IsAlreadyCheckin` 把
  //    `code=14001` + msg「今日已签到」当作幂等成功
  //    （`internal/upstream/client.go:199-201`，用例
  //    `internal/upstream/checkin_retry_test.go:67`）。初版只认 10001/1001，
  //    于是上游若改用 14001，我们会对「其实已签」判**失败** ——
  //    报错文案还会误导用户以为签到坏了。
  // 2. **文案兜底**（`已签到` / `already checked in`）：Go 的
  //    `alreadyCheckinMarkers`（`client.go:201,2071-2075`）就是按文案匹配的，
  //    因为**码值由服务端下发**（`110` 那种「本地产物里没有硬编码」的情况已出现过），
  //    上游改码是已知风险，只认码会在改码当天集体失灵。
  //
  //    ⚠️ 但英文侧**刻意收窄**成 `already checked/signed in`，不照抄 Go 的裸
  //    `already`：裸词会命中 `activity already ended` 这类文案，而误报
  //    「今天已签」的方向是**有害**的 —— 用户以为签过了、当天积分就真的错过
  //    （与本项目 qoder 那条「把『服务端没下发数据』误报成『今天已领』」同因，
  //    见 `upstream/checkin.ts` 头部第 2 条的同类教训）。
  //    误报「未签」最多让用户多点一次（上游幂等，回业务码，无害）。
  const msg = res.envelope?.msg ?? ''
  const alreadyByCode = code === 10001 || code === 1001 || code === 14001
  // ⚠️ **整句**匹配，且只在**未知码**上兜底（已知码已在上面的分支处理完）。
  //    子串匹配会把「已签到记录写入失败」这类失败报文翻成假成功 —— 见
  //    `ALREADY_CHECKED_IN_TEXT` 的缺陷说明。
  const alreadyByMsg = code !== 0 && ALREADY_CHECKED_IN_TEXT.some((p) => p.test(msg.trim()))
  if (alreadyByCode || alreadyByMsg) {
    return { claimed: false, alreadyDone: true, credit: 0 }
  }

  // ── 「本次无领取资格」—— **不是失败**（真实缺陷修复）──
  //
  // 国际版的每日奖励挂在**活动**上：活动没开时回 `41000`，另有 `40901`
  // （任务不可用）、`1002`（无资格）、`1003`（活动已结束）。
  // 这四个都是**正常状态**。
  //
  // ⚠️ 修复前它们落到下面的 `classify()` ⇒ 被归成 `unknown` ⇒ **抛 UpstreamError**
  // ⇒ 面板显示「签到失败」、自动签到还会反复重试。
  // 而任务本身的注释还写着「此时本方法会如实返回无收益而不是谎报成功」——
  // **注释与代码不一致**，那正是这个缺陷藏住的原因。
  //
  // ⚠️ 判据用**码集合**而不是文案：文案由服务端下发、随时可改；
  // 而码是协议的一部分（参考实现也是按码判的）。
  if (CHECKIN_INACTIVE_CODES.includes(code)) {
    return {
      claimed: false,
      alreadyDone: false,
      credit: 0,
      inactive: true,
      inactiveReason: msg !== '' ? msg : `当前无领取资格（业务码 ${code}）`,
    }
  }

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `签到失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  const credit = typeof res.envelope?.data?.credit === 'number' ? res.envelope.data.credit : 0
  return { claimed: true, alreadyDone: false, credit }
}

/** 查余额（只读）。返回所有包 + 汇总。 */
export async function fetchBalance(
  ctx: { uid: string; accessToken: string },
  env: Env,
  now: number,
): Promise<{ packages: BalancePackage[]; total: number; expiring: number; earliestExpiry: number }> {
  const bases = resolveUpstream(env)
  const res = await callUpstream({
    method: 'POST',
    url: `${bases.billing}/v2/billing/meter/get-user-resource`,
    headers: billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: '{}',
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `余额查询失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  const packages = parseBalance(res.envelope?.data, now)
  const live = packages.filter((p) => !p.expired)
  const total = live.reduce((sum, p) => sum + p.cycleRemain, 0)

  // 快过期窗口：7 天（Go 侧 pool.expiring_soon 默认 168h）
  const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
  const expiring = live
    .filter((p) => p.expiresAt > 0 && p.expiresAt - now <= EXPIRING_WINDOW_MS)
    .reduce((sum, p) => sum + p.cycleRemain, 0)

  const expiries = live.map((p) => p.expiresAt).filter((t) => t > 0)
  const earliestExpiry = expiries.length === 0 ? 0 : Math.min(...expiries)

  return { packages, total, expiring, earliestExpiry }
}
