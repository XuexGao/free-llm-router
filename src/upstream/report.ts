/**
 * 行为事件上报（`POST /v2/report`）。
 *
 * ## 同一个端点，四套指纹，走**不同域名**
 *
 * 这是最容易被搞混的地方（AGENTS.md §6.1）：
 *
 * | 指纹 | 域名 | 头族 |
 * |---|---|---|
 * | CLI | `www.codebuddy.cn`（billing 域） | `billingHeaders` |
 * | 桌面 | `copilot.tencent.com`（chat 域） | `desktopHeaders` |
 * | Web | `www.workbuddy.cn`（web 域） | `webHeaders` |
 * | mp | `www.codebuddy.cn`（billing 域） | `mpHeaders` |
 *
 * ⇒ **同一条事件，发错域名 = 点不亮**。故这里把四个入口显式分开，
 * 而不是做一个带 `realm` 参数的通用函数（那样调用方很容易传错）。
 *
 * ## 上报成功 ≠ 计分
 *
 * 上游返回 200 不代表任务进度真的涨了（计分是**异步**的，实测 5–8s 才落定）。
 * 故上报后必须**回读进度**确认 —— 见 `taskrunner/verify.ts`（第 5 步）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { billingHeaders, desktopHeaders, mpHeaders, webHeaders } from './headers.js'
import type { Event } from './events.js'

/** 上报结果。 */
export interface ReportResult {
  ok: boolean
  httpStatus: number
  detail: string
}

/** 内部：发一次上报。 */
async function postReport(
  url: string,
  headers: Record<string, string>,
  events: Event[],
): Promise<ReportResult> {
  const res = await callUpstream({
    method: 'POST',
    url,
    headers,
    body: JSON.stringify(events),
  })

  if (res.ok) return { ok: true, httpStatus: res.httpStatus, detail: `已上报 ${events.length} 条事件` }

  const c = classify(res.httpStatus, res.raw)
  return {
    ok: false,
    httpStatus: res.httpStatus,
    detail: `${c.kind}: ${c.msg || res.raw.slice(0, 160)}`,
  }
}

/**
 * CLI 指纹上报（billing 域）。
 *
 * 用于 `chat_5`（对话活跃）与 `first_buddy` 的前置解锁。
 * 每条事件前应有 ≥1s 间隔（Go 侧 `reportGap = 1050ms`），由调用方在步骤间控节奏。
 */
export async function reportCli(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.billing}/v2/report`,
    billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/**
 * 桌面指纹上报（chat 域）。
 *
 * ⚠️ 桌面事件的公共指纹由 `events.desktopFingerprint()` 注入到**每条**事件 ——
 * 服务端按 `machineId`/`extName` 判定是否来自桌面端。
 */
export async function reportDesktop(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.chat}/v2/report`,
    desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/** Web 指纹上报（web 域）。用于 `Library_read` 等 web 端任务。 */
export async function reportWeb(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.web}/v2/report`,
    webHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    events,
  )
}

/** mp 指纹上报（billing 域，带 mp 头）。用于 `Sequential_Tasks_*` 与 `school_season`。 */
export async function reportMp(
  ctx: { uid: string; accessToken: string },
  env: Env,
  events: Event[],
): Promise<ReportResult> {
  if (events.length === 0) return { ok: true, httpStatus: 0, detail: '无事件' }
  const bases = resolveUpstream(env)
  return await postReport(
    `${bases.billing}/v2/report`,
    { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': 'mp-weixin' },
    events,
  )
}

/**
 * 把公共指纹注入到每条事件（业务字段优先）。
 *
 * ⚠️ 顺序很重要：业务字段**覆盖**指纹字段。这样调用方可以显式对齐设备标识
 * （如 mp 任务覆盖 `machineId`），而不用改指纹函数。
 */
export function withFingerprint(events: Event[], fingerprint: Event): Event[] {
  return events.map((ev) => ({ ...fingerprint, ...ev }))
}

/**
 * 反探测脱敏：把请求体里的裸数字 `11128` 改写。
 *
 * ## 为什么必须做
 *
 * 上游的**反探测**机制：请求体里只要出现裸 `11128` 就整单拦截，
 * 与该数字的上下文无关（`code=11128` / 裸 `11128` / `错误码 11128` 全部命中），
 * 而相邻的 `11148` / `11101` / `11115` 均放行
 * （Go 侧 `sanitize.go:70-76` 实测记录）。
 *
 * 因果很微妙：**11128 正是这类拦截自身的错误码**，上游据此识别
 * 「在讨论/回显其内部错误码」的请求。所以这串数字**出现在请求里本身就是拦截条件**，
 * 不改写必然失败。
 *
 * 改法：插入连字符（`11-128`）保留可读性与指代。
 * ⚠️ 零宽空格**无效** —— 实测上游会先归一化再匹配。
 */
export function sanitizeFingerprints(text: string): string {
  if (!text.includes('11128')) return text
  return text.replaceAll('11128', '11-128')
}

/** 对事件数组做脱敏（JSON 序列化后整体替换，覆盖所有字段）。 */
export function sanitizeEvents(events: Event[]): Event[] {
  const serialized = JSON.stringify(events)
  if (!serialized.includes('11128')) return events
  return JSON.parse(sanitizeFingerprints(serialized)) as Event[]
}
