/**
 * `/v1/responses`（OpenAI Responses API）单测。
 *
 * ⚠️ 只测**纯转换**（不碰网络）—— 端到端由部署后实测覆盖。
 * 原因：这里全是「形状转换」，而形状写错的症状是**静默**的
 *（模型不调工具、上下文丢失、客户端算错 token），必须用单测钉死。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { toChatBody, toResponsesObject, usageOf, ResponsesError } from '../src/gateway/responses.ts'

test('🔴 Responses 的 `tools` 是**扁平**的，必须转成 Chat 的嵌套形状', () => {
  // ⚠️ 这是最容易写错的一处。两边形状不同：
  //   Responses: {"type":"function","name":"f","parameters":{...}}
  //   Chat:      {"type":"function","function":{"name":"f","parameters":{...}}}
  // 不转的话上游认为「没有工具」⇒ 模型永远不调用工具，
  // 而客户端看到的是「模型不听话」，完全想不到是工具没传进去。
  const chat = toChatBody({
    input: 'hi',
    tools: [
      { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } },
    ],
  }, 'm')
  const tools = chat.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.type, 'function')
  const fn = tools[0]!.function as Record<string, unknown>
  assert.equal(fn.name, 'get_weather', '⚠️ 必须嵌到 function 下')
  assert.equal(fn.description, '查天气')
  assert.deepEqual(fn.parameters, { type: 'object', properties: {} })
  // ⚠️ 顶层不该残留 name（那说明没转换）
  assert.equal(tools[0]!.name, undefined, '顶层不该有 name')
})

test('⚠️ 非 function 类型的工具必须丢弃（上游不支持，发过去会整个 400）', () => {
  const chat = toChatBody({
    input: 'hi',
    tools: [
      { type: 'web_search' },
      { type: 'function', name: 'keep_me', parameters: {} },
      { type: 'file_search' },
    ],
  }, 'm')
  const tools = chat.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1, '只保留 function 类型')
  assert.equal((tools[0]!.function as Record<string, unknown>).name, 'keep_me')
})

test('🔴 `instructions` 必须转成首条 system（国际版硬要求）', () => {
  // ⚠️ 国际版端点**要求首条是 system**，否则回 11128 且被伪装成
  //「安全策略拦截」（见 buddy.ts 的说明）。故 `instructions` 必须变成 system 消息。
  const chat = toChatBody({ instructions: '你是助手', input: '你好' }, 'm')
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, 'system')
  assert.equal(msgs[0]!.content, '你是助手')
  assert.equal(msgs[1]!.role, 'user')
})

test('⚠️ `input` 字符串与数组两种形态都要支持', () => {
  const a = toChatBody({ input: 'hi' }, 'm')
  assert.deepEqual((a.messages as unknown[])[0], { role: 'user', content: 'hi' })

  const b = toChatBody({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
  }, 'm')
  const msgs = b.messages as Array<Record<string, unknown>>
  assert.deepEqual(msgs[0], { role: 'user', content: [{ type: 'text', text: '你好' }] },
    '⚠️ input_text 必须转成 Chat 的 text')
})

test('⚠️ `developer` 角色必须转成 system（保住提示词顺序）', () => {
  // pi 这类客户端用 OpenAI **新**规范，把系统提示词放 `developer` 里。
  // ⚠️ 若不在**这一步**转成 system，它会被 payload 的清理逻辑挪位置，
  // system 提示词的位置就变了（那会让模型的注意力落在错误的地方）。
  const chat = toChatBody({
    input: [{ type: 'message', role: 'developer', content: '系统提示' }, { role: 'user', content: 'hi' }],
  }, 'm')
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs[0]!.role, 'system', '⚠️ developer 必须转成 system')
  assert.equal(msgs[0]!.content, '系统提示')
})

test('⚠️ 工具调用的历史（function_call / function_call_output）必须能往返', () => {
  const chat = toChatBody({
    input: [
      { role: 'user', content: '天气' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"c":"bj"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴' },
    ],
  }, 'm')
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 3)
  const asst = msgs[1]!
  assert.equal(asst.role, 'assistant')
  const calls = asst.tool_calls as Array<Record<string, unknown>>
  assert.equal(calls[0]!.id, 'call_1')
  assert.equal((calls[0]!.function as Record<string, unknown>).name, 'get_weather')
  const tool = msgs[2]!
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'call_1', '⚠️ tool 消息靠 tool_call_id 配对，写错就整条会话 400')
  assert.equal(tool.content, '晴')
})

test('⚠️ `function_call` 缺 call_id 时回落到 `id`', () => {
  // 参考实现（responses.ts:490-492）：`call_id` 才是配对 id，`id`（fc_…）只是
  // item 身份。两者都可能出现，优先 call_id，缺了才退回 id。
  const chat = toChatBody({
    input: [{ type: 'function_call', id: 'fc_abc', name: 'f', arguments: '{}' }],
  }, 'm')
  const calls = (chat.messages as Array<Record<string, unknown>>)[0]!.tool_calls as Array<Record<string, unknown>>
  assert.equal(calls[0]!.id, 'fc_abc')
})

test('⚠️ `reasoning` 历史项必须丢弃（无法回放加密思考内容）', () => {
  const chat = toChatBody({
    input: [
      { type: 'reasoning', summary: [] },
      { role: 'user', content: 'hi' },
    ],
  }, 'm')
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]!.role, 'user')
})

test('🔴 `previous_response_id` 必须**报错**，不能静默忽略', () => {
  // ⚠️ 静默忽略是危险的：客户端以为服务端记着上一轮上下文，于是只发本轮新增内容；
  // 我们忽略它，模型就只看到那一点内容，答非所问。
  // 故宁可明确报错，让客户端知道本网关无状态。
  assert.throws(() => toChatBody({ input: 'hi', previous_response_id: 'resp_x' }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: 'hi', store: true }, 'm'), ResponsesError)
})

test('🔴 `usage.input_tokens` 必须**含**缓存命中（官方口径）', () => {
  // ⚠️ 参考实现曾经写反过（发不含缓存的），后果是 Codex 算
  // `input_tokens - cached` 得到负数而夹到 0 ⇒ 上下文占用少算上百倍
  // ⇒ **自动压缩永不触发**。依据 `responses.ts:28-36`。
  const u = usageOf({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 800 } })!
  assert.equal(u.input_tokens, 1000, '⚠️ 必须是**总输入**（含缓存），不是 200')
  assert.deepEqual(u.input_tokens_details, { cached_tokens: 800 })
  assert.equal(u.output_tokens, 50)
  assert.equal(u.total_tokens, 1050)
  // ⚠️ 未命中量由客户端自己算（1000-800=200），我们不能替它减掉。
  assert.equal((u.input_tokens as number) - 800, 200)
})

test('⚠️ `max_output_tokens` → `max_completion_tokens`（由 Chat 路径统一改写）', () => {
  const chat = toChatBody({ input: 'hi', max_output_tokens: 4096 }, 'm')
  assert.equal(chat.max_completion_tokens, 4096)
  // ⚠️ 不发 `max_tokens`：那是上游认的旧名，由 prepareChatBody 单点改写，
  // 免得两个端点各写一份而漂移。
  assert.equal(chat.max_tokens, undefined)
})

test('⚠️ `reasoning.effort` → 顶层 `reasoning_effort`（不转会静默丢失档位）', () => {
  const chat = toChatBody({ input: 'hi', reasoning: { effort: 'high' } }, 'm')
  assert.equal(chat.reasoning_effort, 'high')
  // 非法值要被拦下，而不是发个上游看不懂的东西
  assert.throws(() => toChatBody({ input: 'hi', max_output_tokens: -1 }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: 'hi', max_output_tokens: 1.5 }, 'm'), ResponsesError)
})

test('⚠️ 图片块：input_image → image_url，且**绝不**自行下载 URL', () => {
  // ⚠️ 不下载是安全红线（SSRF：能打环回 / 云元数据端点，AGENTS.md §7.1）。
  const chat = toChatBody({
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }] }],
  }, 'm')
  const msg = (chat.messages as Array<Record<string, unknown>>)[0]!
  assert.deepEqual(msg.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }])
})

test('⚠️ 空 input / 无可用消息必须报错（不能发出一个空请求）', () => {
  assert.throws(() => toChatBody({ input: [] }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: [{ type: 'reasoning' }] }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({}, 'm'), ResponsesError)
})

test('🔴 非流式输出对象必须含官方要求的全部字段', () => {
  // 字段逐项对齐参考实现 `responses.ts:843-872`。缺字段会让标准客户端解析失败。
  const obj = toResponsesObject(
    { input: 'hi', max_output_tokens: 100, reasoning: { effort: 'low' } },
    'test-model',
    {
      id: 'x', object: 'chat.completion', created: 1, model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    'resp_1',
  )
  assert.equal(obj.id, 'resp_1')
  assert.equal(obj.object, 'response')
  assert.equal(obj.status, 'completed')
  assert.equal(obj.model, 'test-model')
  assert.equal(obj.background, false)
  assert.equal(obj.store, false)
  assert.equal(obj.error, null)
  assert.equal(obj.incomplete_details, null)
  assert.equal(obj.previous_response_id, null)
  assert.deepEqual(obj.reasoning, { effort: 'low', summary: null })
  assert.deepEqual(obj.text, { format: { type: 'text' } })
  assert.equal(obj.max_output_tokens, 100)
  // ⚠️ `created_at` 单位是**秒**（不是毫秒）
  assert.ok(typeof obj.created_at === 'number' && (obj.created_at as number) < 1e11,
    '⚠️ created_at 必须是**秒**')
  // output 项
  const out = obj.output as Array<Record<string, unknown>>
  assert.equal(out.length, 1)
  assert.equal(out[0]!.type, 'message')
  assert.equal(out[0]!.role, 'assistant')
  const content = out[0]!.content as Array<Record<string, unknown>>
  assert.equal(content[0]!.type, 'output_text')
  assert.equal(content[0]!.text, '你好')
  assert.deepEqual(content[0]!.annotations, [])
})

test('⚠️ `finish_reason: length` → status `incomplete` + incomplete_details', () => {
  const obj = toResponsesObject({ input: 'hi' }, 'm', {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '截断' }, finish_reason: 'length' }],
  }, 'r')
  assert.equal(obj.status, 'incomplete')
  assert.deepEqual(obj.incomplete_details, { reason: 'max_output_tokens' })
})

test('🔴 工具调用必须产出 function_call 输出项，且正文为空时不发空 message', () => {
  const obj = toResponsesObject({ input: 'hi' }, 'm', {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
      ] },
    }],
  }, 'r')
  const out = obj.output as Array<Record<string, unknown>>
  // ⚠️ 正文为空 + 有工具调用 ⇒ **只**发 function_call 项。
  // 多发一个空 message 项会让客户端渲染一个空气泡。
  assert.equal(out.length, 1, '⚠️ 不该发空的 message 项')
  assert.equal(out[0]!.type, 'function_call')
  assert.equal(out[0]!.call_id, 'call_1')
  assert.equal(out[0]!.name, 'f')
  assert.equal(out[0]!.arguments, '{"a":1}')
})

test('⚠️ reasoning_content 要单独成一个 reasoning 输出项', () => {
  const obj = toResponsesObject({ input: 'hi' }, 'm', {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '答案', reasoning_content: '思考中' }, finish_reason: 'stop' }],
  }, 'r')
  const out = obj.output as Array<Record<string, unknown>>
  assert.equal(out.length, 2)
  assert.equal(out[0]!.type, 'reasoning', '⚠️ reasoning 项应在正文之前')
  assert.deepEqual(out[0]!.summary, [{ type: 'summary_text', text: '思考中' }])
  assert.equal(out[1]!.type, 'message')
  // ⚠️ `output_index` 必须等于它在 output[] 里的下标
  assert.equal(out[0]!['output_index'], undefined, 'output 项本身不带 output_index（那是事件字段）')
})

test('⚠️ usage 为 null 时输出 null（不能编造 0 —— 那会被当成真实用量记账）', () => {
  assert.equal(usageOf(null), null)
  assert.equal(usageOf(undefined), null)
  const obj = toResponsesObject({ input: 'hi' }, 'm', {
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }],
  }, 'r')
  assert.equal(obj.usage, null)
})
