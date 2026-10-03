/**
 * Qoder wasm-bindgen 桥（**Workers 版**）。
 *
 * ## 与参考项目的唯一差异：WASM 字节从哪来
 *
 * `deepseek-harness-codearts/src/qoder-wasm.ts:38,43` 用
 * `readFileSync` + `fileURLToPath` 从磁盘读 298KB 的
 * `qoder-auth-wasm.wasm`。Workers **没有可跨请求持久化的文件系统**
 * （`AGENTS.md §2.5` 第 3 条），这条路径必然不可用。
 *
 * ✅ 已验证的替代方案：**把 `.wasm` 当模块 import**。
 * wrangler 有**内置默认规则**
 * （`node_modules/wrangler/wrangler-dist/cli.js:150957`：
 * `{ type: "CompiledWasm", globs: ["*" + "*" + "/*.wasm", ...] }`（wrangler 内建默认规则，无需手动配置），
 * 故**无需**在 `wrangler.jsonc` 里加 `rules` —— `import mod from './x.wasm'`
 * 会直接得到 `WebAssembly.Module`。实测：
 * - `wrangler deploy --dry-run` 产物 292.00 KiB / gzip 131.05 KiB（打包成功）；
 * - 把同一步骤产出的字节喂给本文件的 glue，`generate_runtime_auth_fields`
 *   与 `prepareInfer` 都正常返回（`authFields keyLen = 172`、
 *   `prepareInferRequest` 的 URL 与 20 个签名头齐全）。
 *
 * 代价与边界：
 * - **WASM 是模块级单例**，`WebAssembly.Module` 在 isolate 之间各自编译一次
 *   （Workers 的模块实例可跨请求复用，编译有缓存，不是每请求 298KB 解析）；
 * - Workers 的 **1MB 脚本体积上限**（免费版，gzip 后）。298KB 未压缩、
 *   gzip 后约 131KB 的 WASM 加上本项目其余代码后仍然安全，
 *   但**再加第二份大 WASM 就会顶到上限** —— 故这里**不**内置任何兜底表以外的
 *   二进制产物。
 *
 * ## ⚠️ 三条来自参考实现的实测坑（改了会得到 Rust panic）
 *
 * 1. **两个 `getRandomValues` import 的签名方向相反**：
 *    `_d49329ff89a07af1` 写 **wasm 内存**、`_c44a50d8cfdaebeb` 调 **JS 对象**。
 * 2. **返回值布局有两套**：字符串类为 `ptr/len/valIdx/isErr`，
 *    而 `qodercontext_new` / `prepareInferRequest` 为 `ptr/errIdx/isErr`。
 * 3. **`requestresult_url(栈指针, ptr)` 参数顺序与直觉相反**（栈指针在前）。
 *
 * 以上三条的出处：`deepseek-harness-codearts/src/qoder-wasm.ts:28-37`。
 *
 * ## ⚠️ 不是「破解密码学」
 *
 * WASM 同时导出了成对的编解码函数（`decrypt_server_response` /
 * `model_cache_decrypt` / `profileencryptor_*`）。我们**直接调用它**，
 * 不逆向其算法 —— 等同「用客户端自己的钥匙开自己的锁」。
 * 依据：同文件 `:22-26`。
 */

import wasmModule from './qoder-auth-wasm.wasm'

/**
 * `CompiledWasm` 规则给出的产物就是 `WebAssembly.Module`。
 *
 * ⚠️ 这里用**类型断言**而不是 `declare module '*.wasm'`：
 * `@cloudflare/workers-types` 未提供该声明（已 grep 确认），
 * 而 `text-modules.d.ts` 只声明了本项目用到的 Text 模块。
 * 断言比全局声明更窄 —— 后者会让**任何** `.wasm` import 通过类型检查，
 * 包括那些忘了配规则的场景。
 */
const WASM_MODULE = wasmModule as unknown as WebAssembly.Module

/**
 * 归一化 wasm 产物（**两种打包器给的东西不一样**）。
 *
 * | 打包器 | `import` 得到 |
 * |---|---|
 * | wrangler（`CompiledWasm` 规则） | 已编译的 `WebAssembly.Module` |
 * | esbuild（单测用的 `--loader:.wasm=copy`） | ESM 包装对象，需从字节编译 |
 *
 * ⚠️ 这个差异是**实测踩到的**：单测跑起来报
 * `Cannot find module 'qoder_auth_wasm_bg.js' imported from ...wasm`
 * —— esbuild 把 wasm 当 ESM 模块处理，生成了一份带 JS glue 的包装。
 *
 * 故这里不再假定「拿到的一定是 Module」，而是运行时判别：
 * 是 Module 就直接用，是字节（ArrayBuffer/TypedArray）就编译一次。
 * 单元测试因此不需要为 qoder 开特例，生产路径也不受影响。
 */
async function compileWasm(raw: unknown): Promise<WebAssembly.Module> {
  if (raw instanceof WebAssembly.Module) return raw

  // ⚠️ 用 `WebAssembly.instantiate(bytes, {})` 而不是 `WebAssembly.compile`：
  // 本项目的 tsconfig 是 `lib: ["ES2022"]`（无 DOM），
  // `WebAssembly.compile` 的声明来自 DOM lib，故在此不可见。
  // `instantiate` 有 ES2022 的声明，且**顺带**得到 instance ——
  // 但我们只取 `.module`（真正的实例化在下面按真实 import 表做）。
  /**
   * ⚠️ 统一归一成 `Uint8Array` 而**不是** `ArrayBuffer`：`ArrayBufferView.buffer`
   * 的类型是 `ArrayBufferLike`（含 `SharedArrayBuffer`），而 `BufferSource`
   * 在 workers-types 里**不含** `SharedArrayBuffer` ⇒ 直接传会编译失败。
   * 复制成 `Uint8Array` 既消除了该类型问题，也顺带**切断对打包器缓冲区的别名**
   * （wasm 编译期间若原缓冲被复用，会出现极难排查的偶发失败）。
   */
  const bytes = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : ArrayBuffer.isView(raw)
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice()
      : undefined

  if (bytes !== undefined) {
    /**
     * ⚠️ **`WebAssembly.instantiate` 在两种 tsconfig 下解析到不同的重载**。
     *
     * 本项目是 `lib: ["ES2022"]`（**无 DOM**），`WebAssembly` 的声明来自
     * `@cloudflare/workers-types`；那里只暴露了
     * `instantiate(module: Module, …) => Promise<Instance>` 这一个重载。
     * 而这里传的是**字节**，运行时会走另一个重载并返回
     * `{ module, instance }` —— 故 TS 报 `Property 'module' does not exist
     * on type 'Instance'`（纯粹是声明缺失，不是行为问题）。
     *
     * 修法：**只对「被调用的函数」本身断言签名**，而不是对返回值做
     * `as unknown as { module }` —— 后者会把 `Instance` 类型整个抹掉，
     * 万一将来真传错参数（传了 Module 却取 `.module`）也检查不出来。
     */
    const instantiateFromBytes = WebAssembly.instantiate as unknown as (
      bytes: BufferSource,
      imports: Record<string, unknown>,
    ) => Promise<{ module: WebAssembly.Module; instance: WebAssembly.Instance }>
    const result = await instantiateFromBytes(bytes, {})
    return result.module
  }

  // ⚠️ 不静默降级：拿不到可编译的 wasm 就无法生成签名头，
  // 硬继续只会产出必然 401 的请求。
  throw new Error(
    `qoder: 无法把 wasm 产物编译成 WebAssembly.Module（拿到 ${Object.prototype.toString.call(raw)}）。` +
      '请确认打包器把 .wasm 配成了 CompiledWasm（wrangler 内建规则）或可编译的字节。',
  )
}

/**
 * wasm-bindgen 生成的 import 对象**名**。WASM 里 embed 了这个模块路径，
 * 名字必须完全一致，否则 `instantiate` 会因缺 import 而失败
 * （`deepseek-harness-codearts/src/qoder-wasm.ts:68-72`）。
 */
const IMPORT_MODULE = './qoder_auth_wasm_bg.js'

/** 客户端版本（影响 `Cosy-Version` 与签名载荷）。 */
export const QODER_COSY_VERSION = '1.1.49'

/** `generate_runtime_auth_fields` 的产物。 */
export interface QoderRuntimeAuthFields {
  encrypt_user_info: string
  key: string
}

/** 构造 WASM 上下文所需的用户信息。 */
export interface QoderWasmUserInfo {
  uid: string
  securityOauthToken: string
  organizationId?: string
  organizationTags?: readonly string[]
  dataPolicyAgreed?: boolean
}

/** 客户端元数据（写入 `QoderContext`）。 */
export interface QoderClientMetadata {
  client_type: string
  business_product: string
  business_type: string
  scene: string
}

/** `prepareInferRequest` 的产物。 */
export interface QoderInferRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** assistant 消息携带的一次工具调用（**OpenAI 风格**，不是 Anthropic）。 */
export interface QoderInferToolCall {
  id: string
  type: 'function'
  index?: number
  function: { name: string; arguments: string }
}

/** 下发给模型的工具定义（**OpenAI 风格**：顶层 `tools`）。 */
export interface QoderInferTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** 加密推理请求里的一条消息。 */
export interface QoderInferMessage {
  role: string
  /** 带图片时是**多模态数组**（`{type:'image_url',…}`），否则是字符串。 */
  content: string | ReadonlyArray<Record<string, unknown>>
  tool_calls?: readonly QoderInferToolCall[]
  tool_call_id?: string
}

/** 构造加密推理请求的入参。 */
export interface QoderInferAsk {
  /** 模型**目录 key**（如 `qfmodel`）—— 本端点认的就是 key。 */
  modelKey: string
  userText: string
  systemText?: string
  isReasoning?: boolean
  history?: readonly QoderInferMessage[]
  maxTokens?: number
  reasoningEffort?: string
  source?: string
  isVl?: boolean
  contextWindow?: number
  displayName?: string
  format?: string
  maxInputTokens?: number
  sessionType?: string
  /** **必填**：决定服务端路由（缺了会落到故障节点）。 */
  business?: Record<string, unknown>
  tools?: readonly QoderInferTool[]
}

/**
 * 构造加密端点 `agent_chat_generation` 的**明文请求体**。
 *
 * 抽成纯函数有两个理由（同参考实现 `:230-243`）：
 * 1. **可测**：密文本地不可解（朴素 `JSON.parse` 会抛），
 *    把 payload 构造独立出来才能直接断言 `tools` / `messages` 是否真的下发；
 * 2. **单一来源**：`prepareInfer` 只负责「拿它去加密」，不再内联一份结构。
 *
 * ⚠️ 结构逐项复刻官方 `G4A()`：
 * - `chat_context` **不能传空对象**；
 * - `business` 缺失会被路由到故障节点（实测 `qfmodel` 恒回
 *   `[FAIL]node:... msg:Execution failed`，而同一模型在 IDE 里完全正常）；
 * - `model_config` 有 **10 个字段**（早期只传 6 个）；
 * - `tools` 键**恒存在**（无工具时是空数组，与客户端一致）。
 *
 * 依据：`deepseek-harness-codearts/src/qoder-wasm.ts:244-326` 与
 * `AGENTS.md` 的 Qoder 章节第 2、6 条。
 */
export function buildQoderInferPayload(
  ask: QoderInferAsk,
  requestId: string = crypto.randomUUID(),
): Record<string, unknown> {
  const isReasoning = ask.isReasoning ?? false
  const text = ask.userText

  const parameters: Record<string, unknown> = {}
  if (ask.maxTokens !== undefined) parameters.max_tokens = ask.maxTokens
  if (ask.reasoningEffort !== undefined) {
    parameters.reasoning_effort = ask.reasoningEffort
    // `none` 表示**关闭思考**：官方用 `enable_thinking=false` 表达。
    parameters.enable_thinking = ask.reasoningEffort !== 'none'
  }
  if (ask.contextWindow !== undefined) parameters.context_length = ask.contextWindow

  const messages: QoderInferMessage[] = []
  for (const m of ask.history ?? []) {
    // 逐字段搬运而非整体展开：只保留协议认识的三个键，避免把调用方的
    // 内部字段（如 DSH 的 `id` / `source`）原样发给上游。
    messages.push({
      role: m.role,
      content: m.content,
      ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls }),
      ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
    })
  }
  if (messages.length === 0) messages.push({ role: 'user', content: text })

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: ask.modelKey, is_reasoning: isReasoning },
        originalContent: text,
      },
      chatPrompt: '',
      // ⚠️ **忠实复刻，不是缺陷**：官方 `Hyc()` 就把该字段恒置 `null`。
      // 图片的**正确通道是 `messages[].content` 的多模态数组**，
      // 别再来盯这个字段（AGENTS.md 记过这次排查弯路）。
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: ask.sessionType ?? 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: ask.modelKey,
      display_name: ask.displayName ?? '',
      model: '',
      format: ask.format ?? 'openai',
      is_vl: ask.isVl ?? true,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: ask.source ?? 'system',
      max_input_tokens: ask.maxInputTokens ?? ask.contextWindow ?? 200_000,
    },
    custom_model: null,
    system: ask.systemText ? [{ type: 'text', text: ask.systemText }] : [],
    messages,
    // ⚠️ **必须把调用方的工具定义真的发出去**（顶层 `tools`）。
    // 硬编码 `[]` 会让模型拿不到任何函数 schema，只能用正文里的 XML 文本
    // 臆造工具调用 —— 用户报障「执行任务出现任务调用 xml 泄露任务终止」。
    tools: ask.tools ?? [],
    parameters,
    ...(ask.business === undefined ? {} : { business: ask.business }),
  }
}

/**
 * WASM 实例的 glue 状态（沿用 wasm-bindgen 的变量名约定）。
 *
 * ⚠️ 与参考实现的差异：参考版是模块级 `let gluePromise`，
 * 在 Workers 里这**刚好正确** —— 模块实例跨请求复用（同一 isolate 内），
 * 而 `WebAssembly.Module` 本就是无状态的。**不要**改成按请求新建实例：
 * 那会让每次请求都重新构造 `QoderContext`（含密钥派生），
 * 在 10ms CPU 预算下是纯浪费。
 *
 * ⚠️ 但 `QoderEncryptedInfer` 实例**不是**线程安全的（参考实现 `:595-597`）：
 * 它持有 WASM 里的 `QoderContext` 指针。Workers 的 isolate 在
 * `await` 之间**可能**交错执行同一模块的代码，故**每次请求新建一个实例**
 * （见 `prepareQoderInfer`），只共用无状态的 glue。
 */
interface Glue {
  exports: Record<string, (...args: number[]) => number>
  heap: () => Uint8Array
  view: () => DataView
  readString: (ptr: number, len: number) => string
  writeString: (text: string) => number
  lastLength: () => number
  heapObject: (index: number) => unknown
  pushObject: (value: unknown) => number
  takeObject: (index: number) => unknown
  callString: (invoke: (stack: number) => void) => string
  callPointer: (invoke: (stack: number) => void) => number
}

let gluePromise: Promise<Glue> | null = null

async function getGlue(): Promise<Glue> {
  gluePromise ??= createGlue()
  return gluePromise
}

/** 真正实例化 WASM 并接好 import。 */
async function createGlue(): Promise<Glue> {
  let exports: Record<string, (...args: number[]) => number> = {}
  let cachedHeap: Uint8Array | null = null
  let cachedView: DataView | null = null

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const encoder = new TextEncoder()

  const heap = (): Uint8Array => {
    if (cachedHeap === null || cachedHeap.byteLength === 0) {
      cachedHeap = new Uint8Array((exports.memory as unknown as { buffer: ArrayBuffer }).buffer)
    }
    return cachedHeap
  }
  const view = (): DataView => {
    if (cachedView === null || cachedView.buffer !== (exports.memory as unknown as { buffer: ArrayBuffer }).buffer) {
      cachedView = new DataView((exports.memory as unknown as { buffer: ArrayBuffer }).buffer)
    }
    return cachedView
  }
  const readString = (ptr: number, len: number): string =>
    decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len))

  /** 对象堆（与官方 `wW` 一致：1024 个 undefined，再 push 四个哨兵）。 */
  const objects: unknown[] = new Array(1024).fill(undefined)
  objects.push(undefined, null, true, false)
  let firstFree = objects.length
  const heapObject = (index: number): unknown => objects[index]
  const pushObject = (value: unknown): number => {
    if (firstFree === objects.length) objects.push(objects.length + 1)
    const index = firstFree
    firstFree = objects[index] as number
    objects[index] = value
    return index
  }
  const takeObject = (index: number): unknown => {
    const value = heapObject(index)
    // 索引 < 1028 是哨兵（undefined/null/true/false），不可回收
    if (index >= 1028) {
      objects[index] = firstFree
      firstFree = index
    }
    return value
  }

  let lastLength = 0
  const writeString = (text: string): number => {
    const encoded = encoder.encode(text)
    const ptr = exports.__wbindgen_export2!(encoded.length, 1) >>> 0
    heap().subarray(ptr, ptr + encoded.length).set(encoded)
    lastLength = encoded.length
    return ptr
  }

  const callString = (invoke: (stack: number) => void): string => {
    let ptr = 0
    let len = 0
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const v = view()
      ptr = v.getInt32(stack + 0, true)
      len = v.getInt32(stack + 4, true)
      const isError = v.getInt32(stack + 12, true)
      if (isError) throw takeObject(v.getInt32(stack + 8, true))
      return readString(ptr, len)
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
      if (ptr) exports.__wbindgen_export4!(ptr, len, 1)
    }
  }

  const callPointer = (invoke: (stack: number) => void): number => {
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const v = view()
      const ptr = v.getInt32(stack + 0, true)
      const isError = v.getInt32(stack + 8, true)
      if (isError) throw takeObject(v.getInt32(stack + 4, true))
      return ptr
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
    }
  }

  /** wasm-bindgen 的「调用 JS 函数并捕获异常」包装。 */
  const guard = (fn: (...args: number[]) => void, args: number[]): void => {
    try {
      fn(...args)
    } catch (error) {
      exports.__wbindgen_export!(pushObject(error))
    }
  }

  const imports = {
    __wbindgen_object_drop_ref: (a: number) => takeObject(a),
    __wbindgen_object_clone_ref: (a: number) => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a: number, e: number) =>
      pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a: number, e: number) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).set(heapObject(e) as Uint8Array, heapObject(t) as number)),
    // ⚠️ 这两个签名**方向相反**：一个写 wasm 内存，一个调 JS 对象。
    // 写反会得到 Rust panic `unreachable`。
    __wbg_getRandomValues_d49329ff89a07af1: (...a: number[]) =>
      guard((x: number, y: number) => {
        crypto.getRandomValues(heap().subarray(x >>> 0, (x >>> 0) + y))
      }, a),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { getRandomValues: (v: unknown) => void }).getRandomValues(heapObject(y))
      }, a),
    __wbg_crypto_38df2bab126b63dc: (a: number) =>
      pushObject((heapObject(a) as { crypto: unknown }).crypto),
    __wbg_process_44c7a14e11e9f69e: (a: number) =>
      pushObject((heapObject(a) as { process: unknown }).process),
    __wbg_versions_276b2795b1c6a219: (a: number) =>
      pushObject((heapObject(a) as { versions: unknown }).versions),
    __wbg_node_84ea875411254db1: (a: number) => pushObject((heapObject(a) as { node: unknown }).node),
    // ⚠️ 参考实现这里 push 的是 `node:module` 的 `module` 对象；
    // Workers 没有它，push 一个空对象即可 —— WASM 只在 `require('crypto')`
    // 那条**已被上方 getRandomValues 覆盖**的分支里用它。
    __wbg_require_b4edbdcf3e2a1ef0: (...a: number[]) => guard(() => pushObject({}), a),
    __wbg_msCrypto_bd5a034af96bcba6: (a: number) =>
      pushObject((heapObject(a) as { msCrypto: unknown }).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { randomFillSync: (v: unknown) => void }).randomFillSync(takeObject(y))
      }, a),
    __wbg_call_d578befcc3145dee: (...a: number[]) =>
      guard((fn: number, self: number, arg: number) => {
        const target = heapObject(fn) as { call: (thisArg: unknown, ...rest: unknown[]) => unknown }
        pushObject(target.call(heapObject(self), heapObject(arg)))
      }, a),
    __wbg_new_with_length_9cedd08484b73942: (a: number) => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (a: number) => (heapObject(a) as { length: number }).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a: number, e: number, t: number) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t) as Uint8Array)
    },
    __wbg_subarray_0f98d3fb634508ad: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).subarray(e >>> 0, t >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
      (globalThis as { self?: unknown }).self === undefined ? 0 : pushObject((globalThis as { self?: unknown }).self),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      (globalThis as { window?: unknown }).window === undefined ? 0 : pushObject((globalThis as { window?: unknown }).window),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p: number, l: number) => {
      throw new Error(readString(p, l))
    },
    __wbg_Error_2e59b1b37a9a34c3: (p: number, l: number) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (id: number) => {
      const v = heapObject(id)
      return typeof v === 'object' && v !== null
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (id: number) => typeof heapObject(id) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: (id: number) => typeof heapObject(id) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (id: number) => heapObject(id) === undefined,
  }

  // ⚠️ `WebAssembly.instantiate(module, imports)` 接受已编译的 Module。
  // 生产环境复用 wrangler 注入的那一份；单测下 esbuild 给的是包装对象，
  // 故先归一化（见 compileWasm 的说明）。
  const compiled = await compileWasm(WASM_MODULE)
  const instance = await WebAssembly.instantiate(compiled, { [IMPORT_MODULE]: imports })
  exports = instance.exports as unknown as Record<string, (...args: number[]) => number>

  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callString,
    callPointer,
  }
}

/** 生成运行时鉴权字段（`encrypt_user_info` / `key`）。 */
export async function generateRuntimeAuthFields(user: QoderWasmUserInfo): Promise<QoderRuntimeAuthFields> {
  const g = await getGlue()
  const payload = JSON.stringify({
    uid: user.uid,
    security_oauth_token: user.securityOauthToken,
    organization_id: user.organizationId ?? '',
    organization_tags: user.organizationTags ?? [],
    data_policy_agreed: user.dataPolicyAgreed ?? false,
  })
  const raw = g.callString((stack) => {
    const a = g.writeString(payload)
    g.exports.generate_runtime_auth_fields!(stack, a, g.lastLength())
  })
  return JSON.parse(raw) as QoderRuntimeAuthFields
}

/**
 * 构造一次加密推理请求（`url` / `headers` / `body`）。
 *
 * ## 为什么做成「一次性」函数而不是导出一个类
 *
 * `QoderContext` 指针**不可跨并发复用**（见 `Glue` 的注释）。做成
 * `QoderEncryptedInfer.create()` + `.prepareInfer()` 两步，
 * 会让调用方有机会把实例缓存起来 —— 那正是要避免的。
 * 本函数把「创建 → 取请求 → 丢弃上下文」封在一次调用里。
 *
 * ⚠️ 返回的 `headers` **必须原样透传**：其中的 `Authorization` 是 WASM 生成的
 * `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>` 覆盖会导致
 * `403 Signature invalid`（参考实现 `:649-655`）。
 */
export async function prepareQoderInfer(options: {
  user: QoderWasmUserInfo
  /** 设备标识（本插件生成并随凭据持久化的随机 UUID）。 */
  machineId: string
  metadata: QoderClientMetadata
  /** 加密端点 host —— 必须是 `api2.qoder.sh` 系，写 `api2-v2` 会 404。 */
  host: string
  clientVersion?: string
  ask: QoderInferAsk
}): Promise<QoderInferRequest> {
  const g = await getGlue()
  const fields = await generateRuntimeAuthFields(options.user)
  const version = options.clientVersion ?? QODER_COSY_VERSION

  const userInfoJson = JSON.stringify({
    uid: options.user.uid,
    encrypt_user_info: fields.encrypt_user_info,
    key: fields.key,
    organization_id: options.user.organizationId ?? '',
    organization_tags: options.user.organizationTags ?? [],
    data_policy_agreed: options.user.dataPolicyAgreed ?? false,
  })

  const context = g.callPointer((stack) => {
    const machine = g.writeString(options.machineId); const machineLen = g.lastLength()
    const ver = g.writeString(version); const verLen = g.lastLength()
    const info = g.writeString(userInfoJson); const infoLen = g.lastLength()
    const meta = g.writeString(JSON.stringify(options.metadata)); const metaLen = g.lastLength()
    // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
    g.exports.qodercontext_new!(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen)
  })

  const ask = options.ask
  const payload = buildQoderInferPayload(ask)

  const result = g.callPointer((stack) => {
    const host = g.writeString(options.host); const hostLen = g.lastLength()
    const body = g.writeString(JSON.stringify(payload)); const bodyLen = g.lastLength()
    const key = g.writeString(ask.modelKey); const keyLen = g.lastLength()
    const source = g.writeString(ask.source ?? 'system'); const sourceLen = g.lastLength()
    g.exports.qodercontext_prepareInferRequest!(
      stack, context, host, hostLen, body, bodyLen, key, keyLen, source, sourceLen,
    )
  })

  const headerMap = g.takeObject(g.exports.requestresult_headers!(result))
  const headers: Record<string, string> = {}
  if (headerMap instanceof Map) {
    for (const [k, v] of headerMap) headers[String(k)] = String(v)
  }

  const readResultString = (invoke: (stack: number, ptr: number) => void): string => {
    let out = ''
    const v = g.view()
    const stack = g.exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack, result)
      const ptr = v.getInt32(stack + 0, true)
      const len = v.getInt32(stack + 4, true)
      out = ptr ? g.readString(ptr, len) : ''
    } finally {
      g.exports.__wbindgen_add_to_stack_pointer!(16)
    }
    return out
  }

  return {
    // ⚠️ 参数顺序：(栈指针, ptr) —— 与直觉相反
    url: readResultString((stack, ptr) => g.exports.requestresult_url!(stack, ptr)),
    headers,
    body: readResultString((stack, ptr) => g.exports.requestresult_body!(stack, ptr)),
  }
}
