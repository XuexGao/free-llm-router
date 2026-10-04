/**
 * 任务计划表：任务码 → 步骤序列（**纯函数**）。
 *
 * ## 为什么单独一个文件
 *
 * AGENTS.md §5 的分层纪律：**协议表与执行逻辑分离**。
 * 上游改了某个任务的判据时，**只改这里**（步骤编排）或 `../upstream/events.ts`
 * （事件形状），不动 DO 与动作实现。
 *
 * ## 反风控间隔是协议的一部分，不是性能调优
 *
 * 每个步骤的 `delayMs` 直接来自 Go 侧实测（AGENTS.md §2.4）。
 * ⚠️ **不要为了「跑快点」调小它们** —— `mpChatEventGap = 45s` 是服务端
 * **回滚进度**的下限，调小会让任务白跑。
 */

import { GAP, type TaskStep } from './steps.js'
import { NEEDS_REAL_CHAT } from './actions.js'

/**
 * 第一版支持的**零对话消耗**任务 → 动作名。
 *
 * ⚠️ 这里**只列零消耗动作**。需要真实对话的任务在 `REAL_CHAT_ACTIONS`
 * （见下方），由 `includeRealChat` 控制是否入队 ——
 * 这样挂 cron 的日常计划**永远不会**在用户无感知的情况下消耗配额。
 */
const ZERO_COST_ACTIONS: ReadonlyArray<{ code: string; action: string }> = [
  { code: 'chat_5', action: 'chat5' },
  { code: 'first_buddy', action: 'firstBuddy' },
  { code: 'RichMeow_Chat', action: 'richMeow' },
  { code: 'Buddy_App', action: 'buddyApp' },
  { code: 'Buddy_App_QQ', action: 'buddyApp' },
  { code: 'automation_1', action: 'automationCreate' },
  { code: 'Library_read', action: 'libraryRead' },
  { code: 'template_5', action: 'templateUse' },
  { code: 'playbook_prompt', action: 'playbookPrompt' },
  { code: 'create_canvas', action: 'createCanvas' },
  { code: 'Hp_Appearance', action: 'hpAppearance' },
]

/**
 * 需要**真实对话**的任务 → 动作名（**会消耗配额**）。
 *
 * ⚠️ 这些**默认不入队**，只有 `includeRealChat` 为 true 时才加入
 * （见 `planGrowth` 的参数说明）。
 *
 * 理由：`daily` 计划挂在每小时 cron 上。若把会消耗配额的任务放进去，
 * 用户会在**无感知**的情况下持续花配额 —— 那不可接受。
 */
export const REAL_CHAT_ACTIONS: ReadonlyArray<{ code: string; action: string }> = [
  { code: 'expert_5', action: 'expert5' },
  { code: 'Expert_team_use_3', action: 'expertTeamUse3' },
  { code: 'skill_1', action: 'skill1' },
  { code: 'Expert_lighthouse', action: 'expertLighthouse' },
  { code: 'black_cat', action: 'blackCat' },
]

/**
 * **非任务类**的日常动作（不挂在任何 task code 上，故没有 `verifyAndClaim`）。
 *
 * ## 为什么单独一张表
 *
 * `ZERO_COST_ACTIONS` 里每一项都对应一个**成长任务**（有 task code，
 * 做完要回读 + 领奖）。而猫猫旅行 / 连登兑换 / 抽奖是**独立的活动**：
 * 它们没有 task code，奖励由活动接口直接发放，故**不能**走 `verifyAndClaim`
 * （那会去任务列表里找一个不存在的任务，白跑一轮并留下一条假的「未达标」）。
 *
 * ⚠️ 全部**零对话消耗** —— 可以安全地进挂 cron 的自动计划。
 * ⚠️ 全部**幂等**：重复执行不会重复领奖（上游对已领取回业务码）。
 */
const DAILY_ACTIVITY_ACTIONS: ReadonlyArray<{ code: string; action: string }> = [
  // 先领上一次的旅行奖励，再出发为下一次准备（动作内部保证顺序）
  { code: 'travel', action: 'travel' },
  // 连登档位兑换（逐档、单档失败不中断）
  { code: 'redeem_streak', action: 'redeemStreak' },
  // 抽奖（次数为 0 时不打上游）
  { code: 'lottery', action: 'lottery' },
]

/**
 * 每日计划：只读探测 → 签到 → 解冻相关查询。
 *
 * 顺序即执行顺序：先只读探测（确认账号可用 + 拿到进度），
 * 再做写操作（签到）。这样失败时能快速定位是「账号问题」还是「动作问题」。
 */
export function planDaily(): TaskStep[] {
  return [
    { code: '_probe', action: 'listTasks', delayMs: GAP.report },
    { code: 'checkin', action: 'checkin', delayMs: GAP.report },
    // 签到后查余额：余额恢复的冷却账号由调用方解冻
    { code: '_probe', action: 'balance', delayMs: 0 },
  ]
}

/**
 * 成长任务计划：只做**零对话消耗**的动作。
 *
 * ⚠️ 每个动作后面跟一次「回读 + 领奖」步骤：
 * 上游计分异步（实测 5–8s），且**达标后必须显式领奖**才会到账。
 * 少了这一步，任务做了但积分永远拿不到，且没有任何报错。
 */
export function planGrowth(options?: { includeRealChat?: boolean }): TaskStep[] {
  const includeRealChat = options?.includeRealChat === true

  const steps: TaskStep[] = [
    // 先拉一次列表，确认账号可用并拿到当前进度
    { code: '_probe', action: 'listTasks', delayMs: GAP.report },
    // ⚠️ **签到必须在本计划里**。面板与文档都承诺「签到 → 成长任务 → 领奖」
    //（`src/panel/assets/index.html:50-53`、`src/index.ts:447`），
    // 但早期 `planGrowth` **没有这一步** —— 用户点「执行每日任务」时只跑了成长任务，
    // **从未签到**。实测证据（2026-10-04，线上 `/admin/tasks/status`）：
    // 该按钮对应的一次运行 `done` 里有 23 步、`chat_5`/`first_buddy`/… 全在，
    // 却**没有任何 checkin 步骤**。
    //
    // 签到是**幂等**的（已签到时上游回业务码 10001，见 `upstream/checkin.ts:9-10`），
    // 故与 `daily` 计划重复执行无副作用。
    { code: 'checkin', action: 'checkin', delayMs: GAP.report },
  ]

  const actions = includeRealChat
    ? [...ZERO_COST_ACTIONS, ...REAL_CHAT_ACTIONS]
    : ZERO_COST_ACTIONS

  // ⚠️ **活动类动作放在成长任务之前**。理由：旅行/连登/抽奖是**直接发积分**的，
  // 而成长任务要靠回读确认、耗时更长。先做「确定性收益」再去做「需要回读的」，
  // 万一后面某步超时或中断，用户至少已经拿到活动的积分。
  for (const { code, action } of DAILY_ACTIVITY_ACTIONS) {
    steps.push({ code, action, delayMs: GAP.report })
  }

  for (const { code, action } of actions) {
    // 双保险：零消耗计划里绝不出现需要真实对话的任务
    if (!includeRealChat && NEEDS_REAL_CHAT.has(code)) continue
    steps.push({ code, action, delayMs: GAP.report })
    // 回读 + 领奖（内部有界轮询 ~12s；步间再留一次间隔）
    //
    // ⚠️ 真实对话类任务的间隔要更长：它们前面刚发过真实 chat，
    // 紧接着回读很可能还没落定（上游异步计分 5–8s）。
    steps.push({ code, action: 'verifyAndClaim', delayMs: includeRealChat ? GAP.claimPoll : GAP.report })
  }

  return steps
}

/** 按名称取计划。`includeRealChat` 只对 `growth` 有意义。 */
export function planByName(
  name: 'daily' | 'growth',
  options?: { includeRealChat?: boolean },
): TaskStep[] {
  switch (name) {
    case 'daily':
      // ⚠️ daily 计划**永远**不含真实对话任务（它挂在 cron 上，不能让用户无感知花配额）
      return planDaily()
    case 'growth':
      return planGrowth(options)
  }
}

/** 导出零消耗动作表（供面板展示与单测核对）。 */
export function zeroCostActions(): ReadonlyArray<{ code: string; action: string }> {
  return ZERO_COST_ACTIONS
}
