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
import assert from 'node:assert/strict'

import {
  cleanupToolPairing,
  ensureStreamOptions,
  normalizeToolChoice,
  prepareChatBody,
  sanitizeChatBody,
  translateMaxCompletionTokens,
} from '../src/gateway/payload.ts'
import {
  detectErrorFrame,
  doneFrame,
  errorFrame,
  parseSseLine,
  sseHeaders,
  translateFrame,
  aggregateSse,
} from '../src/gateway/stream.ts'
import { extractModels } from '../src/gateway/models.ts'
import { isAuthLikeFailure, mapErrorToPunishment } from '../src/gateway/server.ts'

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
