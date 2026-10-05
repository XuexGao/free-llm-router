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
  // ⚠️ 单帧版本（无状态）：每帧都判断 + 净化。
  //
  // ## 🔴 为什么生产路径**不用**这个函数（实测的性能铁律）
  //
  // 8000 帧 / 10ms 配额 ⇒ **每帧只有 1.25 微秒**。而实测每帧的代价：
  //
  // | 做法 | 8000 帧的 CPU |
  // |---|---|
  // | JSON 往返 | 26.7ms |
  // | 单次正则判断（`needsNormalize`） | 7.4ms |
  // | 单次 `String.includes` | 7.4ms |
  // | 正则替换 | 35.7ms |
  //
  // ⇒ **任何「每帧扫描整帧字符串」的做法都超预算**，长回答必被切断
  //（用户报「思考 78 秒又断了」）。
  //
  // 根因是量级：一条 20 分钟的生成会有 **2 万帧**，逐帧开销乘上去必然爆。
  //
  // ✅ **生产路径用 {@link createFrameTranslator}**：首帧判断**一次**，
  // 之后全程沿用同一决定（不再逐帧扫描），实测同场景降到 **5.2ms**。
  //
  // ⚠️ 本函数保留给**单帧场景**（测试、非流式聚合），语义与有状态版一致。
  return createFrameTranslator().translate(rawData)
}

/**
 * 创建一个**有状态**的帧转换器（生产路径用它）。
 *
 * ## 🔴 为什么要「首帧决定一次」（实测的性能铁律）
 *
 * 逐帧扫描整帧字符串**必然超预算**：8000 帧时单次 `includes` 就要 **7.4ms**，
 * 而 Free 计划只有 **10ms/次调用**；长回答有 **2 万帧**时更不可能。
 *
 * ⇒ 改成**首帧判断一次**，此后同一流的所有帧沿用该决定：
 * 需要净化就一路净化（不再判断），不需要就一路原样透传。
 * 实测同场景 **35.7ms → 5.2ms**。
 *
 * ## 为什么「首帧」可以代表整个流
 *
 * 实测：需要净化的**只有腾讯那两家**（`buddy` / `workbuddy`）——
 * 它们的**首帧**就带 `reasoning_content:""` 等空值标记，且**整条流都有**。
 * 而 cline / raccoon / qoder 等供应商的帧本来就干净，从不出现空值字段。
 * ⇒ 首帧的形态足以判定整条流，不会漏。
 *
 * ⚠️ 这也覆盖工具调用：buddy 的工具帧与普通帧来自同一个上游，
 * 首帧判为「需净化」后，后续的工具帧（空 `name`）同样会被净化。
 */
export function createFrameTranslator(): { translate: (rawData: string) => string } {
  // `undefined` = 还没遇到首帧；`true`/`false` = 已决定整条流的策略。
  let normalize: boolean | undefined
  // 首帧**学到的**空值字面量（见 `learnEmptyRun`）：后续帧用它做定点替换，快 5 倍。
  let learned: string | undefined

  return {
    translate(rawData: string): string {
      if (normalize === undefined) {
        // ⚠️ **整个流只做这一次判断 + 一次学习**（见上方说明）。
        normalize = needsNormalize(rawData)
        if (normalize) learned = learnEmptyRun(rawData)
      }
      if (!normalize) return `data: ${rawData}\n\n`
      return `data: ${dropEmptyFields(rawData, learned)}\n\n`
    },
  }
}

/**
 * 从**首帧**提取「连续空值段」的字面量，供后续帧定点替换。
 *
 * ## 为什么值得这么做（实测）
 *
 * 通用正则（按字段粒度 + 交替分支）在 20000 帧下要 **51ms**，而
 * **Free 计划只有 10ms/次调用**。改用「首帧学到的字面量 + `replaceAll`」
 * 后同场景 **9.8ms**（快 5 倍）。
 *
 * ## 为什么首帧的字面量对整条流成立
 *
 * 实测同一流里空值字段的**集合是稳定的** —— 只有这几种组合：
 * `(reasoning_content, function_call, refusal, tool_calls, extra_fields)`、
 * 少一个 `extra_fields`、只有前两个、只有一个……
 * 它们在**同一帧里总是连续**，故首帧提取的连续段对后续帧同样成立。
 *
 * ⚠️ **匹配失败时返回 `undefined`**，`dropEmptyFields` 会回落到通用正则
 * （慢但正确）—— 绝不因为「学不到」就漏净化。
 */
export function learnEmptyRun(rawData: string): string | undefined {
  // 从第一个空值字段开始，贪心吃到最后一个空值字段结束。
  const m = /,"(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)":(?:"",|null,|\[\],)/.exec(rawData)
  if (m === null) return undefined
  const rest = rawData.slice(m.index + m[0].length)
  // 继续吃**紧接着**的空值字段（连续段的其余部分）
  let total = m[0]
  let tail = rest
  for (;;) {
    const n = /^"(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)":(?:"",|null,|\[\],)/.exec(tail)
    if (n === null) break
    total += n[0]
    tail = tail.slice(n[0].length)
  }
  // 去掉末尾多余的逗号（保留给下一个非空字段）
  return total.endsWith(',') ? total.slice(0, -1) : total
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
export function dropEmptyFields(rawData: string, learned?: string): string {
  // ⚠️ **这条路径目前是「休眠」的** —— 实测上游已不再发这些空值字段
  //（44 万帧抓取里只有 31 帧含空值，全部来自 2026-10-05 上午，
  // 之后**再没出现过**）。故这里优先保证**正确**，性能只要不退化成
  // 二次方即可：真触发时说明上游又改了形状，届时按实测重做优化。
  //
  // ## 历史教训（不要再犯）
  //
  // 我为这条路径连续优化了三轮（JSON 往返 → 正则 → 循环收敛 → 字面量），
  // 每轮都以为找到了「长回答被切断」的根因，**但都没命中** ——
  // 因为这条路径对用户的实际场景**根本不触发**。
  // **正确顺序是：先确认路径会不会走到，再决定要不要优化它。**
  //
  // ## 为什么不能假设「空值段长度固定」
  //
  // 实测真实帧里的空值段长度是**变化的**：
  // ```
  // (reasoning_content, function_call, refusal, tool_calls, extra_fields)  ← 5 个
  // (reasoning_content, function_call, refusal, tool_calls)                 ← 4 个
  // (reasoning_content, function_call)                                      ← 2 个
  // (reasoning_content)                                                     ← 1 个
  // ```
  // ⇒ 任何「整段字面量」替换都会**漏帧**。必须按**字段粒度**处理。
  //
  // ## 实现：一次 `replace`（单次 `g` 扫描），不做循环
  //
  // 正则的交替分支同时覆盖「前置逗号」与「后置逗号」，删除时**只吃一侧逗号** ——
  // 相邻字段各吃自己那侧，故**不会产生新的相邻空值**，一次扫描即收敛。
  // 循环（第一版写法）会在每轮重新扫描整帧，帧数一多就是**二次方**开销。
  let out = rawData

  // ① 首帧学到的字面量（若有）：定点替换，比通用正则快。
  // ⚠️ 学不到就跳过，由 ② 兜底 —— **绝不因为「学不到」而漏净化**。
  if (learned !== undefined && learned !== '') out = out.replaceAll(learned, '')

  // ② 通用兜底：按字段粒度删（覆盖学到的字面量没匹配上的帧，如形状中途变化）。
  out = out.replace(EMPTY_FIELD_PATTERN, '')
  // ③ 工具片段里的空 `name` / `arguments`（字段名不同）。
  out = out.replace(EMPTY_TOOL_FIELD_PATTERN, '')
  // ④ `finish_reason` 是**替换**而不是删除：客户端靠它判断流结束。
  return out.replace('"finish_reason":""', '"finish_reason":null')
}
/**
 * 匹配**一个**非规范空值字段 + 它的一个相邻逗号（前置**或**后置）。
 *
 * ⚠️ 必须按**字段粒度**（不能假设空值段长度固定，见 `dropEmptyFields` 的说明）。
 * ⚠️ 只吃**一侧**逗号：相邻字段各吃自己那侧，故一次扫描即可收敛。
 *    `(?=})` 分支覆盖「字段是对象最后一个成员」的情况。
 */
const EMPTY_FIELD_PATTERN = new RegExp(
  ',"(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)":(?:""|null|\\[\\])'
  + '|"(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)":(?:""|null|\\[\\]),'
  + '|,"(?:reasoning_content|refusal|function_call|tool_calls|extra_fields)":(?:""|null|\\[\\])(?=\\})',
  'g',
)

/**
 * 工具片段里的空 `name` / `arguments` + 一个相邻逗号。
 *
 * ⚠️ 与上面的区别只是**字段名不同**（`name` / `arguments` 只在
 * `tool_calls[].function` 里出现，OpenAI 帧没有 `delta.name`）。
 */
const EMPTY_TOOL_FIELD_PATTERN = new RegExp(
  '"(?:name|arguments)":"",|,"(?:name|arguments)":""|,"(?:name|arguments)":""(?=\\})',
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
 * ⚠️ 这一条只管「有没有」（判定用），**不做替换** ——
 * 替换由 `EMPTY_FIELD_PATTERN` / `EMPTY_TOOL_FIELD_PATTERN` 负责。
 */
const EMPTY_VALUE_PATTERN = /"(?:reasoning_content|refusal|finish_reason|name)":""|"(?:function_call|extra_fields)":null|"tool_calls":\[\]/

/**
 * 这一帧**可能含错误**吗（廉价预检，命中才做 `JSON.parse`）。
 *
 * ## 🔴 为什么单独抽成「只在前几帧检查」的形态（实测的性能铁律）
 *
 * 8000 帧 / 10ms 配额 ⇒ **每帧只有 1.25 微秒**。实测 2 万帧下：
 *
 * | 判据 | CPU |
 * |---|---|
 * | 4 分支交替正则 | **9.6ms** |
 * | 单次 `includes('"error"')` | **9.2ms** |
 * | 单次 `includes('"code"')` | **20ms** |
 *
 * ⇒ **任何每帧全串扫描都超预算**。而错误帧的语义决定了它**不需要每帧查**：
 * 上游要拒绝请求，必然在**流的开头**就拒绝（首帧或前几帧），
 * 绝不可能先正常输出几万字再突然说「你的请求非法」。
 *
 * 故仅在**前 {@link ERROR_CHECK_FRAMES} 帧**做这个检查 —— 之后完全不查。
 * 这是「用语义换 CPU」：正确性不降，成本归零。
 */
export const ERROR_HINT_PATTERN = /"error"|"statusCodeValue"|"stackTrace"|"code"/

/**
 * 只在前多少帧做**错误帧**检查（见 `ERROR_HINT_PATTERN` 的说明）。
 *
 * 5 帧足够：上游拒绝必然发生在开头。放宽到 5 而不是 1，
 * 是为了容忍「首帧是 role 帧、错误在第 2 帧」这种形态。
 */
export const ERROR_CHECK_FRAMES = 5

/**
 * 这一帧**真的带 usage 数据**吗（O(1) 尾判，不做全串扫描）。
 *
 * ## 🔴 这是原实现的真实缺陷（实测定位）
 *
 * 原判据 `includes('"usage"')` **每帧都命中** —— 因为上游**每一帧**都带
 * `"usage":null`，只有末帧才是真对象：
 *
 * ```json
 * {"choices":[…],"usage":null}                       ← 每帧都是这个形状
 * {"choices":[…],"usage":{…,"prompt_tokens":33,…}}   ← 只有末帧有真数据
 * ```
 *
 * 于是每帧都 `JSON.parse` 整个帧 ⇒ 实测 6521 帧 **18.32ms CPU** ⇒ 超 10ms ⇒ 流被切断。
 *
 * 改成 `"usage":{` 后降到 3.93ms；但 2 万帧时**仍要 8.1ms**（还是全串扫描）。
 *
 * ## 最终方案：判**尾部**
 *
 * 实测该上游的帧**必然以 `"usage":null}` 结尾**（紧凑序列化、usage 是最后一个键）：
 * - 普通帧 `…,"usage":null}`
 * - 末帧   `…,"usage":{…}}`（结尾是两层 `}`）
 *
 * 故用 `endsWith` 做 **O(1)** 判断：**尾串不是 `"usage":null}` 才需要解析**。
 * 实测 8.1ms → **2.2ms**。
 *
 * ⚠️ **判错方向是安全的**：若某天上游改了字段顺序（不再是 usage 结尾），
 * 这个判据会对**所有帧**都返回「需要解析」——
 * 即**退化成原来的行为**（能拿到 usage，只是慢），**不会丢数据**。
 * 这是刻意选的失败方向：「宁慢不丢」。
 *
 * ⚠️ 注意 usage 帧的结尾是 `}}` 而不是 `"usage":null}`，故判据写成
 * 「**不以 `"usage":null}` 结尾** ⇒ 可能是真 usage」。
 */
export function mayHaveUsage(rawData: string): boolean {
  return !rawData.endsWith('"usage":null}')
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
