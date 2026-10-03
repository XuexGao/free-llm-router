/**
 * 进度回读与自动领奖。
 *
 * ## 🔴 为什么回读必须「有界轮询」而不是「读一次」
 *
 * 上游计分是**异步**的。Go 侧实测（`autotask.go:236-240`）：
 * 行为事件上报后**立即回读仍是 0/1**，约 **5–8 秒后**才变 1/1。
 *
 * ⇒ 只读一次会误判「未达标」，从而**跳过自动领奖** ——
 * 任务其实已经完成，但积分永远没领，且没有任何报错。
 * 这是「静默失败」的典型形态（AGENTS.md §7.2 明令禁止）。
 *
 * ## 为什么要「有界」
 *
 * 不能用 `while (!done)` 无限等：上游若永久不达标，会无限占用 DO alarm
 * 并白烧 Free 计划的 Duration 配额。故用固定预算：
 * `claimPollAttempts = 4` × `claimPollGap = 3s` ≈ 12 秒（Go 侧同值）。
 *
 * ## 为什么轮询期间的查询失败**不覆盖**已有结果
 *
 * Go 侧明确记录（`autotask.go:260`）：轮询中途的查询失败若覆盖了先前拿到的
 * 结果，会把「已达标」误判成「未知」。故保留最后一次**成功**的结果。
 */

import type { Env } from '../env.js'
import { claimReward, claimRewardMp, isMpTask, listTasks, mergeTaskLists, type Task } from '../upstream/tasks.js'

/** 回读参数（Go 侧实测值，**不要为了跑快调小**）。 */
export const CLAIM_POLL_ATTEMPTS = 4
export const CLAIM_POLL_GAP_MS = 3000

/** 账号上下文（回读与领奖都需要）。 */
export interface AccountContext {
  uid: string
  accessToken: string
  realm: string
  enterpriseId?: string
}

/** 回读结果。 */
export interface VerifyOutcome {
  task: Task | undefined
  /** 是否达标（或已领）。 */
  done: boolean
  /** 轮询了几次（含首次）。 */
  attempts: number
  detail: string
}

/**
 * 拉取单个任务（默认口径 + mp 口径合并）。
 *
 * ⚠️ 必须合并两个口径：mp 专属任务（`Sequential_Tasks_*` / `school_season`）
 * **在默认口径的列表里根本不存在**，只查默认口径永远找不到它们。
 */
export async function findTask(
  ctx: AccountContext,
  env: Env,
  taskCode: string,
): Promise<Task | undefined> {
  const base = await listTasks(ctx, env)
  // 只在目标任务可能属于 mp 时才多打一次请求（省配额）
  if (isMpTask(taskCode)) {
    try {
      const mp = await listTasks(ctx, env, { mp: true })
      return mergeTaskLists(base, mp).find((t) => t.taskCode === taskCode)
    } catch {
      // mp 口径拉取失败不致命：可能只是该账号没有 mp 任务
      return base.find((t) => t.taskCode === taskCode)
    }
  }
  return base.find((t) => t.taskCode === taskCode)
}

/**
 * 回读任务进度，未达标时在有界预算内轮询等待。
 *
 * @returns 最后一次成功拿到的任务状态（可能仍未达标）
 */
export async function waitForTask(
  ctx: AccountContext,
  env: Env,
  taskCode: string,
  options?: { attempts?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<VerifyOutcome> {
  const attempts = options?.attempts ?? CLAIM_POLL_ATTEMPTS
  // ⚠️ 这里的 sleep 是**测试注入点**：生产用真实定时器，单测传 no-op
  // （否则 12 秒的等待会让单测变成「慢测试」，进而被跳过、失去保护作用）。
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let task = await findTask(ctx, env, taskCode)
  let used = 1

  if (task === undefined) {
    return { task: undefined, done: false, attempts: used, detail: `未找到任务 ${taskCode}` }
  }
  if (task.claimable || task.claimed) {
    return {
      task,
      done: true,
      attempts: used,
      detail: task.claimed ? '已领取过' : `进度达标（${task.current}/${task.target}）`,
    }
  }

  for (let i = 1; i < attempts; i += 1) {
    await sleep(options?.gapMs ?? CLAIM_POLL_GAP_MS)
    used += 1
    try {
      const next = await findTask(ctx, env, taskCode)
      if (next !== undefined) {
        task = next // 只在成功时更新
        if (task.claimable || task.claimed) {
          return {
            task,
            done: true,
            attempts: used,
            detail: task.claimed ? '已领取过' : `进度达标（${task.current}/${task.target}，第 ${used} 次回读）`,
          }
        }
      }
    } catch {
      // ⚠️ 轮询期间的查询失败**不覆盖**已拿到的结果（Go 侧同口径）
      continue
    }
  }

  return {
    task,
    done: false,
    attempts: used,
    detail: `回读 ${used} 次仍未达标（${task.current}/${task.target}）`,
  }
}

/** 领取结果。 */
export interface ClaimOutcome {
  claimed: boolean
  credit: number
  energy: number
  detail: string
}

/**
 * 领取奖励（自动选择 mp / 普通路径）。
 *
 * 幂等：已领过返回 `claimed:false` + 明确说明，**不是错误**。
 */
export async function claimTask(
  ctx: AccountContext,
  env: Env,
  taskCode: string,
): Promise<ClaimOutcome> {
  try {
    const result = isMpTask(taskCode)
      ? await claimRewardMp(ctx, env, taskCode)
      : await claimReward(ctx, env, taskCode)

    if (result.alreadyClaimed) {
      return { claimed: false, credit: 0, energy: 0, detail: '此前已领取过（幂等命中）' }
    }
    return {
      claimed: true,
      credit: result.credit,
      energy: result.energy,
      detail: `已领取 +${result.credit} 积分 +${result.energy} 能量`,
    }
  } catch (error) {
    return {
      claimed: false,
      credit: 0,
      energy: 0,
      detail: `领奖失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 完整闭环：回读 → 达标则领奖。
 *
 * 这是动作实现的「后半段」，供各任务动作复用。
 */
export async function verifyAndClaim(
  ctx: AccountContext,
  env: Env,
  taskCode: string,
  options?: { attempts?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ verify: VerifyOutcome; claim: ClaimOutcome | undefined; detail: string }> {
  const verify = await waitForTask(ctx, env, taskCode, options)

  if (!verify.done) {
    // 未达标不领奖，但**如实回报**（不假装成功）
    return { verify, claim: undefined, detail: `进度未达标：${verify.detail}` }
  }

  // 已领过就不用再打领奖接口
  if (verify.task?.claimed === true) {
    return { verify, claim: undefined, detail: '任务已完成且已领取，无需重复领奖' }
  }

  const claim = await claimTask(ctx, env, taskCode)
  return { verify, claim, detail: `${verify.detail}；${claim.detail}` }
}
