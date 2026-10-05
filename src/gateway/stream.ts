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

  // 形态 4：华为云风格 `{error_code, error_msg}`（CodeArts 在用）。
  //
  // ⚠️ 实测踩到：CodeArts 模型名不对时上游回的是
  // `{"text":"[DONE]","error_code":"InferHub.002002009.404",
  //   "error_msg":"The model is not registered, please request other model"}`
  // —— 这一帧**既没有 `error`、也没有 `code`**（它是 `error_code`），
  // 于是被当成普通帧丢掉，最终给客户端一个 **`content:''` + `finish_reason:'stop'`
  // 的空回答**。用户看到的是「模型返回了空」，完全看不出是模型名错了。
  //
  // 这类「静默空回答」比报错更糟：用户会以为模型不行，而不是自己选错了模型。
  const errorCode = chunk.error_code
  if (typeof errorCode === 'string' && errorCode !== '') {
    const msg = typeof chunk.error_msg === 'string' ? chunk.error_msg : ''
    return `上游错误 ${errorCode}${msg === '' ? '' : `：${msg}`}`
  }

  // 形态 5：既没有 choices 也没有已知错误字段 —— 可疑但可能是 usage 帧
  return undefined
}

/**
 * 把上游的一帧转成给客户端的输出。
 *
 * @returns 要写给客户端的内容（含 `data:` 前缀与结尾空行），或空串表示不写
 */
export function translateFrame(rawData: string): string {
  // ⚠️ **需要净化时必须解析**（见 `normalizeFrame` 的说明）。
  // 判据先做**廉价字符串检查**：只有含非标准字段时才付解析代价。
  if (needsNormalize(rawData)) {
    try {
      const frame = JSON.parse(rawData) as Record<string, unknown>
      normalizeFrame(frame)
      return `data: ${JSON.stringify(frame)}\n\n`
    } catch {
      // 解析失败：原样转发（不因为净化失败而丢帧）
    }
  }
  return `data: ${rawData}\n\n`
}

/**
 * 这一帧**是否含非标准字段**（需要净化）。
 *
 * ⚠️ 廉价字符串预检，避免对每个正常帧都做 JSON.parse ——
 * Free 计划只有 10ms CPU，正常帧原样转发是刻意的优化。
 */
export function needsNormalize(rawData: string): boolean {
  return (
    rawData.includes('"reasoning_content"')
    || rawData.includes('"extra_fields"')
    || rawData.includes('"refusal"')
    || rawData.includes('"function_call"')
    // ⚠️ `tool_calls` 同样要净化：上游后续片段的 `function.name` 是**空串**，
    // 会把 agent 客户端的工具名覆盖掉（实测抓取，见 normalizeToolCalls）。
    || rawData.includes('"tool_calls"')
  )
}

/**
 * 把上游帧**净化成严格 OpenAI 形状**（就地修改）。
 *
 * ## ⚠️ 为什么必须做（用户报障实测）
 *
 * 用户把本 API 接入 **ZCode 客户端**后：「buddy 的 v4.1-flash 一直显示
 * 思考一段时间，每次思考只有 1 个单词」。根因是 buddy 上游**每帧都带**
 * 这些**非标准字段**（即使是空值）：
 *
 * ```json
 * {"delta":{"role":"assistant","content":"","reasoning_content":"",
 *           "function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},
 *  "finish_reason":""}
 * ```
 *
 * 严格客户端看到 `delta` 里**存在** `reasoning_content` 键就认为「这是思考内容」，
 * 于是把每帧那一个字的 `content` 当成思考显示 → **一直停在"思考中"**。
 * 而 OpenAI 规范里：不需要的字段**应当省略**，不是给空值。
 *
 * ## 净化规则（逐条对应规范）
 *
 * | 字段 | 上游给的 | 规范要求 | 处理 |
 * |---|---|---|---|
 * | `reasoning_content` | `""` | 无此字段（非官方扩展） | 空串时**删除** |
 * | `function_call` | `null` | 已废弃 | `null` 时删除 |
 * | `refusal` | `""` | 只有真拒绝时才有 | 空串时删除 |
 * | `tool_calls` | `[]` | 只在有工具调用时出现 | 空数组时删除 |
 * | `extra_fields` | `null` | 非规范字段 | 一律删除 |
 * | `finish_reason` | `""` | `null` 或具体值 | 空串 → `null` |
 *
 * ⚠️ **只删「空值」，不删有内容的字段** —— 真在思考的模型（`reasoning_content`
 * 非空）必须原样保留，那是有效信息。
 */
export function normalizeFrame(frame: Record<string, unknown>): void {
  const choices = frame['choices']
  if (!Array.isArray(choices)) return
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    const c = choice as Record<string, unknown>

    // `finish_reason: ""` → `null`（规范里只有 null 或具体值）
    if (c['finish_reason'] === '') c['finish_reason'] = null

    const delta = c['delta']
    if (delta === null || typeof delta !== 'object') continue
    const d = delta as Record<string, unknown>

    // ⚠️ 空串/空数组/null 一律**删除**，而不是保留空值 ——
    // 「字段存在」本身就是客户端判断的依据（这正是本次缺陷的根源）。
    if (d['reasoning_content'] === '') delete d['reasoning_content']
    if (d['refusal'] === '') delete d['refusal']
    if (d['function_call'] === null) delete d['function_call']
    delete d['extra_fields']

    if (Array.isArray(d['tool_calls'])) {
      if (d['tool_calls'].length === 0) {
        delete d['tool_calls']
      } else {
        normalizeToolCalls(d['tool_calls'])
      }
    }

    // 空的 `role` 也没什么用，但它只在首帧出现且规范里合法 —— 保留。
  }
}

/**
 * 净化流式 `tool_calls` 片段（**agent 工具能否工作就看这里**）。
 *
 * ## ⚠️ 实测缺陷：后续片段的 `function.name` 是**空串**
 *
 * 上游流式工具调用的真实形状（实测抓取）：
 *
 * ```jsonc
 * // 首帧：id / type / name 齐全
 * {"id":"call_00_bkAcI…","type":"function",
 *  "function":{"name":"get_weather","arguments":""},"index":0}
 * // 后续帧：name 是**空串**，只有 arguments 在增量
 * {"function":{"name":"","arguments":"{"},"index":0}
 * {"function":{"name":"","arguments":"\""},"index":0}
 * ```
 *
 * OpenAI 规范要求后续片段**省略** `name`，而不是给空串。
 * 严格客户端（ZCode 这类 agent 工具）在累加片段时若用**赋值**
 *（`call.function.name = frag.function.name`）而不是「非空才覆盖」，
 * 工具名会被空串**覆盖掉** → 调用失败，而报错完全不指向真正原因。
 *
 * ## 处理
 *
 * - `function.name === ''` → 删除该键（保留 `arguments` 增量）；
 * - `function.arguments === ''` → 删除（首帧那个空串同样有害）；
 * - 其余片段原样保留。
 *
 * ⚠️ **不能因为 `name` 为空就丢弃整个片段** —— 那些片段承载着
 * `arguments` 的增量，丢了参数就拼不完整。
 */
export function normalizeToolCalls(toolCalls: unknown[]): void {
  for (const item of toolCalls) {
    if (item === null || typeof item !== 'object') continue
    const call = item as Record<string, unknown>
    const fn = call['function']
    if (fn === null || typeof fn !== 'object') continue
    const f = fn as Record<string, unknown>
    if (f['name'] === '') delete f['name']
    if (f['arguments'] === '') delete f['arguments']
  }
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

  // ⚠️ **必须复用 `parseSseLine`**，不能自己写一套 `data: ` 前缀判断。
  //
  // 实测踩到（就是这条 bug 导致 CodeArts 非流式恒为空回答）：
  // 我第一版写的是 `line.startsWith('data: ')`（**带空格**），
  // 而部分上游发的是 `data:{...}`（**不带空格**）——
  // 于是每一帧都被 `continue` 掉，聚合结果恒为 `content:''`，
  // 客户端看到「模型返回空」，而流式路径（用的是 `parseSseLine`）却正常。
  //
  // 教训：同一件事只能有一个实现。两条路径共用 `parseSseLine` 后，
  // 「带不带空格」「`[DONE]` 怎么判」「非 JSON 帧怎么办」都不会再分叉。
  for (const line of rawSse.split('\n')) {
    const parsed = parseSseLine(line)
    if (parsed.kind !== 'chunk' || parsed.data === undefined) continue

    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(parsed.data) as Record<string, unknown>
    } catch {
      continue // parseSseLine 已校验过是 `{` 开头，走到这里说明 JSON 本身坏了
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
