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
import { referenceChatHeaders } from '../src/upstream/headers.ts'
import { classify } from '../src/upstream/client.ts'

/**
 * 剥掉注释后再做源码断言。
 *
 * ⚠️ 必需：本仓库的注释里会**大量引用反例**（如「原实现用首条消息指纹」），
 * 朴素的字符串搜索会把注释当成代码 ⇒ 误报。实测踩到过。
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
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
import { ERROR_CHECK_FRAMES, ERROR_HINT_PATTERN, aggregateSse, createFrameTranslator, detectErrorFrame, doneFrame, errorFrame, mayHaveUsage, needsNormalize, normalizeFrame, normalizeToolCalls, parseSseLine, sseHeaders, translateFrame } from '../src/gateway/stream.ts'
import { extractModels } from '../src/gateway/models.ts'
import { clientStatusFor, isAuthLikeFailure, mapErrorToPunishment, parseBusinessCode, parseResetAt, punishmentForStreamError, refineModelScoped } from '../src/gateway/server.ts'

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

test('🔴 会话粘性 key 只能来自**客户端显式标识**，绝不从内容推断', () => {
  // ## 实测缺陷（用户报「思考 78 秒又断了」）
  //
  // 我第一版用「首条消息指纹」当会话 key，想法是「同一会话的后续轮次
  // 首条消息不变，故指纹稳定」。**这个推断是错的**：
  //
  // - 「首条消息相同」**不等于**「同一会话」—— 任何两个用户发出相同 prompt
  //   （或同一用户重发）都会得到**同一个 key**；
  // - 于是这些**互相独立的请求**被当成一个会话，**全部粘到同一账号**；
  // - 并发时该账号被压垮，**上游把先前的流踢掉** ⇒「长回答中途突然停止」。
  //
  // **决定性对照实验**：
  // - 3 个**相同 prompt** 并发 ⇒ 1 个被切断；
  // - 3 个**不同 user 字段**并发 ⇒ **3/3 全部完整**。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const i = src.indexOf('async function deriveSessionKey')
  const block = stripComments(src.slice(i, i + 2600))

  // 必须认显式标识
  assert.ok(block.includes('body.user'), '必须认 `user` 字段')
  assert.ok(/conversation_id|conversationId/.test(block), '必须认显式会话 id')

  // ⚠️ **绝不能**从 messages 内容推断
  assert.ok(!block.includes('messages'), '⚠️ 不得读取 messages —— 内容相同不等于同一会话')
  assert.ok(!/sha256Hex\(`\$\{role\}/.test(block), '不得对消息内容做哈希')

  // 都没有时必须返回空串（不做粘性），而不是编造
  assert.ok(/return ''/.test(block), '无显式标识时必须返回空串（回落常规随机）')
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

test('🔴 usage 判据必须是 O(1) 尾判，且不误判（原实现的真实缺陷）', () => {
  // ## 原实现的真实缺陷（实测定位）
  //
  // 原判据 `includes('"usage"')` **每帧都命中** —— 上游**每一帧**都带
  // `"usage":null`，只有末帧才是真对象 ⇒ 每帧都 `JSON.parse` 整个帧。
  // 实测 6521 帧 **18.32ms CPU** ⇒ 超 10ms 配额 ⇒ 长思考被切断。
  //
  // 改成 `"usage":{` 后 3.93ms，但 2 万帧时**仍要 8.1ms**（还是全串扫描）。
  // ⇒ 最终用 **`endsWith` 尾判**（O(1)）：2 万帧 **8.1ms → 2.2ms**。
  //
  // ⚠️ 该上游的帧必然以 `"usage":null}` 结尾（usage 是最后一个键）。
  assert.equal(
    mayHaveUsage('{"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}],"usage":null}'),
    false, '⚠️ usage:null 的普通帧必须跳过解析（上游每帧都是这个形状）',
  )
  assert.equal(
    mayHaveUsage('{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":33}}'),
    true, '末帧（usage 是对象）必须解析',
  )

  // ⚠️ **判错方向必须是安全的**：若上游改了字段顺序（不再以 usage 结尾），
  // 判据会对所有帧返回 true ⇒ 退化成原来的行为（能拿到 usage，只是慢），
  // **不会丢数据**。这是刻意选的失败方向「宁慢不丢」。
  assert.equal(
    mayHaveUsage('{"usage":{"prompt_tokens":1},"choices":[]}'),
    true, '⚠️ 顺序变了也要返回 true（宁可多解析，不可漏 usage）',
  )
})
test('⚠️ 错误探测也要廉价（N 次 includes 换成一条正则）', () => {
  // 同一类问题：`data.includes('"error"') || ... || data.includes('"code"')`
  // 是 **4 次全串扫描**，实测 6521 帧下 13.36ms —— 本身就超预算。
  // 合并成一条正则后 4.98ms。
  assert.equal(ERROR_HINT_PATTERN.test('{"choices":[{"delta":{"content":"普通"}}]}'), false)
  assert.equal(ERROR_HINT_PATTERN.test('{"code":6004,"msg":"限流"}'), true)
  assert.equal(ERROR_HINT_PATTERN.test('{"error":{"message":"x"}}'), true)
})

test('⚠️ 有内容/干净帧在生产路径（有状态转换器）上的开销可忽略', () => {
  // ⚠️ 量化护栏用**生产路径**（`createFrameTranslator`），不是单帧版
  // `translateFrame` —— 后者刻意保留逐帧语义（供测试与非流式用），
  // 拿它做性能断言会误报（实测会 20ms+，但那不是线上路径）。
  const thinking =
    '{"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The"},"finish_reason":null}],"usage":null}'
  // ⚠️ **用中位数而不是单次测量**：CI/沙箱上单次测量会被其它负载干扰
  //（实测同一代码在 6ms 与 21ms 之间抖动），那会让这条测试变成**噪声源**。
  const t = createFrameTranslator()
  const N = 8000
  const runs: number[] = []
  for (let r = 0; r < 7; r += 1) {
    const start = performance.now()
    for (let i = 0; i < N; i += 1) t.translate(thinking)
    runs.push(performance.now() - start)
  }
  runs.sort((a, b) => a - b)
  const median = runs[Math.floor(runs.length / 2)] ?? 0
  assert.ok(
    median < 20,
    `⚠️ ${N} 帧**中位**耗时 ${median.toFixed(1)}ms（原始样本 ${runs.map((x) => x.toFixed(1)).join(',')}）`
      + ' —— 疑似快速路径失效（超 10ms 配额就会切流）',
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

// ───────── 🔴 长回答被切断：逐帧开销 + 并发挤同号（两条真实缺陷） ─────────

test('🔴 帧翻译必须是**有状态**的：首帧判断一次，不得逐帧扫描', () => {
  // ## 实测缺陷（用户报「思考 78 秒又断了」）
  //
  // 8000 帧 / 10ms 配额 ⇒ **每帧只有 1.25 微秒**，而实测：
  // - 单次 `String.includes` 扫描整帧：**7.4ms**
  // - 单次正则判断：**7.4ms**
  // - 正则替换：**35.7ms**
  //
  // ⇒ 任何「每帧扫描整帧字符串」的做法都超预算。一条 20 分钟的长回答有
  // **2 万帧**，逐帧开销乘上去必然爆 ⇒ 流被切断。
  //
  // 修法：`createFrameTranslator()` 首帧判断**一次**，之后全程沿用该决定。
  const t = createFrameTranslator()
  // 首帧带空值 ⇒ 整条流都按「需净化」处理
  const flash = '{"choices":[{"delta":{"content":"a","reasoning_content":"","refusal":""},"finish_reason":""}],"usage":null}'
  assert.equal(t.translate(flash).includes('reasoning_content'), false, '首帧被净化')
  assert.equal(t.translate(flash).includes('reasoning_content'), false, '后续帧同样被净化')

  // 首帧干净 ⇒ 整条流原样透传（不付任何扫描代价）
  const t2 = createFrameTranslator()
  const clean = '{"choices":[{"delta":{"content":"x"},"finish_reason":null}],"usage":null}'
  assert.equal(t2.translate(clean).includes('"content":"x"'), true, '干净帧原样输出')
})

test('🔴 帧翻译不得退化成二次方（该路径实测已休眠，但不能是性能地雷）', () => {
  // ## 重要事实：这条路径（含空值字段的**老格式**）实测**已不再触发**
  //
  // 44 万帧抓取里只有 31 帧含空值，全部来自 2026-10-05 上午，
  // **之后上游再没发过这些字段**。故这里**不锁绝对耗时**（那是给死代码定 SLA），
  // 只锁「不得退化成二次方」—— 真触发时说明上游又改了形状，届时按实测重做。
  //
  // ⚠️ **历史教训**：我为这条路径连续优化了三轮，每轮都以为找到了
  // 「长回答被切断」的根因，但都没命中 —— 因为它对用户场景根本不触发。
  // **正确顺序是先确认路径会不会走到，再决定要不要优化。**
  const legacy =
    '{"id":"x","choices":[{"index":0,"delta":{"role":"a","content":"a","reasoning_content":"","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":""}],"usage":null}'

  // 1 万帧与 2 万帧的耗时应当**近似线性**（比值 < 4 表示没有退化成二次方）
  const run = (n: number): number => {
    const t = createFrameTranslator()
    const start = performance.now()
    for (let i = 0; i < n; i += 1) t.translate(legacy)
    return performance.now() - start
  }
  run(2000) // 预热
  const t1 = run(10_000)
  const t2 = run(20_000)
  const ratio = t2 / Math.max(t1, 0.01)
  assert.ok(ratio < 4, `⚠️ 2 万帧/1 万帧 耗时比 ${ratio.toFixed(2)} —— 疑似退化成二次方`)

  // ⚠️ 配对的**正向**用例：证明这条路径确实会被走到（断言不是恒真）。
  assert.ok(needsNormalize(legacy), '该帧确实含空值（会走净化路径）')
  // 且净化必须**有效**
  const t = createFrameTranslator()
  assert.equal(t.translate(legacy).includes('reasoning_content'), false, '空值字段必须被删掉')
})
test('🔴 同号并发必须摊开（否则上游踢掉先前的流）', () => {
  // ## 实测缺陷（用户报「思考 78 秒又断了」）
  //
  // 上游对**同一账号的并发流**不友好：后来者会把先前的流**踢掉** ⇒
  // 「长回答中途突然停止、没有任何输出」。
  //
  // **决定性对照实验**：
  // - 3 个**相同 prompt** 并发 ⇒ 1 个被切断；
  // - 3 个**不同 user 字段**并发 ⇒ **3/3 全部完整**。
  //
  // ⚠️ 纯加权随机不够：它每次都独立掷骰，完全可能连中同一个账号。
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  const i = src.indexOf('async pick(request: PickRequest)')
  const block = stripComments(src.slice(i, i + 4000))
  assert.ok(/SPREAD_WINDOW_MS/.test(block), '必须按时间窗摊开刚被选中的账号')
  assert.ok(/notePickedAt\(/.test(block), '必须记录/查询最近选中的时刻')
  assert.ok(
    /fresh\.length > 0 \? fresh : candidates/.test(block),
    '⚠️ 摊开失败时必须**回落到全部候选** —— 绝不因此报「无可用账号」',
  )
})

test('⚠️ 摊开必须让位于显式会话粘性（有 user 字段时优先 cache）', () => {
  // ⚠️ 顺序即语义：`preferred` 命中要**直接返回**，不参与摊开 ——
  // 否则「同一会话命中 prompt cache」这个收益就没了。
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  const i = src.indexOf('async pick(request: PickRequest)')
  const block = stripComments(src.slice(i, i + 4000))
  const prefIdx = block.indexOf('preferred !== ')
  const spreadIdx = block.indexOf('SPREAD_WINDOW_MS')
  assert.ok(prefIdx > 0 && spreadIdx > 0, '两段逻辑都应存在')
  assert.ok(prefIdx < spreadIdx, '⚠️ 粘性判断必须在摊开**之前**')
})

// ───── 「账号是好的但就是用不了」：11128 渠道拦截被误判为账号故障 ─────

test('🔴 11128 必须判为渠道拦截（waf_blocked），不是 request_illegal', () => {
  // ## 实测缺陷（用户报「账号明明都是好的，但就是用不了」）
  //
  // 上游原文：`Illegal API invocation from an unapproved channel` /
  // `The request was blocked by security policy.`
  //
  // 关键区别：
  // - `11140`（真正的 request_illegal）是**这个账号发了非法请求** ⇒ 该罚账号；
  // - `11128` 是**请求的渠道指纹不被认可** ⇒ 与账号好坏**无关**。
  //
  // ⚠️ 原实现把 11128 归为 `request_illegal` ⇒ `dimension: 'breaker'`
  // ⇒ 罚账号（`fails++`，**3 次就熔断 30 分钟**）⇒ 好账号被逐个熔断。
  //
  // 修 ① 改成 waf_blocked（治好了熔断）**但引入了新缺陷**：
  // waf_blocked 会触发 `noteWaf` 的 IP 级判定，凑够 2 个账号就**误报全局封锁**
  //（用户报「显示出口 IP 被 WAF 拦截」）。故现在用**独立的 channel_blocked**。
  const body = JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
  })
  // ⚠️ 必须是**独立的 channel_blocked**，不能是 waf_blocked ——
  // 后者会触发 IP 级判定（noteWaf），导致「误报出口 IP 被拦」的全局 503。
  assert.equal(classify(400, body).kind, 'channel_blocked', '11128 必须判为 channel_blocked')

  // ⚠️ 配对的**反向**用例：真正的 11140 仍须罚账号（否则非法请求不会被制止）
  const illegal = JSON.stringify({ code: 11140, msg: 'illegal request' })
  assert.equal(classify(400, illegal).kind, 'request_illegal', '11140 仍是 request_illegal')
})

test('🔴 渠道拦截不得触发账号熔断（好号被逐个熔断就是用户报的现象）', () => {
  // `waf_blocked` 的处置必须是**软冷却 + 不换号**：
  // 换号撞的是同一套渠道判定，只会把风控放大到更多账号上。
  const mapped = mapErrorToPunishment('channel_blocked')
  assert.equal(mapped.punish, false, '⚠️ 渠道拦截**不该罚账号**（它说的是请求指纹，不是账号）')
  assert.equal(mapped.rotate, false, '⚠️ 不换号 —— 换号撞同一堵墙且放大风控')

  // ⚠️ 同时确认 HTTP 403 的 WAF 仍然要软冷却（那是真的拦截）
  const waf = mapErrorToPunishment('waf_blocked')
  assert.equal(waf.punish, true, 'HTTP 403 的 WAF 仍须软冷却')
  assert.equal(waf.dimension, 'soft')
})

test('🔴 流内错误必须按类别罚，不能一律 breaker', () => {
  // ⚠️ 流内错误（HTTP 头已发出、错误在 SSE 帧里）原先**一律** `breaker`：
  // `fails++`，3 次熔断 30 分钟。渠道拦截的文案走到这里就会误伤好号。
  assert.equal(
    punishmentForStreamError('upstream_error: Illegal API invocation from an unapproved channel'),
    'soft', '⚠️ 渠道拦截必须软冷却',
  )
  assert.equal(punishmentForStreamError('The request was blocked by security policy.'), 'soft')
  assert.equal(punishmentForStreamError('code 11128'), 'soft')
  // ⚠️ 配对的**反向**用例：真正的流中断仍须熔断（否则坏号不会被剔除）
  assert.equal(punishmentForStreamError('流传输中断：connection reset'), 'breaker')
  assert.equal(punishmentForStreamError('upstream returned invalid json'), 'breaker')
})

test('🔴 不是客户端的错就不要回 400（否则客户端以为是自己请求写错了）', () => {
  // ## 实测缺陷（用户报的正是这个）
  //
  // `Request failed: 400: {"message":"所有账号均失败，最后一次：request_illegal:
  //  Illegal API invocation from an unapproved channel"}`
  //
  // ⚠️ 400 让客户端以为「是我自己请求写错了」，而真实原因是**上游渠道判定**。
  // 轮转完所有账号仍失败时，故障点在**我们与上游之间** ⇒ 正确语义是 502。
  assert.equal(clientStatusFor(400, 'waf_blocked'), 502, '⚠️ 渠道拦截不是客户端的错')
  assert.equal(clientStatusFor(400, 'request_illegal'), 502, '账号侧非法请求也不是客户端的错')
  assert.equal(clientStatusFor(429, 'rate_limited'), 502)
  assert.equal(clientStatusFor(500, 'server'), 502)
  assert.equal(clientStatusFor(401, 'auth_error'), 502, '凭据失效是网关侧问题')

  // ⚠️ **例外必须保留**：确实是「请求内容」的问题 ⇒ 如实回 400，
  // 否则客户端会一直重试一个必然失败的请求。
  assert.equal(clientStatusFor(400, 'context_exceeded'), 400, '上下文超限是客户端该改的')
  assert.equal(clientStatusFor(400, 'image_invalid'), 400, '图片无效是客户端该改的')
})

test('⚠️ 客户端版本号必须与仓库内实测依据一致（5.5.6）', () => {
  // ⚠️ 原值 5.5.4 抄自 Go 侧默认值（旧值），而本仓库 `realtime.ts:222`
  // 在**同一个端点**上写的是 5.5.6 —— 同一仓库两个版本号本身就不一致。
  //
  // 版本号是上游判定**渠道是否被认可**的输入之一（11128）。
  const src = readFileSync('src/upstream/headers.ts', 'utf8')
  assert.ok(/export const CLIENT_VERSION = '5\.5\.6'/.test(src), 'CLIENT_VERSION 应为 5.5.6')
  assert.ok(!/CLIENT_VERSION = '5\.5\.4'/.test(src), '不得残留旧的 5.5.4')
  // 同仓库内保持一致
  const rt = readFileSync('src/upstream/realtime.ts', 'utf8')
  assert.ok(rt.includes("'5.5.6'"), 'realtime 用的也是 5.5.6（保持一致）')
})

test('🔴 渠道拦截绝不能触发 IP 级判定（否则误报「出口 IP 被 WAF 拦截」）', () => {
  // ## 实测缺陷（用户报两个 503）
  //
  // 报障原文：
  // ```
  // 503: 出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403）
  // 503: 供应商「workbuddy」的 1 个账号都在冷却中…约 30 分钟后自动恢复
  // ```
  // 但「两个明明都是正常的」。
  //
  // 根因是我上一轮的修法**引入了新缺陷**：把 11128 归为 `waf_blocked`，
  // 而 `waf_blocked` 会触发 `noteWaf` 的 **IP 级判定** ——
  // 每次 11128 都被记成「IP 级 403 命中」，凑够 `WAF_IP_THRESHOLD = 2`
  // 就**全局停服 60 秒**。而用户有 3 个账号，极易触发。
  //
  // ⚠️ 11128 是**正常的业务码响应**（`{"code":11128}`），
  // 不是 HTTP 403 无信封 —— 两者形态完全不同，必须分开分类。
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const i = src.indexOf("if (kind === 'waf_blocked')")
  assert.ok(i > 0, '应能找到 IP 级判定入口')
  const block = stripComments(src.slice(i, i + 400))

  // IP 级判定**只**对 waf_blocked 触发
  assert.ok(/kind === 'waf_blocked'/.test(block), 'IP 级判定只应对 HTTP 403 的 WAF 触发')
  assert.ok(
    !/channel_blocked/.test(block),
    '⚠️ channel_blocked（11128）**不得**进入 IP 级判定 —— 它与出口 IP 无关',
  )
})

test('⚠️ 渠道拦截与 WAF 必须是两个独立类别（形态不同、处置不同）', () => {
  // - `waf_blocked`：**HTTP 403 + 无业务信封** ⇒ 可能是出口 IP 级 ⇒ 需要 IP 判定
  // - `channel_blocked`：**业务码 11128** ⇒ 请求指纹问题 ⇒ 与 IP / 账号都无关
  //
  // ⚠️ 混为一类会产生两个假故障：
  //   ① 健康账号被逐个软冷却；
  //   ② 凑够阈值后误报「出口 IP 被拦」并全局停服。
  const src = readFileSync('src/upstream/client.ts', 'utf8')
  assert.ok(/11128: 'channel_blocked'/.test(src), '11128 必须归为 channel_blocked')
  assert.ok(!/11128: 'waf_blocked'/.test(src), '⚠️ 不得再归为 waf_blocked')

  // 两者的处置都要「不换号」，但罚款不同
  assert.equal(mapErrorToPunishment('channel_blocked').rotate, false)
  assert.equal(mapErrorToPunishment('channel_blocked').punish, false, '不罚账号')
  assert.equal(mapErrorToPunishment('waf_blocked').punish, true, 'HTTP 403 仍要软冷却')
})

// ───── `role: 'developer'` 导致 11128（用户报两处 502 的根因） ─────

test("🔴 `role:'developer'` 必须被降级为 system（否则上游判「首条不是 system」→ 11128）", () => {
  // ## 实测根因（用户报「错误 502 … unapproved channel」）
  //
  // 用本地日志代理抓到 pi（`pi-coding-agent`）的**真实请求体**：
  // ```json
  // {"model":"workbuddy/deepseek-v4.1-flash",
  //  "messages":[{"role":"developer","content":"You are an expert coding assistant…"}, …]}
  // ```
  // ⚠️ 它用的是 **`developer`** 角色（OpenAI **新**规范），而**上游只认**
  // `system` / `user` / `assistant` / `tool`。
  //
  // 我们原样转发 ⇒ 上游判定「首条不是 system」⇒ 国际版回
  // `11128 Illegal API invocation from an unapproved channel`
  //（`displayMsg` 把它**伪装成「安全策略拦截」**，极易误判成账号被封）。
  //
  // 参考实现的做法是**丢弃** `developer`（`message-shape.ts:99,125`，
  // 理由：它只承载工具增删元数据）。但 pi 那条**确实承载系统提示词**，
  // 丢掉会让模型失去行为约束 ⇒ 我们**多做一步**：有内容就降级为 `system`。
  const msgs = [
    { role: 'developer', content: 'You are an expert coding assistant.' },
    { role: 'user', content: 'hi' },
  ]
  const out = cleanupToolPairing(msgs) as Array<Record<string, unknown>>
  assert.equal(out.length, 2, '两条都应保留')
  assert.equal(out[0]!.role, 'system', '⚠️ developer 必须降级为 system（保住提示词语义）')
  assert.equal(out[0]!.content, 'You are an expert coding assistant.')

  // ⚠️ 配对的**反向**用例：空的 developer（纯元数据）应当**丢弃**，
  // 否则会给上游造出一条空 system。
  const meta = cleanupToolPairing([
    { role: 'developer', content: '' },
    { role: 'user', content: 'hi' },
  ]) as Array<Record<string, unknown>>
  assert.equal(meta.length, 1, '空 developer 应被丢弃')
  assert.equal(meta[0]!.role, 'user')

  // 无 developer 时**不得**改动（零成本透传，且保持数组引用不变）
  const plain = [{ role: 'user', content: 'hi' }]
  assert.equal(cleanupToolPairing(plain), plain, '无改动时应返回原数组引用')
})

test("⚠️ 国际版的「首条必须是 system」判据必须把 developer 视同 system", () => {
  // ⚠️ 若只认 `role === 'system'`，`withSystemFirst` 会**多补一条**
  // 「You are a helpful assistant.」并排在真正的提示词**前面** ——
  // 那会稀释（甚至覆盖）客户端自己的行为约束。
  //
  // 而 pi 的 developer 是首条 ⇒ 必须被视同「已有 system」，不补。
  const src = readFileSync('src/providers/buddy.ts', 'utf8')
  const i = src.indexOf('function withSystemFirst')
  const block = stripComments(src.slice(i, i + 1200))
  assert.ok(/firstRole === 'system'/.test(block), '应认 system')
  assert.ok(/firstRole === 'developer'/.test(block), '⚠️ developer 也必须视同 system')
})

test('🔴 国内版与国际版的 chat 头必须是**两套不同取值**（不能套用）', () => {
  // ## 实测缺陷：我一度把国际版的值套到国内版上
  //
  // 参考实现（`deepseek-harness-codearts/src/product.ts`）里两个产品是
  // **完全不同的客户端形态**，不是同一个模板换段：
  //
  // | 项 | 国内版 CodeBuddy（`id:'buddy'`） | 国际版 WorkBuddy |
  // |---|---|---|
  // | `userAgent` | **`CodeBuddyIDE/1.106.1`** | `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2` |
  // | `attributionName`（三个归属头共用） | **`CodeBuddy`** | `WorkBuddy` |
  // | `clientVersion` | **`1.106.1`** | `5.5.2` |
  // | `apiDomain` | `copilot.tencent.com` | `www.workbuddy.ai` |
  // | `productCode` | `codebuddy` | `workbuddy` |
  const dom = referenceChatHeaders({ uid: 'u', accessToken: 'tok', variant: 'buddy' })
  const intl = referenceChatHeaders({ uid: 'u', accessToken: 'tok', variant: 'workbuddy' })

  // ⚠️ UA 是完全不同的格式（国内版不含 `WorkBuddy`）
  assert.equal(dom['User-Agent'], 'CodeBuddyIDE/1.106.1', '国内版 UA 必须是 IDE 形态')
  // ⚠️ 国际版 UA 逐字对齐参考实现（三段**同值** 5.5.2）
  assert.equal(
    intl['User-Agent'], 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    '国际版 UA 三段都应是 5.5.2（我一度混了国内版段，导致与 X-IDE-Version 自相矛盾）',
  )
  // ⚠️ UA 里的版本号必须与 X-IDE-Version 一致 —— 同一请求里两个版本号
  // 正是「渠道指纹」最容易露馅的地方。
  assert.equal(intl['X-IDE-Version'], '5.5.2')
  assert.ok(intl['User-Agent']?.includes('5.5.2'), 'UA 与 X-IDE-Version 必须同版本')

  // ⚠️ 归属三头在国内版是 `CodeBuddy`
  assert.equal(dom['X-IDE-Name'], 'CodeBuddy', '国内版归属名是 CodeBuddy')
  assert.equal(dom['X-IDE-Type'], 'CodeBuddy')
  assert.equal(dom['X-Product'], 'CodeBuddy')
  assert.equal(intl['X-IDE-Name'], 'WorkBuddy', '国际版归属名是 WorkBuddy')

  // ⚠️ 版本号不同
  assert.equal(dom['X-IDE-Version'], '1.106.1', '国内版版本是 1.106.1')
  assert.equal(intl['X-IDE-Version'], '5.5.2', '国际版版本是 5.5.2')

  // X-Domain 必须与端点一致
  assert.equal(dom['X-Domain'], 'copilot.tencent.com')
  assert.equal(intl['X-Domain'], 'www.workbuddy.ai')
  assert.equal(dom['X-Product-Code'], 'codebuddy')
  assert.equal(intl['X-Product-Code'], 'workbuddy')

  // ⚠️ 参考实现只发这 11 个（多发的头是 Go 侧口径，国际版端点不认）
  assert.equal(dom['Accept'], 'text/event-stream', 'Accept 必须精确（不能带 json 偏好）')
  assert.ok(!('Origin' in dom), '⚠️ 不得发 Origin（Go 侧口径，参考实现不发）')
  assert.ok(!('X-Machine-ID' in dom), '⚠️ 不得发 X-Machine-ID')
  assert.ok(!('X-Conversation-Request-ID' in dom), '⚠️ 不得发 X-Conversation-Request-ID')
  assert.equal(dom['Authorization'], 'Bearer tok', '只保留 Authorization')
})

test('🔴 鉴权失败判据必须认 `invalid access token`（正则跨度写窄会导致续期静默失效）', () => {
  // ## 实测缺陷（这是 minimax「用几分钟就永久 401」的真正根因）
  //
  // 原判据是 `invalid.?token` —— `.?` 只允许**一个**字符，
  // 而 minimax 的真实报错是 `invalid access token`（中间隔了 `access`，
  // 6 个字符）⇒ **匹配失败** ⇒ 续期分支根本不进 ⇒ 「永远是 401」。
  //
  // ⚠️ 症状是「续期**静默**不触发」（不报错），故必须用单测钉死。
  // ⚠️ 我当时的第一版修复（加宽跨度）**又把 `invalid_token` 弄坏了** ——
  // 因为 `\W` 不匹配下划线。这里把两种分隔符都覆盖住。
  for (const detail of [
    'MiniMax 对话失败（http=401）：invalid access token', // ← 真实报错原文
    'invalid_token',
    'invalid-token',
    'invalid token',
    'Invalid access token',
    'the token has expired',
    'token has expired',
  ]) {
    assert.equal(isAuthLikeFailure(0, detail), true, `应判为鉴权失败：${detail}`)
  }
  // ⚠️ 反向：**不能**放宽到 `invalid.*token` —— 那会误伤这类非鉴权错误，
  // 让网关拿一个没坏的凭据去续期（无谓打上游）。
  assert.equal(isAuthLikeFailure(0, 'invalid model, but the token is fine'), false,
    '⚠️ 不能误判：这只是模型名非法，不是鉴权问题')
  // 状态码通路仍然独立有效
  assert.equal(isAuthLikeFailure(401, 'whatever'), true)
  assert.equal(isAuthLikeFailure(403, 'whatever'), true)
  // CodeArts 走 HTTP 400 + 业务码，必须靠**内容**判
  assert.equal(isAuthLikeFailure(400, '{"error_code":"APIG.0602"}'), true)
})
