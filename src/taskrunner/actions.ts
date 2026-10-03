/**
 * 任务动作注册表：`action` 名 → 执行体。
 *
 * ## 为什么用「字符串名 + 注册表」而不是直接传函数
 *
 * DO 的 RPC 只能传**可结构化克隆**的值，**函数无法跨 isolate 传递**。
 * 因此执行器必须按名字在这里解析。
 *
 * ## 分层纪律
 *
 * 这里只做**动作编排**（调哪个上游、带什么头、如何判定结果），
 * 事件形状由 `../upstream/events.ts` 的纯函数构造。
 * 上游改判据时**只改 events.ts**，本文件不动（AGENTS.md §5）。
 *
 * ## 第一版范围（AGENTS.md §8.1）
 *
 * 只做**零对话消耗**的动作。6 个需要真实对话的任务
 * （`Model_chat_GLM5.2` / `expert_5` / `Expert_team_use_3` / `skill_1` /
 * `Expert_lighthouse` / `black_cat`）**明确不在第一版** ——
 * 注册表对它们返回失败并**说明原因**，不静默跳过。
 */

import { resolveUpstream, type Env } from '../env.js'
import { billingHeaders, desktopHeaders, mpHeaders, webHeaders, deriveDeviceId, MP_MACHINE_ID } from '../upstream/headers.js'
import { callUpstream, UpstreamError } from '../upstream/client.js'
import { dailyCheckin, fetchBalance } from '../upstream/checkin.js'
import { listTasks, mergeTaskLists } from '../upstream/tasks.js'
import { reportCli, reportDesktop, reportWeb, sanitizeEvents, withFingerprint } from '../upstream/report.js'
import {
  cliChatRequestEvent,
  desktopAppearanceSkinApplyEvent,
  desktopAutomationCreatedEvent,
  desktopBuddyAppSequence,
  desktopChatSequence,
  desktopDesignCanvasEvents,
  desktopFingerprint,
  desktopPlaybookEvents,
  desktopTemplateUseEvents,
  newIds,
  webElementClickEvent,
  webFingerprint,
  type Event,
} from '../upstream/events.js'
import {
  expertLighthouseChain,
  expertUseChain,
  marketExpertList,
  realChat,
  skillFreshChain,
  EXPERT_SUMMON_GAP_MS,
  NIGHT_CHAT_GAP_MS,
  inNightWindow,
} from '../upstream/realtime.js'
import { verifyAndClaim } from './verify.js'
import type { TaskStep } from './steps.js'

/** 执行一步所需的账号上下文。 */
export interface ActionContext {
  uid: string
  nickname: string
  realm: string
  accessToken: string
  now: number
}

/** 单步执行结果。 */
export interface ActionResult {
  ok: boolean
  detail: string
}

/**
 * **需要真实对话**（会消耗上游配额）的任务码。
 *
 * ⚠️ 这些任务**已实现**（见下方 `expert5` / `expertTeamUse3` / `skill1` /
 * `expertLighthouse` / `blackCat` 动作），但性质与零消耗任务不同：
 * 它们真的会花掉极少量配额（每次都是 `fast-model` 的极短对话）。
 *
 * 保留这个集合的用途：**默认不把它们放进自动计划**，只有显式请求才跑
 * （见 `plans.ts` 的 `includeRealChat` 参数）。这样「自动签到」这类日常调度
 * 不会在用户无感知的情况下消耗配额。
 */
export const NEEDS_REAL_CHAT: ReadonlySet<string> = new Set([
  'Model_chat_GLM5.2',
  'expert_5',
  'Expert_team_use_3',
  'skill_1',
  'Expert_lighthouse',
  'black_cat',
])

/** 动作名 → 执行体。 */
type ActionHandler = (ctx: ActionContext, step: TaskStep, env: Env) => Promise<ActionResult>

/**
 * 单次上报的间隔常量（Go 侧实测值）。
 *
 * ⚠️ **不要为了「跑快」调小** —— 这些是反风控间隔，不是性能参数。
 */
const REPORT_GAP_MS = 1050

/** 该账号的派生设备标识（同账号恒同值）。 */
async function deviceIds(uid: string): Promise<{ machineId: string; sessionId: string }> {
  return {
    machineId: await deriveDeviceId(uid, 'machine'),
    sessionId: await deriveDeviceId(uid, 'session'),
  }
}

/** 动作表。键名即 `TaskStep.action`。 */
const ACTIONS: Record<string, ActionHandler> = {
  /** 每日签到（billing 域，幂等）。 */
  async checkin(ctx, _step, env): Promise<ActionResult> {
    try {
      const result = await dailyCheckin({ uid: ctx.uid, accessToken: ctx.accessToken }, env)
      if (result.alreadyDone) return { ok: true, detail: '今日已签到（幂等命中）' }
      return { ok: true, detail: `签到成功${result.credit > 0 ? ` +${result.credit} 积分` : ''}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, '签到') }
    }
  },

  /** 查询余额（只读，用于签到后解冻冷却账号）。 */
  async balance(ctx, _step, env): Promise<ActionResult> {
    try {
      const result = await fetchBalance({ uid: ctx.uid, accessToken: ctx.accessToken }, env, ctx.now)
      return {
        ok: true,
        detail: `余额 ${result.total}${result.expiring > 0 ? `（其中 ${result.expiring} 即将过期）` : ''}，${result.packages.length} 个包`,
      }
    } catch (error) {
      return { ok: false, detail: describeError(error, '余额查询') }
    }
  },

  /** 拉取任务列表（只读）。默认口径 + mp 口径合并。 */
  async listTasks(ctx, _step, env): Promise<ActionResult> {
    try {
      const base = await listTasks(ctx, env)
      let all = base
      try {
        const mp = await listTasks(ctx, env, { mp: true })
        all = mergeTaskLists(base, mp)
      } catch {
        // mp 口径失败不致命
      }
      const pending = all.filter((t) => !t.claimed)
      const claimable = all.filter((t) => t.claimable)
      // 列出未领任务的进度明细：这是面板判断「还差什么」的唯一依据，
      // 也是排查「任务跑了但没点亮」的关键信息（只报数量会让人无从下手）。
      const detailList = pending
        .map((t) => `${t.taskCode}(${t.current}/${t.target}${t.claimable ? ' 可领' : ''})`)
        .join('、')
      return {
        ok: true,
        detail: `共 ${all.length} 个任务，${pending.length} 个未领，${claimable.length} 个可领` +
          (detailList === '' ? '' : `｜未领：${detailList}`),
      }
    } catch (error) {
      return { ok: false, detail: describeError(error, '任务列表拉取') }
    }
  },

  /**
   * `chat_5`：补报对话活跃事件（只补差额）。
   *
   * 幂等：先读进度算差额，已达标则跳过。
   * ⚠️ 每条之间 1050ms 间隔（`reportGap`）—— 这是反风控要求。
   */
  async chat5(ctx, _step, env): Promise<ActionResult> {
    try {
      const tasks = await listTasks(ctx, env)
      const task = tasks.find((t) => t.taskCode === 'chat_5')
      const target = task !== undefined && task.target > 0 ? task.target : 5
      const current = task?.current ?? 0
      const need = target - current

      if (need <= 0) return { ok: true, detail: `进度已达标（${current}/${target}），无需上报` }

      let sent = 0
      for (let i = 0; i < need; i += 1) {
        const ids = newIds()
        const event = cliChatRequestEvent({
          uid: ctx.uid,
          conversationId: `wb2api-chat5-${ctx.now}-${i}`,
          requestId: ids.requestId,
          now: Date.now(),
        })
        const result = await reportCli({ uid: ctx.uid, accessToken: ctx.accessToken }, env, sanitizeEvents([event]))
        if (!result.ok) {
          return { ok: false, detail: `上报第 ${i + 1}/${need} 条失败：${result.detail}（已成功 ${sent} 条）` }
        }
        sent += 1
        // ⚠️ 步**内**的多条上报之间必须留间隔（反风控）；
        // 最后一条之后不再等（省一次无意义等待）。
        // 注意：步**间**的间隔由 DO 的 alarm 负责（`TaskStep.delayMs`），不在这里做。
        if (i < need - 1) {
          await new Promise<void>((r) => setTimeout(r, REPORT_GAP_MS))
        }
      }
      return { ok: true, detail: `已补报 ${sent} 条对话事件（目标 ${target}，此前 ${current}）` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'chat_5') }
    }
  },

  /**
   * `first_buddy`：前置上报 → 同意协议 → 领养。
   *
   * 顺序不可调换：领养接口要求**当日已有活跃**（前置上报产生），
   * 少了前置会恒失败于 `first_buddy task not completed yet`
   * （Go 侧记录过这个缺陷，修正后实测 +300 到账）。
   */
  async firstBuddy(ctx, step, env): Promise<ActionResult> {
    try {
      // ① 前置上报（解锁当日活跃）
      const ids = newIds()
      const pre = cliChatRequestEvent({
        uid: ctx.uid,
        conversationId: `wb2api-adopt-${ctx.now}`,
        requestId: ids.requestId,
        now: Date.now(),
      })
      const preResult = await reportCli({ uid: ctx.uid, accessToken: ctx.accessToken }, env, sanitizeEvents([pre]))
      if (!preResult.ok) return { ok: false, detail: `前置上报失败：${preResult.detail}` }

      // 给上游事件处理留时间
      await new Promise<void>((r) => setTimeout(r, REPORT_GAP_MS))

      const bases = resolveUpstream(env)
      const headers = desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken })

      // ② 同意协议（幂等）
      const agree = await callUpstream({
        method: 'POST',
        url: `${bases.chat}/activity/growth/buddy/agreement`,
        headers,
        body: JSON.stringify({ agree: true }),
      })
      if (!agree.ok) {
        return { ok: false, detail: `同意协议失败：http=${agree.httpStatus} ${agree.raw.slice(0, 120)}` }
      }

      // ③ 领养
      const first = await callUpstream({
        method: 'POST',
        url: `${bases.chat}/activity/growth/buddy/first`,
        headers,
        body: '{}',
      })
      if (!first.ok) {
        // 门槛未过是**可重试**的（上游要求当日活跃），不是致命错误
        const msg = first.envelope?.msg ?? ''
        if (/not completed|task not/i.test(msg)) {
          return { ok: false, detail: '前置已上报，但领养门槛未过（上游要求当日活跃），可稍后重试' }
        }
        return { ok: false, detail: `领养失败：http=${first.httpStatus} ${msg || first.raw.slice(0, 120)}` }
      }
      return { ok: true, detail: '已领取 Buddy（+300 积分 +8 能量）' }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'first_buddy') }
    }
  },

  /**
   * `RichMeow_Chat`：桌面指纹对话事件链（6 事件，**纯 API 可点亮**）。
   *
   * ⚠️ 判据核心是 `chat_message_response.isSuccessful = true`。
   */
  async richMeow(ctx, _step, env): Promise<ActionResult> {
    try {
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const ids = newIds()
      const chain = desktopChatSequence({
        conversationId: ids.conversationId,
        requestId: ids.requestId,
        messageId: ids.messageId,
        modelId: 'glm-5.2',
        modelName: 'GLM-5.2',
        now: Date.now(),
      })
      const fingerprint = desktopFingerprint({
        uid: ctx.uid,
        nickname: ctx.nickname,
        machineId,
        sessionId,
        now: Date.now(),
      })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents(withFingerprint(chain, fingerprint)),
      )
      return result.ok
        ? { ok: true, detail: '已上报桌面对话事件链（6 事件）' }
        : { ok: false, detail: `事件链上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'RichMeow_Chat') }
    }
  },

  /** `Buddy_App` / `Buddy_App_QQ`：Buddy 应用进入链（5 事件）。 */
  async buddyApp(ctx, _step, env): Promise<ActionResult> {
    try {
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const ids = newIds()
      const chain = desktopBuddyAppSequence({
        conversationId: ids.conversationId,
        // 企鹅教师助手的固定 id（Go 侧实测值）
        buddyId: 'cb_y5Dy46tPQGGWtueMxXbe',
        now: Date.now(),
      })
      const fingerprint = desktopFingerprint({
        uid: ctx.uid,
        nickname: ctx.nickname,
        machineId,
        sessionId,
        now: Date.now(),
      })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents(withFingerprint(chain, fingerprint)),
      )
      return result.ok
        ? { ok: true, detail: '已上报 Buddy 应用进入事件链（5 事件）' }
        : { ok: false, detail: `事件链上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'Buddy_App') }
    }
  },

  /** `automation_1`：定时任务创建事件（单事件）。 */
  async automationCreate(ctx, _step, env): Promise<ActionResult> {
    try {
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const ids = newIds()
      const fingerprint = desktopFingerprint({
        uid: ctx.uid, nickname: ctx.nickname, machineId, sessionId, now: Date.now(),
      })
      const event = desktopAutomationCreatedEvent({ conversationId: ids.conversationId, now: Date.now() })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents(withFingerprint([event], fingerprint)),
      )
      return result.ok
        ? { ok: true, detail: '已上报定时任务创建事件' }
        : { ok: false, detail: `上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'automation_1') }
    }
  },

  /**
   * `Library_read`：资料库阅读点击（**web 域**指纹）。
   *
   * ⚠️ 走 web 域（`www.workbuddy.cn`）+ `x-client-platform: web`，
   * 不是 chat 域。发错域名点不亮。
   */
  async libraryRead(ctx, _step, env): Promise<ActionResult> {
    try {
      const machineId = await deriveDeviceId(ctx.uid, 'webmachine')
      const event = webElementClickEvent({
        uid: ctx.uid,
        machineId,
        pageUrl: 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm',
        elementId: 'library_doc_intro_click',
        now: Date.now(),
      })
      const result = await reportWeb(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents([event]),
      )
      return result.ok
        ? { ok: true, detail: '已上报资料库介绍阅读事件' }
        : { ok: false, detail: `上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'Library_read') }
    }
  },

  /** `template_5`：模板使用事件组 × 差额（每组 2 事件）。 */
  async templateUse(ctx, _step, env): Promise<ActionResult> {
    try {
      const tasks = await listTasks(ctx, env)
      const task = tasks.find((t) => t.taskCode === 'template_5')
      const target = task !== undefined && task.target > 0 ? task.target : 5
      const need = target - (task?.current ?? 0)
      if (need <= 0) return { ok: true, detail: `进度已达标（${target}），无需上报` }

      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const fingerprint = desktopFingerprint({
        uid: ctx.uid, nickname: ctx.nickname, machineId, sessionId, now: Date.now(),
      })
      let sent = 0
      for (let i = 0; i < need; i += 1) {
        const ids = newIds()
        const events = desktopTemplateUseEvents({
          conversationId: ids.conversationId,
          templateId: `wb2api-template-${i}`,
          now: Date.now(),
        })
        const result = await reportDesktop(
          { uid: ctx.uid, accessToken: ctx.accessToken },
          env,
          sanitizeEvents(withFingerprint(events, fingerprint)),
        )
        if (!result.ok) return { ok: false, detail: `第 ${i + 1}/${need} 组失败：${result.detail}` }
        sent += 1
        if (i < need - 1) await new Promise<void>((r) => setTimeout(r, REPORT_GAP_MS))
      }
      return { ok: true, detail: `已上报 ${sent} 组模板使用事件` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'template_5') }
    }
  },

  /** `playbook_prompt`：灵感案例「做同款」发送事件组。 */
  async playbookPrompt(ctx, _step, env): Promise<ActionResult> {
    try {
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const ids = newIds()
      const events = desktopPlaybookEvents({
        conversationId: ids.conversationId,
        pageUrl: 'https://www.workbuddy.cn/playbook',
        now: Date.now(),
      })
      const fingerprint = desktopFingerprint({
        uid: ctx.uid, nickname: ctx.nickname, machineId, sessionId, now: Date.now(),
      })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents(withFingerprint(events, fingerprint)),
      )
      return result.ok
        ? { ok: true, detail: '已上报灵感案例事件组' }
        : { ok: false, detail: `上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'playbook_prompt') }
    }
  },

  /** `create_canvas`：设计画布事件组。 */
  async createCanvas(ctx, _step, env): Promise<ActionResult> {
    try {
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const ids = newIds()
      const events = desktopDesignCanvasEvents({ conversationId: ids.conversationId, now: Date.now() })
      const fingerprint = desktopFingerprint({
        uid: ctx.uid, nickname: ctx.nickname, machineId, sessionId, now: Date.now(),
      })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents(withFingerprint(events, fingerprint)),
      )
      return result.ok
        ? { ok: true, detail: '已上报设计画布事件组' }
        : { ok: false, detail: `上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'create_canvas') }
    }
  },

  /** `Hp_Appearance`：外观主题设置 + 皮肤生效事件。 */
  async hpAppearance(ctx, _step, env): Promise<ActionResult> {
    try {
      const bases = resolveUpstream(env)
      // ① 设置主题（API）
      const set = await callUpstream({
        method: 'POST',
        url: `${bases.chat}/v2/user-asset/appearance/set`,
        headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
        body: JSON.stringify({ kind: 'theme', resource_key: 'theme-tkmw7j' }),
      })
      if (!set.ok) {
        return { ok: false, detail: `设置主题失败：http=${set.httpStatus} ${set.raw.slice(0, 120)}` }
      }

      // ② 上报皮肤生效事件
      const { machineId, sessionId } = await deviceIds(ctx.uid)
      const event = desktopAppearanceSkinApplyEvent({
        uid: ctx.uid, machineId, sessionId, now: Date.now(),
      })
      const result = await reportDesktop(
        { uid: ctx.uid, accessToken: ctx.accessToken },
        env,
        sanitizeEvents([event]),
      )
      return result.ok
        ? { ok: true, detail: '已设置主题并上报皮肤生效事件' }
        : { ok: false, detail: `事件上报失败：${result.detail}` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'Hp_Appearance') }
    }
  },

  // ─────────────────── 需要真实对话的动作（会消耗配额） ───────────────────
  // ⚠️ 这些动作由 `plans.ts` 的 `includeRealChat` 控制是否入队。
  // 每个都**先查进度**：已达标就直接跳过，不做无谓的对话消耗。

  /**
   * `expert_5`：召唤并使用 5 位真实专家。
   *
   * ⚠️ 关键点：`expert_actual_use` 的判据要求
   * ① 专家 id **真实存在**（编造不计数）→ 必须先拉市场列表；
   * ② `requestId` 是**服务端签发**的（自造 UUID 不计数）→ 必须真发对话并从 SSE 抓 id。
   */
  async expert5(ctx, _step, env): Promise<ActionResult> {
    return await runExpertBatch(ctx, env, 'agent', 5, 'expert_5')
  },

  /** `Expert_team_use_3`：召唤并使用 3 个专家团（`expertType=team`）。 */
  async expertTeamUse3(ctx, _step, env): Promise<ActionResult> {
    return await runExpertBatch(ctx, env, 'team', 3, 'Expert_team_use_3')
  },

  /** `skill_1`：真实对话（`finishReason=tool_calls`）+ `skill_info` 事件。 */
  async skill1(ctx, _step, env): Promise<ActionResult> {
    try {
      const outcome = await skillFreshChain(
        { uid: ctx.uid, accessToken: ctx.accessToken, nickname: ctx.nickname },
        env,
        (events) =>
          reportDesktop({ uid: ctx.uid, accessToken: ctx.accessToken }, env, sanitizeEvents(events)),
      )
      return outcome
    } catch (error) {
      return { ok: false, detail: describeError(error, 'skill_1') }
    }
  },

  /** `Expert_lighthouse`：固定轻量云专家（可免费领一个月轻量服务器）。 */
  async expertLighthouse(ctx, _step, env): Promise<ActionResult> {
    try {
      const outcome = await expertLighthouseChain(
        { uid: ctx.uid, accessToken: ctx.accessToken, nickname: ctx.nickname },
        env,
        (events) => reportDesktop({ uid: ctx.uid, accessToken: ctx.accessToken }, env, sanitizeEvents(events)),
      )
      return outcome
    } catch (error) {
      return { ok: false, detail: describeError(error, 'Expert_lighthouse') }
    }
  },

  /**
   * `black_cat`：夜猫子——窗口内做若干次 glm-5.2 真实对话并上报。
   *
   * ⚠️ 只补**差额**（先读进度），且每次之间 4 秒间隔（Go 侧实测）。
   * 有上限 `MAX_NIGHT_CHATS` 兜底：上游若返回异常大的 target，不至于无限对话。
   */
  async blackCat(ctx, _step, env): Promise<ActionResult> {
    try {
      // ⚠️ 窗口外**直接跳过**，不做任何对话。
      // 夜猫子只在 23:00–08:00 计分；窗口外跑会白花配额，
      // 且表现为「上报成功但进度不动」——很难排查（线上实测过）。
      if (!inNightWindow(Date.now())) {
        return { ok: true, detail: '当前不在夜猫子窗口（23:00–08:00 UTC+8），已跳过（无消耗）' }
      }

      const tasks = await listTasks(ctx, env)
      const task = tasks.find((t) => t.taskCode === 'black_cat')
      if (task === undefined) return { ok: false, detail: '该账号无 black_cat 任务' }
      if (task.claimed || (task.target > 0 && task.current >= task.target)) {
        return { ok: true, detail: '进度已达标，无需对话' }
      }
      const need = Math.min(Math.max(0, task.target - task.current), MAX_NIGHT_CHATS)
      if (need === 0) return { ok: true, detail: '无需补做' }

      let done = 0
      for (let i = 0; i < need; i += 1) {
        const chat = await realChat({ uid: ctx.uid, accessToken: ctx.accessToken }, env, '')
        const event = cliChatRequestEvent({
          uid: ctx.uid,
          conversationId: chat.conversationId,
          requestId: chat.requestId,
          now: Date.now(),
          modelId: 'glm-5.2',
          modelName: 'GLM-5.2',
        })
        const r = await reportCli(
          { uid: ctx.uid, accessToken: ctx.accessToken },
          env,
          sanitizeEvents([event]),
        )
        if (!r.ok) return { ok: false, detail: `第 ${i + 1}/${need} 次上报失败：${r.detail}（已完成 ${done}）` }
        done += 1
        if (i < need - 1) await new Promise<void>((res) => setTimeout(res, NIGHT_CHAT_GAP_MS))
      }
      return { ok: true, detail: `已完成 ${done} 次 glm-5.2 对话并上报` }
    } catch (error) {
      return { ok: false, detail: describeError(error, 'black_cat') }
    }
  },

  /**
   * 通用「回读 + 自动领奖」动作。
   *
   * ⚠️ 上游计分**异步**（实测 5–8s 才落定），故必须有界轮询
   * （见 `verify.ts` 的详细说明）。只读一次会误判「未达标」而**跳过领奖**。
   */
  async verifyAndClaim(ctx, step, env): Promise<ActionResult> {
    try {
      const outcome = await verifyAndClaim(
        {
          uid: ctx.uid,
          accessToken: ctx.accessToken,
          realm: ctx.realm,
        },
        env,
        step.code,
      )
      // 领奖成功但进度仍显示未领取时，不作为失败（可能上游状态滞后）
      const claimOk = outcome.claim === undefined || outcome.claim.claimed || outcome.verify.done
      return { ok: claimOk, detail: outcome.detail }
    } catch (error) {
      return { ok: false, detail: describeError(error, `${step.code} 领奖`) }
    }
  },
}

/** 夜间对话的次数上限（防上游返回异常大的 target 导致无限对话）。 */
const MAX_NIGHT_CHATS = 10

/**
 * 专家批量使用：拉真实列表 → 逐个「召唤 → 真实对话 → 使用事件」。
 *
 * ⚠️ 逐个**独立容错**：某一位专家失败就换下一位，直到凑够 `count` 位。
 * 不因为一位失败就整体失败 —— 那样会让剩下的配额白花。
 */
async function runExpertBatch(
  ctx: ActionContext,
  env: Env,
  expertType: string,
  count: number,
  label: string,
): Promise<ActionResult> {
  try {
    const experts = await marketExpertList({ uid: ctx.uid, accessToken: ctx.accessToken }, env, expertType)
    if (experts.length === 0) return { ok: false, detail: `${label}：专家市场列表为空（无法取得真实专家 id）` }

    let ok = 0
    let lastError = ''
    for (let i = 0; i < experts.length && ok < count; i += 1) {
      const expert = experts[i]
      if (expert === undefined) continue
      const outcome = await expertUseChain(
        { uid: ctx.uid, accessToken: ctx.accessToken, nickname: ctx.nickname },
        env,
        expert,
        (events) => reportDesktop({ uid: ctx.uid, accessToken: ctx.accessToken }, env, sanitizeEvents(events)),
      )
      if (outcome.ok) ok += 1
      else lastError = outcome.detail
      // 间隔：反风控（Go 侧 expertSummonGap = 6s，不要调小）
      if (ok < count && i < experts.length - 1) {
        await new Promise<void>((r) => setTimeout(r, EXPERT_SUMMON_GAP_MS))
      }
    }

    return ok >= count
      ? { ok: true, detail: `已对 ${ok} 位真实专家完成召唤+使用链（类型 ${expertType}）` }
      : { ok: false, detail: `${label}：仅完成 ${ok}/${count} 位${lastError === '' ? '' : `；最后一次失败：${lastError}`}` }
  } catch (error) {
    return { ok: false, detail: describeError(error, label) }
  }
}

/** 统一错误描述（保留原文片段，便于定位）。 */
function describeError(error: unknown, label: string): string {
  if (error instanceof UpstreamError) {
    return `${label}失败（${error.kind}）：${error.message}`
  }
  return `${label}异常：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
}

/**
 * 执行一步（**唯一入口**）。
 *
 * 判定顺序即纪律：
 * 1. **需要真实对话的任务**直接拒绝（第一版范围外，显式说明原因）；
 * 2. 未注册的动作 → 显式报错（**不静默跳过** —— 那会让用户以为任务做了）；
 * 3. 已注册动作 → 执行，异常**包装成失败结果**（不让 alarm 崩掉）。
 */
export async function executeAction(step: TaskStep, ctx: ActionContext, env: Env): Promise<ActionResult> {
  // 未注册的动作 → 显式报错（**不静默跳过**：那会让用户以为任务做了）
  const handler = ACTIONS[step.action]
  if (handler === undefined) {
    return { ok: false, detail: `未注册的动作：${step.action}` }
  }

  // ⚠️ 这里**刻意不再**拦截「需要真实对话」的任务。
  //
  // 是否跑真实对话由 **计划层** 决定（`plans.ts` 的 `includeRealChat`）——
  // 那是唯一能同时知道「用户显式要求了」与「该任务是否已达标」的地方。
  //
  // 早期版本在这里加了一道 `NEEDS_REAL_CHAT.has(step.code)` 的硬闸，
  // 结果把已经实现好的 5 个真实对话动作**全部拦死**（线上实测：
  // `growth + includeRealChat` 的 10 个步骤全部报「不在第一版范围」）。
  // 教训：门禁要放在**决定要不要入队**的地方，而不是放在执行处 ——
  // 后者会让「实现好了但没接线」这种问题只在运行时才暴露。

  // 执行；任何异常都转成失败结果（带原文），不向上抛
  try {
    return await handler(ctx, step, env)
  } catch (error) {
    return { ok: false, detail: describeError(error, step.action) }
  }
}

/** 已注册的动作名（供面板展示与单测核对）。 */
export function registeredActions(): string[] {
  return Object.keys(ACTIONS).sort()
}

/** 供外部构造步骤时复用的头构造器。 */
export const headerBuilders = {
  billing: (uid: string, token: string) => billingHeaders({ uid, accessToken: token }),
  desktop: (uid: string, token: string) => desktopHeaders({ uid, accessToken: token }),
  web: (uid: string, token: string) => webHeaders({ uid, accessToken: token }),
  mp: (uid: string, token: string) => mpHeaders({ uid, accessToken: token }),
}

/** 供单测核对 mp machineId 常量。 */
export const MP_MACHINE_ID_FOR_TEST = MP_MACHINE_ID
/** 供单测核对事件类型。 */
export type { Event }
