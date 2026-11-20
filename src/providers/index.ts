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
import { minimaxProvider, minimaxIntlProvider } from './minimax.js'
import { codeartsProvider } from './codearts.js'
import { lobsteraiProvider } from './lobsterai.js'
import { loomyProvider } from './loomy.js'
import { geminiProvider } from './gemini.js'
import { traeProvider } from './trae.js'
import { qoderProvider, qodercnProvider } from './qoder.js'
import { opencodeProvider } from './opencode.js'
import { raccoonProvider } from './raccoon.js'
import { zcodeProvider } from './zcode.js'
import { parseJsonLenient } from '../upstream/import.js'

/**
 * 默认供应商 id（裸模型名回落到它）。
 *
 * ## ⚠️ 它与 {@link PROVIDERS} 的**顺序无关**了（2026-11-21 改）
 *
 * 改前：默认供应商**就是数组第 0 项**。那条耦合有两个真实代价：
 *
 * 1. **改默认值等于改注册顺序** —— 而注册顺序还决定「自动识别时先试谁」，
 *    两件事被绑在一起，任何一边的调整都会悄悄影响另一边；
 * 2. **`array[0]` 会被新加的供应商挤动** —— 源码里那条「放在最后，不能被新加的
 *    挤动」的注释，正是这个脆弱性的自白。
 *
 * 现在显式声明：想换默认供应商只改这一个字符串。
 *
 * ## ⚠️ 为什么默认是 Trae（用户要求，2026-11-21）
 *
 * 用户明确要求「默认供应商改为 Trae，workbuddy 现在不太稳定」。
 *
 * **代价（必须知道）**：裸模型名（`deepseek-v4-flash` 这种不带 `provider/` 前缀的）
 * 从此回落到 **Trae**，而不再是 WorkBuddy。既有的裸名调用方会因此换渠道 ——
 * 这是用户明示要求的行为变更，不是缺陷。
 *
 * ⚠️ **它不影响任何已存账号**：账号的 `provider` 字段是落盘时写下的，
 * 读取时不依赖本常量（见 `src/index.ts` 的 `persistProviderCredential`）。
 */
export const DEFAULT_PROVIDER = 'trae'

/**
 * **需要绑定 `env` 的供应商**（目前只有 WorkBuddy 国内版）。
 *
 * ## ⚠️ 为什么它与 `DEFAULT_PROVIDER` 必须分开（这是一个真实故障源）
 *
 * 改前源码里到处是 `providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider`
 * —— 它把「谁是默认供应商」当成了「谁需要 env 绑定」的判据。两者**毫无关系**：
 *
 * - `bindBuddy` 的唯一职责是「让国内版可以用 env 覆盖上游域名」，
 *   那是 **buddy 这个产品的特性**；
 * - 而「默认供应商」只是「裸模型名回落到谁」。
 *
 * 默认值是 buddy 时两者**恰好重合**，所以缺陷一直没暴露。一旦把默认改成 Trae：
 * - Trae 会被喂进 `bindBuddy(env)` ⇒ 拿到一个**国内版 buddy 的 provider 对象**，
 *   于是「用 Trae 的凭据打腾讯端点」—— 必然 401；
 * - 而**真正的 buddy** 因为不再是默认值，反而拿不到 env 绑定。
 *
 * ⇒ 故这里用**产品 id** 判定，与默认供应商彻底解耦。
 */
export const ENV_BOUND_PROVIDER = 'buddy'

/**
 * 取「本次调用该用哪个 provider 实例」。
 *
 * ⚠️ **所有调用点都必须走这里**，不要再写 `x === DEFAULT_PROVIDER ? bindBuddy(...) : p`
 * —— 那正是上面注释记录的那个故障源。
 *
 * @param providerId 供应商 id
 * @param fallback 该 id 对应的 provider 实例（通常是 `findProvider` 的结果）
 * @param env Worker 绑定（只有 buddy 会用到）
 */
export function providerForCall(
  providerId: string,
  fallback: Provider,
  /** `bindBuddy` 的延迟引用 —— 由调用方传入，避免 providers 层反向依赖 buddy 的 env 类型。 */
  bindEnvBound: (() => Provider) | undefined,
): Provider {
  if (providerId === ENV_BOUND_PROVIDER && bindEnvBound !== undefined) return bindEnvBound()
  return fallback
}

/**
 * **历史账号没有 `provider` 字段时**该当作哪一家。
 *
 * ## ⚠️ 为什么它必须与 `DEFAULT_PROVIDER` 分开（真实故障源）
 *
 * 源码里大量 `account.provider ?? DEFAULT_PROVIDER` 的兜底，其真实语义是
 * 「**本项目的原生供应商**」—— 也就是历史数据（那时只有 WorkBuddy）里的账号。
 *
 * 把默认供应商改成 Trae 之后，若这些兜底仍读 `DEFAULT_PROVIDER`，会发生：
 * - 所有**改动前**落盘、`provider` 字段为空的老 WorkBuddy 账号，
 *   会被当成 **Trae** 账号；
 * - 于是拿腾讯凭据打字节端点 —— 必然 401，而用户看到的是「账号失效了」。
 *
 * ⇒ 兜底值是**数据的解释规则**，它只由「历史上写没写这个字段」决定，
 * **与默认供应商无关**。默认供应商可以换，这个不能跟着换。
 */
export const LEGACY_PROVIDER = 'buddy'

/**
 * 全部供应商。
 *
 * ## ⚠️ 顺序**不再决定**默认供应商（见 {@link DEFAULT_PROVIDER}）
 *
 * 但顺序仍有**一个**语义：**自动识别凭据时的尝试次序**
 * （`parseCredentialAnywhere` 会把默认供应商排到最后当兜底，其余保持本序）。
 * 故「特征强的在前、最宽松的兜底」这条纪律仍然有效。
 *
 * 命名口径对齐参考项目 `deepseek-harness-codearts/src/product.ts:76`
 * （`id: 'buddy' | 'workbuddy'`）：buddy = 国内，workbuddy = 国际。
 */
export const PROVIDERS: readonly Provider[] = [
  // ⚠️ `buddy`（国内版）的凭据形态**最宽松**（只要 accessToken + uid），
  // 故它在自动识别里由 `parseCredentialAnywhere` 显式排到最后 ——
  // 这里的数组位置只影响面板展示，不影响识别的「最后」语义。
  buddyProvider,
  workbuddyProvider,
  clineProvider,
  minimaxProvider,
  // ⚠️ 国际版紧随国内版（同族相邻）：两站凭据形态相同，**国际版不参与**
  // 自动识别（它不声明 `matchesShape`），故顺序不影响识别结果。
  minimaxIntlProvider,
  codeartsProvider,
  lobsteraiProvider,
  traeProvider,
  qoderProvider,
  // ⚠️ 中国版紧随国际版：两者**形状无法区分**，自动识别时中国版不参与
  //（它不声明 `matchesShape`），故顺序不影响识别结果，只影响面板展示。
  qodercnProvider,
  opencodeProvider,
  raccoonProvider,
  zcodeProvider,
  loomyProvider,
  geminiProvider,
]

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
  //
  // ## ⚠️ 这里排的是 `ENV_BOUND_PROVIDER`（buddy），**不是** `DEFAULT_PROVIDER`
  //
  // 改前写的是「把默认供应商排到最后」—— 那条判据在默认值恰好是 buddy 时
  // 语义正确，但它把两件事混为一谈：
  //
  // - 「谁最宽松、该兜底」是**凭据形状**的属性（buddy 只要 accessToken+uid）；
  // - 「谁是默认供应商」是**裸模型名路由**的属性，与形状无关。
  //
  // 默认值改成 Trae 之后，若仍按 `DEFAULT_PROVIDER` 排序，会发生两件真事：
  // 1. **Trae 被排到最后**，而它的 `matchesShape` 要求 `machine_id`+`device_id`
  //    —— 它本来就不该兜底；
  // 2. **buddy 不再被排到最后** ⇒ 它会在 `trae` 之前被尝试，
  //    于是任何 `{accessToken, uid}` 形态的对象都被 buddy 抢走
  //    （这正是 `types.ts` 记录的「导入成功但打哪都 401」那个缺陷）。
  const ordered = [...PROVIDERS].sort((a, b) => {
    if (a.id === ENV_BOUND_PROVIDER) return 1
    if (b.id === ENV_BOUND_PROVIDER) return -1
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
    // 例外：**兜底供应商**（WorkBuddy 国内版）作为兜底总是参与 ——
    // 它的形态最宽松，且语义上「没被别家认领的对象就是它的」，
    // 这样既保住向后兼容，又不会抢别家的凭据。
    if (record !== undefined && provider.id !== ENV_BOUND_PROVIDER) {
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
