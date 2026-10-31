/**
 * 规范模型名归一化（「聚合 provider」的地基）。
 *
 * ## 要解决的问题
 *
 * 同一个真实模型在各渠道的叫法**完全不同**。以 DeepSeek V4.1 Flash 为例
 *（下面全是线上实测的真实 id）：
 *
 * | 渠道 | 线上真实 id |
 * |---|---|
 * | `buddy` / `workbuddy` / `trae` / `codearts` / `cline` | `deepseek-v4.1-flash` |
 * | `lobsterai` | `deepseek-flash` |
 * | `raccoon` | `sn-deepseek-v4-1-flash` |
 * | `loomy` | `DeepSeek-V4.1-Flash` |
 *
 * ⇒ 用户在选择器里看到**四条同名条目**，却不知道它们其实是同一个模型、
 * 只是渠道不同（而各渠道的积分到期时间不同）。本模块把它们归到**一个规范键**。
 *
 * ## 推导优先级（顺序不可改）
 *
 * 1. **显式补丁** `CANONICAL_OVERRIDES`：少数`realId` 与规范键**没有字面关系**
 *    （如 lobsterai 的 `deepseek-flash` —— 它其实等于 `deepseek-v4-1-flash`），
 *    字面推导救不了，只能显式登记；
 * 2. **按 id 推导**：绝大多数家（把 `id` 做规范化就得到规范键）；
 * 3. **按 name 推导**：少数家的 `id` 是无意义的代号（如 qoder 的 `qfmodel`），
 *    只能靠展示名。
 *
 * ⚠️ **每家的「主通道」是固定的**，不做投票、不做全局 name 优先 ——
 * 同一家的同一个模型必须**恒**归到同一个键，否则「排序」会随目录顺序抖动。
 *
 * ## 与参考实现的关系
 *
 * 算法与常量对齐参考实现 `canonical-models.ts`（已逐条核对）。
 * 本文件是**纯函数**（不碰网络/存储），故可被单测完全覆盖。
 */

/**
 * 规范化一个模型 id 成「键」形态。
 *
 * 顺序（**不可改**，每一步都对应实测踩过的形态）：
 * 1. `trim().toLowerCase()` —— 大小写不敏感（`MiniMax-M3` vs `minimax-m3`）；
 * 2. 去掉**最后一个** `/` 及其前缀 —— cline 的 id 形如 `cline-free/deepseek-v4.1-flash`，
 *    那一段是它的「免费通道」前缀，不是模型名的一部分；
 * 3. 去掉 `:free` 后缀（部分渠道用它标免费通道）；
 * 4. 去掉开头的 `sn-`（raccoon 的前缀，如 `sn-deepseek-v4-1-flash`）；
 * 5. `.` → `-`（`v4.1` → `v4-1`）；
 * 6. 空白 → `-`（`DeepSeek V4.1 Flash` → `deepseek-v4-1-flash`）。
 *
 * ⚠️ **日期快照后缀不剥**（`-0731`）：`deepseek-v4-flash-0731` 与
 * `deepseek-v4-flash` 是**两个不同的模型**，合并会让用户选到一个他并不知道的版本。
 * ⚠️ `-official` 同理不剥。
 * ⚠️ 点是**替换**不是删除：`v4.1` → `v4-1`，不能变成 `v41`（那会与 `v41` 撞车）。
 */
export function normalizeModelKey(raw: string): string {
  if (typeof raw !== 'string') return ''
  let s = raw.trim().toLowerCase()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:free$/, '')
  s = s.replace(/^sn-/, '')
  s = s.replace(/\./g, '-')
  s = s.replace(/\s+/g, '-')
  return s
}

/**
 * 规范化一个**展示名**成键形态。
 *
 * ⚠️ 与 `normalizeModelKey` 的差别在处理渠道加的装饰：
 * - 去掉 `·` 之后的一切（那是渠道拼的倍率/免费标记，如 `GLM-5.3-Flash · x0.8`）；
 * - 去掉「免费」二字（渠道用它标免费通道）。
 *
 * 只对 `id` 无意义的家（qoder）使用。
 */
export function normalizeNameKey(name: string): string {
  if (typeof name !== 'string') return ''
  let s = name.replace(/\s*·.*$/, '')
  s = s.replace(/免费/g, '')
  return normalizeModelKey(s.trim())
}

/**
 * **不参与聚合**的通用名。
 *
 * ⚠️ 这些名字在多个渠道里指**不同的东西**（`auto` 在 loomy 是它自己的自动路由，
 * `fast-model` 在 buddy 是一个具体档位），把它们聚成一个虚拟模型会让聚合层
 * 「替你选一个别的模型」，那是**静默改变语义**。
 *
 * ⚠️ `auto` 尤其重要：它是**聚合 provider 自己的保留名**（见 `aggregate.ts`），
 * 必须排除，否则会与聚合的 `auto` 撞车。
 */
export const EXCLUDED_ALIASES: ReadonlySet<string> = new Set([
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
  'auto',
])

/**
 * 显式补丁：那些字面推导**救不回来**的别名。
 *
 * ⚠️ 必须用 `Object.hasOwn` 查（见 {@link canonicalKeyFor} 的说明）——
 * 普通字面量对 `constructor` 会返回 `Object` 构造函数。
 *
 * 目前只有一条：lobsterai 的 `deepseek-flash` 实际就是 `deepseek-v4-1-flash`。
 * ⚠️ qoder 的 `qfmodel`（Qwen3.8-Flash）**不登记** —— 它的展示名与 V4 系列无关，
 * 登记只会把两个不同厂商的模型混在一起。
 *
 * ⚠️ qoder 的 `dfmodel` 现在**登记**了（用户明确要求「所有 DeepSeek-Flash 都归类
 * 为 DeepSeek-V4.1-Flash」，而它的展示名**正是** `DeepSeek-Flash`）。
 * 诚实记录一个限制：我用真实对话问过它的底层模型，它只答自己是「Qoder」
 *（产品名，不是模型名），**无法用对话验证它究竟是不是 V4.1-Flash**。
 * ⇒ 这条映射的依据是**用户的要求 + 展示名**，不是我的推断。
 */
export const CANONICAL_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  lobsterai: { 'deepseek-flash': 'deepseek-v4-1-flash' },

  // ## 用户要求：所有 DeepSeek 的 Flash 变体都归到 `DeepSeek-V4.1-Flash`
  //
  // ⚠️ 补丁的键用的是**原始的 `realId`**（`canonicalKeyFor` 先查补丁、后归一化），
  // 故这里写原始 id，不是 `normalizeModelKey` 处理后的形态。
  //
  // | 渠道 | 原始 realId | 不经补丁会得到的键 | 原因 |
  // |---|---|---|---|
  // | raccoon | `sn-deepseek-v4-1-flash-1017` | `deepseek-v4-1-flash-1017` | 末尾 `-1017` 是**渠道版本号**，字面推导救不回来 |
  raccoon: {
    'sn-deepseek-v4-1-flash-1017': 'deepseek-v4-1-flash',
    // ⚠️ 同时登记去掉 `sn-` 的形态：`normalizeModelKey` 会剥 `sn-`，
    // 而补丁查的是**原值**，两种写法在目录里都见过。
    'deepseek-v4-1-flash-1017': 'deepseek-v4-1-flash',
  },

  // qoder 走 `name` 通道（见 `PRIMARY_CHANNEL`），故键是**原始 realId** `dfmodel`
  // （补丁在归一化之前查）。它的展示名 `DeepSeek-Flash` 归一后是 `deepseek-flash`，
  // 与 `deepseek-v4-1-flash` 是两个键 ⇒ 必须在这里并掉。
  qoder: { dfmodel: 'deepseek-v4-1-flash' },
}

/**
 * 规范键 → 官方展示名。
 *
 * 未登记的键**回落到键本身**（不编造名字）。条目取自参考实现并已用线上
 * 目录核对。
 */
export const CANONICAL_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-flash-official': 'DeepSeek V4 Flash Official',
  'glm-5-3': 'GLM-5.3',
  'glm-5-3-flash': 'GLM-5.3-Flash',
  'glm-5-3-flashx': 'GLM-5.3-FlashX',
  'glm-5-2': 'GLM-5.2',
  'glm-5-1': 'GLM-5.1',
  'glm-5': 'GLM-5',
  'glm-5v-turbo': 'GLM-5V-Turbo',
  'kimi-k3': 'Kimi K3',
  'kimi-k3-1': 'Kimi K3.1',
  'kimi-k2-8-preview': 'Kimi K2.8 Preview',
  'kimi-k2-7': 'Kimi K2.7',
  'kimi-k2-7-code': 'Kimi K2.7 Code',
  'kimi-k2-7-code-highspeed': 'Kimi K2.7 Code HighSpeed',
  'kimi-k2-6': 'Kimi K2.6',
  'kimi-k2-5': 'Kimi K2.5',
  'minimax-m3': 'MiniMax M3',
  'minimax-m3-1-flash-preview': 'MiniMax M3.1 Flash Preview',
  'minimax-m2-7': 'MiniMax M2.7',
  'minimax-m2-7-highspeed': 'MiniMax M2.7 HighSpeed',
  'qwen-3-8-max': 'Qwen 3.8 Max',
  'qwen3-8-flash': 'Qwen3.8 Flash',
  'qwen3-8-max': 'Qwen3.8 Max',
  'qwen-3-7-plus': 'Qwen 3.7 Plus',
  'qwen3-7-max': 'Qwen3.7 Max',
  'qwen3-7-plus': 'Qwen3.7 Plus',
  'qwen3-7-flash': 'Qwen3.7 Flash',
  'qwen3-6-plus': 'Qwen3.6 Plus',
  'gemini-3-8-flash': 'Gemini 3.8 Flash',
  'gemini-3-5-flash': 'Gemini 3.5 Flash',
  'hy4-preview': 'Hy4 Preview',
  'hy4-preview-dev': 'Hy4 Preview Dev',
  'hy4-preview-x': 'Hy4 Preview X',
  'hy3': 'Hy3',
  'hy3-x': 'Hy3 X',
  'sensenova-6-8-flash': 'SenseNova 6.8 Flash',
  'sensenova-6-8-flash-lite': 'SenseNova 6.8 Flash Lite',
  'mimo-v2-6-flash': 'MiMo V2.6 Flash',
  'mimo-v2-5': 'MiMo V2.5',
  'spark-x': 'Spark X',
}

/**
 * 每家的**主推导通道**。
 *
 * ⚠️ 绝大多数家按 `id` 推导即可；只有 `id` 是无意义代号的家才用 `name`。
 * **不做投票**：同一家的结果必须恒定。
 *
 * qoder 的线上 id 是 `qfmodel`（无意义），故走 name。
 */
const PRIMARY_CHANNEL: Readonly<Record<string, 'id' | 'name'>> = {
  qoder: 'name',
}

/** 规范键的推导结果。 */
export interface CanonicalKey {
  key: string
  /** 命中方式（排障用：能回答「它凭什么被归到这里」）。 */
  via: 'patch' | 'name' | 'id'
}

/**
 * 把一个渠道的 `realId` / `realName` 归到**规范键**。
 *
 * 顺序不可改（见文件头说明）。返回 `undefined` = **不参与聚合**
 *（通用名，见 {@link EXCLUDED_ALIASES}）。
 */
export function canonicalKeyFor(
  provider: string,
  realId: string,
  realName: string,
): CanonicalKey | undefined {
  const idKey = normalizeModelKey(realId)
  if (EXCLUDED_ALIASES.has(realId) || EXCLUDED_ALIASES.has(idKey)) return undefined

  // ① 显式补丁
  //
  // ⚠️ **必须 `Object.hasOwn`**：`CANONICAL_OVERRIDES` 是普通对象字面量，
  // 用 `patch[realId]` 直接取，`realId === 'constructor'` 会拿到 `Object`
  // 构造函数（真值）⇒ 规范键变成 `function Object() {...}`，
  // 而展示名那一侧同样会炸。这不是假想：模型 id 是外部输入。
  const patch = Object.hasOwn(CANONICAL_OVERRIDES, provider)
    ? CANONICAL_OVERRIDES[provider]
    : undefined
  if (patch !== undefined && Object.hasOwn(patch, realId)) {
    const patched = patch[realId] as string
    if (EXCLUDED_ALIASES.has(patched)) return undefined
    return { key: patched, via: 'patch' }
  }

  // ② / ③ 按主通道推导
  const channel = Object.hasOwn(PRIMARY_CHANNEL, provider) ? PRIMARY_CHANNEL[provider] : 'id'
  const nameKey = normalizeNameKey(realName)
  if (channel === 'name' && nameKey.length > 0 && nameKey !== idKey) {
    return EXCLUDED_ALIASES.has(nameKey) ? undefined : { key: nameKey, via: 'name' }
  }
  if (idKey.length === 0) return undefined
  return EXCLUDED_ALIASES.has(idKey) ? undefined : { key: idKey, via: 'id' }
}

/**
 * 规范键 → 展示名。
 *
 * ⚠️ 同样必须 `Object.hasOwn`：`CANONICAL_NAMES['constructor']` 用直接取值
 * 会拿到 `Object` 构造函数 ⇒ 展示名成了个函数 ⇒ 目录校验失败，
 * 整份聚合目录会被判无效而**全部消失**。
 */
export function canonicalDisplayName(key: string): string {
  if (typeof key !== 'string' || key.length === 0) return ''
  return Object.hasOwn(CANONICAL_NAMES, key) ? (CANONICAL_NAMES[key] as string) : key
}

/**
 * 从渠道给的展示名里解析**价格倍率**（数字越小越便宜）。
 *
 * 渠道会把倍率拼进展示名，如 `GLM-5.3-Flash · x0.8`、`MiniMax M3 · x4.0`，
 * 促销时还有 `x1.0 → x0.5` 这种箭头形态。
 *
 * - 含「免费」→ `0`；
 * - 命中倍率 → 该数字（有箭头时取**箭头后**的值，那才是实际计费倍率）；
 * - 都没有 → `Number.POSITIVE_INFINITY`（**未知**，排在已知价格之后）。
 *
 * ⚠️ **分隔符 `·` 是必需的**：不要求它的话，模型名里出现的数字
 *（如 `kimi-k2.5`）会被误读成倍率。
 */
/**
 * **裸模型名的别名表** → 聚合规范名。
 *
 * ## 为什么需要它（用户要求）
 *
 * 「把 DeepSeek-V4.1-Flash 路由到 buddy 改为路由到自动的 DeepSeek」。
 *
 * 裸名（无 `provider/` 前缀）现在一律回落到默认供应商 `buddy`。
 * 实测后果：客户端写 `DeepSeek-V4.1-Flash`（**官方拼写、带大写与点**）时，
 * 这个名字被**原样**送给 buddy，而 buddy 的真实 id 是小写
 * `deepseek-v4.1-flash` ⇒ 上游回
 * `model [DeepSeek-V4.1-Flash] service info not found`
 * ⇒ 用户得到一个**看着像「模型不存在」的错误**，而其实是大小写/拼写没归一。
 *
 * ⇒ 这张表把「用户在别处见过的官方拼写」直接映射到**聚合规范名**，
 * 于是同一个请求会被聚合路由接管：自动挑一个**积分最快作废**的渠道，
 * 而不是死死绑在某一家。
 *
 * ## ⚠️ 两条纪律
 *
 * 1. **只映射「已知的官方拼写」**，不做模糊匹配 —— 拼错的名字必须**照旧报错**
 *    （报错里会列出可用键），不能让用户以为「随便写写就能通」。
 * 2. 键全部用小写存储、查表时把输入也转小写 ⇒
 *    `DeepSeek-V4.1-Flash` / `deepseek-v4.1-flash` / `DEEPSEEK-V4.1-FLASH`
 *    都能命中同一条。
 */
export const BARE_MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  // 官方拼写（带大写与点）→ 聚合规范名
  ['deepseek-v4.1-flash', 'deepseek-v4-1-flash'],
  ['deepseek v4.1 flash', 'deepseek-v4-1-flash'],
  ['glm-5.3-flash', 'glm-5-3-flash'],
  ['glm 5.3 flash', 'glm-5-3-flash'],
])

/**
 * 查裸名别名 → 聚合规范名。
 *
 * ⚠️ 大小写与空格都归一后再查（见 `BARE_MODEL_ALIASES` 的纪律 2）。
 * 查不到返回 `undefined` —— 调用方据此走**原有**的回落逻辑，
 * 不要因为「没命中」就改变行为。
 */
export function aggregateAliasForBareModel(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*·.*$/, '')
  return BARE_MODEL_ALIASES.get(key)
}

/**
 * 解析上游**真实下发**的 `credits` 字段（如 `"x0.21"`）→ 倍率数字。
 *
 * ## 为什么需要它（我踩过的坑）
 *
 * 上游 `/v3/config` 的每个模型条目本来就有 `credits`（如实测的
 * `"x0.21"` / `"x0.65"`），而我**不知道它存在**，于是用
 * `priceFactorFromName` 从**模型名**里正则抠 `· x0.05` 后缀 ——
 * 结果 46 个模型里 **39 个抠不到**（名字里根本没写倍率），
 * 面板显示成一片「未标注」。
 *
 * ⚠️ **教训：先找上游有没有现成字段，再用启发式解析名字。**
 * 名字是给人看的，字段才是给程序用的。
 *
 * ## 接受的形态（都实测/文献见过）
 *
 * - `"x0.21"` / `"×0.21"` / `"X0.21"` —— 带倍率符号
 * - `"0.21"` —— 纯数字
 * - `0.21`（数字）—— 上游偶尔会直接给数字
 * - `"free"` / `"免费"` —— 免费 ⇒ 0
 *
 * ⚠️ 解析不出来返回 `undefined`（**不是** Infinity、也不是 0）：
 * 「该家没给倍率」与「免费」是两件完全不同的事，不能混。
 */
export function parseCreditsFactor(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const t = raw.trim().toLowerCase()
  if (t === '') return undefined
  if (t.includes('免费') || t === 'free') return 0
  // 去掉倍率符号与前后空白；允许 `x0.21` / `× 0.21`
  const m = /^[x×]?\s*(\d+(?:\.\d+)?)$/.exec(t)
  if (m === null || m[1] === undefined) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

export function priceFactorFromName(name: string): number {
  if (typeof name !== 'string') return Number.POSITIVE_INFINITY
  if (name.includes('免费')) return 0
  const m = /·\s*[×x]?\s*(\d+(?:\.\d+)?)(?:\s*[→>]\s*[×x]?\s*(\d+(?:\.\d+)?))?\s*$/i.exec(name.trim())
  if (m === null) return Number.POSITIVE_INFINITY
  const picked = m[2] ?? m[1]
  const n = Number(picked)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}
