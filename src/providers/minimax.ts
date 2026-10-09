/**
 * MiniMax Code（中国版）供应商适配器。
 *
 * ## 为什么这个文件比别家复杂（本供应商唯一的「协议族外」成员）
 *
 * 上游推理端点是 **Anthropic Messages**，不是 OpenAI：
 *
 * ```
 * POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
 * ```
 *
 * 本项目的网关对外是 **OpenAI 兼容**的，故这一层必须做一次真实的协议翻译
 * （消息 / system / 工具 / 工具结果 / 图片），**不能**像 cline 那样原样透传
 * （`src/minimax-messages.ts:2-15` 明确记录：硬套 OpenAI 形状会把
 * `tools` / `tool_calls` / `input_json_delta` 全部翻译错）。
 *
 * ## 数据来源（全部为参考项目对本机 MiniMax Code 桌面端的逆向 + 实测）
 *
 * - 主机与端点：`src/minimax-product.ts:152-198`；
 * - 请求头（**刻意不加 `anthropic-version`**）：`src/minimax.ts:147-163`；
 * - 消息序列化与工具/图片形状：`src/minimax-messages.ts:69-356`；
 * - 签到与余额：`src/minimax-credits.ts:1-461`；
 * - 思考档位的三种 mode：`AGENTS.md` 的「8.1」一节。
 *
 * ## 登录（**已接线**到 `/admin/providers/login/{start,poll}`）
 *
 * 走 **OAuth 设备码 + PKCE**（`src/minimax-oauth.ts`）：申请设备码 → 用户授权
 * → 轮询换 token。**不起本地监听端口** ⇒ 可在 Workers 跑，故 `login: true`。
 *
 * ⚠️ 轮询是**每请求一次**（面板每 3 秒发独立 HTTP 请求），不是循环：
 * `intervalSec` / `nextPollAt` / `deadline` / `deviceCode` / `codeVerifier`
 * **全部持久化在登录会话载荷**里 —— Workers 无跨请求内存，放模块变量会静默失效。
 *
 * ⚠️ 三个实测判据（写错会得到「用户还没来得及点授权就报失败」）：
 * 1. **`pending` 是 HTTP 200 + `status: "pending"`**，而标准 OAuth 是
 *    「非 200 + `error=authorization_pending`」—— **两种形态都要认**
 *    （`src/minimax-oauth.ts:10-16`）。只看状态码会把「还在等授权」误判成
 *    「拿到 token 了」，报错是 `令牌响应缺少 access_token`；
 * 2. PKCE 是 **S256**，`code_challenge` 由 `code_verifier` 做 SHA-256 后
 *    **base64url** 得到（`src/minimax-oauth.ts:196-201`）—— Workers 上用
 *    `crypto.subtle.digest('SHA-256', …)` 实现，**不需要**任何 `node:crypto`；
 * 3. `slow_down` 的退避是 **`intervalMs += 5000`**（与 Cline 的 1000 不同），
 *    且**累积**（`src/minimax-oauth.ts:276-280`）。
 *
 * ⚠️ 设备码与 token 轮询挂 **`https://account.minimax.cn`**，而业务端点挂
 * `https://agent.minimax.cn` —— 两个 host **不可混用**（`minimax-product.ts:127-130`）。
 * token 响应必须校验 `token_type.toLowerCase() === 'bearer'` 与
 * `scope` 含 `agent.default`，且过期时间要用 `expires_in` 自算 ——
 * 实测 `access_token` **不是 JWT**（前缀 `mmoat_`、60 字符、0 个点），
 * 从 JWT 解 `exp` **恒失败**（`src/minimax.ts:51-63`）。
 */

import { anthropicSseToOpenAiSse } from './anthropic.js'
import {
  ProviderError,
  type ChatRequest,
  type CheckinResult,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

// ─────────────────────────── 协议常量 ───────────────────────────

/** 供应商 id（注册表键、`provider/model` 前缀）。 */
const ID = 'minimax'

/** 单次续期超时（对齐参考实现 `MINIMAX_OAUTH_TIMEOUT_MS`）。 */
const MINIMAX_REFRESH_TIMEOUT_MS = 30_000

/** API 主机（目录 / 签到 / 积分 / 推理都挂它下面）。 */
const API_HOST = 'https://agent.minimax.cn'

/**
 * **账号域**（OAuth 专用）。
 *
 * ⚠️ 与 {@link API_HOST} **不是同一个 host，不可混用**：
 * 设备码与 token 轮询挂 `account.minimax.cn`，业务端点挂 `agent.minimax.cn`
 *（`src/minimax-product.ts:127-130`）。
 */
const ACCOUNT_HOST = 'https://account.minimax.cn'
/** 设备码申请路径。 */
const DEVICE_CODE_PATH = '/oauth2/device/code'
/** token 轮询 / 续期路径。 */
const TOKEN_PATH = '/oauth2/token'
/** OAuth client_id（官方常量，取自 `auth.json` 与 asar）。 */
const MINIMAX_CLIENT_ID = 'mcode-public'
/** OAuth audience（asar `contracts.js` 的 `MCODE_OAUTH_AUDIENCE`）。 */
const MINIMAX_AUDIENCE = 'agent-backend'
/** OAuth scope（**凭据校验要求必须含它**，否则 `invalid_token_response`）。 */
const MINIMAX_SCOPE = 'agent.default'

/** 目录查询参数（远端要求显式 region/buildEnv，否则目录为空）。 */
const REGION = 'cn'
const BUILD_ENV = 'prod'

/** 推理路径（**Anthropic Messages**，不是 OpenAI）。 */
const INFER_PATH = '/mavis/api/v1/llm/v1/messages'
/** 远端模型目录（**必须带 `?region=&buildEnv=`**）。 */
const MODELS_PATH = '/mavis/api/v1/models'
/**
 * 签到领取（**必须带 `?timezone_id=`**，body 为空对象）。
 *
 * ⚠️ 同族的**状态**端点（`/minimax-cloud/api/v1/signin/status?timezone_id=…`）
 * 这里**刻意不定义** —— 本适配器没有消费它的方法，写一个没人读的路径常量
 * 就是死配置（参考项目记录过「没人读的配置会让人误以为存在某条调用链」）。
 * 需要「签到面板」时按 `src/minimax-credits.ts:342-356` 的实测形状补上即可。
 */
const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'
/** 积分明细。 */
const CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details'

/** 业务请求超时（对齐参考 `MINIMAX_REQUEST_TIMEOUT_MS = 30_000`）。 */
const TIMEOUT_MS = 30_000

/**
 * 签到所报时区。
 *
 * ⚠️ **不能**用 `Intl.DateTimeFormat().resolvedOptions().timeZone` —— 官方桌面端
 * 取的是**用户本机时区**（`src/minimax-credits.ts:88-105`），而 Cloudflare Workers
 * 里它**恒为 `UTC`**。服务端按上报时区结算「今天」，报 UTC 会让中国用户
 * 在 00:00–08:00 之间被判成「还没到新的一天」，表现为「签到按钮明明能点却已领过」。
 * 故这里写死 `Asia/Shanghai`，并允许凭据里的 `extras.timezoneId` 覆盖。
 */
const DEFAULT_TIMEZONE_ID = 'Asia/Shanghai'

// ─────────────────────── 内嵌兜底模型目录 ───────────────────────

/** 一个归一后的模型条目（远端与兜底表共用形状）。 */
interface MinimaxModel {
  id: string
  name: string
  /** 上下文窗口；**0 = 未知**（调用方必须判 `> 0` 才使用）。 */
  contextWindow: number
  /** 单次输出上限（远端 `limit.output`）。 */
  maxOutput: number
  supportsImage: boolean
  /** 思考档位（远端 `effort_options`）—— **只有 M3.1-Flash-Preview 有**。 */
  effortOptions?: readonly string[]
  defaultEffort?: string
  /**
   * 思考开关模式（远端 `thinking_config.mode`）：
   * `forced_on` = 关不掉；`switchable` = 可开关。缺失 = 未知（不声明）。
   */
  thinkingMode?: string
}

/**
 * 兜底模型目录（`src/minimax-product.ts:76-119`）。
 *
 * ⚠️ **必须含 `MiniMax-M3.1-Flash-Preview`**：它**不在**客户端内置静态表里
 * （asar 的 `MINIMAX_MODELS` 只有 M3 / M2.7-highspeed / M2.7），而它正是
 * 官方界面上被选中的那个。若兜底表也漏掉它，远端一失败用户就**看不到自己在用的模型**。
 *
 * ⚠️ **只有 M3.1-Flash-Preview 有档位** —— 其余三个远端**没有 `effort_options`**。
 * 给它们编档位就是凭空猜测（Qoder「`qmodel` 没有档位就是没有，不要按截图猜」同型教训）。
 *
 * ⚠️ **窗口取档位表最大档**：M3.1 的 `limit.context` 是 512000，但
 * `context_window_options` 是 `[512000, 1000000]` —— 填 512K 会让客户端
 * 远早于官方能力触发压缩。
 */
const FALLBACK_MODELS: readonly MinimaxModel[] = [
  {
    id: 'MiniMax-M3.1-Flash-Preview',
    name: 'M3.1-Flash-Preview',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsImage: true,
    effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'default',
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M3',
    name: 'M3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsImage: true,
    // 实测可开关思考（不传/disabled → 0 思考块，adaptive → 2785+ 字符），
    // 但**没有档位** ⇒ 只有开/关两态。
    thinkingMode: 'switchable',
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'M2.7-highspeed',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsImage: false,
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M2.7',
    name: 'M2.7',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsImage: false,
    thinkingMode: 'forced_on',
  },
]

/**
 * 必须先声明 adaptive thinking 的模型前缀。
 *
 * ⚠️ 按**前缀**而非全等：`MiniMax-M3.1-Flash-Preview` 是 preview 名，正式版
 * 可能叫 `MiniMax-M3.1`；而 `MiniMax-M3` **不能**被命中（它不需要 adaptive，
 * 实测不传 thinking 即 200）—— 故必须是 `M3.1` 而不是 `M3`。
 */
const ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'

// ─────────────────────────── 小工具 ───────────────────────────

/** 数组/null 一律不当对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 读非空字符串（去空白）。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 沿嵌套路径读非空字符串。 */
function readNested(
  source: Record<string, unknown>,
  path: readonly string[],
  keys: readonly string[],
): string | undefined {
  let current: Record<string, unknown> | undefined = source
  for (const segment of path) {
    if (current === undefined) return undefined
    current = asRecord(current[segment])
  }
  return current === undefined ? undefined : readString(current, keys)
}

/** 只放行**安全正整数**（`0` / 负数 / `NaN` 一律视为「没有」）。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 有限数字（含数字字符串；`Number('')` 是 0，故先挡空串）。 */
function looseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 读有限数字（同时接受 camelCase / snake_case 键）。 */
function readNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = looseNumber(source[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** 时间字段 → 毫秒时间戳（接受 ISO 字符串 / 秒 / 毫秒 / 纯数字串）。 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined
      return parsed < 1e12 ? Math.round(parsed * 1000) : Math.round(parsed)
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** base64url → UTF-8 文本；失败返回 undefined。 */
function base64UrlToText(segment: string): string | undefined {
  try {
    const normalized = segment.replaceAll('-', '+').replaceAll('_', '/')
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(normalized + padding)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * 由令牌派生一个稳定的本地主键（**仅兜底**）。
 *
 * ⚠️ 与 cline 同因：`parseCredential` 是**同步**接口，而 `crypto.subtle` 只有
 * 异步 API。该值只作本地账号主键（不鉴权、不上行、不参与任何安全判定）。
 * 实测 MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点），
 * 故它连 `sub` 都解不出来 —— 这条兜底路径在真实凭据上是**主路径**。
 */
function stableKeyOf(secret: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < secret.length; i += 1) {
    const code = secret.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
  }
  return `minimax-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

// ─────────────────────────── 请求头 ───────────────────────────

/**
 * 业务端点请求头（目录 / 签到 / 积分）。
 *
 * ⚠️ MiniMax 的业务端点**只需 Bearer**（实测签到 / 积分 / 目录均如此），
 * 不需要 machine 头或签名（`src/minimax.ts:134-145`）。
 */
function businessHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
}

/**
 * 推理端点请求头（**Anthropic Messages**）。
 *
 * ⚠️ **刻意不加 `anthropic-version`**：实测（2026-09-29 真实请求）只带
 * `Authorization` + `Content-Type` + `Accept` 即 HTTP 200
 * （`src/minimax.ts:147-163`）。照 Anthropic 官方文档补那个头**是猜测**，
 * 本项目的纪律是「不凭猜测给上游发字段」。
 *
 * ⚠️ `Accept: text/event-stream`（**不是** `application/json`）：请求体带
 * `stream: true`，响应是 SSE。
 */
function inferHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
}

/** 凭据里的访问令牌（缺了就抛错，不让空令牌去打上游）。 */
function accessTokenOf(credential: ProviderCredential): string {
  const token = credential.accessToken.trim()
  if (token.length === 0) {
    throw new ProviderError({
      provider: ID,
      message: 'MiniMax 凭据缺少访问令牌（accessToken），请重新导入或登录',
    })
  }
  return token
}

/** 签到上报的时区（凭据可覆盖；见 {@link DEFAULT_TIMEZONE_ID} 的注释）。 */
function timezoneOf(credential: ProviderCredential): string {
  const value = credential.extras.timezoneId
  return value !== undefined && value.trim().length > 0 ? value.trim() : DEFAULT_TIMEZONE_ID
}

// ─────────────────────────── 凭据解析 ───────────────────────────

/**
 * 从用户粘贴的任意形状里解析出 MiniMax 凭据。
 *
 * ## 认识的形态
 *
 * ```jsonc
 * // ① 官方客户端登录态 `~/.minimax/auth/prod/cn/mcode-public/auth.json`（蛇形）
 * { "access_token": "mmoat_…", "refresh_token": "mmort_…", "token_type": "Bearer",
 *   "expires_at": "1790000000000", "scope": "agent.default" }
 *
 * // ② 扁平驼峰（手写 / 别的工具导出）
 * { "accessToken": "mmoat_…", "refreshToken": "mmort_…", "expiresAt": 1790000000000 }
 *
 * // ③ 嵌套（整包 / 记录 envelope）
 * { "auth": { "access_token": "…" }, "account": { "uid": "…" } }
 * // ④ 只粘贴一个令牌字符串
 * "mmoat_…"
 * ```
 *
 * ## 严格的地方
 *
 * **访问令牌绝不用空串兜底**：那会产出一份永远 401 的凭据。缺令牌时直接抛错，
 * 并把「缺什么」写清楚。`uid` 的兜底链见 {@link buildCredential}：
 * 它只用于本地主键，拿不到稳定身份时用令牌派生 —— 那**不会**让人误以为
 * 「账号身份已知」，也不会产生空 uid（空 uid 会让账号池的键塌成同一个）。
 */
// ─────────────────────── 设备码登录（OAuth 2.0 Device Grant + PKCE） ───────────────────────

/** 一次设备码授权的材料（**必须整体持久化**，见 `pollMinimaxLogin` 的说明）。 */
export interface MinimaxDeviceAuth {
  /** 服务端下发的设备码（轮询时回传）。 */
  deviceCode: string
  /** PKCE 的 verifier —— ⚠️ 轮询时**必须**带上，丢了换不到 token。 */
  codeVerifier: string
  /** 展示给用户的短码（如 `ABCD-1234`）。 */
  userCode: string
  /** 用户要在浏览器打开的地址。 */
  verificationUri: string
  /** 带短码的完整地址（有就用它，省得用户手输）。 */
  verificationUriComplete: string
  /** 设备码有效期（秒）。 */
  expiresInSec: number
  /** 服务端要求的轮询间隔（秒）。 */
  intervalSec: number
}

/** 一次性轮询的结果。 */
export type MinimaxPollOutcome =
  | { kind: 'pending'; intervalSec: number }
  | { kind: 'success'; credential: ProviderCredential }
  | { kind: 'failed'; message: string }

/** PKCE：生成 `code_verifier` 与它的 S256 `code_challenge`（base64url）。 */
async function createMinimaxPkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  // 43–128 字符的 URL-safe 随机串（RFC 7636）。这里用 32 字节 → base64url 43 字符。
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const codeVerifier = base64Url(bytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return { codeVerifier, codeChallenge: base64Url(new Uint8Array(digest)) }
}

/** base64url（无填充）—— PKCE 与 JWT 段都用这个形态。 */
function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** 从 JSON 里安全读非空字符串。 */
function mmString(source: Record<string, unknown>, key: string): string {
  const v = source[key]
  return typeof v === 'string' && v !== '' ? v : ''
}

/** 从 JSON 里安全读正数。 */
function mmNumber(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * 申请设备码。
 *
 * ⚠️ 走 **`account.minimax.cn`**，不是业务域 `agent.minimax.cn`（两个 host 不可混用）。
 */
export async function startMinimaxLogin(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MinimaxDeviceAuth> {
  const pkce = await createMinimaxPkce()
  const body = new URLSearchParams({
    client_id: MINIMAX_CLIENT_ID,
    scope: MINIMAX_SCOPE,
    audience: MINIMAX_AUDIENCE,
    code_challenge: pkce.codeChallenge,
    // ⚠️ 必须是 `S256`（**不是** RFC 标准的 `S256` 缩写之外的写法）；
    // 错值会被服务端当成明文 challenge 比对，永远授权失败。
    code_challenge_method: 'S256',
  })

  const res = await fetcher(`${ACCOUNT_HOST}${DEVICE_CODE_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  })
  if (!res.ok) {
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `MiniMax 设备码申请失败（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 160)}`,
    })
  }
  const payload = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (payload === undefined) {
    throw new ProviderError({ provider: ID, message: 'MiniMax 设备码响应不是 JSON' })
  }
  const deviceCode = mmString(payload, 'device_code')
  const userCode = mmString(payload, 'user_code')
  const verificationUri = mmString(payload, 'verification_uri') || mmString(payload, 'verification_url')
  const expiresInSec = mmNumber(payload, 'expires_in')
  if (deviceCode === '' || userCode === '' || verificationUri === '' || expiresInSec === undefined) {
    throw new ProviderError({
      provider: ID,
      message: 'MiniMax 设备码响应缺少必要字段（device_code / user_code / verification_uri / expires_in）',
    })
  }
  return {
    deviceCode,
    codeVerifier: pkce.codeVerifier,
    userCode,
    verificationUri,
    verificationUriComplete: mmString(payload, 'verification_uri_complete') || verificationUri,
    expiresInSec,
    // ⚠️ `interval` 单位是**秒**，缺省 5 秒（照 asar 的默认值）。
    intervalSec: mmNumber(payload, 'interval') ?? 5,
  }
}

/**
 * **轮询一次**授权结果（不是循环 —— 面板每 3 秒发一个独立请求）。
 *
 * ## ⚠️ 两种「还在等」的形态都要认（实测判据）
 *
 * 1. **HTTP 200 + `status: "pending"`** —— MiniMax 自己的形态；
 * 2. **非 200 + `error: "authorization_pending"`** —— OAuth 标准形态。
 *
 * 只看状态码会把「还在等授权」误判成「拿到令牌了」，报错是
 * `令牌响应缺少 access_token`（用户还没来得及点授权就看到失败）。
 *
 * ⚠️ `slow_down` 的退避是 **`intervalSec += 5`**（与 Cline 的 +1 不同），
 * 且**必须累积**跨请求保留 —— 故返回值带回新的 `intervalSec`，由调用方写回会话。
 */
export async function pollMinimaxLoginOnce(
  auth: MinimaxDeviceAuth,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MinimaxPollOutcome> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: auth.deviceCode,
    client_id: MINIMAX_CLIENT_ID,
    // ⚠️ code_verifier 必须带上：服务端拿它的 S256 与申请时的 challenge 比对。
    code_verifier: auth.codeVerifier,
  })

  let res: Response
  try {
    res = await fetcher(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    })
  } catch (error) {
    // 网络层失败**不判终态**（抖动量不构成「授权失败」的证据）
    return {
      kind: 'pending',
      intervalSec: auth.intervalSec,
      // 说明见函数的 `pending` 约定：这里刻意不报错，让面板继续轮询
    }
  }

  const payload = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
  const record = payload ?? {}
  const status = mmString(record, 'status')
  const error = mmString(record, 'error')

  // ── 形态一：HTTP 200 + status ──
  if (res.ok && status === 'pending') return { kind: 'pending', intervalSec: auth.intervalSec }
  if (res.ok && status === 'slow_down') {
    // ⚠️ +5 秒且**累积**（`src/minimax-oauth.ts:276-280`）
    return { kind: 'pending', intervalSec: auth.intervalSec + 5 }
  }
  if (res.ok && (status === 'denied' || status === 'access_denied')) {
    return { kind: 'failed', message: '用户拒绝了授权，请重新发起登录' }
  }
  if (res.ok && (status === 'expired' || status === 'expired_token')) {
    return { kind: 'failed', message: '设备码已过期，请重新发起登录' }
  }

  // ── 形态二：非 200 + error（OAuth 标准形态）──
  if (error === 'authorization_pending') return { kind: 'pending', intervalSec: auth.intervalSec }
  if (error === 'slow_down') return { kind: 'pending', intervalSec: auth.intervalSec + 5 }
  if (error === 'access_denied') return { kind: 'failed', message: '用户拒绝了授权，请重新发起登录' }
  if (error === 'expired_token') return { kind: 'failed', message: '设备码已过期，请重新发起登录' }

  // ── 成功：HTTP 200 且有 access_token ──
  if (res.ok && mmString(record, 'access_token') !== '') {
    const credential = parseMinimaxTokenGrant(record, auth)
    if (credential === undefined) {
      return { kind: 'failed', message: 'MiniMax 令牌响应无法解析（缺 access_token / scope 不含 agent.default）' }
    }
    return { kind: 'success', credential }
  }

  return {
    kind: 'failed',
    message: `MiniMax 授权失败：${error !== '' ? error : `HTTP ${res.status}`}`,
  }
}

/**
 * 把令牌响应转成凭据。
 *
 * ⚠️ **硬校验照抄参考实现**（`src/minimax-oauth.ts:150-190`）：
 * - `access_token` 非空；
 * - `token_type.toLowerCase() === 'bearer'`；
 * - `scope` 必须含 `agent.default`（否则 `invalid_token_response`）；
 * - 过期时间用 `expires_in` **自算** —— 实测 `access_token` **不是 JWT**
 *   （前缀 `mmoat_`、60 字符、0 个点），从 JWT 解 `exp` **恒失败**。
 */
function parseMinimaxTokenGrant(
  record: Record<string, unknown>,
  auth: MinimaxDeviceAuth,
): ProviderCredential | undefined {
  const accessToken = mmString(record, 'access_token')
  if (accessToken === '') return undefined
  const tokenType = mmString(record, 'token_type')
  if (tokenType.toLowerCase() !== 'bearer') return undefined
  const scope = mmString(record, 'scope')
  if (!scope.includes(MINIMAX_SCOPE)) return undefined
  const expiresInSec = mmNumber(record, 'expires_in')
  if (expiresInSec === undefined) return undefined

  const refreshToken = mmString(record, 'refresh_token')
  // ⚠️ uid 优先用服务端下发的 `account_id`。没有它时 `buildCredential`
  // 会回落到 `stableKeyOf(accessToken)`（**对同一 token 恒同值**），
  // 故不会因为重复轮询而在池里堆出重复账号。
  const accountId = mmString(record, 'account_id') || mmString(record, 'accountId')

  return buildCredential(
    accessToken,
    accountId === '' ? undefined : accountId,
    refreshToken === '' ? undefined : refreshToken,
    Date.now() + expiresInSec * 1000,
    { scope },
  )
}

export function parseCredential(input: unknown): ProviderCredential {
  if (typeof input === 'string') {
    const token = input.trim()
    if (token === '') {
      throw new ProviderError({ provider: ID, message: 'MiniMax 凭据为空字符串' })
    }
    return buildCredential(token, undefined, undefined, undefined, undefined)
  }

  const record = asRecord(input)
  if (record === undefined) {
    throw new ProviderError({
      provider: ID,
      message:
        'MiniMax 凭据必须是一个 JSON 对象或令牌字符串'
        + '（可粘贴 `~/.minimax/auth/prod/cn/mcode-public/auth.json` 的内容）。',
    })
  }

  const accessTokenRaw =
    readString(record, ['access_token', 'accessToken', 'access', 'token'])
    ?? readNested(record, ['auth'], ['access_token', 'accessToken', 'access', 'token'])
    ?? readNested(record, ['credentials'], ['access_token', 'accessToken'])
    ?? readNested(record, ['data'], ['access_token', 'accessToken'])
    ?? readNested(record, ['data', 'credentials'], ['access_token', 'accessToken'])
  if (accessTokenRaw === undefined) {
    throw new ProviderError({
      provider: ID,
      message:
        '未能从凭据里读到 MiniMax 访问令牌（`access_token` / `accessToken`）。'
        + '访问令牌形如 `mmoat_…`，可从 MiniMax Code 客户端的登录态文件里取得。',
    })
  }

  const refreshTokenRaw =
    readString(record, ['refresh_token', 'refreshToken', 'refresh'])
    ?? readNested(record, ['auth'], ['refresh_token', 'refreshToken'])
    ?? readNested(record, ['data'], ['refresh_token', 'refreshToken'])

  const accountId =
    readString(record, ['account_id', 'accountId', 'user_id', 'userId', 'uid', 'sub'])
    ?? readNested(record, ['account'], ['uid', 'id', 'account_id'])
    ?? readNested(record, ['userInfo'], ['id', 'userId', 'accountId'])
    ?? readNested(record, ['data', 'userInfo'], ['id', 'userId', 'accountId'])
    ?? readNested(record, ['data'], ['account_id', 'accountId', 'userId'])

  const nickname =
    readString(record, ['nickname', 'displayName', 'name', 'username'])
    ?? readNested(record, ['account'], ['nickname', 'name'])
    ?? readNested(record, ['userInfo'], ['nickname', 'name'])

  const expiresRaw =
    readNumber(record, ['expires_at', 'expiresAt', 'expire_time', 'expireTime'])
    ?? readNumber(asRecord(record.auth) ?? {}, ['expires_at', 'expiresAt'])
    ?? readNumber(asRecord(record.data) ?? {}, ['expires_at', 'expiresAt'])
  const expiresAt = expiresRaw !== undefined
    ? parseTimestamp(expiresRaw)
    : parseTimestamp(record.expires_at ?? record.expiresAt ?? record.expire_time)

  const scope = readString(record, ['scope'])
  const timezoneId = readString(record, ['timezone_id', 'timezoneId'])

  return buildCredential(accessTokenRaw, accountId, refreshTokenRaw, expiresAt, {
    nickname,
    scope,
    timezoneId,
  })
}

/** 把解析出的碎片组装成 `ProviderCredential`（uid 的兜底链在这里收口）。 */
function buildCredential(
  accessToken: string,
  accountId: string | undefined,
  refreshToken: string | undefined,
  expiresAt: number | undefined,
  profile: { nickname?: string | undefined; scope?: string | undefined; timezoneId?: string | undefined } | undefined,
): ProviderCredential {
  // JWT 只用来补元数据（**不参与鉴权**）。实测真实令牌不是 JWT ⇒ 这里恒不命中，
  // 保留仅为兼容上游将来改发 JWT（`src/minimax.ts:51-63`）。
  const claims = decodeJwtClaims(accessToken)
  const jwtSub = claims === undefined ? undefined : readString(claims, ['sub'])
  const jwtExp = claims === undefined ? undefined : readNumber(claims, ['exp'])

  const uid = accountId ?? jwtSub ?? stableKeyOf(accessToken)
  const nickname = profile?.nickname !== undefined && profile.nickname.length > 0
    ? profile.nickname
    : uid

  // ⚠️ 过期时间优先用显式字段：实测 `access_token` 不是 JWT，JWT 分支恒不命中，
  // 若只靠 JWT 会让过期时间彻底丢失、账号永远显示「未知」。
  const resolvedExpiry = expiresAt ?? (jwtExp !== undefined ? parseTimestamp(jwtExp) : undefined)

  return {
    provider: ID,
    uid,
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAt: resolvedExpiry ?? 0,
    nickname,
    // ⚠️ `timezoneId` 放 extras 是**有意的**：它不影响主流程，却是签到正确与否的
    // 关键（见 DEFAULT_TIMEZONE_ID 的注释）—— 正是 extras 该容纳的那类字段。
    extras: {
      scope: profile?.scope ?? '',
      timezoneId: profile?.timezoneId ?? '',
    },
  }
}

/** 解出 JWT 载荷（仅用于读 `sub` / `exp`）。 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (payload === undefined || payload.length === 0) return undefined
  const text = base64UrlToText(payload)
  if (text === undefined) return undefined
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

// ─────────────────────────── 模型目录 ───────────────────────────

/** 归一一个**远端**条目（复刻 asar `parseModel`，`src/minimax.ts:227-313`）。 */
function normalizeRemoteModel(raw: unknown): MinimaxModel | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  // ⚠️ `id` 与 `name` 是**两个不同字段**：远端 `models` 对象的 key 是长名
  // （`MiniMax-M3.1-Flash-Preview`，由调用方注入为 `id`），条目自带的 `name`
  // 是短名（`M3.1-Flash-Preview`）—— 官方 IDE 显示的是后者，故必须分别取。
  const id = readString(record, ['id']) ?? readString(record, ['name'])
  if (id === undefined) return undefined
  const name = readString(record, ['name']) ?? id

  const limit = asRecord(record.limit) ?? {}
  const options = Array.isArray(record.context_window_options)
    ? record.context_window_options.filter((v): v is number => positiveInt(v) !== undefined)
    : []
  // 窗口：**档位表最大档优先**，无档位表才回退 `limit.context`。
  const contextWindow = options.length > 0
    ? Math.max(...options)
    : (positiveInt(limit.context) ?? 0)

  const modalities = asRecord(record.modalities) ?? {}
  const inputs = Array.isArray(modalities.input)
    ? modalities.input.filter((v): v is string => typeof v === 'string')
    : []

  const effortOptions = Array.isArray(record.effort_options)
    ? record.effort_options.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  const rawDefault = readString(record, ['default_effort'])
  // ⚠️ 默认档必须落在档位表内，否则不发（照 Qoder 的 resolveModel）。
  const defaultEffort = rawDefault !== undefined && effortOptions.includes(rawDefault)
    ? rawDefault
    : undefined
  const thinkingMode = asRecord(record.thinking_config) === undefined
    ? undefined
    : readString(asRecord(record.thinking_config) ?? {}, ['mode'])

  return {
    id,
    name,
    contextWindow,
    maxOutput: positiveInt(limit.output) ?? 0,
    supportsImage: inputs.includes('image'),
    ...(effortOptions.length === 0 ? {} : { effortOptions }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
  }
}

/**
 * 解析远端目录响应。
 *
 * 形状（`src/minimax-auth.ts:449-488` 的 `parseMinimaxModelsPayload`）：
 * `{ providers: [ { providerId: 'minimax', config: { models: { <长名>: {...} },
 * model_order: [...] } } ] }`。
 *
 * ⚠️ `models` 是**对象**（key 即模型长名），不是数组 —— 把 key 注入为 `id`
 * 是「长名 / 短名」两个字段能同时保留的前提。
 */
function parseRemoteModels(payload: unknown): MinimaxModel[] {
  const record = asRecord(payload)
  if (record === undefined) return []
  const providers = record.providers
  if (!Array.isArray(providers)) return []
  const minimax = providers
    .map((item) => asRecord(item))
    .find((item) => item !== undefined && readString(item, ['providerId']) === ID)
  if (minimax === undefined) return []
  const config = asRecord(minimax.config)
  if (config === undefined) return []
  const models = asRecord(config.models)
  if (models === undefined) return []

  const out: MinimaxModel[] = []
  for (const [id, raw] of Object.entries(models)) {
    const entry = normalizeRemoteModel(
      asRecord(raw) === undefined ? { id } : { ...(asRecord(raw) as Record<string, unknown>), id },
    )
    if (entry !== undefined) out.push(entry)
  }

  // ⚠️ 按远端 `model_order` 排序（若提供），否则保持对象插入序。
  const order = config.model_order
  if (Array.isArray(order)) {
    const index = new Map<string, number>()
    order.forEach((id, i) => {
      if (typeof id === 'string') index.set(id, i)
    })
    out.sort((a, b) =>
      (index.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return out
}

/**
 * 拉模型目录（远端优先，失败或解析出 0 条时回退内嵌兜底表）。
 *
 * ⚠️ **不能照抄客户端内置表**：asar 的 `MINIMAX_MODELS` 只有 3 个，而远端有 4 个
 * —— 照抄会漏掉 `MiniMax-M3.1-Flash-Preview`，那正是官方界面上被选中的模型
 * （`src/minimax-product.ts:65-75`）。
 *
 * ⚠️ 远端失败时回退兜底表而**不抛错**：目录是展示信息，不该让整个供应商不可用。
 * 但这里**不静默** —— 用 `ProviderModel` 无法表达「这是兜底」，故保留一条
 * `console.warn`（面板/日志里能看出目录来自兜底，而不是「账号没有模型」）。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const token = accessTokenOf(credential)
  const url = new URL(`${API_HOST}${MODELS_PATH}`)
  url.searchParams.set('region', REGION)
  url.searchParams.set('buildEnv', BUILD_ENV)

  let remote: MinimaxModel[] = []
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: businessHeaders(token),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!res.ok) {
      console.warn(`[minimax] 模型目录请求失败（http=${res.status}），已回退内嵌兜底表`)
    } else {
      remote = parseRemoteModels(await res.json())
      if (remote.length === 0) {
        console.warn('[minimax] 远端模型目录解析出 0 条，已回退内嵌兜底表')
      }
    }
  } catch (error) {
    console.warn(
      `[minimax] 模型目录获取异常，已回退内嵌兜底表：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const source = remote.length > 0 ? remote : FALLBACK_MODELS
  return source.map((model) => ({
    id: model.id,
    name: model.name,
    // ⚠️ 0 = 未知（调用方判 `> 0` 才使用），不编造窗口。
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    supportsImage: model.supportsImage,
    // MiniMax 没有「免费额度模型」概念（免费资格是账号套餐决定的，不是模型属性），
    // 故一律 false —— 不编造，也不隐藏（面板会按余额展示）。
    isFree: false,
  }))
}

// ──────────────── OpenAI 请求体 → Anthropic Messages ────────────────

/** Anthropic 内容块（本文件内部用的宽松形状）。 */
type AnthropicBlock = Record<string, unknown>

/** 从 OpenAI 的 `image_url` 里取出 `data:` URL 的解析结果。 */
interface DataUrl {
  mediaType: string
  base64: string
}

/**
 * 解析 `data:<mime>;base64,<数据>` 形式的图片 URL。
 *
 * ⚠️ **只认 `data:` URL，绝不下载 http(s) 链接**：AGENTS.md §7.1.3 明确禁止
 * （「不实现 SSRF：网关不下载 http(s) 图片 URL」，参考项目 `images.ts:163-168`
 * 记录过它能打环回与云元数据端点）。拿到普通 URL 时**抛错**而不是静默丢弃
 * ——静默丢图会让用户以为模型看到了图片。
 */
function parseImageDataUrl(url: string): DataUrl {
  if (!url.startsWith('data:')) {
    throw new ProviderError({
      provider: ID,
      message:
        'MiniMax 只接受内联（`data:` URL）图片，不接受 http(s) 图片链接。'
        + '请让客户端把图片以 base64 直接内联在 `image_url.url` 里。',
    })
  }
  const comma = url.indexOf(',')
  if (comma < 0) {
    throw new ProviderError({ provider: ID, message: '图片 data URL 缺少逗号分隔符' })
  }
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  const [rawMime, rawEncoding] = meta.split(';')
  const mediaType = rawMime !== undefined && rawMime.trim().length > 0 ? rawMime.trim() : 'image/png'
  const encoding = rawEncoding !== undefined ? rawEncoding.trim().toLowerCase() : 'base64'
  if (encoding !== 'base64') {
    throw new ProviderError({
      provider: ID,
      message: `图片 data URL 的编码是「${encoding}」，MiniMax 只接受 base64`,
    })
  }
  const base64 = data.trim()
  if (base64 === '') {
    throw new ProviderError({ provider: ID, message: '图片 data URL 里没有 base64 数据' })
  }
  return { mediaType, base64 }
}

/** 把 OpenAI 的文本/多模态 content 转成 Anthropic 内容块数组。 */
function contentToBlocks(content: unknown): AnthropicBlock[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []

  const blocks: AnthropicBlock[] = []
  for (const raw of content) {
    const part = asRecord(raw)
    if (part === undefined) continue
    const type = readString(part, ['type'])

    if (type === 'text' || type === undefined) {
      const text = readString(part, ['text']) ?? (typeof part.text === 'string' ? part.text : undefined)
      if (text !== undefined && text !== '') blocks.push({ type: 'text', text })
      continue
    }

    if (type === 'image_url') {
      const imageUrl = asRecord(part.image_url)
      const url = imageUrl === undefined ? readString(part, ['url']) : readString(imageUrl, ['url'])
      if (url === undefined) {
        throw new ProviderError({ provider: ID, message: '图片块缺少 `image_url.url`' })
      }
      const parsed = parseImageDataUrl(url)
      // ⚠️ Anthropic 的形状：`{type:'image', source:{type:'base64', media_type, data}}`，
      // 且 `data` 是**裸 base64**（无 `data:` 前缀）。
      // ⚠️ OpenAI 的 `{type:'image_url'}` 形状实测被服务端**明确拒绝**：
      // `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`
      //（`src/minimax-messages.ts:171-180`）。
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64 },
      })
      continue
    }

    // 未知块类型：**不静默丢**，但也不让它把整轮打挂 —— 记日志即可。
    console.warn(`[minimax] 忽略无法转换的内容块类型：${String(type)}`)
  }
  return blocks
}

/** 把 OpenAI 的 `tool_calls[].function.arguments`（**字符串**）解析成对象。 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    const record = asRecord(raw)
    return record ?? {}
  }
  const trimmed = raw.trim()
  if (trimmed === '') return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return asRecord(parsed) ?? {}
  } catch {
    // ⚠️ 解析失败退化为 `{}`（**不编造参数**），但**不能丢掉整条 tool_use** ——
    // 丢了会让后续 `tool_result` 变成孤儿块，服务端 400。
    return {}
  }
}

/** 一条待转换的 OpenAI 消息。 */
type OpenAiMessage = Record<string, unknown>

/**
 * OpenAI 消息数组 → Anthropic `messages` 数组。
 *
 * ## 必须保留的东西（Qoder 在这里踩过**三个同型缺陷**）
 *
 * 1. **assistant 的 `tool_calls` → `tool_use` 块**（带 `id` / `name` / `input`）；
 * 2. **`role:'tool'` 消息 → user 消息里的 `tool_result` 块**（带 `tool_use_id`）——
 *    Anthropic 协议**没有 `role:'tool'`**。丢掉它，模型会反复重调同一工具或
 *    凭空编造结果；
 * 3. **图片保留为多模态块**（不是压成纯文本）。
 *
 * ## ⚠️ 配对纪律（真实 400 的两个来源）
 *
 * - **同批 `tool_result` 必须合并进一条 user 消息**：harness 会把**每个**工具调用
 *   落成一条独立 tool 消息，逐条下发会产出多条连续 user ⇒ 第二条前面是 user 而非
 *   assistant ⇒ `400 ... tool call result does not follow tool call (2013)`；
 * - **不得跨 assistant 边界累积**：那会变成 `assistant A / assistant B / user(A+B)`，
 *   A 的结果前面是 B ⇒ **同样** 2013。
 *
 * 故实现用「assistant 进待发区，遇到它的结果或下一条非工具消息时**成对提交**」
 * （与 `src/minimax-messages.ts:224-355` 同一算法）。
 */
function toAnthropicMessages(messages: readonly unknown[]): AnthropicBlock[] {
  const out: AnthropicBlock[] = []
  let pendingAssistant: AnthropicBlock | undefined
  let pendingToolResults: AnthropicBlock[] = []

  /** 把「待发 assistant + 已累积的工具结果」成对提交。 */
  const commitPending = (): void => {
    if (pendingAssistant === undefined && pendingToolResults.length === 0) return
    if (pendingAssistant !== undefined) out.push(pendingAssistant)
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
    pendingAssistant = undefined
  }

  for (const raw of messages) {
    const message = asRecord(raw)
    if (message === undefined) continue
    const role = readString(message, ['role']) ?? ''
    // ⚠️ `system` 走**顶层 `system` 字段**（Anthropic 协议），不是一条 system 消息
    // —— Anthropic Messages 端点不接受 system 角色消息（`minimax-messages.ts:72-75`）。
    // 这里的 system 由调用方在 buildPayload 里抽走并合并，故此处跳过。
    if (role === 'system' || role === 'developer') continue

    if (role === 'tool') {
      // 一等 tool 消息（DSH 0.1.7+ 形状，`message-shape.ts`）。
      const toolCallId = readString(message, ['tool_call_id', 'toolCallId'])
      if (toolCallId === undefined) continue
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: contentToBlocks(message.content),
        ...(message.isError === true || message.is_error === true ? { is_error: true } : {}),
      })
      continue
    }

    if (role === 'assistant') {
      // ⚠️ 上一批若还没发出，先成对发出，再把当前 assistant 转入待发区
      //（否则会变成 assistant A / assistant B / user(A+B) → 2013）。
      commitPending()
      const blocks: AnthropicBlock[] = contentToBlocks(message.content)
      // ⚠️ 历史里的 `reasoning` 不回传：Anthropic 要求 thinking 块带签名
      //（`signature`），我们不持久化签名 ⇒ 回传无签名 thinking 会被拒。
      // 丢弃思考历史是安全的（不影响正确答案）。
      const toolCalls = message.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const rawCall of toolCalls) {
          const call = asRecord(rawCall)
          if (call === undefined) continue
          const id = readString(call, ['id'])
          const fn = asRecord(call.function)
          const name = fn === undefined ? undefined : readString(fn, ['name'])
          // ⚠️ 名称为空的 tool_call 会让上游 400 且不指出字段 ⇒ 直接丢弃
          //（与 `gateway/payload.ts` 的 `cleanupToolPairing` 同一判据）。
          if (id === undefined || name === undefined) continue
          blocks.push({
            type: 'tool_use',
            id,
            name,
            input: parseToolArguments(fn?.arguments),
          })
        }
      }
      if (blocks.length === 0) continue
      pendingAssistant = { role: 'assistant', content: blocks }
      continue
    }

    // user（以及任何未知角色按 user 处理）：先成对提交待发 assistant，再发正文。
    commitPending()
    const blocks = contentToBlocks(message.content)
    if (blocks.length === 0) continue
    out.push({ role: 'user', content: blocks })
  }

  // ⚠️ 收尾必须提交：末尾的待发 assistant 与结果都要发出去，
  // 否则会留下无结果的 tool_use（Anthropic 同样 400）。
  commitPending()
  return out
}

/** 把 OpenAI 的 `tools` 转成 Anthropic 的 `input_schema` 形状。 */
function toAnthropicTools(tools: unknown): AnthropicBlock[] {
  if (!Array.isArray(tools)) return []
  const out: AnthropicBlock[] = []
  for (const raw of tools) {
    const tool = asRecord(raw)
    if (tool === undefined) continue
    // 兼容「已经是 Anthropic 形状」的输入（有 `input_schema` 时原样用）。
    const fn = asRecord(tool.function) ?? tool
    const name = readString(fn, ['name'])
    if (name === undefined) continue
    const description = readString(fn, ['description'])
    const schema = asRecord(fn.parameters) ?? asRecord(fn.input_schema)
    out.push({
      name,
      ...(description === undefined ? {} : { description }),
      input_schema: schema ?? { type: 'object', properties: {} },
    })
  }
  return out
}

/**
 * 归一思考档位（见 `src/minimax-messages.ts:108-140` 的决策表）。
 *
 * | 情形 | 请求体 | 实测行为 |
 * |---|---|---|
 * | `effort === 'none'`（用户选「关闭思考」） | `thinking:{type:'disabled'}` | 0 思考字符 |
 * | `effort === 'on'`（用户选「开启思考」，M3 的 `switchable`） | `thinking:{type:'adaptive'}` | 2785+ 字符 |
 * | 有档位 effort | `thinking:{type:'adaptive'}` + `output_config.effort` | 档位真的改变思考量 |
 * | M3.1（无档位也**必须** adaptive） | `thinking:{type:'adaptive'}` | 必须，否则 **400** |
 * | 其余（M2.7 系） | **整个不发** | 服务端默认思考（forced_on） |
 *
 * ⚠️ **`disabled` 只对 `switchable` 的模型可达**：M3.1 传 `disabled` 会被**硬拒**
 * （`400 ... requires adaptive thinking; thinking.type="disabled" ... (2013)`），
 * M2.7 传 `disabled` 会被**静默忽略**（用户以为关掉了、实际没关 —— 比不给选项更糟）。
 * 故这里只接受目录**声明过**的档位值；未知值一律丢弃（不猜测、不硬试）。
 */
function normalizeEffort(
  raw: unknown,
  model: MinimaxModel | undefined,
  modelId: string,
): { effort?: string; requiresAdaptive: boolean } {
  // ⚠️ **必须按「模型 id」判，不能按「查到的目录条目」判**：目录请求失败时
  // `entry` 是 undefined，若据此判 false 就会给 M3.1 **漏发** adaptive thinking
  // —— 那是服务端**硬 400**（`requires adaptive thinking ... (2013)`）。
  // 目录只是补充信息，绝不能让一个关键判据依赖它是否拉取成功。
  const requiresAdaptive = modelId.startsWith(ADAPTIVE_ONLY_PREFIX)
    || (model !== undefined && model.id.startsWith(ADAPTIVE_ONLY_PREFIX))
  if (typeof raw !== 'string' || raw.trim() === '') return { requiresAdaptive }
  const effort = raw.trim()

  // 白名单 = 远端档位表 ∪（switchable 时的 on/none）。
  const declared = new Set<string>(model?.effortOptions ?? [])
  if (model?.thinkingMode === 'switchable') {
    declared.add('on')
    declared.add('none')
  }
  // 目录未知（远端与兜底都没这条模型）时不放行任何档位：宁可退回服务端默认，
  // 也不要把一个可能触发 400 的 `disabled` 发给 M3.1。
  if (!declared.has(effort)) return { requiresAdaptive }
  return { effort, requiresAdaptive }
}

/**
 * 构造 Anthropic Messages 请求体（**纯函数**，便于单测锁死形状）。
 *
 * ⚠️ 图片必须由调用方**已经内联**成 data URL（本函数是同步纯函数，
 * 不碰附件服务、不做网络请求）。
 */
export function buildMinimaxPayload(input: {
  body: Record<string, unknown>
  model: string
  entry: MinimaxModel | undefined
}): Record<string, unknown> {
  const { body, model, entry } = input

  // ① system：OpenAI 把它放在 messages 里的 `role:'system'`，Anthropic 要**顶层**
  //    `system` 字段。多条 system 消息用空行拼接（官方客户端同口径）。
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const systemParts: string[] = []
  const dialogue: unknown[] = []
  for (const raw of rawMessages) {
    const message = asRecord(raw)
    if (message === undefined) continue
    if (readString(message, ['role']) === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : contentToBlocks(message.content)
            .map((block) => (typeof block.text === 'string' ? block.text : ''))
            .filter((part) => part !== '')
            .join('\n')
      if (text.trim() !== '') systemParts.push(text)
      continue
    }
    dialogue.push(raw)
  }

  const payload: Record<string, unknown> = {
    model,
    stream: true,
    messages: toAnthropicMessages(dialogue),
  }

  if (systemParts.length > 0) payload.system = systemParts.join('\n\n')

  // ② max_tokens：Anthropic 端点是**必填**的（不像 OpenAI 可以省略让服务端定）。
  //    客户端没给时用目录里的单次输出上限；目录也没有（未知模型）时才省略，
  //    让服务端自己报错，而不是我们编一个数字。
  //
  // ⚠️ 上限必须**收敛到目录声明的单次输出上限**：客户端可能带着从别家模型抄来的
  //    大值（如 943718），上游会以 400 直接拒绝整轮请求，而错误信息不会说
  //    「你该改小一点」。这与参考实现给 TRAE / Cline 加 `clampMaxTokens` 同因。
  //    ⚠️ 目录未知时**不夹取**（没有依据，夹一个猜的数比不夹更糟）。
  const requestedMax = looseNumber(body.max_tokens) ?? looseNumber(body.max_completion_tokens)
  const ceiling = entry !== undefined && entry.maxOutput > 0 ? entry.maxOutput : undefined
  const maxTokens = requestedMax !== undefined && Number.isSafeInteger(requestedMax) && requestedMax > 0
    ? (ceiling === undefined ? requestedMax : Math.min(requestedMax, ceiling))
    : ceiling
  if (maxTokens !== undefined) payload.max_tokens = maxTokens

  const temperature = looseNumber(body.temperature)
  if (temperature !== undefined) payload.temperature = temperature
  const topP = looseNumber(body.top_p)
  if (topP !== undefined) payload.top_p = topP

  if (Array.isArray(body.stop) && body.stop.length > 0) {
    payload.stop_sequences = body.stop.filter((item): item is string => typeof item === 'string')
  }

  // ③ 工具与 tool_choice。
  const tools = toAnthropicTools(body.tools)
  const choice = body.tool_choice
  const choiceType = typeof choice === 'string' ? choice : readString(asRecord(choice) ?? {}, ['type'])
  // ⚠️ Anthropic **没有**「禁用工具」的选项：`tool_choice:'none'` 只能靠
  // **整段不发 tools** 表达（发了 tools 又不给选择语义，模型仍可能调用）。
  const toolsDisabled = choiceType === 'none'
  if (tools.length > 0 && !toolsDisabled) {
    payload.tools = tools
    if (choiceType === 'required') {
      payload.tool_choice = { type: 'any' }
    } else if (choiceType === 'auto' || choiceType === undefined) {
      payload.tool_choice = { type: 'auto' }
    } else {
      // 具名选择：OpenAI 是 `{type:'function', function:{name}}`，
      // Anthropic 是 `{type:'tool', name}`。
      const named = asRecord(choice)
      const name = named === undefined
        ? undefined
        : (readString(asRecord(named.function) ?? {}, ['name']) ?? readString(named, ['name']))
      if (name !== undefined) payload.tool_choice = { type: 'tool', name }
      else payload.tool_choice = { type: 'auto' }
    }
  }

  // ④ 思考形态（决策表见 normalizeEffort 的注释）。
  const { effort, requiresAdaptive } = normalizeEffort(body.reasoning_effort, entry, model)
  if (effort === 'none') {
    payload.thinking = { type: 'disabled' }
  } else if (effort === 'on') {
    payload.thinking = { type: 'adaptive' }
  } else if (effort !== undefined) {
    payload.thinking = { type: 'adaptive' }
    payload.output_config = { effort }
  } else if (requiresAdaptive) {
    // M3.1：**不发 thinking 也会 400**（服务端强制 adaptive），故无条件补上。
    payload.thinking = { type: 'adaptive' }
  }

  return payload
}

// ─────────────────────────── 对话 ───────────────────────────

/**
 * 发起流式对话，返回**上游原始响应**（SSE，由网关逐帧透传）。
 *
 * ⚠️ 非 2xx 抛 `ProviderError`。上游的错误体是 Anthropic 形状
 * （`{"type":"error","error":{"type":"invalid_request_error","message":"…(2013)"}}`），
 * 故把嵌套的 `error.message` 提到文案里 —— 只留 `[object Object]` 等于没有信息。
 *
 * ⚠️ **402 必须能被识别成额度不足**（`retryable: true`）：参考实现记录过
 * 「归成 SERVER/AUTH 会让用户看不到『去充值』这个唯一有效动作」。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const token = accessTokenOf(credential)
  // ⚠️ 目录条目只在本地已知时才用于「默认 max_tokens」与档位白名单；
  // 拉目录失败**不能**让对话失败（那是把展示信息变成了硬依赖）。
  const entry = await lookupModel(credential, request.model, request.signal)

  let payload: Record<string, unknown>
  try {
    payload = buildMinimaxPayload({ body: request.body, model: request.model, entry })
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError({
      provider: ID,
      message: `MiniMax 请求体转换失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const res = await fetch(`${API_HOST}${INFER_PATH}`, {
    method: 'POST',
    headers: inferHeaders(token),
    body: JSON.stringify(payload),
    signal: request.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `MiniMax 对话失败（http=${res.status}）：${anthropicErrorText(text)}`,
      retryable: res.status === 429 || res.status === 402,
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // ⚠️ **必须把 Anthropic SSE 翻成 OpenAI SSE**（否则是静默失败）
  // ───────────────────────────────────────────────────────────────────────
  //
  // MiniMax 的推理端点说的是 **Anthropic Messages 协议**，SSE 帧形如
  // `{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}` ——
  // **没有 `choices` 字段**。
  //
  // 而网关的 `streamResponse` 对 OpenAI 帧是「零解析直通」（刻意如此：
  // Free 计划 10ms CPU，不 parse 才能省）。两者相遇的结果是：
  // Anthropic 帧被**原样转发**给客户端，标准 OpenAI 客户端按
  // `choices[0].delta.content` 取值 → **一帧正文都读不到**，
  // 而且**不报错、不中断**，表现为「回答为空」。
  //
  // 这正是 AGENTS.md §7.2 反复点名的静默失败形态，故在供应商层就地转换：
  // 出站流统一为 OpenAI SSE，网关无需知道供应商差异。
  // ⚠️ `res.body` 可能为 null（理论上 200 也可能没有 body）——
  // 此时必须**显式报错**，不能返回一个空流让客户端以为「回答为空」。
  if (res.body === null) {
    throw new ProviderError({
      provider: 'minimax',
      httpStatus: res.status,
      message: 'MiniMax 返回 200 但没有响应体',
    })
  }
  const converted = anthropicSseToOpenAiSse(res.body, request.model)
  return new Response(converted, {
    status: res.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
}

/** 从 Anthropic 形状的错误体里取可读文案。 */
function anthropicErrorText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '(空响应体)'
  try {
    const record = asRecord(JSON.parse(trimmed))
    if (record !== undefined) {
      const nested = asRecord(record.error)
      const message = nested === undefined ? undefined : readString(nested, ['message'])
      if (message !== undefined) {
        const type = readString(nested ?? {}, ['type'])
        return type === undefined ? message : `${type}: ${message}`
      }
      const flat = readString(record, ['message', 'msg', 'detail', 'error'])
      if (flat !== undefined) return flat
    }
  } catch {
    // 不是 JSON（可能是 HTML 错误页）—— 直接用原文片段。
  }
  return trimmed.slice(0, 300)
}

/** 查本地目录里的模型条目（远端 + 兜底；失败返回 undefined，**不抛错**）。 */
async function lookupModel(
  credential: ProviderCredential,
  model: string,
  signal: AbortSignal,
): Promise<MinimaxModel | undefined> {
  const fallback = FALLBACK_MODELS.find((item) => item.id === model)
  if (fallback !== undefined) return fallback
  try {
    const token = accessTokenOf(credential)
    const url = new URL(`${API_HOST}${MODELS_PATH}`)
    url.searchParams.set('region', REGION)
    url.searchParams.set('buildEnv', BUILD_ENV)
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: businessHeaders(token),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!res.ok) return undefined
    return parseRemoteModels(await res.json()).find((item) => item.id === model)
  } catch {
    // 目录只是**补充**信息：拿不到就让 payload 退回「不声明档位、不设默认输出上限」，
    // 绝不能因为一次目录抖动让整轮对话失败。
    return undefined
  }
}

// ─────────────────────── 签到与余额的公共部分 ───────────────────────

/** 带 `timezone_id` 的 URL（**query 参数，不是请求头**）。 */
function withTimezone(path: string, timezoneId: string): string {
  const url = new URL(`${API_HOST}${path}`)
  url.searchParams.set('timezone_id', timezoneId)
  return url.toString()
}

/** 一次业务请求的结果（业务失败也作为数据返回，由调用方决定语义）。 */
interface EnvelopeResult {
  ok: boolean
  payload?: Record<string, unknown>
  code: number
  message: string
}

/**
 * 取业务载荷。
 *
 * ⚠️ **两个端点的响应形状不同，不能一刀切**：
 * - `signin/*` 是**信封**（业务字段在 `data` 下）；
 * - `credit/details` 是**平铺的**（`total_count` 与 `base_resp` **同级**，
 *   **没有** `data` 键）。
 *
 * 故「有 `data` 对象就用它，否则用顶层」—— 只认 `data` 会把一个**合法**的
 * 余额响应判成「响应缺少 data 字段」，于是「余额为 0」被报成查询失败。
 */
function unwrapEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.data) ?? payload
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️⚠️ **业务码在 `base_resp.status_code`（不是 `code`），而且 HTTP 状态码不可信**：
 * 实测 `invalid timezone_id` 也是 **HTTP 200**
 *（`src/minimax-credits.ts:13-22`）。只看 HTTP 状态码会把失败当成成功。
 */
async function requestEnvelope(
  url: string,
  accessToken: string,
  init: { method: string; body?: string },
  signal: AbortSignal,
): Promise<EnvelopeResult> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method,
      headers: businessHeaders(accessToken),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
  } catch (error) {
    return { ok: false, code: -1, message: error instanceof Error ? error.message : String(error) }
  }

  const text = await res.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      code: res.status,
      message: res.status === 401 || res.status === 403
        ? `凭据已失效（http=${res.status}），请重新登录该账号`
        : `服务端返回了非 JSON 响应（http=${res.status}）：${text.slice(0, 120)}`,
    }
  }
  const record = asRecord(parsed)
  if (record === undefined) return { ok: false, code: -1, message: '响应无法解析' }

  const baseResp = asRecord(record.base_resp) ?? {}
  const statusCode = readNumber(baseResp, ['status_code'])
  const statusMsg = readString(baseResp, ['status_msg']) ?? ''
  if (statusCode !== undefined && statusCode !== 0) {
    return { ok: false, code: statusCode, message: statusMsg === '' ? `业务错误 ${statusCode}` : statusMsg }
  }
  return { ok: true, payload: record, code: 0, message: '' }
}

// ─────────────────────────── 余额 ───────────────────────────

/**
 * 查询积分余额。
 *
 * `GET /minimax-cloud/api/v1/credit/details`
 * → `{ details: [ { remaining_amount: "800.00", … } ], total_count: 1,
 *      base_resp: { status_code: 0, status_msg: "ok" } }`
 *
 * ## ⚠️ 一个已被生产数据推翻的字段误读（**不要改回去**）
 *
 * 初版把 **`total_count` 当积分余额** —— 错的，它是 `details[]` 的**记录条数**。
 * 实测领到 800 积分后：真实余额是 `remaining_amount`（**800**），
 * `total_count` 是 **1**（`src/minimax-credits.ts:402-437`）。
 *
 * ⚠️ 这个误读**在账号余额为 0 时不会暴露**：那时 `details` 整个缺失、
 * `total_count` 恰好也是 0 —— 「条数 0」与「余额 0」数值上偶然重合。
 * 故任何「0 → 0」的断言都是同义反复，无法暴露它。
 *
 * 口径：**余额 = Σ `details[].remaining_amount`**；`remaining_amount` 实测是
 * **字符串**（`"800.00"`），故用宽容解析。`details` 缺失 ⇒ **0**（真的为 0），
 * 与「查询失败」（抛错）是**两回事**，不要合并。
 */
/**
 * 用 `refresh_token` 续期（OAuth `refresh_token` grant）。
 *
 * ## 🔴 为什么必须有它（实测缺陷）
 *
 * 上线实测：minimax 起初能正常对话，**几分钟后**所有请求变成
 * `http=401 invalid access token`，而账号状态看起来完全正常。
 *
 * 根因：**该 provider 此前完全没有 `refresh` 方法**。
 * 而 `ProviderCredential.refreshToken` 明明有值（导入的凭据里带着）。
 * ⇒ 网关 `isAuthLikeFailure()` 判定 401 后，按
 * `provider.refresh !== undefined` 决定要不要续期 —— 它是 `undefined`，
 * 于是**不续期、直接失败**。表现为「这个号用一会儿就废了」。
 *
 * ⚠️ 这是本项目第 2 次踩到「续期写好了却没人调」的同型缺陷
 *（见 `types.ts:186-193` 记录的第 1 次）。故这次连**单测**一起补上。
 *
 * ## 请求形状（逐项取自参考实现）
 *
 * - 端点 `POST https://account.minimax.cn/oauth2/token`
 *   （`minimax-oauth.ts:309`）；
 * - `Content-Type: application/x-www-form-urlencoded`（**不是 JSON**）；
 * - 体：`grant_type=refresh_token` + `refresh_token` + `client_id`
 *   + `scope` + `audience`（`minimax-oauth.ts:99-110`）。
 *
 * ⚠️ 四个常量必须**逐字一致**：`client_id` 是官方客户端硬编码值，
 * 换一个上游回 `invalid_client`；`scope` / `audience` 同理。
 */
async function refresh(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential> {
  const refreshToken = credential.refreshToken.trim()
  if (refreshToken === '') {
    // ⚠️ 文案必须含连续的「重新登录」四个字：调用方按该子串判定**终态**
    //（不该重试、该让用户重新登录）。
    throw new ProviderError({
      provider: ID,
      message: 'MiniMax 凭据缺少 refresh_token，无法自动续期，请重新登录（或重新导出凭据）',
    })
  }

  let res: Response
  try {
    res = await fetch(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        audience: MINIMAX_AUDIENCE,
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MINIMAX_REFRESH_TIMEOUT_MS)]),
    })
  } catch (error) {
    // ⚠️ 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
    throw new ProviderError({
      provider: ID,
      retryable: true,
      message: `MiniMax 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await res.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = undefined
  }

  if (!res.ok) {
    const record = asRecord(parsed) ?? {}
    const code = readString(record, ['error', 'error_code']) ?? `HTTP ${res.status}`
    // `invalid_grant` = refresh_token 本身失效 ⇒ **终态**（重试无意义）
    const terminal = code.includes('invalid_grant') || res.status === 400 || res.status === 401
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      retryable: !terminal,
      message: terminal
        ? `MiniMax 的 refresh_token 已失效（${code}），请重新登录`
        : `MiniMax 续期失败（${code}）`,
    })
  }

  const record = asRecord(parsed) ?? {}
  const accessToken = readString(record, ['access_token', 'accessToken'])
  if (accessToken === undefined || accessToken === '') {
    // 拿到 2xx 却没有令牌 = **无法续期**（需重新登录），而不是可重试的瞬时故障。
    throw new ProviderError({
      provider: ID,
      message: 'MiniMax 续期响应缺少 access_token，请重新登录',
    })
  }

  // ⚠️ 新 refresh_token 缺失/为空时**保留旧值** —— 最容易踩的坑：
  // 丢掉它会让「本次续期成功」变成「下次续期永远失败」。
  const nextRefreshRaw = readString(record, ['refresh_token', 'refreshToken'])
  const nextRefresh = nextRefreshRaw !== undefined && nextRefreshRaw.length > 0
    ? nextRefreshRaw
    : credential.refreshToken

  // 过期时间：`expires_in`（秒）→ 绝对毫秒。缺了就**保留旧值**（绝不编造）。
  const expiresIn = readNumber(record, ['expires_in', 'expiresIn'])
  const expiresAt = expiresIn !== undefined && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : credential.expiresAt

  return {
    ...credential,
    accessToken,
    refreshToken: nextRefresh,
    expiresAt,
  }
}

async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const token = accessTokenOf(credential)
  const result = await requestEnvelope(`${API_HOST}${CREDIT_DETAILS_PATH}`, token, { method: 'GET' }, signal)
  if (!result.ok || result.payload === undefined) {
    throw new ProviderError({
      provider: ID,
      httpStatus: result.code,
      message: `MiniMax 余额查询失败：${result.message}`,
      retryable: result.code === 429 || result.code === 402,
    })
  }
  const data = unwrapEnvelope(result.payload)
  const details = Array.isArray(data.details) ? data.details : undefined
  // ⚠️ 连 `details` 与 `total_count` 都没有 ⇒ 形状不对，**不编造 0**。
  if (details === undefined && readNumber(data, ['total_count']) === undefined) {
    throw new ProviderError({
      provider: ID,
      message: 'MiniMax 余额响应形状异常（既无 details 也无 total_count）',
    })
  }

  let total = 0
  let earliestExpiry = 0
  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  for (const raw of details ?? []) {
    const entry = asRecord(raw)
    if (entry === undefined) continue
    const remaining = looseNumber(entry.remaining_amount)
    if (remaining === undefined) continue
    total += remaining
    const expiry = parseTimestamp(entry.expire_at_ms) ?? 0
    if (expiry > 0 && (earliestExpiry === 0 || expiry < earliestExpiry)) earliestExpiry = expiry
    // ⚠️ 明细名**不编造**：`credit_type` 的语义未实测（参考实现也刻意留空 packages），
    // 故用序号占位，只保证金额与到期时间真实。
    packages.push({ name: `积分包 ${packages.length + 1}`, amount: remaining, expiry })
  }

  return {
    total,
    // ⚠️ `expiredTotal` 恒 0：`details[]` 里没有区分「本周期有效」的标志，
    // 不凭猜测分类。`expiring` 同理留 0，真实到期时间在 packages 里如实给出。
    expiring: 0,
    earliestExpiry,
    packages,
  }
}

// ─────────────────────────── 签到 ───────────────────────────

/**
 * 每日签到（领取当日积分）。
 *
 * ```
 * POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   body: {}
 * ```
 *
 * ## ⚠️ 三个必须记住的点
 *
 * 1. **`timezone_id` 是 query 参数且必填**：实测放请求头**无效**、都不带报
 *    `invalid timezone_id`、非法时区名也报错（`src/minimax-credits.ts:13-22`）。
 *    且**那些错误也是 HTTP 200** ⇒ 判据只能是 `base_resp.status_code`。
 * 2. **幂等判据是响应体的 `claim_result`（`1`=本次真领取、`2`=已领过），
 *    不是 HTTP 状态码**（重复领取同样 200）。缺失 / 越界 / 非数字一律判失败，
 *    **绝不虚报成功** —— 虚报会让用户以为 +了积分、实际 +0。
 * 3. **`points` 是总数，`bonus_points` 含在其中，不得相加**：实测第 1 天
 *    `points: 800` / `bonus_points: 400`，客户端按钮就显示「签到得 800」，
 *    右上角「额外 400」只是角标。相加会**虚高一倍**。
 *
 * ⚠️ 这里的 `alreadyDone` 只来自 `claim_result=2`。**不用**「先查 status 看
 * `is_today && status===3`」判定，也不把「没有可领项」当成已领 ——
 * 后者会把「服务端没下发数据」误报成「今天已领」（Qoder 踩过同款）。
 * 查询状态端点的存在见 `src/minimax-credits.ts:342-356`（状态面板用），
 * 但领没领**只能**以领取响应为准。
 */
async function checkin(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult> {
  const token = accessTokenOf(credential)
  const timezoneId = timezoneOf(credential)
  const url = withTimezone(SIGNIN_CLAIM_PATH, timezoneId)
  // ⚠️ body 必须是 `{}`（实测客户端就是这么发的）。
  const result = await requestEnvelope(url, token, { method: 'POST', body: '{}' }, signal)

  if (!result.ok || result.payload === undefined) {
    throw new ProviderError({
      provider: ID,
      httpStatus: result.code,
      message: `MiniMax 签到失败（timezone_id=${timezoneId}）：${result.message}`,
      retryable: result.code === 429 || result.code === 402,
    })
  }

  const data = unwrapEnvelope(result.payload)
  const claimResult = readNumber(data, ['claim_result'])
  if (claimResult === 2) {
    return { alreadyDone: true, gained: 0, detail: '今日已签到（服务端判定为重复领取）' }
  }
  if (claimResult !== 1) {
    // ⚠️ 判据不明确时**不虚报成功**：如实抛错，让调用方与用户看到真实原因。
    throw new ProviderError({
      provider: ID,
      message: `MiniMax 签到响应缺少有效的 claim_result（实际值：${String(data.claim_result)}）`,
    })
  }
  // ⚠️ `points` 就是总数（已含 bonus_points），**不相加**。
  const gained = looseNumber(data.points) ?? looseNumber(data.bonus_points) ?? 0
  return {
    alreadyDone: false,
    gained,
    detail: `签到成功，获得 ${gained} 积分（时区 ${timezoneId}）`,
  }
}

// ─────────────────────────── 导出 ───────────────────────────

export const minimaxProvider: Provider = {
  /**
   * 对象判别式：`minimax` 独有的字段名。
   *
   * ⚠️ 只认 `minimax` 独有的键 —— 通用键（`accessToken`/`uid`）
   * 会被 WorkBuddy 等家共用，拿来判别必然抢错。
   */
  matchesShape(input) {
    return readString(input, ['minimax_user_id', 'minimaxUserId', 'mavis_user_id']) !== undefined
  },

  /** 裸字符串判别式：三段式 JWT（MiniMax 只下发 JWT，无固定前缀）。 */
  bareStringPattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,

  id: ID,
  name: 'MiniMax Code（中国版）',
  capabilities: {
    /**
     * ✅ **OAuth 设备码 + PKCE，已接线**（`/admin/providers/login/{start,poll}`）。
     *
     * 无本地回调监听 ⇒ 可在 Workers 跑（`src/minimax-oauth.ts:3-8`）。
     * 面板显示**用户码 + 授权链接**（同 cline 形态）。
     *
     * ⚠️ 三个判据写在文件头注释里（`pending` 两种形态 / PKCE 是 S256 /
     * `slow_down` 是 +5 秒且累积）—— 改这里之前先读那段。
     */
    login: true,
    listModels: true,
    chat: true,
    /** ✅ 有真实余额端点 `/minimax-cloud/api/v1/credit/details`。 */
    balance: true,
    /**
     * ✅ **有真实的每日签到**：`POST /minimax-cloud/api/v1/signin/claim?timezone_id=…`，
     * 响应体 `claim_result` 判幂等（`src/minimax-credits.ts:358-400`）。
     *
     * ⚠️ 本项与 Cline 相反（那边扫描产物后确认**没有**签到接口）——
     * 这正是「必须逐家核实、不能照抄」的原因。
     */
    checkin: true,
  },
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  refresh,
  /**
   * 该失败是否值得**换号重试**。
   *
   * 与其余供应商一致：429（频率限制）与 402（额度不足）值得换号。
   * ⚠️ MiniMax 的额度不足**不一定**以 402 下发 —— 业务错误也可能走
   * HTTP 200 + `base_resp.status_code`（见 `requestEnvelope` 的注释），
   * 那类错误到不了这里（在 `chat()` 里已转成 `ProviderError`）。
   * 故这里额外加一层**文案兜底**，覆盖 4xx 但语义是额度/限流的形态。
   */
  shouldRotate(status: number, bodyText: string): boolean {
    if (status === 429 || status === 402) return true
    if (status === 401) return true
    const lower = bodyText.toLowerCase()
    return CREDIT_MARKERS.some((marker) => lower.includes(marker))
  },
}

/** 额度 / 限流文案标记（中英双通道）。 */
const CREDIT_MARKERS: readonly string[] = [
  'insufficient',
  'quota',
  'rate limit',
  'too many requests',
  'balance',
  'credit',
  'payment required',
  'exceeded',
  '积分不足',
  '额度不足',
  '余额不足',
  '频率限制',
  '超出限制',
]
