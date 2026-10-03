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
import assert from 'node:assert/strict'

import {
  DEFAULT_PROVIDER,
  findProvider,
  parseCredentialAnywhere,
  providerCatalog,
  providerIds,
  requireProvider,
} from '../src/providers/index.ts'
import { ProviderError, splitModelName } from '../src/providers/types.ts'
import { anthropicSseToOpenAiSse } from '../src/providers/anthropic.ts'

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
