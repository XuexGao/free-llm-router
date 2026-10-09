/**
 * Qoder（阿里系）供应商适配器 —— 国际版 `qoder` 与中国版 `qodercn` **共用一份实现**。
 *
 * ## 为什么两个变体只有一个实现
 *
 * 中国版与国际版的**协议完全相同**，差异**全部**是配置字段值
 * （`deepseek-harness-codearts/src/qoder-product.ts:176-180`：
 * 「两个取值共用同一套协议实现……不存在『CN 要另写一份协议』的情况」）。
 * 故此文件用 {@link buildQoderProduct} 参数化，**不要**复制实现文件 ——
 * 那会让每一处已记录的缺陷修两遍
 * （`AGENTS.md` 的 qodercn 章节第 1 条）。
 *
 * ## 本供应商最容易踩的四条（全部有实测出处）
 *
 * 1. **两条推理路径认两套模型名，且 host 不同**：
 *    加密端点 `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`
 *    认**目录 key**（`qfmodel` / `dmodel`）；公开端点 `api2-v2.qoder.sh`
 *    只认通用名（`qwen-flash`），目录 key 一律 `Unsupported model`。
 *    两者**不是同一个 host**，混用 404。
 *    ⇒ 本适配器只走加密端点（`src/qoder-product.ts:188-207`）。
 * 2. **模型列表恒用静态表**：远端 `GET /algo/api/v2/model/list` 需 **WASM 签名**，
 *    属只读目录能力却要付密码学代价；参考实现因此**不发网络请求**
 *    （`AGENTS.md` 的 Qoder 章节第 3 条）。本适配器照做。
 * 3. **登录是 PKCE 设备码轮询**（不起本地监听端口），故 Workers 可行；
 *    但轮询的 **HTTP 404 表示「用户尚未完成授权」**，必须继续轮询而不是报错
 *    （`deepseek-harness-codearts/src/qoder-oauth.ts:107-118` 的实测依据：
 *    该端点 404，而任意不存在路径回 401）。
 * 4. **`options.tools` 必须真的下发到请求体顶层 `tools`**，且工具历史要保留
 *    `tool_calls` / `tool_call_id`（**OpenAI 风格**，不是 Anthropic 风格）。
 *    不下发会让模型用正文里的 XML 臆造工具调用 → 任务终止
 *    （`AGENTS.md` 的 Qoder 章节第 6 条，两处真实缺陷）。
 *
 * ## 与 Workers 相关的两个移植决定（都已在注释里给出后果）
 *
 * - **WASM 改为模块 import**：`src/qoder-wasm.ts` 用 wrangler 内置的
 *   `CompiledWasm` 规则（`node_modules/wrangler/wrangler-dist/cli.js:150957`）
 *   拿到 `WebAssembly.Module`，取代参考实现的 `readFileSync`。
 *   ✅ 已实测：`deploy --dry-run` 打包成功（292.00 KiB / gzip 131.05 KiB），
 *   glue 能正常产出鉴权字段与签名请求。
 * - **机器身份改为用户配置**：参考实现 spawn `runtime-info.exe`
 *   （`deepseek-harness-codearts/src/qoder-machine.ts:421`）取
 *   `Cosy-MachineToken` / `Cosy-MachineType`。Workers **无 `child_process`**
 *   （`AGENTS.md §2.5` 第 4 条）。故这两个值改为凭据 `extras` 里的两个字符串。
 *   ⚠️ **后果必须知道**（`src/qoder-machine.ts:33-59`）：缺这两个头时
 *   `/sash/api/v1/me/campaigns` 只回 **1 条 `VIEW_DETAILS`、`claimable:false`**，
 *   于是「今天已领」与「服务端没下发可领项」在响应上**无法区分** ——
 *   参考实现因此把「未领取」误报成「今天已领」（用户报障）。
 *   本适配器**刻意不复制该行为**：缺 machine 头时 `checkin()` **抛错**
 *   说明缺什么，而不是返回 `alreadyDone:true`（见 {@link checkin}）。
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
import { prepareQoderInfer, type QoderInferMessage, type QoderInferTool } from './qoder-wasm.js'

// ─────────────────────────── 产品配置 ───────────────────────────

/** 兜底模型目录中的一个条目。 */
export interface QoderFallbackModel {
  /** 模型目录 **key**（如 `qfmodel`）—— 只能走加密端点。 */
  id: string
  name: string
  /**
   * 上下文窗口（**总上下文**）。
   *
   * ⚠️ 取目录 `context_config` 档位表的**最大档**，**不是 `max_input_tokens`**。
   * 两者经常自相矛盾（CN `dmodel`：`max_input_tokens` 96000、档位表却到 1M），
   * 而官方客户端只认档位表 —— 依据
   * `deepseek-harness-codearts/src/qoder-product.ts:36-46` 与
   * `AGENTS.md` 的「2.1」节（含 asar 里 `zX()` 的源码与 3 个模型的实测上限）。
   */
  contextWindow: number
  supportsImage?: boolean
  supportsThinking?: boolean
  isFree?: boolean
  /** 计费倍率（目录 `price_factor`）。**0 是合法值（免费）**，不能当缺失。 */
  priceFactor?: number
}

/**
 * 国际版模型目录（**实测数据**，17 条）。
 *
 * 出处：`deepseek-harness-codearts/src/qoder-product.ts:362-436`
 * （`QODER_FALLBACK_MODELS`，逐条对照本机 `~/.qoder/.models/{uid}/catalog-v6`）。
 * ⚠️ **不要凭印象改数值** —— 国际版曾因「手工估值 + 单测只断言 id 列表」
 * 让 14 个模型的价格长期漂移未被发现（用户报障）。
 */
export const QODER_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, priceFactor: 0.5 },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2 },
  { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.1 },
  { id: 'efficient', name: 'Efficient', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.3 },
  { id: 'smodel', name: 'Sonus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 8 },
  { id: 'cmodel', name: 'Cantus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 4 },
  // 免费额度模型（`is_free`）：e2e 探针默认用它们以免消耗积分。
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, isFree: true, priceFactor: 0.2 },
  // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失。
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, isFree: true, priceFactor: 0 },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1 },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.04 },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4 },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.8 },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8 },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.2 },
]

/**
 * 中国版模型目录（**实测数据**，14 条）。
 *
 * 出处：`deepseek-harness-codearts/src/qoder-product.ts:480-581`
 * （`QODER_CN_FALLBACK_MODELS`，逐条对照本机 `~/.qoder-cn/.models/{uid}/catalog-v6`）。
 *
 * ⚠️ **不能沿用国际版那张 17 条的表**：
 * - CN 独有 `q37fmodel` / `gm51model`；
 * - CN **没有** `ultimate` / `performance` / `efficient` / `smodel` / `cmodel`
 *   —— 沿用会让菜单出现 5 个 CN 端点根本不认的模型，点了就报错；
 * - `mmodel` 在 CN 是 **MiniMax-M2.7**（国际版 M3），且档位表**只有 200K 一档**。
 */
export const QODER_CN_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, isFree: true, priceFactor: 0.2 },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, isFree: true, priceFactor: 0 },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.04 },
  // CN 独有：Qwen3.7-Flash（国际版目录无此 key）。
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  // ⚠️ CN 的 `max_input_tokens` 是 96000，但档位表有 1M 档 → 填 1M（口径见 `contextWindow`）。
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1 },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8 },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  // CN 独有：GLM-5.2（国际版目录无此 key）。
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.6 },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4 },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8 },
  // ⚠️ 唯一档位表只有 200K 一档的 CN 模型 —— 不要跟着其它条改成 1M。
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, priceFactor: 0.2 },
]

/** Qoder 产品配置（两个变体共用同一套协议实现）。 */
export interface QoderProduct {
  id: 'qoder' | 'qodercn'
  displayName: string
  /** 登录与 OAuth 基址。 */
  authBase: string
  /** OpenAPI 基址（轮询、续期、userinfo、`/sash/` 都走它）。 */
  openApiBase: string
  /**
   * **加密推理**基址（`agent_chat_generation` 所在 host）。
   *
   * ⚠️ 与公开端点 `api2-v2.qoder.sh` **不是同一个 host**：加密端点走
   * `api2.qoder.sh`（`QoderProduct.encryptedInferBase` 的注释，
   * `src/qoder-product.ts:200-207`），写错会 404。
   */
  encryptedInferBase: string
  /**
   * OAuth client id（**prod 环境**那一个）。
   *
   * ⚠️ 两个 client id 的对应关系**容易读反**：源码
   * `client_id: i ? J_a : G_a`，调用点第 4 参是 `isProd()` —— prod → `true`
   * → **`J_a`**。用错的那个会让服务端在**授权回调阶段**拒绝，页面报
   * 「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（真实缺陷）。
   */
  clientId: string
  /** 请求体 `metadata.context` 的客户端标识（源码 `Fp()` 的 CLI 默认值）。 */
  clientMetadata: {
    client_type: string
    business_product: string
    business_type: string
    scene: string
  }
  /**
   * `/sash/` 端点（用量、活动）的 `Cosy-ClientType` 头取值。
   *
   * ⚠️ **与 `clientMetadata.client_type` 不是同一个身份**：
   * 那个是推理请求体加密信封里的 CLI 身份（`'5'`）；本值是官方**桌面客户端**
   * 身份（`'10'`）。服务端按这个头进入活动下发分支
   * （`src/qoder-product.ts:244-274` 的对照表：`'5'` → 空活动、`'10'` → 1 条）。
   */
  sashClientType: string
  userAgentPrefix: string
  fallbackModels: readonly QoderFallbackModel[]
}

/**
 * 构造一份产品配置。
 *
 * 参数化的**唯一**目的就是让 `qodercn` 可被平凡构造出来（差异全是字段值，
 * 见 `src/qoder-product.ts:584-631` 的 `QODER_CN`）。
 */
export function buildQoderProduct(variant: 'qoder' | 'qodercn'): QoderProduct {
  if (variant === 'qodercn') {
    return {
      id: 'qodercn',
      displayName: 'Qoder (中国版)',
      authBase: 'https://qoder.cn',
      openApiBase: 'https://openapi.qoder.com.cn',
      // ⚠️ CN **没有**可用的公开 OpenAI 兼容端点：
      // `gateway.qoder.com.cn` 上的 `/model/v1/chat/completions` 实测回 **503**
      // （`src/qoder-product.ts:594-604`）。故这里与 `encryptedInferBase` 同值
      // 仅表示「没有独立公开端点」，**不要**据此发请求。
      encryptedInferBase: 'https://gateway.qoder.com.cn',
      clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
      // CN 沿用国际版的 **CLI** 身份（源码 `Fp()` 默认值）；CN 实测接受
      // （`AGENTS.md` 的 qodercn 章节第 5 条：CN 实测接受默认值 `qodercli`）。
      clientMetadata: {
        client_type: '5',
        business_product: 'cli',
        business_type: 'agent',
        scene: 'assistant',
      },
      sashClientType: '10',
      userAgentPrefix: 'qoder',
      fallbackModels: QODER_CN_FALLBACK_MODELS,
    }
  }
  return {
    id: 'qoder',
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    // ⚠️ 不是 `environments.prod.inferBaseUrl`（那是 `api2.qoder.sh`）……
    // 不，正是它：源码 `Sja = { prod: "api2-v2.qoder.sh" }` 是**公开**端点，
    // 加密端点用 `environments.prod.inferBaseUrl` = `api2.qoder.sh`。
    encryptedInferBase: 'https://api2.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    clientMetadata: {
      client_type: '5',
      business_product: 'cli',
      business_type: 'agent',
      scene: 'assistant',
    },
    sashClientType: '10',
    userAgentPrefix: 'qoder',
    fallbackModels: QODER_FALLBACK_MODELS,
  }
}

// ─────────────────────────── 凭据 ───────────────────────────

/** 凭据里的关键 extras 键。 */
const EXTRA_MACHINE_ID = 'machineId'
const EXTRA_MACHINE_TOKEN = 'machineToken'
const EXTRA_MACHINE_TYPE = 'machineType'

/** 宽容读取：接受嵌套（`{credential:{…}}` / `{data:{…}}`）与扁平两种形态。 */
function unwrapCredential(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProviderError({ provider: 'qoder', message: '凭据必须是 JSON 对象' })
  }
  const record = input as Record<string, unknown>
  // 常见的三种包装层（面板导出、DSH 快照、本项目的存储条目）。
  for (const key of ['credential', 'credentials', 'data', 'qoder']) {
    const nested = record[key]
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      return nested as Record<string, unknown>
    }
  }
  return record
}

/** 取第一个非空字符串字段。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 解析绝对过期时刻（epoch ms）。兼容秒与毫秒 —— 缺省 0 表示未知。 */
function readExpiresAt(source: Record<string, unknown>): number {
  for (const key of ['expire_time', 'expireTime', 'expiresAt', 'expires_at']) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      // ⚠️ 10 位视为**秒**、13 位视为**毫秒**。Go 侧与本项目都踩过这个坑
      // （`AGENTS.md` 的「已实测发现的约束」第 5 条）。
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

/** 从 JWT 的 payload 段里取字段（**不验签** —— 只用于展示/兜底，不做安全判据）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payload = parts[1] ?? ''
  try {
    // base64url → 标准 base64，再补齐 padding（`atob` 不接受缺 padding 的输入）。
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    const json = atob(withPad)
    const parsed = JSON.parse(json) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 Qoder 凭据。
 *
 * 接受的形态（都来自真实世界）：
 * 1. 本插件登录产出的 `QoderCredential`（`security_oauth_token` / `access_token`
 *    **双写同值**，见 `deepseek-harness-codearts/src/qoder.ts:144-164`）；
 * 2. 只写了 `access_token` / `token` 的扁平形态；
 * 3. 上面任一种再套一层 `{credential:{…}}` / `{data:{…}}`。
 *
 * ⚠️ **`machineId` 缺失时自动生成**：它是**本插件自己生成并持久化**的随机
 * UUID（不是硬件指纹，见 `src/qoder.ts:71-79`），且「值不被服务端绑定校验」
 * —— 但**加密推理必需**，因为它参与 `QoderContext` 的密钥派生。
 * 服务端对它的要求是「同一个凭据每次用同一个值」，故这里**生成后必须由调用方
 * 持久化**（本函数把它放进 `extras`，调用方会连同凭据一起加密存盘）。
 *
 * ⚠️ **绝不用空串兜底 access token**（`types.ts` 的硬要求）。
 */
export function parseCredential(input: unknown): ProviderCredential {
  const source = unwrapCredential(input)

  const accessToken = readString(source, [
    'security_oauth_token',
    'securityOauthToken',
    'access_token',
    'accessToken',
    'token',
  ])
  if (accessToken === undefined) {
    throw new ProviderError({
      provider: 'qoder',
      message: 'Qoder 凭据缺少访问令牌（需要 `access_token` 或 `security_oauth_token`）；'
        + '请用面板的设备码登录，或从 Qoder 客户端导出后粘贴完整 JSON',
    })
  }

  const machineId = readString(source, ['machine_id', 'machineId'])
    ?? crypto.randomUUID()

  // uid：优先显式字段，其次 JWT 的 `sub` / `user_id`。
  // ⚠️ **加密推理需要 uid**（`generate_runtime_auth_fields` 用它派生
  // `encrypt_user_info`；参考实现 `src/qoder.ts:154-161` 的实测结论）。
  const jwt = decodeJwtPayload(accessToken)
  const uid = readString(source, ['uid', 'user_id', 'userId'])
    ?? (jwt === undefined ? undefined : readString(jwt, ['sub', 'user_id', 'userId', 'uid']))
  if (uid === undefined) {
    throw new ProviderError({
      provider: 'qoder',
      message: 'Qoder 凭据缺少账号 id（`uid` / `user_id`），且访问令牌里也解不出 `sub`。'
        + '加密推理必须知道 uid，请重新走一次设备码登录',
    })
  }

  const nickname = readString(source, ['nickname', 'user_name', 'userName', 'name'])
    ?? (jwt === undefined ? undefined : readString(jwt, ['name', 'nickname']))

  /** extras 是兜底口袋；机器头是**用户提供的配置**（Workers 无 child_process）。 */
  const extras: Record<string, string> = { [EXTRA_MACHINE_ID]: machineId }
  const machineToken = readString(source, ['machineToken', 'machine_token', 'cosyMachineToken'])
  const machineType = readString(source, ['machineType', 'machine_type', 'cosyMachineType'])
  if (machineToken !== undefined) extras[EXTRA_MACHINE_TOKEN] = machineToken
  if (machineType !== undefined) extras[EXTRA_MACHINE_TYPE] = machineType

  return {
    provider: 'qoder',
    uid,
    accessToken,
    refreshToken: readString(source, ['refresh_token', 'refreshToken']) ?? '',
    expiresAt: readExpiresAt(source),
    nickname: nickname ?? uid,
    extras,
  }
}

// ─────────────────────────── 模型目录 ───────────────────────────

/** 兜底表 → 统一形状。 */
export function toProviderModels(models: readonly QoderFallbackModel[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    // ⚠️ 目录里**没有**单次输出上限字段（那是 `max_input_tokens` 之外的另一个
    // 概念，官方目录未下发）。给 0 = 未知，**不编造** —— 编造会让客户端算出
    // 错误的输出预算（与 `workbuddy.ts:97-99` 同款纪律）。
    maxOutput: 0,
    supportsImage: m.supportsImage === true,
    isFree: m.isFree === true,
  }))
}

// ─────────────────────────── Anthropic 无关：推理链路 ───────────────────────────

/**
 * 把 OpenAI 形态的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 为什么必须保留多模态数组与工具字段（两处真实缺陷）
 *
 * 出处：`AGENTS.md` 的 Qoder 章节第 6、7 条（对应
 * `deepseek-harness-codearts/src/qoder-adapter.ts:236-360`）。
 *
 * 1. **不能只保留 `content` 为字符串的消息**：assistant 带工具调用时
 *    `content` 是 **`null`**（OpenAI 规范），整条会被丢；`role:'tool'` 的
 *    `tool_call_id` 也会被丢 —— 于是模型看不到自己调用过什么，
 *    表现为反复重调同一工具或凭空编造结果。
 * 2. **含图消息必须保留 content 数组**：图片的正确通道是
 *    `messages[].content` 的多模态数组（`{type:'image_url',…}`），
 *    **不是** `chat_context.imageUrls`（官方 `Hyc()` 把那个字段恒置 `null`）。
 *    把 content 压成纯文本会让图片全部消失。
 * 3. **纯文本仍输出字符串**：上游对字符串兼容性最好。
 * 4. 判空必须把**图片**算作内容，否则「只发一张图、不带文字」的消息会被吃掉。
 */
export function buildQoderHistory(
  messages: readonly Record<string, unknown>[],
): QoderInferMessage[] {
  const history: QoderInferMessage[] = []
  for (const message of messages) {
    if (typeof message.role !== 'string') continue
    const parts = qoderContentParts(message.content)
    const content: string | ReadonlyArray<Record<string, unknown>> =
      parts ?? qoderContentText(message.content)
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? (message.tool_calls as QoderInferMessage['tool_calls'])
      : undefined
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
    const isEmpty = parts === undefined ? content.length === 0 : parts.length === 0
    if (isEmpty && toolCalls === undefined && toolCallId === undefined) continue
    history.push({
      role: message.role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    })
  }
  return history
}

/** content → 纯文本（工具调用消息的正文是空串）。 */
export function qoderContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text') parts.push(String(record.text ?? ''))
  }
  return parts.join('')
}

/**
 * content 数组 → 多模态 parts（**含图才有意义**）。
 *
 * ⚠️ 只搬协议认识的 `type` / `text` / `image_url.url`(+`detail`)：
 * 不要把调用方的内部字段（`id` / `source` / `attachment`）原样发给上游。
 *
 * @returns 有图时返回 parts；**纯文本或无图时返回 undefined**，
 *          让调用方继续用字符串形态。
 */
export function qoderContentParts(content: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown; image_url?: { url?: unknown; detail?: unknown } }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      const url = block.image_url?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const detail = block.image_url?.detail
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
        },
      })
      hasImage = true
    }
  }
  return hasImage ? parts : undefined
}

/**
 * OpenAI 工具表 → 加密端点顶层 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：`{type:'function', function:{name, description?, parameters?}}`
 * —— `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 */
export function buildQoderTools(tools: unknown): QoderInferTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return []
  const out: QoderInferTool[] = []
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as { type?: unknown; function?: unknown }
    // 兼容「已经是扁平 OpenAI 形态」与「外层套了 type/function」两种输入。
    const fn: Record<string, unknown> =
      typeof record.function === 'object' && record.function !== null
        ? (record.function as Record<string, unknown>)
        : (raw as Record<string, unknown>)
    const name = fn.name
    if (typeof name !== 'string' || name.length === 0) continue
    const description = fn.description
    const parameters = fn.parameters
    out.push({
      type: 'function',
      function: {
        name,
        ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
        ...(typeof parameters === 'object' && parameters !== null
          ? { parameters: parameters as Record<string, unknown> }
          : {}),
      },
    })
  }
  return out
}

// ─────────────────────────── Qoder 信封解包 ───────────────────────────

/**
 * 从信封 JSON 文本里取出内层 OpenAI 帧文本；无法识别时返回 `null`。
 *
 * ## 信封形状（加密端点独有）
 *
 * ```
 * data:{"headers":{…},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
 *                               ↑ 这里才是标准 OpenAI chunk（**JSON 字符串**）
 * ```
 *
 * ⚠️ **内层 `body` 并未加密** —— 只有**请求**体需要 WASM 加密。
 * 故这里只做「剥信封」，不涉及任何解密。
 * 依据：`deepseek-harness-codearts/src/qoder-envelope.ts:1-52`。
 */
export function unwrapQoderEnvelopePayload(payload: string): string | null {
  let envelope: { body?: unknown }
  try {
    envelope = JSON.parse(payload) as { body?: unknown }
  } catch {
    return null
  }
  if (envelope.body === undefined) return null
  return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body)
}

/** Qoder 的业务错误码（都来自参考实现与 AGENTS.md 的实测记录）。 */
export const QODER_QUEUE_CODE = '10605'
export const QODER_BILLING_CODE = '110'

/**
 * 从一段错误文本/对象里解析「排队」信息。
 *
 * ⚠️ **不能先用某个字段当门禁再解析** —— 第三次回归（2026-09-27）的教训是
 * 业务码可能嵌两层（顶层 `code` 是 403、`10605` 在 `message` 里）。
 * 故这里**递归**遍历 `message` / `body` / `result` / `data` 并解析字符串，
 * 让解析函数自己判定。
 * 依据：`AGENTS.md` 的 Qoder 章节第 8 条。
 */
export function parseQoderQueueError(value: unknown, depth = 0): { retryAfterMs?: number } | undefined {
  if (depth > 5) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = parseQoderQueueError(JSON.parse(trimmed), depth + 1)
        if (parsed !== undefined) return parsed
      } catch {
        // 不是 JSON —— 落到下面的文本判据
      }
    }
    if (trimmed.includes(QODER_QUEUE_CODE)) {
      // 排队信息藏在 `message` 里，且 `message` 本身是「一个 JSON 字符串」。
      //
      // ⚠️ **必须容忍转义引号**：真实形态是**双层嵌套**的文本
      // （外层 `{code:403, message:"{code:10605, message:\"{…}\"}"}`），
      // 内层的引号在原文里是 `\"`。只认裸 `"` 的正则会**匹配不到**，
      // 于是退回 1 秒兜底而服务端要 30 秒 —— 与 `AGENTS.md` 记的
      // 「第二次回归：拿不到 retryAfterSeconds 只能退回 1 秒」是同一形态。
      const seconds = /\\?"retryAfterSeconds\\?"\s*:\s*(\d+)/.exec(trimmed)
      if (seconds !== null) return { retryAfterMs: Number.parseInt(seconds[1] ?? '0', 10) * 1000 }
      return {}
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  // ⚠️ `isQueued:false`（瞬时排队，`waitTime:0`）也要认 —— 用户报障
  // 「一次重试就能成功」正是这一形态。判据**不能**要求 `isQueued === true`。
  const hasQueueMarker = record.isQueued !== undefined || record.serviceAvailable !== undefined
    || record.waitTime !== undefined
  const code = record.code
  const codeHit = code === QODER_QUEUE_CODE || code === Number(QODER_QUEUE_CODE)
  const seconds = typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds
    : typeof record.retry_after_ms === 'number' ? record.retry_after_ms / 1000
      : undefined

  /**
   * ⚠️⚠️ **本层已判定是排队时，仍必须递归去找延迟**（真实缺陷，写用例时实测到）。
   *
   * 排队有三种真实下发形态，业务码与延迟**不在同一层**：
   *
   * | 形态 | `code` 位置 | `retryAfterSeconds` 位置 |
   * |---|---|---|
   * | ① 顶层 | 顶层 `code` | 顶层 |
   * | ② **嵌在 `message` 里**（抓包实测） | 顶层 `code` | **`message` 那段 JSON 字符串里** |
   * | ③ SSE 帧内（HTTP 200 包裹） | 帧内 `code` | 帧内 `message` |
   *
   * 早期写法在命中 `code` 后**直接返回** `{}`（只在本层找延迟），于是形态 ②
   * 拿不到 `retryAfterSeconds` —— 只能退回 1 秒兜底，而服务端要的是 30 秒，
   * 结果「永远等不到」。这与 `AGENTS.md` 记的第二次回归是**同一病根**：
   * 一次只修一条通道，另一条静默失效。
   * ⇒ 故这里**无论本层命不命中**都要递归一次，用内层的结果兜底。
   */
  let nested: { retryAfterMs?: number } | undefined
  for (const key of ['message', 'body', 'result', 'data', 'error']) {
    const found = parseQoderQueueError(record[key], depth + 1)
    if (found !== undefined) { nested = found; break }
  }

  if (codeHit || hasQueueMarker) {
    if (seconds !== undefined) return { retryAfterMs: Math.round(seconds * 1000) }
    // 本层没有延迟就取内层找到的；内层也没有则如实返回「无延迟信息」。
    return nested ?? {}
  }
  return nested
}

/**
 * 是否「当日额度用尽」（业务码 `110`）—— **不可重试**。
 *
 * ⚠️ **必须与排队分开**：客户端把 `billing_error` 映射为 `permission`
 * （**不重试**），而 `rate_limit` 映射为 `rate_limited`（可重试）。
 * 早期把 110 归为「服务端故障」导致**白重试 5 次**
 * （`AGENTS.md` 的 Qoder 章节第 9 条）。
 *
 * ⚠️ 文案兜底的关键词必须**窄**：`balance` / `quota` 之类泛词会误伤
 * 模型正文里恰好讨论「余额」的内容。
 */
export function looksLikeQoderBillingError(value: unknown): boolean {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return lower.includes('billing daily count exceeded')
      || lower.includes('daily count exceeded')
      || lower.includes('billing_error')
  }
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.code === QODER_BILLING_CODE || record.code === Number(QODER_BILLING_CODE)) return true
  for (const key of ['message', 'body', 'result', 'data', 'error']) {
    if (looksLikeQoderBillingError(record[key])) return true
  }
  return false
}

/**
 * 把 Qoder 的**信封 SSE** 整流成标准 OpenAI SSE。
 *
 * ## 铁律：逐帧转换，禁止整包缓冲（`AGENTS.md §8.2.2`）
 *
 * ## 错误帧必须**保真转发**
 *
 * ⚠️ 参考实现的第一次修复把内层 `{code, message}` 降级重组为
 * `{error:{message:"… (code)"}}` —— **丢掉 `code` 字段**并把后缀拼进
 * `message`。两个后果都极隐蔽（`AGENTS.md` 的 Qoder 章节第 8 条）：
 * ① 下游排队识别依赖顶层 `code === '10605'`，丢字段 → 永远不命中；
 * ② 后缀污染了 `message` 里那段**内层 JSON 字符串**，使二次解析失败。
 * ⇒ 这里**保真**：`code` 独立、`message` 原样，另加 `type`。
 *
 * ⚠️ 业务错误（1110 额度）**也**要带上 `code`，让 `gateway/stream.ts` 的
 * `detectErrorFrame` 能识别（它认 `code !== 0`）。
 */
export function unwrapQoderEnvelopeStream(
  upstream: ReadableStream<Uint8Array>,
  label: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()
  let buffer = ''

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          // 信封流是**逐行**的（每帧一行 `data:`），且参考实现按 `\n` 切
          // 而不是按空行 —— 与标准 SSE 不同。故这里也用 `\n`。
          const newline = buffer.indexOf('\n')
          if (newline === -1) break
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)

          if (line === '') continue
          if (!line.startsWith('data:')) {
            // 保留 `event:` 等行（`event: error` 对诊断有价值）。
            controller.enqueue(encoder.encode(`${line}\n`))
            continue
          }
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            continue
          }
          const inner = unwrapQoderEnvelopePayload(payload)
          if (inner === null) {
            // 不是信封 → 原样透传（容错：万一服务端某天直接回标准帧）。
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
            continue
          }
          if (!inner.includes('"choices"') && !inner.includes('[DONE]')) {
            // 业务错误：内层是错误 JSON 而非 choices。
            let code: unknown
            let message = inner
            try {
              const parsed = JSON.parse(inner) as { code?: unknown; message?: unknown }
              if (parsed.code !== undefined) code = parsed.code
              if (typeof parsed.message === 'string') message = parsed.message
            } catch {
              // 保持原文
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                ...(code === undefined ? {} : { code }),
                message,
                type: 'model_error',
              })}\n\n`),
            )
            continue
          }
          controller.enqueue(encoder.encode(`data: ${inner}\n\n`))
        }
      },
      flush(controller) {
        const rest = buffer.trim()
        if (rest.length === 0) return
        const payload = rest.startsWith('data:') ? rest.slice(5).trim() : rest
        const inner = unwrapQoderEnvelopePayload(payload)
        if (inner !== null) controller.enqueue(encoder.encode(`data: ${inner}\n\n`))
      },
    }),
  )
}

// ─────────────────────────── 对话 ───────────────────────────

/**
 * 排队等待的**用户定下的规则**（`AGENTS.md` 的 Qoder 章节第 8 条，不要擅自改）。
 *
 * - 服务端给的排队时间 **< 10 秒 → 按它的值**；
 * - **≥ 10 秒 → 封顶 10 秒** —— 避免一次阻塞 30 秒让 UI 长期停在「运行中」；
 * - 最多 3 次（本项目 `chat()` 只有一次请求的预算，且网关已有换号层）。
 */
/**
 * 单次排队等待的上限（服务端要求的 `retryAfter` 更大时按此截断）。
 *
 * ⚠️ **必须截断**：服务端可能给出很长的 `retryAfter`，照等会让一个 HTTP
 * 请求挂住几分钟，而 Worker 最终会被平台掐断（实测报
 * `Network connection lost.` 且耗时 122s）。
 */
const QUEUE_MAX_DELAY_MS = 10_000

/** 排队重试的次数上限。 */
const QUEUE_MAX_ATTEMPTS = 3

/**
 * 排队的**总墙钟预算**（毫秒）—— 所有重试与等待加起来不得超过它。
 *
 * ## 🔴 为什么必须有总预算（实测缺陷）
 *
 * 原先只有「次数上限」（3 次 × 最多 10s 等待 + 每次 20s 超时 ≈ 90s），
 * **没有总时间上限**。实测后果：
 *
 * ```
 * qoder 排队 3 轮耗尽（约 90s）→ 触发续期（再 30s）
 *   ⇒ 请求总共挂到 122s
 *   ⇒ Worker 报 `Network connection lost.`
 *   ⇒ 以前还因为缺异常边界而只回一个裸 `error code: 1101`（无任何原因）
 * ```
 *
 * ⚠️ 参考实现（`qoder-adapter.ts:167-172`）默认等 **30 分钟** ——
 * 那是一个**长驻本地进程**的合理预算，而**本服务跑在 Worker 里**：
 * 一个 HTTP 请求挂几分钟既会被平台掐断，用户也早已放弃。
 *
 * ⇒ 取 **45 秒**：足够覆盖「一次正常排队」（实测常见 20–25s），
 * 又远低于平台会掐断的量级。超出预算时**如实报「排队太挤」**，
 * 让客户端稍后重试 —— 那比挂到被平台掐断（无可读原因）好得多。
 */
const QUEUE_TOTAL_BUDGET_MS = 45_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError({ provider: 'qoder', message: '请求已取消' }))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ProviderError({ provider: 'qoder', message: '请求已取消' }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 发起加密推理（内部：单次尝试）。 */
async function postQoderInfer(
  product: QoderProduct,
  credential: ProviderCredential,
  request: ChatRequest,
): Promise<Response> {
  const body = request.body as Record<string, unknown>
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const history = buildQoderHistory(messages)
  const tools = buildQoderTools(body.tools)

  /** 最后一条 user 消息即本轮提问（其余作为历史）。 */
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const userText = qoderContentText(lastUser?.content)
  const systemText = qoderContentText(lastUser === undefined ? '' : body.system ?? body.system_prompt)

  const model = product.fallbackModels.find((m) => m.id === request.model)
  const maxTokens = typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0
    ? body.max_tokens
    : undefined
  const reasoningEffort = typeof body.reasoning_effort === 'string' && body.reasoning_effort.length > 0
    ? body.reasoning_effort
    : undefined

  const prepared = await prepareQoderInfer({
    user: { uid: credential.uid, securityOauthToken: credential.accessToken },
    machineId: credential.extras[EXTRA_MACHINE_ID] ?? credential.uid,
    metadata: { ...product.clientMetadata },
    host: product.encryptedInferBase,
    ask: {
      modelKey: request.model,
      userText,
      history,
      // ⚠️ 工具定义必须真的下发：模型**唯一**能学到函数 schema 的通道。
      tools,
      ...(systemText.length > 0 ? { systemText } : {}),
      ...(model?.supportsThinking !== undefined ? { isReasoning: model.supportsThinking } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(model?.supportsImage !== undefined ? { isVl: model.supportsImage } : {}),
      ...(model?.name !== undefined ? { displayName: model.name } : {}),
      ...(model?.contextWindow !== undefined
        ? { contextWindow: model.contextWindow, maxInputTokens: model.contextWindow }
        : {}),
      // ⚠️ **`business` 必填**，否则服务端把请求路由到故障节点
      // `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`。
      // 实测：不带 `business` 时 `qfmodel` 恒失败，其余模型恰好不受影响 ——
      // 极易误判为「该模型服务端故障」（而 IDE 里同一模型完全正常）。
      // 源码依据：`MPi(A){ return A === 'sec_scan' ? 'security' : 'default' }`。
      business: { type: 'agent' },
    },
  })

  // ⚠️ `prepared.headers` **必须原样透传**：其中的 `Authorization` 是 WASM 生成的
  // `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>` 覆盖会导致
  // `403 Signature invalid`（参考实现 `src/qoder-wasm.ts:649-655`）。
  return await fetch(prepared.url, {
    method: 'POST',
    headers: prepared.headers,
    body: prepared.body,
    // ⚠️ **必须带超时** —— 只透传 `request.signal` 等于「永不超时」，
    // 一次挂住就会让上层所有预算（排队总预算等）失效。
    // 两者用 `any` 组合：客户端取消与超时都要生效。
    signal: request.signal.aborted
      ? request.signal
      : AbortSignal.any([request.signal, AbortSignal.timeout(INFER_TIMEOUT_MS)]),
  })
}

/** 发起对话（返回**已转成 OpenAI SSE** 的响应）。 */
async function chat(
  product: QoderProduct,
  credential: ProviderCredential,
  request: ChatRequest,
): Promise<Response> {
  // ⚠️ 记**开始时刻**，用于总预算判据（见 QUEUE_TOTAL_BUDGET_MS 的说明）。
  const queueStartedAt = Date.now()
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      response = await postQoderInfer(product, credential, request)
    } catch (error) {
      // ## 🔴 必须把「超时/客户端取消」翻译成**可分类**的错误
      //
      // 实测缺陷：`postQoderInfer` 的 `AbortSignal.timeout(INFER_TIMEOUT_MS)`
      // 触发后抛 `TimeoutError`，而**这里没有 catch** ⇒ 它直接穿透到
      // Worker 的异常边界 ⇒ 客户端收到 **HTTP 500 `internal_error`**。
      //
      // ⚠️ 那是**错的分类**：单次推理超时说明「上游慢/在排队」，
      // 是**容量**问题 ⇒ 应该 `retryable`（换号或稍后重试有效），
      // 而不是「服务内部错误」（那会让用户以为是我们坏了）。
      //
      // ⚠️ 客户端主动取消则**必须原样区分**（本项目已有此纪律，见
      // `zcode.ts` 的同款说明）：把它当可重试会让「用户点了取消」
      // 变成「我们偷偷又发了一次请求」。
      if (request.signal.aborted) {
        throw new ProviderError({ provider: product.id, message: '请求已被客户端取消' })
      }
      const message = error instanceof Error ? error.message : String(error)
      // ⚠️ 只有「超时/中止」才归为繁忙；其它传输层错误仍按可重试的网络问题处理。
      const timedOut = /timeout|timed out|abort/i.test(message)
      throw new ProviderError({
        provider: product.id,
        retryable: true,
        message: timedOut
          ? `Qoder 单次请求超过 ${Math.round(INFER_TIMEOUT_MS / 1000)} 秒未返回`
            + `（上游繁忙或排队）。请稍后重试 —— 这是上游问题，不是账号或配置问题。`
          : `Qoder 请求失败：${message}`,
      })
    }

    if (response.ok) {
      if (response.body === null) {
        throw new ProviderError({ provider: product.id, message: '上游返回 200 但没有响应体' })
      }
      return new Response(unwrapQoderEnvelopeStream(response.body, product.id), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    }

    const text = await response.text().catch(() => '')

    // ── 排队（业务码 10605，可能藏在两层 message 里）→ 按服务端延迟等待后重试 ──
    // ⚠️ **不能用顶层 `code` 当门禁**：第三次回归时顶层是 403、10605 在 message 里。
    const queue = parseQoderQueueError(text)
    if (queue !== undefined) {
      // ⚠️ **先判总预算，再判次数** —— 两个上限都要守，任一超了就如实上报。
      const spent = Date.now() - queueStartedAt
      const overBudget = spent >= QUEUE_TOTAL_BUDGET_MS
      if (overBudget || attempt >= QUEUE_MAX_ATTEMPTS) {
        // ⚠️ 如实说明「是排队太挤」，而不是把它伪装成失败 ——
        // 用户据此知道「稍后重试有用」，而不是「我的账号/配置有问题」。
        // ⚠️ `retryable: true`：排队是**容量**问题，换号或稍后重试确实有效。
        throw new ProviderError({
          provider: product.id,
          httpStatus: response.status,
          retryable: true,
          message:
            `Qoder 服务繁忙：排队等待已超过 ${Math.round(QUEUE_TOTAL_BUDGET_MS / 1000)} 秒`
            + `（已尝试 ${attempt + 1} 次，实际等待 ${Math.round(spent / 1000)} 秒）。`
            + '请稍后重试 —— 这是上游排队，不是账号或配置问题。',
        })
      }
      const wait = queue.retryAfterMs === undefined
        ? 1000
        : Math.min(queue.retryAfterMs, QUEUE_MAX_DELAY_MS)
      await sleep(wait, request.signal)
      continue
    }

    // ── 额度用尽（业务码 110）→ **不可重试**，如实上报 ──
    if (looksLikeQoderBillingError(text)) {
      throw new ProviderError({
        provider: product.id,
        httpStatus: response.status,
        // ⚠️ `retryable: false`：额度按自然日结算，重试与换号都无意义；
        // 标记应为「UTC+8 当日 24:00 解禁」（由账号池负责，不在本层）。
        retryable: false,
        message: `Qoder 当日额度已用尽（${response.status}）：${text.slice(0, 300)}`,
      })
    }

    throw new ProviderError({
      provider: product.id,
      httpStatus: response.status,
      // ⚠️ 429 / 402 值得换号（`types.ts` 的缺省语义）。
      retryable: response.status === 429 || response.status === 402,
      message: `Qoder 推理失败：http=${response.status} ${text.slice(0, 300)}`,
    })
  }
}

// ─────────────────────────── 余额 / 签到（`/sash/` 端点） ───────────────────────────

/** `/sash/` 端点的请求头。 */
function sashHeaders(product: QoderProduct, credential: ProviderCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    // ⚠️ 桌面 app 身份（`'10'`）；用 CLI 的 `'5'` 时活动列表恒为空。
    'Cosy-ClientType': product.sashClientType,
    // ⚠️ 参考实现里 UA 恒为 `"Qoder"`（`src/qoder-product.ts:627-628`）。
    'User-Agent': 'Qoder',
  }
  const token = credential.extras[EXTRA_MACHINE_TOKEN]
  const type = credential.extras[EXTRA_MACHINE_TYPE]
  // ⚠️ **必须成对**出现：只带一个等于没带（实测消融表）。
  if (token !== undefined && type !== undefined) {
    headers['Cosy-MachineToken'] = token
    headers['Cosy-MachineType'] = type
  }
  return headers
}

/** 一个额度桶（`/sash/api/v2/me/usage` 的 `qoderUsage` 子项）。 */
interface QoderQuotaBucket {
  total?: unknown
  used?: unknown
  remaining?: unknown
  unit?: unknown
}

/** 把一个额度桶换算成统一条目。 */
function toPackage(name: string, quota: unknown): { name: string; amount: number; expiry: number } | undefined {
  if (typeof quota !== 'object' || quota === null) return undefined
  const bucket = quota as QoderQuotaBucket
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const total = num(bucket.total)
  const used = num(bucket.used)
  const remainingRaw = num(bucket.remaining)
  if (total === undefined && used === undefined && remainingRaw === undefined) return undefined
  const remaining = remainingRaw !== undefined
    ? Math.max(0, remainingRaw)
    : Math.max(0, (total ?? 0) - (used ?? 0))
  return { name, amount: remaining, expiry: 0 }
}

/**
 * 查余额。
 *
 * ⚠️ **余额不只在 `userQuota` 里**（真实缺陷）：实测某账号
 * `userQuota.remaining = 0` 而 `addOnQuota.remaining = 100`（资源包）。
 * 只读 `userQuota` 会显示 0。
 * 出处：`deepseek-harness-codearts/src/qoder-credits.ts:13-40` 与
 * `AGENTS.md` 的「Qoder 积分余额」章节。
 *
 * ⚠️ 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 →
 * **抛错说明**，而不是返回 0（0 是「已用光」的语义，会误导用户）。
 */
async function balance(
  product: QoderProduct,
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderBalance> {
  const res = await fetch(`${product.openApiBase}/sash/api/v2/me/usage`, {
    method: 'GET',
    headers: sashHeaders(product, credential),
    signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  if (!res.ok) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      retryable: res.status === 429 || res.status === 401,
      message: `Qoder 余额查询失败：http=${res.status}`,
    })
  }
  const body = (await res.json()) as Record<string, unknown>
  if (body.displayMode === 'enterprise') {
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 企业版账号不下发额度数字（只在客户端内展示外部链接），无法查余额',
    })
  }
  const usage = body.qoderUsage
  if (typeof usage !== 'object' || usage === null) {
    throw new ProviderError({
      provider: product.id,
      message: `Qoder 余额响应缺少 qoderUsage 字段（原文：${JSON.stringify(body).slice(0, 200)}）`,
    })
  }
  const record = usage as Record<string, unknown>
  const packages: Array<{ name: string; amount: number; expiry: number }> = []
  const plan = toPackage('套餐额度', record.userQuota)
  if (plan !== undefined) packages.push(plan)
  const addOn = toPackage('资源包', record.addOnQuota)
  if (addOn !== undefined) packages.push(addOn)
  // ⚠️ 顺序即展示顺序：套餐额度 → 资源包 → 专用资源包。
  const dedicated = record.dedicatedResourcePackages
  if (Array.isArray(dedicated)) {
    for (const item of dedicated) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : '专用资源包'
      const pkg = toPackage(name, entry)
      if (pkg === undefined) continue
      const expires = entry.expiresAt ?? entry.expires_at
      if (typeof expires === 'string' && expires.length > 0) {
        const parsed = Date.parse(expires.replace(' ', 'T'))
        if (Number.isFinite(parsed)) pkg.expiry = parsed
      }
      packages.push(pkg)
    }
  }
  // ⚠️ 一个包都没解析出来 → **抛错**（「响应形状与预期不符」），而不是返回 0
  // —— 后者会让用户以为额度被清空了。
  if (packages.length === 0) {
    throw new ProviderError({
      provider: product.id,
      message: `Qoder 余额响应形状无法识别（原文：${JSON.stringify(usage).slice(0, 200)}）`,
    })
  }
  const total = packages.reduce((sum, pkg) => sum + pkg.amount, 0)
  const expiries = packages.map((pkg) => pkg.expiry).filter((v) => v > 0)
  return {
    total,
    // ⚠️ 套餐/资源包没有独立到期（统一「领取后 30 天」），故这里不编造
    // 「即将过期」的额度 —— 编造会让面板显示一条假的紧迫提醒。
    expiring: 0,
    earliestExpiry: expiries.length > 0 ? Math.min(...expiries) : 0,
    packages,
  }
}

/** 一条活动（`campaigns[]` 的一项）。 */
interface QoderCampaign {
  campaignId: string
  actionType?: string
  claimStatus?: string
  amount?: number
}

/** 解析 `/sash/api/v1/me/campaigns` 的响应。 */
function parseCampaigns(body: unknown): { claimable: boolean; campaigns: QoderCampaign[] } {
  if (typeof body !== 'object' || body === null) return { claimable: false, campaigns: [] }
  const record = body as Record<string, unknown>
  const raw = Array.isArray(record.campaigns) ? record.campaigns : []
  const campaigns: QoderCampaign[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const campaignId = entry.campaignId ?? entry.campaign_id ?? entry.id
    if (typeof campaignId !== 'string' || campaignId.length === 0) continue
    const benefit = typeof entry.benefit === 'object' && entry.benefit !== null
      ? (entry.benefit as Record<string, unknown>)
      : undefined
    campaigns.push({
      campaignId,
      ...(typeof entry.actionType === 'string' ? { actionType: entry.actionType } : {}),
      ...(typeof entry.claimStatus === 'string' ? { claimStatus: entry.claimStatus } : {}),
      ...(typeof benefit?.amount === 'number' ? { amount: benefit.amount } : {}),
    })
  }
  return { claimable: record.claimable === true, campaigns }
}

/**
 * 每日签到（领取活动积分）。
 *
 * ## ⚠️ 缺 machine 头时**必须抛错**，不能报「今天已领」
 *
 * 这是本适配器与参考实现**刻意不同**的一处，理由是那条被记录的真实缺陷
 * （`deepseek-harness-codearts/src/qoder-machine.ts:33-59`）：
 *
 * | 请求头 | `/sash/api/v1/me/campaigns` |
 * |---|---|
 * | 仅 `Cosy-ClientType: '10'` | `showCampaign:true, claimable:false`，**1 条 `VIEW_DETAILS`** |
 * | ＋ `Cosy-MachineToken` ＋ `Cosy-MachineType` | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
 *
 * 参考实现把「筛出 0 个可领活动」当成「今天已领」，于是**把
 * 『服务端没下发数据』误报成『今天已领』**（用户报障：插件说已领、官方还能领）。
 * 本适配器改为：**没有 machine 头就不下结论**，抛错说明要配哪两个字段。
 *
 * ⚠️ 「今天已领」的**正确判据不是「列表为空」** —— 抓包实测领取前后对照
 * （`AGENTS.md` 的「Qoder 每日领取」章节）：领取成功后列表**仍非空**，
 * 只是那条 `CLAIM_BENEFIT` 的 `claimStatus` 由 `CLAIMABLE` 变 `CLAIMED`、
 * 顶层 `claimable` 变 `false`。
 *
 * ⚠️ 幂等判据是响应体的 `replayed`，**不是 HTTP 状态码**：重复领取同样返回
 * **200**，但 `replayed:true`、**不含 `benefit`**。
 */
async function checkin(
  product: QoderProduct,
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<CheckinResult> {
  const machineToken = credential.extras[EXTRA_MACHINE_TOKEN]
  const machineType = credential.extras[EXTRA_MACHINE_TYPE]
  if (machineToken === undefined || machineType === undefined) {
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 自动签到需要设备身份头 `Cosy-MachineToken` + `Cosy-MachineType`（必须成对）。'
        + 'Workers 无法运行 Qoder 的 `runtime-info.exe` 生成它们，'
        + '请在导入凭据时把这两个值一并放进 `machineToken` / `machineType` 字段'
        + '（可从 Qoder 桌面端的 `machine_token.json` 取：`token` → machineToken、`type` → machineType）。'
        + '缺这两个头时服务端只下发 1 条 `VIEW_DETAILS`（`claimable:false`），'
        + '此时「今天已领」与「没有可领项」无法区分 —— 故这里如实报错而不谎报已领',
    })
  }

  const timeout = AbortSignal.timeout(20_000)
  const requestSignal = signal.aborted ? signal : AbortSignal.any([signal, timeout])

  const res = await fetch(`${product.openApiBase}/sash/api/v1/me/campaigns`, {
    method: 'GET',
    headers: sashHeaders(product, credential),
    signal: requestSignal,
  })
  if (!res.ok) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      retryable: res.status === 429,
      message: `Qoder 活动列表查询失败：http=${res.status}`,
    })
  }
  const { claimable, campaigns } = parseCampaigns(await res.json())

  // ⚠️ 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`：
  // 实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。
  const target = campaigns.find(
    (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE',
  )
  if (target === undefined) {
    // 有 `CLAIM_BENEFIT` 但已 `CLAIMED` → 真·今天已领。
    const claimed = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT')
    if (claimed !== undefined) {
      return { alreadyDone: true, gained: 0, detail: 'Qoder 今日积分已领取（活动状态为 CLAIMED）' }
    }
    // 只有 `VIEW_DETAILS` → 服务端**没有下发可领项**。带齐 machine 头后仍如此，
    // 才可能是「今天真的没有活动」（活动每日 10:00 UTC+8 刷新）。
    if (campaigns.length > 0) {
      return {
        alreadyDone: true,
        gained: 0,
        detail: `Qoder 当前没有可领取的活动（服务端下发 ${campaigns.length} 条，`
          + '均为 VIEW_DETAILS 型；活动每日 10:00（UTC+8）刷新）',
      }
    }
    return { alreadyDone: true, gained: 0, detail: 'Qoder 活动列表为空，暂无可领积分' }
  }

  // ⚠️ 请求体必须是**空串**（抓包实测 `content-length: 0`）。
  const claimRes = await fetch(
    `${product.openApiBase}/sash/api/v1/me/campaigns/${encodeURIComponent(target.campaignId)}/claim`,
    { method: 'POST', headers: sashHeaders(product, credential), body: '', signal: requestSignal },
  )
  const text = await claimRes.text().catch(() => '')
  if (!claimRes.ok) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: claimRes.status,
      retryable: claimRes.status === 429,
      message: `Qoder 领取失败：http=${claimRes.status} ${text.slice(0, 200)}`,
    })
  }
  let replayed = false
  let gained = target.amount ?? 0
  let message: string | undefined
  try {
    const parsed = JSON.parse(text) as { replayed?: unknown; benefit?: { amount?: unknown }; message?: unknown }
    // ⚠️ **幂等判据是 `replayed`，不是状态码**：重复领取也回 200，
    // 但 `replayed:true`、不含 `benefit`。
    replayed = parsed.replayed === true
    if (parsed.benefit?.amount === undefined) gained = 0
    else if (typeof parsed.benefit.amount === 'number') gained = parsed.benefit.amount
    if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    // 非 JSON 响应：claimable 已经说明成功过，按成功处理但收益未知。
    gained = 0
  }
  if (replayed) {
    return { alreadyDone: true, gained: 0, detail: 'Qoder 今日积分已领取（服务端回 replayed=true）' }
  }
  return {
    alreadyDone: false,
    gained,
    detail: message ?? `Qoder 领取成功${gained > 0 ? `，+${gained} 积分` : ''}`,
  }
}

// ─────────────────────────── 续期 ───────────────────────────

/**
 * 续期路径（挂 `openApiBase`，`src/qoder.ts:27` 的 `QODER_REFRESH_PATH`）。
 *
 * ⚠️ 与登录轮询路径（`/api/v1/deviceToken/poll`）只差最后一段 —— 写错会拿到
 * 一个语义完全不同的响应（轮询在没有待授权会话时回 404），排查起来毫无头绪。
 */
const REFRESH_PATH = '/api/v1/deviceToken/refresh'

/** 单次续期超时（对齐参考 `QODER_REQUEST_TIMEOUT_MS = 30_000`，`src/qoder.ts:14`）。 */
const REFRESH_TIMEOUT_MS = 30_000

/**
 * **单次推理**的超时（毫秒）。
 *
 * ## 🔴 为什么必须有（实测缺陷）
 *
 * 原先 `postQoderInfer` 只透传 `request.signal`（**没有超时**）——
 * 于是**一次** fetch 就能无限期挂住。实测后果：
 *
 * ```
 * 一次 infer 挂住 → 排队预算（45s）根本来不及生效
 *   ⇒ 整个请求挂到 121.8s
 *   ⇒ Worker 报 `Network connection lost.`（连接被平台回收）
 * ```
 *
 * ⚠️ 我加了「排队总预算」后**仍然** 121.8s，就是因为预算只能在
 * 「每次 infer **返回之后**」才被检查 —— 而 infer 自己不返回。
 * **教训：加总预算前，必须确认每一段都有界。**
 *
 * 取值 30s：与参考实现的 `QODER_REQUEST_TIMEOUT_MS` 一致
 *（`src/qoder.ts:14`，用于 qoder 的鉴权与推理请求）。
 */
const INFER_TIMEOUT_MS = 30_000

/**
 * 用 `refresh_token` 换一份新凭据。
 *
 * ## 协议（`src/qoder-auth.ts:395-437` 的 `refreshCredential`，逐字对齐）
 *
 * ```
 * POST {openApiBase}/api/v1/deviceToken/refresh
 * headers: Content-Type: application/json + Accept + User-Agent: qoder/1.0.0
 * body:    { "refresh_token": "…", "machine_id": "…" }        ← 蛇形！
 * → { "device_token": "dt-…", "refresh_token": "drt-…",
 *     "expires_at": <ISO 串或毫秒>, "refresh_token_expires_at": …,
 *     "user_id": "…", "user_name": "…" }
 * ```
 *
 * ⚠️ **续期响应用 `device_token` 承载访问令牌**，登录响应用 `token`
 * —— 字段名不同，两个都要认（`src/qoder.ts:211-235` 的注释明确记录）。
 * 只认 `token` 会把一次成功的续期读成「响应缺少令牌」。
 *
 * ⚠️ **`machine_id` 是必填**：它参与加密推理的密钥派生
 * （`src/qoder.ts:287-293` 的 `qoderRefreshBody` 只发这两个字段，
 * `machine_token` 来自本插件没有的 UMID 子系统）。故必须从 `extras` 原样取出
 * 再回写 —— 丢了它，续期成功但**推理会失败**，且下一次续期也没有设备标识了。
 *
 * ## 终态判定（与参考一致，`src/qoder-auth.ts:411-436`）
 *
 * - 401/403 → 终态，提示重新登录；
 * - 200 但响应里没有令牌 → 终态（重试一万次也不会有）；
 * - 网络异常 / 5xx / 429 → `retryable: true`（**绝不能**报成「请重新登录」）。
 */
async function refresh(
  product: QoderProduct,
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderCredential> {
  const refreshToken = credential.refreshToken.trim()
  if (refreshToken === '') {
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 凭据缺少 refresh_token，无法自动续期，请重新走一次设备码登录',
    })
  }
  // ⚠️ `machine_id` 必须带（见上方说明）。凭据里没有时**不编造**一个随机值：
  // 随机值会让加密推理的密钥派生与服务端记录不一致，表现为「续期成功但推理 401」。
  const machineId = (credential.extras[EXTRA_MACHINE_ID] ?? '').trim()
  if (machineId === '') {
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 凭据缺少 machine_id（加密推理与续期都必需），无法自动续期，请重新走一次设备码登录',
    })
  }

  let res: Response
  try {
    res = await fetch(`${product.openApiBase}${REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // 与参考一致：`{userAgentPrefix}/1.0.0`（`src/qoder-auth.ts:400`）。
        'User-Agent': `${product.userAgentPrefix}/1.0.0`,
      },
      // ⚠️ **蛇形**字段名（`refresh_token` / `machine_id`），不是驼峰。
      body: JSON.stringify({ refresh_token: refreshToken, machine_id: machineId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: product.id,
      retryable: true,
      message: `Qoder 续期网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await res.text().catch(() => '')

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      message: `Qoder 登录态已失效（HTTP ${res.status}），请重新登录（refresh_token 已被拒绝）`,
    })
  }

  let parsed: Record<string, unknown>
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('not an object')
    }
    parsed = candidate as Record<string, unknown>
  } catch {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      retryable: res.status >= 500 || res.status === 429,
      message: `Qoder 续期响应不是 JSON（HTTP ${res.status}）：${text.trim().slice(0, 160) || '(空响应体)'}`,
    })
  }

  if (!res.ok) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      retryable: res.status >= 500 || res.status === 429,
      message: `Qoder 续期失败（HTTP ${res.status}）：${text.trim().slice(0, 200)}`,
    })
  }

  // ⚠️ 访问令牌在续期响应里叫 `device_token`（登录响应才叫 `token`）。
  const nextAccessToken = readString(parsed, ['device_token', 'token', 'access_token', 'accessToken'])
  if (nextAccessToken === undefined) {
    // 200 却没有令牌 → 终态（参考 `src/qoder-auth.ts:429-434` 的同款判据）。
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 续期响应缺少访问令牌（device_token），请重新登录',
    })
  }

  // ⚠️ 新 refresh_token 缺失时**保留旧值** —— Qoder 实测会轮换它，
  // 但「某次没下发」不该把可续期凭据变成不可续期。
  const nextRefresh = readString(parsed, ['refresh_token', 'refreshToken']) ?? credential.refreshToken
  // 过期时间来自响应（可能是 ISO 串，也可能是秒/毫秒数字）；`readExpiresAt`
  // 三种形态都认。取不到时**保留旧值**（0 = 未知），不编造。
  const parsedExpiry = readExpiresAt(parsed)
  const expiresAt = parsedExpiry > 0 ? parsedExpiry : credential.expiresAt

  // uid 不在续期响应里（参考 `applyQoderRefresh` 明确要保留它，加密推理依赖）。
  const nextUid = readString(parsed, ['user_id', 'userId']) ?? credential.uid
  const nextNickname = readString(parsed, ['user_name', 'userName']) ?? credential.nickname

  return {
    // ⚠️ `{...credential}` 展开保留 uid / nickname / extras（machineId、machineToken、
    // machineType）—— 机器头是**用户提供的配置**，Workers 里无法重新探测，
    // 丢了积分/推理能力都会退化。
    ...credential,
    uid: nextUid,
    nickname: nextNickname,
    accessToken: nextAccessToken,
    refreshToken: nextRefresh,
    expiresAt,
    extras: { ...credential.extras, [EXTRA_MACHINE_ID]: machineId },
  }
}

// ─────────────────────────── Provider 导出 ───────────────────────────

/** 用一份产品配置造出 `Provider`。 */
export function buildQoderProvider(product: QoderProduct): Provider {
  return {
    id: product.id,
    name: product.displayName,
    capabilities: {
      /**
       * ✅ **可在 Workers 完成**：Qoder 用的是 PKCE 设备码**轮询**
       * （`redirect_uri` 是自定义协议 `qoder-app://`，不起本地监听端口）。
       * 依据：`deepseek-harness-codearts/src/qoder-oauth.ts:5-10` 与
       * `AGENTS.md §2.5` 第 2 条（本项目能成立的前提之一）。
       *
       * ⚠️ **需要网关层接线**：本文件导出了 {@link startQoderLogin} /
       * {@link pollQoderLogin}，但 `src/index.ts` 的 `/admin/login/*` 目前只
       * 分派 workbuddy。接上之前，面板的「登录」按钮走的仍是 workbuddy 流程。
       */
      login: true,
      listModels: true,
      chat: true,
      balance: true,
      /**
       * ✅ **可自动签到**，但**依赖用户提供两个 device 头**
       * （见 {@link checkin} 的说明与 `capabilities` 的诚实纪律：
       * 缺配置时 `checkin()` 抛错而不是谎报已领）。
       */
      checkin: true,
    },
    /**
     * 对象判别式：Qoder 凭据的**独有**字段。
     *
     * ⚠️ 不认 `access_token` / `uid` 这些通用字段 ——
     * 它们和 buddy 等家重叠，拿来判别会让 Qoder 凭据被 buddy 兜底抢走
     * （实测：本地 QODER 凭据被判成 buddy）。
     * Qoder 独有：`security_oauth_token` / `machine_id`（成对出现）。
     */
    matchesShape(input) {
      return (
        typeof input['security_oauth_token'] === 'string'
        || (typeof input['machine_id'] === 'string' && typeof input['security_oauth_token'] === 'string')
      )
    },
    parseCredential,
    async listModels(_credential, _signal) {
      // ⚠️ **恒用静态表，不发网络请求**：远端 `GET /algo/api/v2/model/list`
      // 需 WASM 签名，而目录是只读能力 —— 付密码学代价换一张几乎不变的清单
      // 不值得（`AGENTS.md` 的 Qoder 章节第 3 条，参考实现同样做法）。
      return toProviderModels(product.fallbackModels)
    },
    /**
     * ✅ **可静默续期**：`POST {openApiBase}/api/v1/deviceToken/refresh`
     * （蛇形 body + 必填 `machine_id`，完整说明见 {@link refresh}）。
     *
     * ⚠️ 它**只挂 `openApiBase`**（国际版 `openapi.qoder.sh` / 中国版
     * `openapi.qoder.com.cn`）—— 续期与推理不是一个 host，别混用。
     * 本方法是产品参数化的，故 `qoder` 与 `qodercn` 两个变体自动都有一份。
     */
    async refresh(credential, signal) {
      return await refresh(product, credential, signal)
    },
    async chat(credential, request) {
      return await chat(product, credential, request)
    },
    async balance(credential, signal) {
      return await balance(product, credential, signal)
    },
    async checkin(credential, signal) {
      return await checkin(product, credential, signal)
    },
    shouldRotate(status, bodyText) {
      // ⚠️ 额度用尽（110）**不该换号**：它按自然日结算，换号确实可能换成另一个
      // 还有额度的账号 —— 故这里**返回 true**，与「不重试同一账号」并不矛盾
      // （换号由账号池负责标记，见 `AGENTS.md` 第 9 条的用户要求）。
      if (looksLikeQoderBillingError(bodyText)) return true
      return status === 429 || status === 402
    },
  }
}

/** 国际版 provider（注册表用的就是它）。 */
export const qoderProvider: Provider = buildQoderProvider(buildQoderProduct('qoder'))

/**
 * 中国版 provider —— **已可直接注册**（`buildQoderProduct('qodercn')` 只差配置）。
 *
 * 目前**不**放进 `src/providers/index.ts` 的 `PROVIDERS`（按任务要求只注册
 * `qoder`）；将来要加时，把它加进数组并给 `env` 无需改动 —— 没有任何
 * 实现文件需要复制。
 */
export const qodercnProvider: Provider = buildQoderProvider(buildQoderProduct('qodercn'))

// ─────────────────────────── 设备码登录（PKCE 轮询） ───────────────────────────

/** 一次设备登录会话（`machineId` 必须随凭据持久化）。 */
export interface QoderDeviceSession {
  verifier: string
  nonce: string
  machineId: string
  loginUrl: string
  productId: string
}

/** 生成 PKCE verifier / challenge。 */
async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  // ⚠️ RFC 7636 的 unreserved 集合（共 66 个字符），与源码 `Y_a()` 一致
  // （`src/qoder.ts:33-39`）。
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const length = 43 + Math.floor(86 * Math.random())
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let verifier = ''
  for (let i = 0; i < length; i += 1) {
    verifier += alphabet[(bytes[i] ?? 0) % alphabet.length]
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  // ⚠️ base64url 且**去掉 padding** —— 带 `=` 会让服务端校验失败
  // （`src/qoder.ts:49-55`）。
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

/**
 * 第一步：构造授权 URL 并返回会话（**不打开浏览器、不等用户**）。
 *
 * 两步式是**协议要求**：浏览器只在用户点击后的短暂窗口内允许 `window.open`，
 * 若把「生成 URL → 打开 → 等授权」做成一次阻塞调用，调用方拿到 URL 时手势
 * 已过期，弹窗被拦截（`src/qoder-oauth.ts:11-17` 的真实缺陷）。
 *
 * ⚠️ `client_id` 用 **`product.clientId`**（prod 的 `J_a`）。用错的那个
 * 会让服务端在**授权回调阶段**拒绝（页面报「参数无效」），且**入口 302
 * 检查发现不了** —— 对任一 client_id（含全零 UUID）它都回 302。
 */
export async function startQoderLogin(
  variant: 'qoder' | 'qodercn' = 'qoder',
): Promise<QoderDeviceSession> {
  const product = buildQoderProduct(variant)
  const pkce = await createPkce()
  const nonce = crypto.randomUUID()
  const machineId = crypto.randomUUID()
  const query = new URLSearchParams({
    challenge: pkce.challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: product.clientId,
  })
  return {
    verifier: pkce.verifier,
    nonce,
    machineId,
    loginUrl: `${product.authBase}/device/selectAccounts?${query.toString()}`,
    productId: product.id,
  }
}

/**
 * 第二步：轮询一次取 token。
 *
 * ⚠️ **挂 `openApiBase`，不是 `authBase`**：实测 `qoder.com` 的该路径返回 401，
 * 而 `openapi.qoder.sh` 返回 **404**（= 无待授权会话，**应继续轮询**）。
 * 写错 host 会让登录永远失败（`src/qoder.ts:120-126`）。
 *
 * ⚠️ **HTTP 404 不是错误**，它表示「用户尚未完成授权」。实测依据：该端点返回
 * 404 而任意不存在的路径返回 401 —— 说明它被网关豁免认证、由业务层报
 * 「会话未就绪」（`src/qoder-oauth.ts:110-118`）。
 *
 * @returns `undefined` 表示「继续等」；否则是解析好的凭据。
 */
export async function pollQoderLogin(
  session: QoderDeviceSession,
  signal: AbortSignal,
): Promise<ProviderCredential | undefined> {
  const product = buildQoderProduct(session.productId === 'qodercn' ? 'qodercn' : 'qoder')
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.verifier,
    challenge_method: 'S256',
  })
  const res = await fetch(
    `${product.openApiBase}/api/v1/deviceToken/poll?${query.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  )
  // ⚠️ 404 = 尚未授权 → 继续轮询（**不是错误**）。
  if (res.status === 404) return undefined
  if (!res.ok) {
    throw new ProviderError({
      provider: product.id,
      httpStatus: res.status,
      retryable: res.status >= 500,
      message: `Qoder 登录轮询失败：http=${res.status}`,
    })
  }
  const payload = (await res.json()) as Record<string, unknown>
  // 登录响应用 `token`，续期响应用 `device_token` —— 两者字段名不同，故都接受
  // （`src/qoder.ts:205-235`）。
  const accessToken = readString(payload, ['token', 'device_token', 'access_token'])
  if (accessToken === undefined) return undefined
  const uid = readString(payload, ['user_id', 'userId'])
    ?? (() => {
      const jwt = decodeJwtPayload(accessToken)
      return jwt === undefined ? undefined : readString(jwt, ['sub', 'user_id', 'uid'])
    })()
  if (uid === undefined) {
    throw new ProviderError({
      provider: product.id,
      message: 'Qoder 设备码响应缺少 user_id，且令牌里解不出 `sub` —— 无法构造加密推理所需的 uid',
    })
  }
  return {
    provider: product.id,
    uid,
    accessToken,
    refreshToken: readString(payload, ['refresh_token', 'refreshToken']) ?? '',
    expiresAt: readExpiresAt(payload),
    // ⚠️ 设备码轮询响应里**没有用户名**，昵称只能后续补一次 `/api/v1/userinfo`
    // （`src/qoder.ts:343-394` 记录了这次真实缺陷：4 个账号的 nickname 全缺失）。
    // 故这里先回落到 uid，由调用方用 `fetchQoderUserNickname` 补齐。
    nickname: readString(payload, ['user_name', 'userName']) ?? uid,
    extras: { [EXTRA_MACHINE_ID]: session.machineId },
  }
}

/**
 * 补一次昵称（`GET /api/v1/userinfo` 的 `name`）。
 *
 * ⚠️ 失败时返回 `undefined` 而**不抛错**：昵称只是展示信息，拿不到不应让登录
 * 整体失败（`src/qoder.ts:360-367` 的同原则）。
 */
export async function fetchQoderUserNickname(
  variant: 'qoder' | 'qodercn',
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<string | undefined> {
  const product = buildQoderProduct(variant)
  try {
    const res = await fetch(`${product.openApiBase}/api/v1/userinfo`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}` },
      signal: signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as Record<string, unknown>
    return readString(body, ['name', 'displayName', 'nickname'])
  } catch {
    return undefined
  }
}
