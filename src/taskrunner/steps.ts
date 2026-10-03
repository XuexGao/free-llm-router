/**
 * 任务步骤的**协议类型与节奏常量**。
 *
 * ## 为什么单独一个文件（而不是放在 TaskRunnerDO.ts 里）
 *
 * 这些是纯数据，被 `plans.ts` / `actions.ts` / `verify.ts` 共用。
 * 若定义在 `TaskRunnerDO.ts` 里，那三个模块 import 它就会把
 * `import { DurableObject } from 'cloudflare:workers'` **一起拽进来** ——
 * 而 `cloudflare:workers` 是 Workers 运行时内置模块，**Node 下无法解析**，
 * 导致单测（在 Node 里跑）直接崩在加载阶段。
 *
 * ⇒ 把纯数据与 DO 实现分开，依赖方向就干净了：
 * `步骤定义 → 计划/动作`，`DO → 动作`，而**动作不再依赖 DO**。
 */

/**
 * 单个任务步骤。
 *
 * `action` 是**字符串**而不是函数 —— DO 的 RPC 只传可结构化克隆的值，
 * 函数无法跨 isolate 传递（见 `TaskRunnerDO` 的文件头说明）。
 */
export interface TaskStep {
  /** 任务码（如 `chat_5` / `first_buddy`）。 */
  code: string
  /** 该步骤的动作标识 —— 字符串，由 `actions.ts` 解释。 */
  action: string
  /** 进入下一步前等待的毫秒数。 */
  delayMs: number
}

/** 一次任务运行的持久化状态。 */
export interface RunState {
  uid: string
  /** 待执行的步骤队列（先进先出）。 */
  queue: TaskStep[]
  /** 已完成步骤的摘要（用于回报与去重）。 */
  done: Array<{ code: string; action: string; ok: boolean; detail: string }>
  /** 运行是否已结束。 */
  finished: boolean
  /** 最后一步的失败原因（空 = 无失败）。 */
  lastError: string
  startedAt: number
  updatedAt: number
}

/** 执行一步所需的账号上下文（由调用方在 `start` 时一并给出并持久化）。 */
export interface RunContext {
  /** 访问令牌（**不要在日志里打印**）。 */
  accessToken: string
  /** 上游 uid。 */
  uid: string
  /** 昵称（事件里要用）。 */
  nickname: string
  /** 日志分组用的 realm。 */
  realm: string
}

/**
 * 各步骤之间的默认安全间隔（Go 侧**实测**值，见 AGENTS.md §2.4）。
 *
 * ⚠️ **不要为了「跑快」调小它们。** 这些是反风控间隔，不是性能参数：
 * `mpChatEvent`（45s）是服务端**回滚进度**的下限；
 * `report`（1050ms）是连续上报的最小间隔。
 */
export const GAP = {
  /** `reportGap`：事件上报之间的间隔。 */
  report: 1050,
  /** `claimPollGap`：进度回读之间的间隔。 */
  claimPoll: 3000,
  /** `mpActionGap`：mp 任务动作间隔。 */
  mpAction: 2000,
  /** `mpChatEventGap`：mp 对话事件间隔（**必须**够长，否则服务端回滚进度）。 */
  mpChatEvent: 45_000,
} as const
