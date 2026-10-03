/**
 * 用量统计（按模型 / 账号 / 时间聚合）。
 *
 * ## 为什么用「环形缓冲 + 惰性聚合」而不是持久化
 *
 * Free 计划下 DO SQLite 的**行写入**配额是 100,000/天，而一次对话就产生一条记录 ——
 * 若每次请求都写一行，正常使用可能撞配额，且我们要的是**近期趋势**而不是审计账本。
 *
 * ⇒ 用量记录放 **DO storage 的单个 key**（`usage:ring`），保留最近 N 条。
 * 这仍然会被持久化（抗 DO 回收），但只有**一次写**而不是一行 —— 且聚合在内存里做。
 *
 * ⚠️ 这与 Go 侧的 `usage.json`（30 秒防抖落盘）思路一致，但更保守：
 * 这里没有后台定时器可依赖（Workers 无跨请求后台执行），故直接在请求结束时写。
 */

/** 一条用量记录。 */
export interface UsageRecord {
  /** 时刻（epoch ms）。 */
  at: number
  /** 账号 uid。 */
  uid: string
  /** 模型 id。 */
  model: string
  /** 输入 token。 */
  input: number
  /** 输出 token。 */
  output: number
  /** 是否成功。 */
  ok: boolean
  /** 失败时的错误类别。 */
  errorKind?: string
  /** 耗时（毫秒）。 */
  ms: number
}

/** 环形缓冲的最大长度（保留最近多少条）。 */
export const USAGE_RING_SIZE = 500

/** 时间窗口聚合结果。 */
export interface UsageSummary {
  /** 总请求数。 */
  total: number
  /** 成功数。 */
  ok: number
  /** 失败数。 */
  failed: number
  /** 输入 / 输出 token 合计。 */
  inputTokens: number
  outputTokens: number
  /** 平均耗时（毫秒）。 */
  avgMs: number
  /** 按模型聚合（降序）。 */
  byModel: Array<{ model: string; count: number; input: number; output: number; failed: number }>
  /** 按账号聚合（降序）。 */
  byAccount: Array<{ uid: string; count: number; input: number; output: number; failed: number }>
  /** 按小时聚合（用于画趋势）。 */
  byHour: Array<{ hour: string; count: number; failed: number }>
  /** 最早记录时刻（0 = 无记录）。 */
  since: number
}

/**
 * 聚合用量记录（**纯函数**，便于单测）。
 *
 * @param records 记录（顺序无关）
 * @param now 当前时刻（用于算小时桶）
 */
export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const byModel = new Map<string, { count: number; input: number; output: number; failed: number }>()
  const byAccount = new Map<string, { count: number; input: number; output: number; failed: number }>()
  const byHour = new Map<string, { count: number; failed: number }>()

  let total = 0
  let ok = 0
  let failed = 0
  let inputTokens = 0
  let outputTokens = 0
  let msSum = 0
  let since = 0

  for (const r of records) {
    total += 1
    if (r.ok) ok += 1
    else failed += 1
    inputTokens += r.input
    outputTokens += r.output
    msSum += r.ms
    if (since === 0 || r.at < since) since = r.at

    const m = byModel.get(r.model) ?? { count: 0, input: 0, output: 0, failed: 0 }
    m.count += 1
    m.input += r.input
    m.output += r.output
    if (!r.ok) m.failed += 1
    byModel.set(r.model, m)

    const a = byAccount.get(r.uid) ?? { count: 0, input: 0, output: 0, failed: 0 }
    a.count += 1
    a.input += r.input
    a.output += r.output
    if (!r.ok) a.failed += 1
    byAccount.set(r.uid, a)

    // 小时桶（UTC+8，与其它模块口径一致）
    const hour = hourBucketUtc8(r.at)
    const h = byHour.get(hour) ?? { count: 0, failed: 0 }
    h.count += 1
    if (!r.ok) h.failed += 1
    byHour.set(hour, h)
  }

  const desc = <T extends { count: number }>(entries: Array<[string, T]>, key: 'model' | 'uid') =>
    entries
      .map(([k, v]) => ({ [key]: k, ...v }) as never)
      .sort((a, b) => (b as { count: number }).count - (a as { count: number }).count)

  return {
    total,
    ok,
    failed,
    inputTokens,
    outputTokens,
    avgMs: total === 0 ? 0 : Math.round(msSum / total),
    byModel: desc([...byModel.entries()], 'model'),
    byAccount: desc([...byAccount.entries()], 'uid'),
    byHour: [...byHour.entries()]
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    since,
  }
}

/**
 * 小时桶标签（`MM-DD HH:00`，UTC+8）。
 *
 * ⚠️ 用固定 +8 偏移，不依赖本机时区（Workers 恒 UTC）——
 * 与项目其它模块（签到日界、夜猫子窗口）保持同一口径。
 */
export function hourBucketUtc8(at: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const d = new Date(at + CST_OFFSET)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:00`
}

/**
 * 截断到环形缓冲上限（保留**最新**的 N 条）。
 *
 * ⚠️ 必须按时间排序后再截断：写入顺序未必等于时间顺序（并发请求完成有先后），
 * 直接 `slice(-N)` 有可能丢掉更新的记录而留下旧的。
 */
export function trimUsageRing(records: UsageRecord[], limit = USAGE_RING_SIZE): UsageRecord[] {
  if (records.length <= limit) return records
  return [...records].sort((a, b) => a.at - b.at).slice(-limit)
}
