/**
 * 事件构造的单测（锁死上游判据依赖的形状）。
 *
 * ## 为什么这些断言值得写
 *
 * 上游对事件链有**真实性校验**：字段缺一个可能 200 但静默丢弃，
 * 或者只发前半段点不亮。而这类失败**没有报错**，只表现为「任务进度不涨」——
 * 排查代价极高。
 *
 * 所以这里把「哪些字段是判据核心」显式钉住，改坏了立刻红。
 *
 * 运行：`node --test --experimental-strip-types tests/events.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

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
  mpFingerprint,
  newIds,
  webElementClickEvent,
  webFingerprint,
} from '../src/upstream/events.ts'

const NOW = 1_700_000_000_000

test('CLI 事件：三个判别字段必须精确匹配', () => {
  const ev = cliChatRequestEvent({
    uid: 'u1',
    conversationId: 'c1',
    requestId: 'r1',
    now: NOW,
  })
  // ⚠️ 这三个是 CLI 口径的判别标志（区别于桌面/`` 的 "cli"）
  assert.equal(ev.agentName, 'default')
  assert.equal(ev.agentType, 'conversation')
  assert.equal(ev.mode, 'craft')
  assert.equal(ev.eventCode, 'chat_request_send')
})

test('CLI 事件：userId 必须存在（缺失会被服务端静默丢弃）', () => {
  const ev = cliChatRequestEvent({ uid: 'u-xyz', conversationId: 'c1', requestId: 'r1', now: NOW })
  assert.equal(ev.userId, 'u-xyz')
})

test('CLI 事件：字段必须齐全，不能用最小 3 字段', () => {
  const ev = cliChatRequestEvent({ uid: 'u1', conversationId: 'c1', requestId: 'r1', now: NOW })
  // Go 侧明确记录「勿用最小 3 字段，防上游后续加严」
  const required = [
    'eventCode', 'timestamp', 'reportDelay', 'mode', 'conversationId', 'requestId',
    'inputLength', 'requestModelId', 'requestModelName', 'isPlan', 'isAutoExecuteTerminal',
    'isAutoModify', 'codebaseEnable', 'maxToken', 'maxSteps', 'temperature', 'maxRetries',
    'mentionContexts', 'knowledgeId', 'knowledgeName', 'codebaseId', 'mentionContextCount',
    'command', 'expertId', 'recommendId', 'skillId', 'skillCount', 'totalCount', 'fileUri',
    'presentAt', 'traceId', 'rootRequestId', 'parentConversationId', 'agentName', 'agentType', 'userId',
  ]
  for (const key of required) {
    assert.ok(key in ev, `缺少字段 ${key}`)
  }
})

test('CLI 事件：模型 id 缺省时回落 deepseek-v4-flash，requestId 缺省回落 conversationId', () => {
  const ev = cliChatRequestEvent({ uid: 'u1', conversationId: 'c1', requestId: '', now: NOW })
  assert.equal(ev.requestModelId, 'deepseek-v4-flash')
  assert.equal(ev.requestModelName, 'deepseek-v4-flash')
  assert.equal(ev.requestId, 'c1')
  assert.equal(ev.rootRequestId, 'c1')
})

test('桌面事件链：必须是 6 个事件，且顺序固定', () => {
  const chain = desktopChatSequence({
    conversationId: 'c1',
    requestId: 'r1',
    messageId: 'm1',
    modelId: 'glm-5.2',
    modelName: 'GLM-5.2',
    now: NOW,
  })
  assert.equal(chain.length, 6)
  assert.deepEqual(
    chain.map((e) => e.eventCode),
    [
      'agent_task_created',
      'chat_message_send',
      'chat_request_send',
      'chat_message_response',
      'chat_message_status',
      'chat_request_response',
    ],
  )
})

test('⚠️ 桌面事件链：chat_message_response.isSuccessful 必须是 true（判据核心）', () => {
  const chain = desktopChatSequence({
    conversationId: 'c1', requestId: 'r1', messageId: 'm1',
    modelId: 'glm-5.2', modelName: 'GLM-5.2', now: NOW,
  })
  const response = chain.find((e) => e.eventCode === 'chat_message_response')
  assert.notEqual(response, undefined)
  assert.equal(response?.isSuccessful, true, 'isSuccessful=false 会点不亮')
})

test('桌面事件链：三键贯穿（服务端靠它 join）', () => {
  const chain = desktopChatSequence({
    conversationId: 'conv-x', requestId: 'req-y', messageId: 'msg-z',
    modelId: 'm', modelName: 'M', now: NOW,
  })

  // ⚠️ 注意字段名差异（逐字对齐 Go 侧 desktop.go）：
  // `chat_request_send` 用的是 **parentConversationId**，**没有** conversationId；
  // 而 `chat_message_response` 两个都有。
  // 写错字段名不会报错，只会让服务端 join 不上 —— 故这里显式钉住。
  const send = chain.find((e) => e.eventCode === 'chat_request_send')
  assert.equal(send?.parentConversationId, 'conv-x')
  assert.equal(send?.conversationId, undefined, 'chat_request_send 不该有 conversationId')
  assert.equal(send?.rootRequestId, 'req-y')
  assert.equal(send?.['codebuddy.session_id'], 'conv-x')
  assert.equal(send?.['codebuddy.conversation_request_id'], 'req-y')

  const created = chain.find((e) => e.eventCode === 'agent_task_created')
  assert.equal(created?.messageId, 'msg-z')
  assert.equal(created?.conversationId, 'conv-x')

  // chat_message_response 两个会话字段都在
  const response = chain.find((e) => e.eventCode === 'chat_message_response')
  assert.equal(response?.conversationId, 'conv-x')
  assert.equal(response?.parentConversationId, 'conv-x')
})

test('桌面指纹：ideName/ideType/extName 是判别字段', () => {
  const fp = desktopFingerprint({ uid: 'u1', nickname: 'n', machineId: 'm36', sessionId: 's36', now: NOW })
  assert.equal(fp.ideName, 'WorkBuddy')
  assert.equal(fp.ideType, 'WorkBuddy')
  assert.equal(fp.extName, 'workbuddy-desktop')
  assert.equal(fp.machineId, 'm36')
  assert.equal(fp.userId, 'u1')
  assert.equal(fp.product, 'SaaS')
})

test('⚠️ mp 指纹：ideType / platform / source 是判别字段', () => {
  const fp = mpFingerprint({ uid: 'u1', nickname: 'n', now: NOW, machineId: 'hardcoded-36' })
  assert.equal(fp.ideType, 'WorkBuddy_MP')
  assert.equal(fp.platform, 'mini_program')
  assert.equal(fp.source, 'mini_program')
  assert.equal(fp.extName, 'workbuddy-mp')
})

test('web 事件：pageURL / elementId 是判别字段', () => {
  const ev = webElementClickEvent({
    uid: 'u1',
    machineId: 'm36',
    pageUrl: 'https://www.workbuddy.cn/library',
    elementId: 'library_doc_intro_click',
    now: NOW,
  })
  assert.equal(ev.eventCode, 'web_element_click')
  assert.equal(ev.elementId, 'library_doc_intro_click')
  assert.equal(ev.pageURL, 'https://www.workbuddy.cn/library')
})

test('web 指纹：machineId 与 userId 存在', () => {
  const fp = webFingerprint({ uid: 'u1', machineId: 'webm36', now: NOW })
  assert.equal(fp.machineId, 'webm36')
  assert.equal(fp.userId, 'u1')
})

test('Buddy 应用链：5 个事件，mode=LOCAL', () => {
  const chain = desktopBuddyAppSequence({ conversationId: 'c1', buddyId: 'b1', now: NOW })
  assert.equal(chain.length, 5)
  for (const ev of chain) {
    assert.equal(ev.mode, 'LOCAL')
    assert.equal(ev.buddyId, 'b1')
  }
})

test('模板使用：每组 2 事件，含 template_used 判据', () => {
  const evs = desktopTemplateUseEvents({ conversationId: 'c1', templateId: 't1', now: NOW })
  assert.equal(evs.length, 2)
  assert.deepEqual(evs.map((e) => e.eventCode), ['agent_task_created_with_template', 'template_used'])
})

test('灵感案例：判据是 playbook_prompt_send（不是曝光/点击）', () => {
  const evs = desktopPlaybookEvents({ conversationId: 'c1', pageUrl: 'https://x', now: NOW })
  const codes = evs.map((e) => e.eventCode)
  assert.ok(codes.includes('playbook_prompt_send'), '缺 playbook_prompt_send 点不亮')
  assert.ok(codes.includes('playbook_cta_click'))
})

test('设计画布：2 事件，含 wbx_design_canvas_*', () => {
  const evs = desktopDesignCanvasEvents({ conversationId: 'c1', now: NOW })
  assert.deepEqual(evs.map((e) => e.eventCode), ['wbx_design_canvas_task_create', 'wbx_design_canvas_open'])
})

test('定时任务：单事件 automated_task_create_suc', () => {
  const ev = desktopAutomationCreatedEvent({ conversationId: 'c1', now: NOW })
  assert.equal(ev.eventCode, 'automated_task_create_suc')
})

test('外观：事件码 + 固定主题 resourceKey', () => {
  const ev = desktopAppearanceSkinApplyEvent({ uid: 'u1', machineId: 'm', sessionId: 's', now: NOW })
  assert.equal(ev.eventCode, 'appearance_skin_apply')
  assert.equal(ev.resourceKey, 'theme-tkmw7j')
})

test('newIds：三个 id 互不相同且非空', () => {
  const ids = newIds()
  assert.notEqual(ids.conversationId, '')
  assert.notEqual(ids.requestId, '')
  assert.notEqual(ids.messageId, '')
  assert.notEqual(ids.conversationId, ids.requestId)
  assert.notEqual(ids.requestId, ids.messageId)
  // requestId / messageId 是 32 位 hex（无连字符）
  assert.match(ids.requestId, /^[0-9a-f]{32}$/)
  assert.match(ids.messageId, /^[0-9a-f]{32}$/)
})
