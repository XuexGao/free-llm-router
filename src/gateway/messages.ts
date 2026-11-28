/**
 * **Anthropic Messages API** 原生入站适配。
 *
 * 暴露两个端点：
 * - `POST /v1/messages`（及别名 `/messages`）
 * - `POST /v1/messages/count_tokens`（及别名 `/messages/count_tokens`）
 *
 * ## 为什么需要它（而不是「让客户端改用 OpenAI 协议」）
 *
 * Claude Code、Anthropic 官方 SDK 只说 Messages 协议：它们发 `system` /
 * `messages[].content` 块数组 / `tool_use` / `tool_result`，并且**只解析**
 * `message_start` / `content_block_delta` 这类 SSE 事件。
 * 让用户「自己转协议」不现实 ⇒ 服务端必须自己认这套。
 *
 * ## 实现策略：与 `responses.ts` **完全同构**，只做协议外壳转换
 *
 * ```
 * Messages 请求 ──messagesToChatBody()──▶ Chat 请求体
 *                                             │
 *                                handleChatCompletions()  ← 选号/轮转/冷却/续期/子密钥记账全复用
 *                                             │
 *              ┌──────────────────────────────┴──────────────────────────────┐
 *              ▼                                                             ▼
 *   非流式：aggregateSse() → toAnthropicMessage()          流式：toAnthropicSse()
 * ```
 *
 * ⚠️ **为什么不重写一条独立路由**：那会让「Chat 路径修好的任何缺陷本端点**自动受益**」
 * 这条性质失效 —— 本项目反复踩过「同一个 bug 只修一半」（最典型的是 SSE
 * `data:` 前缀那两次）。代价是多一层转换，非常值得。
 *
 * ## 🔴 本文件最容易写错的一处：`usage` 口径与 **Responses 相反**
 *
 * | 协议 | `input_tokens` 含不含缓存命中 | 客户端怎么算上下文 |
 * |---|---|---|
 * | OpenAI Responses | **含**（命中单列在 `input_tokens_details.cached_tokens`） | `input - cached` |
 * | **Anthropic** | **不含**（命中单列在 `cache_read_input_tokens`） | `input + cache_read` |
 *
 * 上游给我们的是 **OpenAI 口径**（`prompt_tokens` 含命中）。
 * 若这里**原样透传**，Claude Code 会算 `input + cache_read` ⇒ **虚高近一倍**
 * ⇒ 过早触发自动压缩 ⇒ 用户看到「才聊了几句就压缩了」。
 * 若反过来在 Responses 那边扣减，Codex 会得负数夹到 0 ⇒ **永远不压缩**。
 *
 * ⇒ 两条腿**必须各自做对**，不能互相抄。本文件负责**扣减**（见 {@link toAnthropicUsage}）。
 *
 * ## 其余三条不能凭直觉改的协议点
 *
 * 1. **`system` 是顶层字段，不是 `messages[0]`**（Anthropic 规范），
 *    且**可以是块数组**。转成 Chat 时要拼成一条 `role: 'system'`。
 * 2. **`tool_result` 是 user 消息里的块**，而 Chat 要求它是独立的
 *    `role: 'tool'` 消息 ⇒ 必须拆开重排（见 {@link messagesToChatBody}）。
 * 3. **`tool_use.input` 必须是对象**（字典），而 Chat 的
 *    `tool_calls[].function.arguments` 是 **JSON 字符串** ⇒ 两个方向都要转，
 *    且 parse 失败时**不能抛**（那会让整轮对话失败）。
 */

import { aggregateSse, findUpstreamError, isContentless, sseHeaders, type AggregatedCompletion } from './stream.js'
import { handleChatCompletions } from './server.js'
import { jsonError, readJsonCapped } from './http.js'
import { resolveMaxRequestBytes, type Env } from '../env.js'
import type { SubkeyContext } from './authz.js'

// ─────────────────────────── 类型 ───────────────────────────

/** Anthropic `/v1/messages` 请求体（只声明我们会读取的字段）。 */
export interface MessagesRequest {
  model?: unknown
  messages?: unknown
  system?: unknown
  max_tokens?: unknown
  stop_sequences?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  top_k?: unknown
  tools?: unknown
  tool_choice?: unknown
  thinking?: unknown
  metadata?: unknown
}

/** 请求转换错误（入口据此回 Anthropic 形状的错误体）。 */
export class MessagesError extends Error {
  readonly status: number
  readonly errorType: string
  constructor(message: string, status = 400, errorType = 'invalid_request_error') {
    super(message)
    this.name = 'MessagesError'
    this.status = status
    this.errorType = errorType
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

// ─────────────────────────── 入站：Messages → Chat ───────────────────────────

/**
 * `system`（字符串或块数组）→ 纯文本。
 *
 * ⚠️ Anthropic 允许 `system` 是**块数组**（`[{type:'text',text:…}]`），
 * 而 Chat 只接受字符串。直接 `String(system)` 会得到 `[object Object]`
 * —— 那是一条**看起来正常但内容全错**的 system 提示，比报错更难发现。
 */
export function systemTextOf(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  let out = ''
  for (const raw of system) {
    if (!isObject(raw)) continue
    // `type` 一般是 `text`；其余块类型（如未来的 cache_control 专用块）跳过
    if (typeof raw.text === 'string') out += raw.text
  }
  return out
}

/**
 * Anthropic content 块数组 → Chat 的 content。
 *
 * ## 两种输出形态（**按有没有图片决定**，不能一律用数组）
 *
 * - **纯文本** ⇒ 返回**字符串**。这是 Chat 最兼容的形态；
 *   发块数组虽然也合法，但部分上游对数组形态的文本处理有差异。
 * - **含图片** ⇒ 返回块数组（`{type:'text'}` / `{type:'image_url'}`）。
 *
 * ⚠️ 图片只接受 **base64 内联**（`source.type === 'base64'`）。
 * `source.type === 'url'` **绝不**由我们去下载 —— 那是 SSRF（能打环回与云元数据
 * 端点，见 AGENTS.md §7.1.3）。故这种块**跳过并计数**，由调用方如实告知用户。
 */
export function contentToChat(
  content: unknown,
): { content: unknown; skippedImages: number } {
  if (typeof content === 'string') return { content, skippedImages: 0 }
  if (!Array.isArray(content)) return { content: '', skippedImages: 0 }

  let text = ''
  const parts: unknown[] = []
  let hasImage = false
  let skippedImages = 0

  for (const raw of content) {
    if (!isObject(raw)) continue
    const type = raw.type

    if (type === 'text') {
      const t = typeof raw.text === 'string' ? raw.text : ''
      text += t
      parts.push({ type: 'text', text: t })
      continue
    }

    if (type === 'image') {
      const source = isObject(raw.source) ? raw.source : undefined
      const mediaType = source === undefined ? undefined : nonEmptyString(source.media_type)
      const data = source === undefined ? undefined : nonEmptyString(source.data)
      if (source !== undefined && source.type === 'base64' && data !== undefined) {
        hasImage = true
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType ?? 'image/png'};base64,${data}` },
        })
      } else {
        // `source.type === 'url'` 或形状不认识 ⇒ **不下载、不转发**，如实计数
        skippedImages += 1
      }
      continue
    }

    // 其余块（`document` / `search_result` 等）跳过：上游不支持，
    // 发过去只会 400 并让**整轮对话**失败。丢一块比丢整轮好。
  }

  if (!hasImage) return { content: text, skippedImages }
  // 有图时才用块数组；纯文本块 + 图片混排
  return { content: parts, skippedImages }
}

/** Anthropic `tools` → Chat `tools`（外层都带 `type:'function'`，但内层键名不同）。 */
export function toolsToChat(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new MessagesError('tools must be an array')
  const out: unknown[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    // Anthropic 的服务端工具（`web_search_20250305` 等）用 `type` 区分；
    // 我们只认**自定义工具**（有 `name` + `input_schema`）
    const name = nonEmptyString(item.name)
    if (name === undefined) continue
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof item.description === 'string' ? item.description : '',
        parameters: isObject(item.input_schema)
          ? item.input_schema
          : { type: 'object', properties: {} },
      },
    })
  }
  return out.length > 0 ? out : undefined
}

/** Anthropic `tool_choice` → Chat `tool_choice`。 */
export function toolChoiceToChat(raw: unknown): unknown {
  if (!isObject(raw)) return undefined
  const type = raw.type
  if (type === 'auto') return 'auto'
  if (type === 'any') return 'required'
  if (type === 'none') return 'none'
  if (type === 'tool') {
    const name = nonEmptyString(raw.name)
    if (name !== undefined) return { type: 'function', function: { name } }
  }
  return undefined
}

/**
 * 把 Anthropic 的 `messages` 转成 Chat 的 `messages`。
 *
 * ## 三个必须处理的形态差异
 *
 * 1. **`tool_use` 是 assistant 内容块** ⇒ 要提升成 Chat 的
 *    `assistant.tool_calls[]`（`arguments` 是 **JSON 字符串**）。
 * 2. **`tool_result` 是 user 内容块** ⇒ 要拆成**独立的** `role:'tool'` 消息
 *    （Chat 的强制形状），并带上 `tool_call_id`。
 * 3. 一条 user 消息里**既有 `tool_result` 又有文本**时，拆开后**顺序很重要**：
 *    先 `tool`（回应上一轮的调用），再 `user`（本轮新输入）。顺序反了会让
 *    上游认为「工具结果没有对应的调用」而报配对错误。
 */
export function messagesToChat(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) throw new MessagesError('messages 必须是数组')
  const out: unknown[] = []

  for (const item of raw) {
    if (!isObject(item)) continue
    const role = nonEmptyString(item.role)
    const content = item.content

    // ── assistant：可能有 tool_use 块 ──
    if (role === 'assistant') {
      const { content: chatContent, skippedImages } = contentToChat(content)
      void skippedImages
      const toolCalls: unknown[] = []
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block) || block.type !== 'tool_use') continue
          const id = nonEmptyString(block.id)
          const name = nonEmptyString(block.name)
          if (id === undefined || name === undefined) continue
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              // ⚠️ Chat 要 JSON **字符串**；Anthropic 给的是对象。
              // 形状不认识时退化成 `{}`（而不是抛错 —— 一次工具参数畸形
              // 不该让整轮对话失败）。
              arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
            },
          })
        }
      }
      const message: Record<string, unknown> = { role: 'assistant', content: chatContent }
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      out.push(message)
      continue
    }

    // ── user：可能含多个 tool_result ⇒ 拆成独立的 tool 消息 ──
    if (role === 'user') {
      const toolResults: Array<Record<string, unknown>> = []
      // 非 tool_result 的部分（文本 + 图片）
      const restBlocks: unknown[] = []

      if (Array.isArray(content)) {
        for (const block of content) {
          if (isObject(block) && block.type === 'tool_result') {
            const callId = nonEmptyString(block.tool_use_id)
            if (callId === undefined) continue
            // `content` 可能是字符串或块数组；Chat 的 `tool` 消息只接受字符串
            const text = typeof block.content === 'string'
              ? block.content
              : contentToChat(block.content).content instanceof Array
                ? (contentToChat(block.content).content as unknown[])
                    .map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : ''))
                    .join('')
                : String(contentToChat(block.content).content ?? '')
            toolResults.push({
              role: 'tool',
              tool_call_id: callId,
              content: text,
            })
            continue
          }
          restBlocks.push(block)
        }
      } else if (typeof content === 'string') {
        restBlocks.push({ type: 'text', text: content })
      }

      // ⚠️ 顺序：先 tool（回应上一轮），再 user（本轮新输入）
      for (const tr of toolResults) out.push(tr)

      // 剩余部分若为空则**不产生** user 消息（纯工具结果轮次）
      const hasRest = restBlocks.length > 0
      if (hasRest) {
        const { content: chatContent } = contentToChat(restBlocks)
        // 纯文本块已被压成字符串；空串则不产生空消息
        if (!(typeof chatContent === 'string' && chatContent === '')) {
          out.push({ role: 'user', content: chatContent })
        }
      }
      continue
    }

    // 其余 role（如 `system` 出现在 messages 里）——Anthropic 不允许，
    // 但宽容处理成 user（而不是丢消息让上下文莫名少一段）
    if (content !== undefined) {
      out.push({ role: 'user', content: contentToChat(content).content })
    }
  }

  return out
}

/**
 * 一个 Messages 请求 → Chat 请求体。
 *
 * @param model 已解析出的模型名（**含 `provider/` 前缀**，由外层决定保留或剥离）
 */
export function messagesToChatBody(body: MessagesRequest, model: string): Record<string, unknown> {
  const messages = messagesToChat(body.messages)
  if (messages.length === 0) throw new MessagesError('messages 不能为空')

  const system = systemTextOf(body.system)
  if (system !== '') {
    // ⚠️ 系统提示必须**排在最前**（Chat 的语义要求）
    messages.unshift({ role: 'system', content: system })
  }

  // ⚠️ **`max_tokens` 必须校验为必填**（黑盒排查实测，2026-11-27）
  //
  // Anthropic 规范里 `max_tokens` 是**必填**。此前缺省时被**静默省略** ——
  // 于是上游按自己的默认上限生成，客户端拿到的可能是超长回答，
  // 而客户端以为「没限制」。更糟的是：这是一个**规范违例**，
  // 任何合规的客户端都不会这么发，说明我们漏了校验。
  //
  // ⚠️ 但**必须区分**「缺省」与「传了非法值」：两者都该 400，
  //    且文案要说清楚该传什么。
  const maxTokens = positiveInt(body.max_tokens)
  if (maxTokens === undefined) {
    throw new MessagesError('max_tokens 必填（必须是正整数，例如 1024）')
  }

  const chat: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
  }

  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    chat.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    chat.top_p = body.top_p
  }
  // ⚠️ `top_k` 在 Chat 里**不存在**（OpenAI 无该参数）。**静默丢弃**而不报错：
  // 报错会让 Claude Code 每次请求都失败（它默认就带 top_k）。
  // 代价是采样略有差异，但那不影响可用性。
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    chat.stop = body.stop_sequences.filter((s): s is string => typeof s === 'string')
  }

  const tools = toolsToChat(body.tools)
  if (tools !== undefined) chat.tools = tools
  const toolChoice = toolChoiceToChat(body.tool_choice)
  if (toolChoice !== undefined) chat.tool_choice = toolChoice

  return chat
}

// ─────────────────────────── 出站：Chat → Messages ───────────────────────────

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'refusal'

/** 上游 `finish_reason` → Anthropic `stop_reason`。 */
export function toAnthropicStopReason(
  finishReason: string | null | undefined,
  hasToolCalls = false,
): AnthropicStopReason {
  const fr = typeof finishReason === 'string' ? finishReason.trim().toLowerCase() : ''
  if (fr === 'length' || fr === 'max_tokens') return 'max_tokens'
  if (fr === 'tool_calls' || fr === 'function_call' || hasToolCalls) return 'tool_use'
  if (fr === 'stop_sequence') return 'stop_sequence'
  if (fr === 'content_filter') return 'refusal'
  return 'end_turn'
}

/**
 * 上游 Chat `usage` → Anthropic `usage`。
 *
 * ## 🔴 这里必须**扣减**缓存命中（与 `responses.ts` 相反）
 *
 * 上游给的是 OpenAI 口径：`prompt_tokens` **含**缓存命中，
 * 命中量在 `prompt_tokens_details.cached_tokens`。
 *
 * Anthropic 口径要求 `input_tokens` **不含**缓存命中，命中单列在
 * `cache_read_input_tokens`。Claude Code 用
 * `input_tokens + cache_read_input_tokens` 算总上下文 ——
 *
 * - **不扣减** ⇒ 总数 = 含命中 + 命中 = **虚高近一倍** ⇒ 过早触发自动压缩；
 * - 扣减后 ⇒ 总数与上游真实 prompt 一致。
 *
 * ⚠️ `Math.max(0, …)` 是**防御**，不是正常路径：上游理论上
 * `cached <= prompt`，但若它下发不一致（本项目见过上游字段自相矛盾），
 * 负数会让 Claude Code 的占用条算出负值。
 */
export function toAnthropicUsage(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) return { input_tokens: 0, output_tokens: 0 }

  const prompt = typeof raw.prompt_tokens === 'number' && Number.isFinite(raw.prompt_tokens)
    ? raw.prompt_tokens
    : 0
  const completion = typeof raw.completion_tokens === 'number' && Number.isFinite(raw.completion_tokens)
    ? raw.completion_tokens
    : 0

  const details = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const cachedRaw = details !== undefined && typeof details.cached_tokens === 'number'
    ? details.cached_tokens
    : 0
  const cacheRead = Number.isFinite(cachedRaw) && cachedRaw > 0 ? cachedRaw : 0

  const usage: Record<string, unknown> = {
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: Math.max(0, completion),
  }
  // ⚠️ 只在真的有时才发该字段：发 `0` 会让部分客户端显示「缓存 0 tokens」的噪声
  if (cacheRead > 0) usage.cache_read_input_tokens = cacheRead
  return usage
}

/** 工具参数字符串 → `tool_use.input` 对象（协议要求必须是字典）。 */
export function parseToolUseInput(rawArgs: unknown): Record<string, unknown> {
  if (isObject(rawArgs)) return rawArgs
  if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return {}
  try {
    const parsed = JSON.parse(rawArgs) as unknown
    if (isObject(parsed)) return parsed
    if (parsed === null || parsed === undefined) return {}
    // 非对象的合法 JSON（数字/数组）⇒ 包一层，保住原值
    return { value: parsed }
  } catch {
    // ⚠️ **解析失败不抛错**：一次工具参数畸形不该让整轮对话失败。
    // 保留原文进 `raw`，让用户/上游都能看出原始内容。
    return { raw: rawArgs }
  }
}

/** 生成一个 Anthropic 形状的 message id（`msg_` 前缀）。 */
function messageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `msg_${hex}`
}

/** 把聚合后的 Chat completion 转成 Anthropic message 对象（**非流式**）。 */
export function toAnthropicMessage(
  model: string,
  completion: AggregatedCompletion,
  id = messageId(),
): Record<string, unknown> {
  const choice = (Array.isArray(completion.choices) ? completion.choices[0] : undefined) as
    | Record<string, unknown>
    | undefined
  const message = isObject(choice?.message) ? choice.message : {}
  const text = typeof message.content === 'string' ? message.content : ''
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  const content: unknown[] = []
  // ⚠️ 空文本块**不发**：Anthropic 客户端对「只有一个空 text 块」会显示空白回复，
  // 而真实原因是上游没产出内容（那该在别处报错，不该伪装成一个空块）。
  if (text !== '') content.push({ type: 'text', text })

  for (const raw of rawToolCalls) {
    if (!isObject(raw)) continue
    const fn = isObject(raw.function) ? raw.function : undefined
    const name = nonEmptyString(fn?.name)
    if (name === undefined) continue
    content.push({
      // ⚠️ `id` 必须沿用上游给的那个：它是下一轮 `tool_result.tool_use_id`
      // 的对应键，自造会让配对断裂。
      id: nonEmptyString(raw.id) ?? `toolu_${content.length}`,
      type: 'tool_use',
      name,
      input: parseToolUseInput(fn?.arguments),
    })
  }

  const hasToolUse = content.some((c) => isObject(c) && c.type === 'tool_use')
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toAnthropicStopReason(
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      hasToolUse,
    ),
    stop_sequence: null,
    usage: toAnthropicUsage(completion.usage),
  }
}

/**
 * 上游 SSE → Anthropic SSE 事件流（**逐帧**，禁整包缓冲）。
 *
 * ## 事件序列（Anthropic 官方规范，顺序不能错）
 *
 * ```
 * message_start          {message:{id,type,role,model,content:[],usage:{input_tokens,...}}}
 * content_block_start    {index, content_block:{type:'text',text:''}}
 * content_block_delta    {index, delta:{type:'text_delta',text:'…'}}
 * content_block_stop     {index}
 * [tool_use 时：content_block_start{type:'tool_use'} + input_json_delta…]
 * message_delta          {delta:{stop_reason,stop_sequence}, usage:{output_tokens}}
 * message_stop
 * ```
 *
 * ⚠️ **必须从 `message_start` 开始**：Claude Code 靠它建立消息上下文，
 * 缺了它后续所有事件都会被丢弃（表现为「界面一片空白但连接是 200」）。
 *
 * ⚠️ **文本块与工具块要各占一个 index**：同一条 assistant 消息里
 * 「先说一句话，再调用工具」是两个块 —— 共用一个 index 会让客户端
 * 把工具参数拼进文本里。
 */
export function toAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  id = messageId(),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''

  let started = false
  /**
   * **块序号单调分配器**。
   *
   * ## 🔴 为什么必须单调（真实缺陷，2026-11-27）
   *
   * 原实现用 `toolIndex = Math.max(textIndex, 0) + 1` 从文本块下标**反推**
   * 工具块下标，于是出现两类撞车：
   *
   * 1. **两个并行工具调用都拿 index 1**（`textIndex` 在两个工具之间没变）；
   * 2. **工具后再出正文**时 `textIndex += 1` 得到 1，又撞上工具块。
   *
   * ⚠️ 后果很严重：Claude Code 按 `index` 维护块数组，同 index 会覆盖 ——
   * 表现为工具参数错乱或工具名丢失。而工具调用是 agent 场景的**主路径**。
   *
   * ⇒ 改成单一递增分配器：谁开新块谁取下一个号，永不重号。
   */
  let nextBlockIndex = 0
  // 当前打开的块（`index` / 类型 / 已发过多少文本）
  let textIndex = -1
  let textOpen = false
  let toolIndex = -1
  let toolOpen = false
  let toolCallIndex = -1
  let finalUsage: Record<string, unknown> = { input_tokens: 0, output_tokens: 0 }
  let finishReason: string | undefined
  let sawToolUse = false

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  }

  const ensureStart = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (started) return
    started = true
    emit(controller, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // ⚠️ `input_tokens` 在流式里**先给 0**，真实值在 message_delta 里补
        // —— 这与 Anthropic 官方行为一致（它们在末尾才结算 input）。
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const closeText = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!textOpen) return
    textOpen = false
    emit(controller, 'content_block_stop', { type: 'content_block_stop', index: textIndex })
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.getReader()

      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            // 收尾：关块 → message_delta → message_stop
            ensureStart(controller)
            closeText(controller)
            if (toolOpen) {
              toolOpen = false
              emit(controller, 'content_block_stop', { type: 'content_block_stop', index: toolIndex })
            }
            emit(controller, 'message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: toAnthropicStopReason(finishReason, sawToolUse),
                stop_sequence: null,
              },
              usage: finalUsage,
            })
            emit(controller, 'message_stop', { type: 'message_stop' })
            controller.close()
            return
          }

          buffer += decoder.decode(value, { stream: true })
          // ⚠️ 按 `\n\n` 切帧（SSE 规范），**保留**最后一段不完整的在 buffer 里
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            // ⚠️ 复用项目唯一的 SSE 行解析口径：`data:` 可能**没有空格**
            //（实测上游确实这么发，见 AGENTS.md ②e）。不宽容就会漏掉每一帧。
            for (const line of frame.split('\n')) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (payload === '' || payload === '[DONE]') continue

              let chunk: Record<string, unknown>
              try {
                const parsed = JSON.parse(payload) as unknown
                if (!isObject(parsed)) continue
                chunk = parsed
              } catch {
                continue
              }

              ensureStart(controller)

              // 上游错误帧：转成 Anthropic 的 error 事件（**不静默**）
              if (chunk.error !== undefined) {
                const err = isObject(chunk.error) ? chunk.error : {}
                emit(controller, 'error', {
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message:
                      nonEmptyString(err.message) ?? '上游返回了错误，且未给出可读原因',
                  },
                })
                controller.close()
                return
              }

              const choices = Array.isArray(chunk.choices) ? chunk.choices : []
              const choice = choices.length > 0 && isObject(choices[0]) ? choices[0] : undefined
              const delta = isObject(choice?.delta) ? choice.delta : undefined

              // 文本增量
              const piece = delta !== undefined && typeof delta.content === 'string' ? delta.content : ''
              if (piece !== '') {
                if (!textOpen) {
                  closeText(controller)
                  textIndex = nextBlockIndex
                  nextBlockIndex += 1
                  textOpen = true
                  emit(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: textIndex,
                    content_block: { type: 'text', text: '' },
                  })
                }
                emit(controller, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: textIndex,
                  delta: { type: 'text_delta', text: piece },
                })
              }

              // 工具调用增量
              const toolDeltas = delta !== undefined && Array.isArray(delta.tool_calls) ? delta.tool_calls : []
              for (const td of toolDeltas) {
                if (!isObject(td)) continue
                const fn = isObject(td.function) ? td.function : undefined
                const name = nonEmptyString(fn?.name)
                const argsPiece = typeof fn?.arguments === 'string' ? fn.arguments : ''

                // 新的工具调用（有 name 或 index 变化）⇒ 开一个新块
                if (name !== undefined) {
                  if (toolOpen) {
                    toolOpen = false
                    emit(controller, 'content_block_stop', { type: 'content_block_stop', index: toolIndex })
                  }
                  closeText(controller)
                  // ⚠️ 取**下一个**序号，不从 textIndex 反推（见 nextBlockIndex 说明）
                  toolIndex = nextBlockIndex
                  nextBlockIndex += 1
                  toolOpen = true
                  sawToolUse = true
                  toolCallIndex += 1
                  emit(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: toolIndex,
                    content_block: {
                      type: 'tool_use',
                      id: nonEmptyString(td.id) ?? `toolu_${toolCallIndex}`,
                      name,
                      input: {},
                    },
                  })
                }

                if (argsPiece !== '' && toolOpen) {
                  emit(controller, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: toolIndex,
                    // ⚠️ Anthropic 用 `input_json_delta` 传**参数片段**
                    //（正是累计的 JSON 字符串的一部分），不是完整对象。
                    delta: { type: 'input_json_delta', partial_json: argsPiece },
                  })
                }
              }

              // usage 与 finish_reason
              if (isObject(chunk.usage)) finalUsage = toAnthropicUsage(chunk.usage)
              if (choice !== undefined && typeof choice.finish_reason === 'string') {
                finishReason = choice.finish_reason
              }
            }
          }

          pump()
        }).catch(() => {
          // ⚠️ 读流出错：如实发一个 error 事件（不静默 close —— 那会让客户端
          // 以为「正常结束但没内容」，与本项目反复记录的「空回复」同型）。
          try {
            ensureStart(controller)
            emit(controller, 'error', {
              type: 'error',
              error: { type: 'api_error', message: '读取上游流失败（连接中断）' },
            })
            controller.close()
          } catch {
            // controller 可能已关闭 —— 忽略
          }
        })
      }

      pump()
    },
  })
}

// ─────────────────────────── 入口 ───────────────────────────

/** Anthropic 形状的错误响应。 */
export function anthropicErrorJson(
  message: string,
  status = 400,
  errorType = 'invalid_request_error',
): Response {
  return Response.json(
    { type: 'error', error: { type: errorType, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * 处理 `POST /v1/messages`。
 *
 * 与 `handleResponses` **完全同构**（见文件头的策略说明）。
 */
export async function handleMessages(
  request: Request,
  env: Env,
  realm = 'cn',
  ctx?: ExecutionContext,
  subkey?: SubkeyContext,
): Promise<{ response: Response }> {
  const parsed = await readJsonCapped(request, resolveMaxRequestBytes(env))
  if (!parsed.ok) {
    // ⚠️ 体过大/JSON 非法要翻成 **Anthropic 形状**（客户端只认这个）
    const text = await parsed.response.text().catch(() => '')
    let message = '请求体不合法'
    try {
      const obj = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof obj.error?.message === 'string') message = obj.error.message
    } catch {
      // 保留默认文案
    }
    return {
      response: anthropicErrorJson(message, parsed.response.status, 'invalid_request_error'),
    }
  }
  const body = parsed.value
  if (!isObject(body)) {
    return { response: anthropicErrorJson('request body must be a JSON object') }
  }
  const req = body as MessagesRequest

  const model = nonEmptyString(req.model)
  if (model === undefined) return { response: anthropicErrorJson('model 必填') }

  let chatBody: Record<string, unknown>
  try {
    chatBody = messagesToChatBody(req, model)
  } catch (error) {
    if (error instanceof MessagesError) {
      return { response: anthropicErrorJson(error.message, error.status, error.errorType) }
    }
    return {
      response: anthropicErrorJson(error instanceof Error ? error.message : String(error)),
    }
  }

  // ⚠️ 强制流式问上游（本网关的上游只支持流式；Chat 路径同理）。
  chatBody.stream = true

  const wantsStream = req.stream === true
  const id = messageId()

  const chatRequest = new Request(new URL('/v1/chat/completions', request.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody),
  })
  const inner = await handleChatCompletions(chatRequest, env, realm, ctx, subkey)

  if (!inner.response.ok || inner.response.body === null) {
    const text = await inner.response.text().catch(() => '')
    let message = text
    try {
      const obj = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof obj.error?.message === 'string') message = obj.error.message
    } catch {
      // 非 JSON：保留原文
    }
    return {
      response: anthropicErrorJson(
        message || `上游返回 HTTP ${inner.response.status}`,
        inner.response.status,
        'api_error',
      ),
    }
  }

  if (wantsStream) {
    return {
      response: new Response(toAnthropicSse(inner.response.body, model, id), {
        status: 200,
        headers: sseHeaders(),
      }),
    }
  }

  // 非流式：必须收齐才能返回（缓冲是**必需**的，见 `responses.ts` 同处说明）
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

  // ## 🔴 上游错误必须显式报出，不能回一个「合法但空白」的 200（真实缺陷）
  //
  // 此前这里直接 `toAnthropicMessage(...)` 返回 —— 缺少 chat 路径那套兜底。
  // 上游回 `200 + 流内错误帧` 时，客户端拿到的是
  //   `200 content: []`、`stop_reason:"end_turn"`
  // ⇒ Claude Code 会把它当成「模型什么也没说」，而**完全看不到真实原因**。
  //
  // 判据复用 `findUpstreamError` / `isContentless`（与 chat 路径同一份实现）。
  const upstreamError = findUpstreamError(raw)
  if (upstreamError !== undefined) {
    return { response: anthropicErrorJson(`上游错误：${upstreamError}`, 502, 'api_error') }
  }
  if (isContentless(aggregated.choices[0])) {
    return {
      response: anthropicErrorJson(
        `上游返回了空响应（既没有正文/思考内容，也没有可识别的错误帧）。`
        + `上游原文片段：${raw.trim().slice(0, 300) || '(空)'}`,
        502,
        'api_error',
      ),
    }
  }
  return {
    response: Response.json(toAnthropicMessage(model, aggregated, id), {
      headers: { 'cache-control': 'no-store' },
    }),
  }
}

/**
 * 处理 `POST /v1/messages/count_tokens`。
 *
 * ## ⚠️ 这是一个**估算**，不是精确计数
 *
 * Anthropic 官方用自家 tokenizer。我们拿不到，也不该假装有。
 * 故这里给一个**保守估值**并**在响应里如实标注**：
 *
 * - 英文约 4 字符 / token，中文约 1 字 / token（我们用字节数与字符数加权）；
 * - **宁高不低**：低估会让 Claude Code 以为还有余量，发出超限请求；
 *   高估只是让它更早压缩，代价小得多。
 *
 * ⚠️ Claude Code 主要用它做**提示**，不会因为数值不准而失败。
 */
export async function handleCountTokens(request: Request): Promise<{ response: Response }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { response: anthropicErrorJson('请求体必须是合法 JSON') }
  }
  if (!isObject(body)) return { response: anthropicErrorJson('request body must be a JSON object') }

  // 把整个请求体序列化后按字符/字节混合估：这样 system / messages / tools
  // 全都被计入（不需要逐字段遍历，也就不会漏字段）。
  const text = JSON.stringify(body)
  const chars = text.length
  // UTF-16 码元数 vs 字节数：纯 ASCII 时两者相等，中文时字节约是码元的 3 倍。
  const bytes = new TextEncoder().encode(text).length
  // 经验权重：ASCII 每 token ≈ 3.5 字符；非 ASCII 每 token ≈ 1 字符。
  // 用 `bytes` 与 `chars` 的差值反推「多字节字符数」。
  const nonAscii = Math.max(0, Math.floor((bytes - chars) / 2))
  const ascii = Math.max(0, chars - nonAscii)
  const estimate = Math.ceil(ascii / 3.5) + nonAscii

  return {
    response: Response.json(
      { input_tokens: estimate },
      { headers: { 'cache-control': 'no-store' } },
    ),
  }
}
