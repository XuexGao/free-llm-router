/**
 * LobsterAI（有道龙虾）供应商适配器。
 *
 * ## 本供应商的特殊之处（与其它家不同，不要照抄到别家）
 *
 * 1. **对话端点只支持 SSE**：`stream` 必须恒为 `true`，`stream:false` 上游回 500
 *    （`lobsterai-adapter.ts:13` 的差异表 + `:1008-1010` 的强制改写）。
 * 2. **非 chat 端点统一信封 `{code, msg, data}`**：`code !== 0` 或 `data` 非对象
 *    即失败（`lobsterai.ts:233` 的 `parseLobsteraiEnvelope`）。**chat 端点是唯一
 *    例外** —— 它返回裸 SSE，不套信封（`lobsterai.ts:31-33`）。
 * 3. **模型目录端点必须带 `X-LobsterAI-Client-Capabilities`**：服务端按它
 *    **过滤模型集合**，不带该头时 `kimi-k3` 根本不会出现
 *    （`lobsterai.ts:533-544` 的实测记录）。
 * 4. 有**每日签到**（三步：`client-activities/slot` → `/{code}/context` →
 *    `/actions/check_in`，`lobsterai-credits.ts:36-40,234`）。
 *
 * ## 🔴 登录为什么不可用（实测结论，不是偷懒）
 *
 * LobsterAI 走**授权码 + 本地回调**：浏览器跳回 `127.0.0.1:<随机端口>`
 * （源实现 `lobsterai-oauth.ts:256` 的 `createServer` 与 `:348` 的
 * `listenOnRandomPort` → `server.listen(0, '127.0.0.1')`），再由本进程拿
 * `code` 去换 token。
 * **Workers 没有监听 socket**，且**没有轮询替代**：回调是唯一能拿到 `code`
 * 的通道，没有「设备码轮询」端点可用。
 * ⇒ `capabilities.login = false`，只支持从桌面客户端导出凭据后粘贴导入。
 *
 * ## 与源实现的一处刻意不同：不做「流内错误换号」
 *
 * 源实现把 HTTP 非 2xx 与**流内错误帧**统一纳入换号循环
 * （`lobsterai-adapter.ts:1020-1090` 的长注释记着这个真实缺陷的根因）。
 * 那个循环要求先消费整个 SSE 流、再决定换号 —— 在本项目里流是**逐帧透传**给
 * 客户端的（10ms CPU 预算，`gateway/stream.ts` 的铁律），一旦吐了一半就无法
 * 重放。故本层如实把上游响应（含错误帧）交给共享网关：网关的 `streamResponse`
 * 会识别错误帧并让客户端看到原因，账号轮转则由网关按 HTTP 状态码驱动。
 */

import {
  ProviderError,
  type ChatRequest,
  type CheckinResult,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

// ── 端点与常量（逐个对应源实现，勿凭空改） ──

/** 上游 API 基址（`lobsterai-product.ts:63`，与 `sigin.py:10` 一致）。 */
export const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'

/**
 * 续期路径（`POST /api/auth/refresh`，**不带 Authorization**）。
 *
 * 依据：参考实现 `src/lobsterai.ts:34` / `lobsterai-auth.ts:524`。
 */
export const LOBSTERAI_REFRESH_PATH = '/api/auth/refresh'
/** 对话端点（`lobsterai.ts:45`，OpenAI 兼容、**仅 SSE**）。 */
export const LOBSTERAI_CHAT_PATH = '/api/proxy/v1/chat/completions'
/** 可用模型端点（`lobsterai.ts:36`）。 */
export const LOBSTERAI_MODELS_PATH = '/api/models/available'
/** 积分余额端点（`lobsterai-credits.ts:40`）。 */
export const LOBSTERAI_PROFILE_SUMMARY_PATH = '/api/user/profile-summary'
/** 活动槽位查询端点（`lobsterai-credits.ts:36`）。 */
export const LOBSTERAI_ACTIVITY_SLOT_PATH = '/api/client-activities/slot'
/** 活动上下文端点前缀（`lobsterai-credits.ts:38`，需拼 `/{activityCode}/context`）。 */
export const LOBSTERAI_ACTIVITY_CONTEXT_PATH = '/api/client-activities'

/**
 * 客户端版本号端点（`lobsterai-product.ts:85`）。
 *
 * 响应**不是**统一信封：`code`/`msg` 在外层，载荷在 `data.value.version`。
 */
export const LOBSTERAI_CLIENT_VERSION_API
  = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'

/** 版本号兜底值（`lobsterai-product.ts:98`）。 */
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.9.4'

/**
 * 客户端能力声明（`lobsterai-product.ts:116`）。
 *
 * 两个能力**都必须声明**，各自解决一个具体问题：
 * - `kimi-k3-agentic-v1`：**模型列表的准入条件**（不带则缺 `kimi-k3`）；
 * - `thinking-level-control-v1`：关闭思考（`reasoning_effort: "off"`）的前提，
 *   不带该能力时服务端直接 HTTP 500。
 */
export const LOBSTERAI_CLIENT_CAPABILITIES
  = 'kimi-k3-agentic-v1,thinking-level-control-v1'

/** User-Agent（`lobsterai-product.ts:129`，照抄 `client.go:21`）。 */
export const LOBSTERAI_USER_AGENT = 'LobsterAI/0.1.0'

/** 控制面请求超时（毫秒），与 `lobsterai.ts:52` 的 30s 同口径。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 版本号缓存有效期（12 小时，`lobsterai.ts:66`）。 */
const VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** 活动槽位的三个固定 query 参数（`lobsterai-credits.ts:52-54`）。 */
const SLOT_PLACEMENT = 'desktop_sidebar'
const SLOT_CONTAINER_API_VERSION = '2'
/** ⚠️ `platform` 是**伪装客户端形态**，与本机运行环境无关，改了可能拿不到活动。 */
const SLOT_PLATFORM = 'win32'

/**
 * 兜底模型目录（`lobsterai-product.ts:180-200` 的 `LOBSTERAI_FALLBACK_MODELS`）。
 *
 * 顺序照抄原表（那是 2026-08-06 的实测返回顺序）。`contextWindow` 全部是
 * 桥接层统一填的估值 131072，**不是**逐模型实测（`lobsterai-product.ts:47-52`），
 * 故远端可用时一律采信远端。
 */
const FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow: number }> = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 131_072 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 131_072 },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 131_072 },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 131_072 },
  { id: 'qwen3.7-max', name: 'qwen3.7-max', contextWindow: 131_072 },
  { id: 'qwen3.7-plus', name: 'qwen3.7-plus', contextWindow: 131_072 },
  { id: 'qwen3.6-plus', name: 'qwen3.6-plus', contextWindow: 131_072 },
  { id: 'qwen3.5-plus-2026-04-20', name: 'qwen3.5-plus-2026-04-20', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code-highspeed', name: 'kimi-k2.7-code-highspeed', contextWindow: 131_072 },
  { id: 'kimi-k2.6', name: 'kimi-k2.6', contextWindow: 131_072 },
  { id: 'kimi-k2.5', name: 'kimi-k2.5', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-pro-260628', name: 'doubao-seed-2-1-pro-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'doubao-seed-2-1-turbo-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-0-code-preview-260215', name: 'doubao-seed-2-0-code-preview-260215', contextWindow: 131_072 },
  { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131_072 },
  { id: 'glm-5.1', name: 'glm-5.1', contextWindow: 131_072 },
  { id: 'glm-5v-turbo', name: 'glm-5v-turbo', contextWindow: 131_072 },
  { id: 'glm-5', name: 'glm-5', contextWindow: 131_072 },
]

// ── 客户端版本号（动态真值，失败回落兜底） ──

/**
 * isolate 内存里的版本号缓存。
 *
 * ⚠️ 为什么值得缓存：版本号是**日期式**的（`2026.9.4`），变更频率极低，而
 * 签到每次都要带它（`lobsterai-credits.ts:176` 的 `clientVersion` query 参数）
 * —— 不缓存会让每次签到多一次跨域请求。
 *
 * ⚠️ **只缓存成功结果**，不缓存兜底值：缓存兜底会让一次瞬时故障在 12 小时内
 * 持续影响后续请求（`lobsterai.ts:658-660` 同款取舍）。
 */
let cachedClientVersion: string | undefined
let cachedClientVersionAt = 0

/** 解析客户端版本号：内存缓存 → 上游更新接口 → 兜底常量。 */
async function resolveClientVersion(signal: AbortSignal): Promise<string> {
  const now = Date.now()
  if (cachedClientVersion !== undefined && now - cachedClientVersionAt < VERSION_CACHE_TTL_MS) {
    return cachedClientVersion
  }
  try {
    const res = await fetch(LOBSTERAI_CLIENT_VERSION_API, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': LOBSTERAI_USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (res.ok) {
      const version = parseClientVersionFromUpdate((await res.json()) as unknown)
      if (version !== undefined) {
        cachedClientVersion = version
        cachedClientVersionAt = now
        return version
      }
    }
  } catch {
    // 网络/解析失败：走兜底。刻意不缓存兜底值（见上方说明）。
  }
  return LOBSTERAI_FALLBACK_CLIENT_VERSION
}

/** 从更新接口响应里取版本号（`lobsterai.ts:600-607`）。 */
export function parseClientVersionFromUpdate(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const outer = (body as Record<string, unknown>).data
  if (typeof outer !== 'object' || outer === null) return undefined
  const value = (outer as Record<string, unknown>).value
  if (typeof value !== 'object' || value === null) return undefined
  const version = (value as Record<string, unknown>).version
  if (typeof version !== 'string') return undefined
  const trimmed = version.trim()
  // 只接受**日期式数字版本**（形如 `2026.9.4`）：实测响应里还有 `date` / `url`
  // 之类的字段，若服务端把 `version` 换成别的东西，我们宁可走兜底常量。
  return /^\d+(\.\d+)+$/.test(trimmed) ? trimmed : undefined
}

// ── JSON 安全读取 ──

/** 从 JSON 安全读取字符串（兼容后端把数字返回成 number）。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 从 JSON 安全读取数字（兼容字符串形态的数字；取不到返回 0）。 */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return 0
}

/** 从 JSON 安全读取字符串数组（非字符串项剔除）。 */
function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

// ── 信封解包 ──

/** 信封解析结果（与 `lobsterai.ts:190-199` 同构）。 */
export type LobsteraiEnvelopeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/**
 * 解析 `{code, msg, data}` 信封（`lobsterai.ts:233-257`）。
 *
 * 三条判定，缺一不可：
 * 1. 响应体必须是对象；
 * 2. `code` 必须为 `0`；
 * 3. `data` 必须是**对象** —— 非对象一律视为失败。
 *
 * ⚠️ 第 3 条尤其重要：上游在凭据失效时倾向于返回 `code: 0` 但 `data: null`，
 * 只看 code 会把这种情况当成成功，随后在解引用时崩在更远的地方
 * （`lobsterai.ts:243-248` 的实测记录）。
 */
export function parseLobsteraiEnvelope(body: unknown): LobsteraiEnvelopeResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: -1, message: '响应不是 JSON 对象' }
  }
  const record = body as Record<string, unknown>
  // `code` 缺失时不能当作 0：缺失说明这根本不是该协议的信封。
  const rawCode = record.code
  const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
    ? rawCode
    : (typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : -1)
  const message = readString(record, 'msg') || readString(record, 'message')
  if (code !== 0) {
    return { ok: false, code, message: message.length > 0 ? message : `code=${code}` }
  }
  const data = record.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, code, message: message.length > 0 ? message : 'data 为空（accessToken 可能已失效）' }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

// ── 凭据解析 ──

/**
 * 解析 LobsterAI 凭据。
 *
 * ## 字段落点
 *
 * | LobsterAI 字段 | 本项目字段 | 用途 |
 * |---|---|---|
 * | `access_token` | `accessToken` | `Authorization: Bearer` |
 * | `refresh_token` | `refreshToken` | 静默续期 |
 * | `expires_at` | `expiresAt` | 毫秒时间戳（秒会自动 ×1000） |
 * | `uid` | `uid` | 账号池主键 |
 * | `nickname` | `nickname` | 展示名 |
 * | `user_id` / `yid` | `extras.user_id` | 模型列表 query 的 `userId` |
 * | `uuid` | `extras.uuid` | 身份载荷必带 |
 * | `first_keyfrom` / `latest_keyfrom` | `extras.*` | 身份载荷必带 |
 *
 * ⚠️ **`uuid` / `first_keyfrom` / `latest_keyfrom` 必须随凭据一起保存**
 * （`lobsterai.ts:73-83`）：LobsterAI 的续期请求体不只是 refreshToken，还要带
 * 这三个字段。丢了就续期失败、只能让用户重新登录 —— 这是本供应商最容易漏的
 * 一点，故放在 `extras` 里而不是丢掉。
 *
 * ⚠️ `accessToken` **绝不兜底成 `''`**（`types.ts:148-151`）—— 空 token 产出的
 * 是「永远 401」的凭据，比直接报错难排查得多。
 */
function parseCredential(input: unknown): ProviderCredential {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: 'LobsterAI 凭据必须是一个 JSON 对象（至少含 access_token）。',
    })
  }
  const root = input as Record<string, unknown>

  // ── 判别闸门：拒绝 TRAE 凭据 ──
  //
  // `providers/index.ts` 的 `parseCredentialAnywhere` 会**按注册顺序**逐家试，
  // 而 LobsterAI 只需要 `access_token` 就能通过，因此排在它后面的 TRAE 凭据
  // （同样有 `access_token` + `uid`）会被本解析器抢先认走 —— 表现为「导入 TRAE
  // 凭据后账号出现在 LobsterAI 下，一发消息就 401」。
  //
  // 判据是 TRAE 凭据的**独有字段** `machine_id`（LobsterAI 协议里没有这个概念：
  // 它的身份载荷是 `uuid` / `keyfrom`）。这里显式拒绝，把凭据让给 TRAE 的
  // 解析器 —— 这正是 `parseCredentialAnywhere` 注释所说的「凭据本身有足够的
  // 判别特征」。
  if (pickString(root, ['machine_id', 'machineId']).length > 0
    && pickString(root, ['uuid', 'install_uuid', 'installUuid']).length === 0) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: '这份凭据带有 machine_id 且没有 uuid，看起来是 TRAE 的凭据，不是 LobsterAI 的。',
    })
  }

  const accessToken = pickString(root, ['access_token', 'accessToken'])
  if (accessToken === '') {
    throw new ProviderError({
      provider: 'lobsterai',
      message:
        'LobsterAI 凭据缺少 access_token。'
        + '请在 LobsterAI 桌面客户端登录后导出凭据（形如 `{"access_token":"…","refresh_token":"…"}`），'
        + '或从客户端本地存储里复制 access_token（注意不要只贴 JWT 之外的字段）。',
    })
  }

  const uuid = pickString(root, ['uuid', 'install_uuid', 'installUuid'])
  const userId = pickString(root, ['user_id', 'userId', 'yid'])
  // uid 的优先级：显式 uid → 有道 yid / user_id → 手机号 → access_token 的
  // **稳定指纹**。⚠️ 不能用 accessToken 本身当主键：access_token 每次续期都会
  // 换新，拿它当主键会让账号池在续期后多出一条「新账号」。
  const uid = pickString(root, ['uid', 'id'])
    || userId
    || pickString(root, ['mobile', 'phone'])
    || `token:${stableTokenKey(accessToken)}`

  const nickname = pickString(root, ['nickname', 'nick_name', 'name', 'mobile'])
    || 'LobsterAI'

  return {
    provider: 'lobsterai',
    uid,
    accessToken,
    refreshToken: pickString(root, ['refresh_token', 'refreshToken']),
    expiresAt: pickExpiresAt(root),
    nickname,
    extras: {
      user_id: userId,
      uuid,
      first_keyfrom: pickString(root, ['first_keyfrom', 'firstKeyfrom']),
      latest_keyfrom: pickString(root, ['latest_keyfrom', 'latestKeyfrom']),
    },
  }
}

/** 按候选键名顺序取第一个非空字符串。 */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 由 access_token 派生一个稳定主键。
 *
 * ⚠️ 这是**兜底**路径（用户没给 uid / user_id 时才会走到）。用 token 的
 * 「头部与尾部的哈希」而非 token 本身：
 * - 不把明文 token 写进账号池主键（主键会出现在面板、日志、DO key 里）；
 * - 不同 token 极低概率碰撞。
 *
 * ⚠️ 但这仍然只是**兜底**：token 轮换后本函数会算出不同的值，账号会「变新号」。
 * 故 `parseCredential` 的注释明确要求用户尽量连 `user_id` / `uid` 一起粘贴。
 */
function stableTokenKey(token: string): string {
  const head = token.slice(0, 8)
  const tail = token.slice(-8)
  return `${head}${tail}`
}

/**
 * 解析过期时间（毫秒）。
 *
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601。⚠️ **秒 → 毫秒必须 ×1000**
 * （AGENTS.md §9「`expiresAt` 单位」）。取不到返回 0（= 未知），
 * 由调用方按「无法解析则不算过期」处理（`lobsterai.ts:275-281` 同款）。
 */
function pickExpiresAt(source: Record<string, unknown>): number {
  const raw = pickString(source, ['expires_at', 'expiresAt'])
  if (raw === '') return 0
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

// ── 请求头 ──

/**
 * 构造身份载荷（`lobsteraiKeyfromBody`，`lobsterai.ts:305-321`）。
 *
 * 四个字段的语义：
 * - `firstKeyfrom` / `latestKeyfrom`：登录时与最近活动的时间戳
 *   （⚠️ 用凭据里**存储**的原值，不取当前时刻 —— 源实现同样如此，
 *   见 `lobsterai.ts:311-314`）；
 * - `version`：客户端版本号（动态真值）；
 * - `uuid` / `userId`：可选，缺失时**不带该键**（而非带空串）。
 */
export function lobsteraiKeyfromBody(
  credential: ProviderCredential,
  clientVersion: string,
): Record<string, string> {
  const body: Record<string, string> = {
    firstKeyfrom: credential.extras.first_keyfrom ?? '',
    latestKeyfrom: credential.extras.latest_keyfrom ?? '',
    version: clientVersion,
  }
  const uuid = credential.extras.uuid ?? ''
  const userId = credential.extras.user_id ?? ''
  if (uuid.length > 0) body.uuid = uuid
  if (userId.length > 0) body.userId = userId
  return body
}

/**
 * 基础请求头（`lobsterai.ts:492-505`）。
 *
 * 只设四个头：LobsterAI **不认**腾讯系那套 `X-Domain` / `X-Product` /
 * `X-IDE-*` 归属头，带上不仅无用，还可能让服务端按错误的客户端形态归因。
 */
export function lobsteraiAuthHeaders(
  credential: ProviderCredential,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': LOBSTERAI_USER_AGENT,
  }
}

/**
 * 对话请求头（`lobsterai.ts:517-529`）。
 *
 * 比基础头多两个 `X-LobsterAI-Client-*`，`Accept` 为 SSE。
 * `Capabilities` 声明客户端支持的 agentic 协议版本（影响工具调用行为）。
 */
export function lobsteraiChatHeaders(
  credential: ProviderCredential,
  clientVersion: string,
): Record<string, string> {
  return {
    ...lobsteraiAuthHeaders(credential, 'text/event-stream, application/json'),
    'X-LobsterAI-Client-Capabilities': LOBSTERAI_CLIENT_CAPABILITIES,
    'X-LobsterAI-Client-Version': clientVersion,
  }
}

// ── 模型目录 ──

/**
 * 列出模型目录：`GET /api/models/available`（`lobsterai-adapter.ts:254-290`）。
 *
 * ⚠️ **必须带 `X-LobsterAI-Client-Capabilities`**（`lobsterai.ts:533-544`）：
 * 服务端按它声明的能力过滤模型集合 —— 不带该头时返回 25 个模型且**没有
 * `kimi-k3`**，带上才 26 个。早期实现只有 4 个基础头，因此即使解析正确也会
 * 永久缺少 `kimi-k3`。
 *
 * ⚠️ query 是身份载荷（`buildLobsteraiModelsQuery`），**不含 refreshToken**
 * —— 那既是信息泄露（会进服务端访问日志），也不是该端点的预期输入
 * （`lobsterai-adapter.ts:305-312`）。
 *
 * 失败时回落兜底表而不是抛错：目录是建议性的，拉不到远端不代表不能对话。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const clientVersion = await resolveClientVersion(signal)
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(lobsteraiKeyfromBody(credential, clientVersion))) {
    if (value.length > 0) params.set(key, value)
  }
  const query = params.toString()
  const base = `${LOBSTERAI_API_BASE}${LOBSTERAI_MODELS_PATH}`
  const url = query.length > 0 ? `${base}?${query}` : base

  let payload: unknown
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...lobsteraiAuthHeaders(credential),
        // 与 chat 同样带这两个头，只是 Accept 为 JSON。
        'X-LobsterAI-Client-Capabilities': LOBSTERAI_CLIENT_CAPABILITIES,
        'X-LobsterAI-Client-Version': clientVersion,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!res.ok) {
      // ⚠️ 401/403 是**真故障**（凭据失效），必须让用户看到 —— 静默回落兜底表
      // 会让用户以为目录正常、却在发消息时才发现 token 失效。
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          provider: 'lobsterai',
          httpStatus: res.status,
          message: `LobsterAI 凭据已失效（HTTP ${res.status}），请重新从桌面客户端导出凭据并导入。`,
          retryable: true,
        })
      }
      return fallbackModels()
    }
    payload = (await res.json()) as unknown
  } catch (error) {
    if (error instanceof ProviderError) throw error
    // 网络层失败：回落兜底表（目录不是主流程）。
    return fallbackModels()
  }

  const entries = readModelArray(payload)
  if (entries.length === 0) return fallbackModels()

  const models: ProviderModel[] = []
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readString(record, 'modelId')
    if (id === '') continue
    const name = readString(record, 'modelName')
    // 只采信远端**确实给出**的数值，缺失给 0（未知）而不是编造
    // （`lobsterai-adapter.ts:270-290` 的「不编造值」约定）。
    const contextWindow = readNumber(record, 'contextWindow')
    const maxTokens = readNumber(record, 'maxTokens')
    models.push({
      id,
      name: name.length > 0 ? name : id,
      contextWindow: contextWindow > 0 ? contextWindow : 0,
      maxOutput: maxTokens > 0 ? maxTokens : 0,
      // `supportsImage` 由远端逐模型下发（`lobsterai-adapter.ts:277`）。
      // ⚠️ 缺字段时给 false 而非 true：谎报支持图片会让请求被上游按体积拒绝
      // （`lobsterai-product.ts` 记录过 12 张原图能过、13 张 500 的实测）。
      supportsImage: record.supportsImage === true,
      // LobsterAI 没有「免费额度模型」标记；远端也没有该字段，如实为 false。
      isFree: false,
    })
  }
  return models.length > 0 ? models : fallbackModels()
}

/**
 * 取出模型数组，兼容多种包装（`lobsterai-adapter.ts` 的
 * `readLobsteraiModelArray`）。
 *
 * 远端在统一信封里下发（`{code, msg, data: {…}}`），但不同版本的数据层可能
 * 是 `data` 本身是数组、或 `data.models` / `data.modelList`。这里逐层尝试。
 */
function readModelArray(payload: unknown): unknown[] {
  if (typeof payload !== 'object' || payload === null) return []
  const root = payload as Record<string, unknown>
  const data = root.data
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    const inner = data as Record<string, unknown>
    for (const key of ['models', 'modelList', 'availableModels', 'items']) {
      if (Array.isArray(inner[key])) return inner[key] as unknown[]
    }
    return []
  }
  for (const key of ['models', 'modelList', 'availableModels', 'items']) {
    if (Array.isArray(root[key])) return root[key] as unknown[]
  }
  return []
}

/** 兜底模型目录。 */
function fallbackModels(): ProviderModel[] {
  return FALLBACK_MODELS.map((entry) => ({
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    // 兜底表按 131072 统一填估值（`lobsterai-product.ts:47-52`），
    // 输出上限无依据 → 0（未知），不编造。
    maxOutput: 0,
    supportsImage: false,
    isFree: false,
  }))
}

// ── 对话 ──

/**
 * 发起流式对话，返回**上游原始响应**（由共享网关逐帧透传）。
 *
 * ⚠️ **`stream` 恒为 `true`**：上游只支持 SSE，`stream:false` 会返回 500
 * （`lobsterai-adapter.ts:13,1008-1010`）。这里直接改写而不是报错 ——
 * 客户端要非流式时，由网关聚合流（那与 OpenAI 语义一致）。
 *
 * ⚠️ **不发 `prompt_cache_key`**：那是腾讯后端的前缀缓存机制，LobsterAI 未
 * 实测支持（`lobsterai-adapter.ts:21` 的差异表）。若调用方带了它，这里删掉。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const clientVersion = await resolveClientVersion(request.signal)
  const body: Record<string, unknown> = { ...request.body, stream: true }
  // 腾讯侧的前缀缓存字段：此处无意义，删掉以免上游按未知字段处理。
  delete body.prompt_cache_key

  try {
    return await fetch(`${LOBSTERAI_API_BASE}${LOBSTERAI_CHAT_PATH}`, {
      method: 'POST',
      headers: lobsteraiChatHeaders(credential, clientVersion),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 请求失败（网络层）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }
}

// ── 积分：余额与签到 ──

/** 一次带认证的 JSON 请求结果。 */
type PostResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; message: string }

/**
 * 发起一次带认证的请求并解析 JSON。
 *
 * ⚠️ **不用 `response.json()`**（`lobsterai-credits.ts:130-137`）：
 * 凭据失效时服务端可能返回 HTML 错误页，`json()` 抛出的
 * `Unexpected token '<' ...` 对用户毫无意义。先取文本再解析，非 JSON 时
 * 给出带状态码的可读原因。
 */
async function requestJson(
  url: string,
  credential: ProviderCredential,
  signal: AbortSignal,
  init: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' },
): Promise<PostResult> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method,
      headers: lobsteraiAuthHeaders(credential),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: `凭据已失效（HTTP ${res.status}），请重新导出凭据` }
    }
    const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
    return { ok: false, status: res.status, message: `服务端返回了非 JSON 响应（HTTP ${res.status}）：${snippet}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, status: res.status, message: '响应不是 JSON 对象' }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}

/**
 * 查余额：`GET /api/user/profile-summary`（`lobsterai-credits.ts:300-330`）。
 *
 * ⚠️ 端点用 `profile-summary` 而非 `/api/user/quota`：后者只显示
 * `freeCreditsTotal=300`，**不含活动积分**（实测某账号 profile-summary 有
 * 5297.72，quota 只有 300，`lobsterai-credits.ts:292-296`）。
 *
 * 明细在 `creditItems[]`：`creditsRemaining` 是剩余量，`label` 才是人看的包名
 * （`type` 是机器分类码 `campaign`）。
 */
/**
 * 用 `refresh_token` 续期。
 *
 * ## 🔴 为什么必须有它（同型缺陷第 2 次）
 *
 * 上线实测：`lobsterai` 的凭据**带 `refresh_token`**，但 provider 上
 * **没有挂 `refresh` 方法** ⇒ 网关在 401 时按
 * `provider.refresh !== undefined` 决定要不要续期 —— 它是 `undefined`，
 * 于是**不续期、直接失败**。表现为「这个号用一会儿就废了」，
 * 而账号状态看起来完全正常。
 *
 * ⚠️ 这与 minimax 那次是**同一个缺陷**（见 `types.ts:186-193` 记录的第 1 次
 * 与 minimax `refresh` 的注释）。故两处都补了单测。
 *
 * ## 请求形状（逐项取自参考实现）
 *
 * - 端点 `POST https://lobsterai-server.youdao.com/api/auth/refresh`
 *   （`lobsterai.ts:34`、`lobsterai-auth.ts:524`）；
 * - ⚠️ **不带 `Authorization`** —— 续期只认 body 里的 `refreshToken`。
 *   带一个过期 Bearer 只会给上游制造额外的拒绝理由；
 * - 体 = keyfrom 载荷 + `refreshToken`（`lobsterai.ts:333-341`）：
 *   `firstKeyfrom` / `latestKeyfrom` / `version`，外加 `uuid` / `userId`（有才发）。
 *
 * ⚠️ `firstKeyfrom` 与 `latestKeyfrom` 用**凭据里存储的原值**，**不取当前时刻** ——
 * 严格对齐 Go 的 `KeyfromBody()`（`auth.go:37-50`）：它读的就是
 * `a.LatestKeyfrom`，而 `RefreshToken`（`client.go:137-145`）**从不更新该字段**。
 * 发当前时刻会让「同一份凭据每次续期体都不同」，而上游可能按它判重。
 */
async function refresh(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential> {
  const refreshToken = credential.refreshToken.trim()
  if (refreshToken === '') {
    // ⚠️ 文案必须含连续的「重新登录」四个字：调用方按该子串判定**终态**。
    throw new ProviderError({
      provider: 'lobsterai',
      message: 'LobsterAI 凭据缺少 refresh_token，无法自动续期，请重新登录（或重新导出凭据）',
    })
  }

  const clientVersion = await resolveClientVersion(signal)
  // ⚠️ 缺 keyfrom 会让上游认不出这是哪个客户端 —— 但**不阻断**续期：
  // 有的凭据本就不带（老版本导出），发空串让它按自己的规则判。
  const body: Record<string, unknown> = {
    firstKeyfrom: credential.extras['first_keyfrom'] ?? '',
    latestKeyfrom: credential.extras['latest_keyfrom'] ?? '',
    version: clientVersion,
    refreshToken,
  }
  const uuid = credential.extras['uuid'] ?? ''
  if (uuid !== '') body.uuid = uuid
  const userId = credential.extras['user_id'] ?? ''
  if (userId !== '') body.userId = userId

  let res: Response
  try {
    res = await fetch(`${LOBSTERAI_API_BASE}${LOBSTERAI_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': LOBSTERAI_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    // ⚠️ 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
    throw new ProviderError({
      provider: 'lobsterai',
      retryable: true,
      message: `LobsterAI 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await res.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: res.status,
      message: `LobsterAI 续期响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`,
    })
  }

  // ⚠️ 判据：401/403 = 会话死亡 ⇒ **终态**（重试无意义，必须重新登录）。
  // 其余失败按可重试处理（瞬时 5xx 被包成业务码的情形很常见）。
  if (!res.ok) {
    const terminal = res.status === 401 || res.status === 403
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: res.status,
      retryable: !terminal,
      message: terminal
        ? `LobsterAI 登录态已失效（HTTP ${res.status}），请重新登录`
        : `LobsterAI 续期失败（HTTP ${res.status}）：${text.slice(0, 160)}`,
    })
  }

  // 复用既有解析器：它与导入路径共用一套字段口径，避免两处漂移。
  const next = parseCredential(parsed)
  if (next === undefined || next.accessToken === '') {
    // 拿到 2xx 却没有令牌 = **无法续期**（需重新登录），不是可重试的瞬时故障。
    throw new ProviderError({
      provider: 'lobsterai',
      message: 'LobsterAI 续期响应缺少 access_token，请重新登录',
    })
  }

  // ⚠️ 保留旧凭据里解析器没回填的字段（尤其 extras 的 keyfrom / uuid）——
  // 丢了它们会让「本次续期成功」变成「下次续期永远失败」。
  return {
    ...credential,
    accessToken: next.accessToken,
    // ⚠️ 新 refresh_token 缺失/为空时**保留旧值**（最容易踩的坑）。
    refreshToken: next.refreshToken !== '' ? next.refreshToken : credential.refreshToken,
    expiresAt: next.expiresAt > 0 ? next.expiresAt : credential.expiresAt,
    nickname: next.nickname !== '' ? next.nickname : credential.nickname,
    extras: { ...credential.extras, ...next.extras },
  }
}

async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const result = await requestJson(
    `${LOBSTERAI_API_BASE}${LOBSTERAI_PROFILE_SUMMARY_PATH}`,
    credential,
    signal,
  )
  if (!result.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: result.status,
      message: `LobsterAI 积分查询失败：${result.message}`,
      retryable: result.status === 429 || result.status === 402 || result.status === 401 || result.status === 403,
    })
  }
  const envelope = parseLobsteraiEnvelope(result.body)
  if (!envelope.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 积分查询失败：${envelope.message}（code=${envelope.code}）`,
    })
  }

  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  let earliestExpiry = 0
  let expiring = 0
  const items = envelope.data.creditItems
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const remaining = readNumber(record, 'creditsRemaining')
      const type = readString(record, 'type')
      const label = readString(record, 'label')
      const expiresAt = readString(record, 'expiresAt')
      // 到期时间实测是 ISO 8601（`"2026-10-23T01:21:23"`），`replace(' ', 'T')`
      // 兼容旧格式（空格分隔），与 `lobsterai-credits.ts:336-342` 同款。
      const parsedExpiry = expiresAt.length > 0
        ? Date.parse(expiresAt.replace(' ', 'T'))
        : Number.NaN
      const expiry = Number.isFinite(parsedExpiry) ? parsedExpiry : 0
      if (expiry > 0) {
        if (earliestExpiry === 0 || expiry < earliestExpiry) earliestExpiry = expiry
        // 「即将过期」的定义沿用项目的 1 天口径之外不另设阈值：这里如实汇总
        // **所有**已知到期时间下的余额（调用方按需再筛）。
        expiring += remaining
      }
      packages.push({
        // ⚠️ 包名用 `label`（实测「每日登录奖励」）而不是 `type`（`campaign`）：
        // type 是机器分类码，label 才是人看的名字。
        name: label.length > 0 ? label : (type.length > 0 ? type : '积分包'),
        amount: remaining,
        expiry,
      })
    }
  }

  // 负数一律 clamp 到 0（`lobsterai-credits.ts:390-392`）：服务端在超额扣费/
  // 计量回滚等异常下可能下发负值，原样透出会让卡片显示「-12.5 积分」。
  const total = Math.max(0, readNumber(envelope.data, 'totalCreditsRemaining'))
  if (total === 0 && packages.length === 0) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: 'LobsterAI 积分查询失败：响应既没有 totalCreditsRemaining 也没有 creditItems 明细',
    })
  }
  return {
    total: roundCredits(total),
    expiring: roundCredits(expiring),
    earliestExpiry,
    packages,
  }
}

/**
 * 每日签到（三步流程，`lobsterai-credits.ts:234-290`）。
 *
 * ```
 * 1) GET  /api/client-activities/slot?placement=…&clientVersion=…&containerApiVersion=2&platform=win32
 * 2) GET  /api/client-activities/{activityCode}/context?configRevision=…
 * 3) POST /api/client-activities/{activityCode}/actions/check_in
 * ```
 *
 * 幂等靠**客户端**：请求带 `idempotencyKey`（UUID4），且签到前先查 context 的
 * `state.claimedToday` 与 `actions` 是否含 `check_in`。
 * ⚠️ **两步预检查都要做** —— 只看 `claimedToday` 会漏掉「活动有但今天不该领」
 * 的情形（`lobsterai-credits.ts:22-26`）。
 */
async function checkin(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult> {
  const clientVersion = await resolveClientVersion(signal)

  // ── 第 1 步：活动槽位 ──
  const slotQuery = new URLSearchParams({
    placement: SLOT_PLACEMENT,
    clientVersion,
    containerApiVersion: SLOT_CONTAINER_API_VERSION,
    platform: SLOT_PLATFORM,
  })
  const slotResult = await requestJson(
    `${LOBSTERAI_API_BASE}${LOBSTERAI_ACTIVITY_SLOT_PATH}?${slotQuery.toString()}`,
    credential,
    signal,
  )
  if (!slotResult.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: slotResult.status,
      message: `LobsterAI 签到失败（活动槽位查询）：${slotResult.message}`,
      retryable: slotResult.status === 429 || slotResult.status === 401 || slotResult.status === 403,
    })
  }
  const slotEnvelope = parseLobsteraiEnvelope(slotResult.body)
  if (!slotEnvelope.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 签到失败（活动槽位查询）：${slotEnvelope.message}（code=${slotEnvelope.code}）`,
    })
  }
  const slotState = readString(slotEnvelope.data, 'slotState')
  const activity = typeof slotEnvelope.data.activity === 'object' && slotEnvelope.data.activity !== null
    ? slotEnvelope.data.activity as Record<string, unknown>
    : {}
  const activityCode = readString(activity, 'activityCode')
  const configRevision = readNumber(activity, 'configRevision')

  if (slotState !== 'available' || activityCode === '') {
    // ⚠️ 这里**抛错**而不是返回 `alreadyDone: true`：`alreadyDone` 的语义是
    // 「今天已签到（幂等命中）」，用它表示「今天没活动可签」是在用布尔值撒谎
    // —— 调用方会显示「今天已签到」而用户什么都没拿到。
    // 「无可用活动」是真实业务状态，但**必须显式**（AGENTS.md §7.2）：
    // 抛错让面板如实显示原因，而不是静默吞掉一次本该发生的签到。
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 当前无可用签到活动（slotState=${slotState || '未知'}${activityCode === '' ? '，activityCode 为空' : ''}）。`
        + '通常是活动未开始/已下线，或该账号不在活动范围内。',
    })
  }

  // ── 第 2 步：活动上下文 ──
  const contextUrl = `${LOBSTERAI_API_BASE}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(activityCode)}/context`
    + `?${new URLSearchParams({ configRevision: String(configRevision) }).toString()}`
  const contextResult = await requestJson(contextUrl, credential, signal)
  if (!contextResult.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: contextResult.status,
      message: `LobsterAI 签到失败（活动上下文查询）：${contextResult.message}`,
      retryable: contextResult.status === 429,
    })
  }
  const contextEnvelope = parseLobsteraiEnvelope(contextResult.body)
  if (!contextEnvelope.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 签到失败（活动上下文查询）：${contextEnvelope.message}（code=${contextEnvelope.code}）`,
    })
  }
  const state = typeof contextEnvelope.data.state === 'object' && contextEnvelope.data.state !== null
    ? contextEnvelope.data.state as Record<string, unknown>
    : {}
  if (state.claimedToday === true) {
    return { alreadyDone: true, gained: 0, detail: '今天已签到' }
  }
  const actions = readStringArray(contextEnvelope.data, 'actions')
  if (!actions.includes('check_in')) {
    // 活动存在但当前不可签到（未开始 / 已结束 / 无资格）。
    // ⚠️ 同样抛错而**不是** `alreadyDone: true` —— 与「今天已领」是两回事，
    // 用同一个布尔值表达会让用户以为已经领过了（见上方注释）。
    throw new ProviderError({
      provider: 'lobsterai',
      message: 'LobsterAI 签到活动当前不可签到（活动上下文未下发 check_in 动作），'
        + '可能是活动未开始、已结束或该账号无资格。',
    })
  }

  // ── 第 3 步：领取 ──
  const claimUrl = `${LOBSTERAI_API_BASE}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(activityCode)}/actions/check_in`
  const claimResult = await requestJson(claimUrl, credential, signal, {
    method: 'POST',
    body: JSON.stringify({
      configRevision,
      // 客户端幂等键（对齐 `sigin.py:63` 的 uuid4）：服务端据此去重。
      idempotencyKey: crypto.randomUUID(),
      payload: {},
    }),
  })
  if (!claimResult.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      httpStatus: claimResult.status,
      message: `LobsterAI 签到领取失败：${claimResult.message}`,
      retryable: claimResult.status === 429,
    })
  }
  const claimEnvelope = parseLobsteraiEnvelope(claimResult.body)
  if (!claimEnvelope.ok) {
    throw new ProviderError({
      provider: 'lobsterai',
      message: `LobsterAI 签到领取失败：${claimEnvelope.message}（code=${claimEnvelope.code}）`,
    })
  }

  // 积分字段三级回退（`sigin.py:65-66`）：creditsGranted → rewardCredits →
  // credits。不同活动/版本用不同字段名，只认其中一个会显示「+0 积分」。
  const result = typeof claimEnvelope.data.result === 'object' && claimEnvelope.data.result !== null
    ? claimEnvelope.data.result as Record<string, unknown>
    : {}
  const gained = readNumber(result, 'creditsGranted')
    || readNumber(result, 'rewardCredits')
    || readNumber(result, 'credits')
  const message = readString(result, 'message')

  return {
    alreadyDone: false,
    gained,
    detail: message.length > 0
      ? message
      : (gained > 0 ? `签到成功，获得 ${gained} 积分` : '签到成功（服务端未下发本次积分数量）'),
  }
}

/** 把额度规整为两位小数（多包相加会把服务端浮点尾数显式化）。 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}

// ── 供应商实例 ──

export const lobsteraiProvider: Provider = {
  id: 'lobsterai',
  name: 'LobsterAI（有道龙虾）',
  capabilities: {
    // 🔴 见文件头「登录为什么不可用」：授权码只能经 127.0.0.1 本地回调拿到
    // （`lobsterai-oauth.ts:256,348`），Workers 无法监听本地端口。
    login: false,
    loginBlockedReason:
      'LobsterAI 登录会把浏览器的授权回调打回本机 127.0.0.1 的临时端口，'
      + 'Cloudflare Workers 无法监听本地端口，也没有设备码轮询之类的替代流程。'
      + '请在 LobsterAI 桌面客户端里完成登录，然后导出凭据 JSON'
      + '（含 access_token、refresh_token、user_id、uuid、first_keyfrom、latest_keyfrom 这几项），'
      + '粘贴到本项目的「导入凭据」里 —— 缺 uuid 与 keyfrom 会导致之后无法自动续期。',
    listModels: true,
    chat: true,
    balance: true,
    checkin: true,
  },
  /**
   * 对象凭据的判别式（自动识别时用）。
   *
   * ## 🔴 为什么必须有它（实测缺陷）
   *
   * 用户报「我在本地登录了 lobsterai，你推送上去试试」——实测导入后
   * 凭据被判成了 **raccoon**（账号以 `raccoon:116092` 出现）。
   *
   * 根因有**两层**：
   * 1. Raccoon 的 `matchesShape` 判据是「`user_id` 是纯数字」，而
   *    **LobsterAI 的 `user_id` 恰好也是纯数字**（`116092`）；
   * 2. 本家**原先没有 `matchesShape`** ⇒ `parseCredentialAnywhere` 的循环里
   *    会被「对象的字段形状不属于该供应商」直接**跳过**
   *    ⇒ 凭据落到排在后面的 raccoon 手里（Raccoon 在注册表里更靠后，
   *    但 LobsterAI 自己先被跳过了）。
   *
   * ⚠️ **教训：任何支持「凭据导入」的供应商都必须有 `matchesShape`** ——
   * 没有它，自动识别时**永远轮不到你**，而症状是「凭据被别家认走」，
   * 用户看到的是「导入成功但一发消息就 401」。
   *
   * 判据用**独有字段**：`first_keyfrom` / `latest_keyfrom`（身份载荷必带，
   * 别家没有这个概念）；或同时具备 `uuid` + `access_token`（LobsterAI 的
   * 最小可用凭据形态）。
   */
  matchesShape(input) {
    // ⚠️ 先排除 TRAE（它有 machine_id 且没有 uuid）—— 与 `parseCredential`
    // 里的拒绝逻辑同一判据（那边是抛错，这里是返回 false，语义一致）。
    const hasMachine = typeof input['machine_id'] === 'string' && input['machine_id'] !== ''
    const hasUuid = typeof input['uuid'] === 'string' && input['uuid'] !== ''
    if (hasMachine && !hasUuid) return false
    // 独有字段：keyfrom（camelCase 与 snake_case 都认）
    for (const k of ['first_keyfrom', 'latest_keyfrom', 'firstKeyfrom', 'latestKeyfrom']) {
      const v = input[k]
      if (typeof v === 'string' || typeof v === 'number') return true
    }
    // 兜底形态：uuid + access_token（LobsterAI 协议的必要组合）
    const hasToken =
      (typeof input['access_token'] === 'string' && input['access_token'] !== '')
      || (typeof input['accessToken'] === 'string' && input['accessToken'] !== '')
    return hasUuid && hasToken
  },
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  refresh,
  /**
   * 换号判据：429 / 402 值得换号；**401/403 也值得换号** ——
   * LobsterAI 的 access_token 是 JWT，过期或失效时回 401，而账号池里另一个
   * 账号可能仍有效（源实现同样在 401/403 时先尝试续期，见
   * `lobsterai-adapter.ts:1035-1043`）。
   */
  shouldRotate(status: number): boolean {
    return status === 429 || status === 402 || status === 401 || status === 403
  },
}
