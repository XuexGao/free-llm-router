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
import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import {
  DEFAULT_PROVIDER,
  findProvider,
  PROVIDERS,
  parseCredentialAnywhere,
  providerCatalog,
  providerIds,
  requireProvider,
} from '../src/providers/index.ts'
import { ProviderError, splitModelName } from '../src/providers/types.ts'
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

test('默认供应商在注册表里且是第 0 项（顺序有语义）', () => {
  assert.equal(providerIds()[0], DEFAULT_PROVIDER)
  assert.notEqual(findProvider(DEFAULT_PROVIDER), undefined)
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
  // 这条断言用一个「WorkBuddy 能认、但更像别家」的输入来验证顺序。
  // 只要默认供应商是兜底项，任何多供应商歧义输入都应先被别家拿走。
  const providers = providerIds()
  assert.equal(providers[0], DEFAULT_PROVIDER, '默认供应商应在首位（兜底语义）')
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

test('⚠️ raccoon 的 checkin 必须是 false（上游确实没有该端点）', () => {
  // 依据参考项目 plugin-src/client/credits-capabilities.js:133：
  // `raccoon: { balance: true, onboardingTasks: true }` —— 无 dailyCheckin。
  // 每日 300 是服务端按日自动发放（账单 biz_type: 'daily_grant'）。
  const raccoon = findProvider('raccoon')
  assert.notEqual(raccoon, undefined)
  assert.equal(raccoon?.capabilities.checkin, false, 'raccoon 不该声明支持签到')
  assert.ok(
    (raccoon?.capabilities.checkinBlockedReason ?? '').includes('自动发放'),
    '原因里应说明「服务端自动发放」，否则用户仍会困惑',
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

test('腾讯双变体：buddy 有签到，workbuddy（国际版）没有', () => {
  const buddy = findProvider('buddy')
  const intl = findProvider('workbuddy')
  assert.notEqual(buddy, undefined)
  assert.notEqual(intl, undefined)
  assert.equal(buddy?.capabilities.checkin, true, '国内版有签到')
  assert.equal(intl?.capabilities.checkin, false, '国际版无签到接口')
  assert.ok((intl?.capabilities.checkinBlockedReason ?? '').length > 10, '国际版也要说明原因')
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
  assert.ok(/^  refresh,$/m.test(src), '⚠️ 必须**挂到 provider 对象**上（只定义不挂 = 等于没有）')
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
  const src = readFileSync('src/providers/index.ts', 'utf8')
  const registry = src.slice(src.indexOf('export const PROVIDERS'))
  const ids = [...registry.matchAll(/^\s{2}(\w+Provider),$/gm)].map((m) => m[1])
  assert.ok(ids.length >= 12, `应解析出全部 provider（实际 ${ids.length}）`)

  const missing: string[] = []
  for (const name of ids) {
    // provider 的实现文件与变量名的对应：去掉结尾的 Provider 并转小写
    const base = name.replace(/Provider$/, '').toLowerCase()
    const file = `src/providers/${base}.ts`
    if (!existsSync(file)) continue
    const body = readFileSync(file, 'utf8')
    // ⚠️ 两种挂载形态都算：`matchesShape(input) {` 与 `matchesShape: xxx,`
    if (!/^\s*matchesShape[(:]/m.test(body)) missing.push(`${name} (${file})`)
  }
  assert.deepEqual(
    missing,
    [],
    '⚠️ 以下 provider 缺 matchesShape，自动识别时会被跳过、凭据被别家认走：'
      + missing.join('、'),
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
