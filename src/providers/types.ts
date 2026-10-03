/**
 * 多供应商抽象层。
 *
 * ## 为什么需要这一层
 *
 * 本项目最初只做 WorkBuddy（腾讯）。要接入其它供应商时，**不能**把每个供应商
 * 的分支写进网关 —— 那会让 `gateway/server.ts` 变成一个巨大的 switch，
 * 且每加一家都要动核心路径。
 *
 * 这里的做法：把「一家供应商」的全部差异收敛到一个 `Provider` 接口
 * （对应参考项目 `deepseek-harness-codearts` 的 `LlmAdapter` 思路），
 * 网关只依赖接口，不认具体供应商。
 *
 * ## 与参考项目的关键差异
 *
 * 参考项目依赖 DSH 宿主（`LlmRuntimeLike` / `settingsNamespace` / 注册表），
 * 本项目**刻意不依赖任何宿主** —— `Provider` 是自包含的纯接口，
 * 只用 Web 标准 API（`fetch` / `Request` / `ReadableStream` / WebCrypto）。
 * 这样它既能跑在 Workers，也能在 Node 单测里跑。
 *
 * ## 移植纪律（来自对参考项目的实测分析）
 *
 * 1. **登录机制决定可行性**：设备码轮询可在 Workers 跑；
 *    依赖 `127.0.0.1:<port>` 本地回调的**不可能**跑（Workers 无监听 socket）。
 *    这类供应商只支持「导入凭据」。
 * 2. **不假装支持**：不可移植的能力（如需 headful 浏览器的签到）
 *    必须在 `capabilities` 里**显式声明为 false**，而不是运行时静默失败。
 */

/** 凭据形态：所有供应商共用，但字段含义由各供应商解释。 */
export interface ProviderCredential {
  /** 供应商 id（如 `workbuddy` / `cline`）。 */
  provider: string
  /** 该供应商标识账号的稳定 id（用作主键）。 */
  uid: string
  /** 访问令牌（Bearer 值，含供应商要求的前缀）。 */
  accessToken: string
  /** 刷新令牌（可能为空）。 */
  refreshToken: string
  /** 绝对过期时刻（epoch ms）。0 = 未知/不过期。 */
  expiresAt: number
  /** 昵称（展示用）。 */
  nickname: string
  /**
   * 供应商特有字段的**兜底口袋**。
   *
   * ⚠️ 用途是容纳那些不影响主流程、但个别供应商需要的字段
   * （如 codearts 的 AK/SK、qoder 的 machineToken）。
   * **不要把主流程必需的字段塞进来** —— 那会失去类型检查。
   */
  extras: Record<string, string>
}

/**
 * 供应商能力声明。
 *
 * ⚠️ **必须如实声明**。声明了却做不到，会让用户以为能用而实际失败；
 * 反之则会隐藏可用能力。两者都比「不支持」更糟 ——
 * 后者至少是**可解释**的（AGENTS.md §7.2「失败必须显式」）。
 */
export interface ProviderCapabilities {
  /** 能否在 Workers 里完成设备码/轮询式登录（false ⇒ 只能导入凭据）。 */
  login: boolean
  /** 能否列出模型目录。 */
  listModels: boolean
  /** 能否流式对话。 */
  chat: boolean
  /** 能否查余额。 */
  balance: boolean
  /** 能否自动每日签到。 */
  checkin: boolean
  /**
   * 登录不可用时的**可读原因**（会直接显示在面板上）。
   *
   * ⚠️ 不要写「不支持」这种无信息量的文案 —— 要说清**为什么**，
   * 用户才知道该怎么办（例如「需本地回调监听，请从桌面端导出凭据」）。
   */
  loginBlockedReason?: string
  /**
   * 签到不可用时的**可读原因**。
   *
   * ⚠️ 与 `loginBlockedReason` 同理：`checkin: false` 必须能解释清楚，
   * 否则用户会以为是本服务的缺陷（实测：国际版**上游本就没有**签到接口）。
   */
  checkinBlockedReason?: string
}

/** 对话请求（与 OpenAI 兼容，但由各供应商自行转换）。 */
export interface ChatRequest {
  /** 模型 id（**不含** `provider/` 前缀）。 */
  model: string
  /** 已准备好的请求体（OpenAI 形状，由网关清洗过）。 */
  body: Record<string, unknown>
  /** 客户端断开信号。 */
  signal: AbortSignal
}

/** 模型目录条目（统一形状）。 */
export interface ProviderModel {
  id: string
  name: string
  /** 上下文窗口（0 = 未知）。 */
  contextWindow: number
  /** 单次输出上限（0 = 未知）。 */
  maxOutput: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 是否免费额度模型。 */
  isFree: boolean
}

/** 余额信息（统一形状）。 */
export interface ProviderBalance {
  /** 可用总额。 */
  total: number
  /** 即将过期的额度（0 = 无）。 */
  expiring: number
  /** 最早过期时刻（0 = 无）。 */
  earliestExpiry: number
  /** 明细条目（可空）。 */
  packages: Array<{ name: string; amount: number; expiry: number }>
}

/** 签到结果。 */
export interface CheckinResult {
  /** 今天是否已签到（幂等命中）。 */
  alreadyDone: boolean
  /** 本次获得的额度（0 = 未知或不适用）。 */
  gained: number
  /** 可读说明。 */
  detail: string
}

/**
 * 一个供应商。
 *
 * ## 实现纪律
 *
 * - **每个方法都必须自己处理错误并抛出带原文的异常**，
 *   绝不返回「空结果」冒充成功（那是最难排查的失败形态）。
 * - **不要在这层做账号池/冷却** —— 那是 `AccountPoolDO` 的职责。
 *   这一层只回答「用这份凭据能不能成、结果是什么」。
 */
export interface Provider {
  /** 供应商 id（小写，用于 URL 与存储）。 */
  readonly id: string
  /** 展示名。 */
  readonly name: string
  /** 能力声明。 */
  readonly capabilities: ProviderCapabilities

  /**
   * 从用户粘贴的任意形状里解析出凭据。
   *
   * ⚠️ 各供应商的凭据形态差异极大（有的嵌套、有的扁平、有的要 AK/SK）。
   * 实现必须**宽容**（尽量认）但**严格**（缺关键字段就抛错，
   * 不要用空字符串兜底 —— 那会产出永远 401 的凭据）。
   */
  parseCredential(input: unknown): ProviderCredential

  /** 列出模型目录。 */
  listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]>

  /**
   * 发起流式对话，返回**上游原始响应**。
   *
   * 返回 `Response` 而不是解析后的 chunk：网关需要**逐帧透传**（10ms CPU 约束），
   * 由 `stream` 模块统一转换，供应商层不重复实现流处理。
   */
  chat(credential: ProviderCredential, request: ChatRequest): Promise<Response>

  /** 查余额（`capabilities.balance === false` 时不该被调用）。 */
  balance?(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance>

  /** 每日签到（`capabilities.checkin === false` 时不该被调用）。 */
  checkin?(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult>

  /**
   * 对象凭据的**判别式**（自动识别时用）。
   *
   * ## ⚠️ 为什么必须有它（实测踩到的严重缺陷）
   *
   * 多个供应商的凭据形状**高度重叠**，最要命的是：**WorkBuddy、cline、minimax、
   * zcode 的 access token 都是三段式 JWT**（实测 WorkBuddy 的 token 就是标准
   * `eyJhbGciOiJSUzI1NiIsImtpZCI6…`，1500 字符）。因此
   * **靠令牌形状无法区分**是哪一家。
   *
   * 更糟的是字段名也重叠：cline 把 `uid` / `user_id` 当作 `accountId` 的别名，
   * 而 DSH 形态的 WorkBuddy 凭据恰好就有 `user_id`。结果实测
   * `{accessToken, uid}` 被 **cline 抢走**，存成一个 cline 账号，
   * 一用就 401 —— 而用户以为导入的是 WorkBuddy。
   *
   * ⇒ 判据必须是**该供应商独有**的字段（别家不会有），而不是通用别名。
   * 返回 true 表示「这个对象看起来是我的」。
   *
   * 未声明该方法 = 「不参与对象形态的自动识别」（只接受显式声明）。
   * 这样设计是刻意的：**宁可要求用户显式说明，也不要把凭据存错家**。
   */
  matchesShape?(input: Record<string, unknown>): boolean

  /**
   * 裸字符串凭据的**判别式**（自动识别时用）。
   *
   * ## ⚠️ 为什么需要它（实测踩到的系统性缺陷）
   *
   * 有四个供应商支持「直接粘贴令牌字符串」这种形态（cline / minimax /
   * opencode / zcode）。若它们都无条件接受任何非空字符串，那么
   * `parseCredentialAnywhere` 的**自动识别**会把**任意文本**交给排在最前的那家
   * —— 实测 `parseCredentialAnywhere('str')` 被 minimax 收下，
   * 产出一个永远 401 的假账号，而用户看到的是「导入成功」。
   *
   * ⇒ 自动识别时，只有**形状匹配**的供应商才有资格收下裸字符串。
   * 显式声明供应商时**不校验**（用户已明确说了这是哪家，不该替他判断）。
   *
   * 返回 `undefined` 表示「不支持裸字符串形态」。
   */
  readonly bareStringPattern?: RegExp

  /**
   * 判断该错误是否值得**换号重试**。
   *
   * 缺省语义（各供应商可覆盖）：429 与 402 值得换号，
   * 其余（400 请求非法 / 5xx 服务端故障）换号无用。
   */
  shouldRotate?(status: number, bodyText: string): boolean
}

/** 供应商层抛出的错误（带可读原因，便于面板与日志）。 */
export class ProviderError extends Error {
  readonly provider: string
  readonly httpStatus: number
  /** 是否值得换号重试。 */
  readonly retryable: boolean

  constructor(input: {
    provider: string
    message: string
    httpStatus?: number
    retryable?: boolean
  }) {
    super(input.message)
    this.name = 'ProviderError'
    this.provider = input.provider
    this.httpStatus = input.httpStatus ?? 0
    this.retryable = input.retryable ?? false
  }
}

/**
 * 把 `provider/model` 形式的模型名拆开。
 *
 * ## 为什么用前缀而不是查表
 *
 * 不同供应商的模型 id **可能重名**（多家都有 `glm-4.6` 之类）。
 * 用 `provider/` 前缀是无歧义的，且对客户端透明（OpenAI 客户端
 * 只把它当字符串）。
 *
 * ⚠️ 无前缀时的处理：**回落到默认供应商**（而不是报错）。
 * 理由：本项目既有用户已经在用裸模型名（`deepseek-v4-flash`），
 * 突然要求加前缀会破坏兼容性。
 */
export function splitModelName(
  raw: string,
  knownProviders: readonly string[],
  defaultProvider: string,
): { provider: string; model: string } {
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const head = raw.slice(0, slash)
    // 只有**已知供应商**才当作前缀 —— 否则像 `deepseek/v3` 这种
    // 上游自带的斜杠模型名会被误拆。
    if (knownProviders.includes(head)) {
      return { provider: head, model: raw.slice(slash + 1) }
    }
  }
  return { provider: defaultProvider, model: raw }
}
