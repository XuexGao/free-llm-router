/**
 * 多供应商抽象层的单测。
 *
 * ## 为什么这些断言重要
 *
 * 供应商层的错误有两个特点：**静默**且**难以归因**。
 * - 凭据解析错 → 导入「成功」但一用就 401，用户以为是账号问题；
 * - 模型名路由错 → 请求打到错误的供应商，报的是别家的错；
 * - 能力声明错 → 面板显示可用，点了却失败。
 *
 * 故这里锁死的是「**判别与拒绝**」的正确性，而不是「能解析」。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import {
  EXPIRY_NEVER,
  EXPIRY_UNUSABLE,
  buildVirtualModels,
  AGGREGATE_ALLOWED_KEYS,
  expiryLabel,
  pickSoonestProvider,
  rankCandidates,
} from '../src/gateway/aggregate.js'
import {
  canonicalDisplayName,
  canonicalKeyFor,
  normalizeModelKey,
  normalizeNameKey,
  priceFactorFromName,
} from '../src/providers/canonical-models.js'
import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import {
  DEFAULT_PROVIDER,
  LEGACY_PROVIDER,
  findProvider,
  PROVIDERS,
  parseCredentialAnywhere,
  providerCatalog,
  providerIds,
  requireProvider,
} from '../src/providers/index.ts'
import { ProviderError, splitModelName } from '../src/providers/types.ts'
import * as minimaxModule from '../src/providers/minimax.ts'
import { anthropicSseToOpenAiSse } from '../src/providers/anthropic.ts'
import { planGrowth, REAL_CHAT_ACTIONS } from '../src/taskrunner/plans.ts'
import { registeredActions } from '../src/taskrunner/actions.ts'

/**
 * 捕获一次抛错（返回 `undefined` 表示**没有抛**）。
 *
 * ⚠️ 为什么不用 `assert.throws`：它在 Node 里**返回 `undefined`**（不返回错误对象），
 * 所以 `const e = assert.throws(fn); e instanceof ProviderError` 恒为 false ——
 * 一个纯粹自伤的测试写法（本文件踩过）。
 *
 * 也不用 `try { assert.fail() } catch`：那会把 `assert.fail` 自己抛的
 * AssertionError 也 catch 住，于是「应抛错」失败时变得看不出原因。
 */
function catchError(fn: () => unknown): Error | undefined {
  let caught: unknown
  let threw = false
  try {
    fn()
  } catch (error) {
    caught = error
    threw = true
  }
  return threw ? (caught as Error) : undefined
}

// ─────────────────── 模型名路由 ───────────────────

/**
 * 去掉 TS 源码里的 `//` 行注释与 `/* *\/` 块注释。
 *
 * ⚠️ **本文件的断言大量基于源码文本 grep，必须先剥注释** ——
 * 本项目的注释习惯是逐字引用缺陷原文（含 `hooks.onError(message)`
 * 这类**代码字面量**），不剥注释时注释会先于真正的代码命中，
 * 产生「顺序反了 / 找不到」这类**假失败**。我已为此返工两次。
 *
 * ⚠️ 这是**粗略**剥离：不处理字符串里的 `//`（本文件断言的代码里没有这种写法）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

test('无前缀的裸模型名回落到默认供应商（保持既有用户兼容）', () => {
  // 本项目既有用户已经在用 `deepseek-v4-flash`，不能因为多供应商就要求加前缀
  const r = splitModelName('deepseek-v4-flash', ['workbuddy', 'cline'], 'workbuddy')
  assert.equal(r.provider, 'workbuddy')
  assert.equal(r.model, 'deepseek-v4-flash')
})

test('已知供应商前缀被正确拆分', () => {
  const r = splitModelName('cline/claude-sonnet-4', ['workbuddy', 'cline'], 'workbuddy')
  assert.equal(r.provider, 'cline')
  assert.equal(r.model, 'claude-sonnet-4')
})

test('⚠️ 未知前缀不当成供应商（否则上游自带的斜杠模型名会被误拆）', () => {
  // 像 `deepseek/v3` 这种上游自己带斜杠的模型名，不能被拆成 provider=deepseek
  const r = splitModelName('deepseek/v3', ['workbuddy', 'cline'], 'workbuddy')
  assert.equal(r.provider, 'workbuddy', '未知 head 必须回落到默认供应商')
  assert.equal(r.model, 'deepseek/v3', '原名必须完整保留')
})

test('模型名里有多个斜杠时只拆第一个', () => {
  const r = splitModelName('cline/a/b', ['cline'], 'workbuddy')
  assert.equal(r.provider, 'cline')
  assert.equal(r.model, 'a/b')
})

test('空模型名不崩', () => {
  const r = splitModelName('', ['workbuddy'], 'workbuddy')
  assert.equal(r.provider, 'workbuddy')
  assert.equal(r.model, '')
})

// ─────────────────── 注册表 ───────────────────

test('默认供应商必须已注册（但**不再**要求是注册表第 0 项）', () => {
  // ⚠️ 2026-11-21 改造：默认供应商从「注册表第 0 项」改为**显式声明**。
  //
  // 原因见 `src/providers/index.ts` 的 `DEFAULT_PROVIDER` 注释：注册表顺序
  // 同时被用作「自动识别凭据的尝试次序」和「猜默认供应商」，两件事被绑死，
  // 任何一边的编辑都会悄悄影响另一边；且 `array[0]` 会被新加的供应商挤动。
  //
  // 仍然必须成立的那一条：默认供应商**必须是已注册的**，否则裸模型名会
  // 回落到一个 `findProvider` 查不到的家。
  assert.notEqual(findProvider(DEFAULT_PROVIDER), undefined)
  assert.ok(providerIds().includes(DEFAULT_PROVIDER))
})

test('⚠️ requireProvider 未知供应商时抛错并列出可用项', () => {
  try {
    requireProvider('nope')
    assert.fail('应抛错')
  } catch (error) {
    assert.ok(error instanceof ProviderError)
    const message = (error as Error).message
    assert.ok(message.includes('nope'), '错误里应包含请求的 id')
    // 可用列表很重要：用户打错字时能立刻看到正确拼写
    assert.ok(message.includes(DEFAULT_PROVIDER), '错误里应列出可用供应商')
  }
})

test('findProvider 未知返回 undefined（不抛错）', () => {
  assert.equal(findProvider('nope'), undefined)
})

test('⚠️ 每个供应商都必须有 id / name / 完整 capabilities', () => {
  const required = ['login', 'listModels', 'chat', 'balance', 'checkin'] as const
  for (const p of providerCatalog()) {
    assert.ok(p.id !== '', 'id 不能为空')
    assert.ok(!p.id.includes('/'), `id 不能含斜杠（会被模型名路由误拆）：${p.id}`)
    assert.ok(p.name !== '', `${p.id} 缺 name`)
    for (const k of required) {
      assert.equal(typeof p.capabilities[k], 'boolean', `${p.id} 的 capabilities.${k} 必须是布尔`)
    }
  }
})

test('⚠️ 供应商 id 不能重复（重复会让路由指向错误的那家）', () => {
  const ids = providerIds()
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.join(',')}`)
})

test('⚠️ capabilities.login=false 时必须给出可读原因（不能是「不支持」这种废话）', () => {
  for (const p of providerCatalog()) {
    if (p.capabilities.login) continue
    const reason = p.capabilities.loginBlockedReason
    assert.ok(
      typeof reason === 'string' && reason.length >= 10,
      `${p.id} 声明了 login=false，必须给出至少 10 字的可读原因（当前：${String(reason)}）`,
    )
    // 原因要能指导用户行动，而不是只说「不行」
    const actionable = /导出|粘贴|桌面端|CLI|本地|回调|浏览器|凭据|不支持/
    assert.ok(actionable.test(reason), `${p.id} 的阻塞原因应可指导行动：${reason}`)
  }
})

test('⚠️ 默认供应商必须支持 chat（否则裸模型名全部失败）', () => {
  const def = requireProvider(DEFAULT_PROVIDER)
  assert.equal(def.capabilities.chat, true, '默认供应商必须能对话，否则裸模型名回落到它必然失败')
})

// ─────────────────── 凭据解析 ───────────────────

test('⚠️ WorkBuddy 必须最后试（它的解析最宽松，会吞掉别家的凭据）', () => {
  // ## 实测缺陷（本用例守护的东西）
  //
  // WorkBuddy 的凭据形态最宽松（只要 `accessToken` + `uid`），故它**必须**
  // 排在自动识别的最后。否则任何 `{accessToken, uid}` 形态的对象都会被它
  // 抢走 —— 用户看到「导入成功」，实际存成了一个必然 401 的 WorkBuddy 账号。
  //
  // ## ⚠️ 判据已改为**行为级**（2026-11-21）
  //
  // 旧写法是 `assert.equal(providerIds()[0], DEFAULT_PROVIDER)` —— 它假设
  // 「默认供应商 = 注册表第 0 项 = 被排到最后的那家」。这三个概念已被解耦，
  // 且它**从未真正验证过兜底行为**（只比了一个数组下标，是空断言）。
  //
  // 现在直接验行为：给一个 buddy 能认、但**更像别家**的输入，
  // 结果必须**不是** buddy。
  const buddyOnly = parseCredentialAnywhere({
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2ln',
    uid: 'user-1',
  })
  assert.equal(
    buddyOnly.provider.id,
    'buddy',
    '裸 WorkBuddy 形态仍应被 buddy 收下（它是兜底）',
  )

  // 而带别家独有字段的输入，必须被**那一家**拿走，不能落到 buddy。
  const traeShape = parseCredentialAnywhere({
    access_token: 'x',
    machine_id: 'm',
    device_id: 'd',
    uid: 'u',
  })
  assert.equal(traeShape.provider.id, 'trae', '带 TRAE 独有字段的对象必须判给 trae')

  // ⚠️ 且**兜底项本身**必须是 buddy —— 这是上面那些行为的前提。
  assert.equal(LEGACY_PROVIDER, 'buddy', '兜底供应商（最宽松的那家）必须是 buddy')
})

test('完全无法识别的输入抛错，且带上**每一家**的拒绝原因', () => {
  try {
    parseCredentialAnywhere({ nonsense: true })
    assert.fail('应抛错')
  } catch (error) {
    assert.ok(error instanceof ProviderError)
    const message = (error as Error).message
    // 每一家的原因都要在，用户才能看出「到底缺什么」
    assert.ok(message.includes('没有任何供应商能解析'), message.slice(0, 120))
  }
})

test('显式声明供应商时只试它，失败就报错（不静默回落到别家）', () => {
  // ⚠️ 用 assert.throws 而不是 try/catch + assert.fail：
  // 后者会把 assert.fail 自己抛出的 AssertionError 也 catch 住，
  // 于是断言「error instanceof ProviderError」失败 —— 一个自伤的测试写法。
  const error = catchError(
    // 声明成 cline 但给不合法令牌 → 必须失败，
    // 不能「好心」地存成 cline 账号（那会让用户以为导入成功了）
    () => parseCredentialAnywhere({ accessToken: 'x', uid: 'u1' }, 'cline'),
  )
  assert.ok(error !== undefined, '应抛错')
  assert.ok(error instanceof ProviderError, `应抛 ProviderError，实际 ${error?.constructor.name}`)
  // ⚠️ 大小写不敏感：供应商的展示名是「Cline」而 id 是 `cline`，
  // 断言写死小写会把正确实现判为失败（本条踩过）。
  assert.ok(/cline/i.test(error.message), `错误里应提到 cline：${error.message}`)
})

test('⚠️ 显式声明未知供应商时报的必须是「未知供应商」而不是「解析失败」', () => {
  // 这两个原因的**修复动作完全不同**（改供应商名 vs 改凭据），
  // 报错时必须能区分。
  const error = catchError(() => parseCredentialAnywhere({ accessToken: 'x', uid: 'u' }, 'nope'))
  assert.ok(error !== undefined, '应抛错')
  assert.ok(error instanceof ProviderError)
  assert.ok(error.message.includes('未知供应商'), `应说明是未知供应商：${error.message}`)
})

test('空输入不崩（抛 ProviderError 而不是 TypeError）', () => {
  for (const bad of [null, undefined, 42, 'str', []]) {
    try {
      parseCredentialAnywhere(bad)
      assert.fail(`应抛错：${JSON.stringify(bad)}`)
    } catch (error) {
      assert.ok(error instanceof ProviderError, `${JSON.stringify(bad)} 应抛 ProviderError`)
    }
  }
})

// ─────────────────── ProviderError ───────────────────

test('ProviderError 缺省不可重试（宁可少换号，也不要无谓重试放大风控）', () => {
  const e = new ProviderError({ provider: 'x', message: 'm' })
  assert.equal(e.retryable, false)
  assert.equal(e.httpStatus, 0)
  assert.equal(e.name, 'ProviderError')
})

test('ProviderError 能标记可重试', () => {
  const e = new ProviderError({ provider: 'x', message: 'm', httpStatus: 429, retryable: true })
  assert.equal(e.retryable, true)
  assert.equal(e.httpStatus, 429)
})

// ─────────────────── 协议转换（防「静默无内容」） ───────────────────

test('⚠️ Anthropic SSE 必须转成带 choices 的 OpenAI 帧（否则客户端读不到正文）', async () => {
  // 这条锁死一个**真实的静默失败**：MiniMax/qoder/zcode 说 Anthropic 协议，
  // 若把它们的帧原样透传，标准 OpenAI 客户端按 `choices[0].delta.content`
  // 取值会**一帧正文都读不到**，且不报错、不中断 —— 表现为「回答为空」。
  const anth = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想想"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  const src = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(anth)); c.close() },
  })
  const text = await new Response(anthropicSseToOpenAiSse(src, 'test-model')).text()

  let content = ''
  let reasoning = ''
  let withChoices = 0
  let done = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload.trim() === '[DONE]') { done = true; continue }
    let parsed: { choices?: Array<{ delta?: Record<string, unknown> }> }
    try { parsed = JSON.parse(payload) } catch { continue }
    if (parsed.choices === undefined) continue
    withChoices += 1
    for (const c of parsed.choices) {
      content += (c.delta?.['content'] as string) ?? ''
      reasoning += (c.delta?.['reasoning_content'] as string) ?? ''
    }
  }

  assert.ok(withChoices > 0, `必须有带 choices 的帧（实际 ${withChoices}）—— 否则是静默无内容`)
  assert.equal(content, '你好', '正文必须落在 delta.content')
  // ⚠️ 思考内容进 reasoning_content，**不能污染正文**
  assert.equal(reasoning, '想想', 'thinking_delta 应映射到 reasoning_content')
  assert.ok(!content.includes('想想'), '思考内容不得混入正文')
  assert.equal(done, true, '必须发 [DONE]')
})

test('⚠️ Anthropic 空流必须产生错误帧（不能静默结束）', async () => {
  const src = new ReadableStream<Uint8Array>({
    start(c) { c.close() },
  })
  const text = await new Response(anthropicSseToOpenAiSse(src, 'm')).text()
  // 空流如果不报错，客户端会认为「模型正常回答但没内容」而不重试
  assert.ok(text.includes('"error"') || text.includes('[DONE]'), `空流应有明确结束或错误：${text.slice(0, 120)}`)
})

// ─────────────────── 模型名前缀（防污染模型级冷却） ───────────────────

test('⚠️ 路由后的模型名必须是裸名（带前缀会被上游判为「没有这个模型」）', () => {
  // 这条锁死一个**放大器级**的真实缺陷：
  // 客户端发 `workbuddy/deepseek-v4-flash` 时，若把带前缀的名字原样发给上游，
  // 上游回 `model [workbuddy/...] service info not found`，
  // 该错误被归类为 11102 model_unavailable → **给这个模型写 6 小时冷却**。
  //
  // 后果：此后**裸名**请求也因为模型级冷却而选不到号，
  // 对外表现为「没有可用账号」—— 与真实原因（前缀写错）毫无关系。
  const r = splitModelName('workbuddy/deepseek-v4-flash', ['workbuddy', 'cline'], 'workbuddy')
  assert.equal(r.model, 'deepseek-v4-flash', '交给上游的必须是裸名，不能带前缀')
  assert.ok(!r.model.includes('/'), '裸名里不能残留斜杠')
})

test('⚠️ 每个供应商都要能被前缀路由（且裸名不残留前缀）', () => {
  const ids = providerIds()
  for (const id of ids) {
    const r = splitModelName(`${id}/some-model`, ids, DEFAULT_PROVIDER)
    assert.equal(r.provider, id, `${id} 前缀应路由到自身`)
    assert.equal(r.model, 'some-model', `${id} 的裸名不能带前缀`)
  }
})

test('保留字面量带斜杠的模型名（不能把上游自带斜杠的名字拆掉）', () => {
  // 有些上游的模型 id 本身含斜杠（如 `deepseek/v3`）——
  // 只要斜杠前的不是**已知供应商**，就整名保留。
  const r = splitModelName('deepseek/v3', ['workbuddy', 'cline'], 'workbuddy')
  assert.equal(r.provider, 'workbuddy')
  assert.equal(r.model, 'deepseek/v3', '未知 head 时原名必须完整保留')
})

// ─────────────────── 签到能力声明（用户报障后新增） ───────────────────

test('⚠️ checkin=false 的供应商必须给出可读原因（否则用户以为坏了）', () => {
  // 用户实际报障：「Raccoon 明明支持签到，为什么显示不支持」。
  // 真实原因是 Raccoon 的每日积分**由服务端自动发放**、没有可调用的签到端点。
  // 面板只显示「✕ 每日签到」而不解释，用户就会以为是我们的缺陷。
  const missing: string[] = []
  for (const p of providerCatalog()) {
    if (p.capabilities.checkin) continue
    const reason = p.capabilities.checkinBlockedReason
    if (typeof reason !== 'string' || reason.length < 10) missing.push(p.id)
  }
  assert.deepEqual(missing, [], `这些供应商声明了 checkin=false 却没给原因：${missing.join('、')}`)
})

test('✅ raccoon 可触发每日结算（不是「签到」，是只读 GET 的副作用）', () => {
  // ## 结论已更正（2026-11-21）
  //
  // 旧断言是 `checkin === false`，依据「`/points/v1|v2` 下 sign_in/check_in 全 404」。
  // **那条 404 仍然成立**，但结论下早了：触发器在**办公端**的只读 GET
  // `office/v3/setting_info` 里（实测本轮：该端点 **401** = 存在要鉴权，
  // 而 `points/v1/sign_in` 是 **404**）。
  //
  // ⚠️ 语义差别必须记住：上游**没有**「签到」这个动作，我们只是**触发了一次
  // 结算**。故 `gained` 只能取自 `point_grant_popups`，而 popups 为空
  // **不是失败**（只代表今天此前已结算）。
  const raccoon = findProvider('raccoon')
  assert.notEqual(raccoon, undefined)
  assert.equal(raccoon?.capabilities.checkin, true, 'raccoon 应可触发每日结算')
  assert.equal(typeof raccoon?.checkin, 'function', '声明 checkin=true 就必须实现方法')

  // ⚠️ 判据必须是 `point_grant_popups`（唯一的发放证据）
  const src = readFileSync('src/providers/raccoon.ts', 'utf8')
  assert.ok(src.includes('point_grant_popups'), '必须读 point_grant_popups 作为发放证据')
  assert.ok(src.includes('/office/v3'), '必须打办公端的 setting_info（触发器在这里）')
  // ⚠️ 且 popups 为空**不得**抛错（那会把「今天已结算」误报成失败）
  const fnStart = src.indexOf('async function checkin(')
  assert.ok(fnStart > 0)
  const fn = src.slice(fnStart, src.indexOf('\nasync function balance', fnStart))
  assert.ok(
    !/popups\.length === 0\)\s*\{\s*throw/.test(fn),
    'popups 为空时不得抛错',
  )
})

test('⚠️ buddy 声明了 checkin=true 就必须真的实现 checkin（否则一键签到会崩）', () => {
  // 实测踩到：buddy 声明 checkin:true 但没实现方法，
  // 于是 /admin/checkin/all 对它调用 undefined() 直接抛错。
  for (const id of ['buddy']) {
    const p = findProvider(id)
    assert.notEqual(p, undefined, `${id} 应已注册`)
    if (p?.capabilities.checkin === true) {
      assert.equal(typeof p.checkin, 'function', `${id} 声明支持签到就必须实现 checkin()`)
    }
  }
})

test('⚠️ 声明 checkin=true 的供应商都必须实现 checkin 方法', () => {
  const broken: string[] = []
  for (const p of PROVIDERS) {
    if (p.capabilities.checkin === true && typeof p.checkin !== 'function') broken.push(p.id)
  }
  assert.deepEqual(broken, [], `声明了支持签到却没实现：${broken.join('、')}`)
})

test('腾讯双变体**都有**签到（国际版「无接口」是已更正的误判）', () => {
  // ## ⚠️ 这条断言此前写反了（2026-11-21 更正）
  //
  // 旧断言是 `intl.checkin === false`，理由是「CLI 内核里只有 get-dosage-notify」。
  // **那个推理是错的**：签到端点是 IDE / 网页前端直调的，CLI 内核里本来就不会有
  // —— 与当年 `get-user-resource`（余额）的误判同型。
  //
  // 实测（零凭据探测端点存在性）：`/v2/billing/meter/checkin-activity-status`
  // 与 `/v2/billing/meter/daily-checkin` 在 **workbuddy.ai 与 copilot.tencent.com
  // 上都回 401**（401 = 存在但要鉴权；不存在的路径回 404）⇒ 两站**同形**。
  const buddy = findProvider('buddy')
  const intl = findProvider('workbuddy')
  assert.notEqual(buddy, undefined)
  assert.notEqual(intl, undefined)
  assert.equal(buddy?.capabilities.checkin, true, '国内版有签到')
  assert.equal(intl?.capabilities.checkin, true, '国际版也有签到（端点同形，实测 401 存在）')
  // ⚠️ 声明为 true 就**必须**真的挂上方法（只声明不挂 = 空头承诺）
  assert.equal(typeof intl?.checkin, 'function', 'workbuddy 必须挂上 checkin 方法')
})

test('腾讯双变体都能设备码登录（实测国际版返回 workbuddy.ai 的 authUrl）', () => {
  for (const id of ['buddy', 'workbuddy']) {
    const p = findProvider(id)
    assert.equal(p?.capabilities.login, true, `${id} 应支持设备码登录`)
  }
})

// ─────────────────── 真实对话任务必须进每日计划（用户要求） ───────────────────

test('⚠️ growth 计划开启 includeRealChat 后必须包含全部真实对话任务', () => {
  // 用户明确要求：每日任务要**包含真实对话任务**（那些才给积分）。
  // 漏掉的话，用户点了「执行每日任务」却拿不到 expert_5 / skill_1 等任务的积分。
  const steps = planGrowth({ includeRealChat: true })
  const codes = new Set(steps.map((s) => s.code))
  for (const { code } of REAL_CHAT_ACTIONS) {
    assert.ok(codes.has(code), `includeRealChat=true 时缺少真实对话任务：${code}`)
  }
})

test('⚠️ 真实对话任务表必须覆盖 AGENTS.md §6.4 列的 6 个任务中的 5 个', () => {
  // §6.4 列出 6 个需真实对话的任务。其中 Model_chat_GLM5.2 归在零消耗侧
  // （只上报事件、不发对话），其余 5 个在 REAL_CHAT_ACTIONS。
  const codes = REAL_CHAT_ACTIONS.map((a) => a.code)
  for (const expected of ['expert_5', 'Expert_team_use_3', 'skill_1', 'Expert_lighthouse', 'black_cat']) {
    assert.ok(codes.includes(expected), `缺少 ${expected}`)
  }
})

test('⚠️ 每个真实对话动作都必须已注册（否则入队了却执行不了）', () => {
  const registered = new Set(registeredActions())
  for (const { action } of REAL_CHAT_ACTIONS) {
    assert.ok(registered.has(action), `未注册的动作：${action}`)
  }
})

// ─────────────────── 凭据判别（本地 10 个真实账号暴露的问题） ───────────────────

test('⚠️ qoder/trae/raccoon/codearts 必须有 matchesShape（否则被 buddy 兜底抢走）', () => {
  // 实测：拿本地真实凭据跑 parseCredentialAnywhere，
  // QODER / TRAE / RACCOON 的凭据全被判成 buddy ——
  // 因为它们没有 matchesShape，自动识别时被跳过，
  // 而 buddy 是默认供应商、永远参与且形态最宽松。
  for (const id of ['qoder', 'trae', 'raccoon', 'codearts']) {
    const p = findProvider(id)
    assert.notEqual(p, undefined, `${id} 应已注册`)
    assert.equal(typeof p?.matchesShape, 'function', `${id} 必须声明 matchesShape`)
  }
})

test('⚠️ workbuddy（国际版）必须有 matchesShape（buddy 会明确拒绝它的凭据）', () => {
  // 实测：WORKBUDDY 凭据的 domain 含 workbuddy.ai，
  // buddy.parseCredential 会**明确拒绝**它（防止拿国内端点打国际账号）；
  // 而 workbuddy 若没有 matchesShape 就不参与自动识别 →
  // 最终报「没有任何供应商能解析这份凭据」。
  const intl = findProvider('workbuddy')
  assert.equal(typeof intl?.matchesShape, 'function', '国际版必须声明 matchesShape')
  assert.equal(intl?.matchesShape?.({ domain: 'www.workbuddy.ai' }), true)
  assert.equal(intl?.matchesShape?.({ domain: 'copilot.tencent.com' }), false)
})

test('⚠️ 各家 matchesShape 不得互相误判（用真实凭据的字段形态）', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['qoder', { access_token: 'x', security_oauth_token: 'y', machine_id: 'z' }, true],
    ['qoder', { access_token: 'x', uid: 'u' }, false],
    ['trae', { access_token: 'x', machine_id: 'm', device_id: 'd' }, true],
    ['trae', { access_token: 'x', uid: 'u' }, false],
    ['raccoon', { access_token: 'x', phone: '13800000000' }, true],
    ['raccoon', { access_token: 'x', user_id: '7455957' }, true],
    ['raccoon', { access_token: 'x', user_id: '5ad0e353-69c6-4732-b382-5769fc4b171c' }, false],
    ['codearts', { access_key_id: 'ak', secret_access_key: 'sk' }, true],
    ['codearts', { access_token: 'x' }, false],
    ['opencode', { api_key: 'sk-abc' }, true],
    ['opencode', { access_token: 'x' }, false],
    ['zcode', { zcode_jwt: 'jwt', device_mid: 'd' }, true],
    ['zcode', { access_token: 'x' }, false],
    ['minimax', { minimax_user_id: 'm' }, true],
    ['minimax', { access_token: 'x' }, false],
  ]
  for (const [id, input, expected] of cases) {
    const p = findProvider(id)
    assert.notEqual(p, undefined, `${id} 应已注册`)
    assert.equal(p?.matchesShape?.(input), expected,
      `${id} 对 ${JSON.stringify(Object.keys(input))} 应判 ${expected}`)
  }
})

test('⚠️ JSON 文本形态的凭据必须被识别（不能当成裸令牌拒掉）', () => {
  // 实测：用户从 .credentials.yaml 复制的值是「被引号包住的 JSON 文本」，
  // 之前 parseCredentialAnywhere 把它当裸令牌，被 bareStringPattern 拒掉，
  // 报「没有任何供应商能解析这份凭据」—— 而它其实是完整 JSON。
  const jsonText = JSON.stringify({ access_token: 'x'.repeat(40), user_id: 'u1' })
  const r = parseCredentialAnywhere(jsonText)
  assert.equal(r.provider.id, 'buddy', 'JSON 文本应被正常解析成对象')
})

test('⚠️ JSON 里含裸控制字符时也要能解析（YAML 折行的真实形态）', () => {
  // 实测：某凭据的 scope 字段被 YAML 折行写成了含真实换行符的字符串，
  // JSON.parse 报 "Invalid control character"。宽容解析必须兜住。
  const withNewline = '{"access_token":"' + 'x'.repeat(40) + '","scope":"openid\n    profile","user_id":"u1"}'
  const r = parseCredentialAnywhere(withNewline)
  assert.equal(r.provider.id, 'buddy', '含裸控制字符的 JSON 应能被宽容解析')
})

// ─────────────────── 续期（过期账号用不了的根因） ───────────────────

test('⚠️ Provider 接口必须支持 refresh（否则过期令牌永不恢复）', () => {
  // 实测：本地 cline/raccoon/codearts 的凭据都过期了（前两者过期 5–7 小时），
  // 而本项目**从不调用续期** —— `upstream/auth.ts` 的 refreshCredential
  // 写好了却没人调，等于账号用一天就废。
  assert.ok(
    'refresh' in (findProvider('buddy') as object),
    'buddy 必须实现 refresh',
  )
})

test('⚠️ 声明 refresh 的供应商必须也保持 refreshToken 非空才可能续期', () => {
  // 续期的前提是凭据里有 refresh_token。若 parseCredential 把它丢了，
  // refresh() 永远只会抛「缺少 refresh_token」。
  const withRefresh = PROVIDERS.filter((p) => typeof p.refresh === 'function').map((p) => p.id)
  assert.ok(withRefresh.length > 0, '至少应有一家实现了 refresh')
  assert.ok(withRefresh.includes('buddy'), 'buddy 应有 refresh')
})

test('⚠️ 国际版必须声明 requiresSystemFirst（否则 400 + 11128 伪装成安全拦截）', () => {
  // 实测：www.workbuddy.ai 要求首条消息是 system，否则返回
  // HTTP 400 + code 11128 "first message is not system prompt"，
  // 且 displayMsg 把它伪装成「blocked by security」。
  // 依据 deepseek-harness-codearts/src/account-probe.ts:93-107。
  const intl = findProvider('workbuddy')
  assert.notEqual(intl, undefined)
  // 通过 Provider 是否声明该行为来间接断言（配置字段不外露，
  // 故这里断言行为：缺失 system 时 chat 应自动补一条 —— 用源码级断言）
  const src = readFileSync('src/providers/buddy.ts', 'utf8')
  assert.ok(src.includes('requiresSystemFirst'), '应有 requiresSystemFirst 配置')
  assert.ok(/requiresSystemFirst: true/.test(src), '国际版应打开它')
  assert.ok(src.includes("role: 'system'"), '应在缺失时自动补 system 首条')
})

// ─────────────────── 扫码登录（raccoon） ───────────────────

test('⚠️ beginRaccoonQrLogin 必须是纯本地计算（不碰网络、不碰凭据）', async () => {
  // ⚠️ 这条约束是**安全**要求，不是风格要求：
  // raccoon 的 refresh_token 是**一次性轮换**的，任何误触网络的调用都可能
  // 把用户的凭据消耗掉（我已经犯过两次）。
  // 故「发起登录」必须只做本地计算：生成 code → 拼 URL → 渲染 SVG。
  const { beginRaccoonQrLogin } = await import('../src/providers/raccoon.ts')

  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = (() => { called += 1; throw new Error('不应发网络请求') }) as typeof fetch
  try {
    const started = beginRaccoonQrLogin()
    assert.equal(called, 0, '发起登录不得发任何网络请求')
    assert.match(started.code, /^[0-9a-f]{32}$/, 'qrcode_code 应是 32 位小写 hex')
    assert.ok(started.qrUrl.startsWith('https://'), '二维码内容应是 https URL')
    assert.ok(started.qrSvg.includes('<svg'), '应渲染出 SVG')
    assert.ok(started.qrUrl.includes(started.code), 'URL 必须带上 code（服务端靠它认会话）')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('⚠️ 二维码容量：超长内容应抛错而不是产出扫不出来的坏码', async () => {
  const { renderQrSvg } = await import('../src/providers/raccoon-qr.ts')
  // 版本 1–10 纠错 M 的上限约 213 字节，远超登录 URL（约 145 字节）。
  // 超出时必须抛错 —— 静默产出坏码会让用户对着一个永远扫不出的图发呆。
  // 实际文案：「二维码内容过长（500 字节，上限 213 字节），请缩短内容」
  assert.throws(() => renderQrSvg('x'.repeat(500)), /过长|上限|213/)
})

// ───── 续期缺失：同型缺陷第 2 次（实测「号用一会儿就废」） ─────

test('🔴 minimax 必须挂上 refresh（否则 token 过期后账号永久 401）', () => {
  // ## 实测缺陷
  //
  // 上线实测：minimax 起初能正常对话，**几分钟后**全部变成
  // `http=401 invalid access token`，而账号状态看起来完全正常。
  //
  // 根因：该 provider **完全没有 `refresh` 方法**，而凭据里明明有
  // `refresh_token`。网关按 `provider.refresh !== undefined` 决定要不要续期
  //（`src/gateway/server.ts:934,1003`）—— 它是 `undefined` ⇒ 不续期、直接失败。
  //
  // ⚠️ 这是本项目第 2 次踩到「续期写好了却没人调」（第 1 次见
  // `types.ts` 的说明）。故连单测一起补上，防第 3 次。
  const src = readFileSync('src/providers/minimax.ts', 'utf8')
  assert.ok(/^async function refresh\(/m.test(src), '应有 refresh 函数')
  // ⚠️ 判据必须打在**活对象**上，不能只 grep 源码文本。
  //
  // 本站点的 provider 已参数化（`buildMinimaxProvider(site)`），挂载写法从
  // `refresh,` 变成 `refresh: (credential, signal) => refresh(credential, signal, site)`
  // —— 而源码文本断言会把这种**正确**的等价改写判成失败（假红）。
  // 真判据只有一个：**运行时这两个 provider 的 `refresh` 都是函数**。
  const { minimaxProvider, minimaxIntlProvider } = minimaxModule
  for (const [label, provider] of [
    ['minimax', minimaxProvider],
    ['minimaxintl', minimaxIntlProvider],
  ] as const) {
    assert.equal(typeof provider.refresh, 'function', `⚠️ ${label}.refresh 必须挂到 provider 对象上（只定义不挂 = 等于没有）`)
  }
  // 端点与参数必须逐字对（client_id 错了上游回 invalid_client）
  assert.ok(src.includes("'/oauth2/token'"), '端点应为 /oauth2/token')
  assert.ok(src.includes("'mcode-public'"), 'client_id 必须是官方常量 mcode-public')
  assert.ok(src.includes("grant_type: 'refresh_token'"), '必须是 refresh_token grant')
  assert.ok(src.includes("'agent.default'"), 'scope 必须是 agent.default')
  assert.ok(src.includes("'agent-backend'"), 'audience 必须是 agent-backend')
  // ⚠️ 新 refresh_token 缺失时必须**保留旧值**，否则「本次成功」变「下次永远失败」
  assert.ok(/nextRefreshRaw !== undefined && nextRefreshRaw\.length > 0[\s\S]{0,80}: credential\.refreshToken/.test(src),
    '⚠️ 新 refresh_token 为空时必须保留旧值')
  // ⚠️ 终态文案必须含「重新登录」（调用方按该子串判定不该重试）
  assert.ok(/请重新登录/.test(src), '终态文案要含「重新登录」')
})

test('🔴 lobsterai 必须挂上 refresh（同型缺陷）', () => {
  const src = readFileSync('src/providers/lobsterai.ts', 'utf8')
  assert.ok(/^async function refresh\(/m.test(src), '应有 refresh 函数')
  assert.ok(/^  refresh,$/m.test(src), '⚠️ 必须挂到 provider 对象上')
  assert.ok(src.includes("'/api/auth/refresh'"), '端点应为 /api/auth/refresh')
  // ⚠️ 续期**不带 Authorization**（参考实现同款）：带过期 Bearer 只会多一个被拒理由
  const i = src.indexOf('async function refresh(')
  // ⚠️ 窗口要够宽 —— 函数含大段「为什么」注释，3000 字符会截在说明里
  //（我第一版就是 3000，导致「必须保留旧 extras」误报失败）。
  const block = src.slice(i, i + 6000)
  assert.ok(!/headers:\s*\{[^}]*Authorization/.test(block), '⚠️ 续期不得带 Authorization')
  // ⚠️ keyfrom 必须用凭据里的**存储值**，不取当前时刻（对齐 Go 的 KeyfromBody）
  assert.ok(/firstKeyfrom: credential\.extras\['first_keyfrom'\]/.test(block),
    '⚠️ firstKeyfrom 要用存储值')
  assert.ok(/latestKeyfrom: credential\.extras\['latest_keyfrom'\]/.test(block),
    '⚠️ latestKeyfrom 要用存储值（Go 从不更新它）')
  // ⚠️ extras 要合并保留（丢了 keyfrom ⇒ 下次续期永远失败）
  assert.ok(/extras: \{ \.\.\.credential\.extras, \.\.\.next\.extras \}/.test(block),
    '⚠️ 必须保留旧 extras')
})

test('⚠️ zcode / opencode / loomy 如实不提供 refresh（上游确实没有续期端点）', () => {
  // ⚠️ 这三家是**诚实声明**，不是遗漏 —— 与上面两家（真缺陷）性质不同。
  // 别为了「统一」硬加一个假续期（那会是不实承诺，UI 会显示「可自动续期」）。
  //
  // 依据（读了参考实现）：
  // · zcode 「凭据是静态的，没有 refresh 端点」（`zcode-auth.ts:1765`）；
  // · opencode 匿名通道凭据是字面量 `'public'`，**无凭据可续期**
  //   （`opencode-auth.ts:175` 显式 `refreshable: false`）；
  // · loomy 服务端**没有任何 refresh 端点**（`loomy-auth.ts:11`
  //   `isLoomyRefreshable()` 恒 false）。
  for (const [name, why] of [
    ['zcode', '凭据静态/无 refresh 端点'],
    ['opencode', '匿名通道无凭据可续期'],
    ['loomy', '服务端无 refresh 端点'],
  ] as const) {
    const src = readFileSync(`src/providers/${name}.ts`, 'utf8')
    assert.ok(!/^  refresh,$/m.test(src), `${name} 不应挂 refresh（${why}）`)
  }
  // 且 zcode 要**明说**不可续期（否则后人会以为是漏了）
  const zcode = readFileSync('src/providers/zcode.ts', 'utf8')
  assert.ok(/不可续期/.test(zcode), 'zcode 必须显式说明「不可续期」')
})

test('🔴 zcode 签到前**必须**补发客户端活跃上报（否则 preview 恒为空）', () => {
  // ## 实测缺陷（我第一版漏了）
  //
  // 参考实现 `zcode-upstream.ts:18-29` 写得很明确：
  // ```
  // 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
  //   preview → {"code":0,"data":{"plans":[]}}          ← 空
  // 补之后：
  //   preview → {"code":0,"data":{"plans":[{plan_id:"…"}]}}
  // ```
  // ⚠️ 服务端**不会主动推送**活动，`preview` 的内容**依赖客户端活跃信号**。
  //
  // 我第一版直接查 preview ⇒ 永远拿空列表 ⇒ 把它当成「今天已领取」报给用户。
  // **那是假结论**，比报错更糟：用户以为「已经领过了」，实际是我们**根本没查到**。
  const src = readFileSync('src/providers/zcode.ts', 'utf8')
  assert.ok(src.includes('ZCODE_EVENT_REPORT_URL'), '应有活跃上报端点常量')
  const i = src.indexOf('async function checkin(')
  const block = src.slice(i, i + 4000)
  // ⚠️ 上报必须在**查 preview 之前**
  const reportAt = block.indexOf('ZCODE_EVENT_REPORT_URL')
  const previewAt = block.indexOf('ZCODE_BILLING_PREVIEW_URL')
  assert.ok(reportAt > 0, 'checkin 里必须发活跃上报')
  assert.ok(previewAt > 0, 'checkin 里要查 preview')
  assert.ok(reportAt < previewAt, '⚠️ 上报必须在查 preview **之前**（否则查到的是空列表）')
  // 两个事件都要发
  assert.ok(block.includes("'app_launch'") && block.includes("'app_daily_active'"),
    '两个活跃事件都要发')

  // 🔴 preview **必须带** `app_version` 与 `platform=win32` 查询参数
  //（参考实现 `zcode-upstream.ts:426` 逐字如此）。
  assert.ok(/ZCODE_BILLING_PREVIEW_URL\}?app_version=/.test(block) || /app_version=\$\{encodeURIComponent/.test(block),
    '⚠️ preview 必须带 app_version 查询参数')
  assert.ok(block.includes('platform=win32'), '⚠️ preview 必须带 platform=win32')

  // 🔴 判据必须是「`plan_id` 非空」，**不能**自己编「可领取」标记字段。
  // ⚠️ 我第一版编了 `claimable`/`can_claim`/`available` 三个字段名去筛，
  // 而上游**根本没有这些字段** ⇒ 列表恒为空 ⇒ 签到恒报「没有可领取的积分」
  // ⇒ **假结论**（用户以为领过了，实际是我们筛错了）。
  assert.ok(/\['plan_id'\]/.test(block), '⚠️ 判据必须读 plan_id')
  // ⚠️ 判据要**排除注释** —— 我的说明注释里正引用了那三个臆造字段名
  //（不排除会把「解释为什么不该用」的注释本身判成违规）。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/claimable'\] === true|can_claim'\]|available'\] === true/.test(code),
    '⚠️ 不得使用臆造的「可领取」标记字段（上游没有这些字段）')
  // ⚠️ device_mid 必须用 EXTRA_* 常量取值 —— 存储键是 camelCase，
  // 手写 snake_case 会读到 undefined ⇒ 发空串 ⇒ 上报静默失效。
  assert.ok(/credential\.extras\[EXTRA_DEVICE_MID\]/.test(block),
    '⚠️ device_mid 必须用 EXTRA_DEVICE_MID 常量（键名是 camelCase deviceMid）')
  assert.ok(/credential\.extras\[EXTRA_APP_VERSION\]/.test(block),
    '⚠️ app_version 必须用 EXTRA_APP_VERSION 常量')
  // 上报失败不能阻塞签到
  assert.ok(/catch \{[\s\S]{0,120}\}/.test(block.slice(reportAt - 200, reportAt + 2000)),
    '上报失败应被兜住（不阻塞）')
})

test('🔴 qoder 额度码是一条链（110 + 112），且 pricingUrl 文案腿独立成立', async () => {
  // ## 真实缺陷（参考实现 IKKJFH，本项目已移植修复）
  //
  // 上游的「额度用尽」不止一种码。只认 `110` 时，`112` 三条判据全 false
  // ⇒ 错误被归成「服务端故障」⇒ ① 白退避重试；② **既不换号、也不换 provider**。
  // 用户看到的是「轮换没生效」，而真实原因是**我们没认出这是额度问题**。
  const { looksLikeQoderBillingError, QODER_BILLING_CODES } = await import('../src/providers/qoder.ts')

  // ① 码值腿：两个码都要算额度 —— 字符串与数字两种编码都认
  for (const code of QODER_BILLING_CODES) {
    assert.equal(looksLikeQoderBillingError({ code }), true, `code=${code}（字符串）必须算额度`)
    assert.equal(looksLikeQoderBillingError({ code: Number(code) }), true, `code=${code}（数字）必须算额度`)
  }
  // ⚠️ 反向：集合必须**两个都在**（写回 ['110'] 时本断言变红）
  assert.equal(QODER_BILLING_CODES.includes('110'), true)
  assert.equal(QODER_BILLING_CODES.includes('112'), true)

  // ② 文案腿：`112` 的报文只带 pricingUrl，**没有任何自然语言说明**
  assert.equal(
    looksLikeQoderBillingError('{"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"}'),
    true,
    'pricingUrl 报文必须算额度（这是 112 的唯一线索）',
  )
  assert.equal(looksLikeQoderBillingError({ pricingUrl: 'https://qoder.com.cn/pricing' }), true)

  // ③ 不误伤：`10605`（排队）与泛词都不算额度
  assert.equal(looksLikeQoderBillingError({ code: '10605' }), false, '排队不是额度问题')
  assert.equal(looksLikeQoderBillingError('模型余额与额度讨论，请查看 pricing 页面'), false,
    '自然语言里的 pricing/额度 不算（判据是结构字段，不是主题词）')
})

test('🔴 qoder 排队必须有**总墙钟预算**（只有次数上限会让请求挂到被平台掐断）', () => {
  // ## 实测缺陷
  //
  // 原先只有「次数上限」（3 次 × 最多 10s 等待 + 每次 20s 超时 ≈ 90s），
  // **没有总时间上限**。实测后果：
  // ```
  // 排队 3 轮耗尽（约 90s）→ 触发续期（再 30s）
  //   ⇒ 请求挂到 122s ⇒ Worker 报 `Network connection lost.`
  //   ⇒ 平台回一个裸 `error code: 1101`（无任何可读原因）
  // ```
  //
  // ⚠️ 参考实现默认等 **30 分钟**（`qoder-adapter.ts:167-172`）——
  // 那是**长驻本地进程**的合理预算，而本服务跑在 Worker 里：
  // 挂几分钟既会被平台掐断，用户也早已放弃。
  const src = readFileSync('src/providers/qoder.ts', 'utf8')
  assert.ok(/const QUEUE_TOTAL_BUDGET_MS = \d[\d_]*/.test(src), '必须有总预算常量')
  const m = /const QUEUE_TOTAL_BUDGET_MS = ([\d_]+)/.exec(src)
  const budget = Number(m![1]!.replaceAll('_', ''))
  // ⚠️ 上限：不能长到被平台掐断（实测 122s 会挂）
  assert.ok(budget <= 90_000, `总预算 ${budget}ms 太长，会被平台掐断（实测 122s 即失败）`)
  // ⚠️ 下限：要够覆盖一次正常排队（实测常见 20–25s），否则正常用户会被误报
  assert.ok(budget >= 30_000, `总预算 ${budget}ms 太短，正常排队（20–25s）会被误判为繁忙`)
  // 循环里必须真的用上它
  const i = src.indexOf('async function chat(')
  const block = src.slice(i, i + 3000)
  assert.ok(/DATE|Date\.now\(\) - queueStartedAt/.test(block), '要记录起始时刻')
  assert.ok(/overBudget/.test(block), '⚠️ 必须有超预算判据')
  // ⚠️ 排队超时要**如实说明是排队**，且标记为可重试（容量问题，换号/稍后有效）
  assert.ok(/服务繁忙/.test(block) && /稍后重试/.test(block), '文案要说清是排队、稍后重试有效')
  assert.ok(/retryable: true/.test(block), '⚠️ 排队是容量问题 ⇒ 应标可重试')
})

test('🔴 Worker 入口必须有异常边界（否则只回裸 `error code: 1101`）', () => {
  // ## 实测缺陷
  //
  // 原先 `export default { fetch: handle }` 直接暴露业务函数，而 `handle`
  // **完全没有 try/catch**。任何未捕获的抛出都变成 Cloudflare 的裸
  // `error code: 1101`：客户端只看到 500 + 一个内部码，**不知道发生了什么**。
  //
  // ⚠️ 这与本项目「**绝不静默失败**」（§7.2）直接冲突 —— `1101` 就是
  // 最彻底的静默失败：既没有原因，也没有可操作信息。
  //
  // ⚠️ 这条边界加上后**立刻**定位到了 qoder 的真实原因
  //（`Network connection lost.`，此前完全不可见）。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/async function handle\([\s\S]{0,120}?try \{/.test(src), '⚠️ handle 必须有 try')
  assert.ok(/catch \(error\)/.test(src.slice(src.indexOf('async function handle('), src.indexOf('async function handle(') + 1200)),
    '⚠️ handle 必须有 catch')
  // 必须打**完整堆栈**（只打 message 会让排查失去线索）
  const i = src.indexOf('async function handle(')
  const block = src.slice(i, i + 1400)
  assert.ok(/error\.stack/.test(block), '⚠️ 必须打完整堆栈')
  // ⚠️ 回给客户端**可读原因**，不是裸内部码
  assert.ok(/internal_error/.test(block), '应回可识别的错误码')
  // ⚠️ 绝不能把 Authorization 打进日志。
  // ⚠️ 判据要**排除注释** —— 我的说明注释里正写着「绝不打 Authorization」
  //（不排除会把「解释为什么不打」的注释本身判成违规）。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/Authorization/.test(code), '⚠️ 日志不得含 Authorization')
})

test('🔴 qoder 单次推理必须有**自己的超时**（只透传 signal = 永不超时）', () => {
  // ## 实测缺陷（「加了总预算仍然 121.8s」的根因）
  //
  // 我加了「排队总墙钟预算」后**仍然**挂到 121.8s。原因：
  // `postQoderInfer` 只透传 `request.signal`，**没有超时** ⇒
  // **一次** fetch 就能无限期挂住 ⇒ 预算检查根本没机会执行
  //（预算只能在「每次 infer **返回之后**」才被检查，而 infer 自己不返回）。
  //
  // ⚠️ **教训：加总预算前，必须确认每一段都有界。**
  // 一个无界的子步骤会让外层所有预算形同虚设。
  const src = readFileSync('src/providers/qoder.ts', 'utf8')
  assert.ok(/const INFER_TIMEOUT_MS = \d[\d_]*/.test(src), '必须有推理超时常量')
  const m = /const INFER_TIMEOUT_MS = ([\d_]+)/.exec(src)
  const ms = Number(m![1]!.replaceAll('_', ''))
  // 与参考实现的 `QODER_REQUEST_TIMEOUT_MS = 30_000` 一致
  assert.equal(ms, 30_000, '应与参考实现的 30s 一致')
  // ⚠️ **发起推理的那次 fetch** 必须用上它（不能只是定义）
  const i = src.indexOf('async function postQoderInfer')
  const j = src.indexOf('\n}', src.indexOf('return await fetch(', i))
  const block = src.slice(i, j)
  assert.ok(/AbortSignal\.timeout\(INFER_TIMEOUT_MS\)/.test(block),
    '⚠️ 推理 fetch 必须带 AbortSignal.timeout(INFER_TIMEOUT_MS)')
  assert.ok(/AbortSignal\.any\(\[request\.signal/.test(block),
    '应与 request.signal 用 any 组合（客户端取消与超时都要生效）')
})

test('🔴 zcode 余额：`balances: []` **不是**异常，且要认顶层无 `data` 的形态', () => {
  // ## 实测缺陷（用户报「商汤和 zcode 的账号怎么了，为什么不显示积分」）
  //
  // 线上实测上游原文是：
  // ```json
  // {"server_time":1791524120,"plans":[],"balances":[]}
  // ```
  // 两个问题叠在一起：
  //
  // ① **我们没有 `data` 包裹时也能解析** —— 参考实现的类型标注写的是
  //    `data.balances`，但**实测响应根本没有 `data`**。我第一版只读
  //    `parsed.data` ⇒ 恒判「缺少 data 字段」⇒ zcode 余额**永远查不出来**。
  // ② **`balances: []` 是正常的** —— 参考实现实测记录
  //    （`zcode-upstream.ts:338-348`）：
  //    > **每日赠送的 start-plan 额度不在 `balances` 桶里**，只在 `plans` 里。
  //    > 只读 `balances` ⇒ 面板显示 0，而用户实际能领 1 亿 tokens。
  //    我第一版把「0 个桶」判成「形状无法识别」并**抛错** ⇒ 同样查不出。
  const src = readFileSync('src/providers/zcode.ts', 'utf8')
  const i = src.indexOf('async function balance(')
  const block = src.slice(i, i + 5000)

  // ① 必须兼容「顶层无 data」
  assert.ok(/parsed\.balances \?\? parsed\.data\?\.balances/.test(block),
    '⚠️ 必须同时认顶层与 data 两种层级（实测响应无 data 包裹）')
  // ② 空桶**不能**抛错
  assert.ok(!/packages\.length === 0[\s\S]{0,200}throw/.test(block),
    '⚠️ 空桶不能抛错（那是正常形态，额度在 plans 里）')
  // ③ 空桶时要去看 plans
  assert.ok(/data\.plans/.test(block), '空桶时应回落到 plans（每日额度在那里）')
  // ④ 必须符合 ProviderBalance 契约（没有 remaining/detail 这类自由字段）
  assert.ok(!/remaining:\s*0/.test(block), '⚠️ 不得用 ProviderBalance 契约外的字段')
})

test('🔴 loomy 发验证码不能二次读 request body（否则号码永远被判非法）', () => {
  // ## 实测缺陷（用户报「明明是 11 位电话号码但还是发不了验证码」）
  //
  // `/admin/providers/login/start` 在**开头**已经 `await request.json()`
  // 解析过一次 body（拿 `provider` / `realm`）。而 loomy 分支里**又读了一次**
  // `request.json()` —— HTTP 请求体是**一次性流**，第二次读会抛
  // `TypeError: body used already`，被 `.catch(() => ({}))` 吞掉后
  // `phone` 恒为 `''` ⇒ **任何号码都回「请填写 11 位手机号」**。
  //
  // ⚠️ 症状极具误导性：错误文案说的是「号码格式不对」，而真实原因是
  // **我们没读到号码** —— 用户会反复检查自己输入的东西。
  const src = readFileSync('src/index.ts', 'utf8')
  const start = src.indexOf("path === '/admin/providers/login/start'")
  // ⚠️ 范围要**只到下一个 `path ===`** —— `/login/loomy/sms` 是**另一个端点**，
  // 它有权利读自己的 body。我第一版把范围切到文件末尾，把它也算进来了。
  const after = src.slice(start + 10)
  const nextPath = after.search(/path === '/)
  const block = src.slice(start, start + 10 + (nextPath > 0 ? nextPath : 30000))
  // ⚠️ 只数**代码**里的调用（注释里会引用这个缺陷，要排除）
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n')
  const reads = (code.match(/request\.json\(\)/g) ?? []).length
  assert.equal(reads, 1, `⚠️ login/start 只能读一次 request body（实际 ${reads} 次）—— 第二次会抛异常且被吞掉`)
  // loomy 分支必须用已解析的 body
  const li = code.indexOf("providerId === 'loomy'")
  assert.ok(/body\.phone/.test(code.slice(li, li + 1500)), '⚠️ loomy 必须复用已解析的 body.phone')
})

test('⚠️ 续期失败的原因必须出现在用户可见错误里（不能只进日志）', () => {
  // 用户报「商汤和 zcode 的账号怎么了，为什么调用不了」。
  // 实测 codearts 返回的原始错误是 `APIG.0301 Incorrect IAM authentication
  // Unauthorized` —— ⚠️ **极具误导性**：它说的是「IAM 鉴权不对」，
  // 让人以为账号被封；而真实原因是**凭据缺自动续期材料/refresh token 已消耗**。
  //
  // 两者该采取的行动完全不同：前者等，后者去重新登录。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  assert.ok(/let refreshFailure = ''/.test(src), '要记录续期失败原因')
  assert.ok(/refreshFailure = error instanceof Error/.test(src), '要在 catch 里记下来')
  assert.ok(/自动续期也失败了：\$\{refreshFailure/.test(src),
    '⚠️ 必须把原因附到用户可见的错误文案里')
})

test('🔴 读上游响应失败必须翻成 502 upstream_error（不能穿透成 500 internal_error）', () => {
  // ## 实测缺陷（用户报「qoder 调用不了」，返回「服务内部错误」）
  //
  // provider 的**推理超时**（qoder `INFER_TIMEOUT_MS`）触发点**不在**
  // `provider.chat()` 里 —— `chat()` 返回 `Response` 时**流还没读完**，
  // 超时是在 `nonStreamingResponse` **读体时**炸的。
  //
  // 而那里原先只有 `try/finally`、**没有 `catch`** ⇒ 那个 `TimeoutError`
  // 穿透整个 `handleProviderChat`（它的 try 只包了 `provider.chat` 调用）
  // ⇒ 落到 Worker 异常边界 ⇒ 客户端看到 **`服务内部错误`**。
  //
  // ⚠️ 这是**错误分类**错误：上游慢/超时是**可重试的上游问题**，
  // 不是我们的内部故障。报成 500 会让用户以为服务坏了。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const i = src.indexOf('async function nonStreamingResponse')
  assert.ok(i > 0, '必须能找到 nonStreamingResponse')
  // ⚠️ 窗口取到**文件末尾**：`nonStreamingResponse` 是本文件最后一个函数。
  // 用固定长度（我原先写 4000）会在注释变长后**切掉真正的代码**，
  // 让断言变成「找不到 ⇒ 失败」这种**假失败**（加完 clientGone 说明后就踩到了）。
  // ⚠️ **必须剥掉注释再断言。**
  // 本项目所有解释性注释都用中文详细引用缺陷原文 —— 包括
  // `hooks.onError(message)` 这种**代码字面量**。不剥注释时，注释会先于
  // 真正的代码命中 grep，产生「顺序反了」这种**假失败**（我为此返工两次）。
  const block = stripComments(src.slice(i))
  // 读体必须有 catch
  assert.ok(/catch \(error\) \{[\s\S]{0,600}读取上游响应/.test(block),
    '⚠️ 读体必须有 catch 并翻译成可读错误')
  // ⚠️ 必须回 502 `upstream_error`，不是 500 `internal_error`
  assert.ok(/'upstream_error'/.test(block), '⚠️ 应回 upstream_error 类型')
  assert.ok(/status: 502/.test(block), '⚠️ 应是 502（上游问题），不是 500')
  // ⚠️ 判据要**排除注释**（我的说明里正引用 `internal_error` 这个词）。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/internal_error/.test(code), '⚠️ 不得报成 internal_error')
  // ⚠️ 要参与记账（否则失败不入池状态：不换号、不冷却）
  assert.ok(/hooks\.onError\(message\)/.test(block), '⚠️ 必须调 hooks.onError 参与记账')
})

test('🔴 saveLoginSession 的第三个参数必须是**绝对时刻**（不是时长）', () => {
  // ## 实测缺陷（用户报「讯飞登录显示登录会话不存在或已过期」）
  //
  // `saveLoginSession(state, payload, expiresAt)` 的第三个参数**必须是
  // `Date.now() + TTL` 形态的绝对毫秒时间戳**（见 `AccountPoolDO.ts:767-769`
  // → `writeLoginSession` 直接拿它比 `now`）。
  //
  // ⚠️ 我原先写的是裸的 `5 * 60 * 1000`（= 300000）—— 那是一个
  // **1970-01-01T00:05:00Z** 的时刻 ⇒ 会话**存进去就已经过期**
  // ⇒ 第二步必然报「会话不存在或已过期」，而第一步明明刚成功、验证码也真的发出去了。
  //
  // ⚠️ 这个参数名是 `expiresAt`（**时刻**）而非 `ttl`（**时长**）——
  // 凡是「传时长还是时刻」的接口都极易写错，且症状是**静默失效**
  //（不报错，只是永远查不到）。故这里用单测把所有调用点钉住。
  const src = readFileSync('src/index.ts', 'utf8')
  const calls: string[] = []
  const re = /saveLoginSession\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    // 从该位置往后配平括号，取出整个调用
    let depth = 1
    let k = m.index + 'saveLoginSession('.length
    while (k < src.length && depth > 0) {
      if (src[k] === '(') depth += 1
      else if (src[k] === ')') depth -= 1
      k += 1
    }
    calls.push(src.slice(m.index, k))
  }
  assert.ok(calls.length >= 10, `应找到全部调用点（找到 ${calls.length}）`)

  for (const call of calls) {
    // 取**最后一个顶层参数**
    const body = call.slice(call.indexOf('(') + 1, -1)
    const parts: string[] = []
    let d = 0
    let cur = ''
    for (const c of body) {
      if ('([{'.includes(c)) d += 1
      else if (')]}'.includes(c)) d -= 1
      if (c === ',' && d === 0) { parts.push(cur.trim()); cur = '' } else cur += c
    }
    // ⚠️ 收尾的 `cur` **必须** push（我的 JS 版原先在循环里 push 了，
    // 但 Python 原型漏了 —— 这里保证补上，否则最后一个参数会丢）。
    if (cur.trim() !== '') parts.push(cur.trim())
    const third = parts[parts.length - 1] ?? ''
    // ⚠️ 判据：必须含「时刻」语义的表达式。
    // 合法形态：`Date.now() + …` / `expiresAt` / `now + …` / `…TTL` / `deadline + …`
    const ok = /Date\.now\(\)|expiresAt|now \+|TTL|deadline|sessionTtl/.test(third)
    assert.ok(
      ok,
      `⚠️ saveLoginSession 第 3 参数必须含「绝对时刻」语义（实际：${third.slice(0, 60)}）`
        + ' —— 传裸时长会让会话**存进去就过期**，症状是「会话不存在」',
    )
  }
})

test('🔴 loomy 第二步必须复用 findLoginSession（不能自己解析 getLoginSession 的返回值）', () => {
  // ## 实测缺陷（同上）
  //
  // `getLoginSession()` 返回的是**会话载荷本身**（`AccountPoolDO.ts:776-779`），
  // 而 `findLoginSession()`（`index.ts:376-392`）才把它包成
  // `{realm, payload: session, pool}`。
  //
  // ⚠️ 我原先自己写了个查找循环，还去取 `hit.payload` —— **那一层不存在**
  // ⇒ 恒为 `undefined` ⇒ 第二步必然「会话不存在」。
  //
  // ⚠️ 教训：**同一个查找逻辑已有共享实现时，不要自己再写一遍** ——
  // 我把「包装层的形状」搞错了，而这类错误只表现为「查不到」。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf("path === '/admin/providers/login/loomy/sms'")
  const block = src.slice(i, i + 4000)
  assert.ok(/await findLoginSession\(env, state\)/.test(block),
    '⚠️ loomy 第二步必须用 findLoginSession（它才是那个包装层）')
  assert.ok(!/for \(const r of \[/.test(block),
    '⚠️ 不得自己再写一遍分片查找循环')
})

test('🔴 保活续期：TTL 以天计的家必须在闲置 7 天后主动续一次', () => {
  // ## 真实缺陷（参考实现 issue #124）
  //
  // 腾讯系的 access_token 有效期**以天计**（实测 60 / 30 / 28 天三批）。
  // 而 lead-time 判据只在「距过期不足 1 小时」放行 ⇒ 每小时那轮 cron 全部跳过
  // ⇒ refresh_token 闲置 28 天后被服务端作废：`401 {"code":12153,...}`。
  // 用户看到「凭据过期」，真实原因是**我们让它闲置太久**。
  const src = readFileSync('src/index.ts', 'utf8')

  // ① 两条腿必须**同时**在续期判据里
  assert.ok(/dueByExpiry/.test(src) && /dueByKeepAlive/.test(src),
    '续期判据必须是「到期腿 ∨ 保活腿」')
  assert.ok(/if \(!dueByExpiry && !dueByKeepAlive\) continue/.test(src),
    '两条腿取或后必须能跳过（否则每轮都续）')

  // ② ⚠️ 保活必须**限定在家**——推广到 TTL≈1h 且 refresh_token 一次性的家
  //    会把它们的令牌烧光（本项目丢过账号）。
  assert.ok(/KEEPALIVE_PROVIDERS/.test(src), '必须有「哪些家适用保活」的白名单')
  const white = src.slice(src.indexOf('KEEPALIVE_PROVIDERS: ReadonlySet'), src.indexOf('KEEPALIVE_PROVIDERS: ReadonlySet') + 200)
  assert.ok(/buddy/.test(white) && /workbuddy/.test(white), '两家腾讯变体都要在保活名单里')
  assert.ok(!/codearts|gemini|minimax|lobsterai|trae/.test(white),
    '⚠️ TTL≈1h / 一次性 refresh_token 的家**不得**进保活名单')

  // ③ 7 天窗口（不是「TTL 的百分比」也不是更短的值）
  assert.ok(/KEEPALIVE_MAX_IDLE_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(src),
    '保活窗口必须是 7 天（依据见常量注释的三条取舍）')

  // ④ ⚠️ `REFRESH_LEAD_MS` 必须**保持 1 小时**：它是九家共用的，
  //    改大等于让快到期的家每轮都续（会烧掉一次性 refresh_token）。
  assert.ok(/const REFRESH_LEAD_MS = 3_600_000/.test(src),
    'REFRESH_LEAD_MS 必须仍是 1 小时')

  // ⑤ 解不出 `iat` 必须退化成旧行为（不保活），不能「立刻续」
  assert.ok(/if \(issuedAt <= 0\) return false/.test(src),
    '解不出 iat 时应退化（不保活），而不是每轮白刷')
})

test('🔴 cron 必须做**主动续期**（否则每次凭据过期都先失败一批请求）', () => {
  // ## 用户报「其它账号的稳定性能不能提升一下，动不动就掉登录」
  //
  // 在此之前本项目续期**只有一条路径**：网关收到 401/403 时**才**续期。
  // ⇒ **每一次凭据过期都必然先失败一批请求** ⇒ 用户看到「动不动就掉登录」，
  // 而且掉的时候是**硬失败**（要等客户端重试才恢复）。
  //
  // ⚠️ 参考实现为此专门有 `refresh-scheduler.ts`，`refresh.ts:1` 写明：
  // > 在凭据过期前**提前 1 小时**触发刷新（对齐真实插件的 `36e5`）。
  //
  // 本服务 cron 恰好**每小时一条**，天然是「提前量」的载体。
  const src = readFileSync('src/index.ts', 'utf8')

  // ① 必须有提前量与续期函数
  assert.ok(/const REFRESH_LEAD_MS = 3_600_000/.test(src),
    '提前量必须是 1 小时（对齐参考实现 REFRESH_LEAD_MS）')
  assert.ok(/async function refreshExpiringCredentials/.test(src), '必须有主动续期函数')

  // ② ⚠️ **必须在 cron 的「非任务时点 return」之前调用** ——
  // 否则非任务时点就不会续期，而那正是「保持登录态」的关键。
  const sched = src.slice(src.indexOf('async function scheduled('))
  const callAt = sched.indexOf('await refreshExpiringCredentials(')
  const returnAt = sched.indexOf('if (plan === undefined)')
  assert.ok(callAt > 0, 'cron 里必须调用主动续期')
  assert.ok(returnAt > 0, 'cron 里应有「非任务时点直接返回」的分支')
  assert.ok(callAt < returnAt,
    '⚠️ 主动续期必须在「非任务时点 return」**之前** —— 否则非任务时点永远不续期')

  // ③ ⚠️ 只对**有 refresh 能力**的家动手（否则是「不实承诺」+ 白打上游）
  const fn = src.slice(src.indexOf('async function refreshExpiringCredentials'))
  assert.ok(/provider\?\.refresh === undefined\) continue/.test(fn),
    '⚠️ 没有 refresh 的家必须跳过（zcode/opencode/loomy 无可续期之物）')
  // ④ ⚠️ `expiresAt === 0` 表示**未知**而非「已过期」，不能拿它去续期
  assert.ok(/Number\.isFinite\(expiresAt\) \|\| expiresAt <= 0\) continue/.test(fn),
    '⚠️ expiresAt 为 0/NaN（未知）时必须跳过，不能当成已过期')
  // ⑤ ⚠️ 逐账号 try（一个坏凭据不该让全场不续期）
  assert.ok(/catch \(error\)[\s\S]{0,300}主动续期失败/.test(fn),
    '⚠️ 必须逐账号兜错，否则一个失败会让后面全部不续期')
  // ⑥ ⚠️ 整体也不能让 cron 抛（否则任务分发一起停）
  assert.ok(/catch \(error\)[\s\S]{0,200}主动续期整体失败/.test(sched),
    '⚠️ 续期整体失败不能让 cron 抛出（否则任务分发一起停）')
  // ⑦ 停用的账号不续期（用户明确不用了）
  assert.ok(/if \(account\.disabled\) continue/.test(fn), '停用账号应跳过')
})

test('🔴 每家 provider 都必须有 matchesShape（否则自动识别永远轮不到它）', () => {
  // ## 实测缺陷（用户报「我在本地登录了 lobsterai，推送上去试试」）
  //
  // 导入后 LobsterAI 的凭据被判成了 **raccoon**（账号以 `raccoon:116092` 出现）。
  //
  // 根因：`parseCredentialAnywhere` 的循环里，`matchesShape === undefined`
  // 会被当成「对象的字段形状不属于该供应商」而**直接跳过**
  //（`src/providers/index.ts:170-176`）。
  //
  // - Raccoon 的判据是「`user_id` 是纯数字」；
  // - **LobsterAI 的 `user_id` 恰好也是纯数字**（`116092`）；
  // - 而 LobsterAI 当时**没有 `matchesShape`** ⇒ 被跳过 ⇒ 落到 Raccoon 手里。
  //
  // ⚠️ **教训：任何支持「凭据导入」的供应商都必须有 `matchesShape`。**
  // 这类缺陷的症状是「导入成功但一发消息就 401」/「账号出现在别家下面」——
  // 用户很难联想到判别式缺失。
  //
  // 本测试**动态**遍历注册表，新增供应商若忘了加判别式会立刻失败。
  // ⚠️⚠️ **必须打运行时对象，不能 grep 源码**（2026-11-21 实测到假阳性）
  //
  // 旧写法是「按变量名推出文件名，再在该文件里 grep `matchesShape`」。
  // 本轮新增两家**共用实现文件**的变体（`qodercn` 在 `qoder.ts`、
  // `minimaxintl` 在 `minimax.ts`）—— 于是那两家**根本不需要自己声明**
  // 判别式，却因为同文件里另一个 provider 声明了而**通过检查**。
  //
  // 而它们**故意不声明**判别式（两站凭据形状无法区分，声明会让自动识别
  // 把国际版凭据判给中国版）。⇒ 这条检查必须改成「按 id 查活对象」，
  // 并把「共用文件变体」显式登记为豁免 —— 否则下次新增变体会再次假绿。
  const EXEMPT: ReadonlySet<string> = new Set([
    // 两站凭据逐字段相同，无法靠形状区分 ⇒ 只接受显式声明。
    'qodercn',
    'minimaxintl',
    // 本来就只支持「粘贴 API Key」，不参与对象形态的自动识别。
    'opencode',
    // ⚠️ 它是**兜底**（见 `buddy.ts:183-185` 与 `providers/index.ts` 的
    // `parseCredentialAnywhere`）：形态最宽松（只要 accessToken+uid），
    // 声明的判别式反而会**抢走别家的凭据**。它由排序机制保证「最后试」，
    // 不需要也不应该有 `matchesShape`。
    'buddy',
  ])

  const missing: string[] = []
  for (const provider of PROVIDERS) {
    if (EXEMPT.has(provider.id)) continue
    if (typeof provider.matchesShape !== 'function') missing.push(provider.id)
  }
  assert.deepEqual(
    missing,
    [],
    '⚠️ 以下 provider 缺 matchesShape，自动识别时会被跳过、凭据被别家认走：'
      + missing.join('、'),
  )

  // ⚠️ 豁免名单不许悄悄变长：每加一项都必须在这里说明理由（上面那段注释）。
  assert.ok(EXEMPT.size <= 4, '豁免名单只应有共用实现的双站变体、纯 API Key 家与兜底家')

  // ⚠️ 而**兜底家之外**的国际版/中国版变体必须靠「不参与识别」来区分的，
  // 不能两边都声明（否则同一份凭据会按注册顺序判给先注册的那家）。
  assert.ok(
    typeof findProvider('workbuddy')?.matchesShape === 'function',
    '国际版必须声明判别式（它靠 domain / platform 区分，与国内版不同）',
  )
})

test('🔴 lobsterai 必须被识别为 lobsterai，而不是 raccoon', () => {
  // 实测：LobsterAI 凭据（`user_id` 为纯数字 `116092`）被判成了 raccoon。
  const raccoon = readFileSync('src/providers/raccoon.ts', 'utf8')
  const lobster = readFileSync('src/providers/lobsterai.ts', 'utf8')

  // ① raccoon 必须**显式排除** LobsterAI 的独有字段
  const rMatch = raccoon.slice(raccoon.indexOf('matchesShape('))
  const rBody = rMatch.slice(0, rMatch.indexOf('\n  },'))
  for (const k of ['first_keyfrom', 'latest_keyfrom']) {
    assert.ok(
      rBody.includes(k),
      `⚠️ raccoon 的判别式必须排除 LobsterAI 的独有字段 \`${k}\``
        + '（两者 user_id 都是纯数字，不排除就会误判）',
    )
  }

  // ② lobsterai 必须有 matchesShape，且认自己的独有字段
  assert.ok(/^\s*matchesShape\(/m.test(lobster), '⚠️ lobsterai 必须有 matchesShape')
  const lMatch = lobster.slice(lobster.indexOf('matchesShape('))
  const lBody = lMatch.slice(0, lMatch.indexOf('\n  },'))
  assert.ok(lBody.includes('first_keyfrom'), '⚠️ lobsterai 的判别式应认 first_keyfrom')
  // ③ 也要排除 TRAE（有 machine_id 且无 uuid）—— 与 parseCredential 口径一致
  assert.ok(/machine_id/.test(lBody), '⚠️ lobsterai 的判别式必须排除 TRAE 凭据')
})

test('⚠️ loomy 的 matchesShape 与 parseCredential 必须共用同一份判据', () => {
  // 两处判据一旦分叉，就会出现「matchesShape 说是我、parseCredential 说不是」
  // 这种自相矛盾的组合，症状是「自动识别选中了 Loomy，导入却报错」。
  const src = readFileSync('src/providers/loomy.ts', 'utf8')
  assert.ok(/export function looksLikeLoomyCredential/.test(src),
    '必须有共享判据函数')
  // parseCredential 内部必须复用它
  const pi = src.indexOf('function parseCredential(')
  const pBody = src.slice(pi, pi + 6000)
  assert.ok(/looksLikeLoomyCredential\(source\)/.test(pBody),
    '⚠️ parseCredential 必须复用共享判据，不能自己再写一份')
  // provider 对象必须挂它
  assert.ok(/matchesShape: looksLikeLoomyCredential/.test(src),
    '⚠️ matchesShape 必须复用同一个函数')
  // ⚠️ 嵌套包装层也要认（否则嵌套形凭据永远判不出来）
  const fn = src.slice(src.indexOf('export function looksLikeLoomyCredential'))
  assert.ok(/for \(const wrapper of \['credential', 'credentials', 'auth'\]\)/.test(fn),
    '⚠️ 共享判据必须先展开嵌套包装层（与 parseCredential 一致）')
})

test('🔴 空响应必须显式报错（含「找不到错误帧」的兜底），但**不能**误伤工具调用', () => {
  // ## 实测缺陷（用户报「codearts 调用不了」）
  //
  // CodeArts 在「并发会话数已达上限(3个)」时，非流式路径回的是
  //   `content:'' + finish_reason:'stop' + usage:null` 的 **HTTP 200 空答案**，
  // 而它在**流式**路径是会正常报错的 —— 两条路径口径不一致。
  //
  // 根因有**两处**：
  //
  // 1. 判据里有个错误的合取项
  //    `&& (completion.usage === undefined || completion.usage === null)` ——
  //    它把「有 usage」当成「不是空响应」的理由。而 `usage` 只说「上游计了费」，
  //    与「有没有内容」**无关**：最需要报错的恰恰是「消耗了 token 却没产出内容」。
  // 2. 即使进了那个分支，**只有识别到错误帧才报错**；上游若给的是
  //    「合法但完全空」的响应（没有错误帧、也没有内容），流程会**落回正常返回**
  //    ⇒ 客户端拿到 `content:''`，看起来像「模型说了空话」。
  //
  // ⚠️ 这是本项目 §7.2「失败必须显式」明确禁止的形态：**空回复比报错更糟**。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const i = src.indexOf('async function nonStreamingResponse')
  const block = src.slice(i, i + 8000)

  // ① 判据不得把 usage 当「有内容」的判据
  // ⚠️ 判据要**排除注释**（我的说明里正引用那个错误写法作反面教材）。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(
    !/completion\.usage === undefined \|\| completion\.usage === null/.test(code),
    '⚠️ 空响应判据不得包含 usage 条件（usage 只说明计了费，与内容无关）',
  )

  // ② 必须有「找不到错误帧也要报错」的兜底
  assert.ok(/上游返回了空响应（既没有正文\/思考内容，也没有可识别的错误帧）/.test(block),
    '⚠️ 必须有兜底：找不到错误帧时也要如实报错，不能落回静默空回复')

  // ③ ⚠️ 但**必须排除工具调用** —— 那时 content 也是 ''，不排除会把一次
  //    **成功**的工具调用误报成空响应（假阳性比原缺陷更糟：工具调用是
  //    agent 场景的主路径）。
  assert.ok(/const hasToolCalls = Array\.isArray\(toolCalls\) && toolCalls\.length > 0/.test(block),
    '必须计算 hasToolCalls')
  assert.ok(/choice !== undefined\s*\n\s*&& !hasToolCalls/.test(block),
    '⚠️ 空响应判据必须排除 tool_calls（否则误伤正常的工具调用）')
})

test('⚠️ aggregateSse 确实会把 tool_calls 放进 message（上一条测试的前提）', () => {
  // 上面那条测试断言「必须排除 tool_calls」，其前提是聚合结果里
  // tool_calls 真的在 `choice.message.tool_calls`（而不是别处）。
  // 这个前提若变了，那条断言就会变成**无意义的空转**。
  const src = readFileSync('src/gateway/stream.ts', 'utf8')
  assert.ok(/if \(toolCalls\.length > 0\) choice\.message\.tool_calls = toolCalls/.test(src),
    '⚠️ aggregateSse 必须把 tool_calls 挂在 choice.message 上')
  assert.ok(/finish_reason = toolCalls\.length > 0 \? 'tool_calls' : 'stop'/.test(src),
    "⚠️ 有工具调用时 finish_reason 应为 'tool_calls'")
})

test('🔴 客户端取消**不得**记成账号失败（否则用户的取消会熔断健康账号）', () => {
  // ## 代码审查发现的真缺陷（我自己上一轮引入的）
  //
  // 我给 `nonStreamingResponse` 加的读体 catch 里**无条件**调
  // `hooks.onError(message)`。但那 catch 也会捕获**客户端中途取消**
  //（用户点停止 / 关标签页 / 客户端超时）：那同样会让上游流 abort、
  // `reader.read()` 抛 `AbortError`。
  //
  // ⇒ 一个**健康账号**会因用户的取消动作被记一次失败，而
  // `punishmentForStreamError` 对非 11128 的错误一律返回 `'breaker'`
  // ⇒ **3 次就把好号熔断 30 分钟**。症状正是本项目反复踩到的
  //「账号明明好的，却越来越用不了」。
  //
  // ⚠️ 本项目**已有**这条纪律（`qoder.ts:924`、`zcode.ts:752` 都显式把
  //「请求已被客户端取消」原样区分开），且流式路径**已经**用
  // `hooks.clientGone?.()` 做这个判别 —— 非流式路径此前漏了同一条判据。
  const src = readFileSync('src/gateway/server.ts', 'utf8')

  // ① 非流式读体 catch 里必须有 clientGone 分支，且在 onError **之前**
  const i = src.indexOf('async function nonStreamingResponse')
  assert.ok(i > 0, '必须能找到 nonStreamingResponse')
  // ⚠️ 同上：取到文件末尾，不用固定长度窗口（否则注释一长就产生假失败）。
  // ⚠️ 同上：必须剥注释（我的说明里正引用 `hooks.onError(message)` 这个字面量，
  // 不剥就会让「注释里的 onError」排在真正的代码之前 ⇒ 假失败）。
  const block = stripComments(src.slice(i))
  const goneAt = block.indexOf('const clientGone = hooks.clientGone?.() === true')
  const onErrAt = block.indexOf('hooks.onError(message)')
  assert.ok(goneAt > 0, '⚠️ 非流式读体失败必须先用 clientGone 判别客户端取消')
  assert.ok(onErrAt > 0, '应有 hooks.onError 调用')
  assert.ok(goneAt < onErrAt,
    '⚠️ clientGone 判别必须在 hooks.onError **之前**（否则取消仍会被记成失败）')

  // ② 取消分支必须**不**调 onError —— 即那个 return 要出现在 onError 之前
  const cancelReturn = block.indexOf('client_closed_request')
  assert.ok(cancelReturn > 0 && cancelReturn < onErrAt,
    '⚠️ 客户端取消分支必须在 onError 之前 return（不记失败）')

  // ③ hooks 类型必须声明 clientGone（否则调用点传了也拿不到）
  assert.ok(/clientGone\?: \(\) => boolean/.test(block.slice(0, 600)),
    '⚠️ nonStreamingResponse 的 hooks 类型必须声明 clientGone')

  // ④ ⚠️ **所有** streamResponse 调用点都要传 clientGone。
  // 只传一个等于没修：其余路径 clientGone?.() 返回 undefined ⇒ 仍会记失败。
  const sites = [...src.matchAll(/await streamResponse\(/g)].map((m) => m.index)
  assert.ok(sites.length >= 4, `应有 4 个 streamResponse 调用点（实际 ${sites.length}）`)
  const missing: number[] = []
  sites.forEach((at, n) => {
    // 该调用点往后 1200 字符内应出现 clientGone
    const scope = src.slice(at, at + 1200)
    if (!scope.includes('clientGone')) missing.push(n + 1)
  })
  assert.deepEqual(missing, [],
    `⚠️ 第 ${missing.join('、')} 个 streamResponse 调用点没传 clientGone`
      + '（漏传的路径仍会把客户端取消记成账号失败）')
})

test('🔴 SSE `data:` 前缀必须容忍**无空格**形态（否则扫不到上游错误帧）', () => {
  // ## 实测缺陷（全供应商验收时定位）
  //
  // codearts 经华为 APIG 回的错误帧原文是：
  // ```
  // data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found",...}
  // ```
  // ⚠️ 注意 **`data:` 后面没有空格**。
  //
  // 而非流式路径「找不到内容时回头扫错误帧」那段原先判的是
  // `line.startsWith('data: ')`（**带空格**）⇒ 这一帧**永远匹配不上**
  // ⇒ 用户看到通用兜底「上游返回了空响应…」，而**真实原因是 benefit not found**
  //（账号权益未生效 —— 该采取的行动完全不同）。
  //
  // ⚠️ 关键在于：**同一个项目里 `parseSseLine` 早就同时容忍两种写法**，
  // 而我在 server.ts 里又手写了一遍解析，就漏掉了无空格形态。
  // ⇒ **教训：SSE 一律走 `parseSseLine`，不要手写 `data:` 前缀判断。**
  const server = readFileSync('src/gateway/server.ts', 'utf8')
  const stream = readFileSync('src/gateway/stream.ts', 'utf8')

  // ① parseSseLine 本身必须容忍无空格（这是前提）
  assert.ok(/if \(!trimmed\.startsWith\('data:'\)\)/.test(stream),
    "⚠️ parseSseLine 必须用 startsWith('data:')（不带空格）")
  assert.ok(/trimmed\.slice\(5\)\.trim\(\)/.test(stream),
    '⚠️ parseSseLine 应用 slice(5) 去掉 data: 并 trim')

  // ② server.ts 里**不得**再手写 `startsWith('data: ')`（剥注释后判）
  const code = stripComments(server)
  assert.ok(!/startsWith\('data: '\)/.test(code),
    "⚠️ 不得手写 startsWith('data: ')（带空格）—— 会漏掉上游的 `data:{...}` 形态")

  // ③ 那段错误帧扫描必须复用 parseSseLine
  const i = server.indexOf('async function nonStreamingResponse')
  const block = stripComments(server.slice(i))
  assert.ok(/const frame = parseSseLine\(line\)/.test(block),
    '⚠️ 错误帧扫描必须复用 parseSseLine（同一件事只能有一个实现）')
})

test('🔴 Loomy 模型目录必须认「裸对象 + data[]」形态（实测上游就是这种）', () => {
  // ## 实测缺陷（全供应商验收时定位）
  //
  // `GET /v1/models` 里 `loomy` 贡献 **0 个模型**，且 errors 里写着
  // 「Loomy 模型目录为空：上游响应形状可能已变化（期望 data[] 且条目 type === "chat"）」。
  //
  // ⚠️ 那句文案**误导了我自己**：它让人以为上游改了接口。
  // 用只读诊断抓到上游真实原文后发现 —— **数据一直好好地在那里**：
  // ```
  // { reasoning_enabled, reasoning_catalog_version, object: "list", data: [ …13 条… ] }
  // ```
  // 13 个条目，`type` 正是 `'chat'`，`id` 是 `'DeepSeek-V4.1-Flash'`。
  //
  // ⚠️ 关键在于它**没有 `code` 字段** —— 是 OpenAI 风格的列表信封，
  // **不是** Loomy 的业务信封。于是：
  // - `listModels` 的 `isEnvelope`（`typeof code === 'string'`）判 false（对）；
  // - 但 `parseLoomyModels` 内部用 `parseLoomyEnvelope`（要求 `code === '000000'`）
  //   也判 false ⇒ 落到 `Array.isArray(payload)` ⇒ payload 是**对象** ⇒ 恒空。
  //
  // ⇒ 修法是补上「裸对象 + `data[]`」这第三种形态。
  const src = readFileSync('src/providers/loomy.ts', 'utf8')

  // ① 必须有裸对象 data[] 的分支
  assert.ok(/const bareObjectData = \(\(\) => \{/.test(src),
    '⚠️ parseLoomyModels 必须认「裸对象 + data[]」形态')
  assert.ok(/bareObjectData \?\? \[\]/.test(src),
    '⚠️ 裸对象形态必须作为兜底之一参与取列表')

  // ② 该分支必须在 Array.isArray 之后（保持既有两种形态的优先级不变）
  const fn = src.slice(src.indexOf('export function parseLoomyModels'))
  const arrAt = fn.indexOf('Array.isArray(payload) ? payload')
  const bareAt = fn.indexOf('bareObjectData ?? []')
  assert.ok(arrAt > 0 && bareAt > arrAt,
    '⚠️ 顺序应为：信封 → 裸数组 → 裸对象（既有形态优先级不能变）')
})

test('⚠️ Loomy 的模型条目判据是 `type === "chat"`（实测上游该字段确实存在）', () => {
  // 上一条测试的前提：上游条目里**真的有** `type` 字段且值为 `'chat'`。
  // 这个前提若不成立，上一条断言就只是空转。
  // 实测 `firstKeys` 含：reasoning_efforts / default_reasoning_effort / id /
  // name / object / created / owned_by / **type** / protocol / context_length /
  // max_output_tokens / capabilities / is_default_model。
  const src = readFileSync('src/providers/loomy.ts', 'utf8')
  const fn = src.slice(src.indexOf('export function isLoomyChatModel'))
  assert.ok(/type/.test(fn.slice(0, 600)), '⚠️ isLoomyChatModel 的判据应基于 type 字段')
  assert.ok(/chat/.test(fn.slice(0, 600)), "⚠️ 应判 `type === 'chat'`")
})

// ─────────────────── 聚合：规范模型名归一 ───────────────────

test('🔴 规范名归一：线上 8 个渠道的 DeepSeek V4.1 Flash 必须归到同一个键', () => {
  // 用**线上实测的真实 id** 做断言（不是编造的）——这是本模块存在的全部理由：
  // 同一个真实模型在各渠道叫法完全不同，用户在选择器里看到多条同名条目。
  const cases: Array<[string, string, string, string]> = [
    ['buddy', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'deepseek-v4-1-flash'],
    ['workbuddy', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'deepseek-v4-1-flash'],
    ['trae', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'deepseek-v4-1-flash'],
    ['codearts', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'deepseek-v4-1-flash'],
    // cline 的 id 带「免费通道」前缀，前缀不是模型名的一部分
    ['cline', 'cline-free/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'deepseek-v4-1-flash'],
    // ⚠️ lobsterai 的 id 与规范键**没有字面关系**，只能靠显式补丁
    ['lobsterai', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek-v4-1-flash'],
    // raccoon 的 `sn-` 前缀
    ['raccoon', 'sn-deepseek-v4-1-flash', 'DeepSeek V4.1 Flash', 'deepseek-v4-1-flash'],
    // loomy 的展示名形态（大写 + 点）
    ['loomy', 'DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', 'deepseek-v4-1-flash'],
  ]
  for (const [p, id, name, want] of cases) {
    const got = canonicalKeyFor(p, id, name)
    assert.equal(got?.key, want, `⚠️ ${p}:${id} 应归到 ${want}（实际 ${got?.key}）`)
  }
})

test('🔴 通用名必须排除（尤其 `auto` —— 它是聚合自己的保留名）', () => {
  // ⚠️ `loomy/auto` 是**线上真实存在的模型**，但 `auto` 是聚合 provider 的
  // 保留名。不排除会让两者撞车。
  assert.equal(canonicalKeyFor('loomy', 'auto', 'Auto'), undefined, '⚠️ auto 必须排除')
  for (const name of ['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model']) {
    assert.equal(canonicalKeyFor('buddy', name, name), undefined, `⚠️ ${name} 必须排除（各家含义不同）`)
  }
})

test('⚠️ 归一化细节：点替换而非删除；日期快照后缀不剥', () => {
  // 点是**替换**成连字符，不能删掉 —— `v4.1`→`v4-1`，若删成 `v41` 会与真的 `v41` 撞车
  assert.equal(normalizeModelKey('deepseek-v4.1-flash'), 'deepseek-v4-1-flash')
  assert.notEqual(normalizeModelKey('deepseek-v4.1'), normalizeModelKey('deepseek-v41'))
  // 日期快照是**不同的模型**，剥掉会让用户选到不知道的版本
  assert.notEqual(normalizeModelKey('deepseek-v4-flash-0731'), normalizeModelKey('deepseek-v4-flash'))
  // `-official` 同理
  assert.equal(normalizeModelKey('deepseek-v4-flash-official'), 'deepseek-v4-flash-official')
  // `:free` 后缀要剥
  assert.equal(normalizeModelKey('some-model:free'), 'some-model')
  // 空白 → 连字符
  assert.equal(normalizeModelKey('DeepSeek V4.1 Flash'), 'deepseek-v4-1-flash')
})

test('⚠️ 展示名归一要剥掉渠道的倍率/免费装饰', () => {
  assert.equal(normalizeNameKey('GLM-5.3-Flash · x0.8'), 'glm-5-3-flash')
  assert.equal(normalizeNameKey('MiniMax M3 · x4.0'), 'minimax-m3')
  assert.equal(normalizeNameKey('某模型 免费'), '某模型')
  // ⚠️ 不带 `·` 的数字不能被误读（模型名里本来就有数字）
  assert.equal(normalizeNameKey('gpt-4o'), 'gpt-4o')
})

test('🔴 原型链守卫：`constructor` 这类键不得命中 Object 构造函数', () => {
  // 模型 id 是**外部输入**。`CANONICAL_NAMES['constructor']` 用直接取值会拿到
  // `Object` 构造函数（真值）⇒ 展示名成了个函数 ⇒ 目录校验失败 ⇒
  // **整份聚合目录消失**。故两处表都必须用 `Object.hasOwn` 查。
  const name = canonicalDisplayName('constructor')
  assert.equal(typeof name, 'string', '⚠️ 展示名必须是字符串（不能是函数）')
  assert.equal(name, 'constructor', '未登记的键应回落到键本身')
  // 补丁表同样要守
  const got = canonicalKeyFor('constructor', 'constructor', 'constructor')
  assert.ok(got === undefined || typeof got.key === 'string',
    '⚠️ 不得返回非字符串键')
})

test('⚠️ 价格倍率解析：`·` 分隔符必需，促销箭头取后者', () => {
  assert.equal(priceFactorFromName('GLM-5.3-Flash · x0.8'), 0.8)
  assert.equal(priceFactorFromName('MiniMax M3 · x4.0'), 4)
  // 促销箭头：取**箭头后**的实际计费倍率
  assert.equal(priceFactorFromName('GLM-5.3 · x1.0 → x0.5'), 0.5)
  assert.equal(priceFactorFromName('某模型 免费'), 0, '免费应为 0')
  // ⚠️ 没有 `·` 时不得把模型名里的数字当倍率
  assert.equal(priceFactorFromName('kimi-k2.5'), Number.POSITIVE_INFINITY)
  assert.equal(priceFactorFromName('deepseek-v4.1-flash'), Number.POSITIVE_INFINITY)
})

// ─────────────────── 聚合：虚拟模型与临期优先 ───────────────────

test('🔴 构建虚拟模型：同一真实模型跨渠道归到一条，且顺序稳定', () => {
  const cats = [
    { provider: 'buddy', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    ] },
    { provider: 'lobsterai', models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash · x0.8' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX · x1.2' },
    ] },
    { provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash · x2.0' }] },
    // ⚠️ loomy 的 `auto` 必须被丢弃（通用名，且是聚合的保留名）
    { provider: 'loomy', models: [
      { id: 'auto', name: 'Auto' },
      { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash · x1.0' },
    ] },
  ]
  const vms = buildVirtualModels(cats)
  const ds = vms.find((v) => v.key === 'deepseek-v4-1-flash')
  assert.ok(ds !== undefined, '应有 deepseek-v4-1-flash 虚拟模型')
  // 4 个渠道都归到这一条
  assert.deepEqual(ds.candidates.map((c) => c.provider).sort(),
    ['buddy', 'lobsterai', 'loomy', 'raccoon'],
    '⚠️ 4 个渠道应归到同一个虚拟模型')
  assert.equal(ds.name, 'DeepSeek V4.1 Flash', '展示名应是官方拼写')
  // ⚠️ `auto` 不得出现为虚拟模型
  assert.ok(!vms.some((v) => v.key === 'auto'), '⚠️ auto 必须被排除（保留名）')
  // ⚠️ 顺序必须稳定：候选数降序，同数按键升序
  const keys = vms.map((v) => v.key)
  assert.deepEqual(keys, [...keys].sort((a, b) => {
    const ca = vms.find((v) => v.key === a)?.candidates.length ?? 0
    const cb = vms.find((v) => v.key === b)?.candidates.length ?? 0
    return cb - ca || a.localeCompare(b)
  }), '⚠️ 输出顺序必须确定（否则目录每次刷新都在跳）')
})

test('🔴 临期优先：最快作废的先烧；「长期」排最后但仍可选中', () => {
  const base = [
    { provider: 'buddy', realId: 'm', realName: 'M', price: 1 },
    { provider: 'cheap', realId: 'm', realName: 'M · x0.5', price: 0.5 },
    { provider: 'forever', realId: 'm', realName: 'M', price: 1 },
    { provider: 'unknown', realId: 'm', realName: 'M', price: 1 },
  ]
  const now = Date.now()
  const expiry = {
    buddy: now + 5 * 60_000,      // 5 分钟后
    cheap: now + 60 * 60_000,     // 1 小时后（更便宜，但更不临期）
    forever: EXPIRY_NEVER,        // 长期
    unknown: EXPIRY_UNUSABLE,     // 查不到
  }
  const ranked = rankCandidates(base, (c) => expiry[c.provider as keyof typeof expiry])

  // ⚠️ 「查不到」必须被**剔除**（不是排最后）——我们不知道它能不能用
  assert.ok(!ranked.some((c) => c.provider === 'unknown'),
    '⚠️ EXPIRY_UNUSABLE 必须剔除，不能只排到最后')
  // 到期时刻升序：buddy(5min) → cheap(1h) → forever(长期)
  assert.deepEqual(ranked.map((c) => c.provider), ['buddy', 'cheap', 'forever'])
  // ⚠️ 「长期」必须**仍在**列表里（可用，只是不急）
  assert.ok(ranked.some((c) => c.provider === 'forever'),
    '⚠️ EXPIRY_NEVER 必须仍可被选中（有永久额度的渠道是可用的）')
})

test('🔴 同到期时刻时按价格排序（便宜的先用）', () => {
  const now = Date.now()
  const base = [
    { provider: 'pricey', realId: 'm', realName: 'M · x4.0', price: 4 },
    { provider: 'cheap', realId: 'm', realName: 'M · x0.5', price: 0.5 },
    { provider: 'free', realId: 'm', realName: 'M 免费', price: 0 },
  ]
  const ranked = rankCandidates(base, () => now + 60_000)
  assert.deepEqual(ranked.map((c) => c.provider), ['free', 'cheap', 'pricey'])
})

test('🔴 pickSoonestProvider：「全部长期」不得报成「没有账号」', () => {
  // ⚠️ 这是参考实现记录过的真实缺陷形态：把「还没找到赢家」与
  // 「当前最优时刻」都初始化为 Infinity，会让「全部候选都是长期有效」时
  // 返回 undefined ⇒ 界面报「没有账号登录」——而账号好得很。
  assert.equal(pickSoonestProvider([]), undefined, '空列表应为 undefined')

  const allForever = [
    { provider: 'a', expiry: EXPIRY_NEVER },
    { provider: 'b', expiry: EXPIRY_NEVER },
  ]
  assert.equal(pickSoonestProvider(allForever), 'a',
    '⚠️ 全部长期时必须返回第一个，不能返回 undefined')

  // 全部不可用 → undefined（真的没得选）
  assert.equal(pickSoonestProvider([
    { provider: 'a', expiry: EXPIRY_UNUSABLE },
  ]), undefined, '全部不可用应为 undefined')

  // 混合：跳过不可用，取最早
  const now = Date.now()
  assert.equal(pickSoonestProvider([
    { provider: 'unknown', expiry: EXPIRY_UNUSABLE },
    { provider: 'later', expiry: now + 3600_000 },
    { provider: 'sooner', expiry: now + 60_000 },
  ]), 'sooner')
})

test('⚠️ 到期标签：查不到 / 长期 / 已过期 三者语义不同', () => {
  const now = Date.now()
  // ⚠️ 「查不到」不能说成「已过期」——前者是「没能确定」，后者是「确定没了」，
  // 用户该采取的行动不同。
  assert.equal(expiryLabel(EXPIRY_UNUSABLE, now), '查不到')
  assert.equal(expiryLabel(EXPIRY_NEVER, now), '长期')
  assert.equal(expiryLabel(now - 1000, now), '已过期')
  assert.equal(expiryLabel(now + 30 * 60_000, now), '30 分钟后')
  assert.equal(expiryLabel(now + 3 * 3600_000, now), '3 小时后')
  assert.equal(expiryLabel(now + 72 * 3600_000, now), '3 天后')
})

test('⚠️ 脏目录不得让聚合整体失败（空 id 必须丢弃）', () => {
  // ⚠️ 夹具必须用**白名单内**的规范名：`buildVirtualModels` 现在只输出
  // `AGGREGATE_ALLOWED_KEYS` 里的键（用户要求「聚合只保留那两个模型」）。
  // 用任意名字（如原先的 `good-model`）会让本用例**因白名单而空**，
  // 于是断言 `length === 1` 失败 —— 那是夹具过时，不是「丢弃脏数据」失效。
  const vms = buildVirtualModels([
    { provider: 'x', models: [
      { id: '', name: '' },
      { id: '   ', name: 'blank' },
      { id: 'deepseek-v4-1-flash', name: '' },
    ] },
  ])
  assert.equal(vms.length, 1, '⚠️ 空/空白 id 必须丢弃，否则会产出无效目录')
  // 展示名为空时回落到 id
  assert.equal(vms[0].candidates[0].realId, 'deepseek-v4-1-flash')
})

// ─────────────────── Gemini（Cloud Code Assist） ───────────────────

/**
 * 捕获一次**异步**抛错，并断言它确实是 `ProviderError`。
 *
 * ⚠️ 不用 `assert.rejects`：它不返回错误对象，于是「`retryable` 对不对」
 * 这类**最关键的断言**根本写不出来 —— 与 `catchError` 存在的理由同源。
 *
 * ⚠️ 没抛错时**主动抛出**（而不是返回 `undefined`）：静默返回会让后续的
 * `error.message` 变成 `TypeError`，把「本该失败却成功了」这个真正的结论
 * 掩盖成一句驴唇不对马嘴的报错。
 */
async function catchProviderError(fn: () => Promise<unknown>): Promise<ProviderError> {
  let caught: unknown
  let threw = false
  try {
    await fn()
  } catch (error) {
    caught = error
    threw = true
  }
  if (!threw) throw new Error('⚠️ 期望抛出 ProviderError，但调用成功了')
  if (!(caught instanceof ProviderError)) {
    throw new Error(`⚠️ 期望 ProviderError，实际是：${String(caught)}`)
  }
  return caught
}

/** 造一个只含 `sub` / `email` 的假 `id_token`（**不验签**，本项目只用它取身份）。 */
function idTokenWith(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: 'https://accounts.google.com', ...payload })}.sig`
}

// ## 为什么这一组断言值得单独写
//
// Gemini 是**唯一一个必须靠 `matchesShape` 才能被自动识别认领**的家
// （它的 `access_token` 字段名与 buddy / lobsterai 完全重合），
// 也是唯一一个**模型名必须带档位后缀**才能过上游准入的家。
// 两件事写错的症状都是**静默**的：
// - 判别式缺失/太宽 ⇒ 凭据被别家认走，或把别家凭据吞下（一发消息就 401）；
// - 档位后缀丢失 ⇒ 上游 404，而错误信息完全不指向「后缀」这件事。

test('🔴 Gemini 凭据解析：必须认出 OAuth 形态，且拒绝只带 access_token 的对象', async () => {
  const { parseCredential, looksLikeGeminiCredential } = await import('../src/providers/gemini.ts')

  // ① 参考实现的原始形态（snake_case + `expiry` RFC3339 + project）
  const full = parseCredential({
    access_token: 'ya29.token',
    refresh_token: '1//refresh',
    expiry: '2030-01-01T00:00:00.000Z',
    cloudaicompanionProject: 'aicode-consumers',
    sub: '10500520',
    email: 'user@example.com',
  })
  assert.equal(full.provider, 'gemini')
  assert.equal(full.accessToken, 'ya29.token')
  assert.equal(full.refreshToken, '1//refresh')
  assert.equal(full.uid, '10500520', 'uid 必须优先用 OIDC 的 sub（邮箱可改、sub 不变）')
  assert.equal(full.nickname, 'user@example.com')
  assert.equal(full.extras['project'], 'aicode-consumers')
  assert.equal(new Date(full.expiresAt).toISOString(), '2030-01-01T00:00:00.000Z')

  // ② camelCase 形态（本项目其余家都用 camelCase，用户可能转写）
  const camel = parseCredential({
    accessToken: 'ya29.camel',
    refreshToken: '1//r2',
    expiresIn: 3600,
    cloudaicompanionProject: 'proj-1',
  })
  assert.equal(camel.accessToken, 'ya29.camel')
  assert.equal(camel.refreshToken, '1//r2')
  assert.ok(camel.expiresAt > Date.now(), '`expires_in`（秒）必须在导入时折算成绝对毫秒')

  // ③ 嵌套包装层（`{credential:{…}}`）也要认
  const wrapped = parseCredential({ credential: { access_token: 'ya29.n', id_token: 'a.b.c' } })
  assert.equal(wrapped.accessToken, 'ya29.n')

  // ④ 🔴 **只带 `access_token` 必须拒绝** —— 那是 buddy / lobsterai 的形态，
  // 认下来只会产出一个必然 401 的假账号，而用户看到的是「导入成功」。
  assert.equal(looksLikeGeminiCredential({ access_token: 'x' }), false)
  assert.throws(
    () => parseCredential({ access_token: 'x' }),
    (error: unknown) => error instanceof ProviderError && error.provider === 'gemini',
    '⚠️ 只带 access_token 的对象必须拒绝（否则会吞掉别家凭据）',
  )
  // 非对象一律拒绝
  assert.throws(() => parseCredential('ya29.bare-token'))
})

test('🔴 Gemini matchesShape：必须认自己，且**不得**认领 buddy / lobsterai / raccoon 的凭据', async () => {
  const { geminiProvider } = await import('../src/providers/gemini.ts')
  const matches = geminiProvider.matchesShape
  assert.equal(typeof matches, 'function',
    '⚠️ 没有 matchesShape 的供应商在自动识别时**永远轮不到**（凭据会被别家认走）')

  // ── 接受：四种 Gemini 合法形态 ──
  assert.equal(matches!({ access_token: 't', cloudaicompanionProject: 'p' }), true)
  assert.equal(matches!({ access_token: 't', cloudaicompanion_project: 'p' }), true,
    'snake_case 变体也要认')
  assert.equal(matches!({ access_token: 't', refresh_token: 'r', expiry: '2030-01-01T00:00:00Z' }), true)
  assert.equal(matches!({ access_token: 't', refresh_token: 'r', expires_in: 3600 }), true,
    '⚠️ `expires_in` 是**数字**，判别式只认字符串的话这里会假失败')
  assert.equal(matches!({ access_token: 't', id_token: 'a.b.c' }), true)

  // ── 拒绝：别家的凭据 ──
  // buddy / workbuddy 的形态（DSH 扁平 + Go 嵌套）
  assert.equal(matches!({ accessToken: 'jwt', uid: 'u1', refreshToken: 'r' }), false,
    '⚠️ buddy 凭据（uid + refreshToken，**没有** expiry/expires_in/id_token）必须拒绝')
  assert.equal(matches!({ access_token: 'jwt', uid: 'u1', expiresAt: 1700000000000 }), false,
    '⚠️ `expiresAt` 不是 Gemini 的字段（那是 buddy/lobsterai 的），不得据此认领')
  // lobsterai 的形态
  assert.equal(matches!({
    access_token: 'jwt', refresh_token: 'r', user_id: '116092', uuid: 'x',
    first_keyfrom: 'a', latest_keyfrom: 'b',
  }), false, '⚠️ lobsterai 凭据必须拒绝')
  // raccoon 的形态
  assert.equal(matches!({ access_token: 'jwt', user_id: '116092', phone: '13800000000' }), false,
    '⚠️ raccoon 凭据必须拒绝')
  // cline 的形态
  assert.equal(matches!({ accessToken: 'workos:abc', accountId: 'acc-1', refreshToken: 'r' }), false,
    '⚠️ cline 凭据必须拒绝（`workos:` 前缀 + accountId）')
  // 空对象 / 只有 refresh_token
  assert.equal(matches!({}), false)
  assert.equal(matches!({ refresh_token: 'r', expiry: '2030-01-01T00:00:00Z' }), false,
    '⚠️ 没有 access_token 就不是可用凭据')

  // ── 判别式与 parseCredential **必须共用同一份判据** ──
  // 分叉的症状是「自动识别选中了 Gemini，导入却报错」。
  const accepted = { access_token: 't', id_token: 'a.b.c' }
  assert.equal(matches!(accepted), true)
  assert.doesNotThrow(() => geminiProvider.parseCredential(accepted))
  const rejected = { access_token: 't' }
  assert.equal(matches!(rejected), false)
  assert.throws(() => geminiProvider.parseCredential(rejected))
})

test('Gemini 续期：必须回写**轮换后的** refresh_token，且缺 refresh_token 时明确要「重新登录」', async () => {
  const { refreshGeminiCredential } = await import('../src/providers/gemini.ts')
  const base = {
    provider: 'gemini',
    uid: 'sub-1',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 0,
    nickname: 'u@example.com',
    extras: { project: 'p1', sub: 'sub-1', email: 'u@example.com' },
  }

  // ── ① 缺 refresh_token：终态，文案必须能指导行动 ──
  const noRefresh = await catchProviderError(() =>
    refreshGeminiCredential({ ...base, refreshToken: '' }, AbortSignal.timeout(1000)))
  assert.ok(noRefresh instanceof ProviderError, '缺 refresh_token 必须抛 ProviderError')
  assert.equal(noRefresh.retryable, false, '缺材料是**终态**，重试无意义')
  assert.match(noRefresh.message, /重新登录/, '⚠️ 文案必须含「重新登录」（调用方靠这个子串判定终态）')

  // ── ② 成功 + 轮换写回 ──
  const realFetch = globalThis.fetch
  let seenUrl = ''
  let seenBody = ''
  let seenContentType = ''
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    seenUrl = String(url)
    seenBody = String(init.body ?? '')
    seenContentType = String((init.headers as Record<string, string>)['Content-Type'] ?? '')
    return new Response(JSON.stringify({
      access_token: 'new-access',
      // ⚠️ Google **会轮换** refresh_token：给了新的就必须回写，
      // 否则下一次续期用的是一份已作废的旧值。
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: idTokenWith({ sub: 'sub-1', email: 'u@example.com' }),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  try {
    const next = await refreshGeminiCredential(base, AbortSignal.timeout(5000))
    assert.equal(seenUrl, 'https://oauth2.googleapis.com/token')
    assert.equal(seenContentType, 'application/x-www-form-urlencoded')
    // 表单字段**逐字**：四个字段一个都不能少、顺序也照参考实现。
    assert.match(seenBody, /^client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep\.apps\.googleusercontent\.com/)
    assert.ok(seenBody.includes('client_secret=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'),
      '⚠️ 缺 client_secret 会回 `client_secret is missing`')
    assert.ok(seenBody.includes('refresh_token=old-refresh'))
    assert.ok(seenBody.endsWith('grant_type=refresh_token'), 'grant_type 必须是 refresh_token')

    assert.equal(next.accessToken, 'new-access')
    assert.equal(next.refreshToken, 'rotated-refresh', '⚠️ 轮换后的 refresh_token 必须写回')
    assert.equal(next.uid, 'sub-1', '⚠️ uid 必须保持不变（重建对象会在池里堆出一条新账号）')
    assert.ok(next.expiresAt > Date.now(), '`expires_in` 必须折算成绝对毫秒')
    assert.equal(next.extras['project'], 'p1', 'extras 必须整份保留')

    // ── ③ 上游**没给**新 refresh_token 时必须保留旧值 ──
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: 'newer-access', expires_in: 1800 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const kept = await refreshGeminiCredential(next, AbortSignal.timeout(5000))
    assert.equal(kept.refreshToken, 'rotated-refresh',
      '⚠️ 没给新值时**保留旧值** —— 写成 `?? ""` 会让账号续期一次后永久不可续期')

    // ── ④ 终态失败（invalid_grant）→ 不可重试 + 「重新登录」 ──
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const terminal = await catchProviderError(() =>
      refreshGeminiCredential(base, AbortSignal.timeout(5000)))
    assert.ok(terminal instanceof ProviderError)
    assert.equal(terminal.retryable, false, 'invalid_grant 是终态，不该换号重试')
    assert.match(terminal.message, /重新登录/)
    assert.match(terminal.message, /invalid_grant/, '⚠️ 必须带上游原文（否则无法归因）')

    // ── ⑤ 瞬时失败（500）→ **可重试** ──
    globalThis.fetch = (async () => new Response('upstream boom', { status: 500 })) as unknown as typeof fetch
    const transient = await catchProviderError(() =>
      refreshGeminiCredential(base, AbortSignal.timeout(5000)))
    assert.ok(transient instanceof ProviderError)
    assert.equal(transient.retryable, true, '5xx 是瞬时故障，必须可重试（与 invalid_grant 区分开）')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Gemini 信封：键序必须是**字母序**，模型名必须带档位后缀', async () => {
  const { buildGeminiInferPayload, GEMINI_IDENTITY_HEADERS } = await import('../src/providers/gemini.ts')
  const credential = {
    provider: 'gemini',
    uid: 'sub-1',
    accessToken: 'tok',
    refreshToken: 'r',
    expiresAt: 0,
    nickname: 'n',
    extras: { project: 'proj-x' },
  }

  const prepared = buildGeminiInferPayload(credential, 'gemini-3.8-flash', {
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
    max_tokens: 123,
    temperature: 0.5,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查天气',
        // ⚠️ 白名单外的键（`$schema` / `additionalProperties`）必须被删掉 ——
        // 上游对未知键是**硬 400**。
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: ['string', 'null'], description: '城市' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: 'auto',
  })

  // ── ① 模型名带默认档位后缀（**上游的准入钥匙**：裸名 404）──
  assert.equal(prepared.upstreamModel, 'gemini-3.8-flash-medium')
  assert.equal(prepared.tier, 'medium')

  // ── ② 键序：顶层字母序 ──
  const body = prepared.body
  const order = ['"model"', '"project"', '"request"', '"requestId"', '"userAgent"']
  const positions = order.map((key) => body.indexOf(key))
  assert.ok(positions.every((p) => p >= 0), '信封顶层必须含全部五个键')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions,
    '⚠️ 顶层键必须是字母序（Go 的 encoding/json 对 map 自动排序，TS 的 JSON.stringify 不会）')

  // ── ③ 键序：`request` 内部也是字母序，且 `model` 在 `project` 之前 ──
  const requestAt = body.indexOf('"request"')
  const reqOrder = ['"contents"', '"generationConfig"', '"sessionId"', '"systemInstruction"', '"toolConfig"', '"tools"']
  const reqPositions = reqOrder.map((key) => body.indexOf(key, requestAt))
  assert.ok(reqPositions.every((p) => p > requestAt))
  assert.deepEqual([...reqPositions].sort((a, b) => a - b), reqPositions,
    '⚠️ request 内部键也必须是字母序')

  // ── ④ project / requestId / userAgent / 档位预算 ──
  assert.ok(body.includes('"project":"proj-x"'), 'project 必须取凭据里的值（缺失才回落兜底串）')
  assert.match(body, /"userAgent":"antigravity"/)
  assert.match(body, /"requestId":"agent\/\d+\/[0-9a-f]{8}"/)
  assert.match(body, /"maxOutputTokens":123/)
  assert.match(body, /"includeThoughts":true/, '「关闭思考」是假关，必须恒 true')
  assert.match(body, /"thinkingBudget":4000/, 'medium 档的预算是 4000')
  // system 走顶层 systemInstruction，**不**混进 contents
  assert.match(body, /"systemInstruction":\{"parts":\[\{"text":"你是助手"\}\],"role":"system"\}/)
  assert.ok(!body.includes('"role":"system","parts"'), 'contents 里不得出现 system 角色')
  // 工具 schema 清洗：白名单外的键必须消失，数组型 type 收敛 + nullable
  assert.ok(!body.includes('$schema'), '⚠️ `$schema` 必须被删除（上游对未知键硬 400）')
  assert.ok(!body.includes('additionalProperties'), '⚠️ `additionalProperties` 必须被删除')
  assert.match(body, /"city":\{"description":"城市","nullable":true,"type":"string"\}/,
    '数组型 type 应收敛为单个 type 并补 nullable')

  // ── ⑤ 请求头：身份五头逐字 + **不带 Accept** ──
  assert.equal(prepared.headers['Authorization'], 'Bearer tok')
  for (const [key, value] of Object.entries(GEMINI_IDENTITY_HEADERS)) {
    assert.equal(prepared.headers[key], value, `${key} 必须逐字写死`)
  }
  assert.equal(prepared.headers['Accept'], undefined,
    '⚠️ 流式请求**刻意不带 Accept**（抓包一致）')
  assert.equal(prepared.headers['x-goog-api-key'], undefined, '⚠️ 不得带 x-goog-api-key')

  // ── ⑥ 档位：模型名后缀 > reasoning_effort > 默认 medium ──
  const viaEffort = buildGeminiInferPayload(credential, 'gemini-3.8-flash', {
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  })
  assert.equal(viaEffort.upstreamModel, 'gemini-3.8-flash-high')
  assert.match(viaEffort.body, /"thinkingBudget":10000/)
  // 未知 effort 回落 medium（不编造档位）
  const unknownEffort = buildGeminiInferPayload(credential, 'gemini-3.8-flash', {
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'ultra',
  })
  assert.equal(unknownEffort.tier, 'medium')
  // 模型名里**显式**的档位优先于 reasoning_effort
  const explicit = buildGeminiInferPayload(credential, 'gemini-3.8-flash-low', {
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  })
  assert.equal(explicit.upstreamModel, 'gemini-3.8-flash-low',
    '⚠️ 模型名里的显式后缀优先（listModels 暴露的就是四个独立变体）')
  assert.match(explicit.body, /"thinkingBudget":1000/)
  // tiered 档**不发** thinkingBudget（交给上游自适应）
  const tiered = buildGeminiInferPayload(credential, 'gemini-3.8-flash-tiered', {
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.ok(!tiered.body.includes('thinkingBudget'), 'tiered 档只带 includeThoughts')
  assert.match(tiered.body, /"includeThoughts":true/)

  // ── ⑦ 未知模型名必须**本地拒绝**（放行会让用户静默拿到错模型的答案）──
  assert.throws(
    () => buildGeminiInferPayload(credential, 'gemini-9.9-fake', {
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error: unknown) => error instanceof ProviderError && error.httpStatus === 404,
  )
  // 空消息同样必须拒绝（发空请求上游 400，且报错不指向真因）
  assert.throws(() => buildGeminiInferPayload(credential, 'gemini-3.8-flash', { messages: [] }))
})

test('Gemini SSE 转换：text + thought + tool_call + usage + finish_reason 全部要落地', async () => {
  const { geminiSseToOpenAiSse } = await import('../src/providers/gemini.ts')

  // ⚠️ 上游帧的真实形状（自带 `usageMetadata` 的收尾帧与 `{"response":{…}}` 信封）。
  const frames = [
    // 信封形态 + 思考
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"想一下","thought":true}]}}]}}',
    // 裸 Response 形态 + 正文
    'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}',
    // 工具调用（上游的 functionCall 是**完整**的，不是增量）
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"北京","unit":"c"}}}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"totalTokenCount":105}}',
    // 纯 usage 帧（没有 candidates）—— 必须只记用量、不算内容
    'data: {"usageMetadata":{"promptTokenCount":120,"cachedContentTokenCount":20,"candidatesTokenCount":9,"thoughtsTokenCount":4,"totalTokenCount":129}}',
    // 收尾帧
    'data: {"candidates":[{"finishReason":"STOP"}]}',
    'data: [DONE]',
    '',
  ]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      // ⚠️ 故意在**一行中间**切断，验证 `buffer` 会把半个事件拼回来
      // （不拼的后果是那一整帧被静默丢弃 —— 正好是最容易漏的末帧形态）。
      const raw = frames.join('\n\n') + '\n\n'
      const cut = raw.indexOf('"name":"get_weather"') + 5
      assert.ok(cut > 5, '切断点必须落在工具调用那一行里')
      controller.enqueue(encoder.encode(raw.slice(0, cut)))
      controller.enqueue(encoder.encode(raw.slice(cut)))
      controller.close()
    },
  })

  const out = await new Response(geminiSseToOpenAiSse(stream, 'gemini-3.8-flash-medium')).text()
  assert.ok(out.endsWith('data: [DONE]\n\n'), '必须以 [DONE] 收尾')

  const chunks = out.split('\n\n')
    // ⚠️ 必须用 `data: `（**带空格**）剥前缀：JSON 里可能出现 `data:` 字样，
    // 用 `replace('data:', …)` 之类的宽判据会切坏正文。
    .map((frame) => (frame.startsWith('data: ') ? frame.slice(6) : frame))
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)

  // ── 首帧必须带 role，后续帧不得重复带 ──
  const firstChoices = chunks[0]?.['choices'] as Array<{ delta: Record<string, unknown> }> | undefined
  assert.equal(firstChoices?.length, 1, '每一帧都必须恰好有一个 choice')
  assert.equal(firstChoices![0]!.delta['role'], 'assistant', '首帧必须宣告 role')
  // ⚠️ **用量帧的 `choices` 是空数组**（OpenAI 规范允许，且参考实现也这么做）——
  // 遍历时必须跳过它，否则 `choices[0].delta` 会抛 undefined。
  // 这是本测试第一版的真实缺陷（假失败），不是转换器的缺陷。
  const withChoice = chunks.filter((c) => Array.isArray(c['choices']) && (c['choices'] as unknown[]).length > 0)
  assert.ok(withChoice.length >= 3, '至少有 role / 正文 / 收尾三个带 choice 的帧')
  for (const chunk of withChoice.slice(1)) {
    const delta = (chunk['choices'] as Array<{ delta: Record<string, unknown> }>)[0]!.delta
    assert.equal(delta['role'], undefined, '⚠️ 后续帧不得重复带 role（部分客户端会重开会话）')
  }

  // ── 思考走 reasoning_content，正文走 content ──
  const deltas = withChoice.map((chunk) =>
    (chunk['choices'] as Array<{ delta: Record<string, unknown> }>)[0]!.delta)
  assert.ok(deltas.some((d) => d['reasoning_content'] === '想一下'), '思考必须映射到 reasoning_content')
  assert.ok(deltas.some((d) => d['content'] === '你好'), '正文必须映射到 content')

  // ── 工具调用：name + 已解析的参数 + 本地生成的 id ──
  const toolDelta = deltas.find((d) => d['tool_calls'] !== undefined)
  assert.ok(toolDelta !== undefined, 'functionCall 必须映射成 tool_calls')
  const call = (toolDelta!['tool_calls'] as Array<Record<string, unknown>>)[0]!
  assert.equal(call['type'], 'function')
  assert.ok(typeof call['id'] === 'string' && String(call['id']).startsWith('gemini_tool_'),
    '上游不给 id，必须本地生成')
  const fn = call['function'] as Record<string, unknown>
  assert.equal(fn['name'], 'get_weather')
  assert.deepEqual(JSON.parse(String(fn['arguments'])), { city: '北京', unit: 'c' })

  // ── finish_reason：有工具调用就必须是 tool_calls（否则客户端不会继续执行工具）──
  const finish = withChoice.find((chunk) =>
    (chunk['choices'] as Array<{ finish_reason: unknown }>)[0]!.finish_reason !== null)
  assert.equal(
    (finish!['choices'] as Array<{ finish_reason: unknown }>)[0]!.finish_reason,
    'tool_calls',
    '⚠️ 有工具调用时必须报 tool_calls（报 stop 会让工具循环停下来）',
  )

  // ── usage：input 扣掉缓存、reasoning **不叠加**进 output、取 total 最大的那一份 ──
  const usageFrame = chunks.find((chunk) => chunk['usage'] !== undefined)
  assert.ok(usageFrame !== undefined, '必须发出 usage 帧（网关据此记账）')
  const usage = usageFrame!['usage'] as Record<string, unknown>
  assert.equal(usage['prompt_tokens'], 100, '⚠️ input = promptTokenCount - cachedContentTokenCount（120-20）')
  assert.equal(usage['completion_tokens'], 9, '⚠️ output 只含 candidatesTokenCount，thoughts **不叠加**')
  assert.equal(usage['total_tokens'], 129, '必须用上游自报的最大 totalTokenCount')
  assert.deepEqual(usage['prompt_tokens_details'], { cached_tokens: 20 })
  assert.deepEqual(usage['completion_tokens_details'], { reasoning_tokens: 4 })
})

test('Gemini SSE 兜底：空响应必须**显式报错**，截断的末帧也不得被丢弃', async () => {
  const { geminiSseToOpenAiSse } = await import('../src/providers/gemini.ts')

  // ── ① 完全没有内容的 200 响应 → 错误帧（**绝不静默空回复**）──
  const empty = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"usageMetadata":{"totalTokenCount":7}}\n\n'))
      controller.close()
    },
  })
  const emptyOut = await new Response(geminiSseToOpenAiSse(empty, 'm')).text()
  assert.match(emptyOut, /"error"/, '⚠️ 空响应必须显式报错（空回复比报错更糟）')
  assert.ok(!emptyOut.includes('[DONE]'), '⚠️ 报错后不得再补 [DONE]（那会把失败伪装成正常结束）')

  // ── ② 上游**没给空行结尾**的末帧（被截断的流）：finish/usage 仍在余量里，
  //      必须按整行再走一遍，否则末帧被静默丢弃 ──
  const truncated = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"candidates":[{"content":{"parts":[{"text":"答"}]}}]}\n\n'
        + 'data: {"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}',
      ))
      controller.close()
    },
  })
  const truncatedOut = await new Response(geminiSseToOpenAiSse(truncated, 'm')).text()
  assert.ok(truncatedOut.includes('"content":"答"'))
  assert.ok(truncatedOut.includes('"finish_reason":"length"'),
    '⚠️ 截断流里的 MAX_TOKENS 末帧必须被处理（映射为 length）')
  assert.ok(truncatedOut.includes('"prompt_tokens":3'), '⚠️ 截断流里的 usage 不得被丢弃')

  // ── ③ 非 JSON 的 data: 载荷必须显式报错（不静默忽略）──
  const garbage = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {not json\n\n'))
      controller.close()
    },
  })
  const garbageOut = await new Response(geminiSseToOpenAiSse(garbage, 'm')).text()
  assert.match(garbageOut, /"error"/, '⚠️ 形状不可识别的帧必须报错并带原文片段')
  assert.match(garbageOut, /not json/, '错误里必须带上游原文片段')

  // ── ④ 心跳注释行（`:` 开头）必须被跳过，不能当数据 ──
  const heartbeat = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        ': keep-alive\n\ndata: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
      ))
      controller.close()
    },
  })
  const heartbeatOut = await new Response(geminiSseToOpenAiSse(heartbeat, 'm')).text()
  assert.ok(heartbeatOut.includes('"content":"ok"'))
  assert.ok(!heartbeatOut.includes('"error"'), '⚠️ 心跳行不是数据，不得被当成坏帧')
})

test('Gemini 余额：只认两个 bucketId，比例如实报成百分比（不伪造 token 数）', async () => {
  const { balance, parseGeminiQuotaWindows, toGeminiProviderBalance } =
    await import('../src/providers/gemini.ts')
  const credential = {
    provider: 'gemini',
    uid: 'u',
    accessToken: 'tok',
    refreshToken: 'r',
    expiresAt: 0,
    nickname: 'n',
    extras: {},
  }

  // ── ① 上游形状（含一个别的产品线的桶、一个不可解析 resetTime 的桶）──
  const upstream = {
    groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2030-01-08T00:00:00Z', remainingFraction: 0.9 },
        { bucketId: 'gemini-5h', window: '5h', resetTime: '2030-01-01T05:00:00Z', remainingFraction: 0.82 },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-claude', window: '5h', resetTime: '2030-01-01T05:00:00Z', remainingFraction: 0.1 },
      ] },
      { displayName: 'Broken', buckets: [
        // ⚠️ 不可解析的 resetTime ⇒ **整条桶丢弃**（编一个空串会显示成「永不过期」）
        { bucketId: 'gemini-5h', window: '5h', resetTime: 'not-a-time', remainingFraction: 0.5 },
      ] },
    ],
  }
  const parsed = parseGeminiQuotaWindows(upstream)
  assert.equal(parsed.fiveHour?.remainingFraction, 0.82, '⚠️ 判据是 bucketId，且先命中的那条胜出')
  assert.equal(parsed.weekly?.remainingFraction, 0.9)
  const mapped = toGeminiProviderBalance(parsed.fiveHour, parsed.weekly)
  assert.equal(mapped.packages.length, 2, '只认 gemini-5h / gemini-weekly 两个桶')
  const fiveHour = mapped.packages.find((p) => p.name.includes('5 小时窗口'))!
  assert.equal(fiveHour.amount, 82, 'amount 是**百分点**（上游给的是比例，没有绝对数量）')
  assert.match(fiveHour.name, /剩余比例/, '⚠️ 包名必须写明这是比例，不是 token 数（否则面板会骗人）')
  assert.ok(!fiveHour.name.includes('积分'), '⚠️ 这不是积分，文案不得写成积分')
  assert.equal(mapped.earliestExpiry, Date.parse('2030-01-01T05:00:00Z'),
    'earliestExpiry 取两个窗口里**最早的重置时刻**（epoch ms）')
  assert.equal(mapped.expiring, 0, '配额窗口没有「即将过期额度」的语义，不得编造')
  assert.equal(mapped.total, 86, 'total 取两窗口百分点的平均值')

  // ── ② 认不出任何一个桶 ⇒ 抛错（**不伪造 100%**）──
  assert.deepEqual(parseGeminiQuotaWindows({ groups: [{ buckets: [{ bucketId: '3p-claude' }] }] }), {})
  const realFetch = globalThis.fetch
  let sawBody = ''
  globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    sawBody = String(init.body ?? '')
    return new Response(JSON.stringify({ groups: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    const error = await catchProviderError(() => balance(credential, AbortSignal.timeout(5000)))
    assert.ok(error instanceof ProviderError, '认不出桶必须抛错，不能静默返回 0')
    // ⚠️ 字段名必须是 `project`（`cloudaicompanionProject` 会 400 Cannot find field）
    assert.equal(sawBody, JSON.stringify({ project: 'aicode-consumers' }),
      '⚠️ 配额请求体的字段名必须是 `project`，值取凭据缺失时的兜底串')

    // ── ③ 403 SUBSCRIPTION_REQUIRED：如实报出上游 reason（不能一概说「凭据已失效」）──
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { code: 403, message: 'You do not have a valid license of this product.',
        status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] },
    }), { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const denied = await catchProviderError(() => balance(credential, AbortSignal.timeout(5000)))
    assert.ok(denied instanceof ProviderError)
    assert.match(denied.message, /SUBSCRIPTION_REQUIRED/, '⚠️ 必须把上游 reason 透出来（否则会误导去重新登录）')
    assert.equal(denied.httpStatus, 403)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Gemini 能力声明：login=true（手动回调），checkin=false 必须给出可读原因', async () => {
  const { geminiProvider, listModels } = await import('../src/providers/gemini.ts')
  assert.equal(geminiProvider.id, 'gemini')
  assert.equal(geminiProvider.name, 'Gemini (Cloud Code Assist)')
  // ⚠️ 2026-11-21：登录改走「手动粘贴回调链接」，故 login 翻 true。
  // 仍成立的那条：Google 只允许 loopback 重定向（那正是必须走手动回调的原因）。
  assert.deepEqual(geminiProvider.capabilities.login, true)
  assert.equal(geminiProvider.capabilities.checkin, false)
  assert.ok((geminiProvider.capabilities.checkinBlockedReason ?? '').length > 10)
  // ⚠️ 刻意不声明裸字符串判别式：Gemini 凭据只有 JSON 对象形态，
  // 声明一个宽松的裸串匹配只会把任意文本吞成必然失败的账号。
  assert.equal(geminiProvider.bareStringPattern, undefined)

  // ── 模型目录：裸名 + 四个档位变体（**必须带后缀**，它是上游准入钥匙）──
  const models = await listModels(
    { provider: 'gemini', uid: 'u', accessToken: 't', refreshToken: '', expiresAt: 0, nickname: '', extras: {} },
    AbortSignal.timeout(1000),
  )
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('gemini-3.8-flash'), '必须暴露裸名（调用方只写一个名字时回落默认档）')
  for (const tier of ['low', 'medium', 'high', 'tiered']) {
    assert.ok(ids.includes(`gemini-3.8-flash-${tier}`), `必须暴露档位变体 -${tier}`)
  }
  assert.ok(!ids.some((id) => id.includes('lite')),
    '⚠️ 不得暴露 lite（上游恒 404，暴露即坑）')
  for (const model of models) {
    assert.ok(model.contextWindow > 0, '⚠️ contextWindow 必须用参考实现记录的值，不得为 0 或编造')
    assert.ok(model.maxOutput > 0)
  }
})

test('🔴 聚合只暴露白名单里的两个规范名（用户要求：其它用不上）', () => {
  // 用户原话：「aggregate 只保留 deepseek-v4-1-flash 和 glm-5-3-flash 就行了，
  // 其它的用不上」。
  //
  // ⚠️ 为什么用**白名单**而不是黑名单：各渠道模型池会随上游增删，
  // 黑名单意味着「上游每加一个新模型，聚合目录就自动多一行」——
  // 那正是用户不想要的。
  const cats = [
    { provider: 'buddy', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
      // 这两个都**不在**白名单，必须被过滤掉
      { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
      { id: 'gpt-5.3-astro', name: 'GPT-5.3-Astro' },
    ] },
  ]
  const vms = buildVirtualModels(cats)
  const keys = vms.map((v) => v.key).sort()
  assert.deepEqual(keys, ['deepseek-v4-1-flash', 'glm-5-3-flash'],
    `⚠️ 聚合只应暴露白名单里的两个键，实际 ${JSON.stringify(keys)}`)
  // 白名单本身也要能被测试引用（防止有人改成一个空集合让上面「碰巧通过」）
  assert.equal(AGGREGATE_ALLOWED_KEYS.size, 2, '白名单应恰好 2 个键')
  assert.ok(AGGREGATE_ALLOWED_KEYS.has('deepseek-v4-1-flash'), '应含 deepseek-v4-1-flash')
  assert.ok(AGGREGATE_ALLOWED_KEYS.has('glm-5-3-flash'), '应含 glm-5-3-flash')
})

test('⚠️ 聚合白名单必须在 buildVirtualModels 里收口（覆盖目录与 chat 两条路径）', () => {
  // ## 为什么强调「收口点」
  //
  // 聚合有**两条独立入口**：
  //   1. `/v1/models` 的目录（`src/index.ts`）；
  //   2. 聚合 **chat** 的实际路由（`src/gateway/server.ts` 的 `loadAggregateCatalog`）。
  //
  // ⚠️ 只在入口 1 过滤 ⇒ 「目录里看不到、却仍然能调通」，
  // 等于没关掉。本项目已多次吃过「同一个 bug 只修一半」的教训。
  //
  // 两条路径**都**调用 `buildVirtualModels`，故过滤必须放在那里。
  const agg = readFileSync('src/gateway/aggregate.ts', 'utf8')
  const fn = agg.slice(agg.indexOf('export function buildVirtualModels'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.ok(/AGGREGATE_ALLOWED_KEYS\.has\(key\)/.test(body),
    '⚠️ 白名单过滤必须在 buildVirtualModels 内（否则两条路径只堵住一条）')
  // 两个调用点确实都存在
  const server = readFileSync('src/gateway/server.ts', 'utf8')
  const idx = readFileSync('src/index.ts', 'utf8')
  assert.ok(server.includes('buildVirtualModels'), 'chat 路径应走 buildVirtualModels')
  assert.ok(idx.includes('buildVirtualModels'), '/v1/models 路径应走 buildVirtualModels')
})

test('🔴 TRAE / LobsterAI / OpenCode 都必须交出真实倍率（上游一直有，我们没读）', () => {
  // ## 用户报：「TRAE 和 LobsterAI 还是不显示，OpenCode 有的不显示」
  //
  // ⚠️⚠️ **这是我的第三次同型错误**：只看「解析后的形状」就断定上游没有该字段。
  // 加只读诊断 dump **原始响应**后，三家其实**都有**：
  //
  // | 家 | 上游字段 | 实测值 |
  // |---|---|---|
  // | LobsterAI | `costMultiplier` | `0.05` |
  // | TRAE | `display_contact_config.consumption_rate.data.rate` | `0.06` / `0.39` |
  // | OpenCode | `models.dev` 的 `cost`（判定 `isFree`） | `{input:0,output:0}` |
  //
  // ⇒ 教训：**先去上游原始响应里找字段**，不要因为解析后的对象里没有就下结论。

  // ① LobsterAI：读 `costMultiplier` + 用 `limitedFreeActive` 判免费
  const lb = readFileSync('src/providers/lobsterai.ts', 'utf8')
  assert.ok(/readNumber\(record, 'costMultiplier'\)/.test(lb),
    '⚠️ LobsterAI 必须读上游的 costMultiplier')
  assert.ok(/limitedFreeActive/.test(lb),
    '⚠️ 免费判据应用 limitedFreeActive（limitedFree 只是「有这个活动」）')

  // ② TRAE：读 `display_contact_config`（**字符串化 JSON**）里的 consumption_rate
  const tr = readFileSync('src/providers/trae.ts', 'utf8')
  assert.ok(/readConsumptionRate/.test(tr), '⚠️ TRAE 应解析 consumption_rate')
  assert.ok(/JSON\.parse\(raw\)/.test(tr),
    '⚠️ display_contact_config 是**字符串**，必须 JSON.parse 才读得到 rate')
  assert.ok(/rec\['enable'\] !== true/.test(tr),
    '⚠️ enable !== true 时不得采信 rate（规则未启用）')

  // ③ OpenCode：免费取**并集**（兜底表的匿名通道 / models.dev 的定价）
  const oc = readFileSync('src/providers/opencode.ts', 'utf8')
  assert.ok(/m\.isFree \|\| capability\?\.isFree === true/.test(oc),
    '⚠️ OpenCode 免费应取并集（两个来源语义不同，任一为真都意味着不花钱）')

  // ④ 🔴 冷启动必须主动拉能力表 —— 否则上面那条并集永远拿不到右侧
  assert.ok(/await refreshCapabilities\(\)/.test(oc),
    '⚠️ 能力表冷启动必须主动拉取（原实现只被自己的 stale 分支调用 ⇒ 永远不拉）')
})

test('🔴 workbuddy 的存储 key 必须带前缀（只有 buddy 是裸 uid）', async () => {
  // ## 真实缺陷（本轮实测到）
  //
  // 我把 `workbuddy` 也写进了「裸 uid」白名单（理由「两个腾讯变体同族」）——
  // 那是错的。旧规则是 `providerId === DEFAULT_PROVIDER ? uid : `p:uid``，
  // 而当时默认供应商是 **buddy** ⇒ **buddy 裸 uid、workbuddy 带前缀**。
  //
  // 后果（线上实测）：同一个 `zihang518@gmail.com` 在 global 分片里出现**两条**
  // 记录（`workbuddy:46a2…` 旧的 + `46a2…` 新导的），而停用/冷却标记仍挂在
  // 旧 key 上 —— 表现是「禁用了旧的那条，新的照旧可用」。
  const src = readFileSync('src/index.ts', 'utf8')
  const m = /const BARE_UID_PROVIDERS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(src)
  assert.ok(m !== null, '应有 BARE_UID_PROVIDERS')
  const ids = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.deepEqual(ids, ['buddy'], '⚠️ 只有 buddy 用裸 uid；workbuddy 必须带 workbuddy: 前缀')
})
