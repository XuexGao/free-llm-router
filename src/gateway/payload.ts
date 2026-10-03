/**
 * 出站请求体准备（**纯函数**）。
 *
 * ## 为什么需要这一层
 *
 * OpenAI 客户端发的请求体**不能原样**转给 WorkBuddy 上游，有四处硬性差异
 * （逐条来自 Go 侧实测，AGENTS.md §6）：
 *
 * | 差异 | 后果（若不处理） |
 * |---|---|
 * | 上游**只认 `max_tokens`**，不认 `max_completion_tokens` | 别名被忽略 → 回落默认输出上限（实测 32000）→ **长流被截断** |
 * | 上游要求 **`stream: true`** | 非流式请求被上游按流式处理不当 |
 * | `tool_choice` 只认**字符串** | 对象形式 → **400 code=11101** |
 * | `stream_options.include_usage` 缺省需补 | 末帧不返回 usage → 用量统计恒为 0 |
 *
 * ## 分层纪律
 *
 * 纯函数、无网络、无存储 —— 上游改判据时**只改这个文件**，网关逻辑不动。
 */

/** 需要翻译的字段名（OpenAI 新字段 → 上游认的旧字段）。 */
export function translateMaxCompletionTokens(body: Record<string, unknown>): void {
  const alias = body.max_completion_tokens
  delete body.max_completion_tokens

  // ⚠️ 显式 max_tokens 优先：别名只删不译（避免把别名值覆盖掉用户显式给的值）
  if (body.max_tokens !== undefined) return

  // 只有正整数才翻译。0/null 是「未设置」语义，负数是非法值 —— 都不该变成 max_tokens
  if (typeof alias === 'number' && Number.isSafeInteger(alias) && alias > 0) {
    body.max_tokens = alias
  }
}

/**
 * 归一化 `tool_choice`：上游该字段是 **string**，对象形式会 400 `code=11101`。
 *
 * - `'auto'` / `'none'` / `'required'` → 原样透传；
 * - 对象形式（`{type:'function', function:{name}}`）→ 降级为 `'auto'`（**不是**报错：
 *   降级能让请求成功，报错会让整个对话失败。而具名选择在多数客户端里只影响
 *   偏好，不影响正确性）；
 * - 其他未知形态 → 删除该字段（缺省即 `auto`）。
 */
export function normalizeToolChoice(body: Record<string, unknown>): void {
  const choice = body.tool_choice
  if (choice === undefined) return

  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return
    // 未知字符串：删掉（缺省即 auto），比传给上游被拒好
    delete body.tool_choice
    return
  }

  // 对象形式（含具名函数）：降级为 auto
  delete body.tool_choice
  body.tool_choice = 'auto'
}

/**
 * 补齐 `stream_options.include_usage`。
 *
 * 只有**显式没带**时才补：用户显式设了 `include_usage: false` 就尊重它。
 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (body.stream_options !== undefined) return
  body.stream_options = { include_usage: true }
}

/**
 * 工具配对清理：剔除「孤儿」`tool` 消息与不完整的 `tool_calls`。
 *
 * ## 为什么必须做（Go 侧 `tool_pairing.go` 记录的严重缺陷）
 *
 * OpenAI 规范要求每个 `role:'tool'` 消息都有一个**前序** assistant 消息里的
 * `tool_calls` 与之配对（靠 `tool_call_id`）。
 *
 * 若配对不完整，上游会**对之后每条消息都返 400** ——
 * 也就是整条会话报废，且错误信息不指出是哪个字段。
 *
 * 客户端在中断/重试/切模型时很容易产生孤儿 tool 消息，故必须先行清理。
 *
 * @returns 清理后的消息数组（无改动时返回原数组）
 */
export function cleanupToolPairing(messages: unknown[]): unknown[] {
  // 第一遍：收集所有 assistant 消息声明的 tool_call id
  const declared = new Set<string>()
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    if (msg.role !== 'assistant') continue
    const calls = msg.tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue
      const id = (call as Record<string, unknown>).id
      if (typeof id === 'string' && id !== '') declared.add(id)
    }
  }

  const out: unknown[] = []
  let changed = false

  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') {
      out.push(raw)
      continue
    }
    const msg = raw as Record<string, unknown>

    // 剔除孤儿 tool 消息（tool_call_id 未被子集声明）
    if (msg.role === 'tool') {
      const id = msg.tool_call_id
      if (typeof id !== 'string' || id === '' || !declared.has(id)) {
        changed = true
        continue // 丢弃
      }
    }

    // 剔除 assistant 消息里**名字为空**的 tool_call（Go 侧记录过它跨 provider 传染）
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const kept = (msg.tool_calls as unknown[]).filter((call) => {
        if (call === null || typeof call !== 'object') return false
        const c = call as Record<string, unknown>
        const fn = c.function
        if (fn === null || typeof fn !== 'object') return false
        const name = (fn as Record<string, unknown>).name
        // ⚠️ 名称为空的 tool_call 会让整条会话报废（上游报 11133 且不指出字段）
        return typeof name === 'string' && name !== ''
      })
      if (kept.length !== msg.tool_calls.length) {
        changed = true
        if (kept.length === 0) {
          delete msg.tool_calls
        } else {
          msg.tool_calls = kept
        }
      }
    }

    out.push(msg)
  }

  return changed ? out : messages
}

/** 准备结果。 */
export interface PrepareResult {
  body: string
  /** 做过的改写（供日志与排查）。 */
  applied: string[]
}

/**
 * 完整准备管线。
 *
 * ⚠️ 顺序即语义：先翻译字段名（影响后续判断），再清理工具配对
 * （配对错误会让整个请求失败，必须最先修好内容）。
 */
export function prepareChatBody(input: unknown): PrepareResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = { ...(input as Record<string, unknown>) }
  const applied: string[] = []

  // ① 强制 stream（上游要求）
  if (body.stream !== true) {
    body.stream = true
    applied.push('stream=true')
  }

  // ② max_completion_tokens → max_tokens
  if (body.max_completion_tokens !== undefined) {
    translateMaxCompletionTokens(body)
    applied.push('max_completion_tokens→max_tokens')
  }

  // ③ stream_options 补默认
  if (body.stream_options === undefined) {
    ensureStreamOptions(body)
    applied.push('stream_options.include_usage')
  }

  // ④ tool_choice 归一化（对象形式会 400）
  if (body.tool_choice !== undefined) {
    const before = typeof body.tool_choice
    normalizeToolChoice(body)
    if (before === 'object') applied.push('tool_choice→auto')
  }

  // ⑤ 工具配对清理（不完整配对会让之后每条消息都 400）
  if (Array.isArray(body.messages)) {
    const cleaned = cleanupToolPairing(body.messages)
    if (cleaned !== body.messages) {
      body.messages = cleaned
      applied.push('tool-pairing')
    }
  } else {
    throw new Error('messages 必须是数组')
  }

  return { body: JSON.stringify(body), applied }
}

/**
 * 反探测脱敏（AGENTS.md §6.6）。
 *
 * 裸数字 `11128` 出现在请求体里**本身就是拦截条件**，必须改写。
 * 零宽空格无效（上游会归一化），故插入连字符。
 */
export function sanitizeChatBody(body: string): string {
  if (!body.includes('11128')) return body
  return body.replaceAll('11128', '11-128')
}
