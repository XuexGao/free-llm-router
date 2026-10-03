/**
 * Anthropic Messages 协议的**共享**转换层（Workers / 纯 Web 标准）。
 *
 * ## 为什么这是一个独立文件
 *
 * 本项目已有**三家**供应商说 Anthropic Messages：
 * `zcode`（`zcode-plan/anthropic/v1/messages`）、`qoder` 的 Anthropic BYOK 分支，
 * 以及另一个 agent 正在写的 `minimax`。若各写一份，四类缺陷会被复制多份：
 * `tool_use.input` 是**对象**而不是 JSON 字符串、工具结果必须包成
 * `role:'user'` 里的 `tool_result`、SSE 没有 `data: [DONE]`、
 * 思考走 `thinking_delta`。故这里只保留**协议形状本身**，
 * 不放任何供应商私有逻辑。
 *
 * ## 与参考项目的关键差异（`deepseek-harness-codearts/src/zcode-anthropic.ts`）
 *
 * 参考实现产出的是 DSH 的 `StreamChunk`（异步生成器 + `LlmError`）。
 * 本项目要的是**回到 OpenAI 线的 SSE 字节流**（`gateway/stream.ts` 已按
 * OpenAI 形状解析 usage / 错误帧），且**绝不能整包缓冲**——
 * Workers Free 只有 10ms CPU/次调用（`AGENTS.md §8.2.2`）。
 * 故这里全部是 `TransformStream` 形态的**逐帧**转换 + 纯函数。
 *
 * ## 实测/规范上的坑（都来自协议本身，不是推测）
 *
 * | 维度 | OpenAI | Anthropic |
 * |---|---|---|
 * | system | `messages[0].role='system'` | **顶层 `system` 字段**（块数组） |
 * | 工具声明 | `tools[].function.{name,description,parameters}` | **`tools[].{name,description,input_schema}`**（扁平） |
 * | 工具调用 | `tool_calls:[{id,function:{name,arguments}}]`（**字符串** JSON） | `content:[{type:'tool_use',id,name,input}]`（**对象**） |
 * | 工具结果 | `{role:'tool',tool_call_id,content}` | `{role:'user',content:[{type:'tool_result',tool_use_id,content}]}` |
 * | SSE 结束 | `data: [DONE]` | `message_stop` 事件（**无 `[DONE]`**） |
 * | 思考 | `delta.reasoning_content` | `content_block_delta` 的 `thinking_delta` |
 * | 流内错误 | `{error:{message}}` 帧 | `event: error` + `{type:'error',error:{...}}` |
 *
 * 依据：`deepseek-harness-codearts/src/zcode-anthropic.ts:24-37`（该文件的
 * 「关键形态差异」表，逐条为实测/规范确认）。
 */

import { ProviderError } from './types.js'

/** Anthropic 内容块（本文件用到的子集）。 */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | Array<Record<string, unknown>>
      is_error?: boolean
    }

/** Anthropic 消息（**只有 user / assistant**，system 是顶层字段）。 */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

/** Anthropic 工具声明（**扁平**，不是 OpenAI 的嵌套 `function`）。 */
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  cache_control?: { type: 'ephemeral' }
}

/**
 * 把 JSON 字符串形式的工具参数解析成**对象**。
 *
 * ⚠️ **不补 `{}`**（与 `openai-compat.ts` 同款约定，见
 * `deepseek-harness-codearts/src/zcode-anthropic.ts:77-84`）：
 * 残缺参数应当让上游/harness 报 schema 错误并重试，而不是被静默当成
 * 「无参数调用」—— 后者会让工具收到空参数并可能做出破坏性动作。
 * 这里返回一个带哨兵键的对象，让失败**出现在请求体里**而不是消失。
 */
export function parseToolArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { __unparsableArguments: trimmed }
  }
}

/** 从 OpenAI 形态的 content（字符串或块数组）里取纯文本。 */
export function anthropicTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'input_text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}

/**
 * 把 OpenAI 形态的 image 块转成 Anthropic 的 `image` 块。
 *
 * ## 形态依据（逆向官方 ZCode agent `resources/glm/zcode.cjs`）
 *
 * 见 `deepseek-harness-codearts/src/zcode-anthropic.ts:104-144`：
 * ```js
 * case "file":
 *   if (Dt.mediaType.startsWith("image/"))
 *     $e.push({ type: "image",
 *               source: { type: "base64",
 *                         media_type: Dt.mediaType === "image/*" ? "image/jpeg" : Dt.mediaType,
 *                         data: g2(Dt.data) } })
 * ```
 * `g2(e)` 是「已是字符串就原样用」—— 我们拿到的就是 base64 字符串，直接透传。
 *
 * ⚠️ **`media_type === 'image/*'` 归一为 `image/jpeg`**（官方的兜底分支）：
 * 上游只认具体 mime，收到通配符会拒。漏了这个分支，
 * 用 `image/*` 表示「任意图」的客户端会**全员失败**。
 *
 * ⚠️ **只接受 `data:` URL**：本项目**不下载** http(s) 图片
 * （`AGENTS.md §7.1` 的 SSRF 红线，与 `images.ts:163-168` 同因）。
 */
export function toAnthropicImageBlock(block: Record<string, unknown>): AnthropicBlock | undefined {
  const imageUrl = block.image_url
  const url = typeof imageUrl === 'string'
    ? imageUrl
    : typeof imageUrl === 'object' && imageUrl !== null
      ? (imageUrl as { url?: unknown }).url
      : undefined
  if (typeof url !== 'string') return undefined
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (match === null) return undefined
  const rawMediaType = match[1] ?? 'image/png'
  const mediaType = rawMediaType === 'image/*' ? 'image/jpeg' : rawMediaType
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] ?? '' } }
}

/**
 * OpenAI 形态消息 → Anthropic Messages。
 *
 * 转换规则（逐条对应文件头的差异表）：
 * 1. `role:'system'` 由调用方**先抽走**（见 {@link splitSystemMessages}）——
 *    本函数只处理 user / assistant / tool。
 * 2. `role:'tool'` → 包成 `role:'user'` 的 `tool_result` 块；**连续多个工具结果
 *    合并进同一条 user 消息**（Anthropic 允许，且比发多条 user 更贴近官方形态）。
 * 3. assistant 的 `tool_calls` → `content:[{type:'tool_use',…}]`，
 *    `arguments`（字符串）→ `input`（**对象**）。
 * 4. assistant 的文本与 tool_use 可共存于同一条消息。
 * 5. **空 assistant 消息会被丢弃** —— 上游对空 content 回 400。
 */
export function toAnthropicMessages(
  wire: readonly Record<string, unknown>[],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  /** 把工具结果合并进最后一条 user 消息（若可行）。 */
  const pushToolResult = (block: AnthropicBlock): void => {
    const last = out[out.length - 1]
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(block)
      return
    }
    out.push({ role: 'user', content: [block] })
  }

  for (const message of wire) {
    const role = message.role

    // ⚠️ `system` **必须跳过**，不能落到下面的 user 分支 —— 否则调用方
    // 忘了先调 `splitSystemMessages` 时，system 会变成一条 user 消息，
    // 既污染对话语义，又让上游以为「用户说了一段规则」。
    if (role === 'system') continue

    if (role === 'tool') {
      const toolUseId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      // 孤儿工具结果（没有 tool_call_id）必须丢弃：Anthropic 会 400。
      if (toolUseId.length === 0) continue
      pushToolResult({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: anthropicTextOf(message.content),
      })
      continue
    }

    if (role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      const text = anthropicTextOf(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      const toolCalls = message.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (typeof call !== 'object' || call === null) continue
          const record = call as Record<string, unknown>
          const fn = record.function
          const name = typeof fn === 'object' && fn !== null
            ? (fn as { name?: unknown }).name
            : undefined
          if (typeof name !== 'string' || name.length === 0) continue
          const rawArgs = typeof fn === 'object' && fn !== null
            ? (fn as { arguments?: unknown }).arguments
            : undefined
          blocks.push({
            type: 'tool_use',
            id: typeof record.id === 'string' && record.id.length > 0 ? record.id : `call_${out.length}`,
            name,
            input: parseToolArguments(rawArgs),
          })
        }
      }
      // 空 assistant 消息会让上游 400 —— 丢弃而不是发出。
      if (blocks.length === 0) continue
      out.push({ role: 'assistant', content: blocks })
      continue
    }

    // user（含多模态）
    const content = message.content
    if (typeof content === 'string') {
      if (content.length > 0) out.push({ role: 'user', content })
      continue
    }
    if (!Array.isArray(content)) continue
    const blocks: AnthropicBlock[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') {
        blocks.push({ type: 'text', text: record.text })
        continue
      }
      if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') {
        const image = toAnthropicImageBlock(
          record.type === 'input_image' && typeof record.image_url === 'string'
            ? { image_url: record.image_url }
            : record,
        )
        if (image !== undefined) blocks.push(image)
      }
    }
    if (blocks.length === 0) continue
    out.push({ role: 'user', content: blocks })
  }

  return out
}

/**
 * 从 OpenAI 消息数组里**抽出** system 内容（Anthropic 用顶层 `system` 字段）。
 *
 * ⚠️ 返回**拼接后的字符串**：OpenAI 允许出现多条 system，而 Anthropic 只有
 * 一个顶层槽位。丢弃后续条目是错的（那会静默丢掉调用方的规则）。
 */
export function splitSystemMessages(
  wire: readonly Record<string, unknown>[],
): { system: string | undefined; rest: Array<Record<string, unknown>> } {
  const parts: string[] = []
  const rest: Array<Record<string, unknown>> = []
  for (const message of wire) {
    if (message.role === 'system') {
      const text = anthropicTextOf(message.content)
      if (text.length > 0) parts.push(text)
      continue
    }
    rest.push(message)
  }
  return { system: parts.length > 0 ? parts.join('\n\n') : undefined, rest }
}

/** OpenAI 扁平/嵌套工具表 → Anthropic `input_schema` 形态。 */
export function toAnthropicTools(
  tools: readonly Record<string, unknown>[],
): AnthropicTool[] {
  const out: AnthropicTool[] = []
  for (const tool of tools) {
    // 兼容两种输入：OpenAI 嵌套（`function` 子对象）与已扁平化的形态。
    const fn = typeof tool.function === 'object' && tool.function !== null
      ? (tool.function as Record<string, unknown>)
      : tool
    const name = fn.name
    if (typeof name !== 'string' || name.length === 0) continue
    const description = fn.description
    const parameters = fn.parameters
    out.push({
      name,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      input_schema: typeof parameters === 'object' && parameters !== null
        ? (parameters as Record<string, unknown>)
        : { type: 'object', properties: {} },
    })
  }
  return out
}

/**
 * OpenAI `tool_choice` → Anthropic `tool_choice`。
 *
 * ⚠️ 映射**不是**同名的：OpenAI 的 `required` 在 Anthropic 是 `any`，
 * 而 Anthropic **没有** `none`（要「禁止调用工具」就不下发 `tools`）。
 * 故 `none` 返回 `undefined`，由调用方决定是否丢弃工具表。
 *
 * ⚠️ **`'none'` 必须先于「当函数名」的分支判掉**（本项目写用例时实测到）：
 * 只写「其余字符串即函数名」会把 `none` 变成
 * `{type:'tool', name:'none'}` —— 一个**永远不存在的工具**，
 * 上游会因此报错或让模型去调一个不存在的函数。
 *
 * 依据：Anthropic Messages API 的 `tool_choice` 取值为
 * `{type:'auto'}` / `{type:'any'}` / `{type:'tool', name}`；
 * OpenAI 的为 `'none'` / `'auto'` / `'required'` / `{type:'function',…}`。
 */
export function toAnthropicToolChoice(
  choice: unknown,
): Record<string, unknown> | undefined {
  if (typeof choice !== 'string') {
    // 已经是对象形态（Anthropic 原生或 OpenAI 嵌套）时透传已知形状。
    if (typeof choice === 'object' && choice !== null) {
      const record = choice as Record<string, unknown>
      const type = record.type
      if (typeof type === 'string') {
        if (type === 'function') {
          const name = (record.function as { name?: unknown } | undefined)?.name
          return typeof name === 'string' && name.length > 0 ? { type: 'tool', name } : undefined
        }
        if (type === 'auto' || type === 'any' || type === 'tool') return record
      }
    }
    return undefined
  }
  if (choice === 'auto') return { type: 'auto' }
  // ⚠️ `required` → `any`，**不是**同名映射。
  if (choice === 'required') return { type: 'any' }
  // ⚠️ OpenAI 的 `'none'` = 「不许调工具」。Anthropic **没有**对应取值 ——
  // 正确做法是**不下发 `tools`**，故这里返回 undefined（调用方负责丢弃工具表）。
  // 绝不能落到下面「当函数名」的分支。
  if (choice === 'none') return undefined
  // OpenAI 的 `{type:'function', function:{name}}` 简写：`"name"` 直接给函数名。
  return { type: 'tool', name: choice }
}

/**
 * 给工具表的**最后一个**工具打 prompt caching 断点。
 *
 * ## 为什么只打一个（这是缓存语义，不是省事）
 *
 * Anthropic 的 prompt caching 是**前缀式**的：断点覆盖「**该断点之前的全部内容**」
 * （system + 它之前的全部 tools）。故只在最后一个 tool 上打一个点，就等于把
 * 「system + 全部 tools」整段纳入缓存。
 *
 * ⚠️ 断点有**数量上限（4 个）**：system 块若每块都打，会把预算用光，
 * 于是每步请求全量重算全部工具 schema 的 prefill。
 * 依据：`deepseek-harness-codearts/src/zcode-adapter.ts:1507-1540`。
 */
export function withToolCacheBreakpoint(
  tools: readonly AnthropicTool[],
): AnthropicTool[] {
  if (tools.length === 0) return []
  const out = tools.map((tool) => ({ ...tool }))
  const last = out[out.length - 1]
  if (last !== undefined) last.cache_control = { type: 'ephemeral' }
  return out
}

/** 解析后的 SSE 帧（`event:` 行 + `data:` 行）。 */
export interface SseFrame {
  event?: string
  data: string
}

/**
 * 解析一个 SSE 帧的原始文本。
 *
 * ⚠️ **多行 `data:` 必须用 `\n` 拼接**（SSE 规范：多个 `data:` 行等价于
 * 用换行连接的内容）。只取最后一行会让跨行 JSON 被截断，
 * 而 Anthropic 的 `error` 事件恰好可能跨行。
 */
export function parseSseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split(/\r?\n/)
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0 && event === undefined) return undefined
  return { event, data: dataLines.join('\n') }
}

/**
 * 找到**最早**的空行分隔符（兼容 CRLF）。
 *
 * ⚠️ **不能先查 `\n\n` 再查 `\r\n\r\n`**：在 CRLF 流里 `\r\n\r\n` 同时包含一个
 * `\n\n`（第 2–3 字节），先查 LF 会切在错误位置（把 `\r` 留在下一帧开头）。
 * 依据：`deepseek-harness-codearts/src/zcode-anthropic.ts:353-367`。
 */
export function findFrameBoundary(buffer: string): { start: number; end: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (crlf === -1) return { start: lf, end: lf + 2 }
  if (lf === -1) return { start: crlf, end: crlf + 4 }
  return crlf < lf ? { start: crlf, end: crlf + 4 } : { start: lf, end: lf + 2 }
}

/**
 * Anthropic `stop_reason` → OpenAI `finish_reason`。
 *
 * | Anthropic | OpenAI |
 * |---|---|
 * | `end_turn` / `stop_sequence` / 缺失 | `stop` |
 * | `max_tokens` | `length` |
 * | `tool_use` | `tool_calls` |
 *
 * ⚠️ **有工具调用时必须报 `tool_calls`**（不论上游说什么）：
 * 那是客户端决定「继续执行工具」的依据；报成 `stop` 会让循环停下来，
 * 表现为「模型说要调工具但什么都没发生」。
 * 依据：`deepseek-harness-codearts/src/zcode-anthropic.ts:749-758`。
 */
export function toOpenAiFinishReason(
  stopReason: string | undefined,
  sawToolCall: boolean,
): string {
  if (sawToolCall) return 'tool_calls'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'tool_use') return 'tool_calls'
  return 'stop'
}

/** 流式转换过程中累积的一个内容块。 */
interface BlockState {
  index: number
  kind: 'text' | 'reasoning' | 'tool'
  text: string
  callId: string
  name: string
  args: string
  /** 是否已对客户端发出过首帧（工具块延后到有内容才发）。 */
  started: boolean
  /** 下一个 OpenAI `tool_calls` 的数组下标（与 Anthropic 的块序号解耦）。 */
  toolOrdinal: number
}

/** 流式转换的可变状态（一个流一份）。 */
export interface AnthropicStreamState {
  /** 已完成/进行中的块，按 Anthropic 的块序号索引。 */
  blocks: Map<number, BlockState>
  /** 下一个 `tool_calls` 序号。 */
  nextToolOrdinal: number
  /** `message_start` 里的 input tokens。 */
  inputTokens: number | undefined
  /** `message_delta` 里的 output tokens。 */
  outputTokens: number | undefined
  /** 缓存命中/写入 token（Anthropic 单独计量）。 */
  cacheReadTokens: number | undefined
  cacheWriteTokens: number | undefined
  stopReason: string | undefined
  /** 是否已产出过任何内容（用于「空响应必须显式报错」）。 */
  sawContent: boolean
  /** 是否已发出过 OpenAI 的 `role: 'assistant'` 首帧。 */
  announcedRole: boolean
  /** 是否见过任何工具调用（决定 finish_reason）。 */
  sawToolCall: boolean
  /** 上游是否显式报错（错误帧已下发，收尾不得再补 `[DONE]` 伪装成功）。 */
  failed: boolean
  model: string
  id: string
  created: number
}

/** 新建一份流转换状态。 */
export function createAnthropicStreamState(model: string): AnthropicStreamState {
  return {
    blocks: new Map(),
    nextToolOrdinal: 0,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    stopReason: undefined,
    sawContent: false,
    announcedRole: false,
    sawToolCall: false,
    failed: false,
    model,
    id: `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`,
    created: Math.floor(Date.now() / 1000),
  }
}

/**
 * OpenAI chunk 的公共外壳。
 *
 * ⚠️ **首帧必须带 `role: 'assistant'`**（OpenAI 的流式契约），
 * 之后各帧**不得**重复带 `role` —— 部分客户端会因「同一帧里 role 又出现」
 * 而重开会话。故一旦发出就置 `announcedRole`。
 */
function chunkEnvelope(state: AnthropicStreamState, delta: Record<string, unknown>, finishReason?: string | null): string {
  const withRole = state.announcedRole ? delta : { role: 'assistant', ...delta }
  state.announcedRole = true
  return JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: withRole,
        finish_reason: finishReason ?? null,
      },
    ],
  })
}

/**
 * 把**一个 Anthropic SSE 帧**翻译成零到多个 OpenAI SSE 帧。
 *
 * ## 为什么是「一帧进、多帧出」的纯函数而不是状态机类
 *
 * 状态（块序号 / usage / stop_reason）跨帧存活，但转换本身是纯的 ——
 * 状态作为参数传入。这样它既能在 `TransformStream` 里逐帧调用（不缓冲），
 * 又能被单测直接驱动（不需要构造网络流）。
 *
 * ## 事件映射
 *
 * | Anthropic | 产出 |
 * |---|---|
 * | `content_block_start`(text) | 打开文本块（首帧带 `role`） |
 * | `content_block_start`(thinking/redacted_thinking) | 打开思考块 → `reasoning_content` |
 * | `content_block_start`(tool_use) | 记录 id/name（等 `input_json_delta`） |
 * | `content_block_delta`(text_delta) | `delta.content` |
 * | `content_block_delta`(thinking_delta) | `delta.reasoning_content` |
 * | `content_block_delta`(input_json_delta) | `delta.tool_calls[].function.arguments` |
 * | `message_start` | 记 input usage |
 * | `message_delta` | 记 output usage + `stop_reason` |
 * | `message_stop` | 收尾（`finish_reason` + usage + `[DONE]`） |
 * | `error` / `{type:'error'}` | **降级为 `error` 帧**（不静默结束） |
 * | `ping` | 忽略（不发心跳：本项目网关会补） |
 *
 * ⚠️ **`error` 必须显式下发**。参考项目记过同型缺陷：Qoder 的错误帧被静默
 * 当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」
 * （`AGENTS.md` 的 Qoder 章节）。这里产出的是 `gateway/stream.ts` 能识别的
 * `{error:{message}}` 帧。
 *
 * @returns 要写给客户端的 SSE 文本块数组（可能为空）。
 */
export function translateAnthropicFrame(
  state: AnthropicStreamState,
  frame: SseFrame,
): string[] {
  if (frame.data.length === 0) {
    // 只有 `event:` 行（Anthropic 不会这样发，但容错）
    if (frame.event === 'message_stop') return finishAnthropicStream(state)
    return []
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>
  } catch {
    // 非 JSON 帧（如代理插入的心跳）忽略 —— 但**不能**吞掉 `error` 事件名。
    if (frame.event === 'error') {
      state.failed = true
      return [openAiErrorFrame(`上游返回了非 JSON 的错误帧：${frame.data.slice(0, 200)}`)]
    }
    return []
  }

  const type = typeof payload.type === 'string' ? payload.type : frame.event
  const index = typeof payload.index === 'number' ? payload.index : 0

  // ── 错误帧（两种形态都认：`event: error` 与 `payload.type === 'error'`）──
  if (type === 'error' || frame.event === 'error') {
    const error = payload.error
    const message = typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined
    const errorType = typeof error === 'object' && error !== null
      ? (error as { type?: unknown }).type
      : undefined
    state.failed = true
    const label = typeof errorType === 'string' && errorType.length > 0 ? `[${errorType}] ` : ''
    return [
      openAiErrorFrame(
        `${label}${typeof message === 'string' ? message : JSON.stringify(payload).slice(0, 300)}`,
      ),
    ]
  }

  if (type === 'content_block_start') {
    const block = payload.content_block
    const blockType = typeof block === 'object' && block !== null
      ? (block as { type?: unknown }).type
      : undefined
    if (blockType === 'tool_use') {
      const record = block as { id?: unknown; name?: unknown }
      state.blocks.set(index, {
        index,
        kind: 'tool',
        text: '',
        callId: typeof record.id === 'string' && record.id.length > 0 ? record.id : `call_${index}`,
        name: typeof record.name === 'string' ? record.name : '',
        args: '',
        // ⚠️ 工具块**延后**首帧：空 `tool_calls` 条目（无 name）在客户端不可用。
        started: false,
        toolOrdinal: -1,
      })
      return []
    }
    const kind = blockType === 'thinking' || blockType === 'redacted_thinking' ? 'reasoning' : 'text'
    state.blocks.set(index, {
      index,
      kind,
      text: '',
      callId: '',
      name: '',
      args: '',
      started: true,
      toolOrdinal: -1,
    })
    // Anthropic 的 `content_block_start` 本身不带内容（text 为空串），
    // 但我仍发一帧：它承担「宣告 role」的职责，且客户端需要一个起点。
    return [sseFrame(chunkEnvelope(state, {}))]
  }

  if (type === 'content_block_delta') {
    const delta = payload.delta
    if (typeof delta !== 'object' || delta === null) return []
    const record = delta as Record<string, unknown>
    const deltaType = record.type

    if (deltaType === 'text_delta' && typeof record.text === 'string' && record.text.length > 0) {
      state.sawContent = true
      return [sseFrame(chunkEnvelope(state, { content: record.text }))]
    }

    if (deltaType === 'thinking_delta' && typeof record.thinking === 'string' && record.thinking.length > 0) {
      state.sawContent = true
      // ⚠️ 思考必须走 `reasoning_content`（OpenAI 生态的既有约定，
      // `gateway/stream.ts` 与下游客户端都认这个字段名）。
      return [sseFrame(chunkEnvelope(state, { reasoning_content: record.thinking }))]
    }

    if (deltaType === 'input_json_delta') {
      const partial = typeof record.partial_json === 'string' ? record.partial_json : ''
      const block = state.blocks.get(index)
      if (block === undefined) return []
      block.args += partial
      if (partial.length === 0) return []
      state.sawContent = true
      state.sawToolCall = true
      if (!block.started) {
        block.started = true
        block.toolOrdinal = state.nextToolOrdinal
        state.nextToolOrdinal += 1
      }
      return [
        sseFrame(
          chunkEnvelope(state, {
            tool_calls: [
              {
                index: block.toolOrdinal,
                id: block.callId,
                type: 'function',
                function: { name: block.name, arguments: partial },
              },
            ],
          }),
        ),
      ]
    }

    return []
  }

  // ── usage / stop_reason ──
  if (type === 'message_start') {
    const message = payload.message
    if (typeof message === 'object' && message !== null) {
      collectAnthropicUsage(state, (message as { usage?: unknown }).usage)
    }
    return []
  }

  if (type === 'message_delta') {
    collectAnthropicUsage(state, payload.usage)
    const delta = payload.delta
    if (typeof delta === 'object' && delta !== null) {
      const stopReason = (delta as { stop_reason?: unknown }).stop_reason
      if (typeof stopReason === 'string' && stopReason.length > 0) state.stopReason = stopReason
    }
    return []
  }

  if (type === 'message_stop') return finishAnthropicStream(state)

  // `content_block_stop` / `ping` / 未知事件：不需要即时产出。
  return []
}

/**
 * 收集 Anthropic 的 usage。
 *
 * ⚠️ **必须两处都收**：`message_start` 给 input，`message_delta` 给 output。
 * 只读其中一处都会缺字段（早读没有 output、晚读没有 input）。
 * 依据：`deepseek-harness-codearts/src/zcode-anthropic.ts:598-634`。
 *
 * ⚠️ **用「有值才覆盖」而不是直接赋值**：后到的 `message_delta`（无
 * `input_tokens`）会把先前读到的 input 冲成 `undefined`。
 *
 * ⚠️ **缓存口径分立**：`cache_read_input_tokens` 是命中部分、
 * `cache_creation_input_tokens` 是写入部分，**都不计入** `input_tokens`
 * （Anthropic 的 `input_tokens` 本身就只含未命中部分）。
 */
function collectAnthropicUsage(state: AnthropicStreamState, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return
  const u = usage as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  state.inputTokens = num(u.input_tokens) ?? state.inputTokens
  state.outputTokens = num(u.output_tokens) ?? state.outputTokens
  state.cacheReadTokens = num(u.cache_read_input_tokens) ?? state.cacheReadTokens
  state.cacheWriteTokens = num(u.cache_creation_input_tokens) ?? state.cacheWriteTokens
}

/**
 * 流收尾：`finish_reason` 帧 + usage 帧 + `[DONE]`。
 *
 * ⚠️ **空响应必须显式报错**：对「完全没有任何内容」的 200 响应，
 * 必须让用户看到错误，而不是一个无声的空回复。这正是不依赖 `[DONE]` 的
 * Anthropic SSE 最容易漏的一环（OpenAI 侧有 `[DONE]` 做锚点，Anthropic 没有）。
 * 依据：`deepseek-harness-codearts/src/zcode-anthropic.ts:640-670`。
 *
 * ⚠️ 已失败（`state.failed`）时**不再补 `[DONE]`** —— 那会把一次失败
 * 伪装成「正常结束」，正是 `AGENTS.md` 反复警告的形态。
 */
export function finishAnthropicStream(state: AnthropicStreamState): string[] {
  const frames: string[] = []
  if (!state.sawContent && !state.failed) {
    state.failed = true
    frames.push(openAiErrorFrame('上游返回了空响应（无任何 text / thinking / tool 内容）'))
  }
  if (state.failed) return frames

  frames.push(
    sseFrame(chunkEnvelope(state, {}, toOpenAiFinishReason(state.stopReason, state.sawToolCall))),
  )

  // usage 帧：`gateway/stream.ts` 从 `usage.prompt_tokens` 抓用量记账。
  // ⚠️ 只在**至少拿到一个数**时才发：全 undefined 的 usage 会让面板显示 0，
  // 那比不发更误导。
  if (
    state.inputTokens !== undefined || state.outputTokens !== undefined
    || state.cacheReadTokens !== undefined || state.cacheWriteTokens !== undefined
  ) {
    const input = state.inputTokens ?? 0
    const output = state.outputTokens ?? 0
    frames.push(
      sseFrame(JSON.stringify({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [],
        usage: {
          prompt_tokens: input,
          completion_tokens: output,
          total_tokens: input + output + (state.cacheReadTokens ?? 0) + (state.cacheWriteTokens ?? 0),
        },
      })),
    )
  }

  frames.push('data: [DONE]\n\n')
  return frames
}

/** 包成一个 SSE 帧。 */
export function sseFrame(payload: string): string {
  return `data: ${payload}\n\n`
}

/** 构造 `gateway/stream.ts` 能识别的 OpenAI 错误帧。 */
export function openAiErrorFrame(message: string): string {
  return sseFrame(JSON.stringify({ error: { message, type: 'upstream_error' } }))
}

/**
 * 把 Anthropic SSE 字节流**逐帧**转成 OpenAI SSE 字节流。
 *
 * ## 铁律：必须流式（`AGENTS.md §8.2.2`）
 *
 * Free 计划只有 10ms CPU/次调用。整包缓冲（`await response.text()`）会
 * ①超出 CPU 预算被掐；②客户端看到「卡很久然后一次性吐出」。
 * 故这里是 `TransformStream`：上游来一帧就转一帧、推一帧。
 *
 * ## 兜底纪律
 *
 * 1. **上游流中途断开**（未收到 `message_stop`）→ 也必须收尾，
 *    否则客户端会永远等 `[DONE]`（表现为「回答完了但不结束」）。
 * 2. **非 SSE 响应体**（上游直接回 JSON 错误）→ 原样透传文本，
 *    让客户端看到原文，而不是静默变成空流。
 */
export function anthropicSseToOpenAiSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()
  const state = createAnthropicStreamState(model)
  let buffer = ''
  let finished = false

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, chunks: readonly string[]): void => {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
  }

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          const boundary = findFrameBoundary(buffer)
          if (boundary === undefined) break
          const raw = buffer.slice(0, boundary.start)
          buffer = buffer.slice(boundary.end)
          const frame = parseSseFrame(raw)
          if (frame === undefined) continue
          if (frame.event === 'message_stop' || (frame.data.includes('"message_stop"'))) finished = true
          emit(controller, translateAnthropicFrame(state, frame))
        }
      },
      flush(controller) {
        // 尾帧（没有以空行结束的最后一帧）
        const tail = parseSseFrame(buffer)
        if (tail !== undefined) {
          emit(controller, translateAnthropicFrame(state, tail))
        }
        // ⚠️ 上游**总是**要收尾：见过 `message_stop` 时
        // `translateAnthropicFrame` 已发过 finish/usage/`[DONE]`，
        // 这里的幂等由 `state.failed` + `finished` 共同保证。
        if (!finished && !state.failed) {
          emit(controller, finishAnthropicStream(state))
        }
      },
    }),
  )
}

/** 供上层把 `ProviderError` 里的可读原因塞进错误帧（避免把异常吞成空流）。 */
export function providerErrorToSseFrame(error: unknown, provider: string): string {
  const message = error instanceof ProviderError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error)
  return openAiErrorFrame(`${provider}: ${message}`)
}
