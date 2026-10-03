/**
 * 行为事件构造（**纯函数**，不碰网络、不碰存储）。
 *
 * ## 为什么这个模块最重要
 *
 * 任务计分完全依赖「事件形状对不对」。上游按**客户端指纹 + 事件字段**判定
 * 是否计入进度，字段缺一个就可能 200 但静默丢弃（Go 侧实测：
 * 事件缺 `userId` 时服务端 200 但直接丢）。
 *
 * ⇒ 上游改判据时**只改这个文件**，执行逻辑不动（AGENTS.md §5 的分层纪律）。
 * ⇒ 每个构造函数都有单测锁死形状（`tests/events.test.ts`）。
 *
 * ## 四套指纹（AGENTS.md §6.1）
 *
 * | 指纹 | 事件族 | 判别字段 |
 * |---|---|---|
 * | CLI | `chat_request_send` | `agentName:"default"`, `agentType:"conversation"`, `mode:"craft"` |
 * | 桌面 | `agent_task_created` 等 6 事件 | `ideName/ideType:"WorkBuddy"`, `extName:"workbuddy-desktop"` |
 * | Web | `web_element_click` | `pageURL`, `elementId` |
 * | mp | `chat_request_send` | `ideType:"WorkBuddy_MP"`, `platform:"mini_program"` |
 */

import { DESKTOP_VERSION } from './headers.js'

/** 事件是一个宽松的 map（上游字段多且会变，强类型反而碍事）。 */
export type Event = Record<string, unknown>

/**
 * 桌面端公共指纹（注入到**每个**桌面事件）。
 *
 * ⚠️ `machineId` 必须是**由 uid 稳定派生**的 36 位 hex，不能每次随机 ——
 * 同账号每次生成不同设备标识本身就是风控信号。
 */
export function desktopFingerprint(input: {
  uid: string
  nickname: string
  machineId: string
  sessionId: string
  now: number
}): Event {
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: input.uid,
    username: input.nickname,
    userNickname: input.nickname,
    product: 'SaaS',
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: DESKTOP_VERSION,
    machineId: input.machineId,
    sessionId: input.sessionId,
    extName: 'workbuddy-desktop',
    extVersion: DESKTOP_VERSION,
    os: 'win32',
    arch: 'x64',
    osVersion: '10.0.26220',
    cpuCores: 20,
    memorySize: 24,
    timestamp: input.now,
    presentAt: input.now,
  }
}

/** web 端公共指纹。 */
export function webFingerprint(input: { uid: string; machineId: string; now: number }): Event {
  return {
    userId: input.uid,
    machineId: input.machineId,
    os: 'win32',
    timestamp: input.now,
    presentAt: input.now,
  }
}

/**
 * mp 小程序公共指纹。
 *
 * ⚠️ `machineId` 是**硬编码常量**（不是派生值）—— 实测小程序侧就是这样下发的。
 * `platform: "mini_program"` 与 `ideType: "WorkBuddy_MP"` 是判别的关键。
 */
export function mpFingerprint(input: { uid: string; nickname: string; now: number; machineId: string }): Event {
  return {
    userId: input.uid,
    username: input.nickname,
    userNickname: input.nickname,
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy_MP',
    platform: 'mini_program',
    machineId: input.machineId,
    extName: 'workbuddy-mp',
    extVersion: '2.2.8',
    product: 'SaaS',
    source: 'mini_program',
    timestamp: input.now,
    presentAt: input.now,
  }
}

/**
 * CLI 活跃上报事件（`chat_request_send`）。
 *
 * 这一条同时点亮两件事：growth 连登 + 解锁 `first_buddy` 的前置。
 *
 * ⚠️ 逐字对齐 Go 侧 `chatRequestEvent`（`report.go:150-206`）：
 * **字段必须齐全**，Go 侧明确记录「勿用最小 3 字段，防上游后续加严」。
 */
export function cliChatRequestEvent(input: {
  uid: string
  conversationId: string
  requestId: string
  now: number
  /** 模型 id；空则回落 `deepseek-v4-flash`（Go 侧同口径）。 */
  modelId?: string
  modelName?: string
}): Event {
  const modelId = input.modelId !== undefined && input.modelId !== '' ? input.modelId : 'deepseek-v4-flash'
  const modelName = input.modelName !== undefined && input.modelName !== '' ? input.modelName : modelId
  const requestId = input.requestId !== '' ? input.requestId : input.conversationId

  return {
    eventCode: 'chat_request_send',
    timestamp: input.now,
    reportDelay: 0,
    mode: 'craft',
    conversationId: input.conversationId,
    requestId,
    inputLength: 12,
    requestModelId: modelId,
    requestModelName: modelName,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: input.now,
    traceId: '',
    rootRequestId: requestId,
    parentConversationId: input.conversationId,
    // ⚠️ 这两个字段是 CLI 口径的判别标志（区别于桌面/``）
    agentName: 'default',
    agentType: 'conversation',
    userId: input.uid,
  }
}

/**
 * 桌面端「成功对话」完整事件链（6 事件）。
 *
 * 实测该链点亮 `RichMeow_Chat`（需电脑端的任务）。
 *
 * ⚠️ 关键：`chat_message_response` 的 `isSuccessful: true` 是判据核心 ——
 * 服务端对事件链有真实性校验倾向，只发前半段点不亮。
 */
export function desktopChatSequence(input: {
  conversationId: string
  requestId: string
  messageId: string
  modelId: string
  modelName: string
  now: number
  /**
   * 覆盖 `chat_message_response.finishReason` 与 `chat_request_response.finishReason`。
   * `skill_1` 需要 `'tool_calls'`（语义是「模型发起了工具调用/技能加载」）；
   * 其余绝大多数任务是 `'stop'`。
   */
  finishReason?: string
}): Event[] {
  const { conversationId, requestId, messageId, modelId, modelName, now } = input
  const finishReason = input.finishReason ?? 'stop'
  const assistantMessageId = `${messageId}-assistant`

  const mk = (code: string, extra: Event): Event => ({ eventCode: code, ...extra })

  return [
    mk('agent_task_created', {
      source: 'LOCAL',
      name: 'working',
      task_target: 'local',
      mode: 'craft',
      requestModelId: modelId,
      requestModelName: modelName,
      has_repo: false,
      repo_type: 'none',
      workspace_type: 'empty',
      has_connector: false,
      connector_types: [],
      has_mention: false,
      mention_types: [],
      has_template: false,
      action: '',
      template_name: '',
      has_expert: false,
      expert_id: '',
      expert_name: '',
      expert_industry_id: '',
      has_skill: false,
      skill_names: [],
      conversationId,
      messageId,
      buddyId: '',
      buddyName: '',
    }),
    mk('chat_message_send', {
      messageId: assistantMessageId,
      historyCount: 0,
      isContextTruncated: false,
      currentStepCount: 1,
      traceId: requestId,
      rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli',
      agentType: 'main',
    }),
    mk('chat_request_send', {
      inputLength: 24,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 500,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      traceId: requestId,
      rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli',
      agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    }),
    mk('chat_message_response', {
      messageId: assistantMessageId,
      responseModelId: modelId,
      inputToken: 120,
      outputToken: 80,
      totalToken: 200,
      cachedTokens: 0,
      cachedWriteTokens: 0,
      cachedMissTokens: 0,
      // ⚠️ 判据核心：必须 isSuccessful=true
      isSuccessful: true,
      messageErrorCode: '',
      finishReason,
      firstTokenAt: now,
      traceId: requestId,
      conversationId,
      rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli',
      agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    }),
    mk('chat_message_status', {
      messageId: assistantMessageId,
      messageErrorCode: '0',
      traceId: requestId,
      rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli',
      agentType: 'main',
    }),
    mk('chat_request_response', {
      mode: 'craft',
      toolCallCount: 0,
      inputToken: 120,
      outputToken: 80,
      totalToken: 200,
      cachedTokens: 0,
      cachedWriteTokens: 0,
      cachedMissTokens: 0,
      isSuccessful: true,
      messageErrorCode: '',
      finishReason,
      rootRequestId: requestId,
      parentConversationId: conversationId,
    }),
  ]
}

// ─────────────────── 专家类任务（expert_5 / Expert_team_use_3 / Expert_lighthouse） ───────────────────

/**
 * 平台市场里的真实专家。
 *
 * ⚠️ `expertId` 必须是**平台上真实存在的** id —— `expert_actual_use` 的判据会校验，
 * **编造 id 不计数**（Go 侧 `desktop.go:380` 明确记录）。
 * 故必须先调 `marketExpertList` 拉真实列表，不能硬编码。
 */
export interface MarketExpert {
  expertId: string
  expertType: string
  displayNameZh: string
  professionZh: string
  version: string
  categories: unknown[]
}

/** 取专家的分类（上游是数组，取首个字符串；缺省 `expert-all`）。 */
function expertCategory(e: MarketExpert): string {
  for (const c of e.categories) {
    if (typeof c === 'string' && c !== '') return c
  }
  return 'expert-all'
}

/**
 * 「召唤专家」事件组（3 事件）。
 *
 * ⚠️ `pageURL` 是 asar 内部路径，必须**逐字对齐**真实客户端 ——
 * 服务端按它识别「确实是从客户端里点的召唤」。
 */
export function desktopExpertSummonEvents(e: MarketExpert): Event[] {
  const cat = expertCategory(e)
  const version = e.version !== '' ? e.version : '1.0.0'
  return [
    {
      eventCode: 'web_element_click',
      source: e.expertId,
      type: cat,
      version,
      elementId: 'expert_summon_click',
      elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click',
      id: e.expertId,
      name: e.displayNameZh,
      expertTitle: e.professionZh,
      type: 'expert-all',
      position: 0,
      expertType: e.expertType,
      version,
      mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned',
      id: e.expertId,
      name: e.displayNameZh,
      expertTitle: e.professionZh,
      type: 'expert-all',
    },
  ]
}

/**
 * `expert_actual_use` 事件（**使用**专家的判据）。
 *
 * ⚠️ `requestId` 必须是**服务端返回的真实 id**（从 SSE 流里抓），
 * 自造 UUID 不计数（`desktop.go:417-418`）。
 */
export function desktopExpertActualUseEvent(e: MarketExpert, conversationId: string, requestId: string): Event {
  const cat = expertCategory(e)
  const version = e.version !== '' ? e.version : '1.0.0'
  return {
    eventCode: 'expert_actual_use',
    id: e.expertId,
    name: e.displayNameZh,
    expertTitle: e.professionZh,
    type: cat,
    expertType: e.expertType,
    source: 'builtin',
    version,
    cost: 9000,
    characterCount: 14,
    conversationId,
    requestId,
    messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: 'fast-model',
    requestModelName: 'fast-model',
  }
}

/**
 * `skill_1` 的技能加载事件。
 *
 * ⚠️ 必须带上**真实对话的** `conversationId` / `requestId`，
 * 且配套的 chat 链里 `chat_message_response.finishReason` 要是 `'tool_calls'`
 * （语义：模型发起了工具调用 → 加载了技能）。
 */
export function skillInfoEvent(input: {
  conversationId: string
  requestId: string
  now: number
}): Event {
  return {
    eventCode: 'skill_info',
    id: '润泽小馆·日报撰写',
    skillId: 'skill_2097350077599879168',
    skillVersion: '1.0.0',
    toolStatus: 'success',
    fileCount: 56,
    source: 'workbuddy-desktop',
    conversationId: input.conversationId,
    requestId: input.requestId,
    messageId: `msg-${input.requestId.slice(-8)}`,
    requestModelId: 'fast-model',
    requestModelName: 'fast-model',
    traceId: input.requestId,
  }
}

/**
 * web 域「元素点击」事件（`Library_read` 等 web 端任务用）。
 *
 * ⚠️ `x-client-platform: web` 头与 `pageURL`/`elementId` 是判据。
 */
export function webElementClickEvent(input: {
  uid: string
  machineId: string
  pageUrl: string
  elementId: string
  now: number
}): Event {
  return {
    eventCode: 'web_element_click',
    elementId: input.elementId,
    pageURL: input.pageUrl,
    userId: input.uid,
    machineId: input.machineId,
    os: 'win32',
    timestamp: input.now,
    presentAt: input.now,
  }
}

/** 桌面端「Buddy 应用」进入链（`Buddy_App` / `Buddy_App_QQ` 共用）。 */
export function desktopBuddyAppSequence(input: { conversationId: string; buddyId: string; now: number }): Event[] {
  const { conversationId, buddyId, now } = input
  const mk = (code: string, extra: Event): Event => ({
    eventCode: code,
    conversationId,
    buddyId,
    mode: 'LOCAL',
    timestamp: now,
    presentAt: now,
    ...extra,
  })
  return [
    mk('buddy_app_discover', { action: 'discover' }),
    mk('buddy_app_show', { action: 'show' }),
    mk('buddy_app_enter', { action: 'enter' }),
    mk('buddy_app_auth_confirm', { action: 'auth_confirm' }),
    mk('buddy_app_bind_skip', { action: 'bind_skip' }),
  ]
}

/** 桌面端「定时任务创建成功」事件（`automation_1`）。 */
export function desktopAutomationCreatedEvent(input: { conversationId: string; now: number }): Event {
  return {
    eventCode: 'automated_task_create_suc',
    conversationId: input.conversationId,
    source: 'LOCAL',
    timestamp: input.now,
    presentAt: input.now,
  }
}

/** 桌面端「模板使用」事件组（`template_5`，每组 2 事件）。 */
export function desktopTemplateUseEvents(input: {
  conversationId: string
  templateId: string
  now: number
}): Event[] {
  const { conversationId, templateId, now } = input
  return [
    {
      eventCode: 'agent_task_created_with_template',
      conversationId,
      template_id: templateId,
      source: 'LOCAL',
      timestamp: now,
      presentAt: now,
    },
    {
      eventCode: 'template_used',
      conversationId,
      template_id: templateId,
      timestamp: now,
      presentAt: now,
    },
  ]
}

/** 桌面端「灵感案例发送」事件组（`playbook_prompt`）。 */
export function desktopPlaybookEvents(input: { conversationId: string; pageUrl: string; now: number }): Event[] {
  const { conversationId, pageUrl, now } = input
  return [
    {
      eventCode: 'web_element_click',
      elementId: 'playbook_ctaClick',
      pageURL: pageUrl,
      conversationId,
      timestamp: now,
      presentAt: now,
    },
    { eventCode: 'playbook_cta_click', conversationId, timestamp: now, presentAt: now },
    { eventCode: 'playbook_prompt_send', conversationId, timestamp: now, presentAt: now },
  ]
}

/** 桌面端「设计画布」事件组（`create_canvas`）。 */
export function desktopDesignCanvasEvents(input: { conversationId: string; now: number }): Event[] {
  const { conversationId, now } = input
  return [
    {
      eventCode: 'wbx_design_canvas_task_create',
      conversationId,
      cost: 12000,
      source: 'summon_keyword',
      timestamp: now,
      presentAt: now,
    },
    {
      eventCode: 'wbx_design_canvas_open',
      conversationId,
      cost: 13000,
      source: 'summon_keyword',
      timestamp: now,
      presentAt: now,
    },
  ]
}

/** 外观主题设置事件（`Hp_Appearance`）。 */
export function desktopAppearanceSkinApplyEvent(input: { uid: string; machineId: string; sessionId: string; now: number }): Event {
  return {
    ...desktopFingerprint({
      uid: input.uid,
      nickname: '',
      machineId: input.machineId,
      sessionId: input.sessionId,
      now: input.now,
    }),
    eventCode: 'appearance_skin_apply',
    resourceKey: 'theme-tkmw7j',
  }
}

/**
 * 生成一对关联 id（conversation / request / message）。
 *
 * ⚠️ 为什么必须成对生成：桌面事件链靠 `conversationId` / `rootRequestId` /
 * `messageId` 三键贯穿 join，不成对的话服务端拼不出完整链，点不亮。
 */
export function newIds(): { conversationId: string; requestId: string; messageId: string } {
  return {
    conversationId: crypto.randomUUID(),
    requestId: crypto.randomUUID().replaceAll('-', ''),
    messageId: crypto.randomUUID().replaceAll('-', ''),
  }
}
