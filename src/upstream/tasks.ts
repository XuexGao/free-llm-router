/**
 * 任务列表 / 接受 / 领奖（growth 域）。
 *
 * ## 🔴 领奖路径是本项目最大的历史坑，必须按此实现
 *
 * **错误做法**（Go 侧曾长期如此，一直失败）：
 * ```
 * POST {copilot.tencent.com}/v2/activity/growth/tasks/reward/claim
 * body: {"task_code": "..."}
 * ```
 * 该路径**根本不存在**，恒返回 400 `"task not completed"` —— 看起来像「任务没做完」，
 * 实际是**路径错了**。这是 Go 侧领奖长期失败的真实原因，极易误诊。
 *
 * **正确做法**：
 * ```
 * POST {www.workbuddy.cn}/activity/growth/tasks/<task_code>/claim
 * 无 body；任务码在**路径**里；必须带 x-client-platform: web
 * ```
 *
 * 判别要点：
 * - **域名不同**（web 域，不是 chat 域）；
 * - **路径结构不同**（有 `/v2` 前缀 vs 没有）；
 * - **任务码位置不同**（路径参数 vs body 字段）。
 *
 * mp 专属任务走 chat 域 + mp 头，chat 域 400 时降级到 web 域（实测 web 域可领）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { billingHeaders, desktopHeaders, mpHeaders, webHeaders } from './headers.js'

/** 单个任务（对外视图，字段名对齐上游 JSON）。 */
export interface Task {
  taskCode: string
  title: string
  description: string
  credit: number
  energy: number
  target: number
  current: number
  acceptStatus: string
  status: string
  /** 进度达标且未领取（本地推算）。 */
  claimable: boolean
  /** 已领取。 */
  claimed: boolean
}

/** 领奖结果。 */
export interface ClaimResult {
  /** 本次到账积分（已领过时为 0）。 */
  credit: number
  energy: number
  /** 幂等命中：之前已领过。 */
  alreadyClaimed: boolean
}

/** mp 平台头值。 */
export const MP_PLATFORM = 'miniprogram'

/** mp 专属任务码集合（Go 侧 `autotask.go:201-213`）。 */
export const MP_TASK_CODES: ReadonlySet<string> = new Set([
  'school_season',
  'Sequential_Tasks_1',
  'Sequential_Tasks_2',
  'Sequential_Tasks_3',
  'Sequential_Tasks_4',
  'Sequential_Tasks_5',
  'Sequential_Tasks_6',
  'Sequential_Tasks_7',
])

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 从 `progress` 字段解析 (current, target) —— 上游有两种形态，都要认。 */
function parseProgress(entry: Record<string, unknown>): { current: number; target: number } {
  const progress = entry.progress
  if (progress !== null && typeof progress === 'object' && !Array.isArray(progress)) {
    const p = progress as Record<string, unknown>
    return { current: num(p.current), target: num(p.target) }
  }
  // 扁平形态
  return { current: num(entry.current), target: num(entry.target) }
}

/** 解析任务列表响应。 */
export function parseTasks(data: unknown): Task[] {
  if (data === null || typeof data !== 'object') return []
  const tasks = (data as Record<string, unknown>).tasks
  if (!Array.isArray(tasks)) return []

  const out: Task[] = []
  for (const raw of tasks) {
    // ⚠️ 跳过非对象条目，以及**缺 task_code 的条目**。
    // 实测（本文件的单测发现）：`[null]` 或 `[{}]` 若照单全收，会产出一个
    // `taskCode: ''` 的**空任务**并进入执行队列 —— 那种任务无法 accept/领奖，
    // 只会污染 lastError 并浪费上游请求。task_code 是唯一标识，缺它就是脏数据。
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const taskCode = str(entry.task_code)
    if (taskCode === '') continue

    const { current, target } = parseProgress(entry)
    const acceptStatus = str(entry.accept_status)
    const status = str(entry.status)
    const claimed = acceptStatus === 'claimed'
    // 达标且未领 ⇒ 可领（本地推算；上游也会给 claimable，但推算更可靠）
    const claimable = !claimed && target > 0 && current >= target

    out.push({
      taskCode,
      title: str(entry.title),
      description: str(entry.description),
      // 上游字段名是 reward_ 前缀
      credit: num(entry.reward_credit),
      energy: num(entry.reward_energy),
      target,
      current,
      acceptStatus,
      status,
      claimable,
      claimed,
    })
  }
  return out
}

/**
 * 拉取任务列表。
 *
 * ⚠️ mp 专属任务**只在带 mp 头时下发** —— 不带头的列表里根本看不到它们，
 * 所以「扫描待办」需要分别拉默认口径与 mp 口径再合并（Go 侧同口径）。
 */
export async function listTasks(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  options?: { mp?: boolean },
): Promise<Task[]> {
  const bases = resolveUpstream(env)
  const headers = options?.mp === true
    ? { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': MP_PLATFORM }
    : desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken })

  const res = await callUpstream({
    method: 'GET',
    url: `${bases.chat}/v2/activity/growth/tasks`,
    headers,
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `任务列表拉取失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }

  return parseTasks(res.envelope?.data)
}

/** 合并默认口径与 mp 口径（按 taskCode 去重，默认口径优先）。 */
export function mergeTaskLists(base: Task[], mp: Task[]): Task[] {
  const seen = new Set(base.map((t) => t.taskCode))
  const merged = [...base]
  for (const t of mp) {
    if (!seen.has(t.taskCode)) {
      seen.add(t.taskCode)
      merged.push(t)
    }
  }
  return merged
}

/**
 * 接受任务（「报名」）。
 *
 * 语义要点（Go 侧 `tasks.go:1-22`）：accept **不产生进度**，只是把状态从
 * `not_accepted` 变成 `accepted`。进度由服务端行为事件点亮。
 * ⇒ accept 可**幂等重放**，重复调用无害。
 */
export async function acceptTasks(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  taskCodes: string[],
  options?: { mp?: boolean },
): Promise<void> {
  if (taskCodes.length === 0) return
  const bases = resolveUpstream(env)
  const headers = options?.mp === true
    ? { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': MP_PLATFORM }
    : desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken })

  const res = await callUpstream({
    method: 'POST',
    url: `${bases.chat}/v2/activity/growth/tasks/accept`,
    headers,
    body: JSON.stringify({ task_codes: taskCodes }),
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `接受任务失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }
}

/** 解析领奖响应 `{already_claimed, credit, energy}`。 */
export function parseClaim(data: unknown): ClaimResult {
  if (data === null || typeof data !== 'object') return { credit: 0, energy: 0, alreadyClaimed: false }
  const d = data as Record<string, unknown>
  return {
    credit: num(d.credit),
    energy: num(d.energy),
    alreadyClaimed: d.already_claimed === true,
  }
}

/**
 * 领取奖励（**Web 域权威路径**）。
 *
 * ⚠️ 见文件头的「历史坑」。要点复述：
 * - 域名：`{web}`（**不是** chat 域）；
 * - 路径：`/activity/growth/tasks/<code>/claim`（**没有** `/v2` 前缀）；
 * - 任务码在**路径**里，**无 body**；
 * - 必须带 `x-client-platform: web`。
 *
 * 幂等：已领过返回 `already_claimed: true` + credit 0，**不是错误**。
 */
export async function claimReward(
  ctx: { uid: string; accessToken: string; realm: string; enterpriseId?: string },
  env: Env,
  taskCode: string,
): Promise<ClaimResult> {
  const bases = resolveUpstream(env)
  const headers = webHeaders({ uid: ctx.uid, accessToken: ctx.accessToken })
  if (ctx.enterpriseId !== undefined && ctx.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = ctx.enterpriseId
    headers['X-Tenant-Id'] = ctx.enterpriseId
  }

  const res = await callUpstream({
    method: 'POST',
    url: `${bases.web}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
    headers,
    // 无 body
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `领奖失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  return parseClaim(res.envelope?.data)
}

/**
 * 领取 mp 专属任务奖励：chat 域 + mp 头，**失败降级到 web 域**。
 *
 * Go 侧实测：chat 域对该路径可能回 400（部分任务/租户形态），
 * 而 web 域可领 —— 故必须带降级，不能只试一个域名。
 */
export async function claimRewardMp(
  ctx: { uid: string; accessToken: string; realm: string; enterpriseId?: string },
  env: Env,
  taskCode: string,
): Promise<ClaimResult> {
  const bases = resolveUpstream(env)
  const headers = {
    ...billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    'X-Client-Platform': MP_PLATFORM,
  }

  try {
    const res = await callUpstream({
      method: 'POST',
      url: `${bases.chat}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
      headers,
    })
    if (res.ok) return parseClaim(res.envelope?.data)

    // 仅 400 才降级（路径/形态不符）；其他错误原样抛出
    if (res.httpStatus !== 400) {
      const c = classify(res.httpStatus, res.raw)
      throw new UpstreamError({
        kind: c.kind,
        httpStatus: res.httpStatus,
        code: c.code,
        message: `mp 领奖失败（${c.kind}）：${c.msg}`,
        detail: res.raw.slice(0, 400),
      })
    }
  } catch (error) {
    // 网络层错误不降级（降级也大概率失败），直接抛
    if (!(error instanceof UpstreamError) || error.httpStatus !== 400) throw error
  }

  // 降级：web 域
  return claimReward(ctx, env, taskCode)
}

/** 该任务码是否属于 mp 口径（决定 accept/领奖走哪个变体）。 */
export function isMpTask(taskCode: string): boolean {
  return MP_TASK_CODES.has(taskCode)
}
