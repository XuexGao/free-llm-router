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
