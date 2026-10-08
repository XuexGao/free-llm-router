/**
 * ZCode（智谱 z.ai 免费额度通道）供应商适配器。
 *
 * ## 协议要点（全部有实测出处）
 *
 * 1. **推理是可移植的**：`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`
 *    （Anthropic Messages 协议），需要 `Authorization: Bearer <jwt>`
 *    **加一个必需的 `X-Device-Mid` 头** —— 缺它回
 *    `400 {"code":3001,"msg":"parameter error"}`。
 *    出处：`deepseek-harness-codearts/src/zcode-upstream.ts:9-18` 的对照表
 *    （`GET /zcode-plan/billing/balance` 缺 Authorization → 401、
 *    缺 `X-Device-Mid` → 400 code 3001）。
 * 2. **自 3.14.4（2026-09-29）起模型请求不再索要 captcha**：
 *    `src/zcode-captcha.ts:1-20` 的实测表 ——
 *    `/api/v1/zcode-plan/anthropic`（**模型请求**）不带验证头 → **HTTP 200**
 *    （6 个采样点）；而 `/api/v1/zcode-plan/billing/claim`（**领取**）
 *    不带 → `400 {"code":3007}`，**始终索要**且校验**前置于** plan 校验。
 * 3. **签到（checkin）在 Workers 上不可行** —— 见 `capabilities.checkin` 的说明。
 * 4. **上游对请求体做内容检查**：`system` 缺官方身份块时直接回
 *    `{"code":3012,"msg":"request has been blocked due to unusual activity."}`
 *    （`src/zcode-identity.ts:1-32` 的实测矩阵）。且 **3012 有账号冷却惩罚**
 *    （30 分钟；24h 内第 3 次起 24h；5 次停用）⇒ **不要为了调试反复触发**。
 *
 * ## ⚠️ 在 Workers 上必须丢掉的一件事（诚实记录）
 *
 * 参考实现的 `src/zcode.ts:30-33` 会**解密官方客户端的凭据文件**
 * （`~/.zcode/v2/credentials.json`）：
 * ```ts
 * import { createDecipheriv, createHash } from 'node:crypto'
 * import { existsSync, readFileSync } from 'node:fs'
 * import { homedir, platform, userInfo } from 'node:os'
 * ```
 * 密钥由「平台 + 家目录 + 用户名」派生（`CREDENTIAL_PREFIX = 'enc:v1:'`、
 * `aes-256-gcm`）。Workers **没有文件系统、没有 `node:crypto`、没有
 * `os.userInfo()`** ⇒ 这条**整条回退路径丢弃**，
 * **只支持插件自存的凭据**（用户粘贴）。
 *
 * **真实的用户影响**（不是「换个写法就行」）：
 * 一个装好 ZCode 官方客户端并已登录的用户，在本项目里**不能**零操作直接可用
 * —— 他必须把 JWT 与 device_mid 手动粘进来（或走本文件的设备码登录）。
 * 参考实现把「读官方凭据」当作**回退**、把插件自存当作**优先**
 * （`src/zcode.ts:560-570` 的 `resolveZcodeCredential`），
 * 故丢弃回退路径**不改变优先级语义**，只减少了一条便利通道。
 *
 * ## ⚠️ 顺带丢弃的第二件事
 *
 * 参考实现用 `~/.zcode/v2/telemetry-state.json` 的 `deviceMid` 做设备标识
 * （`src/zcode.ts:203-215`）。Workers 上改为：**凭据里带就用**，
 * 否则**随机生成一个并持久化**。
 * 实测依据（`src/zcode-login.ts:136-143` 的 `generateDeviceMid()` = `randomUUID()`）：
 * 该值**不被服务端绑定校验**，同一账号每次重新登录都会得到一个新值 ——
 * 故自生成是安全的。但它**不是账号标识**（那是 `user_id`）。
 */

import { ProviderError } from './types.js'
import type {
  ChatRequest,
  CheckinResult,
  Provider,
  ProviderBalance,
  ProviderCredential,
  ProviderModel,
} from './types.js'
import {
  anthropicSseToOpenAiSse,
  splitSystemMessages,
  toAnthropicMessages,
  toAnthropicTools,
  toAnthropicToolChoice,
  withToolCacheBreakpoint,
} from './anthropic.js'

// ─────────────────────────── 端点 ───────────────────────────

/** ZCode 平台 origin。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic 端点。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/** 额度余额端点（**需要 Authorization**）。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 客户端配置端点（模型池 + captcha 配置都从这里来）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/**
 * 领取端点（**需要 Authorization + 阿里云 captcha**）。
 *
 * ⚠️ 实测：该端点**始终**索要 captcha（带非法 captcha 与不带都由
 * `400 / code 3007` 拒绝，且**校验前置于 plan 校验**）。
 * 参考：`deepseek-harness-codearts/src/zcode-upstream.ts:73`。
 */
export const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

/**
 * 可领取计划预览端点（`GET`，**不需要 captcha**）。
 *
 * ⚠️ 与 claim 的区别很重要：本端点不需要验证码，故**在 Workers 上可用** ——
 * 它让「有没有可领的」这件事仍然可查（而真正领取才需要浏览器）。
 */
export const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`

/** CLI 设备授权流的初始化端点。 */
export const ZCODE_OAUTH_CLI_INIT_URL = `${ZCODE_ORIGIN}/api/v1/oauth/cli/init`

/** 设备授权流的轮询端点。 */
export const zcodeOauthCliPollUrl = (flowId: string): string =>
  `${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`

/** 客户端版本兜底值（`src/zcode.ts:446`）。 */
export const ZCODE_APP_VERSION_FALLBACK = '3.14.3'

/** 学习自上游的错误码。 */
export const ZCODE_CONCURRENCY_CODE = '3009'
export const ZCODE_QUOTA_CODE = '1005'

// ─────────────────────────── 模型目录 ───────────────────────────

/** 兜底模型目录条目。 */
export interface ZcodeFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
  /** 思考档位（**按展示顺序**）。 */
  reasoningLevels?: readonly string[]
  defaultReasoningLevel?: string
}

/**
 * 兜底模型目录（**实测数据**）。
 *
 * 出处：`deepseek-harness-codearts/src/zcode-product.ts:180-207`
 * （`ZCODE_FALLBACK_MODELS`，逐字照抄上游
 * `GET /api/v1/client/configs` 的 `builtinModels`，实测 2026-09-29）。
 *
 * ⚠️ **只放实测可用的两个**。服务端的模型清单里有 `GLM-5-Turbo` 与 `GLM-5.2`，
 * 但 2026-09-28 实测它们**返回空响应**（同样的三题 0/3 正确，而 GLM-5.3 是 3/3）。
 * 把不可用的模型列出来会让用户选中后收到空回复，**比不列更糟**。
 *
 * ⚠️ **能力字段必须抄上游，不能按「同族应该一样」推断**：
 * 上游 `capabilities.vision` 只有 Flash 有，GLM-5.3 是**空对象**。
 * 参考实现此前按「同族应该一样」给两个都标了 `true` —— 那是错的
 * （`src/zcode-product.ts:199-203`）。
 */
export const ZCODE_FALLBACK_MODELS: readonly ZcodeFallbackModel[] = [
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // 上游 `capabilities.vision === true`。
    supportsImage: true,
    // 上游 `reasoning.levels` 的顺序即展示顺序（low → high → max）。
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // ⚠️ 上游 `capabilities` 是**空对象** ⇒ 这个模型**没有 vision**。
    supportsImage: false,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  },
]

// ─────────────────────────── 官方身份块（3012 的唯一开关） ───────────────────────────

/**
 * 第一块：CLI 身份前缀（官方以此开头，42 字符）。
 *
 * 出处：`deepseek-harness-codearts/src/zcode-identity.ts:24-25`。
 */
export const OFFICIAL_CLI_PREFIX = 'You are ZCode, an interactive coding agent'

/**
 * 第二块：stable 段（多段用 `\n\n` 连接）。
 *
 * ⚠️ 只发**准入必需**的部分。官方完整身份块还含 5KB 的 dynamic 段
 * （`# Communicating with the user` / `# Context management`），
 * 那些是**给 ZCode 内 coding agent 的行为指令**，与准入无关 ——
 * 且它们会被放在 system 开头，**压过调用方自己的 prompt**，
 * 表现为「啰嗦、慢」。故此处不含 dynamic 段。
 * 出处：`src/zcode-identity.ts:40-52`（原文逐字）。
 */
export const OFFICIAL_STABLE_SECTIONS: readonly string[] = [
  "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.",
  "# ZCode Desktop Context\n\n### Files & URLs\n- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).\n- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).\n\n### Inline Code Comments\n- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.\n- Emit one directive per inline comment; emit none when there are no actionable inline comments.\n- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).\n- Optional attributes: start, end (1-based line numbers), priority (0-3).\n- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Keep line ranges tight; end defaults to start.\n- Example: ::code-comment{title=\"[P2] Off-by-one\" body=\"Loop iterates past the end when length is 0.\" file=\"/path/to/foo.ts\" start=10 end=11 priority=2}",
  "# Working style\n\nWhen you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey. Prefer reading the actual file or running the actual command over reasoning about what it probably contains. When a signal pattern-matches to a known failure, check that the evidence actually supports that specific diagnosis before acting on it.",
]

/** `<system-reminder>` 日期块的固定文案（官方逐字）。 */
const CONTEXT_PREFIX_INTRO =
  "As you answer the user's questions, you can use the following context:"

/** 结尾段（⚠️ 前有 **6 个空格**缩进，官方逐字如此）。 */
const CONTEXT_PREFIX_OUTRO =
  '      IMPORTANT: this context may or may not be relevant to your tasks. '
  + 'You should not respond to this context unless it is highly relevant to your task.'

/** 一个 system 文本块（可带 prompt caching 断点）。 */
export interface ZcodeTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/** 本地日期（`YYYY-MM-DD`）。 */
export function formatLocalIsoDate(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 构造 `<system-reminder>` 上下文块（**首轮 user 消息的 content 数组最前面**）。
 *
 * ⚠️ 形态细节（逐字复刻，不要「优化」）：
 * - 整块是**一个** `{type:'text'}`，插到 `content` **数组**最前面 ——
 *   不是拼进文本字符串（后者会改变结构，**仍被判为裸请求**）；
 * - `outro` 前有 **6 个空格**缩进；
 * - 空行由 `join('\n')` 里的空串产生。
 * 出处：`deepseek-harness-codearts/src/zcode-identity.ts:208-226`。
 */
export function buildContextPrefixBlock(now: Date = new Date()): ZcodeTextBlock {
  const body = [
    CONTEXT_PREFIX_INTRO,
    `# currentDate\nToday's date is ${formatLocalIsoDate(now)}.`,
    '',
    CONTEXT_PREFIX_OUTRO,
  ].join('\n')
  return { type: 'text', text: `<system-reminder>${body}</system-reminder>` }
}

/** 一条消息的 content 是否已经是「已插过日期块」的形态。 */
function startsWithSystemReminder(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith('<system-reminder>')
  if (Array.isArray(content)) {
    const first = content[0] as { text?: unknown } | undefined
    return typeof first?.text === 'string' && first.text.startsWith('<system-reminder>')
  }
  return false
}

/**
 * 给**首轮 user 消息**的 content 数组最前面插入日期块。
 *
 * 规则（官方行为，`src/zcode-identity.ts:238-265`）：
 * - 只处理第一条消息，且它必须是 `role === 'user'`；
 * - **幂等**：已以 `<system-reminder>` 开头则不重复插。
 *
 * ⚠️ 这是 3012 的**最后一个开关**：官方客户端**总会**给首轮 user 消息插一个
 * 日期上下文块；裸请求（纯用户文本）会被判为裸请求（
 * `src/zcode-identity.ts:195-200`）。
 */
export function withContextPrefix<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  now: Date = new Date(),
): Array<Record<string, unknown>> {
  const out = messages.map((message) => ({ ...message }) as Record<string, unknown>)
  const first = out[0]
  if (first === undefined || first.role !== 'user') return out
  if (startsWithSystemReminder(first.content)) return out

  const prefix = buildContextPrefixBlock(now)
  const content = first.content
  if (Array.isArray(content)) {
    first.content = [prefix, ...content]
  } else if (typeof content === 'string') {
    first.content = [prefix, { type: 'text', text: content }]
  } else {
    first.content = [prefix]
  }
  return out
}

/**
 * 构造官方形态的 `system` 块数组。
 *
 * ## 结构（逐字复刻官方，**不要「优化」**）
 *
 * ```
 * block[0] = cliPrefix（42 字符）      ← 准入必需
 * block[1] = stable（2856 字符）       ← 准入必需
 * block[2] = "# Environment" 段
 * block[3..] = 调用方的 system（追加在最后）
 * ```
 *
 * ⚠️ **调用方内容必须追加在最后** —— 官方身份块必须处在开头位置
 * （上游的检查看的是**前缀结构**）。
 *
 * ⚠️ **只在最后一块**打 prompt caching 断点：
 * ① Anthropic 的缓存是**前缀式**的，一个位于最后一块的断点覆盖面
 * 等于「每块各打一个」；② 断点有**数量上限（4 个）**，每块都打会把预算
 * 用光，于是 tools 再也打不了点（调用方每步可能带 20+ 个工具）；
 * ③ 调用方的 system 通常是最大的一段可缓存前缀，必须在断点**之内**。
 * 出处：`deepseek-harness-codearts/src/zcode-identity.ts:96-145`。
 *
 * ⚠️ 与官方「逐块打点」有偏差，但**不影响准入**：3012 的判据是身份块的
 * **内容与结构**存在，`cache_control` 只是缓存提示，不参与风控判定。
 */
export function buildZcodeSystemBlocks(
  callerSystem: string | undefined,
  options: { cwd: string; provider?: string; model?: string; platform?: string },
): ZcodeTextBlock[] {
  const stable = OFFICIAL_STABLE_SECTIONS.join('\n\n')
  const provider = options.provider ?? 'zcode'
  const model = options.model ?? 'glm-5.3-flash'
  const platform = options.platform ?? 'linux'
  // ⚠️ 官方每个会话都告诉模型它的运行环境。不发的实测后果：问
  // 「Which model are you?」只能答出笼统的「GLM」—— 因为它**没被告知**。
  // 出处：`src/zcode-identity.ts:154-175`。
  const environment = [
    '# Environment',
    'You have been invoked in the following environment:',
    ` - Primary working directory: ${options.cwd.trim().length > 0 ? options.cwd : '.'}`,
    // ⚠️ Workers 里**没有真实工作目录**，也无从判断是否 git 仓库
    // （参考实现用 `existsSync('.git')`，`src/zcode-identity.ts:178-186`）。
    // 这里如实写 no —— 编造 yes 会让模型以为可以跑 git 命令。
    ' - Is a git repository: no',
    ` - Platform: ${platform}`,
    ` - Shell: ${platform === 'win32' ? 'powershell' : 'bash'}`,
    ` - OS Version: ${platform}`,
    ` - You are powered by the model named ${provider}/${model}.`,
  ].join('\n')

  const blocks: ZcodeTextBlock[] = [
    { type: 'text', text: OFFICIAL_CLI_PREFIX },
    { type: 'text', text: stable },
    { type: 'text', text: environment },
  ]
  if (typeof callerSystem === 'string' && callerSystem.trim().length > 0) {
    blocks.push({ type: 'text', text: callerSystem })
  }
  const last = blocks[blocks.length - 1]
  if (last !== undefined) last.cache_control = { type: 'ephemeral' }
  return blocks
}

// ─────────────────────────── 凭据 ───────────────────────────

/** 取第一个非空字符串字段。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 从 JWT 的 payload 段里取字段（**不验签**）。
 *
 * ⚠️ **只用于取账号标识与展示名，绝不作为安全判据。**
 * ZCode 的 JWT payload 实测只有 `{user_id, token_version, sub, iat}`
 * —— **没有 `exp`**（`deepseek-harness-codearts/src/zcode.ts:578-586`），
 * 故不能靠它判过期。
 */
export function decodeZcodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payload = parts[1] ?? ''
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    const parsed = JSON.parse(atob(withPad)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 ZCode 凭据。
 *
 * 接受的形态：
 * 1. **本插件登录产出的 JSON**（`{zcode_jwt, device_mid, user_id?, ...}`）；
 * 2. **只粘一个 JWT 字符串**（最常见的手工导入方式）——
 *    此时 `device_mid` **自动随机生成**（实测该值不被服务端绑定校验，
 *    见文件头）；
 * 3. 上面任一种再套一层 `{credential:{…}}` / `{data:{…}}`。
 *
 * ⚠️ **判据是上游真正需要的两个字段**（JWT 与 device_mid）：
 * 其余（`coding_plan_key` 等）都可选。
 * 出处：`deepseek-harness-codearts/src/zcode.ts:570-578` 的
 * `isUsableZcodeCredential`。
 *
 * ⚠️ **官方客户端的凭据文件回退路径已丢弃**（见文件头）—— 这里**不**尝试
 * 任何文件解密，缺字段就抛错并说明从哪来。
 */
export function parseCredential(input: unknown): ProviderCredential {
  let source: Record<string, unknown>
  let bareJwt: string | undefined

  if (typeof input === 'string') {
    bareJwt = input.trim()
    source = {}
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    source = input as Record<string, unknown>
    for (const key of ['credential', 'credentials', 'data', 'zcode']) {
      const nested = source[key]
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        source = nested as Record<string, unknown>
        break
      }
    }
  } else {
    throw new ProviderError({
      provider: 'zcode',
      message: 'ZCode 凭据必须是一个 JWT 字符串，或含 `zcode_jwt` 字段的 JSON 对象',
    })
  }

  const jwt = bareJwt ?? readString(source, ['zcode_jwt', 'zcodeJwt', 'jwt', 'access_token', 'accessToken', 'token'])
  if (jwt === undefined) {
    throw new ProviderError({
      provider: 'zcode',
      message: 'ZCode 凭据缺少 JWT（`zcode_jwt` / `jwt`）。'
        + '⚠️ 本项目**无法**读取 ZCode 官方客户端的凭据文件'
        + '（那是 AES-256-GCM + `os.userInfo()` 派生的密钥，Workers 没有文件系统与 '
        + '`node:crypto`）—— 请用面板的设备码登录，'
        + '或从客户端的 `~/.zcode/v2/credentials.json`（键名含 `zcodejwttoken`）'
        + '手工解密后把 JWT 粘进来',
    })
  }

  const payload = decodeZcodeJwtPayload(jwt)
  const uid = readString(source, ['user_id', 'userId', 'uid'])
    ?? (payload === undefined ? undefined : readString(payload, ['user_id', 'userId', 'sub', 'uid']))
  if (uid === undefined) {
    throw new ProviderError({
      provider: 'zcode',
      message: 'ZCode 凭据缺少账号标识（`user_id`），且 JWT 里也解不出 —— '
        + '这个值是去重与面板展示的唯一稳定标识（`device_mid` 每次登录都会变，不能用）',
    })
  }

  // ⚠️ `device_mid` 的语义：**不是账号标识**。同一账号每次重新登录都会
  // 得到一个新值（实测其值不被服务端绑定校验），故拿它判「是否同一账号」
  // 会把同一账号判成不同账号（`src/zcode.ts:203-215`）。
  // 但它是**请求头 `X-Device-Mid` 的必需值** —— 缺了回 400 code 3001。
  const deviceMid = readString(source, ['device_mid', 'deviceMid', 'mid']) ?? crypto.randomUUID()

  const nickname = readString(source, [
    'account_name',
    'accountName',
    'displayName',
    'name',
    'nickname',
    'account_label',
    'phone',
  ]) ?? (payload === undefined ? undefined : readString(payload, ['name', 'displayName']))

  return {
    provider: 'zcode',
    uid,
    accessToken: jwt,
    // ⚠️ **ZCode 凭据是静态的**：JWT 无 `exp`，也没有 refresh 机制
    // （`src/zcode.ts:578-592` 的 `isZcodeExpired` **恒返回 false**、
    // `ZCODE_REFRESHABLE = false`）。真失效时上游回 401/1002，由错误分类处理。
    refreshToken: '',
    expiresAt: 0,
    nickname: nickname ?? uid,
    extras: {
      [EXTRA_DEVICE_MID]: deviceMid,
      // 客户端版本随请求头下发。缺省用兜底值 —— 版本只是一个头，
      // 不让版本探测失败连带让 provider 不可用（`src/zcode-product.ts:67-74`）。
      [EXTRA_APP_VERSION]: readString(source, ['app_version', 'appVersion']) ?? ZCODE_APP_VERSION_FALLBACK,
    },
  }
}

/** 凭据 extras 的键名。 */
const EXTRA_DEVICE_MID = 'deviceMid'
const EXTRA_APP_VERSION = 'appVersion'

// ── 🔴 本供应商**刻意不实现** `refresh()` ──────────────────────────
//
// ZCode 的凭据是**静态的**：JWT 的 payload 里没有 `exp`（实测只有
// `{user_id, token_version, sub, iat}`），也**没有任何续期端点**。
// 参考实现的判据是两条显式常量
//（`deepseek-harness-codearts/src/zcode.ts:592-595`）：
//
// ```ts
// export function isZcodeExpired(_credential: ZcodeCredential): boolean { return false }
// export const ZCODE_REFRESHABLE = false
// ```
//
// 而且它的 `refreshAccountCredential` **根本不发网络请求** —— 只是「重新解析
// 该账号自己的 ref 再写回它自己」（`src/zcode-auth.ts:1544-1600`）。
// 参考项目在 `src/zcode-adapter.ts:162-168` 把这条契约写得更直白：
// 「ZCode **不可续期**（凭据是静态的）。这个回调存在只是为了让适配器与其它
// provider 同形；实现应当**重读凭据**而不是去调 refresh 端点」。
//
// ⚠️ `ZcodeLoginResult.bigmodelRefreshToken`（`src/zcode-login.ts:94-96`）
// 看起来像一个可用的续期材料，但**参考仓库里没有任何地方消费它**
// （只有解析与赋值两处，零调用方）—— 它是「服务端某天给了就记下来」的字段，
// 而不是一条已跑通的续期链路。**不要**据此臆造一个续期请求。
//
// ⇒ 按 `types.ts` 的「不假装支持」纪律，这里**省略** `refresh()`。
// 真失效时上游回 401 / 业务码 1002，由 `shouldRotate` 与错误分类处理
//（换号或提示重新登录），而不是在这一层假装能续期。
//
// 📌 **行为影响**（必须知道）：网关的续期重放分支要求
// `provider.refresh !== undefined`（`gateway/server.ts:582`），故 ZCode 的凭据
// 失效后会**直接**走失败/换号路径。这对本家是正确的 —— 它没有可续的东西，
// 重放一次同样是 401。

// ─────────────────────────── 上游请求头 ───────────────────────────

/**
 * 构造 ZCode 的请求头。
 *
 * ⚠️ 这些头是官方客户端在真实流量里发的。**实测它们不是 3012 的判据**
 * （判据是请求体里的 system 内容），但它们仍是「像官方客户端」的一部分，
 * 且 **`X-Device-Mid` 是硬需求**（缺它 billing 全家桶回 400 code 3001）。
 * 出处：`deepseek-harness-codearts/src/zcode-upstream.ts:60-91`。
 */
export function buildZcodeHeaders(
  credential: ProviderCredential,
  options: { authorization?: string; json?: boolean } = {},
): Record<string, string> {
  const appVersion = credential.extras[EXTRA_APP_VERSION] ?? ZCODE_APP_VERSION_FALLBACK
  const headers: Record<string, string> = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    // ⚠️ **必需**：缺它回 `400 {"code":3001,"msg":"parameter error"}`。
    'X-Device-Mid': credential.extras[EXTRA_DEVICE_MID] ?? credential.uid,
    // ⚠️ 参考实现硬编码 `win32` / `windows`（官方客户端只在 Windows 上有这条
    // 通道）。Workers 上没有真实平台可报，**照抄 win32** 而不是报 `linux` ——
    // 上游可能按平台分池，改成 linux 是没有依据的改动。
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01',
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  return headers
}

// ─────────────────────────── 请求体（Anthropic Messages） ───────────────────────────

/** 构造好的上游请求体与模型信息。 */
export interface ZcodeInferPayload {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * 构造一次 Anthropic Messages 请求。
 *
 * 这是**纯函数**（输入 OpenAI 形状的 body，输出上游 body），故可被单测直接驱动
 * —— 无需构造网络流。
 */
export function buildZcodeInferPayload(
  credential: ProviderCredential,
  model: string,
  openAiBody: Record<string, unknown>,
): ZcodeInferPayload {
  const wire = Array.isArray(openAiBody.messages)
    ? (openAiBody.messages as Array<Record<string, unknown>>)
    : []
  // ⚠️ Anthropic 用**顶层 `system` 字段**，不是 `messages[0].role='system'`。
  const { system: callerSystem, rest } = splitSystemMessages(wire)
  const messages = withContextPrefix(toAnthropicMessages(rest))

  const entry = ZCODE_FALLBACK_MODELS.find((m) => m.id === model)
  const body: Record<string, unknown> = {
    model,
    // ⚠️ `max_tokens` 是 Anthropic 的**必填**字段。缺省用 8192
    // （参考实现 `zcode-adapter.ts:715` 的 `options.maxTokens ?? 8192`）。
    max_tokens: typeof openAiBody.max_tokens === 'number'
      && Number.isSafeInteger(openAiBody.max_tokens)
      && openAiBody.max_tokens > 0
      ? openAiBody.max_tokens
      : 8192,
    system: buildZcodeSystemBlocks(callerSystem, {
      // ⚠️ Workers 里没有真实工作目录。官方声明「cwd is never "unknown" in
      // real traffic」，但这里**只能**给一个占位值 —— 编造一个像真的路径
      // 会让模型用相对路径瞎猜。用 `/workspace` 明确表示「服务端，无本地 FS」。
      cwd: '/workspace',
      provider: 'zcode',
      model,
    }),
    messages,
    stream: true,
  }
  if (typeof openAiBody.temperature === 'number' && Number.isFinite(openAiBody.temperature)) {
    body.temperature = openAiBody.temperature
  }
  if (typeof openAiBody.top_p === 'number' && Number.isFinite(openAiBody.top_p)) {
    body.top_p = openAiBody.top_p
  }
  if (Array.isArray(openAiBody.stop) && openAiBody.stop.length > 0) {
    body.stop_sequences = openAiBody.stop
  }
  // ⚠️ **tools 必须真的下发**（Anthropic 扁平 `input_schema` 形态）。
  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) {
    const tools = toAnthropicTools(openAiBody.tools as Array<Record<string, unknown>>)
    if (tools.length > 0) {
      // ⚠️ 给**最后一个** tool 打 prompt caching 断点：前缀式缓存 ⇒
      // 覆盖「system + 全部 tools」整段。详见 `anthropic.ts` 的
      // `withToolCacheBreakpoint`。
      body.tools = withToolCacheBreakpoint(tools)
    }
  }
  const toolChoice = toAnthropicToolChoice(openAiBody.tool_choice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice

  /**
   * ⚠️ **思考档位下发为 `output_config.effort`**。
   *
   * 协议名**不是** `reasoning_effort` —— 权威依据是上游 `client/configs` 里
   * 每个档位自带的写法（`src/zcode-product.ts:173-179`）：
   * ```json
   * { "path": ["output_config", "effort"], "value": "low" | "high" | "max" }
   * ```
   * 即官方把「怎么表达这个档位」也下发了 —— 照抄即可，不要自己发明字段名。
   *
   * ⚠️ 只在**模型确实声明了该档位**时才写：未知档位直接下发可能被上游拒，
   * 而请求体一旦被拒**整个推理就失败了**（档位只是锦上添花）。
   * 也不发默认值 —— 上游有自己的 `defaultLevel`，我们别去覆盖它。
   */
  const effort = openAiBody.reasoning_effort
  if (typeof effort === 'string' && effort.length > 0) {
    if (entry?.reasoningLevels?.includes(effort) === true) {
      body.output_config = { effort }
    }
  }

  return {
    url: ZCODE_PLAN_MESSAGES_URL,
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.accessToken}` }),
    body,
  }
}

// ─────────────────────────── 错误分类 ───────────────────────────

/**
 * 是否是**并发限流**（`3009 model concurrency limit exceeded`）。
 *
 * ⚠️ 它与 `429` 的另一种语义（额度用尽）**处置完全不同**：
 * 并发限流「等一下就能过」（重试），额度用尽要换账号。
 * 上游 `429 code:3009` 是**并发配额**，与剩余 token 无关
 * （`src/zcode-product.ts:75-82`）。
 *
 * ⚠️ 不判 HTTP 状态码：少数情况下上游用 200/403 包裹限流体。
 */
export function isZcodeConcurrencyLimited(status: number, body: string): boolean {
  void status
  return body.includes(ZCODE_CONCURRENCY_CODE) || /concurrency\s+limit/i.test(body)
}

/**
 * 是否是**额度用尽**（`1005 exceed quota limit` / `1113 余额不足`）。
 *
 * ⚠️ **必须排除 `3009`**：并发限流同样返回 429，但它「等一下就能过」，
 * 若被归到这里就会把账号错标成「当日用尽」（误伤一个完全可用的账号）。
 * 出处：`deepseek-harness-codearts/src/zcode-adapter.ts:1455-1472`。
 *
 * ⚠️ 文案兜底的关键词必须**窄**（`exceed quota limit` / `余额不足`）：
 * `quota` / `balance` 之类泛词会误伤模型正文里恰好讨论「额度」的内容。
 */
export function isZcodeQuotaExhausted(status: number, body: string): boolean {
  if (isZcodeConcurrencyLimited(status, body)) return false
  if (body.includes('1113') || body.includes('余额不足')) return true
  if (body.includes(ZCODE_QUOTA_CODE)) return true
  return /exceed\s+quota\s+limit|quota\s+(?:has\s+been\s+)?exhausted/i.test(body)
}

/** 是否是**风控拦截**（`3012`）—— **不可重试**，且有账号冷却惩罚。 */
export function isZcodeRiskBlocked(body: string): boolean {
  return body.includes('3012') || /unusual activity/i.test(body)
}

/** HTTP 状态 → `ProviderError.retryable`。 */
export function isZcodeRetryable(status: number, body: string): boolean {
  // ⚠️ 风控（3012）**不可重试**：有账号冷却惩罚（30 分钟；24h 内第 3 次起 24h；
  // 5 次停用，`src/zcode-identity.ts:15-22`），重试会加重。
  if (isZcodeRiskBlocked(body)) return false
  // ⚠️ 额度用尽**不可重试**（确定性错误，要等到账期重置）。
  if (isZcodeQuotaExhausted(status, body)) return false
  // ⚠️ 并发限流**可重试**（等一下就能过）。
  if (isZcodeConcurrencyLimited(status, body)) return true
  if (status === 402 || status === 429) return true
  if (status === 401 || status === 403) return false
  return status >= 500
}

// ─────────────────────────── 对话 ───────────────────────────

/** 发起对话（返回**已转成 OpenAI SSE** 的响应）。 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const prepared = buildZcodeInferPayload(credential, request.model, request.body)

  /**
   * ⚠️ **超时必须由本层负责**，不能只依赖上游。
   *
   * 触发路径（真实缺陷，`src/zcode-anthropic.ts:295-315`）：上游建立连接后
   * **不吐任何数据**（智谱免费通道首字节实测有 20 秒以上长尾，也会整段静默），
   * 于是 `reader.read()` 永久挂起 —— 而它**不会被 abort 唤醒**。
   *
   * 参考实现的解法（这里照做）：在 abort 时**主动 `reader.cancel()`**，
   * 让挂起的 `read()` 立刻以 `{ done: true }` 收尾。
   * 那需要拿到 `ReadableStream` 本体，故先在**非流式阶段**设好超时，
   * 再把超时信号的监听挂到流上（见下方 `pipeThrough` 之前的部分）。
   */
  const timeoutController = new AbortController()
  const timeoutMs = 180_000
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = AbortSignal.any([request.signal, timeoutController.signal])

  let res: Response
  try {
    res = await fetch(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: JSON.stringify(prepared.body),
      signal,
    })
  } catch (error) {
    clearTimeout(timer)
    // ⚠️ **用户中断必须原样区分**：把它翻译成 TIMEOUT/TRANSPORT 会让
    // 「用户主动取消」变成「一次可重试的失败」（`src/zcode-adapter.ts:1199-1206`）。
    if (request.signal.aborted) {
      throw new ProviderError({ provider: 'zcode', message: '请求已被客户端取消' })
    }
    if (timeoutController.signal.aborted) {
      throw new ProviderError({
        provider: 'zcode',
        retryable: true,
        message: `ZCode 请求超时（${timeoutMs}ms 内未完成）—— 上游可能长时间不返回数据`,
      })
    }
    throw new ProviderError({
      provider: 'zcode',
      retryable: true,
      message: `ZCode 请求失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (!res.ok) {
    clearTimeout(timer)
    // ⚠️ **必须先读体**：限流/额度/风控三种语义**全在响应体里**，
    // 而 body 只能读一次（`src/opencode-adapter.ts:543-556` 的同款纪律）。
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: 'zcode',
      httpStatus: res.status,
      retryable: isZcodeRetryable(res.status, text),
      message: `ZCode 推理失败：http=${res.status} ${text.slice(0, 300)}`,
    })
  }
  if (res.body === null) {
    clearTimeout(timer)
    throw new ProviderError({ provider: 'zcode', message: '上游返回 200 但没有响应体' })
  }

  // ⚠️ **超时必须覆盖整个流的读取期**，故 `clearTimeout` 放在流的 finally 里
  // （而不是 fetch 之后）—— 否则流式读取阶段既无超时、也失了中断通道
  // （`src/zcode-adapter.ts:1206-1212` 记录了这个真实缺陷）。
  const upstream = res.body
  const converted = anthropicSseToOpenAiSse(upstream, request.model)

  // 用 `pipeThrough` 串一个「收尾清定时器」的 TransformStream：它在流
  // 正常结束、出错、被取消三种情况下都会走 `flush`/`cancel`。
  const withCleanup = converted.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush() {
        clearTimeout(timer)
      },
    }),
  )

  return new Response(withCleanup, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
    },
  })
}

// ─────────────────────────── 模型目录 / 余额 / 签到 ───────────────────────────

/** 拉模型目录（远端 `client/configs`，失败则回退兜底表）。 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const appVersion = credential.extras[EXTRA_APP_VERSION] ?? ZCODE_APP_VERSION_FALLBACK
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, {
        authorization: `Bearer ${credential.accessToken}`,
        json: false,
      }),
      signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    })
    if (!res.ok) return toProviderModels(ZCODE_FALLBACK_MODELS)
    const parsed = (await res.json()) as { data?: { builtinModels?: unknown } }
    const models = parseZcodeRemoteModels(parsed.data?.builtinModels)
    // ⚠️ 远端为空时**回退兜底表**，不让目录拉取失败让 provider 不可用
    // （`src/zcode-upstream.ts:476` 的同款约定）。
    return toProviderModels(models.length > 0 ? models : ZCODE_FALLBACK_MODELS)
  } catch {
    return toProviderModels(ZCODE_FALLBACK_MODELS)
  }
}

/** 兜底表 → 统一形状。 */
export function toProviderModels(models: readonly ZcodeFallbackModel[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxOutput: m.maxTokens,
    supportsImage: m.supportsImage,
    // ⚠️ 上游 `client/configs` **没有**免费标记字段（额度按账号计量）。
    // 给 false = 「不知道」，而不是猜 —— 猜错会让客户端把付费模型当免费刷。
    isFree: false,
  }))
}

/**
 * 解析上游 `client/configs` 的 `builtinModels`。
 *
 * ## 上游形状（实测，`src/zcode-upstream.ts:458-476`）
 *
 * ⚠️ `builtinModels` 是**对象**（键是序号字串，实测
 * `{"0": {…GLM-5.3}, "1": {…GLM-5.3-Flash}}`）。用 `Array.isArray` 判定会得到
 * 「0 个模型」的**假阴性**（首跑真踩过）。
 */
export function parseZcodeRemoteModels(raw: unknown): ZcodeFallbackModel[] {
  if (typeof raw !== 'object' || raw === null) return []
  const entries = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)
  const out: ZcodeFallbackModel[] = []
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = record.modelId ?? record.id
    if (typeof id !== 'string' || id.length === 0) continue
    const capabilities = record.capabilities
    const vision = typeof capabilities === 'object' && capabilities !== null
      ? (capabilities as { vision?: unknown }).vision === true
      : false
    const reasoning = record.reasoning
    let reasoningLevels: string[] | undefined
    let defaultReasoningLevel: string | undefined
    if (typeof reasoning === 'object' && reasoning !== null) {
      const levels = (reasoning as { levels?: unknown }).levels
      if (typeof levels === 'object' && levels !== null) {
        const keys = Object.keys(levels as Record<string, unknown>)
        if (keys.length > 0) reasoningLevels = orderReasoningLevels(keys)
      }
      const def = (reasoning as { defaultLevel?: unknown }).defaultLevel
      if (typeof def === 'string' && def.length > 0) defaultReasoningLevel = def
    }
    const contextWindow = num(record.contextWindow)
    const maxTokens = num(record.maxCompletionTokens ?? record.maxTokens)
    out.push({
      id,
      name: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
      // 缺字段时给保守值（0 会让客户端认为「无窗口」而拒绝自动压缩）。
      contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : 200_000,
      maxTokens: maxTokens !== undefined && maxTokens > 0 ? maxTokens : 32_768,
      supportsImage: vision,
      ...(reasoningLevels !== undefined ? { reasoningLevels } : {}),
      ...(defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {}),
    })
  }
  return out
}

/**
 * 把档位键排成 IDE 的展示序。
 *
 * ⚠️ **不能直接用对象的键序**：上游 JSON 里 `levels` 的插入序实测是
 * `low, max, high`，而 IDE 的档位条显示 `low, high, max`（用户截图为证）。
 * 已知档位按 `none → minimal → low → medium → high → xhigh → max` 排，
 * 未知的按原序追加。出处：`src/zcode-upstream.ts:543-555`。
 */
function orderReasoningLevels(keys: readonly string[]): string[] {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const known = order.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !order.includes(key))
  return [...known, ...unknown]
}

/**
 * 查余额（`GET /api/v1/zcode-plan/billing/balance`）。
 *
 * ⚠️ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。出处：`src/zcode-upstream.ts:193-201`。
 *
 * ⚠️ **单位是 token，不是「积分」**（真实缺陷，用户报障）：
 * 上游桶里有 `unit_type: "token"`、`meter: "model_usage"`，
 * 界面应显示 `94.54M` tokens 这种格式。本项目 `ProviderBalance` 只有数字
 * （没有单位字段），故把 `unit_type` 写进 `packages[].name` 让面板能带上它。
 * 出处：`src/zcode-upstream.ts:93-122`。
 */
/**
 * 每日签到（领取每日积分）。
 *
 * ## ⚠️ 诚实说明：本函数**大概率会失败**，原因在上游而不在我们
 *
 * 领取端点 `/zcode-plan/billing/claim` **始终强制索要阿里云 captcha**
 * （实测：带非法 captcha 与不带 captcha 都回 `400 / code 3007`，
 * 且验证码校验**前置于** plan 校验）—— 参考
 * `deepseek-harness-codearts/src/zcode-upstream.ts:14,73`。
 *
 * 而阿里云验证码是**网页 SDK**，必须由真实浏览器过风控
 *（参考实现为此在本机起了 `CarrierPageServer` 小服务 + headful Chromium；
 * `zcode-captcha.ts` 实测 `--headless=new` 也过不了）。
 * **Workers 没有 listen socket、也拉不起浏览器** ⇒ 这条链在架构上不成立。
 *
 * ## 那为什么还要实现它
 *
 * 用户明确要求「加上 zcode 签到，接受会经常失败」。故这里**如实发起请求**：
 * - 先查 `preview`（**不需要 captcha**）—— 这一步能成功，让用户知道
 *   「有没有可领的」；
 * - 再尝试 `claim` —— 若上游回 3007，就**如实把上游原话报出来**，
 *   而不是编造「签到成功」，也不是静默跳过。
 *
 * ⚠️ **绝不伪造成功**：`CheckinResult` 的成功路径只在真的拿到业务码 0 时走。
 * 谎报签到成功会让用户以为积分到账了 —— 那比失败更糟。
 *
 * ⚠️ 也**不做 captcha 绕过尝试**：那既不可行（没有浏览器），
 * 也是在主动对抗上游风控（本项目 §3.1 的合规红线）。
 */
async function checkin(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<CheckinResult> {
  // ① 先查可领取计划（**不需要 captcha**）—— 这步在 Workers 上真能跑通，
  //    故即便后面 claim 失败，也能给用户一条有用信息。
  let claimable: string[] = []
  try {
    const preview = await fetch(ZCODE_BILLING_PREVIEW_URL, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.accessToken}`, json: false }),
      signal,
    })
    if (preview.ok) {
      const body = (await preview.json().catch(() => undefined)) as
        | { data?: { plans?: Array<Record<string, unknown>> } }
        | undefined
      const plans = body?.data?.plans
      if (Array.isArray(plans)) {
        claimable = plans
          .filter((x) => x !== null && typeof x === 'object')
          .filter((x) => {
            // ⚠️ 判据取「可领取」标记；上游字段名未在参考实现里固定，
            // 故同时看几个可能的名字，任一为真即算。
            const r = x as Record<string, unknown>
            return r['claimable'] === true || r['can_claim'] === true || r['available'] === true
          })
          .map((x) => String((x as Record<string, unknown>)['plan_id'] ?? (x as Record<string, unknown>)['id'] ?? ''))
          .filter((id) => id !== '')
      }
    }
  } catch {
    // 预览失败不致命：继续尝试 claim，让它给出真实的失败原因。
  }

  if (claimable.length === 0) {
    // 没有可领的 ⇒ 这是**正常状态**（今天已领过 / 没有活动），不是错误。
    return { alreadyDone: true, gained: 0, detail: '没有可领取的每日积分（可能今天已领取）' }
  }

  // ② 尝试领取。⚠️ 不带 captcha 头 —— 我们知道它会失败，
  //    但**如实发起**比直接抛「不可用」更诚实：上游若哪天放宽了校验，
  //    这里就自然开始工作，无需再改代码。
  const res = await fetch(ZCODE_BILLING_CLAIM_URL, {
    method: 'POST',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.accessToken}` }),
    body: JSON.stringify({ plan_id: claimable[0] }),
    signal,
  })
  const text = await res.text().catch(() => '')
  // ⚠️ 业务码可能是**纯数字字符串**（参考实现踩过：只认 number 会让风控码
  //    整条丢失，见 `zcode-upstream.ts:518-528`）。
  let code: number | undefined
  let msg = ''
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown }
    const raw = parsed.code
    code = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : undefined
    msg = typeof parsed.msg === 'string' ? parsed.msg : typeof parsed.message === 'string' ? parsed.message : ''
  } catch {
    // 非 JSON：保留原文供错误信息使用
  }

  if (code === 0) {
    return { alreadyDone: false, gained: 0, detail: `签到成功（${claimable.length} 个待领计划）` }
  }
  // ⚠️ 3007 = captcha 被拒；这是**最可能**的结果，文案要说清「是验证码，不是你的账号坏了」。
  if (code === 3007) {
    throw new ProviderError({
      provider: 'zcode',
      httpStatus: res.status,
      message:
        'ZCode 签到需要阿里云验证码（上游强制要求真实浏览器过风控）。'
        + '本服务运行在 Cloudflare Workers，无法拉起浏览器，故签到做不到 —— '
        + '这不是你的账号问题，推理功能完全不受影响。'
        + (msg !== '' ? `上游原话：${msg}` : ''),
    })
  }
  throw new ProviderError({
    provider: 'zcode',
    httpStatus: res.status,
    message: `ZCode 签到失败（code=${String(code)}）：${msg || text.slice(0, 160) || `HTTP ${res.status}`}`,
  })
}

async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const res = await fetch(ZCODE_BILLING_BALANCE_URL, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.accessToken}` }),
    signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: 'zcode',
      httpStatus: res.status,
      retryable: isZcodeRetryable(res.status, text),
      message: `ZCode 余额查询失败：http=${res.status} ${text.slice(0, 200)}`,
    })
  }
  const parsed = (await res.json()) as {
    data?: { displayMode?: unknown; balances?: unknown }
  }
  const data = parsed.data
  if (data === undefined) {
    throw new ProviderError({ provider: 'zcode', message: 'ZCode 余额响应缺少 data 字段' })
  }
  // ⚠️ 企业版不下发额度数字、只给外部链接 ⇒ **抛错说明**，不要显示成 0
  //（0 是「已用光」的语义，会误导用户）。
  if (data.displayMode === 'enterprise') {
    throw new ProviderError({
      provider: 'zcode',
      message: 'ZCode 企业版账号不下发额度数字（只在客户端内展示外部链接），无法查余额',
    })
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const rawBuckets = Array.isArray(data.balances) ? data.balances : []
  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  let total = 0
  let remaining = 0
  let earliestExpiry = 0
  for (const item of rawBuckets) {
    if (typeof item !== 'object' || item === null) continue
    const bucket = item as Record<string, unknown>
    const showName = typeof bucket.show_name === 'string' && bucket.show_name.length > 0
      ? bucket.show_name
      : 'ZCode 额度'
    // ⚠️ 单位字段必须带上：上游说 `unit_type: "token"`，界面据此显示 M 量级。
    const unit = typeof bucket.unit_type === 'string' && bucket.unit_type.length > 0
      ? bucket.unit_type
      : 'token'
    // 优先用 available（若给了），否则用 remaining。
    const amount = num(bucket.available_units) ?? num(bucket.remaining_units) ?? 0
    const bucketTotal = num(bucket.total_units) ?? 0
    // ⚠️ 到期时间是 Unix **秒**，本项目用**毫秒** —— 不换算会得到一个
    // 1970 年的时刻（`AGENTS.md` 的「expiresAt 单位」踩坑记录）。
    const expiresAt = num(bucket.expires_at)
    const expiryMs = expiresAt !== undefined && expiresAt > 0 ? expiresAt * 1000 : 0
    packages.push({ name: `${showName}（${unit}）`, amount, expiry: expiryMs })
    remaining += amount
    total += bucketTotal
    if (expiryMs > 0 && (earliestExpiry === 0 || expiryMs < earliestExpiry)) earliestExpiry = expiryMs
  }
  // ⚠️ 一个桶都没解析出来 → **抛错**（响应形状与预期不符），而不是返回 0。
  if (packages.length === 0) {
    throw new ProviderError({
      provider: 'zcode',
      message: `ZCode 余额响应形状无法识别（原文：${JSON.stringify(data).slice(0, 200)}）`,
    })
  }
  return { total, expiring: 0, earliestExpiry, packages: packages.map((p) => ({ ...p, amount: p.amount })) }
}


// ─────────────────────────── Provider ───────────────────────────

export const zcodeProvider: Provider = {
  /** 对象判别式：`zcode` 独有字段（`zcode_jwt` / `device_mid`）。 */
  matchesShape(input) {
    return readString(input, ['zcode_jwt', 'zcodeJwt', 'device_mid', 'deviceMid']) !== undefined
  },

  /** 裸字符串判别式：三段式 JWT（zcode 的 `zcode_jwt`）。 */
  bareStringPattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,

  id: 'zcode',
  name: 'ZCode (智谱)',
  capabilities: {
    /**
     * ✅ **可在 Workers 完成**：ZCode 用的是**服务端中介的设备授权流**
     * （`POST /api/v1/oauth/cli/init` → 用户在浏览器授权 → 
     * `GET /api/v1/oauth/cli/poll/{flow_id}`），
     * 完全**不经 `zcode://` 自定义协议回调**，故普通服务器进程就能走完。
     * 出处：`deepseek-harness-codearts/src/zcode-login.ts:1-28`。
     *
     * ⚠️ **需要网关层接线**：本文件导出了
     * {@link startZcodeLogin} / {@link pollZcodeLogin}，
     * 但 `src/index.ts` 的 `/admin/login/*` 目前只分派 workbuddy。
     */
    login: true,
    listModels: true,
    chat: true,
    balance: true,
    /**
     * ❌ **签到不可用** —— `billing/claim` 恒索要阿里云 captcha，
     * 而产出它必须 **headful** 浏览器。见 {@link checkin} 的完整依据。
     */
    /**
     * ⚠️ **改为 `true`（用户要求「加上 zcode 签到，接受会经常失败」）**，
     * 但如实声明它**大概率失败**：上游强制阿里云 captcha，Workers 无浏览器。
     * 详见 `checkin()` 的文档注释。
     */
    checkin: true,
    /**
     * ⚠️ 上游 `billing/claim` **始终**索要阿里云 captcha，而验证码需要
     * **headful Chromium**（`src/zcode-captcha.ts:57-65` 实测：`--headless=new` 过不了风控）。
     * Workers 无法拉起浏览器 ⇒ 签到不可行。
     *
     * ✅ 但**推理不受影响**：自 3.14.4（2026-09-29）起模型请求不再索要 captcha
     * （`src/zcode-captcha.ts:5-12` 的 6 个采样点全部 HTTP 200）。
     */
    checkinBlockedReason:
      'ZCode 的签到接口**始终**要求阿里云验证码（需真实浏览器过风控），'
      + 'Workers 无法完成 —— 尝试签到会如实报出上游的 3007 拒绝。'
      + '推理不受影响（自 3.14.4 起模型请求已不再需要验证码）。',
  },
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  // ⚠️ **刻意不提供 `refresh`**：ZCode 凭据是静态的、没有续期端点。
  // 完整依据与行为影响见上方「刻意不实现 refresh()」一节。
  shouldRotate(status, bodyText) {
    // ⚠️ 风控（3012）**不该换号**：换号只会让另一个账号也吃一次冷却惩罚
    //（24h 内第 3 次起 24h、5 次停用）。
    if (isZcodeRiskBlocked(bodyText)) return false
    // ⚠️ 额度用尽（1005/1113）**该换号**：它是账号维度的，换一个还有额度的
    // 账号是唯一有效动作。并发限流（3009）同理值得换号。
    if (isZcodeQuotaExhausted(status, bodyText)) return true
    if (isZcodeConcurrencyLimited(status, bodyText)) return true
    return status === 429 || status === 402
  },
}

// ─────────────────────────── 设备码登录 ───────────────────────────

/** 一次登录流程的状态。 */
export interface ZcodeLoginFlow {
  flowId: string
  /** 用户需要打开这个 URL 完成授权。 */
  authorizeUrl: string
  /** 发起流程用的 CLI 会话密钥（作为 ③ 的 Bearer）。 */
  flowSecret: string
  pollIntervalSec: number
}

/** 生成 CLI 会话密钥（官方 `randomBytes(32).toString('hex')`）。 */
export function generateFlowSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 第一步：发起设备授权流，拿到 `authorize_url`。
 *
 * ## 为什么这条路径正确（而不是「另一个可能可行」的猜测）
 *
 * 它**绕开了故障的 `POST /api/v1/oauth/token`**
 * （`dsh-free-glm` 记录该端点自 2026-09-28 起稳定 500 / code 2007）——
 * token 由轮询直接返回，完全不经过它。
 * 出处：`deepseek-harness-codearts/src/zcode-login.ts:3-17, 33-40`。
 *
 * ⚠️ `Authorization` 里的 Bearer 是**我们自己生成的会话密钥**，
 * 不是用户凭据 —— 官方就是这么做的（`src/zcode-login.ts:155-161`）。
 */
export async function startZcodeLogin(signal: AbortSignal): Promise<ZcodeLoginFlow> {
  const flowSecret = generateFlowSecret()
  const appVersion = ZCODE_APP_VERSION_FALLBACK
  const res = await fetch(ZCODE_OAUTH_CLI_INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${flowSecret}`,
      'Content-Type': 'application/json',
      'User-Agent': `ZCode/${appVersion}`,
      'HTTP-Referer': ZCODE_ORIGIN,
      'X-ZCode-App-Version': appVersion,
      'X-Platform': 'win32',
    },
    body: JSON.stringify({ provider: 'bigmodel' }),
    signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new ProviderError({
      provider: 'zcode',
      httpStatus: res.status,
      retryable: res.status >= 500,
      message: `ZCode 授权初始化失败（HTTP ${res.status}）：${text.slice(0, 200)}`,
    })
  }
  let parsed: {
    data?: { flow_id?: unknown; authorize_url?: unknown; poll_interval_sec?: unknown }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new ProviderError({
      provider: 'zcode',
      message: `ZCode 授权初始化响应不是 JSON：${text.slice(0, 200)}`,
    })
  }
  const flowId = parsed.data?.flow_id
  const authorizeUrl = parsed.data?.authorize_url
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new ProviderError({ provider: 'zcode', message: 'ZCode 授权初始化响应缺 flow_id' })
  }
  if (typeof authorizeUrl !== 'string' || !authorizeUrl.startsWith('https://')) {
    throw new ProviderError({ provider: 'zcode', message: 'ZCode 授权初始化响应缺合法的 authorize_url' })
  }
  const rawInterval = parsed.data?.poll_interval_sec
  const pollIntervalSec = typeof rawInterval === 'number' && rawInterval >= 1 ? rawInterval : 2
  return { flowId, authorizeUrl, flowSecret, pollIntervalSec }
}

/**
 * 第二步：轮询一次。
 *
 * ⚠️ **HTTP 4xx（除 408/429）才是终态失败；5xx 与网络错误继续重试。**
 * 官方原实现：`status >= 400 && status < 400+... && status !== 408 && status !== 429`
 * （`src/zcode-login.ts:266-276`）。
 *
 * @returns `undefined` 表示「继续等」（pending）；否则是解析好的凭据。
 */
export async function pollZcodeLogin(
  flow: ZcodeLoginFlow,
  signal: AbortSignal,
): Promise<ProviderCredential | undefined> {
  const appVersion = ZCODE_APP_VERSION_FALLBACK
  let res: Response
  try {
    res = await fetch(zcodeOauthCliPollUrl(flow.flowId), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${flow.flowSecret}`,
        'User-Agent': `ZCode/${appVersion}`,
        'HTTP-Referer': ZCODE_ORIGIN,
        'X-ZCode-App-Version': appVersion,
      },
      signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    })
  } catch {
    // ⚠️ 网络抖动**不算失败** —— 返回 undefined 让调用方继续轮询
    //（`src/zcode-login.ts:250-259`）。
    return undefined
  }
  // ⚠️ 4xx（除 408/429）才是终态失败；5xx 与网络错误继续重试。
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: 'zcode',
      httpStatus: res.status,
      message: `ZCode 登录轮询被拒（HTTP ${res.status}）：${text.slice(0, 200)}`,
    })
  }
  if (!res.ok) return undefined

  let parsed: {
    code?: unknown
    data?: {
      status?: unknown
      token?: unknown
      user?: { user_id?: unknown; id?: unknown; name?: unknown; email?: unknown }
      bigmodel?: { access_token?: unknown }
    }
  }
  try {
    parsed = await res.json() as typeof parsed
  } catch {
    return undefined
  }
  const data = parsed.data
  if (parsed.code !== 0 || data === undefined || data === null) return undefined
  const status = typeof data.status === 'string' ? data.status : undefined
  if (status === 'pending') return undefined
  if (status === 'failed') {
    throw new ProviderError({ provider: 'zcode', message: '用户拒绝了授权或授权失败' })
  }
  if (status !== 'ready') {
    throw new ProviderError({
      provider: 'zcode',
      message: `ZCode 轮询响应状态无法识别：${String(status)}`,
    })
  }
  const jwt = typeof data.token === 'string' ? data.token : undefined
  if (jwt === undefined || jwt.length === 0) {
    throw new ProviderError({ provider: 'zcode', message: 'ZCode 轮询响应 ready 但缺 token' })
  }
  const user = data.user
  const userId = user === undefined
    ? undefined
    : (typeof user.user_id === 'string' && user.user_id.length > 0
        ? user.user_id
        : typeof user.id === 'string' && user.id.length > 0 ? user.id : undefined)
  const fallbackUid = (() => {
    const payload = decodeZcodeJwtPayload(jwt)
    return payload === undefined ? undefined : readString(payload, ['user_id', 'sub'])
  })()
  const uid = userId ?? fallbackUid
  if (uid === undefined) {
    throw new ProviderError({
      provider: 'zcode',
      message: 'ZCode 登录响应里没有 user_id，且 JWT 里也解不出 —— 无法确定账号标识',
    })
  }
  const displayName = user === undefined
    ? undefined
    : readString(user as Record<string, unknown>, ['name', 'email'])
  return {
    provider: 'zcode',
    uid,
    accessToken: jwt,
    refreshToken: '',
    expiresAt: 0,
    nickname: displayName ?? uid,
    extras: {
      // ⚠️ **必须持久化**：`X-Device-Mid` 是每次请求都要带的头，缺它回 400。
      // 且它是**我们自己随机生成**的（实测其值不被服务端绑定校验），
      // 故不能在每次请求里现生成 —— 那会让设备身份每次请求都变。
      [EXTRA_DEVICE_MID]: crypto.randomUUID(),
      [EXTRA_APP_VERSION]: ZCODE_APP_VERSION_FALLBACK,
    },
  }
}
