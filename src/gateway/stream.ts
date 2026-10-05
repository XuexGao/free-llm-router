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
  // ⚠️ **净化用字符串替换，不用 JSON 往返**（实测的性能铁律，见下）。
  //
  // ## 为什么不能用 `JSON.parse` + `JSON.stringify`
  //
  // 第一版就是那么写的。实测（`deep-model` 长思考 8000 帧）：
  // **JSON 往返 26.7ms**，而 **Free 计划只有 10ms/次调用** ⇒ Worker 被终止
  // ⇒ 用户看到「思考超过 40 秒突然停止、没有任何输出」。
  //
  // 改用**单次正则替换**后同场景只要 **6.01ms**（快 4.4 倍），且**语义等价**。
  //
  // ## ⚠️ 字面量替换是安全的（已验证）
  //
  // 担心「正文里正好含 `"reasoning_content":""` 这段文字」？
  // JSON 会把字符串内的引号转义成 `\"`，故**键位置的引号不会出现在字符串值里**：
  // ```js
  // {"content":"说 \"reasoning_content\":\"\" 是啥"}   ← 不匹配
  // ```
  // 已用 4 组边角用例验证（空值在前 / 只有空值 / 正文含伪文本 / 原序）都产出合法 JSON。
  //
  // ⚠️ 删除时**必须同时处理「前面有逗号」与「后面有逗号」**两种位置，
  // 否则第一个字段或最后一个字段会留下多余逗号 → 非法 JSON。
  // 只有 `finish_reason` 是**替换**（`""` → `null`）而不是删除。
  if (!needsNormalize(rawData)) {
    return `data: ${rawData}\n\n`
  }
  return `data: ${dropEmptyFields(rawData)}\n\n`
}

/**
 * 用**字符串替换**删除帧里的非规范空值字段（不解析 JSON）。
 *
 * 覆盖字段与位置：
 * - `reasoning_content` / `refusal` / `function_call` / `tool_calls` / `extra_fields`
 *   的空值 —— **删除**（前有逗号 或 后有逗号 两种位置都处理）；
 * - `finish_reason: ""` —— **替换**成 `null`（不能删，客户端依赖它）。
 *
 * ⚠️ 工具片段里的 `"name":""` 由 `needsNormalize` 捕获，但**这里不删** ——
 * 它嵌在 `tool_calls` 数组的对象里，字符串替换无法安全定位
 *（同名键可能在别处出现）。那条路径仍走 `normalizeFrame` 的对象层净化。
 */
export function dropEmptyFields(rawData: string): string {
  // ⚠️ **两条正则 + 循环收敛**，而不是一条正则一次替换。
  //
  // ## 为什么不能「一条正则一次替换」（实测踩到两次）
  //
  // ### 坑一：逗号被吃掉，后面的字段失去锚点
  //
  // 若一条正则同时匹配「前置逗号」与「后置逗号」两种形态，
  // 删 `"refusal":"",`（后置逗号形态）时会把逗号一起吃掉 ——
  // 而那个逗号本来是**后面字段的前置锚点**：
  //
  // ```
  // {"content":"a","refusal":"","extra_fields":null}
  //                  ↑ 删掉含逗号 ⇒ {"content":"a""extra_fields":null}   ← 非法 JSON
  // ```
  //
  // ### 坑二：收敛循环也救不了（残留形态无锚点）
  //
  // 上一步残留的 `"extra_fields":null` 前面**既无逗号、也无前导引号**，
  // 任何「含逗号」的分支都匹配不到 ⇒ 循环空转、脏字段留在帧里。
  //
  // ## 正确写法：**先删后置逗号，再删前置逗号**
  //
  // `EMPTY_FIELD_TRAILING` 只匹配 `"x":val,`（保留前面的逗号不动），
  // 于是下一轮 `EMPTY_FIELD_LEADING` 一定还找得到 `,"x":val` 的前置逗号。
  // 两个方向交替执行，**必然收敛**（每轮至少删一个字段，字段数有限）。
  let out = rawData
  let prev = ''
  while (out !== prev) {
    prev = out
    out = out.replace(EMPTY_FIELD_TRAILING, '').replace(EMPTY_FIELD_LEADING, '')
  }
  // `finish_reason` 是**替换**而不是删除：客户端靠它判断流结束，
  // 删掉会让客户端以为「字段缺失」，而规范要求是 `null`。
  out = out.replace('"finish_reason":""', '"finish_reason":null')

  // ⚠️ **工具片段里的空 `name` / `arguments`**（单独处理，因为字段名不同）。
  //
  // 上游流式工具调用的真实形状（实测抓取）：
  // ```jsonc
  // // 首帧：id / type / name 齐全
  // {"id":"call_00_bkAcI…","type":"function",
  //  "function":{"name":"get_weather","arguments":""},"index":0}
  // // 后续帧：name 是**空串**，只有 arguments 在增量
  // {"function":{"name":"","arguments":"{"},"index":0}
  // ```
  //
  // OpenAI 规范要求后续片段**省略** `name`。严格客户端（ZCode 这类 agent 工具）
  // 在累加片段时若用**赋值**（`call.function.name = frag.function.name`）而不是
  // 「非空才覆盖」，工具名会被空串**覆盖掉** → 调用失败，报错完全不指向真正原因。
  //
  // ⚠️ 这两个键只出现在 `tool_calls[].function` 里（OpenAI 帧没有 `delta.name`），
  // 故可以安全地按字面量处理。仍用「前置/后置逗号 + `(?=})`」三种位置，
  // 且**循环收敛**（与上面的字段同理）。
  let toolPrev = ''
  while (out !== toolPrev) {
    toolPrev = out
    out = out
      .replace(EMPTY_TOOL_FIELD_TRAILING, '')
      .replace(EMPTY_TOOL_FIELD_LEADING, '')
  }
  return out
}

/** 工具片段里**值为空串**的字段名（删掉而非保留空串）。 */
const EMPTY_TOOL_FIELD_NAME = '(?:name|arguments)'

/** 工具片段：`"x":"",` —— **后置**逗号。 */
const EMPTY_TOOL_FIELD_TRAILING = new RegExp(`"${EMPTY_TOOL_FIELD_NAME}":"",`, 'g')

/** 工具片段：`,"x":""`（含后跟 `}` 的形态）—— **前置**逗号。 */
const EMPTY_TOOL_FIELD_LEADING = new RegExp(
  `,"${EMPTY_TOOL_FIELD_NAME}":""|,"${EMPTY_TOOL_FIELD_NAME}":""(?=\\})`,
  'g',
)

/** 非规范空值字段名（这些字段在值为空时必须整段删除）。 */
const EMPTY_FIELD_NAME = '(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)'

/** 形态 A：`"x":val,` —— **后置**逗号（保留前面的逗号给下一轮用）。 */
const EMPTY_FIELD_TRAILING = new RegExp(`"${EMPTY_FIELD_NAME}":(?:""|null|\[\]),`, 'g')

/** 形态 B：`,"x":val` —— **前置**逗号。
 *
 * ⚠️ 第二个分支 `(?=})` 是必需的：字段是**最后一个**成员时，
 * 删掉「逗号 + 字段 + 值」后 `}` 紧跟上来，下一轮的字段就失去了逗号锚点。
 * 实测踩到（`"tool_calls":[]` 恰好排在对象最末时残留成
 * `{"content":"a""tool_calls":[]}` —— **非法 JSON**）。
 *
 * `(?=})` 是**前瞻**（不消费 `}`），故 `}` 保留原位，结构完整。
 */
const EMPTY_FIELD_LEADING = new RegExp(
  `,"${EMPTY_FIELD_NAME}":(?:""|null|\\[\\])|,"${EMPTY_FIELD_NAME}":(?:""|null|\\[\\])(?=\\})`,
  'g',
)

/**
 * 这一帧**是否需要净化**（含非规范空值）。
 *
 * ⚠️ 判据必须**只匹配「空值」形态**，而且必须用**一条正则**。
 *
 * ## 这是实测出来的性能铁律（我第一版写错了，造成线上故障）
 *
 * ### 错误一：判据太宽 —— 见到键名就解析
 *
 * 第一版写 `rawData.includes('"reasoning_content"')`。但真实思考帧是
 * ```json
 * {"delta":{"content":"","reasoning_content":"The"}}   // ← 有真实内容
 * ```
 * 它**根本不需要净化**，却照样付了 `JSON.parse` + `JSON.stringify`。
 * 实测后果：`deep-model` 长思考 **8000 帧** ⇒ 每帧 JSON 往返合计
 * **26.7ms CPU**，而 **Free 计划只有 10ms/次调用** ⇒ Worker 被强制终止
 * ⇒ 用户看到「思考超过 40 秒突然停止、没有任何输出」。
 *
 * ### 错误二：用 N 次 `includes` 拼判据 —— 仍然超预算
 *
 * 改成只匹配空值后，若写成 7 次 `String.includes`，实测 **19.05ms** ——
 * 依然超 10ms（`includes` 每次都要从头扫描整个字符串）。
 *
 * ### 正确写法：一条正则
 *
 * 同一条请求下实测：**2.41ms**（比 7 次 includes 快近 8 倍）。
 * 正则在引擎里是单次扫描，而多个 `includes` 是多次全串扫描。
 *
 * ## ⚠️ 字面量匹配是安全的
 *
 * JSON 会把字符串内的引号转义成 `\"`，故键位置的引号**不会**出现在字符串值里
 * （已用「正文含伪文本」用例验证）。
 *
 * ⚠️ `finish_reason` 只匹配**空串**：`null` 是规范的合法值（思考期间就是它），
 * 若把 `null` 也算进来，等于每帧都解析 —— 又是同一个陷阱。
 */
export function needsNormalize(rawData: string): boolean {
  return EMPTY_VALUE_PATTERN.test(rawData)
}

/**
 * 匹配帧里的**非规范空值**（紧凑序列化后的逐字形态），用于**判定**是否需要净化。
 *
 * ⚠️ 与 `EMPTY_FIELD_TRAILING` / `EMPTY_FIELD_LEADING` 的分工：
 * 这一条只管「有没有」，**不做替换**（替换由那两条负责，它们要处理逗号位置）。
 */
const EMPTY_VALUE_PATTERN = /"(?:reasoning_content|refusal|finish_reason|name)":""|"(?:function_call|extra_fields)":null|"tool_calls":\[\]/

/**
 * 这一帧**可能含错误**吗（廉价预检，命中才做 `JSON.parse`）。
 *
 * ⚠️ 用**一条**正则而不是 4 次 `String.includes` —— 与 `EMPTY_VALUE_PATTERN`
 * 同理：多个 `includes` 是多次全串扫描。实测 6521 帧下
 * **13.36ms → 4.98ms**（Free 计划只有 10ms CPU，这个差别是决定性的）。
 */
export const ERROR_HINT_PATTERN = /"error"|"statusCodeValue"|"stackTrace"|"code"/

/**
 * 这一帧**真的带 usage 数据**吗（廉价预检）。
 *
 * ## 🔴 这是原实现的真实缺陷（实测定位，不是新引入的）
 *
 * 原判据是 `frame.data.includes('"usage"')`。但上游**每一帧**都带 `"usage":null`：
 *
 * ```json
 * {"choices":[…],"usage":null}          ← 思考期间每一帧都是这个形状
 * {"choices":[…],"usage":{…, "prompt_tokens":33, …}}   ← 只有末帧才有真数据
 * ```
 *
 * 于是 `includes('"usage"')` **每帧都命中** ⇒ **每帧都 `JSON.parse` 整个帧**。
 *
 * 实测（`deep-model` 长思考 6521 帧）：**18.32ms CPU**，
 * 而 **Free 计划只有 10ms/次调用** ⇒ Worker 被强制终止
 * ⇒ 用户看到「思考一段时间后**突然停止、没有任何输出**」。
 *
 * ⚠️ 修法是**收紧到「usage 是对象」**：`"usage":{`。
 * 实测同场景降到 **3.93ms**（快 4.7 倍），且**语义完全不变**
 *（`usage:null` 本来就没有可解析的数据）。
 *
 * 教训：**判据不能比它要保护的工作还贵**。`null` 与真实对象必须区分开 ——
 * 「字段存在」和「字段有内容」是两件事，这正是本文件反复出现的同一类错误。
 */
export const USAGE_HINT_PATTERN = /"usage":\{/


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
