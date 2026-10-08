/**
 * 供应商注册表。
 *
 * ## 为什么是显式注册而不是动态发现
 *
 * Workers 是打包的，没有运行时文件系统扫描 —— 「自动发现」在这里不成立。
 * 显式注册表还有一个好处：**能不能跑在 Workers 上一眼可见**
 * （每个 import 的模块都必须是纯 Web 标准的）。
 *
 * ## 稳定性纪律
 *
 * 注册顺序决定「默认供应商」的兜底选择，故**不要随意调整顺序**。
 * 第一项是历史默认（WorkBuddy），保证既有用户的裸模型名继续可用。
 */

import type { Provider, ProviderCredential } from './types.js'
import { ProviderError } from './types.js'
import { buddyProvider, workbuddyProvider } from './buddy.js'
import { clineProvider } from './cline.js'
import { minimaxProvider } from './minimax.js'
import { codeartsProvider } from './codearts.js'
import { lobsteraiProvider } from './lobsterai.js'
import { loomyProvider } from './loomy.js'
import { traeProvider } from './trae.js'
import { qoderProvider } from './qoder.js'
import { opencodeProvider } from './opencode.js'
import { raccoonProvider } from './raccoon.js'
import { zcodeProvider } from './zcode.js'
import { parseJsonLenient } from '../upstream/import.js'

/**
 * 全部供应商（**顺序有意义**：第 0 项是默认供应商）。
 */
export const PROVIDERS: readonly Provider[] = [
  // ⚠️ 顺序有语义：第 0 项是默认供应商（裸模型名回落到它）。
  //
  // `buddy`（国内版）在前：本项目既有的账号与调用方都是国内版，
  // 保持它作默认才不会破坏兼容。
  //
  // 命名口径对齐参考项目 `deepseek-harness-codearts/src/product.ts:76`
  // （`id: 'buddy' | 'workbuddy'`）：buddy = 国内，workbuddy = 国际。
  buddyProvider,
  workbuddyProvider,
  clineProvider,
  minimaxProvider,
  codeartsProvider,
  lobsteraiProvider,
  traeProvider,
  qoderProvider,
  opencodeProvider,
  raccoonProvider,
  zcodeProvider,
  // ⚠️ **放在最后**：数组第 0 项是默认供应商，不能被新加的挤动。
  loomyProvider,
]

/** 默认供应商 id（裸模型名回落到它）。 */
export const DEFAULT_PROVIDER = PROVIDERS[0]?.id ?? 'workbuddy'

/** 全部已注册的供应商 id。 */
export function providerIds(): string[] {
  return PROVIDERS.map((p) => p.id)
}

/** 按 id 取供应商（未知返回 undefined）。 */
export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** 按 id 取供应商，未知则抛错（带可用列表，便于排查）。 */
export function requireProvider(id: string): Provider {
  const p = findProvider(id)
  if (p === undefined) {
    throw new ProviderError({
      provider: id,
      message: `未知供应商「${id}」。可用：${providerIds().join('、')}`,
    })
  }
  return p
}

/**
 * 尝试所有供应商解析凭据，返回第一个成功的。
 *
 * ## 为什么这样设计（而不是让用户选供应商）
 *
 * 用户粘贴凭据时**不该被迫先声明这是哪家的** —— 凭据本身有足够的判别特征
 * （字段名、id 前缀、端点域）。失败时把**每一家的拒绝原因**都带上，
 * 这样用户能从错误里看出「到底缺什么」。
 */
export function parseCredentialAnywhere(
  input: unknown,
  /** 用户显式声明的供应商（给了就只试它）。 */
  expected?: string,
): { provider: Provider; credential: ProviderCredential } {
  const errors: string[] = []

  if (expected !== undefined && expected !== '') {
    // ⚠️ `requireProvider` 自己就抛 ProviderError；这里**不能**把它包进 try，
    // 否则「未知供应商」会被误报成「按声明的供应商解析失败」——
    // 掩盖了真实原因（用户只是拼错了供应商名）。
    const provider = requireProvider(expected)
    try {
      return { provider, credential: provider.parseCredential(input) }
    } catch (error) {
      // 已经是 ProviderError 就原样透出（保留其 provider/httpStatus/retryable 信息），
      // 只对非 ProviderError（如 TypeError）做包装。
      if (error instanceof ProviderError) throw error
      throw new ProviderError({
        provider: expected,
        message: `按声明的供应商「${expected}」解析凭据失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // ⚠️ **WorkBuddy 必须最后试**。
  //
  // 它的凭据形态是最宽松的（只要 `accessToken` + `uid`），因此会把别的供应商的
  // 凭据也「认下来」，然后拿去打 WorkBuddy 的端点 → 永远 401。
  // 而其它供应商的凭据有更强的判别特征（cline 的 `workos:` 前缀、
  // codearts 的 AK/SK 对）。
  // 故顺序是：**特征强的先试，最宽松的兜底**。
  const ordered = [...PROVIDERS].sort((a, b) => {
    if (a.id === DEFAULT_PROVIDER) return 1
    if (b.id === DEFAULT_PROVIDER) return -1
    return 0
  })

  // ⚠️ 裸字符串要按形状**预筛**供应商。
  // 否则「任意非空字符串即收下」的那几家会把任何文本吞掉，产出必然 401 的
  // 假账号（实测 `'str'` 被 minimax 收下），而用户看到的是「导入成功」。
  // ⚠️ 字符串输入有两种可能，必须**先判别**：
  //   (a) 一段 JSON 文本（用户从凭据文件里复制的值）；
  //   (b) 一个裸令牌（如 `workos:xxx` / `sk-xxx` / `public`）。
  //
  // 之前把两者都当成裸令牌，于是 (a) 会被 `bareStringPattern` 拒掉，
  // 报「没有任何供应商能解析这份凭据」—— 而它其实是一份完整的 JSON 凭据。
  // 判别方式：以 `{` 或 `[` 开头就按 JSON 解析（宽容解析，容忍裸控制字符）。
  let effective: unknown = input
  let bare: string | undefined
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        effective = parseJsonLenient(trimmed)
      } catch (error) {
        throw new ProviderError({
          provider: 'unknown',
          message: `凭据看起来是 JSON 但解析失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    } else {
      bare = trimmed
    }
  }
  const record =
    effective !== null && typeof effective === 'object' && !Array.isArray(effective)
      ? (effective as Record<string, unknown>)
      : undefined

  for (const provider of ordered) {
    // ⚠️ 对象形态也按 `matchesShape` 预筛：多家凭据字段高度重叠
    // （且 WorkBuddy/cline/minimax/zcode 的令牌**都是三段式 JWT**，
    // 形状无法区分）。实测 `{accessToken, uid}` 会被 cline 抢走，
    // 存成一个永远 401 的 cline 账号，而用户以为导入的是 WorkBuddy。
    //
    // 例外：**默认供应商**（WorkBuddy）作为兜底总是参与 ——
    // 它的形态最宽松，且语义上「没被别家认领的对象就是它的」，
    // 这样既保住向后兼容，又不会抢别家的凭据。
    if (record !== undefined && provider.id !== DEFAULT_PROVIDER) {
      const matches = provider.matchesShape
      if (matches === undefined || !matches(record)) {
        errors.push(`${provider.id}: 对象的字段形状不属于该供应商`)
        continue
      }
    }

    if (bare !== undefined) {
      const pattern = provider.bareStringPattern
      if (pattern === undefined) {
        errors.push(`${provider.id}: 不支持直接粘贴令牌字符串，请提供完整 JSON`)
        continue
      }
      if (!pattern.test(bare)) {
        errors.push(`${provider.id}: 字符串形状不匹配该供应商的令牌格式`)
        continue
      }
    }
    try {
      const credential = provider.parseCredential(effective)
      return { provider, credential }
    } catch (error) {
      errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ProviderError({
    provider: 'unknown',
    message: `没有任何供应商能解析这份凭据。\n${errors.join('\n')}`,
  })
}

/**
 * 供应商能力总览（面板用）。
 *
 * ⚠️ 只暴露**能力与阻塞原因**，不暴露任何凭据信息。
 */
export function providerCatalog(): Array<{
  id: string
  name: string
  capabilities: Provider['capabilities']
}> {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities }))
}
