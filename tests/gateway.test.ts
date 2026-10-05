/**
 * 网关纯函数单测：请求体准备、SSE 帧解析、错误帧识别。
 *
 * ## 为什么这些断言重要
 *
 * 网关的错误几乎全是**静默**的：
 * - `max_completion_tokens` 没翻译 → 上游回落默认上限 → **长回答被截断**（没有报错）；
 * - `tool_choice` 对象形式没归一化 → **400 code=11101**（错误信息不说是哪个字段）；
 * - 工具配对没清理 → 上游**对之后每条消息都 400**（整条会话报废）；
 * - 错误帧没识别 → 客户端看到「干净地停止、无任何报错」（最难排查的形态）。
 *
 * 故这里逐条把语义钉住。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import {
  cleanupToolPairing,
  ensureStreamOptions,
  normalizeToolChoice,
  prepareChatBody,
  sanitizeChatBody,
  translateMaxCompletionTokens,
} from '../src/gateway/payload.ts'
import { ERROR_HINT_PATTERN, USAGE_HINT_PATTERN, aggregateSse, detectErrorFrame, doneFrame, errorFrame, needsNormalize, normalizeFrame, normalizeToolCalls, parseSseLine, sseHeaders, translateFrame } from '../src/gateway/stream.ts'
import { extractModels } from '../src/gateway/models.ts'
import { isAuthLikeFailure, mapErrorToPunishment, parseBusinessCode, parseResetAt, refineModelScoped } from '../src/gateway/server.ts'

// ─────────────────────── max_completion_tokens 翻译 ───────────────────────

test('⚠️ max_completion_tokens 必须翻译成 max_tokens（否则长流被截断）', () => {
  const body: Record<string, unknown> = { max_completion_tokens: 4096 }
  translateMaxCompletionTokens(body)
  assert.equal(body.max_tokens, 4096, '别名应被翻译')
  assert.equal(body.max_completion_tokens, undefined, '别名应被删除（减少 body 体积）')
})

test('⚠️ 显式 max_tokens 优先：别名只删不译（不覆盖用户显式值）', () => {
  const body: Record<string, unknown> = { max_tokens: 1000, max_completion_tokens: 9999 }
  translateMaxCompletionTokens(body)
  assert.equal(body.max_tokens, 1000, '显式值不该被别名覆盖')
  assert.equal(body.max_completion_tokens, undefined)
})

test('非正数值的别名不翻译（0/null 是「未设置」语义，负数是非法值）', () => {
  for (const bad of [0, -1, null, 'not-a-number', undefined]) {
    const body: Record<string, unknown> = { max_completion_tokens: bad }
    translateMaxCompletionTokens(body)
    assert.equal(body.max_tokens, undefined, `${String(bad)} 不该变成 max_tokens`)
    assert.equal(body.max_completion_tokens, undefined, '别名无论如何都该删')
  }
})

// ─────────────────────── tool_choice 归一化 ───────────────────────

test('⚠️ tool_choice 对象形式必须归一化（上游只认 string，对象会 400 code=11101）', () => {
  const body: Record<string, unknown> = {
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }
  normalizeToolChoice(body)
  assert.equal(body.tool_choice, 'auto', '对象形式应降级为 auto（降级能成功，报错会让对话整体失败）')
})

test('tool_choice 字符串枚举原样保留', () => {
  for (const value of ['auto', 'none', 'required']) {
    const body: Record<string, unknown> = { tool_choice: value }
    normalizeToolChoice(body)
    assert.equal(body.tool_choice, value)
  }
})

test('tool_choice 未知字符串被删除（缺省即 auto）', () => {
  const body: Record<string, unknown> = { tool_choice: 'weird-value' }
  normalizeToolChoice(body)
  assert.equal(body.tool_choice, undefined)
})

test('tool_choice 缺省时不做任何事', () => {
  const body: Record<string, unknown> = {}
  normalizeToolChoice(body)
  assert.equal('tool_choice' in body, false)
})

// ─────────────────────── stream_options ───────────────────────

test('stream_options 缺省时补 include_usage（否则末帧没有 usage）', () => {
  const body: Record<string, unknown> = {}
  ensureStreamOptions(body)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('⚠️ 用户显式设置的 stream_options 被尊重（不覆盖）', () => {
  const body: Record<string, unknown> = { stream_options: { include_usage: false } }
  ensureStreamOptions(body)
  assert.deepEqual(body.stream_options, { include_usage: false }, '显式 false 应被尊重')
})

// ─────────────────────── 工具配对清理 ───────────────────────

test('⚠️ 孤儿 tool 消息必须被剔除（不完整配对会让之后每条消息都 400）', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    // 这条 tool 消息没有任何 assistant tool_calls 与之配对 → 孤儿
    { role: 'tool', tool_call_id: 'never-declared', content: 'result' },
    { role: 'assistant', content: 'ok' },
  ]
  const cleaned = cleanupToolPairing(messages)
  assert.equal(cleaned.length, 2, '孤儿 tool 消息应被丢弃')
  assert.ok(!cleaned.some((m) => (m as Record<string, unknown>).role === 'tool'))
})

test('配对的 tool 消息被保留', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'result' },
  ]
  const cleaned = cleanupToolPairing(messages)
  assert.equal(cleaned.length, 3, '完整配对不该被改动')
})

test('⚠️ 名称为空的 tool_call 必须剔除（会跨 provider 传染，报 11133 且不指出字段）', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: '', arguments: '{}' } }, // 空名 → 剔除
        { id: 'c2', type: 'function', function: { name: 'good', arguments: '{}' } }, // 保留
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
  ]
  const cleaned = cleanupToolPairing(messages)
  const assistant = cleaned.find((m) => (m as Record<string, unknown>).role === 'assistant') as Record<string, unknown>
  const calls = assistant.tool_calls as Array<Record<string, unknown>>
  assert.equal(calls.length, 1, '空名的 tool_call 应被剔除')
  assert.equal((calls[0]?.function as Record<string, unknown>).name, 'good')
})

test('tool_call 全为空名时删除整个 tool_calls 字段', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: '' } }] },
  ]
  const cleaned = cleanupToolPairing(messages)
  const assistant = cleaned[0] as Record<string, unknown>
  assert.equal('tool_calls' in assistant, false, '全空时应删除字段而不是留空数组')
})

test('无改动时返回原数组（避免无谓的复制开销）', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  assert.equal(cleanupToolPairing(messages), messages, '无改动应返回同一引用')
})

test('畸形消息不会让清理崩溃', () => {
  const messages = [null, 'string', 42, { role: 'tool' }, { role: 'assistant', tool_calls: 'not-array' }]
  assert.doesNotThrow(() => cleanupToolPairing(messages))
})

// ─────────────────────── 完整管线 ───────────────────────

test('⚠️ prepareChatBody 强制 stream=true（上游要求）', () => {
  const result = prepareChatBody({ model: 'x', messages: [] })
  const body = JSON.parse(result.body) as Record<string, unknown>
  assert.equal(body.stream, true)
})

test('prepareChatBody 记录所做改写（便于排查）', () => {
  const result = prepareChatBody({
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 100,
  })
  assert.ok(result.applied.includes('stream=true'))
  assert.ok(result.applied.includes('max_completion_tokens→max_tokens'))
  assert.ok(result.applied.includes('stream_options.include_usage'))
})

test('prepareChatBody 拒绝非对象 / 缺 messages', () => {
  assert.throws(() => prepareChatBody(null))
  assert.throws(() => prepareChatBody('string'))
  assert.throws(() => prepareChatBody({ model: 'x' }), /messages/)
})

test('⚠️ sanitizeChatBody：裸 11128 必须改写（出现在请求里本身就是拦截条件）', () => {
  assert.equal(sanitizeChatBody('错误码 11128'), '错误码 11-128')
  // 相邻数字不受影响
  assert.equal(sanitizeChatBody('11148'), '11148')
  assert.equal(sanitizeChatBody('11101'), '11101')
})

// ─────────────────────── SSE 帧解析 ───────────────────────

test('parseSseLine：正常数据帧', () => {
  const frame = parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')
  assert.equal(frame.kind, 'chunk')
  assert.ok(frame.data?.includes('choices'))
})

test('parseSseLine：[DONE] 识别为结束', () => {
  assert.equal(parseSseLine('data: [DONE]').kind, 'done')
  assert.equal(parseSseLine('data:[DONE]').kind, 'done')
})

test('parseSseLine：注释行与空行被忽略（上游用注释保活）', () => {
  assert.equal(parseSseLine(': heartbeat').kind, 'ignore')
  assert.equal(parseSseLine('').kind, 'ignore')
  assert.equal(parseSseLine('   ').kind, 'ignore')
})

test('parseSseLine：event/id 行被忽略（本项目不需要）', () => {
  assert.equal(parseSseLine('event: message').kind, 'ignore')
  assert.equal(parseSseLine('id: 123').kind, 'ignore')
})

test('⚠️ parseSseLine：非 JSON 数据帧报错而不是静默丢', () => {
  const frame = parseSseLine('data: <html>error</html>')
  assert.equal(frame.kind, 'error', '非 JSON 应明确报错')
  assert.ok(frame.error?.includes('html'))
})

// ─────────────────────── 错误帧识别（最关键） ───────────────────────

test('⚠️ OpenAI 标准错误帧被识别', () => {
  const msg = detectErrorFrame({ error: { message: 'rate limited', type: 'x' } })
  assert.equal(msg, 'rate limited')
})

test('⚠️ 业务码非 0 被识别', () => {
  const msg = detectErrorFrame({ code: 6004, msg: '模型限流' })
  assert.ok(msg?.includes('6004'))
  assert.ok(msg?.includes('模型限流'))
})

test('⚠️ 网关形态错误帧被识别（最容易被漏掉的一类：既无 code 也无 error）', () => {
  // 这个形状是 Go 侧实测抓到的：没有 code、没有 error、没有 choices
  const msg = detectErrorFrame({
    stackTrace: ['at foo', 'at bar'],
    message: 'Internal error',
    statusCodeValue: 400,
  })
  assert.ok(msg !== undefined, '网关形态必须被识别，否则客户端会看到「干净停止、无报错」')
  assert.ok(msg?.includes('Internal error'))
})

test('只有 stackTrace 没有 statusCodeValue 也能识别', () => {
  const msg = detectErrorFrame({ stackTrace: ['x'], message: 'boom' })
  assert.ok(msg !== undefined)
})

test('正常 chunk 不被误判为错误', () => {
  assert.equal(detectErrorFrame({ choices: [{ delta: { content: 'hi' } }] }), undefined)
  // usage 帧也没有 choices，但没有错误字段 → 不该误判
  assert.equal(detectErrorFrame({ usage: { total_tokens: 10 } }), undefined)
  // code: 0 是成功
  assert.equal(detectErrorFrame({ code: 0, msg: 'OK' }), undefined)
})

// ─────────────────────── 帧转换 ───────────────────────

test('translateFrame 原样转发（不重新序列化，省 CPU）', () => {
  const raw = '{"choices":[{"delta":{"content":"hi"}}]}'
  assert.equal(translateFrame(raw), `data: ${raw}\n\n`)
})

test('errorFrame 产出 OpenAI 兼容错误形状', () => {
  const frame = errorFrame('something failed')
  assert.ok(frame.startsWith('data: '))
  assert.ok(frame.endsWith('\n\n'))
  const json = JSON.parse(frame.slice(6).trim()) as Record<string, unknown>
  assert.ok(json.error !== undefined)
})

test('doneFrame 是 [DONE]', () => {
  assert.equal(doneFrame(), 'data: [DONE]\n\n')
})

test('sseHeaders 声明不经缓冲', () => {
  const headers = sseHeaders()
  assert.ok(headers['content-type']?.includes('text/event-stream'))
  assert.equal(headers['x-accel-buffering'], 'no', '应声明不缓冲，保持逐字输出')
  assert.ok(headers['cache-control']?.includes('no-store'))
})

// ─────────────────────── 模型目录提取 ───────────────────────

test('extractModels：从 /v3/config 双层结构提取', () => {
  const models = extractModels({
    data: { data: { models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'deepseek-v4-flash' }] } },
  })
  assert.equal(models.length, 2)
  assert.equal(models[0]?.id, 'glm-5.2')
  assert.equal(models[0]?.object, 'model')
  // ⚠️ owned_by 跟随**默认供应商**：接入国际版后默认是 `buddy`（国内版）。
  // 命名口径对齐参考项目（buddy = 国内，workbuddy = 国际）。
  assert.equal(models[0]?.owned_by, 'buddy')
  assert.equal(models[0]?.name, 'GLM-5.2')
  assert.equal(models[1]?.name, undefined, '缺 name 不该编造')
})

test('extractModels：跳过无 id 的条目', () => {
  const models = extractModels({ data: { data: { models: [{ name: 'no-id' }, { id: 'ok' }] } } })
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'ok')
})

test('extractModels：畸形输入返回空数组而不抛错', () => {
  assert.deepEqual(extractModels(null), [])
  assert.deepEqual(extractModels({}), [])
  assert.deepEqual(extractModels({ data: {} }), [])
  assert.deepEqual(extractModels({ data: { data: { models: 'not-array' } } }), [])
  assert.deepEqual(extractModels({ data: { data: { models: [null] } } }), [])
})

// ─────────────────── 真实上游形状（实测抓取，防回归） ───────────────────

test('⚠️ extractModels：CN 域真实形状是 data.models[]（单层，实测 54 个模型）', () => {
  // 这个结构逐字取自 2026-10-03 真实抓取的 /v3/config 响应骨架。
  // ⚠️ 最初按 data.data.models（双层）取，线上表现为「HTTP 200 但模型列表为空」——
  // 没有报错、没有提示，只是看起来「这个账号没有模型」，极难排查。
  // 故这条断言专门锁死单层路径。
  const realShape = {
    code: 0,
    msg: 'OK',
    requestId: 'x',
    data: {
      endpoint: 'https://copilot.tencent.com',
      enterpriseId: '',
      agents: [{ name: 'cli', models: ['glm-5.2'], tools: [] }],
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', vendor: 'zhipu', maxInputTokens: 200000, supportsToolCall: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImages: false },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      productFeatures: { EnableArdot: true },
    },
  }
  const models = extractModels(realShape)
  assert.equal(models.length, 3, '单层 data.models 必须能取到（否则线上静默返回空目录）')
  assert.equal(models[0]?.id, 'glm-5.2')
  assert.equal(models[1]?.id, 'deepseek-v4-flash')
})

test('extractModels：仍兼容双层 data.data.models（另一端点家族）', () => {
  const nested = {
    data: { data: { models: [{ id: 'from-nested', name: 'Nested' }] } },
  }
  const models = extractModels(nested)
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'from-nested')
})

test('extractModels：单层优先（两种同时存在时不混淆）', () => {
  const both = {
    data: {
      models: [{ id: 'from-direct' }],
      data: { models: [{ id: 'from-nested' }] },
    },
  }
  const models = extractModels(both)
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'from-direct', '单层是 CN 域真实形态，应优先')
})

// ─────────────────── 错误 → 惩罚维度映射（接线正确性的核心） ───────────────────

test('⚠️ 6004 模型级限流不该罚整个账号（切模型即可用）', () => {
  const m = mapErrorToPunishment('rate_limited')
  assert.equal(m.punish, true)
  assert.equal(m.rotate, true, '限流应换号')
})

test('⚠️ 参数类错误不换号（换号会重放同样的非法请求，放大风控）', () => {
  for (const kind of ['context_exceeded', 'image_invalid'] as const) {
    const m = mapErrorToPunishment(kind)
    assert.equal(m.rotate, false, `${kind} 不该换号`)
    assert.equal(m.punish, false, `${kind} 不该罚号（是请求的问题，不是账号的问题）`)
  }
})

test('⚠️ 网络层错误不罚号也不换号（抖动量不构成「这个号坏了」的证据）', () => {
  const m = mapErrorToPunishment('network')
  assert.equal(m.punish, false)
  assert.equal(m.rotate, false)
})

test('⚠️ WAF 拦截不换号（可能是 IP 级，换号无用）', () => {
  const m = mapErrorToPunishment('waf_blocked')
  assert.equal(m.punish, true, '账号级软冷却仍要记')
  assert.equal(m.rotate, false, 'IP 级拦截换号无用，只会放大请求')
})

test('⚠️ 11140 请求非法不换号（同样的非法请求换号也失败）', () => {
  const m = mapErrorToPunishment('request_illegal')
  assert.equal(m.punish, true, '是强信号，要罚')
  assert.equal(m.rotate, false)
})

test('余额耗尽 / session 死亡 / 5xx 应换号', () => {
  for (const kind of ['credit_exhausted', 'session_dead', 'server'] as const) {
    assert.equal(mapErrorToPunishment(kind).rotate, true, `${kind} 应换号`)
  }
})

test('⚠️ 鉴权失败不罚号（续期凭据即可），但要换号', () => {
  const m = mapErrorToPunishment('auth_error')
  assert.equal(m.punish, false, '凭据过期不该惩罚账号')
  assert.equal(m.rotate, true)
})

test('model_unavailable 走模型级维度（不是账号级）', () => {
  const m = mapErrorToPunishment('model_unavailable')
  assert.equal(m.dimension, 'model', '11102 是 (账号,模型) 维度')
})

test('映射表覆盖所有 ErrorKind（不漏分支）', () => {
  const kinds = [
    'network','server','rate_limited','model_unavailable','credit_exhausted','waf_blocked',
    'request_illegal','session_dead','context_exceeded','image_invalid','auth_error',
    'not_found','already_done','unsupported','unknown',
  ] as const
  for (const k of kinds) {
    const m = mapErrorToPunishment(k)
    assert.equal(typeof m.punish, 'boolean', `${k} 缺少 punish`)
    assert.equal(typeof m.rotate, 'boolean', `${k} 缺少 rotate`)
    assert.ok(typeof m.dimension === 'string' && m.dimension !== '', `${k} 缺少 dimension`)
  }
})

// ─────────────────── 非流式聚合（客户端 stream:false） ───────────────────

test('⚠️ 非流式请求必须聚合成一个 JSON（不能把 SSE 原文返回）', () => {
  // 实测踩到：客户端 `stream: false` 时我们仍返回 SSE 原文，
  // 客户端 JSON.parse 报
  // `Unexpected JSON token at offset 5: Expected EOF after parsing, but had :`
  //（offset 5 正是 `data:` 的冒号）。
  const sse = [
    'data: {"id":"chatcmpl-1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":""}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"m","choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  const out = aggregateSse(sse, { model: 'm', now: 1_700_000_000_000 })
  assert.equal(out.object, 'chat.completion')
  assert.equal(out.id, 'chatcmpl-1')
  assert.equal(out.choices[0]?.message.content, '你好世界', '正文必须被合并')
  assert.equal(out.choices[0]?.finish_reason, 'stop')
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 2 })
})

test('⚠️ 非流式聚合必须按 index 合并分片的 tool_calls arguments', () => {
  // 工具调用的 arguments 是**分片**到达的；不合并的话客户端拿到被截断的
  // JSON，无法解析（这是真实缺陷，不是理论问题）。
  const sse = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":""}]}',
    'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"北京\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ].join('\n')

  const out = aggregateSse(sse, { model: 'm', now: 0 })
  const tc = (out.choices[0]?.message.tool_calls ?? [])[0] as Record<string, unknown>
  assert.notEqual(tc, undefined, '应有 tool_calls')
  const fn = tc['function'] as Record<string, unknown>
  assert.equal(fn['name'], 'get_weather')
  assert.equal(fn['arguments'], '{"city":"北京"}', 'arguments 必须完整合并')
  // 合并后必须是合法 JSON（这正是原缺陷的判据）
  assert.doesNotThrow(() => JSON.parse(String(fn['arguments'])))
  assert.equal(out.choices[0]?.finish_reason, 'tool_calls')
})

test('⚠️ 非流式聚合：reasoning_content 不能混进正文', () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想想"},"finish_reason":""}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"答案"},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n')
  const out = aggregateSse(sse, { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.content, '答案')
  assert.equal(out.choices[0]?.message.reasoning_content, '想想')
})

test('非流式聚合：空流不崩，且不编造 id', () => {
  const out = aggregateSse('', { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.content, '')
  assert.ok(out.id.startsWith('chatcmpl-'), '空流也应有一个 id')
})

// ─────────────────── 鉴权失败判据（续期触发条件） ───────────────────

test('⚠️ isAuthLikeFailure 必须认出 CodeArts 的 HTTP 400 + APIG.0602', () => {
  // 实测踩到两次：CodeArts 的 security_token 过期报的是 **HTTP 400**
  //（不是 401/403）+ `security token has expired`。
  // 只看状态码的判据会漏掉它 → 续期从不触发 → 账号明明能续期却一直报错。
  assert.equal(
    isAuthLikeFailure(400, '{"error_code":"APIG.0602","error_msg":"Bad request: the security token has expired"}'),
    true,
  )
  // 各家真实文案
  assert.equal(isAuthLikeFailure(401, 'upstream 401'), true)
  assert.equal(isAuthLikeFailure(0, 'WorkBuddy auth_error'), true)
  assert.equal(isAuthLikeFailure(0, 'Raccoon 失败（code=200003）：authorization_verify_error'), true)
  assert.equal(isAuthLikeFailure(0, 'Cline 对话失败（http=401）：Unauthorized'), true)
  assert.equal(isAuthLikeFailure(403, 'Forbidden'), true)
})

test('⚠️ isAuthLikeFailure 不该把普通故障判成鉴权失败', () => {
  // 否则会无谓地触发续期（白打上游，且可能把好凭据写坏）
  assert.equal(isAuthLikeFailure(500, '内部错误'), false)
  assert.equal(isAuthLikeFailure(429, 'rate limit'), false)
  assert.equal(isAuthLikeFailure(0, '网络超时'), false)
  assert.equal(isAuthLikeFailure(502, '上游网关错误'), false)
  // ⚠️ 400 本身不是鉴权信号（只有配合具体文案才是）
  assert.equal(isAuthLikeFailure(400, 'invalid parameter: model'), false)
})

// ─────────────────── 静默空回答（比报错更糟） ───────────────────

test('⚠️ detectErrorFrame 必须认出华为云 `error_code`/`error_msg` 形态', () => {
  // 实测踩到：CodeArts 模型名不对时上游回
  // {"text":"[DONE]","error_code":"InferHub.002002009.404",
  //  "error_msg":"The model is not registered, please request other model"}
  // —— 这一帧**既没有 `error` 也没有 `code`**（是 `error_code`），
  // 于是被当普通帧丢掉，最终给客户端一个 content:'' + finish_reason:'stop'
  // 的**空回答**。用户看到「模型返回空」，完全看不出是模型名错了。
  const frame = {
    text: '[DONE]',
    error_code: 'InferHub.002002009.404',
    error_msg: 'The model is not registered, please request other model',
  }
  const msg = detectErrorFrame(frame)
  assert.notEqual(msg, undefined, '必须识别为错误帧')
  assert.ok(msg?.includes('InferHub.002002009.404'), '错误码要带上')
  assert.ok(msg?.includes('not registered'), '原始说明要带上')
})

test('detectErrorFrame：正常帧不能被误判成错误', () => {
  // 正常的增量帧
  assert.equal(detectErrorFrame({ choices: [{ index: 0, delta: { content: 'hi' } }] }), undefined)
  // usage 帧（没有 choices 也没有错误字段）
  assert.equal(detectErrorFrame({ usage: { prompt_tokens: 1 } }), undefined)
  // 空 error_code 不算错误
  assert.equal(detectErrorFrame({ error_code: '' }), undefined)
})

test('⚠️ 裸 JSON 错误体（无 data: 前缀）也必须被识别为错误', () => {
  // 实测踩到：华为 APIG 在 HTTP 200 下直接回一个**裸 JSON 错误体**，
  // 没有任何 `data: ` 前缀。此时：
  // - aggregateSse 找不到 data: 行 ⇒ 产出空 completion；
  // - 逐行扫描也要求 `data: ` 前缀 ⇒ 同样找不到错误。
  // 结果客户端拿到 content:'' + finish_reason:'stop' 的**空回答**。
  const bare = JSON.stringify({
    error: { message: '供应商「CodeArts」请求失败：并发会话数已达上限(3个)' },
  })
  // aggregateSse 对这种输入只能产出空内容（它只认 SSE 帧）
  const out = aggregateSse(bare, { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.content, '', 'aggregateSse 只认 SSE，故为空')

  // 而 detectErrorFrame 对解析后的对象必须能认出错误 ——
  // 这正是 nonStreamingResponse 里「先整体当 JSON 解析」那一步的依据。
  const parsed = JSON.parse(bare) as Record<string, unknown>
  assert.notEqual(detectErrorFrame(parsed), undefined, '裸 JSON 错误体必须被识别')
})

test('⚠️ aggregateSse 必须容忍 `data:` 不带空格（CodeArts 就是这个形态）', () => {
  // 实测踩到（这条 bug 让 CodeArts 非流式恒为空回答）：
  // 华为 APIG 发的是 `data:{...}`（**不带空格**），而我第一版用
  // `line.startsWith('data: ')` 判断 —— 每一帧都被跳过，
  // 聚合结果恒为 content:''，客户端看到「模型返回空」，
  // 而流式路径（用 parseSseLine）却完全正常。
  const noSpace = [
    'data:{"choices":[{"index":0,"delta":{"content":"你"}}]}',
    'data:{"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}',
    'data:[DONE]',
  ].join('\n')
  const out = aggregateSse(noSpace, { model: 'm', now: 0 })
  assert.equal(out.choices[0]?.message.content, '你好', '不带空格的 data: 也必须被解析')

  // 带空格的形态同样要支持（不同上游不一致，两条都要活）
  const withSpace = [
    'data: {"choices":[{"index":0,"delta":{"content":"A"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n')
  assert.equal(aggregateSse(withSpace, { model: 'm', now: 0 }).choices[0]?.message.content, 'AB')
})

// ─────────────────── 会话粘性（prompt cache 命中） ───────────────────

test('⚠️ pick 的 preferred 必须只「排到最前」，不可绕过健康检查', () => {
  // 语义是「优先」不是「只要」：粘性账号若已冷却/熔断/模型限流，
  // 它压根不在 candidates 里 ⇒ 自然回落到其余候选。
  // ⚠️ 绝不能因为「粘性的那个挂了」就报「没有可用账号」。
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  const i = src.indexOf('const preferred = request.preferred')
  assert.ok(i > 0, 'pick 应读取 request.preferred')
  const block = src.slice(i, i + 400)
  // 必须是在 candidates 里 find —— 而不是在原始账号表里直接取
  assert.ok(block.includes('candidates.find'), '必须从**候选集**里找（保证健康检查已通过）')
})

test('⚠️ 会话粘性 key 不得用「全部消息」的哈希（那样每轮都变）', () => {
  // 最容易写错的地方：用全部 messages 哈希 ⇒ 每加一轮消息 key 就变，
  // 粘性等于没有（每轮都当新会话）。必须只用首条消息 + user 字段。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const i = src.indexOf('async function deriveSessionKey')
  const block = src.slice(i, i + 1800)
  assert.ok(block.includes('messages[0]'), '应只取**首条**消息做指纹')
  assert.ok(block.includes("body.user"), '应优先用客户端给的 user 字段')
  // 不得出现对整个 messages 数组做序列化/哈希
  assert.ok(!/JSON\.stringify\(messages\)/.test(block), '不得序列化整个 messages 数组')
  assert.ok(!/messages\.map\(/.test(block), '不得对全部 messages 做映射后哈希')
})

test('⚠️ 会话粘性只在首轮生效（换号后还粘回去会死循环）', () => {
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  // 两条路径都必须是「tried 为空才用粘性」
  const hits = [...src.matchAll(/tried\.length === 0[^\n]*sessionKey/g)].length
  assert.ok(hits >= 2, `两条路径都应限定首轮，实际匹配 ${hits} 处`)
})

test('⚠️ 绑定会话必须在成功后（首帧到达）才做，且用 waitUntil 托住', () => {
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const binds = [...src.matchAll(/bindSession\(/g)].length
  assert.ok(binds >= 2, `两条成功路径都应绑定会话，实际 ${binds} 处`)
  // ⚠️ 记账/绑定都是「流结束后才发生的事」，不用 waitUntil 会被 Worker 取消
  for (const m of src.matchAll(/([^\n]*)bindSession\(/g)) {
    const line = m[1] ?? ''
    assert.ok(
      /waitUntil/.test(line) || line.includes('ctx.waitUntil'),
      `bindSession 必须包在 waitUntil 里（否则流一结束就被取消）：${line.trim().slice(0, 80)}`,
    )
  }
})

// ─────────────── 帧净化（严格客户端兼容：ZCode 等 agent 工具） ───────────────

test('⚠️ 空串的 reasoning_content 必须删除（否则客户端一直显示"思考中"）', () => {
  // 实测（用户报障）：buddy 的 v4.1-flash 每帧都带 `reasoning_content: ""`，
  // 严格客户端看到「字段存在」就当成思考内容 ⇒ 每帧一个字的 content
  // 被显示成思考碎片 = 「一直思考，每次只有 1 个单词」。
  const frame = {
    choices: [{ index: 0, delta: { role: 'assistant', content: '你好', reasoning_content: '' }, finish_reason: '' }],
  }
  normalizeFrame(frame)
  const d = (frame.choices[0] as { delta: Record<string, unknown> }).delta
  assert.equal('reasoning_content' in d, false, '空串 reasoning_content 必须删除')
  assert.equal(d['content'], '你好', '正文必须保留')
})

test('⚠️ 有内容的 reasoning_content 必须保留（那是有效信息）', () => {
  // ⚠️ 只删「空值」。真在推理的模型必须原样透传，否则用户看不到思考过程。
  const frame = { choices: [{ delta: { reasoning_content: '让我想想…' } }] }
  normalizeFrame(frame)
  const d = (frame.choices[0] as { delta: Record<string, unknown> }).delta
  assert.equal(d['reasoning_content'], '让我想想…')
})

test('⚠️ 中间帧的 finish_reason 必须从空串改成 null（否则第一帧就被判流结束）', () => {
  // ⚠️ 这是最隐蔽的一条：客户端普遍写 `if (finish_reason !== null) 流结束`。
  // `"" !== null` 为**真** ⇒ **每一帧**都被当成结束帧，客户端立刻停止读取，
  // 表现为「一直显示思考中 / 没有输出」。规范里中间帧必须是 `null`。
  const frame = { choices: [{ delta: { content: 'a' }, finish_reason: '' }] }
  normalizeFrame(frame)
  assert.equal(frame.choices[0]!.finish_reason, null, '空串必须改成 null')

  // 真实的结束原因必须**原样保留**
  const end = { choices: [{ delta: {}, finish_reason: 'stop' }] }
  normalizeFrame(end)
  assert.equal(end.choices[0]!.finish_reason, 'stop')
})

test('⚠️ 工具调用后续片段的空 function.name 必须删除（否则工具名被覆盖）', () => {
  // 实测抓取：上游首帧给 id/name，后续帧 `name: ""` 只有 arguments 增量。
  // 规范要求后续片段**省略** name。agent 客户端若用赋值累加，
  // 工具名会被空串覆盖 → 调用失败，且报错完全不指向真正原因。
  const frame = {
    choices: [{
      delta: {
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' }, index: 0 },
          { function: { name: '', arguments: '{"city"' }, index: 0 },
        ],
      },
    }],
  }
  normalizeFrame(frame)
  const calls = (frame.choices[0] as { delta: { tool_calls: Array<{ function: Record<string, unknown> }> } }).delta.tool_calls
  assert.equal('name' in calls[0]!.function, true, '首帧的 name 必须保留')
  assert.equal(calls[0]!.function['name'], 'get_weather')
  assert.equal('arguments' in calls[0]!.function, false, '首帧的空 arguments 应删除')
  assert.equal('name' in calls[1]!.function, false, '后续帧的空 name 必须删除')
  assert.equal(calls[1]!.function['arguments'], '{"city"', '⚠️ arguments 增量必须保留（丢了参数就拼不完整）')
})

test('⚠️ 空的 tool_calls 数组必须删除（但非空的不可丢）', () => {
  const empty = { choices: [{ delta: { tool_calls: [] } }] }
  normalizeFrame(empty)
  assert.equal('tool_calls' in (empty.choices[0] as { delta: Record<string, unknown> }).delta, false)

  const nonEmpty = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'x' } }] } }] }
  normalizeFrame(nonEmpty)
  assert.equal(
    (nonEmpty.choices[0] as { delta: { tool_calls: unknown[] } }).delta.tool_calls.length, 1,
  )
})

test('⚠️ needsNormalize 必须覆盖空 name 的工具帧（否则工具名被覆盖）', () => {
  // ⚠️ 漏掉会让「空 name 覆盖工具名」的缺陷**只在工具调用时**出现，
  // 而普通对话测试完全发现不了 —— 这正是它危险的地方。
  assert.equal(
    needsNormalize('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"","arguments":"{"},"index":0}]}}]}'),
    true, '含空 name 的工具帧必须净化',
  )
  assert.equal(needsNormalize('{"choices":[{"delta":{"reasoning_content":""}}]}'), true)
  assert.equal(needsNormalize('{"choices":[{"delta":{"content":"普通帧"}}]}'), false,
    '普通帧不该走解析路径（省 CPU）')
})

test('⚠️ needsNormalize 必须**只匹配空值** —— 有真实内容时走快速路径', () => {
  // ## 这是实测出来的性能铁律（我第一版写错了，直接造成线上故障）
  //
  // 第一版判据是「帧里出现 `reasoning_content` 就解析」。但真实思考帧是
  // `{"delta":{"content":"","reasoning_content":"The"}}` —— **有真实内容，
  // 根本不需要净化**，却照样付了 JSON 往返。
  //
  // 实测后果：`deep-model` 长思考 **6521 帧** ⇒ 每帧 JSON 往返合计
  // **31.6ms CPU**，而 **Free 计划只有 10ms/次调用** ⇒ Worker 被强制终止
  // ⇒ 用户看到「思考超过 40 秒突然停止、没有任何输出」。
  //
  // ⚠️ 所以这条测试锁的是**性能正确性**：有内容的帧必须走快速路径。
  assert.equal(
    needsNormalize('{"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The"},"finish_reason":null}]}'),
    false, '⚠️ 有真实 reasoning 的帧**不得**触发解析（否则长思考会 CPU 超限）',
  )
  assert.equal(
    needsNormalize('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"get_weather","arguments":"{"},"index":0}]}}]}'),
    false, '⚠️ 首帧有真实工具名时也**不得**触发解析',
  )
  assert.equal(
    needsNormalize('{"choices":[{"delta":{"content":"正常文本"}}],"usage":null}'),
    false, '普通帧',
  )
  // ⚠️ 配对的**正向**用例：证明这个断言不是恒真（否则它永远通过、锁不住东西）。
  assert.equal(needsNormalize('{"choices":[{"delta":{"reasoning_content":""}}]}'), true)
})

test('⚠️ translateFrame 端到端：净化后的帧是严格 OpenAI 形状', () => {
  const raw = JSON.stringify({
    id: 'x', object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: 'hi', reasoning_content: '', function_call: null, refusal: '', tool_calls: [], extra_fields: null },
      finish_reason: '',
    }],
  })
  const out = translateFrame(raw)
  assert.ok(out.startsWith('data: '), 'SSE 前缀')
  assert.ok(out.endsWith('\n\n'), 'SSE 结尾')
  const parsed = JSON.parse(out.slice(6).trim())
  assert.deepEqual(Object.keys(parsed.choices[0].delta).sort(), ['content', 'role'],
    '只剩规范字段')
  assert.equal(parsed.choices[0].finish_reason, null, '空串已改成 null')
})

// ─────────── 6004 模型级限流：不能罚整个账号（用户报「一会能用一会不能用」） ───────────

test('⚠️ 6004 必须判为**模型级**限流，不是账号级', () => {
  // 实测（用户报障）：workbuddy 国际版「一会能用一会不能用」。
  // 上游原文：`{"code":6004,"msg":"usage exceeds frequency limit, but don't worry,
  // your usage will reset at 2026-10-05 14:47:23 UTC+8, alternatively, you can
  // switch to the other models"}` —— 「**可以换用其它模型**」= 模型级限流。
  //
  // ⚠️ 若判成账号级：**单账号的供应商**（global 只有 1 个 workbuddy 账号）
  // 会在冷却期内**完全不可用**，而真实情况是「换个模型立刻就能用」。
  const body = '{"code":6004,"msg":"usage exceeds frequency limit, alternatively, you can switch to the other models"}'
  const got = refineModelScoped('rate_limited', body)
  assert.equal(got.dimension, 'model', '6004 必须罚模型维度')
  assert.equal(got.code, 6004)
})

test('⚠️ 14017 等其它限流码仍是账号级（不能一律都罚模型）', () => {
  // ⚠️ 配对的**反向**用例：若把「凡 rate_limited 都判 model」写进去，
  // 账号级限流就永远不会冷却账号 —— 那会让坏号被反复使用。
  const got = refineModelScoped('rate_limited', '{"code":14017,"msg":"too many requests"}')
  assert.equal(got.dimension, 'soft', '14017 是账号级软冷却')
})

test('⚠️ 必须解析上游给的重置时刻（UTC+8 要正确换算）', () => {
  // 上游会明说何时恢复。用自己的退避估算要么过早（继续撞限流）
  // 要么过晚（白白少用几小时）—— 上游知道真实的重置墙钟。
  const ms = parseResetAt('your usage will reset at 2026-10-05 14:47:23 UTC+8')
  assert.notEqual(ms, undefined, '应能解析')
  // 14:47:23 UTC+8 == 06:47:23 UTC
  assert.equal(new Date(ms!).toISOString(), '2026-10-05T06:47:23.000Z',
    '⚠️ 必须按文案里的 UTC+8 换算，不能按运行时本地时区（Worker 跑在 UTC，会差 8 小时）')
})

test('⚠️ 认不出的重置时刻必须返回 undefined（回落本地退避，不编造）', () => {
  assert.equal(parseResetAt('no time here'), undefined)
  assert.equal(parseResetAt('{"code":6004,"msg":"limit"}'), undefined)
  // ⚠️ 编造一个时间会让账号在错误的时刻被解锁，比不解析更糟。
})

// ─────────── 🔴 CPU 纪律：长流不得因每帧开销超限（用户报「突然停止」） ───────────

test('⚠️ 有真实内容的帧必须走快速路径（不得触发 JSON 解析）', () => {
  // ## 这是实测出来的性能铁律 —— 我第一版写错，直接造成线上故障
  //
  // 用户报：「buddy 和 workbuddy 的模型思考超过 40 秒就可能突然停止，没有任何输出」。
  //
  // 根因链：
  // 1. `deep-model` 一次长思考输出 **8000 帧**；
  // 2. 第一版 `needsNormalize` 是 `includes('"reasoning_content"')` —— 见键名就解析，
  //    而真实思考帧 `{"delta":{"content":"","reasoning_content":"The"}}`
  //    **根本不需要净化**；
  // 3. 每帧 JSON 往返 ⇒ 合计 **26.7ms CPU**，而 **Free 计划只有 10ms/次调用**
  //    ⇒ Worker 被强制终止 ⇒ 流突然断掉、没有任何输出。
  //
  //（对照：修复前原样转发只要 **0.25ms**。）
  assert.equal(
    needsNormalize('{"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The"},"finish_reason":null}],"usage":null}'),
    false, '⚠️ 有真实 reasoning 的帧不得触发解析',
  )
  assert.equal(
    needsNormalize('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"get_weather","arguments":"{"},"index":0}]}}]}'),
    false, '⚠️ 有真实工具名的帧不得触发解析',
  )
})

test('🔴 usage=null 不得触发 JSON.parse（原实现的真实缺陷）', () => {
  // ## 这是**原有代码**的缺陷（不是新引入的），实测定位
  //
  // 原判据 `includes('"usage"')` 会**命中 `"usage":null`**，而上游
  // **每一帧**都带 `"usage":null` ⇒ **每帧都 JSON.parse 整个帧**。
  //
  // 实测（6521 帧）：**18.32ms CPU** ⇒ 超 10ms 配额 ⇒ 长思考被切断。
  // 收紧成 `"usage":{`（只在有真数据时解析）后：**3.93ms**（快 4.7 倍），
  // 且**语义完全不变**（`null` 本来就没有可解析的数据）。
  //
  // ⚠️ 教训：**判据不能比它要保护的工作还贵**；
  // 「字段存在」与「字段有内容」是两件事 —— 这是本文件反复出现的同一类错误。
  assert.equal(USAGE_HINT_PATTERN.test('{"choices":[],"usage":null}'), false,
    '⚠️ usage:null 不得触发解析（上游每帧都是这个形状）')
  assert.equal(USAGE_HINT_PATTERN.test('{"choices":[],"usage":{"prompt_tokens":1}}'), true,
    '有真实 usage 对象时才解析')
})

test('⚠️ 错误探测也要廉价（N 次 includes 换成一条正则）', () => {
  // 同一类问题：`data.includes('"error"') || ... || data.includes('"code"')`
  // 是 **4 次全串扫描**，实测 6521 帧下 13.36ms —— 本身就超预算。
  // 合并成一条正则后 4.98ms。
  assert.equal(ERROR_HINT_PATTERN.test('{"choices":[{"delta":{"content":"普通"}}]}'), false)
  assert.equal(ERROR_HINT_PATTERN.test('{"code":6004,"msg":"限流"}'), true)
  assert.equal(ERROR_HINT_PATTERN.test('{"error":{"message":"x"}}'), true)
})

test('⚠️ 长流的每帧开销必须在 10ms CPU 预算内（8000 帧量化）', () => {
  // ⚠️ 这条是**量化护栏**：直接跑 8000 帧（实测最长的思考场景），
  // 断言总耗时在预算内。若有人把快速路径改回「每帧 JSON 往返」，这里会立刻变红。
  //
  // 阈值说明：本地 Node 比 Workers 快，故这里的余量不代表线上余量 ——
  // 它锁的是**数量级**（快速路径 ~4ms vs JSON 往返 ~27ms），不是精确值。
  const thinking =
    '{"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The"},"finish_reason":null}],"usage":null}'
  const N = 8000
  const start = performance.now()
  for (let i = 0; i < N; i += 1) translateFrame(thinking)
  const elapsed = performance.now() - start
  assert.ok(
    elapsed < 15,
    `⚠️ ${N} 帧耗时 ${elapsed.toFixed(1)}ms —— 疑似快速路径失效（应 ~4ms，超 10ms 配额就会切流）`,
  )
  // ⚠️ 配对的**正向**用例：证明这条断言不是恒真（否则它锁不住任何东西）。
  const slow =
    '{"choices":[{"index":0,"delta":{"content":"a","reasoning_content":"","refusal":""},"finish_reason":""}],"usage":null}'
  assert.equal(needsNormalize(slow), true, '含空值的帧确实会走净化路径')
})

test('⚠️ 工具片段的空 name 必须删掉，但 arguments 增量必须保留', () => {
  // 实测抓到的真实形状：首帧给 id/type/name，**后续帧 `name: ""`** 只有 arguments。
  // OpenAI 规范要求后续片段**省略** name；严格 agent 客户端若用赋值累加，
  // 工具名会被空串覆盖 → 调用失败，而报错完全不指向真正原因。
  const first = translateFrame(JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' }, index: 0 }] }, finish_reason: '' }],
  }))
  const p1 = JSON.parse(first.slice(6).trim()).choices[0].delta.tool_calls[0].function
  assert.equal(p1.name, 'get_weather', '首帧的 name 必须保留')
  assert.equal('arguments' in p1, false, '首帧的空 arguments 应删除')

  const later = translateFrame(JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ function: { name: '', arguments: '{"city"' }, index: 0 }] }, finish_reason: null }],
  }))
  const p2 = JSON.parse(later.slice(6).trim()).choices[0].delta.tool_calls[0].function
  assert.equal('name' in p2, false, '后续帧的空 name 必须删除')
  assert.equal(p2.arguments, '{"city"', '⚠️ arguments 增量必须保留（丢了参数就拼不完整）')
})

test('⚠️ 净化不得误伤普通帧的 role/name 字段', () => {
  // ⚠️ 空值删除是按**字面量**做的，必须确认没有把正常字段一起删掉。
  const out = translateFrame('{"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}')
  const d = JSON.parse(out.slice(6).trim()).choices[0].delta
  assert.equal(d.role, 'assistant', 'role 必须保留')
  assert.equal(d.content, 'hi', 'content 必须保留')
})
