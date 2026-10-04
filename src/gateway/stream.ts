/**
 * SSE 流翻译：上游 WorkBuddy 流 → OpenAI 兼容 chunk 流。
 *
 * ## 铁律：必须流式，禁止整包缓冲（AGENTS.md §8.2.2）
 *
 * Free 计划只有 **10ms CPU/次调用**。若把整个响应读进内存再解析
 * （`await response.json()` 或 `await response.text()`），长回答会：
 * 1. 超出 CPU 预算被掐；
 * 2. 客户端看到「卡很久然后一次性吐出」而不是逐字输出。
 *
 * ⇒ 必须**逐块透传**：上游来一帧就转一帧、推一帧。
 *
 * ## 上游帧形状
 *
 * 上游是标准 OpenAI SSE（`data: {...}\n\n`），字段名与 OpenAI 一致：
 * `choices[0].delta.content` / `.reasoning_content` / `.tool_calls`。
 *
 * ⚠️ 但**不能假设它永远规范**：Go 侧记录过多种「非预期形状被静默丢弃」
 * 的缺陷（无 `choices`、错误帧没有 `code`/`error`、响应根本不是 SSE）。
 * 故这里的策略是：**能识别的正常转发，识别不了的必须让客户端看到**
 * （通过 `error` 帧），绝不静默吞掉。
 */

/** 一帧的解析结果。 */
export type FrameKind = 'chunk' | 'done' | 'error' | 'ignore'

export interface ParsedFrame {
  kind: FrameKind
  /** `data:` 后面的原始 JSON 文本（`kind==='chunk'` 时）。 */
  data?: string
  /** 错误说明（`kind==='error'` 时）。 */
  error?: string
}

/**
 * 解析一行 SSE。
 *
 * @param line 不含换行符的单行
 */
export function parseSseLine(line: string): ParsedFrame {
  const trimmed = line.trim()
  if (trimmed === '') return { kind: 'ignore' }

  // 注释行（`: heartbeat`）——上游用它保活，直接忽略
  if (trimmed.startsWith(':')) return { kind: 'ignore' }

  if (!trimmed.startsWith('data:')) {
    // `event:` / `id:` / `retry:` 等：本项目不需要，忽略
    return { kind: 'ignore' }
  }

  const payload = trimmed.slice(5).trim() // 去掉 'data:'
  if (payload === '') return { kind: 'ignore' }
  if (payload === '[DONE]') return { kind: 'done' }

  // 校验是 JSON 对象；不是则如实报错（不静默丢）
  if (!payload.startsWith('{')) {
    return { kind: 'error', error: `非预期的 SSE 数据帧（不是 JSON 对象）：${payload.slice(0, 160)}` }
  }

  return { kind: 'chunk', data: payload }
}

/**
 * 判断一个已解析的 chunk 是否是**错误帧**。
 *
 * ## 为什么必须显式识别
 *
 * Go 侧记录了多个「没有任何报错就中断」的真实缺陷，全部源于解析器不认错误帧：
 * - 网关形态错误帧 `{stackTrace:[...], message, statusCodeValue:400}`
 *   —— **既没有 `code` 也没有 `error`、也没有 `choices`**；
 * - 上游直接回 JSON（完全没有 `data:` 帧）。
 *
 * 若不识别，客户端会看到「干净地停止、无任何报错」—— 这正是最糟的失败形态。
 *
 * @returns 错误说明，或 undefined（不是错误帧）
 */
export function detectErrorFrame(chunk: Record<string, unknown>): string | undefined {
  // 形态 1：OpenAI 标准错误
  const err = chunk.error
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const msg = typeof e.message === 'string' ? e.message : JSON.stringify(e).slice(0, 200)
    return msg
  }

  // 形态 2：业务码非 0
  const code = chunk.code
  if (typeof code === 'number' && code !== 0) {
    const msg = typeof chunk.msg === 'string' ? chunk.msg : ''
    return `上游业务错误 code=${code}${msg === '' ? '' : ` msg=${msg}`}`
  }

  // 形态 3：网关形态（statusCodeValue / stackTrace）—— 最容易被漏掉的一类
  const statusCodeValue = chunk.statusCodeValue
  if (typeof statusCodeValue === 'number' && statusCodeValue >= 400) {
    const msg = typeof chunk.message === 'string' ? chunk.message : '网关错误'
    return `${msg}（statusCodeValue=${statusCodeValue}）`
  }
  if (Array.isArray(chunk.stackTrace) && chunk.choices === undefined) {
    const msg = typeof chunk.message === 'string' ? chunk.message : '上游返回了堆栈信息'
    return msg
  }

  // 形态 4：既没有 choices 也没有已知错误字段 —— 可疑但可能是 usage 帧
  return undefined
}

/**
 * 把上游的一帧转成给客户端的输出。
 *
 * @returns 要写给客户端的内容（含 `data:` 前缀与结尾空行），或空串表示不写
 */
export function translateFrame(rawData: string): string {
  // 原样转发：上游帧形状与 OpenAI 一致（`delta.content` / `reasoning_content` / `tool_calls`）。
  // ⚠️ 刻意**不重新序列化**（不 JSON.parse 再 stringify）：
  // 那会多一次全量解析 + 序列化的 CPU 开销，而 Free 计划只有 10ms。
  // 只在需要**改写**时才解析（见 detectErrorFrame 的调用点）。
  return `data: ${rawData}\n\n`
}

/** 生成一个错误帧（OpenAI 兼容形状），让客户端能看到失败原因。 */
export function errorFrame(message: string): string {
  const payload = JSON.stringify({
    error: { message, type: 'upstream_error' },
  })
  return `data: ${payload}\n\n`
}

/** SSE 结束标记。 */
export function doneFrame(): string {
  return 'data: [DONE]\n\n'
}

/** OpenAI 兼容的响应头。 */
export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    // 关掉 nginx 类中间层的缓冲（虽是 CF 边缘，但保持语义正确）
    'x-accel-buffering': 'no',
  }
}


// ─────────────────── 非流式聚合（客户端要 stream:false 时用） ───────────────────

/** 聚合后的单次补全（OpenAI 非流式形状）。 */
export interface AggregatedCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason: string | null
  }>
  usage?: unknown
}

/**
 * 把上游 SSE 流聚合成**一个**非流式补全。
 *
 * ## ⚠️ 为什么必须做（实测踩到的严重缺陷）
 *
 * 上游**只支持流式**（`AGENTS.md §6.x`：请求体必须 `stream: true`），
 * 故我们一律以流式请求上游。但**客户端**可能要非流式（`stream: false`。
 *
 * 原来的实现**从不检查客户端要什么**，一律把 SSE 转发回去 ——
 * 于是非流式客户端拿到 `data: {...}` 这样的文本，试图 `JSON.parse` 就报
 * `Unexpected JSON token at offset 5: Expected EOF after parsing, but had : instead`
 *（offset 5 正是 `data:` 的冒号）。
 *
 * 修法：客户端要非流式时，在这里把 SSE 帧合并成一条完整回复。
 *
 * ⚠️ 与流式路径的取舍不同：这里**必须缓冲**（非流式的语义就是「一次给完」）。
 * 故它只用于非流式请求；流式路径仍然逐帧透传（10ms CPU 纪律）。
 */
export function aggregateSse(
  rawSse: string,
  meta: { model: string; now: number },
): AggregatedCompletion {
  const result: AggregatedCompletion = {
    id: '',
    object: 'chat.completion',
    created: Math.floor(meta.now / 1000),
    model: meta.model,
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
  }

  let content = ''
  let reasoning = ''
  const toolCalls: Array<Record<string, unknown>> = []
  const choice = result.choices[0]
  if (choice === undefined) return result

  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '' || payload === '[DONE]') continue

    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue // 非 JSON 帧（心跳等）直接跳过
    }

    // 顶层 id / usage 取最后一次出现的值
    if (typeof frame['id'] === 'string' && frame['id'] !== '') result.id = frame['id']
    if (frame['usage'] !== undefined && frame['usage'] !== null) result.usage = frame['usage']

    const choices = frame['choices']
    if (!Array.isArray(choices)) continue
    for (const c of choices) {
      if (c === null || typeof c !== 'object') continue
      const ch = c as Record<string, unknown>
      const delta = ch['delta']
      if (delta !== null && typeof delta === 'object') {
        const d = delta as Record<string, unknown>
        if (typeof d['content'] === 'string') content += d['content']
        if (typeof d['reasoning_content'] === 'string') reasoning += d['reasoning_content']
        if (Array.isArray(d['tool_calls'])) {
          // ⚠️ 工具调用的 arguments 是**分片**到达的，必须按 index 合并，
          // 否则客户端拿到的是被截断的 JSON（无法解析）。
          for (const tc of d['tool_calls']) {
            if (tc === null || typeof tc !== 'object') continue
            const t = tc as Record<string, unknown>
            const idx = typeof t['index'] === 'number' ? t['index'] : toolCalls.length
            const slot = (toolCalls[idx] ??= { index: idx, id: '', type: 'function', function: { name: '', arguments: '' } })
            const fn = slot['function'] as Record<string, unknown>
            if (typeof t['id'] === 'string' && t['id'] !== '') slot['id'] = t['id']
            const tf = t['function']
            if (tf !== null && typeof tf === 'object') {
              const f = tf as Record<string, unknown>
              if (typeof f['name'] === 'string' && f['name'] !== '') fn['name'] = f['name']
              if (typeof f['arguments'] === 'string') fn['arguments'] = String(fn['arguments'] ?? '') + f['arguments']
            }
          }
        }
      }
      const fr = ch['finish_reason']
      if (typeof fr === 'string' && fr !== '') choice.finish_reason = fr
    }
  }

  choice.message.content = content
  if (reasoning !== '') choice.message.reasoning_content = reasoning
  if (toolCalls.length > 0) choice.message.tool_calls = toolCalls
  // ⚠️ 流里没给 finish_reason 时**不能编造** —— 但也不能留 null 让客户端困惑。
  // 有 tool_calls 说明是工具调用，否则按正常结束。
  if (choice.finish_reason === null) {
    choice.finish_reason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
  }
  if (result.id === '') result.id = `chatcmpl-${Math.random().toString(36).slice(2, 15)}`
  return result
}
