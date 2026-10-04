/**
 * TaskRunner Durable Object：**每账号一个**，把长任务拆成 alarm 步进的状态机。
 *
 * ## 为什么必须是状态机 + alarm，而不能「一个请求里 sleep 到底」
 *
 * AGENTS.md §2.4 记录了实测数据：Go 侧单账号跑完全部任务要**数分钟**
 * （`mpChatEventGap = 45s`，`Sequential_Tasks_6` 约 8 分钟）。
 * 而 Workers 的普通请求 handler **没有跨请求的后台执行**：
 * `setInterval` 只在请求上下文内有效，请求结束即冻结；`ctx.waitUntil()` 只延长 30 秒。
 *
 * ⇒ 唯一可行形态是：**每次 alarm 只执行一步**，存进度，再 `setAlarm()` 排下一步。
 *
 * ## 这个设计顺带解决了两个 Go 侧的痛点
 *
 * 1. **per-account 串行**：DO 天然单线程，**语义完全等价**于 Go 侧的
 *    `sync.Mutex TryLock`（`panel.go:96`），但不需要自己写锁。
 *    Go 侧要靠这把锁防「expert 系任务重复消耗真实对话」，这里由运行时保证。
 * 2. **可恢复**：进度存 DO storage，实例被回收后 alarm 仍会重新唤起 ——
 *    比 Go 侧「进程重启即丢队列」更强。
 *
 * ## 10ms CPU 纪律（Free 计划，AGENTS.md §8.2.2）
 *
 * 每一步只做：**发一个上游请求 → 解析小 JSON → 写一次状态 → 排下一步**。
 * 绝不在这里做批量循环。等待时间用 `setAlarm(now + delay)` 表达，**不用 sleep** ——
 * 因为 CPU 只计「实际执行代码」的时间，等待网络 I/O 不计入。
 *
 * ## ⚠️ 一个必须记住的约束：DO 不能接收函数
 *
 * DO 的 RPC 只传**可结构化克隆**的值，**函数无法跨 isolate 传递**。
 * 因此执行器**不能**由调用方注入，必须在 DO 内部按 `action` 名解析
 * （见 `resolveAction`）。这也是 `TaskStep.action` 是**字符串**而不是函数的原因。
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.js'
import { migrate, readProgress, writeProgress } from '../store/db.js'
import { executeAction, type ActionContext, type ActionResult } from './actions.js'
import { GAP, needsCredentialFetch, effectiveAccessToken, type RunContext, type RunState, type TaskStep } from './steps.js'

export class TaskRunnerDO extends DurableObject<Env> {
  /** 当前运行状态（内存镜像；权威副本在 SQLite）。 */
  private run: RunState | undefined
  /** 当前运行的账号上下文。 */
  private context: RunContext | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
  }

  /**
   * 启动（或续跑）一次任务运行。
   *
   * 幂等：若已有未完成的运行，**不覆盖**，直接返回当前状态 ——
   * 避免 Cron 重复触发把队列重置成初始态（Go 侧靠 `q.running` 防重入）。
   */
  async start(uid: string, steps: TaskStep[], context: RunContext, now: number): Promise<RunState> {
    const existing = await this.load(uid)
    if (existing !== undefined && !existing.finished && existing.queue.length > 0) {
      return existing
    }

    const state: RunState = {
      uid,
      queue: steps,
      done: [],
      finished: false,
      lastError: '',
      startedAt: now,
      updatedAt: now,
    }
    await this.ctx.storage.put('context', context)
    await this.save(state)

    // 立即排一次 alarm；**真正的执行在 alarm handler 里**，不在本次调用里。
    // 这样「触发」与「执行」解耦，触发方（Worker / Cron）可以立刻返回。
    if (steps.length > 0) {
      await this.ctx.storage.setAlarm(now)
    }
    return state
  }

  /** 查询当前运行状态（供面板轮询）。 */
  async status(uid: string): Promise<RunState | undefined> {
    return await this.load(uid)
  }

  /** 取消当前运行（人工干预）。 */
  async cancel(uid: string): Promise<void> {
    const state = await this.load(uid)
    if (state === undefined) return
    state.queue = []
    state.finished = true
    state.lastError = 'cancelled'
    await this.save(state)
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * alarm 处理器：**每次只执行一步**。
   *
   * ## 为什么严格只做一步
   *
   * Free 计划 CPU 预算是 10ms/次调用。一步 = 一个上游请求 + 一次状态写，
   * CPU 消耗约数毫秒，稳在预算内。若在这里循环多步，上游 I/O 的排队等待会累积，
   * 且失败重试逻辑会变得难以推理。
   *
   * ## 为什么用 setAlarm 而不是 setTimeout 续期
   *
   * `setAlarm` 是**持久化**的：即使 DO 被回收，alarm 仍会触发。
   * 这是本设计能「比 Go 侧更强地抗重启」的根本原因。
   */
  override async alarm(): Promise<void> {
    const state = await this.loadCurrent()
    if (state === undefined || state.finished || state.queue.length === 0) {
      // 无事可做：不排下一次 alarm，让对象进入 idle（Free 计划下不计 Duration）。
      return
    }

    const step = state.queue[0]
    if (step === undefined) return

    const now = Date.now()
    const context = await this.ctx.storage.get<RunContext>('context')

    if (context === undefined) {
      // 上下文缺失是**状态损坏**，不能静默跳过 —— 那会让任务永远卡在队列头部。
      state.finished = true
      state.lastError = '运行上下文缺失（状态损坏）'
      await this.save(state)
      return
    }

    let result: ActionResult
    try {
      // ⚠️ Cron 扇出时刻意**不读凭据**（`src/index.ts` 的 scheduled() 传
      // `accessToken: ''`），因为 Cron 只有 10ms CPU（AGENTS.md §8.2.1），
      // 在那里解密凭据会超预算。代价是 DO 侧拿到的令牌是空串 ——
      // 而空串会让**所有**上游请求 401。
      //
      // 实测证据（2026-10-04，线上 `/admin/tasks/status`）：10:00 UTC+8 那次
      // cron growth 运行的 `done[]` 里 `listTasks` / `first_buddy` 全是
      // `upstream 401` —— 即**自动任务从未真正跑通**，自动签到自然也从未生效。
      //
      // 故在这里惰性补取：只有令牌为空时才问账号池要凭据（DO 间串行调用，
      // 且只在必要时发生）。放在 try 内是为了让取凭据失败也如实落到该步的
      // error 里，不静默。
      let accessToken = effectiveAccessToken(context.accessToken, '')
      if (needsCredentialFetch(context.accessToken)) {
        const pool = this.env.ACCOUNT_POOL.get(this.env.ACCOUNT_POOL.idFromName(context.realm))
        const credential = (await pool.getCredential(context.uid)) as { accessToken?: unknown } | undefined
        accessToken = effectiveAccessToken(
          context.accessToken,
          typeof credential?.accessToken === 'string' ? credential.accessToken : '',
        )
      }

      const actionContext: ActionContext = {
        uid: context.uid,
        nickname: context.nickname,
        realm: context.realm,
        accessToken,
        now,
      }
      result = await executeAction(step, actionContext, this.env)
    } catch (error) {
      // ⚠️ 不吞异常：把原文写进 lastError，便于面板看到真实原因（AGENTS.md §7.2）。
      result = { ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    }

    // 该步完成：出队并记录
    state.queue.shift()
    state.done.push({ code: step.code, action: step.action, ok: result.ok, detail: result.detail })
    state.updatedAt = now
    if (!result.ok) state.lastError = result.detail
    if (state.queue.length === 0) state.finished = true

    await this.save(state)

    // 排下一步：用本步声明的 delayMs 表达反风控间隔。
    // ⚠️ 等待期间 DO 应进入 idle；不要在这里 await 一个 sleep（会白烧 CPU 预算）。
    if (!state.finished && state.queue.length > 0) {
      await this.ctx.storage.setAlarm(now + Math.max(0, step.delayMs))
    }
  }

  /** 读当前运行状态（从 storage，权威）。 */
  private async loadCurrent(): Promise<RunState | undefined> {
    if (this.run !== undefined) return this.run
    const uid = await this.ctx.storage.get<string>('currentUid')
    if (uid === undefined) return undefined
    this.run = await this.load(uid)
    return this.run
  }

  private async load(uid: string): Promise<RunState | undefined> {
    const raw = readProgress(this.ctx.storage.sql, uid)
    return raw === undefined ? undefined : (JSON.parse(raw) as RunState)
  }

  private async save(state: RunState): Promise<void> {
    this.run = state
    writeProgress(this.ctx.storage.sql, state.uid, JSON.stringify(state), state.updatedAt)
    await this.ctx.storage.put('currentUid', state.uid)
  }
}

// 保持既有 import 路径可用（类型定义已移到 steps.ts，见那里的说明）。
export { GAP } from './steps.js'
export type { RunContext, RunState, TaskStep } from './steps.js'
