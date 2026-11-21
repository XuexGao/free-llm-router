/**
 * Bindings、环境解析与「不写 `parseInt(x) || 默认值`」的硬纪律。
 *
 * ## 为什么这个文件单独存在
 *
 * AGENTS.md §6.8 记录了本项目最贵的同型缺陷：`parseInt(x) || 默认值`。
 * `0` 是**合法**配置值却是 falsy，用 `||` 会被静默换成默认值 —— 开关「关不掉」。
 * `deepseek-harness-codearts` 里至少三处记录过它（`openai-gateway/config.ts:12-14`、
 * `auto-checkin.ts:188-190`、`buddy-balance-rank.ts:87-89`）。
 *
 * 故本文件是**唯一的**环境读取入口，所有解析都走下面这几个函数，
 * 不允许在业务代码里直接读 `env`。
 */

import type { AccountPoolDO } from './pool/AccountPoolDO.js'
import type { TaskRunnerDO } from './taskrunner/TaskRunnerDO.js'

/** Worker 的 bindings 与 vars。 */
export interface Env {
  /** 账号池（每 realm 一个实例）。 */
  ACCOUNT_POOL: DurableObjectNamespace<AccountPoolDO>
  /** 任务执行器（每账号一个实例）。 */
  TASK_RUNNER: DurableObjectNamespace<TaskRunnerDO>

  /** 管理 API 与 OpenAI 兼容端口的共享密钥（用 `wrangler secret put` 设置）。 */
  API_KEY?: string
  /** 凭据加密密钥（32 字节 base64url）。**不设置则拒绝存凭据**，不静默明文落盘。 */
  CREDENTIAL_KEY?: string

  /** 上游域名（见 AGENTS.md §6.2，三个 base 不可混用）。 */
  UPSTREAM_CHAT_BASE?: string
  UPSTREAM_BILLING_BASE?: string
  UPSTREAM_WEB_BASE?: string

  /**
   * **数据面请求体上限**（字节，可选）。
   *
   * 缺省 **8 MiB**（见 `DEFAULT_MAX_REQUEST_BYTES` 的取值依据）。
   * 可通过环境变量 `MAX_REQUEST_BYTES` 覆盖，用于「超大 prompt / 多图 Base64 /
   * 多模态请求」这类正常但很大的请求。
   *
   * ⚠️ 它是**保护性上限**，不是容量目标：目的是让「超限」变成一条**可读的
   * 413 错误**，而不是在上游被拒（那里的报错通常与体积无关、极难归因）。
   */
  MAX_REQUEST_BYTES?: string
}

/** CN 域默认上游（与 Go 侧 `internal/upstream/client.go:693-695` 一致）。 */
export const DEFAULT_UPSTREAM = {
  chat: 'https://copilot.tencent.com',
  billing: 'https://www.codebuddy.cn',
  web: 'https://www.workbuddy.cn',
} as const

/**
 * 显式假值集合。
 *
 * ⚠️ 判据是「**归一化后的字符串是否在集合里**」，而不是 `!value` / `Number(x) || d`。
 * 这样 `'0'`、`'false'`、`'off'`、`'no'` 都能真正关掉开关，且未设置时取默认。
 */
const FALSY = new Set(['0', 'false', 'off', 'no'])

/**
 * 解析一个「默认开」的开关。
 * 未设置 / 空串 → `fallback`；显式假值 → `false`；其余 → `true`。
 */
export function parseEnabled(raw: string | undefined, fallback = true): boolean {
  if (raw === undefined) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '') return fallback
  return !FALSY.has(normalized)
}

/**
 * 解析整数。
 *
 * ⚠️ 刻意**不接受** `parseInt` 的宽松语义（`'12abc'` → 12）。要求整个字符串
 * 就是整数，否则视为非法并返回 `undefined` —— 让调用方显式决定回退策略，
 * 而不是吞掉配置错误。
 */
export function parseInteger(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // 手写整数校验：拒绝 '12abc'、'1.5'、'0x10'、' 12 '（已 trim 故后者可行）
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/** 读取非空字符串；空串视为未设置。 */
export function parseString(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * **数据面请求体上限的缺省值**（8 MiB）。
 *
 * ## 为什么是 8 MiB（而不是更大/更小）
 *
 * - **够用**：一张 2 MiB 的图片经 Base64 膨胀 4/3 ≈ 2.7 MiB；
 *   3 张图 + 正常 prompt 在 8 MiB 内绰绰有余（本项目单图上限另有约束，
 *   见 `providers/*.ts` 的 `imageMaxBytes`）。
 * - **不超过平台硬限**：Workers 对请求体本身有上限（免费档更紧），
 *   设太大只会在平台层被拒 —— 那时拿到的错误与本服务的语义无关。
 * - **它能拦住的是「异常大」**：50 MiB 级别的请求几乎必然是
 *   误用（整段日志/超大附件），而不是正常对话。
 *
 * ⚠️ **可覆盖**：确实需要更大时用 `MAX_REQUEST_BYTES` 环境变量，
 * 不要去改这个常量（改常量会让所有部署一起变，而需要大体积的只是个别场景）。
 */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * 解析 `MAX_REQUEST_BYTES`。
 *
 * ## ⚠️ 绝不写 `parseInt(x) || 默认值`（本项目 §6.8 的硬规则）
 *
 * 那条写法对 `"0"` 会得到默认值（`0` 是 falsy）—— 而 `0` 在这里的含义是
 * 「不限制」，是一个**合法且有意为之**的配置。故判据是显式的：
 * 未设置 / 空串 / 非数字 / 负数 ⇒ 回落默认；**`0` 明确表示不限制**。
 *
 * ⚠️ 上限 `MAX_SAFE_INTEGER` 由 `Number.isSafeInteger` 兜住，
 * 但业务上再夹一个合理上限（1 GiB）—— 超过它的值几乎必然是误填
 * （例如把字节数写成字符数再加了几个零），而**静默接受**会让「限制」形同虚设。
 */
export function resolveMaxRequestBytes(env: Env): number {
  const raw = env.MAX_REQUEST_BYTES
  if (raw === undefined) return DEFAULT_MAX_REQUEST_BYTES
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_MAX_REQUEST_BYTES
  // ⚠️ 只认纯十进制整数：`"8MiB"` / `"1e9"` / `"0x10"` 一律当非法（回落默认），
  // 而不是让 `Number()` 去猜（`Number('0x10')` 是 16 —— 那种「猜对了但没证据」的宽容很危险）
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_REQUEST_BYTES
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(value)) return DEFAULT_MAX_REQUEST_BYTES
  // `0` = 不限制（合法配置，不是 falsy 兜底）
  if (value === 0) return 0
  // 超过 1 GiB 视为误填 ⇒ 回落默认（见上）
  if (value > 1024 * 1024 * 1024) return DEFAULT_MAX_REQUEST_BYTES
  return value
}

/** 上游域名集合。 */
export interface UpstreamBases {
  chat: string
  billing: string
  web: string
}

export function resolveUpstream(env: Env): UpstreamBases {
  return {
    chat: parseString(env.UPSTREAM_CHAT_BASE, DEFAULT_UPSTREAM.chat),
    billing: parseString(env.UPSTREAM_BILLING_BASE, DEFAULT_UPSTREAM.billing),
    web: parseString(env.UPSTREAM_WEB_BASE, DEFAULT_UPSTREAM.web),
  }
}
