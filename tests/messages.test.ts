/**
 * Anthropic Messages API 适配层。
 *
 * ## 为什么这组测试的重点是「口径」而不是「能跑」
 *
 * 协议转换本身是机械的，容易写对；**真正会出事的是两处口径**：
 *
 * 1. **`usage.input_tokens` 含不含缓存命中** —— Anthropic 与 OpenAI **相反**。
 *    写反了不会报错，只会让 Claude Code 的上下文占用**虚高近一倍**
 *    ⇒ 才聊几句就触发自动压缩（或反过来永不压缩）。
 * 2. **`tool_result` 必须先于同轮 user 文本** —— 顺序反了上游报配对错误，
 *    而错误文案与「顺序」毫无关系。
 *
 * 故下面用**纯函数**逐条钉住这些口径（不碰网络）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  contentToChat,
  messagesToChat,
  messagesToChatBody,
  parseToolUseInput,
  systemTextOf,
  toAnthropicStopReason,
  toAnthropicUsage,
  toolChoiceToChat,
  toolsToChat,
} from '../src/gateway/messages.ts'

// ─────────────────────── usage 口径（最关键的一条） ───────────────────────

test('🔴 Anthropic usage：input_tokens 必须**扣掉**缓存命中（与 Responses 相反）', () => {
  // ## 缺陷形态（写错不会报错，只会让上下文占用算错）
  //
  // 上游给 OpenAI 口径：`prompt_tokens` **含**缓存命中
  //（命中量在 `prompt_tokens_details.cached_tokens`）。
  //
  // Anthropic 要求 `input_tokens` **不含**命中，命中单列 `cache_read_input_tokens`。
  // Claude Code 用 `input_tokens + cache_read_input_tokens` 算总占用。
  //
  // ⇒ **不扣减**：总数 = 含命中 + 命中 = 虚高近一倍 ⇒ 过早自动压缩。
  const usage = toAnthropicUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
  })
  assert.equal(usage.input_tokens, 200, '1000 含 800 命中 ⇒ 未命中 200')
  assert.equal(usage.cache_read_input_tokens, 800)
  assert.equal(usage.output_tokens, 200)

  // ⚠️ 关键不变式：两者相加必须等于上游的 prompt_tokens（不虚高也不丢失）
  assert.equal(
    Number(usage.input_tokens) + Number(usage.cache_read_input_tokens),
    1000,
    '⚠️ input + cache_read 必须等于上游 prompt_tokens',
  )
})

test('usage：无缓存命中时不发 cache_read_input_tokens（避免界面上显示 0 的噪声）', () => {
  const usage = toAnthropicUsage({ prompt_tokens: 50, completion_tokens: 10 })
  assert.equal(usage.input_tokens, 50)
  assert.equal(usage.output_tokens, 10)
  assert.ok(!('cache_read_input_tokens' in usage), '无命中时不应带该字段')
})

test('usage：上游字段畸形时不得出现负数（会让占用条算出负值）', () => {
  // 防御：上游理论上 cached <= prompt，但本项目见过它字段自相矛盾
  const usage = toAnthropicUsage({
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 500 },
  })
  assert.equal(usage.input_tokens, 0, '⚠️ 必须夹到 0，不能是负数')
  assert.ok(Number(usage.input_tokens) >= 0)
})

// ─────────────────────── 系统提示 ───────────────────────

test('system：可以是块数组，且必须拼成文本（不能变成 [object Object]）', () => {
  assert.equal(systemTextOf('你是助手'), '你是助手')
  assert.equal(
    systemTextOf([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]),
    'AB',
  )
  // ⚠️ 直接 String([{...}]) 会得到 "[object Object]" —— 一条内容全错的 system
  assert.equal(systemTextOf([{ type: 'text', text: 'X' }]), 'X')
  assert.equal(systemTextOf(undefined), '')
})

test('system 必须被提到 messages 最前面（Chat 的语义要求）', () => {
  const chat = messagesToChatBody(
    { system: 'SYS', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
    'm',
  )
  const msgs = chat.messages as Array<{ role: string }>
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[1].role, 'user')
})

// ─────────────────────── tool_result 顺序 ───────────────────────

test('🔴 tool_result 必须拆成独立的 tool 消息，且**先于**同轮 user 文本', () => {
  // ## 为什么顺序关键
  //
  // 一条 Anthropic user 消息里可能**既有** `tool_result`（回应上一轮调用）
  // **又有**新文本。拆开后必须「先 tool 再 user」——
  // 反了会让上游认为「工具结果没有对应的调用」而报配对错误，
  // 而那个错误文案与「顺序」毫无关系，极难归因。
  const msgs = messagesToChat([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '结果1' },
        { type: 'text', text: '继续' },
      ],
    },
  ]) as Array<{ role: string; tool_call_id?: string }>

  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'tool', '⚠️ tool 必须在前')
  assert.equal(msgs[0].tool_call_id, 'call_1')
  assert.equal(msgs[1].role, 'user', '⚠️ 同轮文本必须在其后')
})

test('纯 tool_result 轮次不产生空的 user 消息', () => {
  const msgs = messagesToChat([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] },
  ]) as Array<{ role: string }>
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'tool')
})

test('assistant 的 tool_use 必须提升成 tool_calls（arguments 是 JSON 字符串）', () => {
  const msgs = messagesToChat([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '北京' } },
      ],
    },
  ]) as Array<Record<string, unknown>>

  const tc = msgs[0].tool_calls as Array<Record<string, unknown>>
  assert.equal(tc.length, 1)
  const fn = tc[0].function as Record<string, unknown>
  assert.equal(fn.name, 'get_weather')
  // ⚠️ Chat 要**字符串**；Anthropic 给的是对象
  assert.equal(typeof fn.arguments, 'string')
  assert.deepEqual(JSON.parse(String(fn.arguments)), { city: '北京' })
  // ⚠️ id 必须沿用（它是下一轮 tool_result.tool_use_id 的对应键）
  assert.equal(tc[0].id, 'call_9')
})

// ─────────────────────── 工具与图片 ───────────────────────

test('tools：input_schema 映射到 parameters', () => {
  const tools = toolsToChat([
    {
      name: 'get_weather',
      description: '查天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ]) as Array<Record<string, unknown>>
  assert.equal(tools.length, 1)
  const fn = tools[0].function as Record<string, unknown>
  assert.equal(fn.name, 'get_weather')
  assert.deepEqual(fn.parameters, { type: 'object', properties: { city: { type: 'string' } } })
})

test('工具参数畸形时不得抛错（一次畸形不该让整轮失败）', () => {
  assert.deepEqual(parseToolUseInput('{坏 JSON'), { raw: '{坏 JSON' })
  assert.deepEqual(parseToolUseInput(''), {})
  assert.deepEqual(parseToolUseInput({ a: 1 }), { a: 1 })
  // 非对象 JSON 包一层，保住原值
  assert.deepEqual(parseToolUseInput('[1,2]'), { value: [1, 2] })
})

test('🔴 图片只接受 base64 内联；URL 形态必须**跳过**（SSRF 红线）', () => {
  // ⚠️ 按 URL 去下载能打环回 / 云元数据端点（AGENTS.md §7.1.3）
  const urlForm = contentToChat([
    { type: 'image', source: { type: 'url', url: 'http://169.254.169.254/latest/meta-data' } },
  ])
  assert.equal(urlForm.skippedImages, 1, '⚠️ URL 形态必须被跳过并计数')
  assert.ok(
    !JSON.stringify(urlForm.content).includes('169.254'),
    '⚠️ 绝不能把该 URL 转发出去',
  )

  const b64 = contentToChat([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ])
  assert.equal(b64.skippedImages, 0)
  assert.ok(JSON.stringify(b64.content).includes('data:image/png;base64,AAAA'))
})

test('纯文本内容转成字符串（不是块数组）', () => {
  const r = contentToChat([{ type: 'text', text: '你好' }])
  assert.equal(typeof r.content, 'string', '纯文本应用字符串形态（兼容性最好）')
  assert.equal(r.content, '你好')
})

test('stop_reason 映射：finish_reason 与 tool_calls 都要认', () => {
  assert.equal(toAnthropicStopReason('length'), 'max_tokens')
  assert.equal(toAnthropicStopReason('stop'), 'end_turn')
  assert.equal(toAnthropicStopReason('tool_calls'), 'tool_use')
  assert.equal(toAnthropicStopReason('content_filter'), 'refusal')
  // ⚠️ 即使 finish_reason 是 stop，只要有工具调用就必须是 tool_use
  assert.equal(toAnthropicStopReason('stop', true), 'tool_use')
})

test('tool_choice 映射：any → required（Anthropic 与 OpenAI 用词不同）', () => {
  assert.equal(toolChoiceToChat({ type: 'auto' }), 'auto')
  assert.equal(toolChoiceToChat({ type: 'any' }), 'required')
  assert.equal(toolChoiceToChat({ type: 'none' }), 'none')
  assert.deepEqual(
    toolChoiceToChat({ type: 'tool', name: 'f' }),
    { type: 'function', function: { name: 'f' } },
  )
})

// ─────────────────────── 鉴权：x-api-key ───────────────────────

test('🔴 claude code 发的是 x-api-key，不是 Authorization（必须两种都认）', async () => {
  // ## 前提缺失（真实阻碍）
  //
  // Anthropic 官方 SDK 与 Claude Code 发 **`x-api-key: <key>`**。
  // 我们此前只读 `Authorization` ⇒ 就算接了 `/v1/messages`，Claude Code 也进不来，
  // 而且它**不会告诉你「请换个头」**（只会显示 401）。
  const { clientKeyOf } = await import('../src/gateway/authz.ts')

  const mk = (headers: Record<string, string>): Request =>
    new Request('https://x/v1/messages', { method: 'POST', headers })

  assert.equal(clientKeyOf(mk({ 'x-api-key': 'K1' })).key, 'K1', '只带 x-api-key 必须认')
  assert.equal(clientKeyOf(mk({ authorization: 'Bearer K2' })).key, 'K2', '只带 Authorization 必须认')
  // 两个都带且**相同** ⇒ 照收（有些客户端两个都发）
  assert.equal(clientKeyOf(mk({ 'x-api-key': 'K3', authorization: 'Bearer K3' })).key, 'K3')
  // 两个都带且**不同** ⇒ 拒绝（不许「任选一个能过的」）
  const conflict = clientKeyOf(mk({ 'x-api-key': 'A', authorization: 'Bearer B' }))
  assert.equal(conflict.conflict, true, '⚠️ 值不同必须拒绝')
  assert.equal(conflict.key, '', '冲突时不返回任何 key')
  // 都不带
  assert.equal(clientKeyOf(mk({})).key, '')
})

// ─────────────────────── 请求体上限 ───────────────────────

test('🔴 MAX_REQUEST_BYTES：绝不用 `parseInt(x) || 默认`（0 是合法「不限制」）', async () => {
  // ## 本项目 §6.8 的硬规则
  //
  // `parseInt('0') || 默认` 会把 `0` 当成「没配置」回落默认 ——
  // 而 `0` 在这里的语义是**不限制**，是一个有意为之的合法配置。
  const { DEFAULT_MAX_REQUEST_BYTES, resolveMaxRequestBytes } = await import('../src/env.ts')
  const mk = (v?: string): { MAX_REQUEST_BYTES?: string } =>
    v === undefined ? {} : { MAX_REQUEST_BYTES: v }

  assert.equal(resolveMaxRequestBytes(mk() as never), DEFAULT_MAX_REQUEST_BYTES, '未设置用默认')
  assert.equal(resolveMaxRequestBytes(mk('') as never), DEFAULT_MAX_REQUEST_BYTES, '空串用默认')
  assert.equal(resolveMaxRequestBytes(mk('0') as never), 0, '⚠️ 0 = 不限制（不是回落默认）')
  assert.equal(resolveMaxRequestBytes(mk('1048576') as never), 1048576)
  // 非纯整数一律回落默认（不猜：`Number('0x10')` 是 16 那种宽容很危险）
  assert.equal(resolveMaxRequestBytes(mk('8MiB') as never), DEFAULT_MAX_REQUEST_BYTES)
  assert.equal(resolveMaxRequestBytes(mk('1e9') as never), DEFAULT_MAX_REQUEST_BYTES)
  assert.equal(resolveMaxRequestBytes(mk('-5') as never), DEFAULT_MAX_REQUEST_BYTES)
  // 超过 1 GiB 视为误填
  assert.equal(resolveMaxRequestBytes(mk('999999999999') as never), DEFAULT_MAX_REQUEST_BYTES)
})

test('超限请求体必须变成**可读的 413**（不是平台掐断的 500）', async () => {
  const { readJsonCapped } = await import('../src/gateway/http.ts')

  // ① content-length 声明超限 ⇒ 不读体就拒（廉价、零 CPU）
  const big = new Request('https://x/y', {
    method: 'POST',
    headers: { 'content-length': String(10 * 1024 * 1024) },
    body: '{}',
  })
  const r1 = await readJsonCapped(big, 1024)
  assert.equal(r1.ok, false)
  assert.equal(r1.ok === false && r1.response.status, 413)

  // ② 413 文案必须给出「实际多大 / 上限多少 / 怎么改」三件事
  if (!r1.ok) {
    const text = await r1.response.text()
    assert.ok(text.includes('MiB'), '要说明体积')
    assert.ok(text.includes('MAX_REQUEST_BYTES'), '⚠️ 要告诉用户该调哪个环境变量')
  }

  // ③ 正常大小照常解析
  const ok = new Request('https://x/y', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
  })
  const r2 = await readJsonCapped(ok, 1024)
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.ok && r2.value, { a: 1 })

  // ④ limit=0 = 不限制
  const r3 = await readJsonCapped(
    new Request('https://x/y', { method: 'POST', body: '{"b":2}' }), 0,
  )
  assert.equal(r3.ok, true)
})

test('面板必须带 X-Robots-Tag: noindex（不能被搜索引擎收录）', async () => {
  // 面板挂在公网域上，被收录等于对外宣告「这里跑着多供应商账号池」
  const { loginSecurityHeaders, securityHeaders } = await import('../src/panel/index.ts')
  for (const [label, headers] of [
    ['面板', securityHeaders()],
    ['登录页', loginSecurityHeaders()],
  ] as const) {
    const tag = headers['x-robots-tag'] ?? ''
    assert.ok(tag.includes('noindex'), `⚠️ ${label}必须 noindex`)
    assert.ok(tag.includes('nofollow'), `${label}还应 nofollow（禁止沿链接爬取）`)
  }
})
