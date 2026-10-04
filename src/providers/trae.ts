/**
 * TRAE（字节跳动 TRAE IDE）供应商适配器。
 *
 * ## 本供应商的特殊之处（与其它家都不同，不要照抄）
 *
 * 1. **请求体不是 OpenAI 形状**：`model` 要同时映射成 `config_name` + `model`、
 *    `function` 通道必填、`tools[].function.parameters` 要序列化成 **JSON 字符串**、
 *    assistant 的 `tool_calls[].function` 要改名成 `function_call`
 *    （`trae.ts:1529` 的 `transformToSOLOBody`）。
 * 2. **响应是 SOLO 自定义 SSE 事件流**（`output` / `token_usage` / `done` /
 *    `error`），**不是** OpenAI 的 `data: {choices:[…]}`（`trae-adapter.ts:9-16`）。
 *    故 `chat()` 必须用 `TransformStream` **逐帧**把 SOLO 事件转成 OpenAI chunk
 *    —— 见 {@link createSoloToOpenAiTransform} 的长注释（这里绝不整包缓冲）。
 * 3. **鉴权头很重**（约 17 个 `X-*`）：`Authorization: Cloud-IDE-JWT <token>`，
 *    且 `X-Cloudide-Token` / `X-Ide-Token` 也要设同一个 token
 *    （`trae.ts:207-240`，缺任一个都可能被拒）。
 * 4. **设备身份随凭据持久化**：`machine_id` 与 `device_id` 都是 32 位 hex，
 *    登录时生成、之后**绝不重新生成**（`trae.ts:1283,1301`）。本层把它们放在
 *    `extras` 里，缺失时**现场生成一次并提示**（见 `parseCredential`）。
 * 5. 有**每日签到**（`checkin_credits/status` → `checkin_credits/claim`）。
 *
 * ## 🔴 登录为什么不可用（实测结论，不是偷懒）
 *
 * TRAE 登录回调**默认直接把 token 放在 query string 里回传**
 * （`auth_callback_url` 参数，老流程没有 `?code=`；`AGENTS.md` 的「TRAE 协议要点」
 * 记录了这一点），宿主必须在本机 `127.0.0.1` 起监听接收
 * （源实现 `trae-oauth.ts:604` 与 `:723` 两处 `createServer`）。
 * **Workers 没有监听 socket**；又因为「tokens 直接在回调 query 里」而不是
 * `?code=`，连「换一个渠道拿 code 再换 token」的轮询替代也不成立。
 * ⇒ `capabilities.login = false`，只支持从 TRAE 桌面端导出凭据后粘贴导入。
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

// ── 端点与产品常量（逐个对应源实现，勿凭空改） ──

/** Agent 服务基址（对话 + 模型目录，`trae-product.ts:167`）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'
/** 签到/积分/Ug 基址（`trae-product.ts:169`）。 */
export const TRAE_UG_HOST = 'https://api.trae.cn'
/** OAuth/认证基址（`trae-product.ts:171`）。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'

/** 对话端点（`trae.ts:44`，SOLO 自定义 SSE）。 */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
/** 模型目录端点（多通道，`trae.ts:53`）。 */
export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param'
/** 签到状态（`trae.ts:59`）。 */
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
/** 签到领取（`trae.ts:61`）。 */
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
/** 积分余额（`trae.ts:63`）。 */
export const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'
/**
 * 续期（ExchangeToken）端点（`trae.ts:55` 的 `TRAE_EXCHANGE_PATH`）。
 *
 * ⚠️ 它挂 **OAuth host**（`api.trae.com.cn`），不是 Agent host，也不是
 * 签到用的 Ug host —— 三个 host 不可互换，挂错会 404 或 401。
 */
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
/**
 * OAuth `client_id`（`trae-product.ts:270` 的 `TRAE.clientId`）。
 *
 * ⚠️ 它与 `TRAE_APP_ID` **不是同一个值**，且请求体字段名是大写开头的
 * `ClientID` —— 照抄参考实现原样，别「规范化」成 `client_id`。
 */
export const TRAE_OAUTH_CLIENT_ID = 'en1oxy7wnw8j9n'

/** App ID（`trae-product.ts` 的 `TRAE.appId`）。 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
/**
 * IDE 版本号 —— **它是模型准入条件**：上游按 `X-Ide-Version` /
 * `X-App-Version-Code` 决定下发哪些模型，版本过低时 `glm-5.3` 等新模型会
 * `4001 param is invalid`（`trae-product.ts:56-64`）。
 */
export const TRAE_IDE_VERSION = '0.1.52'
/** 版本号代码（日期式，`trae-product.ts`）。 */
export const TRAE_IDE_VERSION_CODE = '20260811'
/** User-Agent（`trae-product.ts` 的 `userAgent`）。 */
export const TRAE_USER_AGENT = 'Trae/0.1.52'
/** 设备品牌（`trae-product.ts` 的 `deviceBrand`）。 */
export const TRAE_DEVICE_BRAND = 'Apple'
/** 系统版本（`trae-product.ts` 的 `osVersion`）。 */
export const TRAE_OS_VERSION = 'macOS 15.7.4'

/** 默认对话通道（`trae.ts:1452`，其他值实测均无效）。 */
export const TRAE_FUNCTION = 'solo_work_lite'
/** 默认 model（`trae.ts:1445` 的 `TRAE_DEFAULT_MODEL`）。 */
export const TRAE_DEFAULT_MODEL = 'glm-5.2'

/** 控制面请求超时（毫秒，`trae.ts:68`）。 */
const REQUEST_TIMEOUT_MS = 30_000

/** OpenAI SSE 的结束标记（`trae.ts:1823`）。 */
export const OPENAI_DONE = 'data: [DONE]\n\n'

/**
 * 输出额度安全上限（`trae.ts:1383` 的 `TRAE_DEFAULT_MAX_COMPLETION_TOKENS`）。
 *
 * CN 参考实现实测 `solo_agent_remote` 单次响应上限 64000 tokens，并明确写道
 * 「客户端索要 131072 会把上游打成 4xx」。故这里同样收敛。
 */
export const TRAE_MAX_COMPLETION_TOKENS = 64_000

/**
 * 要拉取的**全部**对话通道（`trae-product.ts` 的 `TRAE.channels`）。
 *
 * ⚠️ **同一模型只在列出它的通道里可调用**：实测 `glm-5.1` 在
 * `solo_agent_remote` 正常出流、在 `solo_work_lite` 回 `4001`
 * （`trae.ts:676-681`）。故 `listModels` 必须把通道归属记下来，`chat` 时用对。
 * 顺序即优先级（合并同名模型时取靠前者）。
 */
export const TRAE_CHANNELS: readonly string[] = ['solo_agent', 'solo_work_lite', 'solo_agent_remote']

/**
 * `batch_get_detail_param` 要传的全部 function。
 *
 * ⚠️ **照抄真实 CN IDE（Trae CN.exe 3.3.94）的 22 个 function**
 * （`trae-auth.ts:670-690`）：只传聊天通道会让**非聊天通道的条目在响应里
 * 位置错乱甚至被解析器跳过**，从而漏掉模型。
 */
const TRAE_BATCH_FUNCTIONS: readonly string[] = [
  'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
  'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
  'custom_agent_generation', 'utils', 'code_reviewer',
  'code_review_summary', 'solo_agent', 'solo_agent_remote',
  'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
  'solo_design_lite', 'solo_design_remote', 'multimodal',
  'system_diagnosis',
]

/**
 * 兜底模型目录（`trae-product.ts:176-210` 的 `TRAE_FALLBACK_MODELS`）。
 *
 * 顺序照抄 Go 端 staticModels（2026-08 实测快照）。远端可用时**完全采信远端**
 * —— 表里的 `contextWindow` 统一是 200000 的估值，不是逐模型实测。
 */
const FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow: number }> = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
]

// ── 设备身份（纯函数，凭据里持久化） ──

/**
 * 生成 32 位 hex 的 `machine_id`（`trae.ts:1283-1290`）。
 *
 * 对齐 Go 端 `randomHex(16)`：16 字节 → 32 hex 字符。
 * ⚠️ 登录时生成后**绝不重新生成** —— 上游按 `machine_id` 标识设备，
 * 换值可能被判定为异常设备（`trae.ts:1361-1378` 记录了轮换开关的取舍）。
 */
export function generateMachineId(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 生成 32 位 hex 的 `device_id`（`trae.ts:1301-1306`）。
 *
 * ⚠️ 是 **hex32**（`openssl rand -hex 16`），**不是** 16 位纯数字 ——
 * 后者是 CodeBuddy 的签到设备号格式，早期实现照抄过那个格式，与 TRAE 协议不符
 * （`trae.ts:1303-1307` 的实测记录）。
 *
 * ⚠️ **每个账号必须互不相同**：同一天两个账号共用同一 `device_id` 会被
 * 「该设备已签到」拦截。
 */
export function generateDeviceId(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 由 user_id 确定性派生 15 位数字设备号（签到专用，`trae.ts:323-326`）。
 *
 * 为什么签到要用派生值而不是凭据里的 `device_id`：trae-mate（真正能签到成功的
 * 参考实现）用「基于 user_id 确定性派生」的设备身份，使每个账号**天然**独享
 * 一个稳定设备号，从而规避服务端「每设备每天一次」的配额
 * （`trae-credits.ts:12-14,265-268`）。
 */
export async function deriveCheckinDeviceId15(userId: string): Promise<string> {
  return await seededDigits(15, userId, 'devid')
}

/**
 * 确定性派生 Market User ID（UUID v4，`trae.ts:331-338`）。
 *
 * ⚠️ 源实现是同步的（用 `node:crypto` 的 `createHash`）；这里因为
 * `crypto.subtle.digest` 是 Promise，故返回 `Promise<string>`。
 */
export async function deriveMarketUserId(userId: string): Promise<string> {
  const bs = await seededStream(userId, 'market', 16)
  bs[6] = ((bs[6] ?? 0) & 0x0f) | 0x40 // version 4
  bs[8] = ((bs[8] ?? 0) & 0x3f) | 0x80 // variant RFC 4122
  const hex = bs.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 确定性派生 Session ID（64 位 hex，`trae.ts:343-346`）。
 */
export async function deriveSessionId(userId: string): Promise<string> {
  return (await seededStream(userId, 'sess', 32)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * SHA-256 确定性伪随机流（`trae.ts:353-370` 的 `seededStream`）。
 *
 * 算法：`SHA256(utf8(salt:seed) ++ counterBE32)` 串联直到达到 `nbytes`。
 * 同样的 `(seed, salt)` 永远产生同样的字节序列 —— 这是「同账号恒同设备号」
 * 的基础。
 *
 * ⚠️ 源实现用 `node:crypto` 的 `createHash`，这里改用
 * `crypto.subtle.digest`（Workers 原生支持）。**但 `subtle.digest` 是异步的**，
 * 因此派生的三个函数（`deriveMarketUserId` / `deriveSessionId` /
 * `deriveCheckinDeviceId15`）在源实现里是同步的、在这里**必须是异步的** ——
 * 这是唯一无法避免的签名差异。算法本身逐字节一致，故派生结果与源实现相同。
 */
async function seededStream(seed: string, salt: string, nbytes: number): Promise<number[]> {
  const prefix = new TextEncoder().encode(`${salt}:${seed}`)
  const result: number[] = []
  let counter = 0
  while (result.length < nbytes) {
    const input = new Uint8Array(prefix.length + 4)
    input.set(prefix, 0)
    input[prefix.length] = (counter >> 24) & 0xff
    input[prefix.length + 1] = (counter >> 16) & 0xff
    input[prefix.length + 2] = (counter >> 8) & 0xff
    input[prefix.length + 3] = counter & 0xff
    const digest = await crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer)
    for (const b of new Uint8Array(digest)) {
      result.push(b)
      if (result.length >= nbytes) break
    }
    counter++
  }
  return result.slice(0, nbytes)
}

/** 确定性派生 N 位数字字符串（`trae.ts:376-379`）。 */
async function seededDigits(n: number, seed: string, salt: string): Promise<string> {
  const bs = await seededStream(seed, salt, n)
  return bs.map((b) => (b % 10).toString()).join('')
}

/** 生成 N 位随机 hex（`trae.ts:394-398`）。 */
function randomHex(n: number): string {
  const buf = new Uint8Array(Math.ceil(n / 2))
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n)
}

/** 生成 UUID v4（`trae.ts:384-388`，此处用 Web 标准的 `crypto.randomUUID`）。 */
function uuidV4(): string {
  return crypto.randomUUID()
}

// ── 请求头 ──

/**
 * SOLO 对话 / 模型目录请求头（`trae.ts:204-240` 的 `traeSOLOHeaders`）。
 *
 * ⚠️ 三处设置**同一个 token**（`Authorization` / `X-Cloudide-Token` /
 * `X-Ide-Token`）看似冗余，但源实现实测「缺任一个都可能被上游拒绝」。
 * `X-Device-Type` / `X-OS-Version` / `X-Device-Brand` 是客户端指纹的一部分，
 * 照抄 macos 形态（与本机实际系统无关）。
 */
export function traeSOLOHeaders(credential: ProviderCredential, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': TRAE_USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Cloudide-Token': credential.accessToken,
    'X-Ide-Token': credential.accessToken,
    'X-Uid': credential.uid,
    'X-App-Id': TRAE_APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': TRAE_IDE_VERSION,
    'X-Ide-Version-Code': TRAE_IDE_VERSION_CODE,
    'X-App-Version-Code': TRAE_IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'macos',
    'X-OS-Version': TRAE_OS_VERSION,
    'X-Device-Brand': TRAE_DEVICE_BRAND,
    'Request-Traffic-Type': 'prod',
  }
  const machineId = credential.extras.machine_id ?? ''
  const deviceId = credential.extras.device_id ?? ''
  if (machineId.length > 0) headers['X-Machine-Id'] = machineId
  if (deviceId.length > 0) headers['X-Device-Id'] = deviceId
  return headers
}

/**
 * 签到/积分请求头（`trae.ts:281-318` 的 `traeCheckinHeaders` + `trae-credits.ts:156`）。
 *
 * ⚠️ 与 SOLO 头是**两套完全不同的头**（约 20 个），不能复用：trae-mate 实际
 * 签到成功用的就是这套完整客户端头（`App-Version` / `Package-Type` /
 * `X-Lscbd-Aid` / `Vscode-Sessionid` 等），而不是简化的 Ug 头
 * （`trae.ts:257-278` 记录了差异）。
 *
 * ⚠️ `X-Device-Id` 用的是**基于 user_id 确定性派生的 15 位数字**，不是凭据里的
 * 32 位 hex `device_id`。后者用于对话，前者用于签到。
 */
export async function traeCheckinHeaders(credential: ProviderCredential): Promise<Record<string, string>> {
  const userId = credential.uid
  const deviceId = await deriveCheckinDeviceId15(userId)
  const marketUserId = await deriveMarketUserId(userId)
  const sessionId = await deriveSessionId(userId)
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': marketUserId,
    'X-User-Region': 'CN',
    'X-Device-Id': deviceId,
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': TRAE_IDE_VERSION,
    'X-Tt-Trace-Id': `00-${randomHex(16)}-01`,
    'Vscode-Sessionid': sessionId,
    'X-Request-Id': uuidV4(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
  }
}

// ── JSON 安全读取 ──

/** 从 JSON 安全读取字符串（兼容数字）。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 从 JSON 安全读取数字（兼容数字字符串）；取不到返回 undefined。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 从 JSON 安全读取布尔（`trae.ts:1431-1437`）。
 *
 * ⚠️ 只有**明确**的布尔语义才返回值：字段缺失返回 `undefined`（「上游没说」与
 * 「上游说 false」是两回事，过滤方据此决定是否剔除）。
 */
function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true') return true
  if (value === 0 || value === 'false') return false
  return undefined
}

// ── 凭据解析 ──

/**
 * 解析 TRAE 凭据。
 *
 * ## 字段落点
 *
 * | TRAE 字段 | 本项目字段 |
 * |---|---|
 * | `access_token` | `accessToken` |
 * | `refresh_token` | `refreshToken`（ExchangeToken 会轮换，续期后必须回写） |
 * | `expires_at` | `expiresAt`（秒会自动 ×1000） |
 * | `uid` | `uid` |
 * | `nickname` / 脱敏手机号 | `nickname` |
 * | `machine_id` / `device_id` | `extras.*` |
 *
 * ## ⚠️ 设备身份的三个诚实处理
 *
 * `machine_id` 与 `device_id` **必须逐账号唯一且稳定**
 * （`trae.ts:70-84`）。但**本适配器无法完成登录**（见文件头），因此从用户
 * 粘贴的凭据里拿到它们是**唯一**的途径。三种情况：
 *
 * 1. 凭据里带了 → 直接用（这是从桌面端导出凭据的正常路径）；
 * 2. 没带 `device_id` → 现场生成一个并写回 `extras`。这在本层是**安全**的
 *    （`device_id` 只是签到设备号，不参与任何签名），且每个账号独立生成，
 *    满足「账号间必须互异」；
 * 3. 没带 `machine_id` → **抛错**，不生成。理由：上游按 `machine_id` 标识
 *    设备，凭空造一个会让服务端看到一个从未登录过的设备，请求会被判为异常
 *    （源实现明确写着「登录时生成并持久化，不可每次重新生成」）。这属于
 *    「必须让用户知道缺什么」的情形，静默补一个假值是更糟的选择。
 *
 * ⚠️ `accessToken` **绝不兜底成 `''`**（`types.ts:148-151`）。
 */
function parseCredential(input: unknown): ProviderCredential {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProviderError({
      provider: 'trae',
      message: 'TRAE 凭据必须是一个 JSON 对象（至少含 access_token 与 machine_id）。',
    })
  }
  const root = unwrapCredentialRoot(input)

  const accessToken = pickString(root, ['access_token', 'accessToken'])
  if (accessToken === '') {
    throw new ProviderError({
      provider: 'trae',
      message:
        'TRAE 凭据缺少 access_token。请在 TRAE 桌面端登录后导出凭据 JSON'
        + '（`access_token` 也写作 `accessToken`，形如 Cloud-IDE-JWT 的载荷）。',
    })
  }

  const userId = pickString(root, ['uid', 'user_id', 'userId'])
  const machineId = pickString(root, ['machine_id', 'machineId'])
  if (machineId === '') {
    throw new ProviderError({
      provider: 'trae',
      message:
        'TRAE 凭据缺少 machine_id（32 位 hex 设备指纹）。'
        + '该值在登录时生成并写入凭据，上游按它标识设备 —— 补一个随机值会让请求被判为异常设备，'
        + '因此这里拒绝自动生成。请从桌面端导出的完整凭据里复制 `machine_id`。',
    })
  }

  // ⚠️ uid 是签到设备身份派生的种子（`deriveCheckinDeviceId15(uid)`），
  // 缺失就无法构造签到头，故必须显式报错而不是用一个随机值顶上 ——
  // 随机 uid 会让每次签到的设备号都不同，等于每次都在「新设备」上签到。
  if (userId === '') {
    throw new ProviderError({
      provider: 'trae',
      message:
        'TRAE 凭据缺少 uid（账号 user_id）。签到设备身份由它确定性派生，缺失会导致每次签到的'
        + '设备号都变化、无法通过「每设备每天一次」校验。请从桌面端导出的凭据里复制 `uid`。',
    })
  }

  // device_id 缺失时现场生成是安全的（见上方注释第 2 条）。
  const deviceId = pickString(root, ['device_id', 'deviceId']) || generateDeviceId()

  const nickname = pickString(root, ['nickname', 'nick_name', 'screen_name', 'screenName', 'name'])
    || 'TRAE'

  return {
    provider: 'trae',
    uid: userId,
    accessToken,
    refreshToken: pickString(root, ['refresh_token', 'refreshToken']),
    expiresAt: pickExpiresAt(root),
    nickname,
    extras: { machine_id: machineId, device_id: deviceId },
  }
}

/**
 * 把用户粘贴的任意形状收敛成一个字段字典。
 *
 * 用户可能粘贴整个凭据 JSON，也可能粘贴桌面端凭据文件里带包装的形态
 * （`{data:{...}}` / `{auth:{...}}`）。逐层合并，外层优先。
 */
function unwrapCredentialRoot(input: unknown): Record<string, unknown> {
  const root = input as Record<string, unknown>
  const merged: Record<string, unknown> = { ...root }
  for (const key of ['data', 'auth', 'credential', 'result', 'trae']) {
    const nested = root[key]
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) continue
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      if (merged[k] === undefined) merged[k] = v
    }
  }
  return merged
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
 * 解析过期时间（毫秒）。
 *
 * ⚠️ **秒 → 毫秒必须 ×1000**：源实现的 Go 端存的是 Unix 秒
 * （`trae.ts:78-84` 明确写了「Go 端存储的是 Unix 秒，这里转换时需
 * `expiresAt * 1000`」）。不乘会让凭据永远被判定为「已过期」。
 *
 * 取不到返回 0（= 未知），由调用方按「无法解析则不算过期」处理。
 */
function pickExpiresAt(source: Record<string, unknown>): number {
  const raw = pickString(source, ['expires_at', 'expiresAt', 'expiration'])
  if (raw === '') return 0
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

// ── OpenAI → SOLO 载荷转换 ──

/**
 * 把 OpenAI 请求体转成 SOLO 格式（`trae.ts:1529-1585` 的 `transformToSOLOBody`）。
 *
 * 六条改写规则（逐条对应 Go 端 `payload.go:PrepareBody`）：
 * 1. `stream` 强制 `true`；
 * 2. `function` = 该模型所属通道（缺失回退 `solo_work_lite`）；
 * 3. `model` → **同时**写 `config_name` 与 `model`（上游两个字段都读）；
 * 4. `tool_choice` 归一化：`"none"` 删 `tool_choice` **并删 `tools`**；
 *    `{type:"auto"/"required"}` → 字符串；`{type:"function",function:{name}}`
 *    → 该名字的字符串；
 * 5. `tools[].function.parameters` 对象 → **JSON 字符串**（SOLO 要求 string）；
 * 6. assistant 消息的 `tool_calls[].function` → `function_call`，且剔除
 *    name 为空的调用（空名字会让整条会话报废）；`content` 字符串 →
 *    `[{type:'text',text:…}]`。
 */
export function transformToSOLOBody(
  openaiBody: Record<string, unknown>,
  channel?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...openaiBody,
    stream: true,
    function: channel !== undefined && channel.length > 0 ? channel : TRAE_FUNCTION,
  }

  const msgs = body.messages
  if (Array.isArray(msgs)) {
    body.messages = msgs.map((msg) =>
      typeof msg === 'object' && msg !== null && !Array.isArray(msg)
        ? transformSOLOMessage(msg as Record<string, unknown>)
        : msg,
    )
  }

  // `__dev` 后缀是上游内部标记（如 `glm-5.2__dev`），发之前必须去掉
  // （`trae.ts:1556-1558`）。
  const model = typeof body.model === 'string' ? body.model : ''
  const baseModel = model.includes('__') ? (model.split('__')[0] ?? '') : model
  const configName = baseModel.length > 0 ? baseModel : TRAE_DEFAULT_MODEL
  body.config_name = configName
  body.model = configName

  normalizeToolChoice(body)
  normalizeTools(body)
  return body
}

/** 转换单条消息（`transformSOLOMessage`，`trae.ts:1590-1630`）。 */
function transformSOLOMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...msg }

  if (result.role === 'assistant') {
    const tcs = result.tool_calls
    if (Array.isArray(tcs)) {
      const kept: unknown[] = []
      for (const tc of tcs) {
        if (typeof tc !== 'object' || tc === null) continue
        const call = { ...(tc as Record<string, unknown>) }
        // `function` → `function_call`（SOLO 的字段名）。
        if (typeof call.function === 'object' && call.function !== null) {
          call.function_call = call.function
          delete call.function
        }
        const fc = call.function_call as Record<string, unknown> | undefined
        // ⚠️ 剔除 name 为空的调用：它会让上游对之后每条消息都 400，整条会话报废。
        if (fc === undefined || typeof fc.name !== 'string' || fc.name.trim().length === 0) continue
        kept.push(call)
      }
      if (kept.length > 0) result.tool_calls = kept
      else delete result.tool_calls
    }
  }

  const content = result.content
  if (typeof content === 'string') {
    result.content = [{ type: 'text', text: content }]
  }
  // 已经是数组 → 原样透传（多模态形态，`trae.ts:1618-1620`）。
  return result
}

/** `tool_choice` 归一化（`trae.ts:1632-1685` 的 `normalizeToolChoice`）。 */
function normalizeToolChoice(body: Record<string, unknown>): void {
  const tc = body.tool_choice
  if (tc === undefined) return

  const suppress = (): void => {
    delete body.tools
    delete body.functions
  }

  if (typeof tc === 'string') {
    if (tc.toLowerCase().trim() === 'none') {
      delete body.tool_choice
      suppress()
    }
    return
  }

  if (typeof tc === 'object' && tc !== null) {
    const value = tc as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type.toLowerCase().trim() : ''
    switch (type) {
      case 'none':
        delete body.tool_choice
        suppress()
        break
      case 'auto':
      case 'required':
        body.tool_choice = type
        break
      case 'function': {
        const fn = value.function as Record<string, unknown> | undefined
        let name = typeof fn?.name === 'string' ? fn.name : ''
        if (name.length === 0) name = typeof value.name === 'string' ? value.name : ''
        body.tool_choice = name.trim().length > 0 ? name.trim() : 'auto'
        break
      }
      default:
        delete body.tool_choice
    }
    return
  }
  delete body.tool_choice
}

/** `tools[].function.parameters` 序列化（`trae.ts:1687-1720` 的 `normalizeTools`）。 */
function normalizeTools(body: Record<string, unknown>): void {
  const raw = body.tools
  if (!Array.isArray(raw) || raw.length === 0) return

  const out: unknown[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const tool = item as Record<string, unknown>
    const fn = tool.function
    if (typeof fn !== 'object' || fn === null) continue
    const fnRecord = fn as Record<string, unknown>
    const params = fnRecord.parameters
    // SOLO 要求 parameters 是 **string**（OpenAI 标准是 object）。
    if (typeof params === 'object' && params !== null) {
      fnRecord.parameters = JSON.stringify(params)
    }
    out.push(tool)
  }
  if (out.length > 0) body.tools = out
  else delete body.tools
}

// ── SOLO SSE → OpenAI SSE（流式转换） ──

/** 解析后的单条 SOLO 事件（`trae.ts:1708-1718`）。 */
interface TraeSSEEvent {
  event: string
  response?: string
  reasoningContent?: string
  toolCalls?: unknown[]
  usage?: Record<string, unknown>
  finishReason?: string
  errorCode?: number
  errorMessage?: string
}

/**
 * 解析一条 SOLO 事件（`trae.ts:1727-1755` 的 `parseTraeSSELine`）。
 *
 * 事件形状：
 * ```
 * event:output
 * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":null}
 * event:token_usage
 * data:{"prompt_tokens":21,"completion_tokens":142}
 * event:done
 * data:{"finish_reason":"stop"}
 * event:error
 * data:{"code":4008,"message":"quota exceeded"}
 * ```
 */
export function parseTraeSSELine(eventName: string, dataLine: string): TraeSSEEvent | undefined {
  const event = eventName.trim()
  if (dataLine.length === 0) return { event }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(dataLine) as Record<string, unknown>
  } catch {
    // 解析失败：仍返回事件名（上游可能发空 data 的心跳帧）。
    return { event }
  }

  const ev: TraeSSEEvent = { event }
  switch (event) {
    case 'output':
      if (typeof raw.response === 'string') ev.response = raw.response
      if (typeof raw.reasoning_content === 'string') ev.reasoningContent = raw.reasoning_content
      if (raw.tool_calls !== null && raw.tool_calls !== undefined && Array.isArray(raw.tool_calls)) {
        ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls)
      }
      break
    case 'token_usage':
      ev.usage = raw
      break
    case 'done':
      if (typeof raw.finish_reason === 'string') ev.finishReason = raw.finish_reason
      break
    case 'error':
      if (typeof raw.code === 'number') ev.errorCode = raw.code
      if (typeof raw.message === 'string') ev.errorMessage = raw.message
      break
    default:
      // metadata / timing_cost / extra_info：解析成功但不产出 chunk。
      break
  }
  return ev
}

/**
 * 归一化 SOLO 的 `tool_calls`（`trae.ts:1760-1776`）。
 *
 * `function_call` → `function`，并清掉 SOLO 专属字段（`namespace` /
 * `partial_arguments`）—— 它们不是 OpenAI 字段，透传给客户端会污染工具调用。
 */
function normalizeTraeToolCalls(calls: unknown[]): unknown[] {
  return calls.map((call) => {
    if (typeof call !== 'object' || call === null) return call
    const c = { ...(call as Record<string, unknown>) }
    if (typeof c.function_call === 'object' && c.function_call !== null) {
      c.function = { ...(c.function_call as Record<string, unknown>) }
      delete c.function_call
    }
    if (typeof c.function === 'object' && c.function !== null) {
      const fn = c.function as Record<string, unknown>
      delete fn.namespace
      delete fn.partial_arguments
    }
    return c
  })
}

/** 生成一帧 OpenAI chunk（`trae.ts:1792-1818` 的 `buildOpenAIChunk`）。 */
export function buildOpenAIChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason?: string,
  usage?: Record<string, unknown>,
): string {
  const choices: Record<string, unknown>[] = [{ index: 0, delta }]
  if (finishReason !== undefined) choices[0]!.finish_reason = finishReason
  const chunk: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
  }
  if (usage !== undefined) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** 生成一帧 OpenAI 错误 chunk（让客户端**看到**失败原因，而不是干净地停止）。 */
export function buildOpenAIErrorChunk(message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`
}

/**
 * 把 SOLO 的 `token_usage` 载荷转成 OpenAI 的 `usage` 形状。
 *
 * ⚠️ 字段名要**改**：OpenAI 用 `prompt_tokens` / `completion_tokens`，
 * 而共享网关（`gateway/server.ts:411-421`）正是按这两个名字读用量并记账 ——
 * 透传 SOLO 的原始字段会让用量统计恒为 0。
 */
function toOpenAiUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const promptTokens = readNumber(usage, 'prompt_tokens') ?? 0
  const completionTokens = readNumber(usage, 'completion_tokens') ?? 0
  const reasoningTokens = readNumber(usage, 'reasoning_tokens')
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: readNumber(usage, 'total_tokens') ?? promptTokens + completionTokens,
    ...(reasoningTokens !== undefined && reasoningTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  }
}

/**
 * 创建「SOLO 事件流 → OpenAI SSE」的**流式**转换器。
 *
 * ## 为什么必须是 TransformStream（而不是读完再转）
 *
 * Free 计划只有 **10ms CPU / 次调用**（AGENTS.md §8.2.2）。若在这里
 * `await response.text()` 把整个响应读进内存再逐帧转发：
 * 1. 长回答（几万 token）的解析与再序列化会超出 CPU 预算被掐断；
 * 2. 客户端看到「卡很久然后一次性吐出」，而不是逐字输出；
 * 3. Workers 的响应体一旦被完整消费，就无法再以流的形式返回。
 *
 * 故这里只维护**一个跨 chunk 的行缓冲**，来一帧转一帧推一帧，
 * 单次 `transform` 的工作量是「解一行 JSON + 拼一帧字符串」。
 *
 * ## 事件映射（逐条对应 `trae-adapter.ts:1330-1500` 的分发逻辑）
 *
 * | SOLO 事件 | OpenAI 输出 |
 * |---|---|
 * | `output.response` | `choices[0].delta.content` |
 * | `output.reasoning_content` | `choices[0].delta.reasoning_content` |
 * | `output.tool_calls` | `choices[0].delta.tool_calls` |
 * | `token_usage` | 末帧的 `usage`（字段名改为 prompt/completion_tokens） |
 * | `done` | 带 `finish_reason` 的收尾帧 + `[DONE]` |
 * | `error` | **错误帧**（`{error:{message}}`），让客户端看到原因 |
 *
 * ⚠️ **上游一个事件都没发就结束**（HTTP 200 + 空流）时必须报错而不是静默
 * 收尾 —— 那正是「模型干净地停止、无任何报错」这一最糟的失败形态
 * （`trae-adapter.ts:1452-1462` 的 `sawAnyUpstreamEvent` 判据）。
 */
export function createSoloToOpenAiTransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  // 帧 id 在整条流里保持一致：OpenAI 客户端按 id 归组 chunk。
  const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  let sawUpstreamEvent = false
  let sawOutput = false
  let finished = false
  /** 末尾累积的 usage，在 `done` 或流结束时随收尾帧一起发出。 */
  let pendingUsage: Record<string, unknown> | undefined

  /** 处理一个已完整到达的事件（event 行 + data 行均已收齐）。 */
  const emitEvent = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const ev = parseTraeSSELine(currentEvent, currentData)
    currentEvent = ''
    currentData = ''
    if (ev === undefined) return
    // 任何**可解析**的事件都算「上游确实开工了」（含 metadata / timing_cost）。
    sawUpstreamEvent = true

    switch (ev.event) {
      case 'output': {
        const delta: Record<string, unknown> = {}
        if (ev.response !== undefined && ev.response.length > 0) {
          delta.content = ev.response
          sawOutput = true
        }
        if (ev.reasoningContent !== undefined && ev.reasoningContent.length > 0) {
          delta.reasoning_content = ev.reasoningContent
        }
        if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
          delta.tool_calls = ev.toolCalls
        }
        if (Object.keys(delta).length > 0) {
          controller.enqueue(encoder.encode(buildOpenAIChunk(id, model, delta)))
        }
        break
      }
      case 'token_usage':
        // 不立即发：OpenAI 的 usage 应出现在**最后一帧**（choices 为空、
        // finish_reason 之外）。这里先存下来，在 done / 流结束时一并发出。
        if (ev.usage !== undefined) pendingUsage = toOpenAiUsage(ev.usage)
        break
      case 'done': {
        finished = true
        const finishReason = ev.finishReason ?? (sawOutput ? 'stop' : 'stop')
        controller.enqueue(encoder.encode(buildOpenAIChunk(id, model, {}, finishReason, pendingUsage)))
        controller.enqueue(encoder.encode(OPENAI_DONE))
        break
      }
      case 'error': {
        // ⚠️ 上游**确实**用流内 `event:error` 下发错误（实测 4001
        // 「param is invalid」）。原样透传成 OpenAI 错误帧，客户端才看得到原因；
        // 静默丢弃会表现为「干净地停止、无任何报错」（`trae-adapter.ts:1430-1448`）。
        const code = ev.errorCode ?? -1
        const message = ev.errorMessage ?? 'unknown error'
        finished = true
        controller.enqueue(encoder.encode(
          buildOpenAIErrorChunk(traeStreamErrorMessage(code, message, model)),
        ))
        controller.enqueue(encoder.encode(OPENAI_DONE))
        break
      }
      default:
        // metadata / timing_cost / extra_info：不产出 chunk，但已计入
        // `sawUpstreamEvent`（说明上游在正常说话，不是空响应）。
        break
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (finished) return
      // ⚠️ `{stream:true}` 必需：多字节字符可能跨 chunk，否则解码出乱码。
      buffer += decoder.decode(chunk, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const trimmed = line.trim()

        // 空行 = 事件分隔符 → 派发累积的事件。
        if (trimmed.length === 0) {
          if (currentEvent.length > 0 || currentData.length > 0) emitEvent(controller)
          if (finished) return
        } else if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          // SOLO 的 data 可能跨行拼接（`trae-adapter.ts:1400-1402`）。
          currentData += trimmed.slice(5)
        }
        // 注释行（":"）与其他字段忽略
        newline = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      if (finished) return
      // 处理缓冲区里最后一个没有以空行结尾的事件。
      if (currentEvent.length > 0 || currentData.length > 0) emitEvent(controller)
      if (finished) return

      if (!sawUpstreamEvent) {
        // 空响应：如实报错（可重试的瞬时故障），绝不假装「模型没话说」。
        controller.enqueue(encoder.encode(
          buildOpenAIErrorChunk('trae: 上游在产生任何事件前结束了流（疑似空响应或被截断）'),
        ))
        controller.enqueue(encoder.encode(OPENAI_DONE))
        return
      }
      // 上游没发 `done` 就断了：补一帧收尾，让客户端能正常结束。
      controller.enqueue(encoder.encode(buildOpenAIChunk(id, model, {}, 'stop', pendingUsage)))
      controller.enqueue(encoder.encode(OPENAI_DONE))
    },
  })
}

/**
 * 组装「上游错误码 + 文案」的可读说明（`trae-adapter.ts:537-543`）。
 *
 * 特意带上**原始 code**：4001（参数无效，通常是通道/模型不匹配）、
 * 1005（Plan 权益不足）、4008（积分耗尽）三类对用户的处置完全不同 ——
 * 抹掉 code 就没法区分「换个模型」还是「去签到赚积分」。
 */
export function traeStreamErrorMessage(code: number, message: string, model: string): string {
  const hint = code === 1005
    ? '（Plan 权益不足或额度受限，可稍后重试或切换账号）'
    : code === 4008
      ? '（积分已耗尽，可先执行每日签到）'
      : code === 4001
        ? '（参数无效：通常是该模型不属于当前对话通道，可换一个模型试试）'
        : ''
  return `trae: 模型 ${model} 返回错误 code=${code}：${message}${hint}`
}

// ── 对话 ──

/**
 * 发起对话，返回**已转成 OpenAI SSE 的流式响应**。
 *
 * ⚠️ 这是三个适配器里**唯一**一个不返回上游原始 `Response` 的：因为上游是
 * SOLO 自定义事件流，若不转换，共享网关的逐帧透传会把 SOLO 事件直接吐给
 * OpenAI 客户端（客户端只会看到一堆无法解析的帧）。转换必须**流式**完成
 * —— 见 {@link createSoloToOpenAiTransform}。
 *
 * ⚠️ 通道选择：`traeChannels` 里记录了该模型所属的通道
 * （**同一模型只在列出它的通道里可调用**，发错通道 → 流内 `4001`）。
 * 由 `listModels` 缓存下来，找不到时回退默认通道。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const channel = cachedModelChannels.get(request.model) ?? TRAE_FUNCTION
  const body: Record<string, unknown> = transformToSOLOBody(request.body, channel)
  // 输出额度收敛到安全上限（见 TRAE_MAX_COMPLETION_TOKENS 的说明）。
  const requested = readNumber(body, 'max_tokens')
  if (requested === undefined || requested > TRAE_MAX_COMPLETION_TOKENS) {
    body.max_tokens = TRAE_MAX_COMPLETION_TOKENS
  }

  let upstream: Response
  try {
    upstream = await fetch(`${TRAE_AGENT_HOST}${TRAE_CHAT_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential, true),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'trae',
      message: `TRAE 请求失败（网络层）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  // 非 2xx：把上游错误体交给网关（网关按状态码决定换号），**不**在此读 body ——
  // 读掉之后调用方就拿不到原文了。
  if (!upstream.ok || upstream.body === null) return upstream

  // 上游是 SOLO 自定义 SSE：用 TransformStream 边收边转，绝不整包缓冲。
  const transformed = upstream.body.pipeThrough(createSoloToOpenAiTransform(request.model))
  return new Response(transformed, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

// ── 模型目录 ──

/** 模型 id → 所属通道（`chat` 时用它选对 `function`）。 */
const cachedModelChannels = new Map<string, string>()

/** 目录缓存（isolate 内存；Workers 没有持久磁盘）。 */
let cachedModels: ProviderModel[] | undefined
let cachedModelsAt = 0
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * 列出模型目录：`POST /api/ide/v1/batch_get_detail_param`。
 *
 * 移植自 `trae.ts:1191-1262` 的 `parseTraeBatchModelList` 与
 * `trae-auth.ts:670-700` 的请求体。三条硬性过滤（缺一不可）：
 * 1. `usage` 必须是 `chat_completion`（该端点是全功能配置表，混入 summary /
 *    multimodal 等条目会塞满无关模型）；
 * 2. `config_switch !== false`（上游已停用）；
 * 3. `is_invisible_to_user !== true`（官方隐藏的内部条目）。
 *
 * 另有两条**可调用性**判据（`isTraeModelCallable`，`trae.ts:828-830`）：
 * `is_custom_model !== true`（需用户自行绑定的模型本插件必然调不通，
 * 实测 5/5 全部回 `4001`）与 `config_switch !== false`。
 *
 * ⚠️ 合并同名条目时的规则照抄 `trae.ts:1160-1180`：**空档位不得覆盖有档位**、
 * 两侧都有档位时按通道优先级取靠前者。原实现是「无条件后覆盖前」，而真实数据
 * 恰恰把信息更空的条目排在最后，导致 13 个模型丢掉 `reasoning_effort_config`。
 *
 * 失败时回落静态表；**401/403 抛错**（凭据失效必须让用户看到）。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const now = Date.now()
  if (cachedModels !== undefined && now - cachedModelsAt < MODEL_CACHE_TTL_MS) return cachedModels

  let payload: unknown
  try {
    const res = await fetch(`${TRAE_AGENT_HOST}${TRAE_BATCH_MODELS_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential, false),
      body: JSON.stringify({
        functions: [...TRAE_BATCH_FUNCTIONS],
        agent_type: '',
        current_config_info: { config_name: '', is_custom_model: false },
        mode_type: 0,
        access_type: 0,
        ab_force_vids: '',
        ab_autotest_advanced_mode: 0,
        show_custom_model: true,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          provider: 'trae',
          httpStatus: res.status,
          message: `TRAE 凭据已失效（HTTP ${res.status}），请重新从桌面端导出凭据并导入。`,
          retryable: true,
        })
      }
      return fallbackModels()
    }
    payload = (await res.json()) as unknown
  } catch (error) {
    if (error instanceof ProviderError) throw error
    return fallbackModels()
  }

  const models = parseBatchModelList(payload)
  if (models.length === 0) return fallbackModels()

  // 记录通道归属，供 chat 选择正确的 `function`。
  for (const model of models) {
    if (model.channel !== undefined) cachedModelChannels.set(model.id, model.channel)
  }

  const providerModels: ProviderModel[] = models.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? 0,
    maxOutput: model.maxOutputTokens ?? 0,
    // `display_config.multimodal` —— 逐模型的权威图片能力判据
    // （`trae.ts` 的 `TraeRemoteModel.multimodal` 注释记录了实测：
    // `multimodal: false` 的模型收到图后的回答与不带图完全一致）。
    supportsImage: model.multimodal === true,
    // TRAE 没有「免费额度模型」标记字段，如实为 false。
    isFree: false,
  }))

  cachedModels = providerModels
  cachedModelsAt = now
  return providerModels
}

/** 兜底模型目录。 */
function fallbackModels(): ProviderModel[] {
  return FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutput: 0,
    supportsImage: false,
    isFree: false,
  }))
}

/** 解析出的远端模型条目。 */
interface TraeRemoteModel {
  id: string
  name: string
  channel?: string
  contextWindow?: number
  maxOutputTokens?: number
  multimodal?: boolean
  isCustomModel?: boolean
  isEnabled?: boolean
  isHidden?: boolean
  usage?: string
  hasReasoningOptions: boolean
}

/**
 * 解析 `batch_get_detail_param` 响应并合并同名条目
 * （`trae.ts:1191-1262`）。
 *
 * 响应形状：`{ function_configs: [{ function, config_info_list: [...] }, …] }`
 * —— **每个 function 各自一套模型目录**。
 */
export function parseBatchModelList(payload: unknown): TraeRemoteModel[] {
  if (typeof payload !== 'object' || payload === null) return []
  const groups = (payload as Record<string, unknown>).function_configs
  if (!Array.isArray(groups)) return []

  const rankOf = (channel: string | undefined): number => {
    if (channel === undefined) return Number.MAX_SAFE_INTEGER
    const index = TRAE_CHANNELS.indexOf(channel)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }

  const byId = new Map<string, TraeRemoteModel>()
  const chosenRank = new Map<string, number>()

  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const g = group as Record<string, unknown>
    const channelName = readString(g, 'function')
    const list = g.config_info_list
    if (!Array.isArray(list)) continue

    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const model = parseConfigEntry(item as Record<string, unknown>, channelName.length > 0 ? channelName : undefined)
      if (model === undefined) continue

      // ── 三条硬性过滤（照抄 `trae.ts:1225-1228`） ──
      if (model.usage !== undefined && model.usage !== 'chat_completion') continue
      if (model.isEnabled === false) continue
      if (model.isHidden === true) continue
      // `is_custom_model === true` 的条目需用户在 IDE 内自行绑定供应商，
      // 本插件必然调不通（实测 5/5 全部回 4001）。
      if (model.isCustomModel === true) continue

      const incumbent = byId.get(model.id)
      if (incumbent === undefined) {
        byId.set(model.id, model)
        chosenRank.set(model.id, rankOf(model.channel))
        continue
      }
      // 规则 1：空档位不得覆盖有档位。
      if (incumbent.hasReasoningOptions && !model.hasReasoningOptions) continue
      // 规则 2：两侧都有档位时按通道优先级取靠前者。
      if (incumbent.hasReasoningOptions && model.hasReasoningOptions) {
        const current = chosenRank.get(model.id) ?? Number.MAX_SAFE_INTEGER
        if (current !== Number.MAX_SAFE_INTEGER && rankOf(model.channel) >= current) continue
      }
      // 规则 3：其余情形沿用「后覆盖前」。
      byId.set(model.id, model)
      chosenRank.set(model.id, rankOf(model.channel))
    }
  }
  return [...byId.values()]
}

/**
 * 解析单条目录条目（`trae.ts:1056-1122` 的 `parseTraeConfigEntry`）。
 *
 * ⚠️ 所有「上游没说」的标志都保持 `undefined`（不填 false）：
 * 过滤方只挡**明确命中**者。把缺字段当 false 会误删整批模型
 * （`trae.ts:1069`）。
 */
function parseConfigEntry(
  entry: Record<string, unknown>,
  channel: string | undefined,
): TraeRemoteModel | undefined {
  const id = readString(entry, 'config_name')
  if (id === '') return undefined
  const display = typeof entry.display_config === 'object' && entry.display_config !== null
    ? entry.display_config as Record<string, unknown>
    : undefined
  const name = display !== undefined ? (readString(display, 'display_name') || id) : id

  const reasoning = entry.reasoning_effort_config
  const reasoningRecord = typeof reasoning === 'object' && reasoning !== null
    ? reasoning as Record<string, unknown>
    : undefined
  const reasoningOptions = reasoningRecord !== undefined && Array.isArray(reasoningRecord.options)
    ? reasoningRecord.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const supportThinking = reasoningRecord !== undefined
    ? readBoolean(reasoningRecord, 'support_thinking')
    : undefined
  // 与 `TraeAdapter.reasoningFor` 完全一致的判据：配置存在 + 未显式
  // `support_thinking: false` + options 非空。
  const hasReasoningOptions = supportThinking !== false && reasoningOptions.length > 0

  const contextWindow = readContextWindow(entry)
  const maxOutputTokens = readDetailMaxTokens(entry)

  return {
    id,
    name,
    ...(channel === undefined ? {} : { channel }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(display === undefined ? {} : { multimodal: readBoolean(display, 'multimodal') === true }),
    ...(display === undefined
      ? {}
      : { isCustomModel: readBoolean(display, 'is_custom_model') }),
    ...(readBoolean(entry, 'config_switch') === undefined
      ? {}
      : { isEnabled: readBoolean(entry, 'config_switch') }),
    ...(readBoolean(entry, 'is_invisible_to_user') === undefined
      ? {}
      : { isHidden: readBoolean(entry, 'is_invisible_to_user') }),
    ...(readString(entry, 'usage').length > 0 ? { usage: readString(entry, 'usage') } : {}),
    hasReasoningOptions,
  }
}

/**
 * 读 `context_window_tokens.dev`（`trae.ts:866-876`）。
 *
 * ⚠️ 用 `dev` 而非 `max`：真实条目形如 `{dev:200000, max:1000000}`，而 `max`
 * 需开启 Max 模式才可用（`strategy=max` + `model_auto_selection` 一整套字段）。
 * 本适配器**不实现 Max 模式**，采信 `max` 会让调用方以为有 1M 窗口、
 * 实际请求被上游拒。
 */
function readContextWindow(entry: Record<string, unknown>): number | undefined {
  const raw = entry.context_window_tokens
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const value = readNumber(record, 'dev') ?? readNumber(record, 'max')
  return value !== undefined && value > 0 ? Math.trunc(value) : undefined
}

/** 读 `model_detail_list[]` 里 `__dev` 那条的 `max_tokens`（`trae.ts:885-899`）。 */
function readDetailMaxTokens(entry: Record<string, unknown>): number | undefined {
  const raw = entry.model_detail_list
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const details = raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
  const preferred = details.find((item) => readString(item, 'model_name').endsWith('__dev'))
  const chosen = preferred ?? details[0]
  if (chosen === undefined) return undefined
  const value = readNumber(chosen, 'max_tokens')
  return value !== undefined && value > 0 ? Math.trunc(value) : undefined
}

// ── 积分：签到与余额 ──

/** 一次 POST JSON 请求的结果。 */
type TraePostResult =
  | { ok: true; body: Record<string, unknown>; status: number }
  | { ok: false; status: number; message: string }

/** 发起一次签到/积分 POST（带完整客户端头，`trae-credits.ts:135-176`）。 */
async function postUgJson(
  path: string,
  credential: ProviderCredential,
  body: string,
  signal: AbortSignal,
): Promise<TraePostResult> {
  try {
    const res = await fetch(`${TRAE_UG_HOST}${path}`, {
      method: 'POST',
      headers: await traeCheckinHeaders(credential),
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    const text = await res.text()
    if (!res.ok) {
      const snippet = text.trim().slice(0, 120).replace(/\s+/g, ' ')
      return { ok: false, status: res.status, message: `HTTP ${res.status}：${snippet}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, status: res.status, message: `非 JSON 响应：${text.trim().slice(0, 120)}` }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, status: res.status, message: '响应不是 JSON 对象' }
    }
    return { ok: true, body: parsed as Record<string, unknown>, status: res.status }
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读业务码（`trae-credits.ts:124-131`）。
 *
 * ⚠️ 不能只 `typeof === 'number'`：后端在部分网关上以字符串 `"9074"` 返回，
 * 只认数字会**误判为成功**（code=0）。
 */
function readClaimCode(body: Record<string, unknown>): number {
  const raw = body.code
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return raw === undefined ? 0 : -1
}

/**
 * 查签到状态（`trae-credits.ts:180-200`）。
 *
 * 响应：`{ code, checked_in: bool, credits: int64, enable: bool }`。
 */
async function fetchCheckinStatus(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<{ checkedIn: boolean; dailyCredit: number; enabled: boolean } | undefined> {
  const result = await postUgJson(TRAE_CHECKIN_STATUS_PATH, credential, '{}', signal)
  if (!result.ok) return undefined
  if (readClaimCode(result.body) !== 0) return undefined
  return {
    checkedIn: result.body.checked_in === true,
    dailyCredit: readNumber(result.body, 'credits') ?? 0,
    enabled: result.body.enable === true,
  }
}

/**
 * 查余额：`POST /trae/api/v2/pay/ide_user_ent_usage`
 * （`trae-credits.ts:341-395`）。
 *
 * body 必须含 `require_usage: true`（否则 `usage` 明细不下发）。
 * `remain = credits_limit - usage.credits_amount`。
 */
async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const result = await postUgJson(
    TRAE_ENT_USAGE_PATH,
    credential,
    JSON.stringify({ require_usage: true, req_source: 2 }),
    signal,
  )
  if (!result.ok) {
    throw new ProviderError({
      provider: 'trae',
      httpStatus: result.status,
      message: `TRAE 积分查询失败：${result.message}`,
      retryable: result.status === 429 || result.status === 402,
    })
  }
  const packList = result.body.user_entitlement_pack_list
  if (!Array.isArray(packList) || packList.length === 0) {
    throw new ProviderError({
      provider: 'trae',
      message: 'TRAE 积分查询失败：响应缺少 user_entitlement_pack_list（无法判断是「无额度」还是解析失败）',
    })
  }

  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  let total = 0
  let earliestExpiry = 0

  for (const item of packList) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const base = typeof entry.entitlement_base_info === 'object' && entry.entitlement_base_info !== null
      ? entry.entitlement_base_info as Record<string, unknown>
      : undefined
    if (base === undefined) continue
    const quota = typeof base.quota === 'object' && base.quota !== null
      ? base.quota as Record<string, unknown>
      : undefined
    if (quota === undefined) continue
    const creditsLimit = readNumber(quota, 'credits_limit') ?? 0
    if (creditsLimit <= 0) continue
    const usage = typeof entry.usage === 'object' && entry.usage !== null
      ? entry.usage as Record<string, unknown>
      : undefined
    const used = usage !== undefined ? (readNumber(usage, 'credits_amount') ?? 0) : 0

    // 到期时间：条目级 `expire_time` 是**秒级** Unix 时间戳（实测 1790783999
    // = 2026-09-30 23:59:59，与官方 UI 逐条吻合）。⚠️ 秒 → 毫秒必须 ×1000，
    // 不乘会让显示落在 1970 年（`trae-credits.ts:356-362`）。
    const expireSec = readNumber(entry, 'expire_time') ?? 0
    const expiry = expireSec > 0 ? expireSec * 1000 : 0
    if (expiry > 0 && (earliestExpiry === 0 || expiry < earliestExpiry)) earliestExpiry = expiry

    // ⚠️ 包名用 `display_desc`（实测「每月登录赠送」/「签到奖励」/「免费」），
    // 不是 `base.name` —— 后者实测为 undefined，旧实现全部回退成了「资源包」。
    const name = readString(base, 'display_desc') || '资源包'
    const remaining = creditsLimit - used
    packages.push({ name, amount: remaining, expiry })
    total += remaining
  }

  return {
    total: Math.round(total * 100) / 100,
    // 「即将过期」沿用项目的保守口径：把**已到期**包之外的余额都算作可用，
    // 这里如实汇总有到期时间的包（调用方按需按时间窗再筛）。
    expiring: Math.round(packages.reduce((sum, pkg) => sum + (pkg.expiry > 0 ? pkg.amount : 0), 0) * 100) / 100,
    earliestExpiry,
    packages,
  }
}

/**
 * 每日签到（`trae-credits.ts:216-290`）。
 *
 * 流程：
 * 1. `POST checkin_credits/status` → `{checked_in, credits, enable}`；
 *    `checked_in === true` 即今天已签（幂等命中，直接返回）；
 * 2. `POST checkin_credits/claim`，body 为 `{}`（⚠️ **不是** `{"req_source":2}`）；
 * 3. 成功后**补查一次 status** 拿本次所得积分。
 *
 * ⚠️ 第 3 步不可省：实测（2026-09-20）claim 的完整响应就是
 * `{"code":0,"message":"success"}`，**没有 `credits` 字段**。早期实现读
 * `body.credits` 因此恒为 0，界面显示「领取成功 +0 积分」而 IDE 里写着 150
 * （`trae-credits.ts:272-276`）。
 *
 * ## 已知限制：9074（设备级限流）不做设备轮换
 *
 * 业务码 **9074**（"too many users, retry later"）的限流范围是 **device_id
 * 而非账号**：源实现 `trae.ts:1310-1355` 提供了 `deriveCheckinDeviceId`
 * （按「基础 id + 代次」派生新设备号）来绕过它，而
 * `trae-credits.ts:262-268` **明确弃用了该轮换**，理由是改用了「基于 user_id
 * 确定性派生设备身份」后各账号天然互异设备、不再需要轮换。
 *
 * 本适配器沿用后者的做法（确定性派生，见 {@link traeCheckinHeaders}）：
 * 派生结果与代次无关、永远稳定，因此**不做** 9074 的设备轮换 ——
 * 命中 9074 时如实报告并给出冷却建议，由调用方按 300s 冷却重试。
 * 这是**有意的取舍**：轮换要求持久化一个「代次」整数，而本层的能力边界是
 * 「无登录、凭据自导入」，多存一个可变状态会引入「什么时候该加代次」的
 * 跨请求决策 —— 那属于账号池的职责，不是适配器的。
 */
async function checkin(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult> {
  const status = await fetchCheckinStatus(credential, signal)
  if (status !== undefined && status.checkedIn) {
    return {
      alreadyDone: true,
      gained: 0,
      detail: `今天已签到${status.dailyCredit > 0 ? `（每日可得 ${status.dailyCredit} 积分）` : ''}`,
    }
  }

  const result = await postUgJson(TRAE_CHECKIN_CLAIM_PATH, credential, '{}', signal)
  if (!result.ok) {
    // HTTP 401 表示会话失效（`trae-credits.ts:82` 归类 SessionDead、永久冷却）。
    throw new ProviderError({
      provider: 'trae',
      httpStatus: result.status,
      message: `TRAE 签到失败：${result.message}`,
      retryable: result.status === 429,
    })
  }

  const code = readClaimCode(result.body)
  if (code === 9074) {
    const message = readString(result.body, 'message') || readString(result.body, 'msg')
    throw new ProviderError({
      provider: 'trae',
      httpStatus: 200,
      // ⚠️ HTTP 200 + 业务码 9074：不可换号（限流是设备维度的，换号无用），
      // 但值得稍后重试（源实现给 300s 冷却）。
      retryable: true,
      message: `TRAE 签到失败：${message || '签到人数过多，请稍后再试'}（业务码 9074，属于设备级限流，稍后重试即可）`,
    })
  }
  if (code !== 0) {
    const message = readString(result.body, 'message') || readString(result.body, 'msg')
    throw new ProviderError({
      provider: 'trae',
      httpStatus: 200,
      message: `TRAE 签到失败（业务码 ${code}）：${message || '上游未给出原因'}`,
    })
  }

  // 补查一次状态拿真实所得（claim 响应不含积分数，见上方注释）。
  const after = await fetchCheckinStatus(credential, signal)
  const gained = after?.dailyCredit ?? 0
  return {
    alreadyDone: false,
    gained,
    detail: gained > 0 ? `签到成功，获得 ${gained} 积分` : '签到成功（上游未下发本次积分数量，可稍后在积分余额里确认）',
  }
}

// ── 供应商实例 ──

// ── 续期（ExchangeToken，**会轮换 refresh_token**） ──

/**
 * 用 `refresh_token` 换一份新凭据。
 *
 * ## 协议（`trae-auth.ts:378-428` 的 `refreshCredential`，逐字对齐）
 *
 * ```
 * POST {TRAE_OAUTH_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken
 * headers: Content-Type: application/json + Accept + User-Agent（**无签名**）
 * body:    { "ClientID": "en1oxy7wnw8j9n", "RefreshToken": "…",
 *            "ClientSecret": "-", "UserID": "" }
 * → { "Result": { "Token": "…", "RefreshToken": "…",
 *                 "TokenExpireAt": <Unix 秒?>, "TokenExpireDuration": <秒>,
 *                 "RefreshExpireAt": … } }
 * ```
 *
 * ⚠️ **四个字段名都是大写开头**（`ClientID` / `RefreshToken` /
 * `ClientSecret` / `UserID`），且 `ClientSecret` 是字面量 `'-'`、`UserID` 是
 * 空串 —— 这两点是实测值，不是占位符（`trae-auth.ts:379-385`）。
 *
 * ⚠️ **`User-Agent` 必须带**：OAuth 端点无签名，只靠 UA 识别客户端
 * （`trae.ts:408-414` 的 `traeOAuthHeaders`）。
 *
 * ## 🔴 `refresh_token` 会**轮换**
 *
 * ExchangeToken 每次调用都下发**新的** `RefreshToken`，且服务端侧旧的随之失效。
 * 故必须**用新值覆盖**（新值为空时才保留旧的）—— 不覆盖会让下一次续期失败。
 * 这正是参考实现 `applyTraeRefresh` 的写法（`trae.ts:614-640`），也是本项目
 * 唯二会轮换 refresh token 的两家之一（另一家是 raccoon）。
 *
 * ## 终态判定（四条独立依据，任一成立即需重新登录）
 *
 * 1. HTTP 401/403（**最权威**：网关拒绝的是凭据本身）；
 * 2. 响应体命中 session-dead 标记（`login` / `unauthorized` / `token invalid`…，
 *    `trae-errors.ts:49-56` 的 `SESSION_DEAD_MARKERS`）；
 * 3. 拿到 2xx、响应体也是 JSON，却**没有** accessToken —— 重试一万次也不会有；
 * 4. 响应体是 HTML 错误页（网关在凭据失效时的典型表现，`json()` 会抛
 *    `Unexpected token '<'`，那个报错对用户毫无信息量，故这里取文本再解析）。
 *
 * 其余（网络异常、5xx、429）→ `retryable: true`，**绝不**报成「请重新登录」。
 */
async function refresh(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential> {
  const refreshToken = credential.refreshToken.trim()
  if (refreshToken === '') {
    throw new ProviderError({
      provider: 'trae',
      message: 'TRAE 凭据缺少 refresh_token，无法自动续期，请重新导出凭据（或重新登录 TRAE 桌面端）',
    })
  }

  let res: Response
  try {
    res = await fetch(`${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // OAuth 端点**无签名**，只发 UA（`trae.ts:408-414`）。
        'User-Agent': TRAE_USER_AGENT,
      },
      body: JSON.stringify({
        ClientID: TRAE_OAUTH_CLIENT_ID,
        RefreshToken: refreshToken,
        ClientSecret: '-',
        UserID: '',
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
    throw new ProviderError({
      provider: 'trae',
      retryable: true,
      message: `TRAE 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // ⚠️ 取文本再尝试解析（**不要**直接用 `response.json()`）：凭据失效时网关会回
  // **HTML 错误页**，`json()` 抛出的 `Unexpected token '<'` 看不出真实原因
  // （`trae-auth.ts:397-408` 的做法与理由）。
  const text = await res.text().catch(() => '')
  let parsed: Record<string, unknown> | undefined
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    parsed = undefined
  }

  const result = parsed === undefined ? undefined : asRecordField(parsed, ['Result', 'result'])
  const accessToken = result === undefined
    ? ''
    : (readString(result, 'Token') || readString(result, 'token') || readString(result, 'accessToken'))
  const lower = text.toLowerCase()

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError({
      provider: 'trae',
      httpStatus: res.status,
      message: `TRAE 登录态已失效（HTTP ${res.status}），请重新登录`,
    })
  }

  if (accessToken === '') {
    // ⚠️ **只在拿不到令牌时才做「会话死亡」文本判定**：那些标记
    // （`login` / `session` / `401`）太宽松，在**成功**响应里也可能偶然命中
    // （例如随机令牌串里恰好含 `401`）。参考实现同样只在失败分支里分类
    // （`trae-auth.ts:414-424` 的 `classifyTraeError` 调用点）。
    if (SESSION_DEAD_MARKERS.some((marker) => lower.includes(marker))) {
      throw new ProviderError({
        provider: 'trae',
        httpStatus: res.status,
        message: `TRAE 登录态已失效（${text.trim().slice(0, 160) || '会话终止'}），请重新登录`,
      })
    }
    // 拿到 2xx + JSON 却没有令牌：同样**不是**瞬时故障（`trae-auth.ts:415-425`）。
    if (res.ok && parsed !== undefined) {
      throw new ProviderError({
        provider: 'trae',
        message: 'TRAE 续期响应缺少访问令牌，请重新登录',
      })
    }
    throw new ProviderError({
      provider: 'trae',
      httpStatus: res.status,
      retryable: res.status >= 500 || res.status === 429,
      message: `TRAE 续期失败（HTTP ${res.status}）：${text.trim().slice(0, 200) || '(空响应体)'}`,
    })
  }

  const nextRefreshRaw = result === undefined ? '' : readString(result, 'RefreshToken')
  // ⚠️ 空值/缺失时保留旧值（见上方「会轮换」说明）。
  const nextRefresh = nextRefreshRaw !== '' ? nextRefreshRaw : credential.refreshToken

  const expiresAt = resolveTraeExpiry(result, accessToken, credential.expiresAt)

  return {
    // ⚠️ `{...credential}` 展开保留 uid / nickname / extras（machine_id、device_id）
    // —— 设备身份不在续期响应里，丢了会让后续请求被判为「异常设备」。
    ...credential,
    accessToken,
    refreshToken: nextRefresh,
    expiresAt,
  }
}

/** 取嵌套对象字段（`trae.ts:435-437` 的 `data.Result ?? data.result`）。 */
function asRecordField(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * 从 ExchangeToken 响应算过期时刻（毫秒）。
 *
 * 判据顺序与参考 `applyTraeRefresh`（`trae.ts:614-640`）**逐条一致**：
 * 1. `TokenExpireAt > 1e12` → 已经是毫秒；
 * 2. `TokenExpireAt > 0` → 秒，×1000（⚠️ Go 端存的是 Unix 秒，见
 *    `trae.ts:78-84`「转换时需 ×1000」，不乘会让凭据永远显示「已过期」）；
 * 3. `TokenExpireDuration > 0` → 相对秒数，`now + ×1000`；
 * 4. 都没有 → 试 JWT 的 `exp`；
 * 5. 仍算不出 → **保留旧值**（不编造）。
 */
function resolveTraeExpiry(
  result: Record<string, unknown> | undefined,
  accessToken: string,
  previous: number,
): number {
  if (result !== undefined) {
    const tokenExpireAt = readNumber(result, 'TokenExpireAt') ?? readNumber(result, 'tokenExpireAt') ?? 0
    if (tokenExpireAt > 1e12) return Math.round(tokenExpireAt)
    if (tokenExpireAt > 0) return Math.round(tokenExpireAt * 1000)
    const duration = readNumber(result, 'TokenExpireDuration') ?? readNumber(result, 'tokenExpireDuration') ?? 0
    if (duration > 0) return Date.now() + Math.round(duration * 1000)
  }
  const fromJwt = decodeJwtExpMs(accessToken)
  return fromJwt ?? previous
}

/** 从 JWT 载荷读 `exp`（秒 → 毫秒）；不是 JWT 或没有 exp 时返回 undefined。 */
function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined || payload === '') return undefined
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const claims = JSON.parse(json) as unknown
    if (typeof claims !== 'object' || claims === null) return undefined
    const exp = (claims as Record<string, unknown>)['exp']
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return Math.round(exp * 1000)
  } catch {
    return undefined
  }
}

/** 会话死亡标记（对齐 Go 端 `sessionDeadMarkers`，`trae-errors.ts:49-56`）。 */
const SESSION_DEAD_MARKERS: readonly string[] = [
  'login', 'token 失效', 'token invalid', 'session', 'unauthorized', '401',
]

// ── 供应商实例 ──

export const traeProvider: Provider = {
  /**
   * 对象判别式：TRAE 凭据的**独有**组合。
   *
   * ⚠️ TRAE 与 buddy 都有 `access_token` + `uid` + `expires_at`，
   * 故必须靠 TRAE 独有的 `machine_id` + `device_id` 组合来判别
   *（`device_id` 是 32 位 hex，见 trae.ts 的注释）。
   * 实测：不加判别时本地 TRAE 凭据被判成 buddy。
   */
  matchesShape(input) {
    return typeof input['machine_id'] === 'string' && typeof input['device_id'] === 'string'
  },
  id: 'trae',
  name: 'TRAE（字节跳动）',
  capabilities: {
    // 🔴 见文件头「登录为什么不可用」：登录回调把 token 直接放在 query 里回传
    // 到 127.0.0.1（`trae-oauth.ts:604,723`），Workers 无法监听本地端口，
    // 且因为没有 `?code=` 连轮询替代都不成立。
    login: false,
    loginBlockedReason:
      'TRAE 登录把访问令牌**直接放在跳转链接的 query 参数里**回传到本机 127.0.0.1 的监听端口，'
      + 'Cloudflare Workers 无法监听本地端口，也没有设备码轮询之类的替代流程。'
      + '请在 TRAE 桌面端登录后导出凭据 JSON，粘贴到本项目的「导入凭据」里 —— '
      + '必须包含 access_token、refresh_token、uid、machine_id 与 device_id'
      + '（machine_id 是设备指纹，缺失时无法自动生成）。',
    listModels: true,
    chat: true,
    balance: true,
    checkin: true,
  },
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  /**
   * ✅ **可静默续期**：`POST {TRAE_OAUTH_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`
   * （大写字段体的 OAuth 交换，完整说明见 {@link refresh}）。
   *
   * ⚠️ **它会轮换 `refresh_token`**：每次续期都下发新值、服务端侧旧值失效。
   * 故 `refresh` 返回的凭据必须**整体落盘**，且 `refreshToken` 用新值覆盖
   * —— 只更新 `accessToken` 会让下一次续期失败。
   *
   * 为什么必须有它：TRAE 的 access_token 寿命按小时计（实测 `exp` 约 14 天，
   * 但服务端会提前作废），过期后所有 Agent/签到请求都被拒，
   * 而凭据里的 `refresh_token` 完好。
   */
  refresh,
  /**
   * 换号判据：
   * - 429（软限流）/ 402 / 401 / 403 值得换号；
   * - **400 也值得换号** —— TRAE 把「该账号在该模型上不可用」（1005 Plan 权益
   *   不足、4008 积分耗尽）以 400 + 业务码下发，另一个账号可能仍有额度
   *   （`trae-errors.ts:133` 的 `shouldRotateTraeAccount` 覆盖了 hard-plan /
   *   quota-exceeded / session-dead / not-found）。
   */
  shouldRotate(status: number): boolean {
    return status === 429 || status === 402 || status === 401 || status === 403 || status === 400
  },
}
