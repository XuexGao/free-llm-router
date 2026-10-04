/**
 * 华为云 CodeArts（码道 Agent）供应商适配器。
 *
 * ## 本供应商的特殊之处（与其它家不同，不要照抄到别家）
 *
 * 1. **认证是华为 `SDK-HMAC-SHA256` 请求签名**，不是 Bearer —— 凭据是
 *    AK / SK / security_token 三元组，其中 security_token 存在
 *    `ProviderCredential.accessToken`，AK/SK 落在 `extras`。
 * 2. **签名参与 canonical request 的头顺序必须字节精确** —— 差一个字符就
 *    401 `APIG.0301`（见 {@link signRequestHuawei} 的逐行说明）。
 * 3. **benefit（免费额度）模型必须带 `maas_type: benefit` 且该头参与签名**
 *    （`llm-adapter.ts:1147-1160`）。
 * 4. 有**每日签到**（`/v1/ops/delivery` → `/v1/ops/claim` → `/v1/ops/confirm`）。
 *
 * ## 🔴 登录为什么不可用（实测结论，不是偷懒）
 *
 * CodeArts 的浏览器登录必须由本地进程起一个 `127.0.0.1:<随机端口>` 的 HTTP
 * 监听来接收回调（源实现 `login.ts:170` 与 `login.ts:287` 两处 `createServer`，
 * 并用 `server.listen(0, '127.0.0.1')` 拿端口）。**Workers 没有监听 socket**，
 * 且**没有轮询替代**：回调是唯一能拿到 `secret` 的通道（`secret` 不通过任何
 * 查询端点下发），故无法用「轮询换设备码」绕开。
 * ⇒ `capabilities.login = false`，只支持从桌面端/IDE 导出凭据后粘贴导入。
 *
 * ## 模型目录为什么是「实时拉取 + 静态兜底」而不是纯静态表
 *
 * 源实现的 `models.ts` **第 1 行就是 `import ... from 'node:fs'`** —— 它把模型
 * 列表与 benefit 集合缓存到 `~/.cache/deveco/*.json`。Workers 既没有
 * `node:fs`（本文件零 `node:` 导入），也没有跨请求的持久磁盘。
 *
 * 故这里的诚实做法是：
 * - **实时拉取**两个签名 GET 端点（`opengw gateway/config` 与
 *   `snap-access/v1/model/builtin`，移植自 `models.ts:159-227`）；
 * - 失败时回落**静态兜底表**（`llm-adapter.ts:47-53` 的 `DEFAULT_MODELS`）；
 * - 缓存只放 **isolate 内存**（同一 isolate 内复用，冷启动重新拉取），
 *   **不做磁盘缓存** —— 那在 Workers 上不存在。
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

// ── 端点常量 ──

/**
 * 推理端点基址。
 *
 * 出处：`llm-adapter.ts:22` 的 `CHAT_API_BASE`，实际请求见
 * `llm-adapter.ts:1114`（`` `${CHAT_API_BASE}/chat/completions` ``）。
 */
export const CODEARTS_CHAT_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'

/** snap-access 网关基址（积分 / 模型目录同一 host）。 */
export const CODEARTS_SNAP_ENGINE_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** 账户/套餐端点（`codearts-credits.ts:82`）。 */
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
/** 活动列表端点（`codearts-credits.ts:84`）。 */
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery'
/** 领取端点（`codearts-credits.ts:86`）。 */
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim'
/** 领取确认端点（`codearts-credits.ts:88`）。 */
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm'
/** 渠道标识（`codearts-credits.ts:91`）。 */
export const CODEARTS_OPS_CHANNEL = 'IDE'

/**
 * benefit（免费额度）模型目录端点（`models.ts:9`）。
 * 响应路径 `result.models[]`。
 */
export const CODEARTS_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * 常规模型目录端点（`models.ts:17`）。
 * 响应路径 `builtinModels[]`。
 */
export const CODEARTS_BUILTIN_MODELS_URL = `${CODEARTS_SNAP_ENGINE_BASE}/v1/model/builtin`

/**
 * 活动列表中「每日签到」的 `type` 取值（`codearts-credits.ts:100`）。
 * 其余三类（邀请 / 新人 / 学生认证）**不属于**每日签到，不能混领。
 */
export const CODEARTS_DAILY_LOGIN_TYPE = 'USER_LOGIN'

/**
 * 已领取状态的取值集合（`codearts-credits.ts:108` 的 `CLAIMED_STATUSES`）。
 *
 * 用于把「今天已领」与「活动未开始 / 无资格」区分开 —— 两者对用户的
 * 含义完全不同，笼统报「不可领取」会让用户以为出了问题。
 */
const CLAIMED_STATUSES: readonly string[] = ['CLAIMED', 'CONFIRMED', 'CONSUMED']

/** 控制面请求超时（毫秒）。与源实现 `codearts-credits.ts:111` 的 30s 同口径。 */
const REQUEST_TIMEOUT_MS = 30_000

// ── 续期（华为 STS OAuth2 + DPoP） ──

/**
 * 华为 STS token 端点（`src/oauth.ts:10` 的 `STS_TOKEN_ENDPOINT`）。
 *
 * ⚠️ 这是**唯一**的续期入口，与推理/积分那套签名端点完全不同源：
 * 它认 OAuth2 表单 + DPoP proof，而不是 `SDK-HMAC-SHA256`。
 */
export const CODEARTS_STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'

/** OAuth client_id（即其 URI scheme，`src/oauth.ts:8` 的 `CLIENT_ID`）。 */
const CODEARTS_OAUTH_CLIENT_ID = 'codearts-agent'

/** 续期请求超时（`src/oauth.ts:12` 的 `TOKEN_TIMEOUT_MS = 60_000`）。 */
const TOKEN_TIMEOUT_MS = 60_000

/** 凭据 extras 里承载 PKCE / DPoP 材料的键名（续期必需，见下方 parseCredential）。 */
const EXTRA_CODE_VERIFIER = 'codeVerifier'
const EXTRA_DPOP_JWK = 'dpopPrivateKeyJwk'

/** ES256 私钥 JWK（P-256；`d` 是私钥材料）。 */
interface DpopPrivateJwk extends Record<string, unknown> {
  kty: string
  crv: string
  x: string
  y: string
  d: string
}

/**
 * snap-access 端点的**签名后追加**头（不参与 canonical request）。
 *
 * ⚠️ 实测结论（`codearts-credits.ts:113-128`）：一旦 `Agent-Type` 进入
 * SignedHeaders，服务端回
 * `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；
 * 同一个头在**签名之后**追加则请求成功。
 *
 * 故这两个头**不能**作为 `signRequestHuawei` 的 `extraHeaders` 传入。
 */
const SNAP_UNSIGNED_HEADERS: Readonly<Record<string, string>> = {
  'Agent-Type': 'PromptCenter',
  'X-Language': 'zh-cn',
}

// ── 静态兜底表（来自源实现，不臆造） ──

/**
 * 远端目录不可用时的兜底模型表。
 *
 * 出处：`llm-adapter.ts:47-53` 的 `DEFAULT_MODELS`，**顺序照抄**。
 */
const FALLBACK_MODELS: readonly string[] = [
  'GLM-5.2', 'GLM-5.1', 'GLM-5',
  'glm-5.3-flash',
  'openpangu-2.0-flash', 'openpangu-2.0-pro',
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'deepseek-v4.1-flash',
]

/**
 * 已知上下文窗口（`llm-adapter.ts:64-70` 的 `CONTEXT_WINDOWS`）。
 *
 * ⚠️ 表里没有的模型给 0（未知），**不编造数值** —— 编造会让客户端算出错误的
 * 上下文预算并提前/过晚触发压缩。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['GLM-5.2', 202_752],
  ['glm-5.3-flash', 1_048_576],
  ['deepseek-v4-flash', 1_048_576],
  ['deepseek-v4-pro', 1_048_576],
  ['deepseek-v4.1-flash', 1_000_000],
])

/**
 * benefit（免费额度）模型兜底集合（`models.ts:52` 的 `CODEARTS_BENEFIT_FALLBACK`）。
 *
 * ⚠️ **判定不能靠「名字里带 flash」这类猜测**：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却相反 —— 前者带上
 * `maas_type` 会 `unsupported model`。唯一权威来源是 gateway/config 的模型
 * 清单 ∪ 本兜底表（`models.ts:351-365`）。
 */
const BENEFIT_FALLBACK: readonly string[] = ['glm-5.3-flash', 'deepseek-v4.1-flash']

// ── 签名（华为 SDK-HMAC-SHA256） ──

/** 字节数组 → 小写 hex。 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `SHA-256` 摘要的 hex（Workers 原生支持 `crypto.subtle.digest`）。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // `.slice()` 复制一份：避免把调用方的视图（可能是大 Buffer 的子视图）整体
  // 传给 digest，那会把 buffer 尾部无关字节一起算进去。
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return toHex(new Uint8Array(hash))
}

/** `HMAC-SHA256` 的 hex（Workers 原生支持 `crypto.subtle.sign`）。 */
export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer)
  return toHex(new Uint8Array(sig))
}

/**
 * 拼装 canonical request。
 *
 * 格式（`sign.ts:13-25`，逐字节照抄）：六段以 `\n` 连接 ——
 *
 * ```
 * ${method}
 * ${uri}
 * ${query}
 * ${header1:value1}\n${header2:value2}      ← 已按头名**字典序**排列
 *                                          ← 空行（header 段与 SignedHeaders 之间）
 * ${signedHeaders 以 ';' 连接}
 * ${payloadHash}
 * ```
 *
 * ⚠️ 头段与 SignedHeaders 之间是**一个空行**（`['a','b','c','d','','e','f']`），
 * 少写或多写都会导致服务端验签失败。
 */
export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

/**
 * 用华为 `SDK-HMAC-SHA256` 签名一个请求，返回**需要合并到请求里的全部头**。
 *
 * 移植自 `sign.ts:28-68`，**逐行对齐**（包括两个反直觉但实测必须的点）：
 *
 * 1. `uri` 若不以 `/` 结尾会**补一个 `/`**（`sign.ts:38-39`）。于是
 *    `/api/v2/chat/completions` 在签名里是 `/api/v2/chat/completions/`。
 *    这看起来像 bug，但它是服务端验签时用的同一规则 —— 改成「正确」的写法
 *    会让**每一个**请求 401。不要「顺手修好它」。
 * 2. `dateStamp` 是 ISO 串去掉 `-` 与 `:`（`20261003T120000Z`），不是 Unix 时间戳。
 *
 * @param extraHeaders 需要**参与签名**的额外头（如 benefit 模型的
 *   `maas_type: benefit`）。它们会进 canonical request 与 SignedHeaders，
 *   因此**必须原样随请求发送**，否则服务端验签失败（`llm-adapter.ts:1158-1160`）。
 * @returns 头映射（含 `host`）。调用方**必须跳过 `host`** —— 那是 fetch 自己
 *   按连接目标生成的，手工设置会被运行时忽略/拒绝。
 */
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = await sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // GET 不带请求体，因此无 content-type（与源实现一致）。
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign))
  headers.set(
    'Authorization',
    `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`,
  )
  return headers
}

/** 把签名结果装进 `Headers`（跳过 `host`）。 */
function signedHeadersToHeaders(signed: Map<string, string>): Headers {
  const headers = new Headers()
  signed.forEach((value, key) => {
    // `host` 由运行时按实际连接目标生成，手工设置会被 fetch 拒绝/忽略。
    if (key !== 'host') headers.set(key, value)
  })
  return headers
}

// ── JSON 安全读取 ──

/** 从 JSON 安全读取字符串（兼容服务端把标识符下发成数字）。 */
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
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 从 JSON 安全读取布尔（兼容 `true` / `'true'`）。 */
function readBool(source: Record<string, unknown>, key: string): boolean {
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

/** 取出一个非数组的对象值；不是对象时返回空对象。 */
function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ── benefit 判定与模型目录缓存 ──

/**
 * 远端下发的 benefit 模型 id 集合（isolate 内存缓存）。
 *
 * ⚠️ 与源实现（写 `~/.cache/deveco/codearts_benefit_models.json`）的差异：
 * Workers 无持久磁盘，故只缓存到 isolate 内存。冷启动后第一次 `listModels`
 * 会重新拉取；在拉取完成前，benefit 判定回落到静态兜底集合 —— 兜底集合里的
 * 两个模型（`glm-5.3-flash` / `deepseek-v4.1-flash`）正是最常用的免费模型，
 * 故这个窗口期不会影响主要用法。
 */
let remoteBenefitIds: string[] | undefined

/** 模型目录的 isolate 内存缓存。 */
let cachedModels: ProviderModel[] | undefined
let cachedModelsAt = 0
/** 目录缓存有效期（2 小时，与源实现 `models.ts:58` 的刷新间隔同口径）。 */
const MODEL_CACHE_TTL_MS = 2 * 3_600_000

/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`（`models.ts:362-365`）。
 *
 * ⚠️ 这是**必须**的：不带该头，benefit 模型一律
 * `InferHub.002002009.404 The model is not registered`
 * （`llm-adapter.ts:1139-1146`）。
 */
export function isCodeArtsBenefitModel(model: string): boolean {
  if (remoteBenefitIds !== undefined && remoteBenefitIds.includes(model)) return true
  return BENEFIT_FALLBACK.includes(model)
}

/** 去掉模型 id 末尾的日期版本后缀（`models.ts:77-85` 的 `normalizeModelId`）。 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

/**
 * 解析模型条目（`models.ts:87-100`）。
 *
 * ⚠️ 过滤视觉（VL）模型：id 含 `-VL-` 或以 `-VL` 结尾的条目上下文小、
 * 不支持工具调用，不适合当 agent 主模型（源实现同样剔除）。
 */
function parseModelEntry(entry: Record<string, unknown>, seen: Set<string>): { id: string; name: string } | undefined {
  const rawId = readString(entry, 'model_id')
  if (rawId.length === 0) return undefined
  const id = normalizeModelId(rawId)
  if (id.includes('-VL-') || id.endsWith('-VL')) return undefined
  const rawName = readString(entry, 'model_name')
  const name = rawName.length > 0 ? normalizeModelId(rawName) : id
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name }
}

/** 沿路径取数组（解析失败返回 undefined）。 */
function extractArray(payload: unknown, path: readonly string[]): unknown[] | undefined {
  let value: unknown = payload
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return Array.isArray(value) ? value : undefined
}

/** 一次签名 GET；非 2xx / 网络失败返回 undefined（调用方回落到兜底）。 */
async function signedGet(
  url: string,
  credential: ProviderCredential,
  signal: AbortSignal,
  unsignedHeaders?: Readonly<Record<string, string>>,
): Promise<unknown | undefined> {
  const signed = await signRequestHuawei(
    credential.extras.ak ?? '',
    credential.extras.sk ?? '',
    credential.accessToken,
    'GET',
    url,
    new Uint8Array(),
  )
  const headers = signedHeadersToHeaders(signed)
  if (unsignedHeaders !== undefined) {
    for (const [key, value] of Object.entries(unsignedHeaders)) headers.set(key, value)
  }
  try {
    const res = await fetch(url, { method: 'GET', headers, signal })
    if (!res.ok) return undefined
    return (await res.json()) as unknown
  } catch {
    return undefined
  }
}

// ── 凭据解析 ──

/**
 * 解析 CodeArts 凭据。
 *
 * ## 字段落点（**这是本供应商最容易搞错的地方**）
 *
 * | 华为凭据字段 | 本项目字段 | 说明 |
 * |---|---|---|
 * | `security_token` / `securityToken` / `access` | `accessToken` | 签名头 `x-security-token` 的值 |
 * | `access_key_id` / `accessKeyId` | `extras.ak` | 签名 `Access=` 的值 |
 * | `secret_access_key` / `secretAccessKey` | `extras.sk` | HMAC 的密钥 |
 *
 * ⚠️ `ProviderCredential.accessToken` 装的是 **security_token**（不是 AK）——
 * 这是刻意的：网关/账号池把 `accessToken` 当作「可续期的主令牌」，而
 * CodeArts 的续期轮换的正是 security_token（AK/SK 长期不变）。
 *
 * ## 宽容度
 *
 * 认三种真实形态：
 * 1. **本项目扁平形**：`{ access_token | security_token, ak, sk, uid?, nickname? }`；
 * 2. **华为 IAM `credential` 形**（`types.ts:5-13`）：
 *    `{ credential: { access, secret, securitytoken } }`；
 * 3. **华为 IAM `result` 形**（`types.ts:14-20`）：
 *    `{ result: { accessKeyId, secretAccessKey, securityToken } }`。
 *
 * 也认 snake_case 与 camelCase 两种拼写，并自动在嵌套层里找。
 *
 * ⚠️ **三元组缺任何一个都抛错**。绝不把 token 兜底成 `''` ——
 * 那会产出「永远 401」的凭据，是最难排查的失败形态（`types.ts:148-151`）。
 */
function parseCredential(input: unknown): ProviderCredential {
  const root = unwrapCredentialRoot(input)

  // ── security_token（必填） ──
  const securityToken = pickString(root, [
    'security_token', 'securityToken', 'securitytoken', 'access_token', 'accessToken', 'access', 'token',
  ])
  if (securityToken === '') {
    throw new ProviderError({
      provider: 'codearts',
      message:
        'CodeArts 凭据缺少 security_token（华为签名必需）。'
        + '请从码道 IDE / 桌面端导出凭据，或从 IAM 临时凭证里复制 `security_token`（也写作 `credential.securitytoken`）。',
    })
  }

  // ── AK / SK（必填） ──
  const ak = pickString(root, ['ak', 'access_key_id', 'accessKeyId', 'accessKey', 'AccessKeyId'])
  // `secret` 是华为 IAM `credential` 对象里的字段名（`types.ts:8`），
  // 排在最后 —— 它最泛化，只在前面几个具体名字都拿不到时才用。
  const sk = pickString(root, ['sk', 'secret_access_key', 'secretAccessKey', 'secretKey', 'SecretAccessKey', 'secret'])

  const missing: string[] = []
  if (ak === '') missing.push('AK（access_key_id）')
  if (sk === '') missing.push('SK（secret_access_key）')
  if (missing.length > 0) {
    throw new ProviderError({
      provider: 'codearts',
      message:
        `CodeArts 凭据缺少 ${missing.join(' 与 ')}。`
        + '华为云 `SDK-HMAC-SHA256` 签名必须同时具备 AK / SK / security_token 三者'
        + '（只有 security_token 无法签名，只有 AK/SK 无法通过临时凭据校验）。',
    })
  }

  // ── 账号稳定标识 ──
  // 优先服务端下发的 user_id / domain_id；都没有时回落 **AK** ——
  // AK 与账号一一对应且长期不变，是这里唯一稳定的标识（security_token 会轮换，
  // 拿它当主键会导致续期后账号池多出一条「新账号」）。
  const uid = pickString(root, ['uid', 'user_id', 'userId', 'domain_id', 'domainId']) || `ak:${ak}`
  const nickname = pickString(root, ['nickname', 'user_name', 'userName', 'name']) || 'CodeArts'
  const expiresAt = pickExpiresAt(root)

  /**
   * ⚠️ **续期所需的另外两样材料必须一起存下来**（`types.ts:931-934` 的
   * `CodeArtsCredential`）：`code_verifier`（PKCE，服务端拿它的 S256 对上授权
   * 时的 code_challenge）与 `dpop_private_key_jwk`（签 DPoP proof，服务端拿它
   * 与 refresh_token 里的 `cnf.jkt` 比对）。
   *
   * 少任一样，`refresh()` 只能抛「材料不全，请重新登录」—— 从而把一份
   * **本可自愈**的凭据变成必须人工重登的废凭据（参考 `src/service.ts:18-30`
   * 的 `isCodeArtsRefreshable` 就是这三样缺一不可）。
   */
  const extras: Record<string, string> = { ak, sk }
  const codeVerifier = pickString(root, ['code_verifier', 'codeVerifier'])
  if (codeVerifier !== '') extras[EXTRA_CODE_VERIFIER] = codeVerifier
  const dpopJwk = asJwk(root['dpop_private_key_jwk'] ?? root['dpopPrivateKeyJwk'])
  if (dpopJwk !== undefined) extras[EXTRA_DPOP_JWK] = JSON.stringify(dpopJwk)

  return {
    provider: 'codearts',
    uid,
    accessToken: securityToken,
    refreshToken: pickString(root, ['refresh_token', 'refreshToken']),
    expiresAt,
    nickname,
    extras,
  }
}

/** 取出一个合法的 ES256 私钥 JWK（形状不符返回 undefined，绝不半信半疑地用）。 */
function asJwk(value: unknown): DpopPrivateJwk | undefined {
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return asJwk(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kty = record['kty']
  const crv = record['crv']
  const x = record['x']
  const y = record['y']
  const d = record['d']
  if (kty !== 'EC' || crv !== 'P-256') return undefined
  if (typeof x !== 'string' || typeof y !== 'string' || typeof d !== 'string') return undefined
  return { kty, crv, x, y, d }
}

/**
 * 把用户粘贴的任意形状收敛到一个「字段字典」。
 *
 * 用户可能粘贴：整个凭据 JSON、`{credential:{...}}`、`{result:{...}}`、
 * 甚至是带 `data` 包装的响应体。这里逐层下钻，把找到的层**合并**成一个
 * 平铺字典（外层优先，因为外层是用户直接写的语义）。
 */
function unwrapCredentialRoot(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProviderError({
      provider: 'codearts',
      message: 'CodeArts 凭据必须是一个 JSON 对象（含 ak / sk / security_token）。',
    })
  }
  const root = input as Record<string, unknown>
  const merged: Record<string, unknown> = { ...root }
  // 只在需要的字段确实缺失时下钻，避免内层的同名字段覆盖用户显式写的值。
  for (const key of ['credential', 'result', 'data', 'auth', 'codearts']) {
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
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601。⚠️ **秒 → 毫秒必须 ×1000** ——
 * 源项目记录过这个坑（AGENTS.md §9「`expiresAt` 单位」），不乘会让凭据
 * 永远被判定为「已过期」，从而每次请求都触发一次无意义的续期。
 *
 * 取不到时返回 0（= 未知/不过期），**不编造**一个「一小时后」的假值。
 */
function pickExpiresAt(source: Record<string, unknown>): number {
  const raw = pickString(source, ['expires_at', 'expiresAt', 'expiration', 'expireTime'])
  if (raw === '') return 0
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

// ── 模型目录 ──

/**
 * 列出模型目录。
 *
 * 实时拉取两个签名端点并合并去重（`models.ts:159-227`）：
 * 1. `opengw gateway/config` → `result.models[]`（benefit 模型）
 * 2. `snap-access /v1/model/builtin` → `builtinModels[]`（常规模型）
 *
 * 两者都失败时回落静态兜底表 —— **不抛错**：目录是建议性的，拉不到远端
 * 不代表不能对话（对话用的是调用方指定的模型 id）。
 *
 * ⚠️ 只把**未被改写 id** 的 gateway 条目记为 benefit：`normalizeModelId` 会把
 * `deepseek-v4-flash-0731` 改写成 `deepseek-v4-flash`，而两者在后端是不同模型、
 * benefit 属性相反（`models.ts:170-177`）。记录被改写过的 id 会把无后缀模型
 * 错误标成 benefit，导致它反而调用失败。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const now = Date.now()
  if (cachedModels !== undefined && now - cachedModelsAt < MODEL_CACHE_TTL_MS) return cachedModels

  const seen = new Set<string>()
  const entries: Array<{ id: string; name: string }> = []
  const benefitIds: string[] = []

  const gateway = await signedGet(CODEARTS_GATEWAY_CONFIG_URL, credential, signal)
  const gatewayModels = gateway === undefined ? undefined : extractArray(gateway, ['result', 'models'])
  if (gatewayModels !== undefined) {
    for (const item of gatewayModels) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const rawId = readString(entry, 'model_id')
      const parsed = parseModelEntry(entry, seen)
      if (parsed === undefined) continue
      if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(parsed.id)
      entries.push(parsed)
    }
  }

  const builtin = await signedGet(CODEARTS_BUILTIN_MODELS_URL, credential, signal, SNAP_UNSIGNED_HEADERS)
  const builtinModels = builtin === undefined ? undefined : extractArray(builtin, ['builtinModels'])
  if (builtinModels !== undefined) {
    for (const item of builtinModels) {
      if (typeof item !== 'object' || item === null) continue
      const parsed = parseModelEntry(item as Record<string, unknown>, seen)
      if (parsed !== undefined) entries.push(parsed)
    }
  }

  // 只在确实拿到 benefit 清单时才覆盖缓存，避免一次空响应把可用集合清空
  // （`models.ts:219-224` 同款取舍）。
  if (benefitIds.length > 0) remoteBenefitIds = benefitIds

  const source = entries.length > 0 ? entries : FALLBACK_MODELS.map((id) => ({ id, name: id }))
  const models: ProviderModel[] = source.map((entry) => ({
    id: entry.id,
    name: entry.name,
    contextWindow: CONTEXT_WINDOWS.get(entry.id) ?? 0,
    // CodeArts 的目录响应里有 `max_tokens` 之类的字段，但源实现并不消费它
    // （`llm-adapter.ts` 目录只取 id/name）。这里给 0 = 未知，不编造。
    maxOutput: 0,
    // VL 多模态条目已在 parseModelEntry 里被剔除（源实现的同一策略），
    // 故这里恒 false —— 而非「猜」某个模型支持图片。
    supportsImage: false,
    isFree: isCodeArtsBenefitModel(entry.id),
  }))

  cachedModels = models
  cachedModelsAt = now
  return models
}

// ── 对话 ──

/**
 * 发起流式对话，返回**上游原始响应**（由共享网关逐帧透传）。
 *
 * 移植要点（`llm-adapter.ts:1082-1171`）：
 * - 请求体是 **OpenAI 兼容形状**，故直接透传网关清洗过的 body；只强制
 *   `stream: true`（网关已做）并补 `tool_stream: true`，后者让后端把超大工具
 *   调用参数分段流式下发，避免单次 SSE 事件过大导致连接被掐断
 *   （`llm-adapter.ts:1099-1104`）。
 * - benefit 模型必须带 `maas_type: benefit`，且**该头参与签名**
 *   （`llm-adapter.ts:1147-1160`）。
 * - 若该账号没有 benefit 包，服务端会以 HTTP 200 + SSE
 *   `InferHub.4004.200 benefit not found` 拒绝。源实现在流里检测该码后
 *   去掉头重试一次。本层**不做**流内重试（那要求把响应体读进内存，破坏流式），
 *   改为如实透传错误帧给客户端 —— 由调用方换号或换模型。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const body: Record<string, unknown> = { ...request.body, stream: true, tool_stream: true }
  const payload = new TextEncoder().encode(JSON.stringify(body))
  const url = `${CODEARTS_CHAT_BASE}/chat/completions`

  const extraSignedHeaders = isCodeArtsBenefitModel(request.model) ? { maas_type: 'benefit' } : undefined
  const signed = await signRequestHuawei(
    credential.extras.ak ?? '',
    credential.extras.sk ?? '',
    credential.accessToken,
    'POST',
    url,
    payload,
    extraSignedHeaders,
  )
  const headers = signedHeadersToHeaders(signed)
  headers.set('Content-Type', 'application/json')
  // Chat-Id / Session-Id 参与服务端的前缀缓存与并发会话计数
  // （`llm-adapter.ts:1162-1164`）；每次请求新生成即可。
  headers.set('Chat-Id', crypto.randomUUID().replaceAll('-', ''))
  headers.set('Session-Id', crypto.randomUUID().replaceAll('-', ''))
  headers.set('lang', 'en')

  try {
    return await fetch(url, { method: 'POST', headers, body: payload, signal: request.signal })
  } catch (error) {
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 请求失败（网络层）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }
}

// ── 积分：余额与签到 ──

/** 一次签名请求的解析结果。 */
type SnapResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/**
 * 把非 2xx 响应整理成**带服务端原因**的说明（`codearts-credits.ts:223-236`）。
 *
 * 为什么不能只写 `HTTP 401`：华为网关的错误体里带着真正的原因，例如
 * `{"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`。
 * 丢掉它会让「签名头位置不对」「凭据过期」「AK 无权限」这些**处置方式完全
 * 不同**的问题看起来一模一样。
 */
function describeHttpFailure(status: number, text: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const code = readString(parsed, 'error_code')
    const msg = readString(parsed, 'error_msg')
    detail = [code, msg].filter((part) => part.length > 0).join(' ')
  } catch {
    // 非 JSON（网关 HTML 错误页等）：截断原文，避免把整页 HTML 塞进 UI。
    detail = text.trim().slice(0, 200)
  }
  return detail.length > 0 ? `HTTP ${status}：${detail}` : `HTTP ${status}`
}

/**
 * 解包响应信封（`codearts-credits.ts:303-325`）。
 *
 * **必须兼容两种形态**，因为两个端点的信封结构不同：
 * - `ops/*` 返回 `{ code, message, data }`，且 `code !== 0` 即业务失败；
 * - `statistics/plugin` **直接返回裸对象**（没有 `data` 解包步骤）。
 *
 * 判定顺序：先看 `code`（存在且非 0 即失败），再取 `data`，没有 `data`
 * 就认为 body 本身即数据。这样两种形态都能正确解析，且不会把业务失败
 * 当成成功。
 */
function unwrapSnapEnvelope(raw: Record<string, unknown>): SnapResult {
  const code = raw.code
  if (typeof code === 'number') {
    if (code !== 0) {
      const message = readString(raw, 'message') || readString(raw, 'msg')
      return { ok: false, code, message: message.length > 0 ? message : `业务码 ${code}` }
    }
    const data = raw.data
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return { ok: true, data: data as Record<string, unknown> }
    }
    return { ok: false, code, message: '响应缺少 data 字段' }
  }
  // 无 code 字段：裸对象形态（statistics/plugin）。
  return { ok: true, data: raw }
}

/** 发起一次带签名的 snap-access 请求（失败保留原因）。 */
async function signedSnapRequest(
  method: 'GET' | 'POST',
  url: string,
  credential: ProviderCredential,
  body: string | undefined,
  signal: AbortSignal,
): Promise<SnapResult> {
  try {
    const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(body)
    // 签名**不含** SNAP_UNSIGNED_HEADERS：那两个头在签名后追加
    // （`codearts-credits.ts:340-348`）。
    const signed = await signRequestHuawei(
      credential.extras.ak ?? '',
      credential.extras.sk ?? '',
      credential.accessToken,
      method,
      url,
      payload,
    )
    const headers = signedHeadersToHeaders(signed)
    for (const [key, value] of Object.entries(SNAP_UNSIGNED_HEADERS)) headers.set(key, value)

    const res = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      // 调用方传入的 signal（网关在客户端断开时取消）优先，叠加 30s 上限。
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    const text = await res.text()
    if (!res.ok) {
      // 把服务端的错误码/原因带出来 —— 只报 `HTTP 401` 会让「签名头放错位置」
      // 这类问题极难定位（源实现踩过，见 describeHttpFailure 的注释）。
      return { ok: false, code: res.status, message: describeHttpFailure(res.status, text) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, code: -1, message: '请求失败或响应无法解析' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: -1, message: '请求失败或响应无法解析' }
    }
    return unwrapSnapEnvelope(parsed as Record<string, unknown>)
  } catch (error) {
    return { ok: false, code: -1, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 积分 metric 名 → 展示名（`codearts-credits.ts:142-148`）。 */
const CREDIT_METRIC_LABELS: Readonly<Record<string, string>> = {
  usageTotalPackageCredit: '总积分包',
  usageBasicPackageCredit: '基础积分包',
  usageOnDemandPackageCredit: '按需积分包',
  usageBonusPackageCredit: '赠送积分包',
}

/** 总额 metric 名（`codearts-credits.ts:150`）。 */
const TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit'

/** 查余额。 */
async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const url = `${CODEARTS_SNAP_ENGINE_BASE}${CODEARTS_PACKAGE_INFO_PATH}`
  const result = await signedSnapRequest('GET', url, credential, undefined, signal)
  if (!result.ok) {
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 账户信息查询失败：${result.message}`,
      httpStatus: result.code > 0 ? result.code : 0,
      retryable: result.code === 429 || result.code === 402,
    })
  }

  const metrics = result.data.metrics
  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  let totalRemain: number | undefined
  let sawAnyCreditMetric = false

  if (Array.isArray(metrics)) {
    for (const item of metrics) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const label = CREDIT_METRIC_LABELS[readString(record, 'name')]
      if (label === undefined) continue
      sawAnyCreditMetric = true
      const amount = readNumber(record, 'package_credit_amount')
      const remain = readNumber(record, 'package_credit_remain')
      if (readString(record, 'name') === TOTAL_CREDIT_METRIC) totalRemain = remain
      // 额度为 0 的分类不列为资源包：列出来只会让「N 个资源包」虚高。
      if (amount <= 0 && remain <= 0) continue
      packages.push({
        name: label,
        amount: remain,
        // `statistics/plugin` **不下发**资源包的有效期字段（那是腾讯侧的形态）。
        // 如实置 0（= 无到期信息），而不是臆造一个到期时间 ——
        // 臆造会让面板显示错误的「即将过期」提醒。
        expiry: 0,
      })
    }
  }

  if (!sawAnyCreditMetric) {
    // 非积分计费账户（Token 计费）：没有积分口径。返回 0 而非抛错 ——
    // 「这个账号没有积分账户」是正常业务状态，不是失败。
    return { total: 0, expiring: 0, earliestExpiry: 0, packages: [] }
  }

  const total = totalRemain ?? packages.reduce((sum, pkg) => sum + pkg.amount, 0)
  return {
    total: Math.round(total * 100) / 100,
    // 服务端不给到期时间，故「即将过期」与「最早到期」如实为 0。
    expiring: 0,
    earliestExpiry: 0,
    packages,
  }
}

/**
 * 每日签到（完整三步流程，`codearts-credits.ts:568-641`）。
 *
 * 判定顺序（每一步都对应一个**对用户含义不同**的结果）：
 * 1. 查账户类型 —— 非积分账户 → 抛 `ProviderError`（活动范围明确限定
 *    「已升级到积分计费模式的用户」，Token 账户不该被报成「签到失败」，
 *    但也不能假装成功）；
 * 2. 查活动列表 —— 无 `USER_LOGIN` 活动 → 抛错（活动未对账号开放）；
 * 3. 活动不可领取且状态属已领取态 → `alreadyDone: true`；
 * 4. `POST /v1/ops/claim`；
 * 5. 响应 `id !== null` 时补 `POST /v1/ops/confirm`（漏掉会让积分停在
 *    「待确认」而不入账，`codearts-credits.ts:615-624`）。
 *
 * ⚠️ 第 3 步是**唯一**的幂等保护：本协议没有幂等键，也没有服务端
 * 「今天已签到」业务码可依赖（`codearts-credits.ts:55-61`），故预检不能省。
 */
async function checkin(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult> {
  const account = await signedSnapRequest(
    'GET',
    `${CODEARTS_SNAP_ENGINE_BASE}${CODEARTS_PACKAGE_INFO_PATH}`,
    credential,
    undefined,
    signal,
  )
  if (!account.ok) {
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 签到前置失败（账户信息查询）：${account.message}`,
      retryable: account.code === 429,
    })
  }
  const pkg = readRecord(account.data, 'package')
  if (!readBool(pkg, 'is_credit_package')) {
    throw new ProviderError({
      provider: 'codearts',
      message: readBool(pkg, 'is_token_package')
        ? 'CodeArts 签到不可用：该账号是 Token 计费账户，不在「每日签到得积分」活动范围内。'
        : 'CodeArts 签到不可用：该账号不是积分计费账户，不在「每日签到得积分」活动范围内。',
    })
  }

  const delivery = await signedSnapRequest(
    'GET',
    `${CODEARTS_SNAP_ENGINE_BASE}${CODEARTS_OPS_DELIVERY_PATH}?channel=${CODEARTS_OPS_CHANNEL}`,
    credential,
    undefined,
    signal,
  )
  if (!delivery.ok) {
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 签到前置失败（活动列表查询）：${delivery.message}`,
      retryable: delivery.code === 429,
    })
  }
  const items = delivery.data.items
  if (!Array.isArray(items)) {
    throw new ProviderError({ provider: 'codearts', message: 'CodeArts 签到前置失败：活动列表响应缺少 items 字段' })
  }

  const activities = items
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
  const activity = activities.find((item) => readString(item, 'type') === CODEARTS_DAILY_LOGIN_TYPE)
  if (activity === undefined) {
    throw new ProviderError({
      provider: 'codearts',
      message: 'CodeArts 签到不可用：活动列表里没有「每日登录领取」（USER_LOGIN）活动，该账号当前不在活动范围内。',
    })
  }

  // 已领取判据：`claimable === false` 且 status 属于已领取态。
  if (!readBool(activity, 'claimable')) {
    const status = readString(activity, 'status')
    if (CLAIMED_STATUSES.includes(status)) {
      return { alreadyDone: true, gained: 0, detail: '今天已签到（服务端状态：已领取）' }
    }
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 签到不可用：活动当前不可领取（status=${status || '未知'}），既非「已领取」也非「可领取」。`,
    })
  }

  // ⚠️ campaignId 服务端下发的是**数字**（实测 `1`），故用 readString 的
  // 数字兼容分支读取，再以字符串回传（`codearts-credits.ts:274-291`）。
  const campaignId = readString(activity, 'campaignId')
  if (campaignId === '') {
    throw new ProviderError({ provider: 'codearts', message: 'CodeArts 签到失败：活动缺少 campaignId，无法领取' })
  }

  const claim = await signedSnapRequest(
    'POST',
    `${CODEARTS_SNAP_ENGINE_BASE}${CODEARTS_OPS_CLAIM_PATH}`,
    credential,
    JSON.stringify({ campaignId, channel: CODEARTS_OPS_CHANNEL }),
    signal,
  )
  if (!claim.ok) {
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 签到领取失败：${claim.message}`,
      httpStatus: claim.code > 0 ? claim.code : 0,
      retryable: claim.code === 429,
    })
  }

  // 服务端要求确认时才补 confirm（判据 `benefit.id !== null`）。
  // ⚠️ confirm 失败**不**把整体判为失败：积分已进入待确认态，报失败会让
  // 用户以为没领到而重复点击（`codearts-credits.ts:615-624`）。
  const benefitId = claim.data.id
  if (benefitId !== null && benefitId !== undefined) {
    await signedSnapRequest(
      'POST',
      `${CODEARTS_SNAP_ENGINE_BASE}${CODEARTS_OPS_CONFIRM_PATH}`,
      credential,
      JSON.stringify({ campaignId }),
      signal,
    )
  }

  // 积分取多级回退：领取响应 → 活动条目。两处都没有时如实记 0，
  // 不臆造「1000」——文档里的 1000 是活动规则，不是本次发放的实测值。
  const gained = readNumber(claim.data, 'benefitAmount')
    || readNumber(claim.data, 'credit')
    || readNumber(claim.data, 'credits')
    || readNumber(claim.data, 'creditAmount')
    || readNumber(claim.data, 'amount')
    || readNumber(activity, 'benefitAmount')
    || readNumber(activity, 'amount')

  return {
    alreadyDone: false,
    gained,
    detail: gained > 0 ? `签到成功，获得 ${gained} 积分` : '签到成功（服务端未下发本次积分数量）',
  }
}

// ── 续期（OAuth2 refresh_token + DPoP） ──

/** base64url 编码（**去 padding**，DPoP 的 `jti` / JWS 段都用这个形态）。 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** UTF-8 文本 → base64url。 */
function base64UrlFromText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text))
}

/**
 * 用持久化的 DPoP 私钥签一个 `dpop+jwt`（`src/oauth.ts:74-85` 的 `signDpopJws`）。
 *
 * 载荷字段与参考**逐字一致**：`htm`（HTTP 方法）、`htu`（完整 URL，**不含 query**）、
 * `iat`（秒）、`jti`（32 字节 hex）。头部必须带 `jwk` —— 服务端要用公钥验签，
 * 并把它与 refresh_token 里的 `cnf.jkt` 比对。
 */
async function signDpopJws(jwk: DpopPrivateJwk, htm: string, htu: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const header = base64UrlFromText(JSON.stringify({
    alg: 'ES256',
    typ: 'dpop+jwt',
    // ⚠️ 只带公钥字段：把 `d` 放进 `jwk` 会**泄漏私钥**给上游（且不符合 RFC 9449）。
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  }))
  const jtiBytes = crypto.getRandomValues(new Uint8Array(32))
  const payload = base64UrlFromText(JSON.stringify({
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: toHex(jtiBytes),
  }))
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  // ⚠️ WebCrypto 的 ECDSA 输出就是 JWS 要的 **raw r||s**（各 32 字节），
  // 与 jose 的产物一致，**不需要**再做 DER 转换。
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

/**
 * 用 `refresh_token` 换一份新凭据。
 *
 * ## 协议（`src/oauth.ts:96-176`，逐字对齐）
 *
 * ```
 * POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 * headers: DPoP: <ES256 dpop+jwt>   Content-Type: application/x-www-form-urlencoded
 * body:    client_id=codearts-agent&code_verifier=…&grant_type=refresh_token
 *          &refresh_token=…
 * → { credentials: { access_key_id, secret_access_key, security_token, expiration },
 *     refresh_token }
 * ```
 *
 * ⚠️ **`code_verifier` 必须重发**：服务端拿它的 S256 对上授权时的 challenge，
 * 少了它直接换不到 token。而它**不在** access token 里，只能靠
 * {@link parseCredential} 一起存进 `extras`（这就是上面要存它的原因）。
 *
 * ⚠️ **DPoP proof 的 `htu` 是完整 URL 且不带 query**（参考实现传的就是常量
 * `STS_TOKEN_ENDPOINT` 本身）。
 *
 * ## 终态判定（**只认 refresh_token 自己失效的信号**，`src/oauth.ts:122-141`）
 *
 * - `error === 'invalid_grant'` 或 `error_code` 含 `ExpiredRefreshToken` → 终态；
 * - ⚠️ **`InvalidDPoPHeader` 不算终态**：它说的是「这次 proof 没过校验」
 *   （时钟偏差、重放判定、网关抖动），与 refresh_token 还能不能用无关。
 *   把它当终态会把材料完好的账号一步标死，只能人工重登
 *   （参考项目为此专门记录了一次真实缺陷）。
 * - 网络异常 → `retryable: true`。
 *
 * ## 返回值
 *
 * 新 `security_token` 写进 `accessToken`；**AK/SK 被服务端轮换时用新值**，
 * 未下发时保留旧的（`extras.ak` / `extras.sk` 同时也是 uid 的来源，不能丢）。
 */
async function refresh(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderCredential> {
  const refreshToken = credential.refreshToken.trim()
  const codeVerifier = (credential.extras[EXTRA_CODE_VERIFIER] ?? '').trim()
  const jwkRaw = credential.extras[EXTRA_DPOP_JWK] ?? ''
  const jwk = asJwk(jwkRaw)

  // 三样缺一即不可静默续期（参考 `src/service.ts:18-30` 的 `isCodeArtsRefreshable`）。
  const missing: string[] = []
  if (refreshToken === '') missing.push('refresh_token')
  if (codeVerifier === '') missing.push('code_verifier')
  if (jwk === undefined) missing.push('dpop_private_key_jwk')
  // ⚠️ 把 `jwk === undefined` 放进同一个条件里（而不是单独一条 `if`）：
  // 这样通过之后 TypeScript 能**收窄** `jwk` 的类型，否则下面签名处报
  // 「可能为 undefined」—— 而那句本该不可达的判空只是为了让类型系统满意。
  if (jwk === undefined || missing.length > 0) {
    // ⚠️ 这不是「网络抖动」，重试一万次也不会好 —— 明确让用户重新登录，
    // 并说清缺什么（否则用户看到「续期失败」不知道该补哪个字段）。
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts 凭据缺少自动续期所需的材料（${missing.join('、')}），无法自动续期，`
        + '请重新登录「码道」并导出完整凭据（新版 IAM OAuth 凭据除三项 AK/SK/security_token 外，'
        + '还带 `refresh_token`、`code_verifier` 与 `dpop_private_key_jwk`）。',
    })
  }

  let dpop: string
  try {
    dpop = await signDpopJws(jwk, 'POST', CODEARTS_STS_TOKEN_ENDPOINT)
  } catch (error) {
    // 本地密码学失败（JWK 损坏等）→ 终态：换多少次请求都签不出来。
    throw new ProviderError({
      provider: 'codearts',
      message: `CodeArts DPoP 签名失败（dpop_private_key_jwk 可能已损坏），请重新登录：`
        + `${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const form = new URLSearchParams({
    client_id: CODEARTS_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  let res: Response
  try {
    res = await fetch(CODEARTS_STS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        DPoP: dpop,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
    })
  } catch (error) {
    // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
    throw new ProviderError({
      provider: 'codearts',
      retryable: true,
      message: `CodeArts 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await res.text().catch(() => '')
  let parsed: Record<string, unknown> = {}
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    // 非 JSON（网关 HTML 错误页）：保持空对象，由下方按状态码归类。
  }

  const credentials = readRecord(parsed, 'credentials')
  const securityToken = readString(credentials, 'security_token')
  const errorCode = readString(parsed, 'error_code')
  const errorName = readString(parsed, 'error')

  /**
   * ⚠️ **`InvalidDPoPHeader` 必须先于「401/403 = 终态」被拦下，且判为可重试**。
   *
   * 参考项目为这条专门记了一次真实缺陷（`src/oauth.ts:124-141`）：把
   * `InvalidDPoPHeader` 当终态，会把**材料完好**的账号（refresh_token 还有
   * 十几天寿命、code_verifier 与 DPoP 私钥都在）一步标成「不可续期」，
   * 重启也不自愈，用户只能重新登录。
   *
   * 它说的是「**这次** proof 没通过校验」—— 时钟偏差让 `iat` 落在窗口外、
   * proof 被判重放、网关抖动，全都是**一次请求层面**的拒绝，
   * 与「refresh_token 还能不能用」无关（该错误实测以 HTTP 401 下发，
   * 故不能只看状态码）。
   *
   * 两边的代价不对称：判可重试最多再发一次 HTTP 请求；判终态则要人工重登。
   */
  if (errorName.includes('InvalidDPoPHeader')) {
    throw new ProviderError({
      provider: 'codearts',
      httpStatus: res.status,
      retryable: true,
      // ⚠️ 文案里**刻意不出现**「重新登录」四个字：调用方按该子串判定终态
      //（同 `raccoon.ts:1245-1247` 记录的判据形态）。写成「无需重新登录」
      // 会被子串匹配**误判成终态**，正好把这条可重试的错误变成账号报废。
      message: `CodeArts 续期被拒（${errorName}：本次 DPoP proof 未通过校验，多为时钟偏差或重放判定），`
        + '将重试；凭据本身仍然有效，无需人工干预',
    })
  }

  // 终态判据**只认这两条**（见上方说明，`InvalidDPoPHeader` 已被上面的分支摘出）。
  if (errorName === 'invalid_grant' || errorCode.includes('ExpiredRefreshToken')) {
    throw new ProviderError({
      provider: 'codearts',
      httpStatus: res.status,
      message: `CodeArts 登录态已过期（refresh_token 已失效：${errorName || errorCode}），请重新登录`,
    })
  }

  if (!res.ok || securityToken === '') {
    // 非终态的失败（5xx / 429 / 网关错误）属可重试。
    const detail = text.trim() === '' ? '(空响应体)' : text.slice(0, 200)
    throw new ProviderError({
      provider: 'codearts',
      httpStatus: res.status,
      retryable: res.status >= 500 || res.status === 429,
      message: `CodeArts 续期失败（HTTP ${res.status}）：${detail}`,
    })
  }

  // AK/SK 被轮换时用新值；未下发时保留旧的（它们是签名必需，丢了整份凭据就废了）。
  const nextAk = readString(credentials, 'access_key_id')
  const nextSk = readString(credentials, 'secret_access_key')
  const nextRefreshRaw = readString(parsed, 'refresh_token')
  // ⚠️ 服务端可能只回新的 access 三元组（不带新 refresh_token）——
  // 此时必须保留旧值，否则续期一次就把账号变成不可续期。
  const nextRefresh = nextRefreshRaw !== '' ? nextRefreshRaw : credential.refreshToken

  // 过期时间来自 `credentials.expiration`（ISO 串）；取不到则保留旧值，不编造。
  const expiration = readString(credentials, 'expiration')
  const parsedExpiry = expiration === '' ? Number.NaN : Date.parse(expiration)
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : credential.expiresAt

  return {
    // ⚠️ `{...credential}` 展开保留 uid / nickname / extras（ak、sk 之外的
    // code_verifier 与 dpop 私钥必须原样留着，否则**下一次**续期会失败）。
    ...credential,
    accessToken: securityToken,
    refreshToken: nextRefresh,
    expiresAt,
    extras: {
      ...credential.extras,
      ...(nextAk === '' ? {} : { ak: nextAk }),
      ...(nextSk === '' ? {} : { sk: nextSk }),
      [EXTRA_CODE_VERIFIER]: codeVerifier,
      [EXTRA_DPOP_JWK]: JSON.stringify(jwk),
    },
  }
}

// ── 供应商实例 ──

export const codeartsProvider: Provider = {
  /**
   * 对象判别式：CodeArts 用 **AK/SK 签名**，字段与其它家完全不重叠。
   *
   * 有 `access_key_id` + `secret_access_key` 就一定是它。
   */
  matchesShape(input) {
    return (
      typeof input['access_key_id'] === 'string'
      && typeof input['secret_access_key'] === 'string'
    )
  },
  id: 'codearts',
  name: 'CodeArts（华为云码道）',
  capabilities: {
    // 🔴 见文件头「登录为什么不可用」：回调依赖 127.0.0.1 本地监听
    // （`login.ts:170` / `login.ts:287`），Workers 无监听 socket，
    // 且没有轮询替代（`secret` 只在浏览器回调里到达）。
    login: false,
    loginBlockedReason:
      'CodeArts 登录需要在本机 127.0.0.1 上开一个回调端口接收浏览器的授权跳转，'
      + 'Cloudflare Workers 无法监听本地端口，且没有轮询式替代方案。'
      + '请在码道 IDE / 桌面端登录后导出凭据（含 access_key_id、secret_access_key、'
      + 'security_token 三项，security_token 也写作 credential.securitytoken），'
      + '把这段 JSON 粘贴到本项目的「导入凭据」里。',
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
   * ✅ **可静默续期**：`POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
   * （OAuth2 `grant_type=refresh_token` + DPoP proof，完整说明见 {@link refresh}）。
   *
   * 为什么必须有它（实测踩到）：本地 CODEARTS 凭据的 `expires_at` 是 ISO 串且
   * **已经过期**，于是所有签名请求 401 `APIG.0301`；而凭据里的 `refresh_token`、
   * `code_verifier`、`dpop_private_key_jwk` 三样齐全、还能用。
   *
   * ⚠️ 与别家不同的是**续期材料**：DPoP 私钥与 PKCE verifier 现在存于
   * `extras`（旧凭据没有这两项 → 只能重新登录，见 {@link parseCredential}）。
   */
  refresh,
  /**
   * 换号判据：429（限流）与 402（额度耗尽）值得换号；
   * **401/403 也值得换号** —— CodeArts 经 APIG 网关鉴权，SecurityToken
   * 被提前吊销或 AK 无权限时正是这两个状态码，另一个账号可能仍有效
   * （`llm-adapter.ts:435-447` 的 `isAuthError` 即按 401/403 识别鉴权失败）。
   */
  shouldRotate(status: number): boolean {
    return status === 429 || status === 402 || status === 401 || status === 403
  },
}
