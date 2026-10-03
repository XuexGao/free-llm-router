/**
 * IP 级 WAF 护栏与真实对话动作的单测。
 *
 * ## 为什么这些断言重要
 *
 * **IP 级护栏**的判据很微妙：它必须区分「同一账号反复失败」（账号问题，交给冷却）
 * 与「短窗内多个不同账号接连失败」（IP 问题，必须 fail-fast）。
 * 判错任一方向都有代价：
 * - 该 fail-fast 却继续轮转 → 把一次请求放大成 N 次撞墙，**加重风控**；
 * - 不该 fail-fast 却停了 → 一个号的偶发问题导致**整个服务暂停**。
 *
 * **真实对话动作**的判据是服务端校验的：
 * - 专家 id 必须真实存在（编造不计数）；
 * - `requestId` 必须是服务端签发的（自造 UUID 不计数）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractServerRequestId, inNightWindow, parseExperts } from '../src/upstream/realtime.ts'
import {
  desktopExpertActualUseEvent,
  desktopExpertSummonEvents,
  desktopChatSequence,
  desktopFingerprint,
  skillInfoEvent,
} from '../src/upstream/events.ts'
import { NEEDS_REAL_CHAT, registeredActions } from '../src/taskrunner/actions.ts'
import { planByName, planGrowth, REAL_CHAT_ACTIONS } from '../src/taskrunner/plans.ts'

// ─────────────────── 服务端 requestId 抓取（真实对话的核心） ───────────────────

test('⚠️ 能从 SSE 文本里抓到服务端签发的 requestId', () => {
  const sse = 'data: {"id":"cmb-0123456789abcdef0123456789abcdef","choices":[]}\n\n'
  const found = extractServerRequestId(sse)
  assert.notEqual(found, undefined)
  assert.equal(found?.id, 'cmb-0123456789abcdef0123456789abcdef')
})

test('也接受裸 32 位 hex', () => {
  const sse = 'data: {"id":"0123456789abcdef0123456789abcdef"}\n'
  assert.equal(extractServerRequestId(sse)?.id, '0123456789abcdef0123456789abcdef')
})

test('⚠️ 跳过形状不合法的 id（SSE 里还有消息 id 等别的 id）', () => {
  // 先出现一个不合法的 id，再出现合法的 —— 必须取后者
  const sse = 'data: {"id":"not-a-real-id","x":1}\ndata: {"id":"cmb-abcdef0123456789abcdef0123456789"}\n'
  const found = extractServerRequestId(sse)
  assert.equal(found?.id, 'cmb-abcdef0123456789abcdef0123456789')
})

test('⚠️ 不合法的 id 不会导致死循环（Go 侧踩过的坑）', () => {
  // 全是非法 id：必须正常返回 undefined 而不是卡住
  const sse = 'data: {"id":"nope"}\n'.repeat(100)
  assert.equal(extractServerRequestId(sse), undefined)
})

test('没有 id 字段时返回 undefined', () => {
  assert.equal(extractServerRequestId('data: {"choices":[]}\n'), undefined)
  assert.equal(extractServerRequestId(''), undefined)
})

test('searchFrom 能推进（供分块读取时继续搜索）', () => {
  const sse = 'data: {"id":"nope"}\ndata: {"id":"cmb-abcdef0123456789abcdef0123456789"}\n'
  const first = extractServerRequestId(sse)
  assert.notEqual(first, undefined, '应从第二个 id 找到')
  // 从返回位置继续搜，不该再找到同一个
  assert.equal(extractServerRequestId(sse, first!.nextFrom + 1), undefined)
})

// ─────────────────── 专家列表解析 ───────────────────

test('⚠️ parseExperts：丢弃没有 expert_id 的条目（id 是判据锚点）', () => {
  const experts = parseExperts({
    experts: [
      { expert_id: 'ex_real1', expert_type: 'agent', display_name_zh: '真专家' },
      { display_name_zh: '没有 id 的脏数据' },
      { expert_id: '', display_name_zh: '空 id' },
    ],
  })
  assert.equal(experts.length, 1, '只有带真实 expert_id 的条目应保留')
  assert.equal(experts[0]?.expertId, 'ex_real1')
})

test('parseExperts：畸形输入返回空数组', () => {
  assert.deepEqual(parseExperts(null), [])
  assert.deepEqual(parseExperts({}), [])
  assert.deepEqual(parseExperts({ experts: 'not-array' }), [])
  assert.deepEqual(parseExperts({ experts: [null] }), [])
})

test('parseExperts：字段缺失时给出安全默认值', () => {
  const e = parseExperts({ experts: [{ expert_id: 'x' }] })[0]
  assert.equal(e?.expertType, 'agent', '缺 expert_type 默认 agent')
  assert.equal(e?.displayNameZh, '')
  assert.deepEqual(e?.categories, [])
})

// ─────────────────── 专家事件形状 ───────────────────

const EXPERT = {
  expertId: 'ex_2cvvUZQhDyeJ',
  expertType: 'agent',
  displayNameZh: '腾讯轻量云专家',
  professionZh: '腾讯轻量云专家',
  version: '1.0.2',
  categories: [] as unknown[],
}

test('召唤链：3 事件，判据字段齐全', () => {
  const events = desktopExpertSummonEvents(EXPERT)
  assert.deepEqual(
    events.map((e) => e.eventCode),
    ['web_element_click', 'expert_summon_click', 'expert_summoned'],
  )
  // asar 内部路径必须逐字对齐（服务端按它识别来自客户端的召唤）
  assert.equal(events[0]?.elementId, 'expert_summon_click')
  assert.ok(String(events[0]?.pageURL).includes('app.asar'))
  assert.equal(events[1]?.id, 'ex_2cvvUZQhDyeJ')
  assert.equal(events[1]?.mode, 'LOCAL')
})

test('⚠️ expert_actual_use：requestId 原样使用（不能改写，否则不计数）', () => {
  const ev = desktopExpertActualUseEvent(EXPERT, 'conv-1', 'cmb-abcdef0123456789abcdef0123456789')
  assert.equal(ev.eventCode, 'expert_actual_use')
  assert.equal(ev.requestId, 'cmb-abcdef0123456789abcdef0123456789')
  assert.equal(ev.conversationId, 'conv-1')
  // messageId 由 requestId 尾 8 位派生（Go 侧同口径）
  assert.equal(ev.messageId, 'msg-23456789')
  assert.equal(ev.source, 'builtin')
})

test('skill_info：带上真实对话的 id', () => {
  const ev = skillInfoEvent({
    conversationId: 'conv-2',
    requestId: 'cmb-0123456789abcdef0123456789abcdef',
    now: 1_700_000_000_000,
  })
  assert.equal(ev.eventCode, 'skill_info')
  assert.equal(ev.conversationId, 'conv-2')
  assert.equal(ev.requestId, 'cmb-0123456789abcdef0123456789abcdef')
  assert.equal(ev.toolStatus, 'success')
})

test('⚠️ skill_1 需要 finishReason=tool_calls（与普通对话任务的关键差异）', () => {
  const normal = desktopChatSequence({
    conversationId: 'c', requestId: 'r', messageId: 'm',
    modelId: 'x', modelName: 'X', now: 1,
  })
  const skill = desktopChatSequence({
    conversationId: 'c', requestId: 'r', messageId: 'm',
    modelId: 'x', modelName: 'X', now: 1, finishReason: 'tool_calls',
  })
  const pick = (events: ReturnType<typeof desktopChatSequence>) =>
    events.find((e) => e.eventCode === 'chat_message_response')?.finishReason
  assert.equal(pick(normal), 'stop', '默认是 stop')
  assert.equal(pick(skill), 'tool_calls', 'skill_1 必须是 tool_calls')
  // 两个 finishReason 字段都要改（Go 侧对两个事件都改）
  const reqResp = skill.find((e) => e.eventCode === 'chat_request_response')?.finishReason
  assert.equal(reqResp, 'tool_calls')
})

// ─────────────────── 计划：真实对话默认不入队 ───────────────────

test('⚠️ 默认 growth 计划绝不含真实对话任务（否则会无感知消耗配额）', () => {
  const steps = planGrowth()
  for (const step of steps) {
    assert.equal(NEEDS_REAL_CHAT.has(step.code), false, `默认计划不该含 ${step.code}`)
  }
})

test('⚠️ daily 计划永远不含真实对话任务（它挂在 cron 上）', () => {
  for (const step of planByName('daily')) {
    assert.equal(NEEDS_REAL_CHAT.has(step.code), false, `daily 不该含 ${step.code}`)
  }
  // 即便显式传参也不该生效
  for (const step of planByName('daily', { includeRealChat: true })) {
    assert.equal(NEEDS_REAL_CHAT.has(step.code), false, 'daily 不受 includeRealChat 影响')
  }
})

test('includeRealChat=true 时真实对话任务才入队', () => {
  const steps = planGrowth({ includeRealChat: true })
  const codes = steps.map((s) => s.code)
  for (const { code } of REAL_CHAT_ACTIONS) {
    assert.ok(codes.includes(code), `开启后应含 ${code}`)
  }
})

test('⚠️ 真实对话任务的步间间隔不短于普通任务（它们前面刚发过真实 chat）', () => {
  const steps = planGrowth({ includeRealChat: true })
  for (const { code } of REAL_CHAT_ACTIONS) {
    // 找到该任务后的 verifyAndClaim 步骤，看它的 delayMs
    const idx = steps.findIndex((s) => s.code === code && s.action !== 'verifyAndClaim')
    assert.ok(idx >= 0, `应找到 ${code} 的动作步骤`)
    const verify = steps[idx + 1]
    assert.equal(verify?.action, 'verifyAndClaim', `${code} 后应跟回读领奖`)
    assert.ok((verify?.delayMs ?? 0) >= 3000, `${code} 的回读间隔应 ≥3s（上游异步计分 5–8s）`)
  }
})

test('⚠️ 计划里引用的真实对话动作都必须已注册', () => {
  const registered = new Set(registeredActions())
  for (const { action } of REAL_CHAT_ACTIONS) {
    assert.ok(registered.has(action), `未注册的动作：${action}`)
  }
})

test('真实对话动作表与零消耗动作表无交集', () => {
  const zero = new Set(planGrowth().map((s) => s.code))
  for (const { code } of REAL_CHAT_ACTIONS) {
    assert.equal(zero.has(code), false, `${code} 不该同时出现在两个表里`)
  }
})

test('⚠️ 真实对话任务都在 NEEDS_REAL_CHAT 集合里（保证默认被排除）', () => {
  for (const { code } of REAL_CHAT_ACTIONS) {
    assert.ok(NEEDS_REAL_CHAT.has(code), `${code} 应在 NEEDS_REAL_CHAT 里，否则会被默认计划带上`)
  }
})

test('⚠️ 真实对话计划的步数比零消耗计划多（多出的正是真实对话任务）', () => {
  const zero = planGrowth().length
  const full = planGrowth({ includeRealChat: true }).length
  assert.equal(full - zero, REAL_CHAT_ACTIONS.length * 2, '每个真实对话任务贡献 2 步')
})

// ─────────────────── 夜猫子窗口（窗口外跑会白花配额） ───────────────────

test('⚠️ inNightWindow：23:00–08:00（UTC+8）才算窗口内', () => {
  const at = (utcHour: number, utcMin = 0) =>
    Date.UTC(2026, 9, 3, utcHour, utcMin, 0)
  // UTC+8：UTC 15:00 = CST 23:00（窗口开始）
  assert.equal(inNightWindow(at(15)), true, 'CST 23:00 应在窗口内')
  assert.equal(inNightWindow(at(16)), true, 'CST 次日 00:00 应在窗口内')
  assert.equal(inNightWindow(at(23, 59)), true, 'CST 07:59 应在窗口内')
  // CST 08:00 出窗口
  assert.equal(inNightWindow(at(0)), false, 'CST 08:00 应出窗口')
  assert.equal(inNightWindow(at(4)), false, 'CST 12:00 不该在窗口内')
  assert.equal(inNightWindow(at(14, 59)), false, 'CST 22:59 还没进窗口')
})

test('⚠️ 窗口边界精确：CST 08:00 整出窗口，22:59 还在窗口外', () => {
  // UTC 00:00 = CST 08:00 → 出
  assert.equal(inNightWindow(Date.UTC(2026, 9, 3, 0, 0)), false)
  // UTC 14:59 = CST 22:59 → 还没进
  assert.equal(inNightWindow(Date.UTC(2026, 9, 3, 14, 59)), false)
  // UTC 15:00 = CST 23:00 → 进
  assert.equal(inNightWindow(Date.UTC(2026, 9, 3, 15, 0)), true)
})

test('⚠️ 桌面事件必须带 reportDelay 与 timestamp（缺了上游报 10001）', () => {
  // 这是线上实测踩到的：专家/技能链上报时漏了公共指纹，
  // 上游返回 `code=10001 event missing both reportDelay and timestamp fields`
  const fp = desktopFingerprint({
    uid: 'u1', nickname: 'n', machineId: 'm', sessionId: 's', now: 1_700_000_000_000,
  })
  assert.equal(typeof fp.reportDelay, 'number', 'reportDelay 必须是数字')
  assert.equal(typeof fp.timestamp, 'number', 'timestamp 必须是数字')

  // 注入后的事件同时具备业务字段与指纹字段
  const summon = desktopExpertSummonEvents({
    expertId: 'ex_1', expertType: 'agent', displayNameZh: 'X',
    professionZh: 'Y', version: '1.0.0', categories: [],
  })
  const merged = summon.map((ev) => ({ ...fp, ...ev }))
  for (const ev of merged) {
    assert.ok('reportDelay' in ev, '每条事件都要有 reportDelay')
    assert.ok('timestamp' in ev, '每条事件都要有 timestamp')
    assert.ok('eventCode' in ev, '业务字段不能被指纹覆盖')
  }
})
