/**
 * **OpenAI Responses API** 出口（`POST /v1/responses`）。
 *
 * ## 为什么要有它
 *
 * 本项目最初只有 `/v1/chat/completions`。而新一代客户端（Codex CLI、以及各家
 * 「只认 Responses」的 agent）**不发** `messages` / `max_tokens`，而是发
 * `input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的
 * SSE 事件（`response.output_text.delta` / `response.output_item.done` /
 * `response.completed`）。协议外壳不同，往里塞 Chat Completions 是塞不进的。
 *
 * 依据：参考实现 `deepseek-harness-codearts/src/openai-gateway/responses.ts:2-16`。
 *
 * ## ⚠️ 两个端点**同时可用**，不做「格式开关」
 *
 * 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让「另一个协议的
 * 客户端在切换后突然失效」，而网关这边本来就没有任何互斥的理由 ——
 * 两者共用同一份 provider 路由、账号池与图片入站。
 *
 * ## 实现策略：**借用 Chat 路径，只做协议外壳转换**
 *
 * 本模块**不重新实现**选号 / 轮转 / 冷却 / 续期那一整套（那是网关最复杂、
 * 已用真实账号验证过的部分）。做法是：
 *
 * ```
 * Responses 请求  ──toChatBody()──▶  Chat 请求体
 *                                      │
 *                          handleChatCompletions()   ← 复用全部既有能力
 *                                      │
 *              ┌───────────────────────┴───────────────────────┐
 *              ▼                                               ▼
 *   非流式：aggregateSse() → toResponsesObject()      流式：toResponsesSse()
 * ```
 *
 * ⚠️ 这样做的**代价**：多一层转换。但换来的是「Chat 路径修好的任何缺陷
 *（如 11128 渠道指纹、6004 模型级限流、developer 角色）本端点**自动受益**」——
 * 若两套各写一遍路由，这些缺陷就必须修两遍，而本项目已经吃过
 * 「同一个 bug 只修了一半」的教训（见 AGENTS.md 的 provider 路径 6004 那次）。
 *
 * ⚠️ **与 Chat 路径的有意差异**（改这个文件前先读）
 *
 * 1. **文本以 `output_text.done` 为准**，不以 delta 累积为准 —— 这是按协议本意。
 * 2. **`usage.input_tokens` 含缓存命中**，命中部分单列在
 *    `input_tokens_details.cached_tokens`。这正是 OpenAI 官方口径，也是 Codex
 *    的判据（它算 `input_tokens - cached` 得未命中量）。
 *    ⚠️ 参考实现**曾经写反过**（发不含缓存的），后果是 Codex 把缓存量当成
 *    负输入而夹到 0，上下文占用被少算上百倍、自动压缩永不触发
 *    （`responses.ts:28-36`）。故这里严格按官方口径。
 */

import {
  aggregateSse, createFrameTranslator, detectErrorFrame, parseSseLine,
  type AggregatedCompletion,
} from './stream.js'
import { handleChatCompletions } from './server.js'
import type { Env } from '../env.js'

// ─────────────────────────── 请求侧 ───────────────────────────

/** Responses 请求体（只声明我们会读的字段）。 */
export interface ResponsesRequest {
  model?: unknown
  input?: unknown
  instructions?: unknown
  max_output_tokens?: unknown
  tools?: unknown
  tool_choice?: unknown
  reasoning?: unknown
  temperature?: unknown
  top_p?: unknown
  stream?: unknown
  user?: unknown
  metadata?: unknown
  parallel_tool_calls?: unknown
  previous_response_id?: unknown
  store?: unknown
  truncation?: unknown
}

/** 请求转换失败（会被上层转成一个 400）。 */
export class ResponsesError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ResponsesError'
    this.status = status
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 取正整数字段（`max_output_tokens`）。非法值**报错而不静默忽略**。 */
function positiveInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ResponsesError(`${field} must be a positive integer`)
  }
  return v
}

/**
 * Responses 的 content 块 → Chat 的 content 块。
 *
 * ⚠️ 两边的**类型名不同**，这是最容易漏的一处：
 * | Responses | Chat |
 * |---|---|
 * | `input_text` | `text` |
 * | `input_image` | `image_url` |
 * | `output_text` | `text`（assistant 历史） |
 */
function chatPartsFromResponses(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const raw of content) {
    if (!isObject(raw)) continue
    const type = raw.type
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      out.push({ type: 'text', text: typeof raw.text === 'string' ? raw.text : '' })
      continue
    }
    if (type === 'input_image') {
      // ⚠️ 只接受 `image_url` 字符串形式。**绝不**按 URL 去下载
      //（那是 SSRF：能打环回 / 云元数据端点，见 AGENTS.md §7.1）。
      // 客户端要发图片就自己 base64 内联。
      const url = nonEmptyString(raw.image_url)
      if (url !== undefined) out.push({ type: 'image_url', image_url: { url } })
      continue
    }
    // 未知块类型**丢弃**而不是报错：上游新增块类型时，
    // 整个会话不该因此不可用（与参考实现「丢一个重复工具」同一取舍）。
  }
  return out.length > 0 ? out : ''
}

/** 从 content 里抽出纯文本（assistant / system 历史用）。 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const raw of content) {
    if (!isObject(raw)) continue
    if (typeof raw.text === 'string') out += raw.text
  }
  return out
}

/**
 * Responses 的 `tools` → Chat 的 `tools`。
 *
 * ⚠️ **形状不同，这是最容易写错的一处**：
 * ```jsonc
 * // Responses：**扁平**
 * {"type":"function","name":"get_weather","parameters":{...},"description":"..."}
 * // Chat：嵌在 `function` 下
 * {"type":"function","function":{"name":"get_weather","parameters":{...}}}
 * ```
 * 不转的话上游会认为「没有工具」，模型于是永远不会调用任何工具 ——
 * 而客户端看到的是「模型不听话」，完全想不到是工具没传进去。
 *
 * ⚠️ 非 function 类型（`web_search` / `file_search` / `computer_use` 等
 * 各家自定义工具）**直接丢弃**：本网关的上游不支持它们，
 * 发过去只会 400 并让整个请求失败。
 */
function toChatTools(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new ResponsesError('tools must be an array')
  const out: unknown[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    if (item.type !== 'function') continue
    const name = nonEmptyString(item.name)
    if (name === undefined) continue
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof item.description === 'string' ? item.description : '',
        parameters: isObject(item.parameters) ? item.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 校验那些「语义会变、故不能静默忽略」的字段。
 *
 * ⚠️ 静默忽略 `previous_response_id` 是**危险**的：客户端以为服务端记着上一轮
 * 上下文，于是只发本轮新增内容 —— 我们忽略它，模型就只看到那一点内容，
 * 答非所问。故**宁可明确报错**，让客户端知道本网关无状态。
 */
function assertSupported(body: ResponsesRequest): void {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new ResponsesError(
      'previous_response_id is not supported: this gateway is stateless and stores no responses. '
        + 'Please send the full conversation in `input` each time.',
    )
  }
  if (body.store === true) {
    // ⚠️ 不静默忽略：客户端以为「服务端存了」，之后拿 id 来引用会拿不到。
    throw new ResponsesError(
      'store:true is not supported: this gateway is stateless and keeps no response history.',
    )
  }
}

/**
 * Responses 请求体 → Chat 请求体。
 *
 * @param body 已解析的 Responses 请求体
 * @param model 已由调用方**去掉 `provider/` 前缀**的模型名
 */
export function toChatBody(body: ResponsesRequest, model: string): Record<string, unknown> {
  assertSupported(body)

  const messages: unknown[] = []

  // `instructions` 是 Responses 里 system 提示词的**唯一**位置。
  // ⚠️ 必须转成一条 `system` 消息：国际版端点**要求首条是 system**
  //（否则回 11128 且伪装成「安全策略拦截」，见 buddy.ts 的说明）。
  const instructions = nonEmptyString(body.instructions)
  if (instructions !== undefined) messages.push({ role: 'system', content: instructions })

  const input = body.input
  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (!isObject(raw)) throw new ResponsesError('input entries must be objects')
      const type = raw.type
      // `type` 缺省时按 EasyInputMessage 处理（`{role, content}`）—— 官方允许这种简写。
      if (type === undefined || type === 'message') {
        const role = raw.role
        const content = chatPartsFromResponses(raw.content)
        if (role === 'user') {
          messages.push({ role: 'user', content })
          continue
        }
        if (role === 'assistant') {
          messages.push({ role: 'assistant', content: textFromContent(content) })
          continue
        }
        if (role === 'system' || role === 'developer') {
          // ⚠️ `developer` 也收下并转成 `system`：我们内部会把它规整成 system
          //（见 payload.ts），但**这里先转**能保住顺序 ——
          // 否则它会被 payload 的清理逻辑移到别处，system 提示词的位置就变了。
          messages.push({ role: 'system', content: textFromContent(content) })
          continue
        }
        throw new ResponsesError(`unsupported message role: ${String(role)}`)
      }
      if (type === 'function_call') {
        // ⚠️ `call_id` 才是与 `function_call_output` 配对的 id；`id`（`fc_…`）
        // 只是 item 身份。两者都可能出现，优先 `call_id`，缺了才退回 `id`。
        const callId = nonEmptyString(raw.call_id) ?? nonEmptyString(raw.id)
        const name = nonEmptyString(raw.name)
        const args = typeof raw.arguments === 'string' ? raw.arguments : ''
        if (callId === undefined || name === undefined) {
          throw new ResponsesError('function_call requires call_id and name')
        }
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
        })
        continue
      }
      if (type === 'function_call_output') {
        const callId = nonEmptyString(raw.call_id)
        if (callId === undefined) throw new ResponsesError('function_call_output requires call_id')
        // `output` 可能是字符串，也可能是 content 块数组 —— 两种都要认。
        const out = raw.output
        const text = typeof out === 'string' ? out : textFromContent(out)
        messages.push({ role: 'tool', tool_call_id: callId, content: text })
        continue
      }
      if (type === 'reasoning') {
        // 历史里的推理项**刻意丢弃**：它承载的是上游加密的思考内容，
        // 网关既没有解密通道也没有可回放的等价物（与 Chat 路径一致 ——
        // 那里的 `reasoning_content` 同样不回传上游）。
        continue
      }
      if (type === 'item_reference') {
        throw new ResponsesError(
          'item_reference is not supported: this gateway is stateless and cannot resolve references.',
        )
      }
      throw new ResponsesError(`input item type ${String(type)} is not supported`)
    }
  } else if (input !== undefined && input !== null) {
    throw new ResponsesError('input must be a string or an array of items')
  }

  if (messages.length === 0) throw new ResponsesError('input contains no usable message')

  const chat: Record<string, unknown> = { model, messages }

  const maxOut = positiveInt(body.max_output_tokens, 'max_output_tokens')
  // ⚠️ 发 `max_completion_tokens`（Responses 的官方字段名），
  // 由 `prepareChatBody` 统一改写成上游认的 `max_tokens` ——
  // 这样「字段改写」只有一处，不会两个端点各写一份而漂移。
  if (maxOut !== undefined) chat.max_completion_tokens = maxOut

  const tools = toChatTools(body.tools)
  if (tools !== undefined) chat.tools = tools
  if (body.tool_choice !== undefined && body.tool_choice !== null) chat.tool_choice = body.tool_choice

  if (typeof body.temperature === 'number') chat.temperature = body.temperature
  if (typeof body.top_p === 'number') chat.top_p = body.top_p
  if (typeof body.user === 'string' && body.user !== '') chat.user = body.user

  /**
   * ⚠️ `reasoning.effort` → `reasoning_effort`。
   *
   * Responses 把思考档位放在**嵌套对象**里（`{reasoning:{effort}}`），
   * 而 Chat 路径读的是顶层 `reasoning_effort`。不转的话档位丢失，
   * 用户设的 `high` 会被静默忽略（模型仍按默认档跑，看起来「设了没用」）。
   */
  if (isObject(body.reasoning)) {
    const effort = nonEmptyString(body.reasoning.effort)
    if (effort !== undefined) chat.reasoning_effort = effort
  }

  return chat
}

// ─────────────────────────── 响应侧 ───────────────────────────

/** 一个输出项的累积状态。 */
interface Item {
  kind: 'message' | 'reasoning' | 'function_call'
  id: string
  outputIndex: number
  text: string
  callId: string
  name: string
  args: string
}

function hexId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

/** 上游 `finish_reason` → Responses 的 `status`。 */
function statusOf(finishReason: string | null | undefined): 'completed' | 'incomplete' {
  return finishReason === 'length' ? 'incomplete' : 'completed'
}

/** 组装最终的 `output[]`（**必须按 outputIndex 排序**，见下）。 */
function outputOf(items: Item[]): unknown[] {
  // ⚠️ `output_index` 的语义就是「本项在 `output` 数组里的下标」。
  // 而项落进 `items` 的顺序取决于**收尾顺序**（有的上游先发工具块的结束、
  // 后发正文块的结束），与**开启顺序**不一致。
  // ⇒ 若不排序，客户端按 `output_index` 去 `output[]` 取会**取错项**。
  // 依据：参考实现 `responses.ts:878-885` 为此专门修过一次。
  const sorted = [...items].sort((a, b) => a.outputIndex - b.outputIndex)
  return sorted.map((it) => {
    if (it.kind === 'message') {
      return {
        id: it.id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: it.text, annotations: [] }],
      }
    }
    if (it.kind === 'reasoning') {
      return { id: it.id, type: 'reasoning', summary: [{ type: 'summary_text', text: it.text }] }
    }
    return {
      id: it.id,
      type: 'function_call',
      status: 'completed',
      call_id: it.callId,
      name: it.name,
      arguments: it.args,
    }
  })
}

/**
 * 从**非流式**的聚合结果构造 Responses JSON 对象。
 *
 * 字段逐项对齐参考实现 `responses.ts:843-872`（那是 OpenAI 官方形状）。
 */
export function toResponsesObject(
  request: ResponsesRequest,
  model: string,
  aggregated: AggregatedCompletion,
  responseId: string,
): Record<string, unknown> {
  const choice = aggregated.choices[0]
  const message: Record<string, unknown> = choice?.message ?? {}
  const items: Item[] = []
  let idx = 0

  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  if (reasoning !== '') {
    items.push({ kind: 'reasoning', id: hexId('rs'), outputIndex: idx++, text: reasoning, callId: '', name: '', args: '' })
  }
  const content = typeof message.content === 'string' ? message.content : ''
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  // ⚠️ 正文为空但**有**工具调用时，不发空的 message 项 ——
  // 那会让客户端多渲染一个空气泡。
  if (content !== '' || calls.length === 0) {
    items.push({ kind: 'message', id: hexId('msg'), outputIndex: idx++, text: content, callId: '', name: '', args: '' })
  }
  for (const call of calls) {
    const c = isObject(call) ? call : {}
    const fn = isObject(c.function) ? c.function : {}
    items.push({
      kind: 'function_call',
      id: hexId('fc'),
      outputIndex: idx++,
      text: '',
      callId: nonEmptyString(c.id) ?? '',
      name: nonEmptyString(fn.name) ?? '',
      args: typeof fn.arguments === 'string' ? fn.arguments : '',
    })
  }

  const status = statusOf(choice?.finish_reason)
  const effort = isObject(request.reasoning) ? request.reasoning.effort ?? null : null

  return {
    id: responseId,
    object: 'response',
    // ⚠️ 单位是**秒**（Chat 路径的 `created` 也是秒，保持一致）。
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model,
    output: outputOf(items),
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: { effort, summary: null },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: usageOf(aggregated.usage as Record<string, unknown> | undefined),
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  }
}

/**
 * Chat 的 `usage` → Responses 的 `usage`。
 *
 * ## 🔴 `input_tokens` 必须**含**缓存命中（官方口径，参考实现曾写反）
 *
 * 官方与 Codex 的判据：
 * ```
 * 未命中 = input_tokens - input_tokens_details.cached_tokens
 * ```
 * 若 `input_tokens` 只算未命中部分（互斥口径），Codex 会把缓存量当成
 * **负输入**而夹到 0 ⇒ 上下文占用被少算上百倍 ⇒ **自动压缩永不触发**。
 *
 * 依据：参考实现 `responses.ts:28-36` 明确记录了这次修正。
 */
export function usageOf(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0
  const details = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cached = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0
  const reasoning =
    isObject(raw.completion_tokens_details) && typeof raw.completion_tokens_details.reasoning_tokens === 'number'
      ? raw.completion_tokens_details.reasoning_tokens
      : 0
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : prompt + completion,
  }
}

// ─────────────────────────── 流式 ───────────────────────────

const encoder = new TextEncoder()

/**
 * 把上游的 Chat SSE 流**逐帧**转成 Responses SSE 事件流。
 *
 * ## ⚠️ 必须逐帧处理，不能先整包读出来
 *
 * 与 Chat 路径同一条铁律：整包缓冲会让长回答在 10ms CPU 预算下超限
 *（本项目为此踩过一次，见 `stream.ts` 的说明）。
 * 故这里用 `TransformStream` 逐 chunk 处理。
 *
 * ## 事件顺序（严格按官方协议）
 *
 * ```
 * response.created
 * response.in_progress
 * ├─ 每项：response.output_item.added → (part added) → deltas → (part done) → response.output_item.done
 * response.completed            ← 或 response.failed
 * ```
 *
 * ⚠️ 每个事件的 `data` 里都有 `sequence_number`，**从 0 递增**。
 * 客户端靠它判「有没有丢事件」。
 */
export function toResponsesSse(
  upstreamBody: ReadableStream<Uint8Array>,
  request: ResponsesRequest,
  model: string,
  responseId: string,
): ReadableStream<Uint8Array> {
  const translator = createFrameTranslator()
  let sequence = 0

  // ⚠️ 有状态：跨 chunk 保留未完成的帧与已开启的输出项。
  let buffer = ''
  const items: Item[] = []
  // 当前"打开中"的项 —— 正文与推理各一个（上游可能先出推理再出正文）。
  let msgItem: Item | undefined
  let reasonItem: Item | undefined
  // 工具调用按 `index` 累积（分片可能乱序/交错）。
  const calls = new Map<number, Item>()
  let usage: Record<string, unknown> | null = null
  let finishReason: string | null = null
  let sawAny = false

  const emit = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`

  const snapshot = (
    status: string,
    err: Record<string, unknown> | null = null,
  ): Record<string, unknown> => ({
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: err,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model,
    // ⚠️ `in_progress` 时 `output` 必须是**空数组**（协议要求），
    // 否则客户端会以为已经有内容了。
    output: status === 'in_progress' ? [] : outputOf(items),
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: {
      effort: isObject(request.reasoning) ? request.reasoning.effort ?? null : null,
      summary: null,
    },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: status === 'in_progress' ? null : usageOf(usage),
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  })

  /** 打开正文项（幂等：已开就返回空数组）。 */
  const openMessage = (): string[] => {
    if (msgItem !== undefined) return []
    const item: Item = {
      kind: 'message', id: hexId('msg'), outputIndex: items.length,
      text: '', callId: '', name: '', args: '',
    }
    msgItem = item
    items.push(item)
    return [
      emit('response.output_item.added', {
        output_index: item.outputIndex,
        item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }),
      emit('response.content_part.added', {
        item_id: item.id, output_index: item.outputIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ]
  }

  const openReasoning = (): string[] => {
    if (reasonItem !== undefined) return []
    const item: Item = {
      kind: 'reasoning', id: hexId('rs'), outputIndex: items.length,
      text: '', callId: '', name: '', args: '',
    }
    reasonItem = item
    items.push(item)
    return [
      emit('response.output_item.added', {
        output_index: item.outputIndex,
        item: { id: item.id, type: 'reasoning', summary: [] },
      }),
      emit('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: item.outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    ]
  }

  /** 关闭一个已开启的项（发它的 `done` 事件）。 */
  const closeMessage = (): string[] => {
    const it = msgItem
    if (it === undefined) return []
    msgItem = undefined
    return [
      emit('response.output_text.done', {
        item_id: it.id, output_index: it.outputIndex, content_index: 0, text: it.text, logprobs: [],
      }),
      emit('response.content_part.done', {
        item_id: it.id, output_index: it.outputIndex, content_index: 0,
        part: { type: 'output_text', text: it.text, annotations: [] },
      }),
      emit('response.output_item.done', {
        output_index: it.outputIndex,
        item: {
          id: it.id, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: it.text, annotations: [] }],
        },
      }),
    ]
  }

  const closeReasoning = (): string[] => {
    const it = reasonItem
    if (it === undefined) return []
    reasonItem = undefined
    return [
      emit('response.reasoning_summary_text.done', {
        item_id: it.id, output_index: it.outputIndex, summary_index: 0, text: it.text,
      }),
      emit('response.reasoning_summary_part.done', {
        item_id: it.id, output_index: it.outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: it.text },
      }),
      emit('response.output_item.done', {
        output_index: it.outputIndex,
        item: { id: it.id, type: 'reasoning', summary: [{ type: 'summary_text', text: it.text }] },
      }),
    ]
  }

  // ⚠️ 上游可能**先出正文、后出推理**（或交错）。收尾顺序必须与开启顺序无关 ——
  // 全部关完之后再按 `outputIndex` 组装 `output[]`（见 `outputOf`）。
  const closeCalls = (): string[] => {
    const out: string[] = []
    for (const [idx, it] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      calls.delete(idx)
      out.push(
        emit('response.function_call_arguments.done', {
          item_id: it.id, output_index: it.outputIndex, arguments: it.args,
        }),
        emit('response.output_item.done', {
          output_index: it.outputIndex,
          item: {
            id: it.id, type: 'function_call', status: 'completed',
            call_id: it.callId, name: it.name, arguments: it.args,
          },
        }),
      )
    }
    return out
  }

  /** 处理一个 Chat delta，产出要发的事件。 */
  const applyDelta = (delta: Record<string, unknown>): string[] => {
    const out: string[] = []
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    if (reasoning !== '') {
      out.push(...openReasoning())
      const it = reasonItem
      if (it !== undefined) {
        it.text += reasoning
        out.push(
          emit('response.reasoning_summary_text.delta', {
            item_id: it.id, output_index: it.outputIndex, summary_index: 0, delta: reasoning,
          }),
        )
      }
    }
    const content = typeof delta.content === 'string' ? delta.content : ''
    if (content !== '') {
      // ⚠️ 正文开始 ⇒ **先关掉推理项**：协议里 reasoning 是独立输出项，
      // 与 message 并列；让它们同时"开着"会让客户端把两者串在一起。
      if (reasonItem !== undefined) out.push(...closeReasoning())
      out.push(...openMessage())
      const it = msgItem
      if (it !== undefined) {
        it.text += content
        out.push(
          emit('response.output_text.delta', {
            item_id: it.id, output_index: it.outputIndex, content_index: 0, delta: content, logprobs: [],
          }),
        )
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isObject(raw)) continue
        const idx = typeof raw.index === 'number' ? raw.index : 0
        const fn = isObject(raw.function) ? raw.function : {}
        let it = calls.get(idx)
        if (it === undefined) {
          // ⚠️ 工具项开始前必须先关掉**正文与推理** —— 输出项不能重叠。
          if (msgItem !== undefined) out.push(...closeMessage())
          if (reasonItem !== undefined) out.push(...closeReasoning())
          it = {
            kind: 'function_call', id: hexId('fc'), outputIndex: items.length,
            text: '', callId: nonEmptyString(raw.id) ?? '', name: '', args: '',
          }
          calls.set(idx, it)
          items.push(it)
          out.push(emit('response.output_item.added', {
            output_index: it.outputIndex,
            item: {
              id: it.id, type: 'function_call', status: 'in_progress',
              call_id: it.callId, name: nonEmptyString(fn.name) ?? '', arguments: '',
            },
          }))
        }
        // ⚠️ 后续分片的 `name` 可能是**空串**（上游那个缺陷），
        // **只在非空时覆盖** —— 否则工具名会被空串冲掉。
        const name = nonEmptyString(fn.name)
        if (name !== undefined) it.name = name
        if (it.callId === '') it.callId = nonEmptyString(raw.id) ?? ''
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        if (args !== '') {
          it.args += args
          out.push(emit('response.function_call_arguments.delta', {
            item_id: it.id, output_index: it.outputIndex, delta: args,
          }))
        }
      }
    }
    return out
  }

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        // `response.created` 与 `response.in_progress` 立刻发 ——
        // 客户端靠 `created` 拿到 response id（后面所有事件都引用它）。
        controller.enqueue(encoder.encode(emit('response.created', { response: snapshot('in_progress') })))
        controller.enqueue(encoder.encode(emit('response.in_progress', { response: snapshot('in_progress') })))
      },
      transform(chunk, controller) {
        buffer += new TextDecoder().decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          const frame = parseSseLine(line)
          if (frame.kind === 'done') continue
          if (frame.kind !== 'chunk' || frame.data === undefined) continue

          let parsed: Record<string, unknown>
          try {
            const obj = JSON.parse(frame.data) as unknown
            if (!isObject(obj)) continue
            parsed = obj
          } catch {
            continue
          }
          const errMsg = detectErrorFrame(parsed)
          if (errMsg !== undefined) {
            controller.enqueue(encoder.encode(emit('response.failed', {
              response: snapshot('failed', { code: 'upstream_error', message: errMsg }),
            })))
            continue
          }
          if (isObject(parsed.usage)) usage = parsed.usage
          const choices = Array.isArray(parsed.choices) ? parsed.choices : []
          for (const c of choices) {
            if (!isObject(c)) continue
            const fr = c.finish_reason
            if (typeof fr === 'string' && fr !== '') finishReason = fr
            const delta = isObject(c.delta) ? c.delta : undefined
            if (delta === undefined) continue
            sawAny = true
            for (const ev of applyDelta(delta)) controller.enqueue(encoder.encode(ev))
          }
        }
      },
      flush(controller) {
        const out: string[] = []
        out.push(...closeReasoning())
        out.push(...closeMessage())
        out.push(...closeCalls())
        // ⚠️ 一项都没有（上游全程没发内容）⇒ 补一个空 message 项。
        // 不补的话 `output: []` 会让客户端以为「模型什么都没说」，
        // 而真实原因可能是上游异常 —— 那是**静默失败**（本项目明令禁止）。
        if (items.length === 0) {
          const item: Item = {
            kind: 'message', id: hexId('msg'), outputIndex: 0,
            text: sawAny ? '' : '（上游未返回任何内容）', callId: '', name: '', args: '',
          }
          items.push(item)
          out.push(...openMessage())
          out.push(...closeMessage())
        }
        const status = statusOf(finishReason)
        out.push(emit(`response.${status}`, { response: snapshot(status) }))
        for (const ev of out) controller.enqueue(encoder.encode(ev))
      },
    }),
  )
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 处理 `POST /v1/responses`。
 *
 * 复用 `handleChatCompletions`：把 Responses 请求体转成 Chat 请求体，
 * 用一个**新的 Request** 调它，再把返回的 SSE 转成 Responses 的形状。
 */
export async function handleResponses(
  request: Request,
  env: Env,
  realm = 'cn',
  ctx?: ExecutionContext,
): Promise<{ response: Response }> {
  let body: ResponsesRequest
  try {
    const parsed = (await request.json()) as unknown
    if (!isObject(parsed)) throw new ResponsesError('request body must be a JSON object')
    body = parsed as ResponsesRequest
  } catch (error) {
    if (error instanceof ResponsesError) {
      return { response: errorJson(error.message) }
    }
    return { response: errorJson('请求体必须是合法 JSON') }
  }

  const model = nonEmptyString(body.model)
  if (model === undefined) return { response: errorJson('model 必填') }

  let chatBody: Record<string, unknown>
  try {
    chatBody = toChatBody(body, model)
  } catch (error) {
    if (error instanceof ResponsesError) return { response: errorJson(error.message, error.status) }
    return { response: errorJson(error instanceof Error ? error.message : String(error)) }
  }

  // ⚠️ **强制流式**去问上游：本网关的上游只支持流式（Chat 路径也是这么做的）。
  // 客户端要不要流式由 `body.stream` 决定，与「我们怎么问上游」无关。
  chatBody.stream = true

  const wantsStream = body.stream === true
  const responseId = hexId('resp')

  // ⚠️ 复用 Chat 处理器 = 复用**全部**既有能力（选号/轮转/冷却/续期/渠道指纹）。
  // 见本文件头「实现策略」的说明。
  const chatRequest = new Request(new URL('/v1/chat/completions', request.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody),
  })
  const inner = await handleChatCompletions(chatRequest, env, realm, ctx)

  // 上游失败：把错误**原样**包成 Responses 的形状（不吞掉原因）。
  if (!inner.response.ok || inner.response.body === null) {
    const text = await inner.response.text().catch(() => '')
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string') message = parsed.error.message
    } catch {
      // 非 JSON：保留原文
    }
    return {
      response: errorJson(message || `上游返回 HTTP ${inner.response.status}`, inner.response.status),
    }
  }

  if (wantsStream) {
    return {
      response: new Response(toResponsesSse(inner.response.body, body, model, responseId), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      }),
    }
  }

  // 非流式：先把上游的 SSE **读成字符串**再聚合。
  //
  // ⚠️ `aggregateSse` 收的是**字符串**（不是流），与 Chat 路径同一口径 ——
  // 见 `server.ts:1230-1256` 的 `nonStreamingResponse`。
  // 非流式本来就要把整条回答收齐才能返回，故这里缓冲是**必需**的；
  // 流式那条路径才是必须逐帧的（见文件头说明）。
  const reader = inner.response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
  } finally {
    try { reader.releaseLock() } catch { /* 忽略 */ }
  }

  const aggregated = aggregateSse(raw, { model, now: Date.now() })
  return {
    response: Response.json(toResponsesObject(body, model, aggregated, responseId), {
      headers: { 'cache-control': 'no-store' },
    }),
  }
}

/** 错误响应（Responses 风格的 error 对象）。 */
function errorJson(message: string, status = 400): Response {
  return Response.json({ error: { message, type: 'invalid_request_error' } }, { status })
}
