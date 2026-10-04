/**
 * OpenCode Zen 供应商适配器（`opencode.ai/zen`）。
 *
 * ## 本供应商的特殊之处（与其它家都不同）
 *
 * 1. **没有任何登录流程**：用户自己粘一个 API key（`sk-…`）；
 *    匿名通道的凭据是**字面量字符串 `'public'`**
 *    （`deepseek-harness-codearts/src/opencode-product.ts:60-62`：
 *    官方 CLI 在没有 key 时自己就用它）。故 `capabilities.login = false`，
 *    且 `loginBlockedReason` 要写清**去哪拿 key**而不是「不支持」。
 * 2. **没有余额/签到端点**：参考实现只实现了 chat 与模型目录
 *    （`src/opencode-adapter.ts` 无 balance/checkin 分支），故两项都声明 `false`。
 * 3. **免费通道有「形状门禁」**（见 {@link ensureFreeLaneShape}）——
 *    这是**最容易漏、漏了整个匿名通道就全废**的一条。
 * 4. **出口 IP 是身份的一部分**：opencode CLI 发往 Zen 的请求**没有任何机器级
 *    指纹**（`src/opencode-product.ts:17-24`：无 machine-id / deviceId / 安装 ID /
 *    遥测）。身份只有三个维度：**出口 IP、API key、随机会话 id**。
 *
 * ## ⚠️ 在 Workers 上必须丢掉的一件事（诚实记录功能损失）
 *
 * 参考实现支持**每账号代理**（`src/opencode.ts:47-49` 的 `proxy` 字段、
 * `src/opencode-proxy.ts` 的 undici `Dispatcher`、
 * `src/opencode-adapter.ts:538-540` 的 per-request `dispatcher`）。
 * Workers **没有 undici**，`fetch` 也没有任何 per-request 代理开关
 * ⇒ 这条能力**整体丢弃**。
 *
 * **真实的功能损失**（不是「换个写法就行」）：
 * - 参考实现的能力分析结论是「**配额扩容只靠给不同匿名槽配不同代理**
 *   （不同出口 IP = 不同配额桶）**」**（`src/opencode-auth.ts:100-102`）。
 *   丢掉代理 ⇒ 多个匿名槽**共享同一个 Cloudflare 出口 IP 段**，
 *   免费额度**不再能通过『多开匿名槽』扩容**，只剩「换 API key」一条路。
 * - 参考实现还有 `label`（脱敏展示）与 `normalizeProxy` 的端口校验，
 *   这些校验在 Workers 上**没有意义**（无处可用），故一并丢弃而不是
 *   保留成一个「看起来支持但不生效」的字段 —— 后者会让用户以为配了代理。
 *
 * ## ⚠️ 必须把磁盘能力缓存换成内存 + Cache API
 *
 * `src/opencode-capability.ts` 的模型**能力元数据**（模态、上下文窗口、
 * 思考档位）来自远端 `https://models.dev/api.json`（**实测 5,311,759 字节**，
 * 一次拉取约 5 秒），并缓存到磁盘
 * （`readFileSync` 在 `:295`、缓存路径在 `:235-238` 的
 * `$DSH_HOME/cache/opencode-capabilities.json`、TTL 见
 * `opencode-product.ts:74-75` 的 60 分钟）。
 *
 * Workers 无持久磁盘 ⇒ 换成两层：
 * 1. **模块级内存**（同一 isolate 内零成本命中，这是热路径）；
 * 2. **Cache API**（`caches.default`，跨 isolate / 跨请求存活）——
 *    没有它，每个新 isolate 冷启动都要拉 5MB，既慢又会撞上游的速率限制。
 *
 * ⚠️ **为什么不能只留内存**：Workers 会水平扩展且随时回收 isolate，
 * 「模块级变量等于每个 isolate 一份」（`AGENTS.md §4.2`）。只留内存的话，
 * 一台新 isolate 就要白拉一次 5MB；流量分散时这会是**每个 isolate 一次**。
 *
 * ⚠️ **为什么用 Cache API 而不是 KV**：本项目不用 KV
 * （`AGENTS.md §8.2.3`：Free 计划 KV 仅 1,000 写/天且最终一致，不适合）。
 * Cache API 在 Free 计划可用、无需绑定、按 URL 索引。
 */

import { ProviderError } from './types.js'
import type {
  ChatRequest,
  Provider,
  ProviderCredential,
  ProviderModel,
} from './types.js'

// ─────────────────────────── 产品配置 ───────────────────────────

/** OpenCode Zen 的固定端点与产品常量。 */
/**
 * ## ✅ 更正：匿名通道**仍然可用**（我先前的判断是错的）
 *
 * 我曾写下「匿名通道已被上游关闭」的结论，依据是 `Bearer public` 返回
 * `401 Missing API key`。**那个结论是错的** —— 真正的原因是**模型选错了**：
 *
 * | 模型类型 | 匿名 `Bearer public` 的结果 |
 * |---|---|
 * | `space-bunny-free` | **200，正常返回**（匿名可用） |
 * | 需付费 key 的模型（如 `deepseek-v4.1-flash`） | `401 Missing API key` |
 * | 免费通道受限的模型（如 `big-pickle`） | `403 FreeTierError: only be used from within OpenCode` |
 *
 * ⚠️ 上游对「需要 key 的模型」返回的是 `Missing API key` —— 这个文案**极具误导性**：
 * 它看起来像「没有提供 key」，实际含义是「**这个模型**不接受匿名访问」。
 * 我据此误判成「整个匿名通道被关闭」，并写进了代码注释。
 *
 * **纪律**：判断「通道是否可用」必须用**明确标记为匿名可用**的模型去验证
 *（如 `space-bunny-free`），不能随便挑一个模型就下结论。
 *
 * 复现（2026-10 实测，86 个模型全打一遍）：
 * ```
 * POST https://opencode.ai/zen/v1/chat/completions
 * authorization: Bearer public
 * body: {"model":"space-bunny-free",...}  → HTTP 200 ✅
 * ```
 */
export const OPENCODE = {
  baseUrl: 'https://opencode.ai/zen',
  chatPath: '/v1/chat/completions',
  /**
   * ⚠️ **匿名凭据是字面量 `public`** —— 官方 CLI 在没有 key 时自己就用它
   * （`src/opencode-product.ts:60-62` 的 `anonymousKey`）。
   */
  anonymousKey: 'public',
  /**
   * ⚠️ 兜底 UA。参考实现会用真机 `opencode --version` 覆盖它；
   * Workers 上**无法探测已安装版本**（无子进程），故恒用兜底值。
   * 这不影响功能：UA 不是门禁判据（门禁只看 body 形状，见
   * `src/opencode-messages.ts:6-8`「描述 / parameters / 全部请求头都不检查」）。
   */
  defaultUserAgent: 'opencode/1.18.22',
  /**
   * 模型**能力**元数据源（远端，能力的主来源）。
   *
   * ⚠️ **不是 `/zen/v1/models`** —— 实测它只返回
   * `id`/`object`/`created`/`owned_by` 四个字段，**不含任何能力信息**
   * （85 条全如此，`src/opencode-product.ts:36-43`）。
   */
  modelsDevUrl: 'https://models.dev/api.json',
  /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档，`opencode-product.ts:74-75`）。 */
  modelsDevTtlMs: 60 * 60 * 1000,
} as const

/** 兜底模型目录条目。 */
export interface OpencodeFallbackModel {
  id: string
  name: string
  /** 匿名通道（`Bearer public`）**能否使用** —— 不是官方定价表的 Free 标记。 */
  isFree: boolean
  contextWindow: number
}

/**
 * 兜底模型表（**以真机实测为准**）。
 *
 * 出处：`deepseek-harness-codearts/src/opencode-product.ts:103-122`
 * （`OPENCODE_FALLBACK_MODELS`，每条对应一次成功的真实请求）。
 *
 * ⚠️ `isFree` 的含义是「**匿名通道**能否使用」，不是官方定价表的 Free 标记
 * —— 这是本适配器唯一关心的维度。
 *
 * ⚠️ `ling-3.0-flash-fin-free` **已被参考实现移除**：它走 `/v1/messages`
 * （Anthropic），该端点对匿名与付费 key 都返回 500，chat 端点则是 404
 * ⇒ 两条通道都不可用。留在目录里只会让用户点到一个必然失败的模型。
 */
export const OPENCODE_FALLBACK_MODELS: readonly OpencodeFallbackModel[] = [
  // ── 匿名**实测可用**（2026-10 逐个复测，共 86 个模型全打一遍）──
  //
  // ⚠️ 只有这一个真的能匿名用。参考项目曾把 7 个标成 `isFree: true`，
  // 但**上游已收紧**：其余 6 个现在返回
  // `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`。
  //
  // ⚠️ 这条清单的正确性**直接影响排查方向**：标错的模型被选中时，
  // 上游对「需要 key 的模型」返回的是 `401 Missing API key` ——
  // 那个文案会把人误导成「匿名通道被关了」，而真相只是**模型选错了**。
  // （我本人就被误导过一次，见本文件顶部的更正说明。）
  { id: 'space-bunny-free', name: 'Space Bunny Free', isFree: true, contextWindow: 262144 },
  // ── 曾标为匿名可用、**现已被上游限制**（保留在目录里但标记为非匿名）──
  { id: 'big-pickle', name: 'Big Pickle', isFree: false, contextWindow: 262144 },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', isFree: false, contextWindow: 262144 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', isFree: false, contextWindow: 262144 },
  { id: 'mimo-v2.5-free', name: 'MiMo-V2.5 Free', isFree: false, contextWindow: 262144 },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: false, contextWindow: 262144 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: false, contextWindow: 262144 },
  // ── 需付费 key（chat 端点；实测匿名为 401）──
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, contextWindow: 262144 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', isFree: false, contextWindow: 262144 },
  { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, contextWindow: 262144 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, contextWindow: 262144 },
  { id: 'minimax-m2.7', name: 'minimax M2.7', isFree: false, contextWindow: 262144 },
  { id: 'minimax-m3', name: 'minimax M3', isFree: false, contextWindow: 262144 },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', isFree: false, contextWindow: 262144 },
]

const FREE_IDS = new Set(OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id))
const REACHABLE_IDS = new Set(OPENCODE_FALLBACK_MODELS.map((m) => m.id))

/** 一份能力元数据（`models.dev` 的 `opencode` 条目里抽取的子集）。 */
export interface OpencodeModelCapability {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  /** 是否接受图片输入（模态，不是「支持 vision」的品牌词）。 */
  supportsImage: boolean
  /** 是否免费（`cost.input === 0 && cost.output === 0`）。 */
  isFree: boolean
}

/** 内存缓存（每个 isolate 一份）。 */
let capabilityMemory: readonly OpencodeModelCapability[] = []
/** 内存缓存的写入时刻（0 = 无缓存）。 */
let capabilityAt = 0
/** 后台刷新去重（避免并发重复下载 5MB）。 */
let refreshing: Promise<void> | undefined

/** Cache API 的索引 URL（Cache API 按 URL 索引，需要一个稳定的假 URL）。 */
const CAPABILITY_CACHE_URL = 'https://free-llm-router.internal/cache/opencode-capabilities.v1'

/**
 * Cache API 是否可用。
 *
 * ⚠️ **必须探测而不是直接用**：`caches.default` 在 `wrangler dev` 的
 * 某些配置下不存在，且本项目的 Worker 未声明任何 Cache 绑定。
 * 用 `typeof` 守卫，避免「缓存不可用」升级成「整个 provider 不可用」。
 */
function cacheApi(): Cache | undefined {
  const globalCaches = (globalThis as { caches?: { default?: Cache } }).caches
  return globalCaches?.default
}

/**
 * 归一 `models.dev` 的一个条目。
 *
 * ⚠️ **能力字段必须照抄上游，不能按「同族应该一样」推断**
 * （`src/opencode-product.ts` 与 `AGENTS.md` 记过 zcode 的同型缺陷：
 * 按「同族应该一样」给两个模型都标了 vision，而上游只有一个有）。
 *
 * ⚠️ **`video` / `audio` / `pdf` 一律降级为 text**：本项目的
 * `ProviderModel` 只有 `supportsImage` 一个布尔位，声明不存在的模态会让
 * 客户端投影出我们并不发送的内容（参考实现 `opencode-capability.ts:211-216`
 * 的同款处理）。
 */
export function normalizeModelsDevEntry(id: string, raw: unknown): OpencodeModelCapability | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as {
    name?: unknown
    modalities?: { input?: unknown }
    limit?: { context?: unknown; output?: unknown }
    cost?: { input?: unknown; output?: unknown }
  }
  const declared = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((m): m is string => typeof m === 'string')
    : []
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    contextWindow: num(entry.limit?.context),
    maxOutputTokens: num(entry.limit?.output),
    supportsImage: declared.includes('image'),
    // ⚠️ 免费判据是 `cost.input === 0 && cost.output === 0` —— **0 是合法值**，
    // 不能用 `> 0` 或 `!== undefined` 之类的近似判定。
    isFree: num(entry.cost?.input) === 0 && num(entry.cost?.output) === 0,
  }
}

/** 从 `models.dev` 的整包 JSON 里抽出 `opencode` 的模型清单。 */
export function parseModelsDevPayload(body: unknown): OpencodeModelCapability[] {
  if (typeof body !== 'object' || body === null) return []
  const models = (body as Record<string, { models?: unknown }>)['opencode']?.models
  if (typeof models !== 'object' || models === null) return []
  const out: OpencodeModelCapability[] = []
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    const entry = normalizeModelsDevEntry(id, raw)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/**
 * 读缓存（内存 → Cache API）。
 *
 * ⚠️ **TTL 过期时不阻塞**：冷路径绝不能 await 5MB 的网络拉取 —— 那会让
 * 模型列表请求卡住（参考实现记过`fetch` 在坏网络下**永不 settle**
 * 的真实事故，故它自己也加了 20 秒超时，见 `opencode-capability.ts:318-330`）。
 * 故这里**只在内存为空**时才走 Cache API，且**永不**在请求路径上等网络。
 */
async function loadCapabilities(): Promise<readonly OpencodeModelCapability[]> {
  const now = Date.now()
  if (capabilityMemory.length > 0 && now - capabilityAt < OPENCODE.modelsDevTtlMs) {
    return capabilityMemory
  }
  if (capabilityMemory.length > 0) {
    // 有旧数据但过期：**先用旧的**，后台刷新（stale-while-revalidate）。
    void refreshCapabilities()
    return capabilityMemory
  }
  const cache = cacheApi()
  if (cache !== undefined) {
    try {
      const hit = await cache.match(CAPABILITY_CACHE_URL)
      if (hit !== undefined) {
        const parsed = (await hit.json()) as { at?: unknown; entries?: unknown }
        if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
          capabilityMemory = parsed.entries as OpencodeModelCapability[]
          capabilityAt = typeof parsed.at === 'number' ? parsed.at : 0
          return capabilityMemory
        }
      }
    } catch {
      // 缓存读失败不影响功能（会退回兜底表）。
    }
  }
  return capabilityMemory
}

/** 后台刷新能力表（幂等 + 吞异常）。 */
export function refreshCapabilities(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(OPENCODE.modelsDevUrl, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`http=${res.status}`)
      const entries = parseModelsDevPayload(await res.json())
      if (entries.length === 0) throw new Error('解析结果为空')
      capabilityMemory = entries
      capabilityAt = Date.now()
      const cache = cacheApi()
      if (cache !== undefined) {
        // ⚠️ Cache API 的 `put` 必须等它完成（`waitUntil` 由调用方决定）；
        // 失败时静默 —— 缓存只是加速，不是功能。
        await cache
          .put(
            CAPABILITY_CACHE_URL,
            new Response(JSON.stringify({ at: capabilityAt, entries }), {
              headers: { 'content-type': 'application/json' },
            }),
          )
          .catch(() => {})
      }
    } catch (error) {
      console.error('[opencode] 能力表刷新失败：', error instanceof Error ? error.message : String(error))
    } finally {
      refreshing = undefined
    }
  })()
  return refreshing
}

// ─────────────────────────── 凭据 ───────────────────────────

/**
 * 从对象形态里取 API key。
 *
 * ⚠️ **只认 `api_key` / `apiKey` / `key`，刻意不收 `token` / `access_token` /
 * `accessToken`**（真实缺陷，跑全量单测时实测到）。
 *
 * 理由与上面裸字符串那道闸同源：`parseCredentialAnywhere` 会让每家依次尝试，
 * 而这些泛化别名是**别家凭据的主体字段名**（WorkBuddy 的凭据就是
 * `{uid, accessToken, …}`）。收下它们会让本适配器把别家的凭据认成 Zen 的 key
 * ——导入「成功」，一用就 401，且报错指向错误的方向。
 *
 * Zen 的凭据形状是明确的（参考实现 `src/opencode.ts:42-50` 的
 * `OpencodeCredential`：`{ api_key, nickname?, fingerprint?, proxy? }`），
 * 故不需要靠别名去猜。
 */
function readApiKey(source: Record<string, unknown>): string | undefined {
  for (const key of ['api_key', 'apiKey', 'key']) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 解析 OpenCode 凭据。
 *
 * 接受的形态：
 * 1. 裸字符串（`sk-…` 直接粘贴 —— 最常见的用法）；
 * 2. `{api_key: '…'}` / `{apiKey: '…'}` / `{key: '…'}`；
 * 3. 上面任一种再套一层 `{credential:{…}}` / `{data:{…}}`。
 *
 * ⚠️ **没有访问令牌时抛错，不用 `'public'` 静默兜底**：用户粘贴的本意是
 * 「我要用我的账号」。悄悄降级成匿名通道会让**付费模型全部 401**，
 * 且用户看不出为什么。要匿名就得**显式**写
 * `{"api_key":"public"}`（见 `loginBlockedReason` 的说明）。
 *
 * ⚠️ `uid` 的派生：Zen 的**账号**身份就是 key 本身（无其它账号标识）。
 *
 * ⚠️ **不能直接把 key 当 uid**：uid 会被用作存储主键并出现在面板/日志里
 * （`AGENTS.md §7.1` 第 4 条：错误信息与日志里凭据必须脱敏）。
 * 故用 {@link fingerprint} 做一个**非密码学**的稳定指纹 —— 它是去重键，
 * 不是安全边界（真正的秘密仍是那份加密存储的 key），
 * 且 key 是高熵的 `sk-…`，指纹不可逆推。
 */
export function parseCredential(input: unknown): ProviderCredential {
  let source: Record<string, unknown>
  if (typeof input === 'string') {
    /**
     * ⚠️⚠️ **裸字符串必须过一道形状闸**（真实缺陷，跑全量单测时实测到）。
     *
     * `parseCredentialAnywhere` 会**依次**让每家供应商尝试解析同一份输入
     * （`src/providers/index.ts` 的设计：不逼用户事先声明是哪家）。
     * 若这里无条件接受「任何字符串」，那么别家凭据只要被粘成裸字符串
     * （如 `"str"`、一串 JWT、一个 base64 凭据包）就会被**我们抢先认下来**，
     * 然后拿去打 Zen 的端点 → 永远 401，且用户看到的是
     * 「导入成功」——正是 `types.ts` 警告的那类最难排查的失败。
     *
     * Zen 的 key 有稳定形状：`sk-` 前缀（加上官方文档里那几个字面量）。
     * 只在这些形状上认领，其余交回给别的供应商。
     */
    const trimmed = input.trim()
    const looksLikeZenKey = trimmed.startsWith('sk-')
      || trimmed === OPENCODE.anonymousKey
    if (!looksLikeZenKey) {
      throw new ProviderError({
        provider: 'opencode',
        message: '这不是 OpenCode Zen 的 API key（应以 `sk-` 开头，或为匿名通道的 `public`）',
      })
    }
    source = { api_key: trimmed }
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    source = input as Record<string, unknown>
    for (const key of ['credential', 'credentials', 'data', 'opencode']) {
      const nested = source[key]
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        source = nested as Record<string, unknown>
        break
      }
    }
  } else {
    throw new ProviderError({
      provider: 'opencode',
      message: 'OpenCode 凭据必须是一个 API key 字符串，或含 `api_key` 字段的 JSON 对象',
    })
  }

  const apiKey = readApiKey(source)
  if (apiKey === undefined) {
    throw new ProviderError({
      provider: 'opencode',
      message: 'OpenCode 凭据缺少 API key（`api_key` / `apiKey` / `key`）。'
        + '请在 https://opencode.ai/auth 登录后复制 Zen 的 API key（形如 `sk-…`）粘贴；'
        + '若要使用**匿名免费通道**，请显式填写 `{"api_key":"public"}`',
    })
  }

  const isAnonymous = apiKey === OPENCODE.anonymousKey
  // ⚠️ **匿名凭证没有账号身份** —— 上游按**出口 IP** 限额（实测：换 key、
  // 换任意伪装头、换指纹全部无效，见 `src/opencode-auth.ts:100-102`）。
  // 故 uid 用一个固定值，让所有匿名槽归到同一条账号记录上。
  const uid = isAnonymous ? 'anonymous' : `key-${fingerprint(apiKey)}`

  return {
    provider: 'opencode',
    uid,
    accessToken: apiKey,
    refreshToken: '',
    // ⚠️ 静态凭据：Zen 的 key 不会过期（无 refresh_token 机制），
    // 故 `expiresAt = 0` = 「未知/不过期」。真失效时上游回 401，
    // 由 `shouldRotate` 与错误分类处理 —— **不做本地猜测**。
    expiresAt: 0,
    nickname: isAnonymous
      ? 'OpenCode 匿名通道'
      : (typeof source.nickname === 'string' && source.nickname.length > 0 ? source.nickname : uid),
    extras: {
      /**
       * ⚠️ **`x-opencode-project` 只需「40 位小写 hex」这个形状**。
       *
       * 真实 CLI 的取值是 `sha1("git-remote:" + 归一化 remote URL)`
       * （`src/opencode.ts:15-20`，本机 opencode.db 实测
       * `895debfe16b1fcca5ebfa2e24b7b914797e632ec`），即**按项目**而非按账号。
       * 参考实现复刻了那条派生（`deriveProjectId`），并在 `opencode2dsh`
       * 用 `prj_<24hex>` 时因形状不符被记过。
       *
       * 这里改用**随机 20 字节 → hex**，理由有三：
       * 1. **形状要求满足**（40 位小写 hex），而形状才是唯一有证据的约束
       *    —— 参考实现明确指出「指纹派生的作用是**防关联**与满足形状门禁，
       *    不是换配额桶」（`src/opencode-product.ts:21-23`）；
       * 2. **防关联效果更强**：把 key 哈希成固定值会让「同一个 key 永远对应
       *    同一个 project id」，而随机值让不同账号之间无法被关联；
       * 3. **不自己实现密码学**：参考实现用了 `node:crypto` 的 SHA-1 + SHA-256
       *    （Workers 的 `crypto.subtle` **支持 SHA-1**，但 `digest()` 是异步的，
       *    而 `parseCredential` 是**同步**接口）—— 为了一个只需满足形状的字段
       *    手写 SHA-1 是不必要的风险。
       *
       * ⚠️ **调用方必须把 `extras` 连同凭据一起持久化**：换一个 project id
       * 等价于「换了一个项目」，会让上游看到同一账号在无数个项目上活动。
       */
      projectId: randomHex(20),
    },
  }
}

/**
 * 稳定指纹（**非密码学**，仅用于去重展示）。
 *
 * 用 FNV-1a 64 位跑两遍（不同 offset basis）拼成 32 位 hex，避免单次
 * 64 位的碰撞面。选它而不用 `crypto.subtle`：`parseCredential` 是**同步**接口，
 * 而 WebCrypto 的 `digest()` 只能异步。
 *
 * ⚠️ **它不是安全边界**：这里只防「把 key 明文当主键/日志字段」，
 * 真正的秘密保护靠凭据加密存储（`src/store/crypto.ts`）。
 */
export function fingerprint(text: string): string {
  const FNV_PRIME = 0x100000001b3n
  const FNV_MASK = 0xffffffffffffffffn
  const hash = (offset: bigint): bigint => {
    let h = offset
    // ⚠️ 逐 **UTF-16 码元**而不是逐字节：本项目只需要「同一输入恒同输出」，
    // 不需要跨语言一致。用码元可避免 `TextEncoder` 的额外分配。
    for (let i = 0; i < text.length; i += 1) {
      h = (h ^ BigInt(text.charCodeAt(i))) & FNV_MASK
      h = (h * FNV_PRIME) & FNV_MASK
    }
    return h
  }
  const a = hash(0xcbf29ce484222325n).toString(16).padStart(16, '0')
  const b = hash(0x84222325cbf29ce4n).toString(16).padStart(16, '0')
  return `${a}${b}`
}

/** 生成 `n` 字节的随机小写 hex（用 WebCrypto 的 CSPRNG，不是 `Math.random`）。 */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─────────────────────────── 会话 id ───────────────────────────

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * 生成 session id：`ses_` + 12 位小写 hex（6 字节时间戳）+ **14** 位 base62。
 *
 * ## ⚠️⚠️ 尾段是 14 而不是 26（真实报障）
 *
 * 官方 `id/index.ts` 写的是 `const LENGTH = 26`，但那是**整段尾部长度**
 * （`randomBase62(LENGTH - 12)`），不是随机段长度。参考实现第一版误读成
 * 「随机 26 位」，产出 `ses_` + 38 字符，形状不对 ⇒ 匿名通道**一律 403
 * `FreeTierError`**（"free tier can only be used from within OpenCode"）。
 *
 * 证据（`src/opencode.ts:88-105`，本机官方 CLI 1.18.22 的真实 session id）：
 * ```
 * ses_f078262d9ffeFwtz1QB7VnN4kM   ← 12 hex + 14 base62 = 26
 * ```
 * 与门禁正则 `ses_[0-9a-f]{12}[0-9A-Za-z]{14}` 一致。
 *
 * ⚠️ **每次调用都是新值**：参考实现让调用方在一次会话内复用
 * （`opencode-adapter.ts` 的 `sessionIds`）。本项目是无状态代理，没有会话概念，
 * 故每次请求一个新 session id —— 这与真实 CLI「每个 session 一个 id」的
 * 语义一致（不破坏亲和，只是没有 prompt cache 复用）。
 */
export function deriveSessionId(): string {
  // 12 位 hex = 6 字节小端时间戳（与官方 `id/index.ts` 的 `timeBytes` 同构）。
  let now = BigInt(Date.now())
  let time = ''
  for (let i = 0; i < 6; i += 1) {
    time += (Number(now & 0xffn)).toString(16).padStart(2, '0')
    now >>= 8n
  }
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  let tail = ''
  for (let i = 0; i < 14; i += 1) tail += BASE62[(bytes[i] ?? 0) % BASE62.length]
  return `ses_${time}${tail}`
}

/** 派生 request id（每请求一个，官方形态 `req_` + 32 hex）。 */
export function deriveRequestId(): string {
  return `req_${randomHex(16)}`
}

/** 构造发往 Zen 的完整指纹头集（与真实 CLI 逐项一致）。 */
export function opencodeHeaders(projectId: string, sessionId: string, requestId: string): Record<string, string> {
  return {
    'x-opencode-project': projectId,
    'x-opencode-session': sessionId,
    'x-opencode-request': requestId,
    'x-opencode-client': 'cli',
    'user-agent': OPENCODE.defaultUserAgent,
  }
}

// ─────────────────────────── FreeTier 形状门禁 ───────────────────────────

/**
 * 门禁工具名（**服务端只认这两个名字**）。
 *
 * 出处：`deepseek-harness-codearts/src/opencode-messages.ts:29-30`。
 */
export const FREE_LANE_GATE_TOOLS = ['bash', 'read'] as const

/** 门禁桩工具：描述固定为「不要调用」，参数为空对象。 */
function gateTool(name: string): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/**
 * 注入门禁工具，必要时补 `tool_choice`。
 *
 * ## ⚠️⚠️ 这是**免费通道能否工作的开关**，绝不能删
 *
 * 门禁依据（`deepseek-harness-codearts/src/opencode-messages.ts:1-14`，
 * opencode2dsh 2026-09-18 实测）：
 *
 * > 匿名通道拒绝**不带 agent 形状**的 body，回 **403 `FreeTierError`**，
 * > 除非 `stream: true` 且 `tools` 里有名为 `bash` 与 `read` 的 function 工具
 * > （描述 / parameters / **全部请求头都不检查**）。
 *
 * ⚠️ **账号槽（带 API key）同样注入**：免费通道与认证通道的服务端策略可能共用
 * 同一层形状检查，多注入一层对认证通道无害（官方 CLI 本来也带全套工具），
 * 但缺了它就可能让匿名槽**整体失效**。
 *
 * ⚠️ `tool_choice: 'none'` **只在原本一个工具都没有时**补：真实工具在列时
 * 覆盖用户的自选 `tool_choice` 会改变模型行为（模型将无法调用任何工具，
 * 而调用方仍在等它调用 —— 表现为工具执行不推进）。
 *
 * @returns 满足门禁的 body；已满足或非 chat body 时**返回同一引用**。
 */
export function ensureFreeLaneShape(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.messages)) return payload
  const tools = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : []
  const names = new Set<string>()
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const fn = (tool as { function?: { name?: unknown } }).function
    if (typeof fn?.name === 'string') names.add(fn.name)
  }
  const missing = FREE_LANE_GATE_TOOLS.filter((name) => !names.has(name))
  if (missing.length === 0) return payload
  return {
    ...payload,
    tools: [...tools, ...missing.map((name) => gateTool(name))],
    ...(tools.length === 0 ? { tool_choice: 'none' } : {}),
  }
}

/**
 * 构造一次 chat 请求的完整 body（已过门禁）。
 *
 * ⚠️ **`stream: true` 恒置** —— 这是门禁的**一半要求**（另一半是那两个工具）。
 *
 * ⚠️ 上游就是标准 OpenAI SSE，故**不需要**任何流转换：
 * `gateway/stream.ts` 已按 OpenAI 形状解析 usage 与错误帧，
 * `chat()` 直接返回上游响应即可。
 */
export function buildOpencodePayload(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...body,
    model,
    // ⚠️ 恒 true：门禁要求。
    stream: true,
    tools: Array.isArray(body.tools) ? body.tools : [],
  }
  return ensureFreeLaneShape(out)
}

// ─────────────────────────── 错误分类 ───────────────────────────

/** 语义化的错误类别。 */
export type OpencodeErrorKind =
  | 'free_usage_limit'
  | 'go_usage_limit'
  | 'rate_limit'
  | 'free_tier'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'

/** 从响应头解析 `retry-after`（秒数或 HTTP 日期）→ 毫秒。 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (raw === undefined || raw === null || raw === '') return undefined
  // ⚠️ **只放行纯数字**：`Date.parse('900')` 会得到 1970 年的时刻，
  // 算出巨大负数被 `Math.max(0, …)` 抹成 0（「立即解除」）—— 那会让额度刚用尽的
  // 账号马上被重选，形成无限空转（`src/opencode-product.ts:172-184`）。
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
export function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown }
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown }).message
      : data.error
    const parts = [data.message, nested, data.msg]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/**
 * 把一次失败的 HTTP 响应归类为语义化的错误。
 *
 * ## ⚠️ 为什么按「错误类型名」而不是「状态码」分类
 *
 * 出处：`deepseek-harness-codearts/src/opencode-product.ts:9-16`。
 * Zen 的额度错误可能带 **400/401/403/429 任一状态码**，唯一稳定的信号是
 * **响应体里的错误类型名**。
 *
 * ⚠️ 本仓库 qoder 曾因「用错误码的默认归类代替业务语义判断」把确定性的
 * 额度耗尽当成可重试的 `SERVER` 而**白重试 5 次**；minimax 也曾把 402 归
 * `AUTH` 让用户看不到「去充值」这个唯一有效动作。
 *
 * ## ⚠️ **顺序即优先级**：限流语义必须在 auth 之前判
 *
 * 上游的额度错误经常带 401/403 状态码。若先判状态码，会把「额度用尽」
 * 误报成「key 失效」，用户的唯一有效动作（等窗口恢复 / 切下一个账号）
 * 会被**完全掩盖**。
 */
export function classifyOpencodeError(status: number, body: string): OpencodeErrorKind {
  const lower = body.toLowerCase()
  if (body.includes('FreeUsageLimitError')) return 'free_usage_limit'
  if (body.includes('GoUsageLimitError')) return 'go_usage_limit'
  // 形状门禁：伪装形态被拒。**不重试也不换槽**（我们每槽发的是同一套形状，
  // 换槽重试无意义），如实透传让人知道「伪装需跟进上游更新」。
  if (body.includes('FreeTierError')) return 'free_tier'
  if (status === 429 || lower.includes('too many requests') || lower.includes('rate limit')) return 'rate_limit'
  if (
    status === 0 || lower.includes('fetch failed') || lower.includes('terminated')
    || lower.includes('econnreset') || lower.includes('socket hang up')
    || lower.includes('getaddrinfo') || lower.includes('econnrefused')
  ) return 'transport'
  // ⚠️⚠️ **402 必须单独归类**：实测付费 key 余额耗尽时上游回
  // `402 {"error":{"type":"server_error","message":"…Insufficient account funds"}}`。
  // 若被归成 `SERVER`，用户看到的是「服务端故障，请重试」—— 而重试永远不会成功
  // （要充值）。
  if (
    status === 402 || lower.includes('insufficient account funds')
    || lower.includes('insufficient funds') || lower.includes('insufficient balance')
  ) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'server'
  return 'auth'
}

/** 类别 → 是否值得换号（`types.ts` 的缺省语义是 429/402）。 */
export function shouldRotateForKind(kind: OpencodeErrorKind): boolean {
  // `free_usage_limit` / `go_usage_limit` / `rate_limit` 都是**配额维度**的，
  // 换号确实可能换成另一个还有配额的账号（付费 key）或另一个出口 IP
  // （匿名槽 —— 但在 Workers 上所有匿名槽共享同一出口，见文件头）。
  if (kind === 'free_usage_limit' || kind === 'go_usage_limit' || kind === 'rate_limit') return true
  if (kind === 'quota') return true
  // `free_tier`（形状被拒）换号无用：我们每槽发的是同一套形状。
  // `auth` / `server` / `transport` 同理不是账号维度的问题。
  return false
}

// ─────────────────────────── Provider ───────────────────────────

/** 是否免费模型（**未知模型返回 false**）。 */
export function isFreeOpencodeModel(id: string): boolean {
  return FREE_IDS.has(id)
}

/** 是否在我们已实测可达的通道里（**未知模型返回 false**）。 */
export function isReachableOpencodeModel(id: string): boolean {
  return REACHABLE_IDS.has(id)
}

/**
 * 拉模型目录并合并能力元数据。
 *
 * ## ⚠️ 目录**只暴露兜底表内的模型**
 *
 * `GET /v1/models` 返回全部 84 个模型，且**不含任何协议信息**
 * （字段只有 id/object/created/owned_by）。若直接把它们交给客户端，
 * 用户会在选择器里看到 `claude-*` / `gpt-*` 等模型 —— 点下去只会拿到
 * 404/401/500。表外的新模型要等实测确认端点后再加进来。
 * 出处：`deepseek-harness-codearts/src/opencode-product.ts:137-152`。
 *
 * ⚠️ 这里**不再发 `GET /v1/models` 请求**：它只返回 4 个字段（无能力信息），
 * 而能力在 models.dev 里。发两次请求换 0 个额外信息是纯浪费 —— 与参考实现
 * 的 `listModels` 一致（它也只读兜底表 + 能力表）。
 */
async function listModels(_credential: ProviderCredential, _signal: AbortSignal): Promise<ProviderModel[]> {
  // 能力表**同步可用的内存副本优先**，拿不到就用兜底表的保守值。
  const capabilities = await loadCapabilities()
  const byId = new Map(capabilities.map((c) => [c.id, c]))
  return OPENCODE_FALLBACK_MODELS.map((m) => {
    const capability = byId.get(m.id)
    return {
      id: m.id,
      name: capability?.name ?? m.name,
      // ⚠️ **窗口未知不编造**：能力表说 0 时回落到兜底表的 262144
      // （那个值是实测的，见兜底表注释），而不是下发 0 ——
      // 0 是「不知道」的哨兵，会让客户端的自动压缩抛错。
      contextWindow: capability !== undefined && capability.contextWindow > 0
        ? capability.contextWindow
        : m.contextWindow,
      maxOutput: capability?.maxOutputTokens ?? 0,
      // ⚠️ 能力表拿不到时**保守回退 false**：声明支持就必须真支持
      // （参考实现 `opencode-adapter.ts` 的 `inputModalitiesOf` 同款约定）。
      // 本轮**不**拉取能力表时也没有本地兜底 —— 故这里如实给 false。
      supportsImage: capability?.supportsImage === true,
      // ⚠️ 免费判定用**兜底表的实测值**（匿名通道能否使用），
      // 不是 models.dev 的 cost —— 两者的语义不同（见兜底表注释）。
      isFree: m.isFree,
    }
  })
}

/** 发起对话（返回上游响应；上游就是 OpenAI SSE，**无需转换**）。 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const payload = buildOpencodePayload(request.model, request.body)
  const headers: Record<string, string> = {
    ...opencodeHeaders(
      // ⚠️ `projectId` 由 `parseCredential` 生成并持久化；万一旧凭据里没有，
      // 现取一个随机值（形状正确即可，见 `parseCredential` 的说明）。
      credential.extras.projectId ?? randomHex(20),
      deriveSessionId(),
      deriveRequestId(),
    ),
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${credential.accessToken}`,
  }
  // ⚠️ 参考实现会在这里挂 undici 的 per-request `dispatcher`（`proxy`）。
  // Workers **没有 undici 的 Dispatcher**，`fetch` 也没有任何 per-request
  // 代理开关 ⇒ 这条能力整体丢弃。后果见文件头「必须丢掉的一件事」。
  const res = await fetch(`${OPENCODE.baseUrl}${OPENCODE.chatPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: request.signal,
  })
  return res
}

export const opencodeProvider: Provider = {
  /**
   * 对象判别式：**只有当对象里出现 `api_key` / `apiKey` 这类 opencode 专有键**时命中。
   *
   * ⚠️ 不能认 `accessToken` / `uid` —— 那会把 WorkBuddy 等家的凭据抢走。
   * opencode 的凭据键名很独特（见 readApiKey 的注释），足以判别。
   */
  matchesShape(input) {
    for (const key of ['api_key', 'apiKey', 'opencode_api_key']) {
      const value = input[key]
      if (typeof value === 'string' && value.trim().length > 0) return true
    }
    return false
  },

  /**
   * 裸字符串判别式：匿名槽的**字面量** `public`，或形如 `sk-…` 的 API key。
   *
   * ⚠️ 必须包含 `public`：那是上游约定的匿名标识（只有 6 个字符），
   * 若按「长度 ≥20」这种通用规则判，会把合法的匿名用法挡掉。
   */
  bareStringPattern: /^(public|sk-[A-Za-z0-9_-]{10,})$/,

  id: 'opencode',
  name: 'OpenCode Zen',
  capabilities: {
    /**
     * ❌ **没有登录流程**（不是「登录不可移植」，而是**上游本就没有**）。
     *
     * 依据：`deepseek-harness-codearts/src/opencode-auth.ts` 全文只有
     * 「身份槽组装」，没有任何 OAuth / 设备码 / 本地回调；
     * 凭据就是用户粘的 API key（`src/opencode.ts:42-50` 的 `OpencodeCredential`）。
     * 官方 CLI 在无 key 时用字面量 `'public'` 走匿名通道
     * （`src/opencode-product.ts:60-62`）。
     */
    login: false,
    loginBlockedReason: 'OpenCode Zen 没有登录流程（无 OAuth / 设备码）—— 请到 '
      + 'https://opencode.ai/auth 登录后复制 Zen 的 API key（形如 `sk-…`）粘贴导入；'
      + '若要使用**匿名免费通道**，请显式导入 {"api_key":"public"}（仅免费模型可用，'
      + '且按出口 IP 限额 —— Workers 上所有匿名账号共享 Cloudflare 的出口 IP 段，'
      + '无法通过多开匿名账号扩容）',
    listModels: true,
    chat: true,
    /**
     * ❌ **无余额端点**：参考实现的 `opencode-adapter.ts` 只有 chat 与模型目录，
     * 全文 grep 无 balance / credits / checkin 分支（已核对）。
     * Zen 侧的用量只在网页控制台里，没有对应的公开 API。
     */
    balance: false,
    /** ❌ 同上：Zen 没有每日签到/领取机制。 */
    checkin: false,
    /**
     * 依据 `src/opencode-adapter.ts` 全文无 balance/credits/checkin 分支
     * （已 grep 核对）——Zen 没有公开的积分/签到 API。
     */
    checkinBlockedReason:
      'OpenCode Zen 没有积分与签到 API（免费通道的额度按请求限流，不是可领取的积分）。',

  },
  parseCredential,
  listModels,
  chat,
  shouldRotate(status, bodyText) {
    return shouldRotateForKind(classifyOpencodeError(status, bodyText))
  },
}

// ⚠️ `balance` / `checkin` 在 `Provider` 接口里是**可选方法**，这里**有意不实现**
// （`capabilities.balance = false`、`capabilities.checkin = false`）。
// 不写「空实现」是有意的：空实现会让网关以为调用是安全的，
// 而 `capabilities` 为 false 时不该被调用（`types.ts:165-169`）。
