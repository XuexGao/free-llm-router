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
