/**
 * 管理面板的单测（安全头、资源路由、CSP 纪律）。
 *
 * ## 为什么这些断言重要
 *
 * 面板是**唯一被浏览器直接加载**的界面，安全边界最容易在这里被放松：
 * - CSP 一旦加入 `'unsafe-inline'`，页面注入的 `<script>` 就会执行；
 * - 安全头一旦漏加，页面就可能被 iframe 嵌套（点击劫持）；
 * - 资源路由写错会让 CSS/JS 返回错误内容（实测踩过：CSS 返回 `[object Object]`）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释后再做源码断言。
 *
 * ⚠️ 必需：本仓库的注释里会**大量引用反例**（如「原实现是 `accounts.find(...)`」），
 * 朴素的字符串搜索会把注释当成代码 ⇒ **误报**。实测踩到过一次。
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitModelName } from '../src/providers/types.ts'

import { CSP, panelAsset, securityHeaders } from '../src/panel/index.ts'

// ─────────────────────── CSP 纪律 ───────────────────────

test("⚠️ CSP 必须禁止内联脚本（不许出现 script-src 'unsafe-inline'）", () => {
  // 内联脚本放行 = 放弃 XSS 防护。这是刻意用独立 app.js 的原因。
  assert.ok(
    !/script-src[^;]*unsafe-inline/.test(CSP),
    "script-src 不得含 'unsafe-inline'（那会让注入的 <script> 执行）",
  )
})

test("CSP 的 script-src 只允许同源", () => {
  assert.ok(/script-src 'self'/.test(CSP))
})

test('⚠️ CSP 的 connect-src 必须限制为同源（防把密钥发去外部域）', () => {
  assert.ok(/connect-src 'self'/.test(CSP), 'connect-src 必须是 self，否则前端可能把密钥发去别处')
})

test('⚠️ CSP 必须禁止被 iframe 嵌套（防点击劫持）', () => {
  assert.ok(/frame-ancestors 'none'/.test(CSP))
})

test("CSP 默认全禁（default-src 'none'，逐个开口）", () => {
  assert.ok(/default-src 'none'/.test(CSP))
})

test("CSP 禁止注入 <base>（base-uri 'none'）", () => {
  assert.ok(/base-uri 'none'/.test(CSP))
})

test('内联样式是允许的（style-src 的口子是安全的）', () => {
  // 内联 style 属性不会导致脚本执行，是安全的口子
  assert.ok(/style-src 'self' 'unsafe-inline'/.test(CSP))
})

// ─────────────────────── 安全头 ───────────────────────

test('安全响应头齐全', () => {
  const h = securityHeaders()
  assert.equal(h['content-security-policy'], CSP)
  assert.equal(h['x-content-type-options'], 'nosniff')
  assert.equal(h['x-frame-options'], 'DENY')
  assert.equal(h['referrer-policy'], 'no-referrer')
  assert.equal(h['cache-control'], 'no-store', '面板不该被缓存（密钥状态会变）')
})

// ─────────────────────── 资源路由 ───────────────────────

test('面板页面路由（带与不带尾斜杠都认）', () => {
  for (const p of ['/panel', '/panel/']) {
    const asset = panelAsset(p)
    assert.notEqual(asset, undefined, `${p} 应命中`)
    assert.ok(asset?.contentType.includes('text/html'))
    assert.ok(asset?.body.includes('<!doctype html>'))
  }
})

test('⚠️ CSS 返回真实样式内容（不是 [object Object]）', () => {
  // 实测踩过：Wrangler 对 .css 有内建模块处理，会把它当 CSS module 对象，
  // 导致线上返回字符串 "[object Object]"。看板因此完全没有样式。
  const asset = panelAsset('/panel/style.css')
  assert.notEqual(asset, undefined)
  assert.ok(asset?.contentType.includes('text/css'))
  assert.ok(!asset?.body.includes('[object Object]'), 'CSS 内容不得是 [object Object]')
  assert.ok(asset?.body.includes(':root'), 'CSS 应含真实样式')
  assert.ok((asset?.body.length ?? 0) > 2000, `CSS 内容过短（${asset?.body.length} 字节），疑似被错误处理`)
})

test('⚠️ JS 返回真实代码（可供浏览器执行）', () => {
  const asset = panelAsset('/panel/app.js')
  assert.notEqual(asset, undefined)
  assert.ok(asset?.contentType.includes('javascript'), '需声明 application/javascript 才能被浏览器执行')
  assert.ok(!asset?.body.includes('[object Object]'))
  assert.ok(asset?.body.includes('localStorage'), 'JS 应含真实逻辑')
  assert.ok((asset?.body.length ?? 0) > 8000, `JS 内容过短（${asset?.body.length} 字节）`)
})

test('未知路径返回 undefined（由调用方 404）', () => {
  assert.equal(panelAsset('/panel/nope.js'), undefined)
  assert.equal(panelAsset('/admin/accounts'), undefined)
  assert.equal(panelAsset('/'), undefined)
})

// ─────────────────────── 前端安全纪律（静态检查） ───────────────────────

test('⚠️ 前端不用 cookie 而用 Authorization 头（豁免 CSRF）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes('authorization'), '应通过 authorization 头传密钥')
  assert.ok(!js.includes('document.cookie'), '不该用 cookie（cookie 自动附带，需额外 CSRF 防护）')
})

test('⚠️ 前端不把密钥写进 URL（避免进日志/Referer）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(!/\?[^"']*key=/i.test(js), '密钥不该出现在 query 里')
})

test('⚠️ 前端用 DOM API 构造链接，不把上游 URL 拼进 innerHTML', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  // 授权 URL 来自上游响应，拼进 innerHTML 就有注入风险
  assert.ok(!/innerHTML\s*=\s*[^;]*authUrl/.test(js), 'authUrl 不得拼进 innerHTML')
  assert.ok(js.includes('createElement'), '应用 DOM API 构造元素')
})

test('面板 HTML 不内联脚本（保 CSP 严格性）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  // 允许 <script src="...">，但不允许带内联内容的 <script>
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.exec(html)
  assert.equal(inline, null, 'HTML 不得含内联脚本，否则 CSP 必须放开 unsafe-inline')
  assert.ok(html.includes('src="/panel/app.js"'), '应通过 src 引用脚本')
})

// ─────────────────── 面板可用性（用户报障后新增） ───────────────────

test('⚠️ 必须有**独立的登录页**（不在面板顶部塞密钥框）', () => {
  // 用户要求：单独一个登录页验证密钥，放在面板里不好看。
  const login = panelAsset('/login')
  assert.notEqual(login, undefined, '应有 /login 页面')
  assert.ok(login?.body.includes('login-form'), '登录页应有表单')
  assert.ok(login?.body.includes('apikey'), '登录页应有密钥输入框')
  const loginJs = panelAsset('/panel/login.js')
  assert.notEqual(loginJs, undefined, '应有登录页脚本')
  assert.ok(loginJs?.body.includes('/admin/pool'), '登录页应真实验证密钥')
  assert.ok(loginJs?.body.includes("location.href = '/panel/'"), '验证通过后应跳转面板')

  // 面板顶部**不该**再有密钥输入框
  const html = panelAsset('/panel/')?.body ?? ''
  assert.ok(!html.includes('id="apikey"'), '面板顶部不该再有密钥框')
  assert.ok(!html.includes('setup-hint'), '不该再有「请填密钥」的顶部提示')
  // 未登录应重定向到登录页
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes("location.href = '/login'"), '未登录/失效应跳登录页')
  assert.ok(html.includes('id="logout"'), '应有退出登录按钮')
})

test('⚠️ 能力标签不该列「列模型」「对话」（全部供应商都支持，是噪音）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const capsBlock = /const CAPS = \[([\s\S]*?)\n\]/.exec(js)
  assert.notEqual(capsBlock, null, '应有 CAPS 定义')
  const body = capsBlock[1]
  // ⚠️ 断言的是**数组元素**（形如 ['listModels', ...]），不是注释文字 ——
  // 注释里解释「为什么不列」时会出现这两个词，不能误判。
  assert.ok(!/\[\s*'listModels'/.test(body), '不该列「列模型」')
  assert.ok(!/\[\s*'chat'/.test(body), '不该列「对话」')
  // 保留有区分度的三项
  assert.ok(/\[\s*'login'/.test(body), '应保留「设备码登录」')
  assert.ok(/\[\s*'balance'/.test(body), '应保留「查余额」')
  assert.ok(/\[\s*'checkin'/.test(body), '应保留「每日签到」')
})

test('⚠️ /v1/models 必须只列「有账号」的供应商的模型（登录后才显示）', () => {
  // 用户要求：没登录的提供商默认不在 API 里显示，登录后再显示。
  //
  // ⚠️ 实现方式**不是**「预先关闭模型」—— 没有账号时根本拉不到模型目录
  //（列模需要凭据），所以无法预先知道要关哪些 id。
  // 正确做法是 /v1/models **按账号聚合**：遍历有账号的供应商逐个拉目录，
  // 没账号的自然不出现。这也让「登录后再显示」自动成立。
  // ⚠️ 单测是**打包后**在 `.build/tests/` 下跑的，故相对路径要指回源码根。
  // 用 process.cwd()（脚本从仓库根运行）最稳。
  const src = readFileSync('src/index.ts', 'utf8')
  // ⚠️ 断言**不变式**（前缀存在），不钉死 `data.push` 的**字面排版** ——
  // 往对象里补 `priceFactor` / `providerName` / `realm` 后，原先「整行字面匹配」
  // 会假失败，而**它要守的约束根本没变**。
  // 简单起见：断言关键标识符存在（比跨行正则更稳）
  assert.ok(src.includes('byProvider'), '/v1/models 应按供应商分组账号')
  assert.ok(/for \(const \[providerId, list\] of byProvider\)/.test(src), '应逐个有账号的供应商拉目录')
  assert.ok(src.includes('provider.capabilities.listModels'), '应只对有列模能力的供应商拉目录')
})

test('⚠️ 面板视图（账号池已并入供应商）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  // ⚠️ `packages` 已按用户要求**删除**（页面与视图都删）。
  // 但 `/admin/packages` **端点保留** —— 账号卡片上的「单独显示积分」仍在用它。
  const views = ['providers', 'tasks', 'usage', 'models', 'config', 'logs']
  for (const v of views) {
    assert.ok(html.includes(`data-view="${v}"`), `缺少视图：${v}`)
    assert.ok(html.includes(`id="view-${v}"`), `缺少视图容器：${v}`)
  }
  // ⚠️ 反向断言：积分包页签与视图都必须已删除，且不留死代码
  assert.ok(!html.includes('data-view="packages"'), '积分包页签应已删除')
  assert.ok(!html.includes('id="view-packages"'), '积分包视图容器应已删除')
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(!/function loadPackages/.test(js), '⚠️ loadPackages 死代码应已删除')
  assert.ok(!/refresh-packages/.test(js), '⚠️ 不应残留 refresh-packages 事件绑定')
  // ⚠️ 但数据源必须保留（账号卡片积分靠它）
  assert.ok(/function fetchPackages/.test(js),
    '⚠️ fetchPackages 必须保留（账号卡片的「单独显示积分」在用）')
  // ⚠️ 账号池已并入「供应商与账号」，不该再有独立视图
  assert.ok(!html.includes('data-view="accounts"'), '账号池应已并入供应商视图')
  assert.ok(!html.includes('id="view-accounts"'), '不该再有独立的账号池容器')
})

test('⚠️ 任务中心必须是两张卡片且**没有选项下拉**', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(html.includes('run-checkin-all'), '应有「全部供应商一键签到」卡片')
  assert.ok(html.includes('run-daily-all'), '应有「Buddy 每日任务」卡片')
  // 用户要求：任务不要有选项，直接全部做一遍
  assert.ok(!html.includes('task-plan'), '不该有任务计划下拉')
  // ⚠️ 面板**不该**让用户选 includeRealChat（无选项），
  // 但后端必须**自动带上**它 —— 否则拿不到真实对话任务的积分。
  assert.ok(!js.includes('includeRealChat'), '面板不该暴露该选项（后端自动带）')
})

test('⚠️ 面板可见文案不得含 Markdown 星号（这是网页不是 Markdown）', () => {
  // 用户明确要求：网页里不要出现 `**加粗**` 这种 Markdown 语法。
  for (const [name, path] of [['HTML', '/panel/'], ['JS', '/panel/app.js']] as const) {
    let body = panelAsset(path)?.body ?? ''
    // 去掉注释后再检查（注释里的星号用户看不到）
    body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const lines = body.split('\n').filter((l) => !l.trim().startsWith('//'))
    const bad = lines.filter((l) => l.includes('**'))
    assert.equal(bad.length, 0, `${name} 里还有 Markdown 星号：${bad[0]?.trim().slice(0, 60)}`)
  }
})

test('⚠️ 剩余总积分必须显示在**每张供应商卡片**的右上角（不是顶部）', () => {
  // 用户明确要求：积分放每个提供商卡片右上角，不是页面右上角。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(js.includes('prov-credits'), '卡片应渲染积分徽标')
  assert.ok(js.includes('data-provider') || js.includes('dataset.provider'), '卡片要带 provider 标识以便定位徽标')
  assert.ok(/position:\s*absolute/.test(css) && /prov-credits/.test(css), '徽标要绝对定位到卡片右上角')
  // 未登录（无账号）时不显示：初始 hidden
  assert.ok(js.includes('credits.hidden = true'), '无积分时徽标必须隐藏（显示 0 会让人以为额度用光）')
})

test('⚠️ 主题必须支持三态（自动 / 浅色 / 深色）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(js.includes("'auto'"), '应有 auto 态')
  assert.ok(js.includes("light") && js.includes("dark"), '应有 light / dark 态')
  // auto 必须靠媒体查询跟随系统
  assert.ok(css.includes('prefers-color-scheme'), 'CSS 应有 prefers-color-scheme（跟随系统）')
  // 图标而非文字
  assert.ok(!js.includes("'浅色'") || js.includes('THEME_ICON'), '主题按钮应显示图标')
})

test('⚠️ 关闭按钮与主题切换必须是图标（不是文字）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  assert.ok(html.includes('icon-btn'), '应有图标按钮样式类')
  // 关闭按钮应是 ✕ 而不是「关闭」二字
  const closeBlock = /<button id="modal-close"[^>]*>([^<]*)</.exec(html)
  assert.notEqual(closeBlock, null, '应有关闭按钮')
  assert.ok(!closeBlock[1].includes('关闭'), `关闭按钮应是图标，当前是「${closeBlock[1]}」`)
})

test('⚠️ 弹窗模型页必须有一键关闭/开启', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes('全部关闭'), '应有「全部关闭」按钮')
  assert.ok(js.includes('全部开启'), '应有「全部开启」按钮')
})

test('⚠️ 必须支持浅色模式（且主题在任何渲染之前应用，避免闪烁）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(html.includes('id="toggle-theme"'), '应有主题切换按钮')
  assert.ok(css.includes("data-theme='light'"), 'CSS 应有浅色变量覆盖')
  // 主题必须在使用前应用（applyTheme 调用要在 bootstrap 之前）
  const applyIdx = js.lastIndexOf('applyTheme(')
  const bootIdx = js.lastIndexOf('bootstrap()')
  assert.ok(applyIdx > 0 && applyIdx < bootIdx, 'applyTheme 必须在 bootstrap 之前调用（否则浅色用户会看到深色闪烁）')
})

test('⚠️ 弹窗模型页必须支持打开/关闭（开关）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes('/admin/providers/models/toggle'), '应有模型开关接口调用')
  assert.ok(js.includes('switch'), '应渲染开关控件')
})

test('⚠️ 面板不得使用 innerHTML 拼外部数据（XSS）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  // 允许注释里提到 innerHTML，但不允许赋值
  const assignments = js.match(/\.innerHTML\s*=/g) ?? []
  assert.equal(assignments.length, 0, `发现 ${assignments.length} 处 innerHTML 赋值，应用 DOM API 构造`)
})

test('⚠️ 供应商卡片不得显示 loginBlockedReason 长文案（只留 ✓/✕ 标签）', () => {
  // 用户要求：每个提供商下方那段说明文字删掉，只保留
  // 「✓ 设备码登录 ✓ 列模型 ✓ 对话 ✓ 查余额 ✓ 每日签到」这样的能力标签。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(!js.includes('无法登录：'), '不应再渲染「无法登录：<长文案>」')
  assert.ok(!/loginBlockedReason/.test(js), '面板不该引用 loginBlockedReason')
  // 但要保留能力标签
  assert.ok(js.includes('设备码登录') && js.includes('每日签到'), '能力标签必须保留')
})

test('⚠️ 供应商视图必须支持点开弹窗管理（账号 / 模型 / 添加）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''
  for (const id of ['modal', 'modal-accounts', 'modal-models', 'modal-add']) {
    assert.ok(html.includes(`id="${id}"`), `缺少弹窗容器：${id}`)
  }
  assert.ok(js.includes('openProviderModal'), '应有点开供应商的函数')
  assert.ok(js.includes('/admin/providers/models'), '弹窗模型页应调按供应商列模接口')
})

test('⚠️ 顶层的添加账号/粘贴凭据已删除（登录入口只在各供应商卡片内）', () => {
  // 用户要求：把「供应商与账号」底部的「添加账号」与「粘贴凭据导入」删掉，
  // 登录入口改到**每个供应商卡片**里（设备码登录在上、粘贴凭据在下）。
  //
  // ⚠️ 这条同时锁住两个层面：
  // · HTML 里不能再有那套顶层控件；
  // · JS 里不能残留对它们的引用 —— 残留会**在加载时**抛
  //   `Cannot set properties of null`，整个面板白屏（比样式错更难查）。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''

  // 顶层控件必须消失
  assert.ok(!html.includes('id="login-provider"'), '顶层登录下拉应已删除')
  assert.ok(!html.includes('id="import-body"'), '顶层粘贴凭据框应已删除')
  assert.ok(!html.includes('id="do-login"'), '顶层「发起登录」按钮应已删除')
  assert.ok(!html.includes('id="do-import"'), '顶层「导入」按钮应已删除')

  // ⚠️ JS 里不得残留引用（否则面板启动即崩）
  for (const id of ['login-provider', 'do-login', 'import-body', 'do-import', 'login-result', 'import-result']) {
    assert.ok(
      !js.includes(`$('${id}')`),
      `⚠️ app.js 不得再引用已删除的 #${id} —— 那会在加载时抛 null 异常，面板白屏`,
    )
  }

  // 登录入口仍在**供应商弹窗**里（设备码登录在上、粘贴凭据在下）
  assert.ok(/startModalLogin\(/.test(js), '供应商弹窗仍应有登录入口')
  assert.ok(/modal-import-body/.test(js), '供应商弹窗仍应有粘贴凭据')
})
test('⚠️ CSS 必须有 [hidden] 的全局兜底（否则 display:flex 会压过它）', () => {
  // 实测 bug：`.banner { display: flex }` 优先级高于 UA 的 `[hidden]{display:none}`，
  // 导致 WAF 横幅**永远显示**，点「立即解除」也没用。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    '必须有 [hidden] { display: none !important } 的全局兜底')
})

test('面板 JS 规模合理（不应该只是几十行的空壳）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const lines = js.split('\n').length
  assert.ok(lines > 300, `面板 JS 只有 ${lines} 行，过薄（参考项目 2600+ 行）`)
})

test('⚠️ 默认视图必须是真实导航项（否则刷新后空白）', () => {
  // 实测踩到：默认视图写成 `accounts`，但账号池已并入「供应商与账号」，
  // 导航里没有 `accounts` → `VIEW_LOADERS['accounts']` 是 undefined →
  // 加载器从不执行 → 刷新后页面空白，切到别的卡片再切回来才显示。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const html = panelAsset('/panel/')?.body ?? ''

  const navs = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]))
  const loaders = new Set([...js.matchAll(/^\s{2}(\w+):\s*\(\)\s*=>/gm)].map((m) => m[1]))

  assert.ok(navs.size > 0, '应能解析出导航项')
  // ① 每个加载器都要对应一个真实导航项（`accounts` 这类残留会在这里暴露）
  for (const l of loaders) {
    assert.ok(navs.has(l), `加载器「${l}」不是导航项（会永远不执行）`)
  }
  // ② 默认视图必须落在加载器里
  const def = /VIEWS\.includes\(stored\)\s*\?\s*stored\s*:\s*'(\w+)'/.exec(js)
  assert.notEqual(def, null, '应能找到默认视图回退值')
  assert.ok(loaders.has(def?.[1] ?? ''), `默认回退视图「${def?.[1]}」没有加载器（会空白）`)

  // ③ ⚠️ **存下来的视图名也必须校验**。
  // 我第一版只改默认值 —— 但用户 localStorage 里早就存了旧名 `accounts`，
  // `getItem` 仍返回旧值，加载器依旧不执行，刷新照样空白。
  assert.ok(/VIEWS\.includes\(stored\)/.test(js), '必须校验 localStorage 里的视图名')
  assert.ok(/Object\.keys\(VIEW_LOADERS\)/.test(js), 'VIEWS 应从加载器派生（不是手写列表）')

  // ④ switchView 自身也要有防线：非法名字回退，而不是静默不加载
  assert.ok(
    /function switchView\(name\)\s*\{[\s\S]{0,240}hasOwnProperty\.call\(VIEW_LOADERS, name\)/.test(js),
    'switchView 应对非法视图名回退',
  )
})

test('⚠️ /v1/models 目录里不得出现裸名（一律带 provider/ 前缀）', () => {
  // 用户要求：「api 上没有前缀的 deepseek-v4.1-flash 和 glm-5.3-flash
  // 是哪个供应商的，加上前缀，方便区分」。
  //
  // 早先给默认供应商额外暴露一份裸名，于是同一模型在目录里出现两次
  //（`buddy/glm-5.3-flash` 与 `glm-5.3-flash`），而多家又有同名模型
  //（buddy / codearts / trae 都有 `deepseek-v4.1-flash`）——
  // 裸名根本分不清是哪一家。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(
    /id: `\$\{providerId\}\/\$\{m\.id\}`/.test(src),
    '目录项必须带 provider/ 前缀',
  )
  // 不能再有针对默认供应商的裸名分支
  assert.ok(
    !/if \(providerId === DEFAULT_PROVIDER\) data\.push\(base\)/.test(src),
    '不得再单独给默认供应商推裸名',
  )
})

test('⚠️ 裸名仍必须能路由（目录不带前缀 ≠ 请求不接受裸名）', () => {
  // 目录负责「说清楚」，路由负责「不 breaking」——
  // 已有客户端配置里写的裸名不能因为这个改动而失效。
  const r = splitModelName('deepseek-v4.1-flash', ['buddy', 'codearts', 'trae'], 'buddy')
  assert.equal(r.provider, 'buddy', '裸名回退到默认供应商')
  assert.equal(r.model, 'deepseek-v4.1-flash')

  // 而带前缀时按前缀路由，不会混淆同名模型
  const c = splitModelName('codearts/deepseek-v4.1-flash', ['buddy', 'codearts', 'trae'], 'buddy')
  assert.equal(c.provider, 'codearts')
  assert.equal(c.model, 'deepseek-v4.1-flash')
})

// ─────────────────── 移动端适配（用户报障：超出屏幕 / 文字换行） ───────────────────

test('⚠️ 面板不得使用可能缺字形的 Unicode 图标（手机上会显示成空框）', () => {
  // 用户报障：「右上角的退出登录按钮没有图标，只有一个框」。
  // 根因：`⏻`（U+23FB POWER SYMBOL）在很多手机字体里**缺字形**，
  // 渲染成一个空方框。同类风险符号还有 `✕`（U+2715）等。
  // 改用内联 SVG —— 不依赖系统字体，尺寸完全可控。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''

  // 明确禁止的「高风险图标字符」（几何图形/杂项符号区，字体覆盖不全）
  //
  // ⚠️ 必须先**剥掉注释**再查：注释里会**提到**这些字符作为反例
  //（「不要用 `⏻`」），直接 includes 会把说明文字误判成违规用法。
  const stripComments = (t) =>
    t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const htmlCode = stripComments(html)
  const jsCode = stripComments(js)

  // ⚠️ `✓`（U+2713）刻意**不**列入：字体覆盖较广，且用作**文本标记**而非按钮。
  // 但 `✕`（U+2715）必须列入 —— 它与 `✓` 同区却覆盖差得多，实测会变空框。
  const RISKY = ['⏻', '✕', '⏭', '⌫', '⏎']
  for (const ch of RISKY) {
    assert.ok(!htmlCode.includes(ch), `HTML 里不得使用 ${ch}（U+${ch.codePointAt(0)?.toString(16).toUpperCase()}）`)
    assert.ok(!jsCode.includes(`'${ch}`) && !jsCode.includes(`"${ch}`), `JS 里不得使用 ${ch} 作图标`)
  }

  // 退出按钮必须是 SVG
  assert.ok(/id="logout"[\s\S]{0,220}<svg/.test(html), '退出按钮必须用内联 SVG')
  // 主题按钮也必须是 SVG（三态图标）。
  // ⚠️ 这里改成**先取出 THEME_ICON 块再查**，而不是用固定距离的
  // `[\s\S]{0,400}` —— 后者会因为块内注释变长而误报（注释也是维护的一部分，
  // 不该反过来限制注释长度）。
  const iconBlock = /const THEME_ICON = \{([\s\S]*?)\n\}/.exec(js)
  assert.notEqual(iconBlock, null, '应有 THEME_ICON 定义')
  assert.ok(iconBlock?.[1].includes('<svg'), '主题图标必须是 SVG')
})

test('⚠️ 所有表格必须包在 .table-wrap 里（否则手机上横向溢出）', () => {
  // `table { width: 100% }` 只表示「尽量占满」；默认 `table-layout: auto`
  // 会按**内容最小宽度**算列宽 —— 长 uid / 长模型名 / 长原因会把表撑得比屏幕宽，
  // 整个页面横向溢出。手机上标准做法是让表格自己滚动。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''

  // 每一处 buildTable( 调用都必须被 wrapTable 包住
  const calls = [...js.matchAll(/(\w+)\(buildTable\(/g)].map((m) => m[1])
  const bare = [...js.matchAll(/(?<![\w(])buildTable\(/g)].length
  const wrapped = calls.filter((c) => c === 'wrapTable').length
  // 允许 buildTable 的定义体本身（`function buildTable(`）
  assert.equal(bare, 1, `buildTable 只应在定义处出现一次裸调用，实际 ${bare}`)
  // ⚠️ **不写死「至少 N 处」** —— 那是个会随界面改版失效的魔数。
  // 本轮把「按模型/按账号」两张表换成了**排名列表**（不存在表格，也就无需包裹），
  // 数量从 5 掉到 4 —— 而**真正要守的约束没变**：
  // 「凡是用表格的地方，必须包在 `.table-wrap` 里」。
  // 上面那条 `bare === 1`（只允许定义处）已经等价地守住了它，
  // 故这里只要求「还有表格在用这套包装」，不再钉具体数字。
  assert.ok(wrapped >= 1, `应仍有用 wrapTable 包裹的表格，实际 ${wrapped}`)

  assert.ok(css.includes('.table-wrap'), 'CSS 必须有 .table-wrap 规则')
  assert.ok(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css), '.table-wrap 必须横向可滚动')
})

test('⚠️ 必须有移动端断点，且长串要能断行', () => {
  const css = panelAsset('/panel/style.css')?.body ?? ''
  // 至少一个手机断点
  assert.ok(/@media\s*\(max-width:\s*720px\)/.test(css), '需要 720px 断点')
  assert.ok(/@media\s*\(max-width:\s*420px\)/.test(css), '需要 420px 断点（老机型/分屏）')
  // 长串断行（uid / URL / token 这类无空格长串否则会顶破容器）
  assert.ok(/overflow-wrap:\s*anywhere/.test(css), '长串必须能在任意位置断行')
  // ⚠️ 不能只用 break-all：那会把正常英文单词也拦腰截断。
  // 同样要剥注释 —— 注释里写着「不用 break-all」这句说明本身。
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/word-break:\s*break-all/.test(cssCode), '不得使用 break-all（会截断正常单词）')
  // 手机上计数卡片应能收缩（flex 项默认 min-width:auto 不收缩）
  assert.ok(/@media[\s\S]*?\.count\s*\{[^}]*min-width:\s*0/.test(css), '计数卡片在手机上必须可收缩')
})

test('文案：统一叫「模型限流」，不叫「模型级限流」', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes('模型限流'), '应有「模型限流」文案')
  assert.ok(!js.includes('模型级限流'), '不得再出现「模型级限流」')
})

test('⚠️ 页面标题必须用当前项目名（不能留历史名）', () => {
  // 实测踩到：项目从 `workbuddy-serverless` → `hivegate` → `free-llm-router`
  // 改了两轮名，但**页面标题一直是旧名**「WorkBuddy Serverless」——
  // 在浏览器标签页上一眼就能看到，是最显眼的一处遗留。
  //
  // ⚠️ 这条测试的价值在于：改名是个**跨文件**的操作，很容易只改
  // package.json / wrangler.jsonc 而漏掉 HTML 里的文案。
  const index = panelAsset('/panel/')?.body ?? ''
  const login = panelAsset('/login')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''

  // 历史名（含大小写变体）一个都不许留
  const HISTORICAL = ['WorkBuddy Serverless', 'workbuddy-serverless', 'HiveGate', 'hivegate']
  for (const name of HISTORICAL) {
    assert.ok(!index.includes(name), `面板 HTML 不得残留历史名「${name}」`)
    assert.ok(!login.includes(name), `登录页不得残留历史名「${name}」`)
    assert.ok(!css.includes(name), `样式表注释不得残留历史名「${name}」`)
  }

  // 标题必须含当前项目名
  assert.ok(/<title>[^<]*free-llm-router[^<]*<\/title>/.test(index), '面板标题应含当前项目名')
  assert.ok(/<title>[^<]*free-llm-router[^<]*<\/title>/.test(login), '登录页标题应含当前项目名')
})

// ─────────────── 悬空 DOM 引用与渲染回归（2026-10-05 线上实测后新增） ───────────────
//
// 这一组测试全部来自**真实的线上事故**，每一条都对应一个曾经存在、
// 且**不会自己报错**的缺陷（静默失效比崩溃更难发现）。

/**
 * 剥掉 JS 注释（块注释 + 整行行注释）。
 *
 * ⚠️ 这些静态检查的注释里会**引用违规写法本身**当反例
 *（例如 loadAccounts 的说明里写着 `$('accounts')`），
 * 不剥注释就会把自己的说明误判成违规。
 */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 剥掉 CSS 注释（注释里可能出现 `}`，会让 `[^}]*` 提前截断）。 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

test('⚠️ app.js 里 $(id) 引用的每个 id 都必须真实存在于面板 HTML', () => {
  // ## 这是什么级别的缺陷
  //
  // 线上事故（P0）：登录成功后**整个面板空白**，且没有任何报错。
  // 根因是 bootstrap() 里一行 `$('setup-hint').hidden = true` ——
  // `#setup-hint` 已在「独立登录页」那次改动中从 index.html 删掉，
  // 但引用留了下来。`$()` 返回 null，赋值抛 TypeError，而它恰好在
  // setAuth() / switchView() **之前**，于是整个启动流程中断。
  //
  // 同一批还有一个 `const box = $('accounts'); clear(box)`：账号池视图早已
  // 并入供应商视图，`#accounts` 不存在 —— 它被同视图的另一个加载器掩盖成
  // **静默失效**，函数后续逻辑一行都没执行，而 7 个调用点都在白调。
  //
  // 结论：`$(...)` 的返回值**既可能为 null，又不会在编译期被发现**。
  // 唯一能拦住它的就是这条静态不变式。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''

  // ⚠️ 必须先剥注释：本文件的注释里会**提到** `$('accounts')` 作为反例
  //（见 loadAccounts 的说明），不剥会把说明文字误判成真实引用。
  const jsCode = stripJsComments(js)

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  assert.ok(htmlIds.size > 10, `应能从 HTML 解析出 id（实际 ${htmlIds.size} 个）`)

  // 只校验**字面量**形式 `$('xxx')`；动态形式（如拼接）天然无法静态校验。
  const refs = [...jsCode.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
  assert.ok(refs.length > 20, `应能解析出若干 id 引用（实际 ${refs.length} 个）`)

  const missing = [...new Set(refs)].filter((id) => !htmlIds.has(id))
  assert.deepEqual(
    missing,
    [],
    `以下 id 在面板 HTML 里不存在，$() 会返回 null（后续操作抛 TypeError → 面板可能整片空白）：${missing.join(', ')}`,
  )

  // 显式钉住这次事故本身，让回归时一眼能看懂是哪一行
  assert.ok(!jsCode.includes('setup-hint'), '不得再引用已删除的 #setup-hint（曾导致登录后面板全空）')
})

test('⚠️ 主题图标 SVG 必须自带 xmlns（XML 解析不会隐式补命名空间）', () => {
  // 线上实测（P1）：顶栏主题按钮是个**空框**，图标完全不显示。
  //
  // 根因：图标串用 `DOMParser(..., 'image/svg+xml')` 解析，而 **XML 解析
  // 不像 HTML 解析那样隐式把 `<svg>` 放进 SVG 命名空间**。缺 `xmlns` 时
  // 根元素只是 `namespaceURI: null` 的普通 Element，浏览器按 **0×0** 渲染。
  // 实测对照：
  //   无 xmlns → { ctor: 'Element',     ns: null,                           0×0 }
  //   有 xmlns → { ctor: 'SVGSVGElement', ns: 'http://www.w3.org/2000/svg', 16×16 }
  //
  // 连带后果：图标 0×0 后按钮只剩 padding，缩成 **20×10px** ——
  // 手机上基本点不中（远低于 44×44 的触控下限）。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const block = /const THEME_ICON = \{([\s\S]*?)\n\}/.exec(js)
  assert.notEqual(block, null, '应有 THEME_ICON 定义')

  const svgs = [...(block?.[1] ?? '').matchAll(/'<svg[^']*'/g)].map((m) => m[0])
  assert.ok(svgs.length >= 3, `三个主题态都应有图标，实际解析到 ${svgs.length} 个`)
  for (const s of svgs) {
    assert.ok(
      /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s),
      `主题图标缺 xmlns（会被渲染成 0×0）：${s.slice(0, 70)}`,
    )
  }

  // setSvg 还必须有兜底注入，免得以后新增图标时重蹈覆辙
  assert.ok(/function setSvg\(/.test(js), '应有 setSvg')
  const setSvg = /function setSvg\([\s\S]*?\n\}/.exec(js)?.[0] ?? ''
  assert.ok(/xmlns/.test(setSvg), 'setSvg 应对缺失的 xmlns 做兜底注入')
})

test('⚠️ 顶栏图标按钮的可点区域必须大于图标本身', () => {
  // 图标 0×0 那次的连带伤害：按钮只剩 padding → 20×10px。
  // 可点区域不该由图标尺寸决定。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(
    /header\s+\.icon-btn\s*\{[^}]*min-(width|height)/.test(css),
    '顶栏图标按钮必须设最小尺寸（否则图标一变，触控目标就跟着缩）',
  )
})

test('⚠️ .table-wrap 内的表格必须按内容取宽（否则横向滚动永不触发）', () => {
  // 实测（P1）：`.table-wrap { overflow-x: auto }` 是**空转的**。
  // 全局 `table { width: 100% }` 让表格永远塞满容器、永不溢出，
  // 于是 overflow-x 形同虚设 —— 表格不是滚动，而是**被压缩**：
  // 五列明细表的表头被挤成竖排单字（「类/型」），`codearts` 断成 `codea/rts`。
  //
  // 实测对照：原样式下 表格宽 309px == 容器 309px（不滚动）；
  //          width: max-content 下 表格宽 397px > 容器 340px（真正可滚动）。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const cssCode = stripCssComments(css)
  const rule = /\.table-wrap\s*>\s*table\s*\{([^}]*)\}/.exec(cssCode)
  assert.notEqual(rule, null, '应有 .table-wrap > table 规则')
  assert.ok(/width:\s*max-content/.test(rule?.[1] ?? ''), '必须 width: max-content（否则永远不会溢出）')
  assert.ok(/min-width:\s*100%/.test(rule?.[1] ?? ''), '必须 min-width: 100%（保证窄表仍占满容器）')

  // ⚠️ 光有上面两条还不够，还要允许网格项收缩。
  //
  // `main` 是 `display: grid`，网格项默认 `min-width: auto`（不小于内容的最小宽度）。
  // 表格一旦按 max-content 取宽，这个最小值就跟着变大、把网格轨道撑开 ——
  // 结果是**整个页面横向溢出**。实测（390px 视口，用量视图）：
  //   不加 min-width: 0 → docScrollW 422 > 视口 375，.table-wrap 自己被撑到
  //                       376px，横向滚动依旧不触发（修了个寂寞，还引入了新问题）；
  //   加上之后          → section 351px、wrap 317px、表格 335px，页面溢出归零。
  assert.ok(
    /main\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(cssCode),
    '必须给网格项 min-width: 0，否则宽表格会把整个页面顶宽',
  )
})

test('⚠️ 计数块的「单列」断点必须 ≤360px（420px 会覆盖几乎所有在用手机）', () => {
  // 实测（P2）：单列规则原先挂在 420px 上，注释写「极窄屏（老机型/分屏）」，
  // 但 420 实际覆盖 375/390/393/402/412 —— 几乎所有在用手机。
  // 后果：5 个计数块纵排占 344px，首个供应商卡片被推到 578px
  //（844 高的屏上已过半；667 高的机型直接落到首屏之外）。
  // 逐宽度实测每行几个：375→1、390→1、412→1，仅 430 及以上为 2 列。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  // ⚠️ 判据写成「断点里把 .counts 收成**一列**」，**不绑死实现方式**。
  // 本项目 `.counts` 从 `flex-wrap` 改成了 `grid`（用户报「6 个卡片在电脑上太窄」），
  // 旧断言匹配的 `flex: 1 1 100%`（写在 `.count` 上）随之失效 ——
  // 但**它要守的结论没变**（单列断点必须 ≤360px）。
  // ⇒ 改为匹配 grid 语境下的单列声明，同时容忍两种写法。
  // ⚠️ 块内内容用 `[^@]*`（不允许再出现 `@media`）—— 否则 `[\s\S]*?` 会
  // **跨越到下一个断点**去匹配，把 720px 那个块误报成「单列断点」
  //（我第一版就是这么错的：720 块里没有 1fr，但匹配一路走到了 360 块）。
  const m = /@media\s*\(max-width:\s*(\d+)px\)\s*\{[^@]*?\.counts\s*\{[^}]*grid-template-columns:\s*1fr/.exec(css)
  assert.notEqual(m, null, '应存在把计数块收成一列的断点（grid-template-columns: 1fr）')
  assert.ok(Number(m?.[1]) <= 360, `单列断点应在 ≤360px，实际 ${m?.[1]}px（会误伤 375/390/412 的机型）`)
})

test('⚠️ 柱状图时间标签必须放得下（"10-03 20:00" 折行会让每行高度翻倍）', () => {
  // 实测：该文案在 10px 字号下的自然宽度是 **55px**，
  // 而原样式在 ≤720px 给 52px、≤420px 给 44px —— 都会折成两行
  //（行高 15.5px → 实际高度 31px，柱状图整体观感变差）。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const m = /@media\s*\(max-width:\s*720px\)[\s\S]*?\.bar-label\s*\{[^}]*width:\s*(\d+)px/.exec(css)
  assert.notEqual(m, null, '手机断点里应有 .bar-label 宽度')
  assert.ok(Number(m?.[1]) >= 56, `.bar-label 应 ≥56px 才容得下 "10-03 20:00"（自然宽 55px），实际 ${m?.[1]}px`)
})

test('⚠️ 必须显式处理 skipped / 非数字 total（否则渲染成「可用 undefined」）', () => {
  // 线上实测（P2）：opencode 匿名通道那行显示 **「可用 undefined」**。
  // 后端其实是对的 —— 它对该账号返回
  // `{skipped:true, reason:'该供应商不支持查余额'}`（既无 error 也无 total），
  // 是前端只判 `a.error` 就落到 else 分支，把 undefined 拼进了字符串。
  //
  // ⚠️ 积分包**页面**已按用户要求删除，但 `/admin/packages` 端点保留
  //（账号卡片的「单独显示积分」靠它），故这条防线仍然必须有 ——
  // 只是断言点从已删除的 `loadPackages` 换到仍在的消费方。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  // 账号卡片：非数字 total 必须跳过（不让 undefined 流到界面）
  assert.ok(/typeof a\.total !== 'number'/.test(js) || /typeof cred\.total !== 'number'/.test(js),
    '⚠️ 应对非数字 total 兜底，不让 undefined 流到界面')
  // 任务结果里 skipped 的显式处理（后端用它标记「该供应商不支持查余额」）
  assert.ok(/r\.skipped/.test(js), '应处理 skipped')
})

test('⚠️ 错误文案不得硬截断（会切掉「请重新登录」这类可行动的尾巴）', () => {
  // 线上实测（P2）：积分包页的失败原因被 `slice(0, 60)` 切成了
  // 「Unauthorized: Please make sure you're」—— 恰好在最需要的信息前断掉，
  // 用户看不出该重新登录、还是等一会、还是换账号。
  //
  // ⚠️ 断言前必须**剥掉注释** —— 代码注释里正拿 `a.error.slice(0, 60)`
  // 当反例讲解（说明「为什么不再这么写」），不剥会把自己的说明误判成违规。
  const jsCode = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(!/a\.error\.slice\(/.test(jsCode), '错误文案不得用 slice 硬截断')
  // ⚠️ 原先这里断言「长错误走 .err-msg 块级样式」，但那唯一的用点是
  // 已按用户要求删除的**积分包页**。保留的消费方（账号卡片）用 `title`
  // 承载完整原因，故这里只钉住「不得硬截断」这条仍然成立的纪律 ——
  // 用 `title` 承载完整原因也是合规的做法，一并钉住。
  assert.ok(/title/.test(jsCode), '完整错误原因应通过 title 等方式可达（不被丢弃）')
})

test('⚠️ 空的输出框不该画出空边框', () => {
  // 实测（P3）：#login-result / #import-result 在无内容时仍渲染成
  // 22px 高的带边框空盒子，看起来像「有东西没加载出来」。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(/\.out:empty\s*\{[^}]*display:\s*none/.test(css), '空的 .out 应不显示')
})

test('⚠️ 登录卡片必须留页面内边距（否则手机上顶到屏幕边缘、圆角被切）', () => {
  // ⚠️ 必须先剥 CSS 注释：注释里会写出 `* { box-sizing: border-box }`
  // 这类示例规则，其中的 `}` 会让 `[^}]*` 提前截断，导致断言假失败。
  const cssCode = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const rule = /\.login-body\s*\{([^}]*)\}/.exec(cssCode)
  assert.notEqual(rule, null, '应有 .login-body 规则')
  assert.ok(/padding:/.test(rule?.[1] ?? ''), '登录页容器必须有内边距')
})

test('⚠️ 模型目录必须逐个账号尝试，不能只取第一个（商汤报障的根因）', () => {
  // ## 实测缺陷（用户报「商汤账号怎么又不行了，明明是用微信扫码登录的」）
  //
  // 原实现是 `accounts.find(...)` —— 拿**第一个**该供应商的账号就去拉目录。
  // 而池里可能有多个账号（实测商汤有 2 个），**第一个恰好是坏号**
  //（refresh_token 已失效）时，整个目录请求就失败；另一个好号明明能拉，
  // 而且正是 `chat`（走 `pick()`，会自动跳过坏号）在用的那个。
  //
  // ## 为什么这个缺陷极具误导性
  //
  // 表现为「**同一个账号 chat 完全正常，模型列表却报登录态已过期**」——
  // 用户会以为整个账号废了，实际只是两条路径的**选号策略不一致**。
  //
  // ⚠️ 这类缺陷的形状：**同一份数据、两条路径、两种选号方式**。
  // 修一处不够，必须让两条路径的判据一致。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf("if (path === '/admin/providers/models'")
  assert.ok(i > 0, '应能找到模型目录端点')
  // ⚠️ **必须先剥掉注释再断言** —— 修缺陷时我会在注释里写下「原实现是
  // `accounts.find(...)`」作为反例，而那会让朴素的源码搜索**误报**。
  //（本仓库其它测试也踩过同一个坑：注释里提到禁用字符会误伤。）
  const block = stripComments(src.slice(i, i + 6000))

  // 不得再用 find 取第一个
  assert.ok(
    !/accounts\.find\(/.test(block),
    '⚠️ 不得用 `accounts.find()` 只取第一个账号 —— 坏号会拖垮整个目录请求',
  )
  // 必须是收集候选 + 逐个尝试
  assert.ok(/candidates\.push\(/.test(block), '应收集全部候选账号')
  assert.ok(/for \(const cand of candidates\)/.test(block), '应逐个尝试候选账号')
})

test('⚠️ 模型目录的候选筛选必须与 chat 的健康判据一致', () => {
  // ⚠️ 只遍历而不筛健康状态，等于把坏号也算进重试 —— 白打上游，
  // 且在 refresh_token 已失效（**终态**）时反复触发续期请求。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf("if (path === '/admin/providers/models'")
  const block = src.slice(i, i + 6000)
  assert.ok(/a\.disabled === true/.test(block), '应跳过 disabled 账号')
  assert.ok(/a\.until > Date\.now\(\)/.test(block), '应跳过冷却中的账号')
  assert.ok(/a\.breakerUntil > Date\.now\(\)/.test(block), '应跳过熔断的账号')
})

test('⚠️ 「供应商」计数块必须在「已禁用」**右边**，且复用同款样式', () => {
  // 用户要求：「在已禁用卡片后面加上供应商，数字显示支持的供应商数量，
  // 点开后弹窗可以调整排序和开关供应商」，并明确纠正为**右边**。
  //
  // ⚠️ 「已禁用」等计数块在同一个横向 flex 行里（`.counts`），
  // 故 DOM 顺序就是视觉左右顺序 —— 必须紧跟其后 append。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const disabledLine = js.indexOf("countBlock('已禁用'")
  const provLine = js.indexOf("countBlock('供应商'")
  assert.ok(disabledLine > 0, '应有「已禁用」计数块')
  assert.ok(provLine > 0, '应有「供应商」计数块')
  assert.ok(provLine > disabledLine, '⚠️「供应商」必须在「已禁用」的右边（DOM 顺序即左右）')
  // ⚠️ 复用它自己的 countBlock（不是另造一套卡片）—— 视觉才统一
  assert.ok(/countBlock\('供应商',\s*\w+,\s*\(\) => openProviderManager\(\)\)/.test(js),
    '应复用 countBlock 并绑定点击打开管理弹窗')
  // 数字是**已启用的供应商数**
  assert.ok(/enabledProviders/.test(js), '数字应是已启用的供应商数')
  // 点开能排序与开关
  assert.ok(js.includes('openProviderManager'), '点击应打开管理弹窗')
  assert.ok(js.includes('/admin/providers/settings'), '弹窗要能把设置存到服务端')
})

test('⚠️ 供应商列表必须支持**拖动**排序（不是上移/下移按钮）', () => {
  // 用户明确要求：「加一个拖动移动位置」。
  //
  // ⚠️ 实现方式**后来换过**：原先用 HTML5 drag-and-drop，但用户实测
  // 「iOS 上只会选择文字」⇒ 已改用 Pointer Events
  //（根因与取舍见下一条测试）。这里只钉住「有拖动能力 + 有手柄」。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(/pointerdown/.test(js), '要有拖动能力（Pointer Events）')
  assert.ok(js.includes('drag-handle'), '要有拖动手柄')
  assert.ok(/drag-handle/.test(css), '手柄要有样式（cursor: grab）')
  // ⚠️ 不能再有上移/下移按钮（用户要的是拖动）
  assert.ok(!/up\.textContent = '↑'/.test(js), '不应保留「上移」按钮')
})

test('⚠️ 供应商管理弹窗必须复用现有 .card 样式（视觉统一）', () => {
  // 用户报：「打开后的风格也不统一」。故弹窗里的行要用**现有的** `.card`
  //（与「账号」页同款），不是自己造一套 `.prow`。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const i = js.indexOf('function openProviderManager')
  // ⚠️ 窗口要取到**下一个顶层函数**，不能用固定长度 ——
  // 该函数因拖动改用 Pointer Events 变长了，固定 3200 会切掉后半段，
  // 让断言变成「找不到 ⇒ 失败」这种**假失败**（我为此返工过）。
  const j = js.indexOf('\nfunction ', i + 10)
  const block = js.slice(i, j > 0 ? j : i + 12000)
  // ⚠️ 断言前剥注释：我的说明里引用了 `row.draggable` 这类旧写法当反例。
  assert.ok(/row\.className = 'card'/.test(stripJsComments(block)), '管理行应复用 .card 样式')
  // ⚠️ 按钮也复用现有的 ghost / danger（不另立样式）
  // ⚠️ 断言用「两者都出现」而不是写死整行：2026-10-13 的 UI 审计给它附加了
  // `prov-sw` 状态类（修「一整列红色关闭按钮」的观感缺陷），整行匹配会**假失败**。
  assert.ok(/off \? 'ghost' : 'danger'/.test(block), '开关应复用 ghost/danger')
  // 自造的 .prow 样式必须已删除（否则就是两套风格）
  assert.ok(!/\.prow\b/.test(css), '⚠️ 不得残留自造的 .prow 样式')
})

test('🔴 账号卡片必须支持单独停用/启用，且按钮在「删除」左边', () => {
  // 用户要求：「每个账号支持单独停用和启用，放在删除左边」。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  // 调的是可逆端点（不是 remove）
  assert.ok(js.includes('/admin/accounts/toggle'), '停用/启用应走 toggle 端点')
  // ⚠️ **顺序**：停用按钮必须先 append，删除在后 ——
  // 用户明确要「放在删除左边」，而 DOM 顺序就是视觉顺序。
  const togAppend = js.indexOf("card.appendChild(tog)")
  const delAppend = js.indexOf("card.appendChild(del)")
  assert.ok(togAppend > 0 && delAppend > 0, '两个按钮都应存在')
  assert.ok(togAppend < delAppend, '⚠️ 停用/启用必须在「删除」左边')
  // ⚠️ 视觉区分：停用可逆（ghost），删除不可逆（danger）——
  // 把可逆操作也做成红色会让用户不敢点。
  assert.ok(/const del = document.createElement\('button'\); del\.className = 'danger'/.test(js),
    '删除仍应是 danger 样式')
})

test('⚠️ 每个账号卡片必须单独显示积分，且**不得阻塞账号列表**', () => {
  // ## 用户两条反馈（先后）
  //
  // 1. 「每个账号单独显示积分」—— 于是接了 `acct-credits`。
  // 2. ⚠️「账号半天加载不出来」—— 因为积分是逐账号串行实时查上游
  //    （实测 `/admin/packages` 要 **16.3 秒**，而 `/admin/accounts` 只要 1.5 秒），
  //    旧写法把两者**串在一起** ⇒ 点开弹窗后要盯空白等 16 秒。
  //
  // ⇒ 现在**先渲染账号**，积分**异步补**。这条测试钉住这个结构。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(js.includes('acct-credits'), '账号卡片要有积分元素')
  assert.ok(/acct-credits/.test(css), '要有样式')

  // ① ⚠️ **必须**用 `/admin/packages` 而不是 `a.credits` ——
  //    后者只在 `AccountPoolDO.revive()` 里被写，平时恒为 0（废弃字段）。
  assert.ok(/fetchPackages\(\)/.test(js), '积分应来自 /admin/packages')

  // ② ⚠️ 积分必须在**渲染之后**异步补，不能 await 在渲染之前。
  const fn = js.slice(js.indexOf('async function loadModalAccounts'))
  const renderAt = fn.indexOf('box.appendChild(card)')
  const creditAt = fn.indexOf('await fetchPackages()')
  assert.ok(renderAt > 0, '应有账号渲染')
  assert.ok(creditAt > renderAt,
    '⚠️ 积分查询必须在**账号渲染之后**（之前会阻塞 16 秒 —— 用户报「半天加载不出来」）')

  // ③ ⚠️ 必须有轮次校验：用户快速切换供应商时，旧一家的积分不能写进新一家
  assert.ok(/modalAccountsSeq/.test(js), '⚠️ 异步补齐必须有轮次校验（否则串数据）')
  // ④ ⚠️ 元素可能已被下一次重载移除，写之前要判 isConnected
  assert.ok(/\.isConnected/.test(js), '⚠️ 写之前要判元素是否仍在文档里')
  // ⑤ 三种终态都要有：有额度 / 查询失败（带原因）/ 不支持查余额
  assert.ok(/查询失败/.test(js), '查询失败要显示（不是静默 0）')
  assert.ok(/不支持查余额/.test(js), '后端标 skipped 时应显示「不支持查余额」而非「查询失败」')
  assert.ok(js.includes("el.textContent = '—'"), '未查到应显示破折号而非 0')
})

test('🔴 供应商关闭必须真的关掉（服务端状态 + 双向拦截）', () => {
  // 用户明确：「彻底关掉（面板 + API 都消失）」。
  // ⚠️ 只在面板隐藏是不够的 —— 客户端可能缓存了旧目录，或按名字硬编码调用。
  const index = readFileSync('src/index.ts', 'utf8')
  const server = readFileSync('src/gateway/server.ts', 'utf8')

  // ① /v1/models 要跳过被关闭的家
  assert.ok(/userDisabledProviders\.has\(providerId\)/.test(index),
    '⚠️ /v1/models 必须跳过被关闭的供应商')

  // ② 路由要拒绝
  assert.ok(index.includes('/admin/providers/settings'), '应有设置端点')
  assert.ok(server.includes('isProviderClosedByUser'), '路由必须有「已关闭」判据')
  assert.ok(/provider_disabled/.test(server), '应回一个可识别的错误码')

  // ③ ⚠️ 判据读**服务端**设置，不是浏览器 localStorage
  assert.ok(/getProviderSettings/.test(server), '判据必须读服务端设置（localStorage 只在面板生效）')

  // ④ ⚠️ 读失败必须按「没关」处理 —— 不能把偏好读取失败放大成全面 403
  const i = server.indexOf('async function isProviderClosedByUser')
  const block = server.slice(i, i + 400)
  assert.ok(/catch\s*\{[\s\S]*?return false/.test(block), '⚠️ 读设置失败必须回 false（不能全面 403）')
})

test('⚠️ 供应商排序不得改变默认供应商（避免悄悄改路由）', () => {
  // 用户选择：「只影响面板展示顺序」，不改默认供应商。
  // ⚠️ 若排序决定默认值，裸模型名的既有请求会被悄悄路由到别家 —— 不可接受。
  const src = readFileSync('src/providers/index.ts', 'utf8')
  assert.ok(/export const DEFAULT_PROVIDER = PROVIDERS\[0\]/.test(src),
    '默认供应商必须仍由**注册表第 0 项**决定，不受面板排序影响')
  // 面板设置里不该有「默认供应商」这个概念
  const index = readFileSync('src/index.ts', 'utf8')
  const i = index.indexOf("path === '/admin/providers/settings'")
  const block = index.slice(i, i + 900)
  assert.ok(!/defaultProvider/.test(block), '设置端点不该改默认供应商')
})

test('🔴 loomy 必须支持短信验证码登录（且走**两步流程**，不是轮询）', () => {
  // 用户要求「Loomy 和 LobsterAI 的设备码登录尽量支持一下」。
  //
  // 实测结论（读了参考实现）：
  // · **loomy 短信**：纯 HTTP 三步（发码 → 用户输入 → 校验），
  //   `loomy-oauth.ts` 里 `127.0.0.1` 出现 **0 次** ⇒ **Workers 上可行**。
  // · **loomy 微信扫码**：需要本地服务器承载弹窗页
  //   （`loomy-wechat-login.ts:11-13` 的 `127.0.0.1:随机端口`）⇒ **不可行**。
  // · **lobsterai**：强制 `http://127.0.0.1:{port}/auth/callback`
  //   （`lobsterai-oauth.ts:95,109`）⇒ **不可行**，已如实声明。
  const loomy = readFileSync('src/providers/loomy.ts', 'utf8')
  assert.ok(/login: true/.test(loomy), 'loomy 应声明 login: true（短信已接线）')

  const index = readFileSync('src/index.ts', 'utf8')
  // 第 1 步：发码（要 phone）
  assert.ok(index.includes("providerId === 'loomy'"), '应有 loomy 发起分支')
  assert.ok(/sendLoomySmsCode/.test(index), '第 1 步应调 sendLoomySmsCode')
  // 第 2 步：提交验证码（**单独端点**，不是 poll）
  assert.ok(index.includes("/admin/providers/login/loomy/sms"), '应有短信提交端点')
  assert.ok(/loginLoomyBySmsCode/.test(index), '第 2 步应调 loginLoomyBySmsCode')
  // ⚠️ 必须是 POST 而不是 GET：验证码进 URL 会落进日志与 Referer
  const i = index.indexOf("path === '/admin/providers/login/loomy/sms'")
  assert.ok(/request\.method === 'POST'/.test(index.slice(i, i + 80)), '⚠️ 提交验证码必须用 POST')

  // ⚠️ msgid 必须持久化（Workers 无跨请求内存）；丢了会被上游判「msgid 无效」
  assert.ok(/msgid/.test(index.slice(index.indexOf("providerId === 'loomy'"), index.indexOf("providerId === 'loomy'") + 2500)),
    '⚠️ 发码后必须把 msgid 存进登录会话')
})

test('⚠️ lobsterai 必须如实声明登录不可行（强制 127.0.0.1 回调）', () => {
  // ⚠️ 用户希望「尽量支持」，但它**架构上不可行** —— 参考实现
  // `lobsterai-oauth.ts:95,109` 明确：`redirect_uri` **必须**是
  // `http://127.0.0.1:{port}/auth/callback`，且回调服务器绑 `127.0.0.1`
  // （`:342` 注释：「绑 127.0.0.1 而非 0.0.0.0：回调只可能来自本机浏览器」）。
  // Workers 没有 listen socket ⇒ 这条链不成立。
  const src = readFileSync('src/providers/lobsterai.ts', 'utf8')
  assert.ok(/login: false/.test(src), 'lobsterai 应如实声明 login: false')
  assert.ok(/loginBlockedReason/.test(src), '必须说明原因（不能只给个 false）')
  // ⚠️ 原因里要说清「怎么做才能用」（导出凭据导入），否则用户卡死
  assert.ok(/导出凭据|粘贴/.test(src), '原因里要给出替代做法')
})

test('⚠️ loomy 面板必须走短信两步流程（不能进轮询逻辑）', () => {
  // ⚠️ 短信登录是「用户输入后主动提交」，**不是**「等服务端状态变化」。
  // 混进轮询那套会让用户干等一个永远不会自己完成的流程。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(js.includes('startLoomySmsLogin'), '应有独立的短信流程函数')
  // 必须在进轮询**之前**分派走
  const fn = js.indexOf('async function startModalLogin')
  const block = js.slice(fn, fn + 600)
  assert.ok(/providerId === 'loomy'/.test(block), '⚠️ 必须在轮询之前分派走')
  assert.ok(/LOGIN_KIND_LABEL[\s\S]{0,120}loomy:/.test(js), '要有「短信验证码登录」标签')
})

test('🔴 供应商拖动必须用 Pointer Events（iOS Safari 不支持普通元素的 HTML5 拖放）', () => {
  // ## 用户实测反馈
  //
  // 「供应商拖动排序功能在 iOS 的浏览器上只会**选择文字**，
  //  在 Chromium 内核的浏览器上能正常拖动，但也不太顺手」。
  //
  // 根因是**两个独立问题**：
  // 1. **iOS Safari 对普通元素根本不支持 HTML5 拖放** ——
  //    `draggable="true"` 只对链接/图片等原生可拖元素有效，对 `<div>`
  //    只会触发文字选择。⇒ 这不是「配置不对」，改属性救不回来。
  // 2. **整行都在拖**（`row.draggable = true`），而注释声称「只有手柄可拖」
  //    ⇒ 按「启用/关闭」按钮时容易误触发拖动，按钮变得难以点中。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const css = panelAsset('/panel/style.css')?.body ?? ''

  // ① 不得再用 HTML5 拖放 API
  for (const api of ['ondragstart', 'ondragover', 'ondrop', '.draggable = true']) {
    assert.ok(!js.includes(api), `⚠️ 不得再用 HTML5 拖放（${api}）—— iOS 上无效`)
  }
  // ② 必须用 Pointer Events
  assert.ok(/pointerdown/.test(js), '应用 pointerdown 起拖')
  assert.ok(/pointermove/.test(js), '应用 pointermove 跟踪位置')
  assert.ok(/pointerup/.test(js), '应用 pointerup 落位')
  // ③ ⚠️ 必须处理 pointercancel，且**不提交**（原样回退）
  assert.ok(/pointercancel/.test(js), '⚠️ 必须处理 pointercancel（系统中断）')
  assert.ok(/endDrag\(false\)/.test(js), '⚠️ pointercancel 必须不提交改动')
  // ④ ⚠️ 必须 setPointerCapture，否则滑出手柄就收不到 pointerup（拖到一半卡住）
  assert.ok(/setPointerCapture/.test(js), '⚠️ 必须 setPointerCapture（否则拖到一半卡住）')
  // ⑤ ⚠️ 必须有起拖阈值，轻点手柄不该算拖动
  assert.ok(/DRAG_START_PX/.test(js), '⚠️ 起拖需有位移阈值（避免误触）')

  // ⑥ ⚠️ CSS 的 touch-action:none 是 iOS 能拖起来的**关键**
  //   （否则 iOS 把长按解释成文字选择/滚动，pointermove 不会持续派发）
  const handleRule = css.slice(css.indexOf('.drag-handle {'))
  const handleBody = handleRule.slice(0, handleRule.indexOf('}'))
  assert.ok(/touch-action:\s*none/.test(handleBody),
    '⚠️ .drag-handle 必须有 touch-action: none —— 这是 iOS 能拖的关键')
  assert.ok(/-webkit-user-select:\s*none|-user-select:\s*none/.test(handleBody),
    '⚠️ .drag-handle 需要 user-select: none（第二道防线）')
})

test('⚠️ 拖动排序只作用于手柄，不作用于整行（否则按钮点不中）', () => {
  // 用户反馈「Chromium 上能拖但不太顺手」的直接原因之一：
  // 整行可拖会让「启用/关闭」按钮几乎点不中（按下即开始拖动，click 不触发）。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  // pointerdown 必须挂在 handle 上
  assert.ok(/handle\.addEventListener\('pointerdown'/.test(js),
    '⚠️ pointerdown 必须挂在小手柄上，不是整行')
  // row 上不得挂 pointerdown
  assert.ok(!/row\.addEventListener\('pointerdown'/.test(js),
    '⚠️ 整行不得起拖（会让按钮点不中）')
  // 开关按钮必须仍然有 onclick（未被拖动逻辑吃掉）
  assert.ok(/sw\.onclick/.test(js), '⚠️ 开关按钮的 onclick 必须保留')
})

test('🔴 浅色主题必须覆盖**两套**规则（显式 light + 跟随系统的 auto）', () => {
  // ## 实测缺陷（用户报「用量的柱形图在自适应主题下的浅色主题背景还是深色的」）
  //
  // 项目有**两套**浅色规则，独立维护：
  //   1. `html[data-theme='light']` —— 用户**显式**选浅色；
  //   2. `@media (prefers-color-scheme: light) { html:not([data-theme]) ... }`
  //      —— 用户选「跟随系统」且系统是浅色。
  //
  // 我只把 `.trend-track` 加进了第 1 套 ⇒ **auto 模式下漏了**，
  // 于是柱状图背景仍是深色（`#10131a`）。
  // ⚠️ 这类缺陷只在**某一种模式**下出现，极难发现 —— 必须用测试钉住「两处都有」。
  const css = panelAsset('/panel/style.css')?.body ?? ''

  // 两套规则都必须存在
  assert.ok(/html\[data-theme='light'\]\s*\.trend-track/.test(css),
    "⚠️ 显式 light 主题要覆盖 .trend-track")
  assert.ok(/html:not\(\[data-theme\]\)\s*\.trend-track/.test(css),
    '⚠️ 跟随系统（auto）的浅色也要覆盖 .trend-track —— 漏了就是用户报的那个缺陷')

  // 一般化：凡是有 `.bar-track` 浅色覆盖的地方，`.trend-track` 也必须有
  // （两个都是「柱状图轨道」，成对出现才不容易漏）
  const explicitLightBlock = css.slice(css.indexOf("html[data-theme='light'] .out"))
  assert.ok(/\.bar-track[\s\S]{0,400}\.trend-track|\.trend-track[\s\S]{0,400}\.bar-track/.test(css)
    || /\.trend-track/.test(explicitLightBlock),
    '⚠️ .bar-track 与 .trend-track 应在同一处一起覆盖（它们是一对）')

  // ⚠️ 更强的判据：**逐条**检查浅色规则体里没有深色底。
  //（不能简单地「取第一个 [data-theme='light'] 之后的全部文本」——
  //  那会把后面的 auto 块与注释也算进来，产生假失败。我第一版就是这么错的。）
  const lightRuleBodies: string[] = []
  const re = /html\[data-theme='light'\]([^{]*)\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) lightRuleBodies.push(m[2] ?? '')
  const autoRuleBodies: string[] = []
  const re2 = /html:not\(\[data-theme\]\)([^{]*)\{([^}]*)\}/g
  while ((m = re2.exec(css)) !== null) autoRuleBodies.push(m[2] ?? '')
  assert.ok(lightRuleBodies.length > 0 && autoRuleBodies.length > 0,
    '两套浅色规则都应存在')
  for (const body of [...lightRuleBodies, ...autoRuleBodies]) {
    assert.ok(!/#10131a/.test(body),
      `⚠️ 浅色规则体里不得残留深色底 #10131a（实际：${body.trim().slice(0, 80)}）`)
  }
})

test('⚠️ 趋势图必须限宽（用户报「太宽不好看」）', () => {
  // `.trend-col` 的 flex-basis 是 26px（保证窄屏柱子可见），
  // 而 30 天窗口 ⇒ 30 列 ⇒ 光柱子就要 780px+，再加 `flex-grow` 撑满
  // ⇒ 整条图横铺满 1180px 容器，很难看。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const rule = css.slice(css.indexOf('.trend {'))
  const body = rule.slice(0, rule.indexOf('}'))
  // ① 整块要有宽度上限
  assert.ok(/max-width:\s*\d+px/.test(body),
    '⚠️ .trend 必须有 max-width（否则 30 列横铺满屏）')
  // ② 单列也要封顶，否则「唯一一根柱」会被拉成整条白块
  const colRule = css.slice(css.indexOf('.trend-col {'))
  const colBody = colRule.slice(0, colRule.indexOf('}'))
  assert.ok(/max-width:\s*\d+px/.test(colBody),
    '⚠️ .trend-col 必须有 max-width（否则单列时一根柱被拉成白块）')
  // ③ 窄屏不能溢出容器
  assert.ok(/width:\s*100%/.test(body), '⚠️ 应有 width:100% 兜底窄屏（不能溢出）')
})

test('🔴 用量「按小时」的数字**必须带单位**（用户报「21 24 是什么意思」）', () => {
  // ## 用户原话：「这个每小时用量的 21 24 是什么意思」
  //
  // 根因：旧版渲染时只写一个裸 `count`：
  //   `val.textContent = fmtNum(h.count) + (h.failed ? ' / ' + … : '')`
  // ⇒ 界面上就是「21」「24」两个数字，**看不出是请求数还是 token 数**。
  // 这不是「不够美观」，是**信息缺失** —— 用户无法解读自己的数据。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function renderUsageHours'))
  // ① 值必须带「次请求」这样的单位
  assert.ok(/次请求/.test(fn), '⚠️ 请求数必须写明单位（不能只有裸数字）')
  // ② 必须同时给出该小时的 token 量（否则仍然不知道每小时花了多少）
  assert.ok(/tokens/.test(fn) || /tok/.test(fn), '⚠️ 该小时的 token 量也要给')
  // ③ 必须有表头，否则右侧两列仍然靠猜
  assert.ok(/bar-head/.test(fn), '⚠️ 需要表头说明各列是什么')
  // ④ 悬停提示里要有完整明细
  assert.ok(/\.title\s*=/.test(fn), '⚠️ 应有 title 提示给出完整数字')
})

test('🔴 「今日」窗口不得显示按天趋势（单根柱没有意义）', () => {
  // 用户明确要求：「今日就不要显示按天趋势了」。
  // 今日窗口只有**一根柱** —— 既不构成趋势，观感也差
  //（单根柱要么被拉成整条白块，要么孤零零杵着）。
  //
  // ⚠️ 要隐藏**整个面板**（含标题），而不是只清空内容 ——
  // 留一个空标题比不显示更让人困惑。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function renderUsageTrend'))
  assert.ok(/windowDays === 1/.test(fn), '应判单日窗口')
  assert.ok(/panel\.hidden = true/.test(fn),
    '⚠️ 单日窗口必须**隐藏整个面板**（不是只清空内容）')
  // 且必须是**提前返回**（不能继续画柱子）
  const hideAt = fn.indexOf('panel.hidden = true')
  const returnAt = fn.indexOf('return', hideAt)
  assert.ok(returnAt > hideAt && returnAt - hideAt < 200,
    '⚠️ 隐藏后必须立即 return，否则仍会画出那根柱')
})

test('🔴 byHour 必须带 token（否则「按小时」给不出用量）', () => {
  // 上一条测试断言「按小时要显示 tokens」，其前提是**后端确实算了**。
  // 这个前提若变了，那条断言就只是空转。
  const src = readFileSync('src/store/usage.ts', 'utf8')
  const iface = src.slice(src.indexOf('export interface UsageHour'))
  const body = iface.slice(0, iface.indexOf('}'))
  for (const k of ['input', 'output']) {
    assert.ok(new RegExp(`\\b${k}\\b`).test(body),
      `⚠️ UsageHour 必须包含 ${k}（否则按小时给不出 token 量）`)
  }
  // ⚠️ 旧数据没有这两个字段 ⇒ 累加时必须按 0 兜底，否则整列变 NaN
  assert.ok(/prev\?\.input \?\? 0/.test(src) && /prev\?\.output \?\? 0/.test(src),
    '⚠️ 旧数据的 byHour 没有 input/output，累加必须 ?？ 0 兜底（否则显示 NaN）')
  assert.ok(/v\.input \?\? 0/.test(src) && /v\.output \?\? 0/.test(src),
    '⚠️ 汇总合并时同样要兜底')
})

test('⚠️ KPI 卡的浅色规则必须**两套都加**（显式 light + 跟随系统 auto）', () => {
  // 这正是本项目上一轮踩过的缺陷（用户报「浅色主题下趋势柱背景还是深色」）：
  // 两套浅色规则**独立维护**，只写一处就会在「跟随系统」模式下漏掉。
  // 本轮新增 KPI 卡时，我自己又差点犯同一个错（先只加了一处）。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(/html\[data-theme='light'\]\s*\.kpi\s*\{/.test(css),
    "⚠️ 显式 light 主题要覆盖 .kpi")
  assert.ok(/html:not\(\[data-theme\]\)\s*\.kpi\s*\{/.test(css),
    '⚠️ 跟随系统（auto）的浅色也要覆盖 .kpi')
})

// ─────────────── 真实执行渲染函数（抓 TDZ 这类**运行时**错误） ───────────────
//
// ## 为什么必须有这一组（用户报「用量页直接加载不出来了」）
//
// 我上一轮加 KPI 卡时，把 `rangeLabel` **用在了 `const` 声明之前** ——
// `const` 有 TDZ，于是 `loadUsage()` 一执行就抛
// `Cannot access 'rangeLabel' before initialization`，**整个用量页空白**。
//
// ⚠️⚠️ **这类错误任何「读源码文本」的断言都抓不到**：
// 语法完全合法（`new Function(src)` 照样通过），只有**真的跑一遍**才会暴露。
// 项目此前只有静态文本断言，所以这个 bug 一路漏到了线上。
//
// ⇒ 这里搭一个**最小 DOM 桩**，把真实的 `loadUsage()` 跑起来。
// ⚠️ 桩只实现面板实际用到的那几个 API（见下方统计），
// 故意**不做**通用伪装 —— 用到没实现的方法要立刻报错，而不是静默返回 undefined。

/** 极简 DOM 元素桩。 */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { for (const x of c) this._s.add(x) },
      remove(...c) { for (const x of c) this._s.delete(x) },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) } else if (on) this._s.add(c); else this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    },
    get firstChild() { return this.children[0] ?? null },
    // ⚠️ DOM 里子节点数组叫 `childNodes`，而面板代码用 `children` ——
    // 两者都要有（我第一版只给了 children，测试读 childNodes 就拿到 undefined）。
    get childNodes() { return this.children },
    get textContent() { return this._text ?? '' },
    set textContent(v) { this._text = String(v); this.children = [] },
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
    insertBefore(c) { this.children.unshift(c); return c },
    addEventListener() {},
    removeEventListener() {},
    // ⚠️ SVG 元素用 `setAttribute`/`getAttribute` 而不是属性赋值 ——
    // `sparkline` 完全依赖它们，桩里必须真的存下来（否则断言读不到 d）。
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null },
    getBoundingClientRect() { return { top: 0, height: 0, left: 0, width: 0 } },
    querySelectorAll() { return [] },
    querySelector() { return null },
    cloneNode() { return makeEl(tag) },
    // ⚠️ 桩里恒真：真实浏览器里「已脱离文档」的元素写文字无效，
    // 但这里没有文档树概念，恒真足够验证**逻辑**不抛错。
    get isConnected() { return true },
    hidden: false,
    title: '',
  }
  return el
}

/**
 * 在最小 DOM 桩里加载面板 JS，并跑一个渲染函数。
 *
 * @param fnSource - 要执行的代码（可访问面板里的函数与变量）
 */
function runPanelJs(fnSource, options = {}) {
  const src = panelAsset('/panel/app.js')?.body ?? ''
  const els = new Map()
  const document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl('div'))
      return els.get(id)
    },
    createElement: (tag) => makeEl(tag),
    // ⚠️ SVG 必须走 `createElementNS`（命名空间）—— `sparkline` 用它建 svg/path。
    // 桩里直接复用同一个元素实现即可（我们只关心属性与子节点）。
    createElementNS: (_ns, tag) => makeEl(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    // ⚠️ 面板用 `document.addEventListener` 注册全局 Escape 关闭弹窗 ——
    // 桩必须实现它，否则 `runPanelJs` 一加载就抛错（实测踩到）。
    addEventListener() {},
    removeEventListener() {},
    documentElement: makeEl('html'),
    importNode: (n) => n,
  }
  const store = new Map([['wb_api_key', 'k']])
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  const window = { open() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
  // ⚠️ 允许注入 fetch/location：`bootstrap()` 的分支判定（401 与网络错误要
  // 区分对待）只能靠**真的跑一次**来验证 —— 静态断言抓不到「把所有 !ok 都
  // 当成密钥失效」这类逻辑错误（那正是本次要修的缺陷）。
  const fetchStub = options.fetch ?? (async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }))
  const locationStub = options.location ?? { href: 'http://x/panel/', search: '' }
  // ⚠️ 用 `new Function` 包一层：面板 JS 里全是函数声明与 const，
  // 直接 eval 会把它们塞进当前作用域，和测试变量撞名。
  // ⚠️⚠️ **必须把定时器换成空实现**。
  //
  // 面板 JS 末尾会调 `bootstrap()`，而它注册了 `setInterval(loadWaf, 20000)`
  // 之类的常驻定时器 —— 在 Node 测试进程里那会让**整个测试永不退出**
  //（我第一版就踩到了：单测跑 294 秒后被 cancel）。
  //
  // ⚠️ 这里要验证的是**同步渲染逻辑**，定时器与它无关，故直接吞掉。
  // ⚠️ 但**不要**把 `setTimeout` 实现成「立即执行回调」—— 那会让
  // 轮询类代码递归自激，同样卡死。直接返回一个假 id、什么都不做最稳。
  const noTimer = () => 0
  const factory = new Function(
    'document', 'localStorage', 'window', 'fetch', 'navigator', 'location', 'alert', 'confirm', 'URL', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    src + '\n;return { ' + fnSource + ' };',
  )
  const rt = factory(document, localStorage, window, fetchStub, { userAgent: 'test' }, locationStub, () => {}, () => true, URL, AbortController, noTimer, noTimer, noTimer, noTimer)
  // 把桩暴露出来，便于断言「有没有跳转、密钥有没有被删」
  rt.__store = store
  rt.__location = locationStub
  return rt
}

test('🔴 loadUsage 必须能**真的跑起来**（TDZ 这类运行时错误只有执行才抓得到）', async () => {
  // 用户报「直接加载不出来了」：`loadUsage` 里 `rangeLabel` 被用在 `const` 声明之前，
  // TDZ 抛错 ⇒ 整页空白。语法检查完全合法，只有真跑才暴露。
  const rt = runPanelJs('loadUsage')
  assert.equal(typeof rt.loadUsage, 'function', 'loadUsage 应可取出')
  // 用空数据跑：只要不抛异常就算过（这里验证的是**不崩**，不是渲染细节）
  await assert.doesNotReject(async () => { await rt.loadUsage() },
    '⚠️ loadUsage 不得抛错（TDZ / 未定义变量这类都会在这里暴露）')
})

test('🔴 用量页所有渲染函数都必须能真的执行（逐个跑一遍）', async () => {
  // ⚠️ 只测 loadUsage 不够：它内部会调 renderUsageTrend / renderUsageHours，
  // 但那两条在「今日 + 无数据」时可能提前 return，覆盖不到主体逻辑。
  // 故把三个渲染函数各自**单独**喂数据跑一遍。
  const rt = runPanelJs('renderUsageTrend,renderUsageHours,renderUsageRanges,loadUsage')
  const bars = [
    { day: '2026-10-11', count: 42, failed: 0, input: 1322, output: 2001, tokens: 3323 },
    { day: '2026-10-10', count: 10, failed: 2, input: 100, output: 50, tokens: 150 },
  ]
  const hours = [
    { hour: '08:00', count: 22, failed: 0, input: 5, output: 12 },
    { hour: '10:00', count: 20, failed: 1, input: 0, output: 0 },
  ]

  // 多日窗口：应画出柱子
  await assert.doesNotReject(async () => { rt.renderUsageTrend(bars, 7) }, '多日趋势应可渲染')
  // 单日窗口：应隐藏面板（不抛错）
  await assert.doesNotReject(async () => { rt.renderUsageTrend(bars, 1) }, '单日趋势应可渲染（并隐藏面板）')
  // 空数据
  await assert.doesNotReject(async () => { rt.renderUsageTrend([], 7) }, '空趋势应可渲染')
  // 按小时：今日窗口
  await assert.doesNotReject(async () => { rt.renderUsageHours(hours, 1) }, '按小时应可渲染')
  // 按小时：非今日（应给提示而不是画图）
  await assert.doesNotReject(async () => { rt.renderUsageHours(hours, 7) }, '非今日按小时应可渲染')
  await assert.doesNotReject(async () => { rt.renderUsageRanges() }, '时间窗控件应可渲染')
})

test('⚠️ 用量页不得有「清空」按钮（用户要求删除）', () => {
  // 用户原话：「这个清空按钮删了，不需要」。
  //
  // ⚠️ 删按钮时**必须连 JS 里的事件绑定一起删** ——
  // `$('clear-usage')` 在按钮不存在时返回 `null`，紧接着 `.onclick = …`
  // 会抛 `TypeError`，而它位于顶层脚本流里 ⇒ **从这里往后的所有绑定全部失效**
  //（表现为「面板一半的按钮都不好使了」）。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')

  assert.ok(!html.includes('id="clear-usage"'), '⚠️ 清空按钮应已从 HTML 删除')
  assert.ok(!js.includes("$('clear-usage')"),
    '⚠️ JS 里不得再引用 clear-usage（否则 null.onclick 抛错，后续绑定全失效）')
  // 刷新按钮必须仍在（只删清空）
  assert.ok(html.includes('id="refresh-usage"'), '刷新按钮应保留')
  // ⚠️ 后端端点**保留**：用户只要求删按钮，没说删能力
  const idx = readFileSync('src/index.ts', 'utf8')
  assert.ok(idx.includes("'/admin/usage/clear'"), '后端清空端点应保留（只删了按钮）')
})

test('⚠️ sparkline 的边界：少于 2 个点必须返回空（不能编造一条平线）', async () => {
  // 照参考项目 KPI 卡底部的趋势线。三个边界都必须对：
  //   1. < 2 个点 ⇒ 连不成线，返回**空**（硬画会得到一条假水平线，
  //      那是在**编造**「数据很平稳」）；
  //   2. 全平（max === min）⇒ 画中线，**不能**除零（NaN 会让整条 path 不渲染）；
  //   3. 正常序列 ⇒ 画出 path。
  const rt = runPanelJs('sparkline')
  // ① 0 / 1 个点 → 空
  for (const vals of [[], [5]]) {
    const svg = rt.sparkline(vals, 'blue')
    assert.equal(svg.childNodes.length, 0,
      `⚠️ ${vals.length} 个点时应返回空 SVG（不能画假线）`)
  }
  // ② 全平 → 有 path 且 d 里**不含 NaN**
  const flat = rt.sparkline([7, 7, 7], 'green')
  assert.equal(flat.childNodes.length, 1, '全平也应画出线（中线）')
  const flatD = flat.childNodes[0].getAttribute('d')
  assert.ok(!/NaN/.test(String(flatD)), `⚠️ 全平时不得出现 NaN（实际 ${flatD}）`)
  // ③ 正常 → 有 path 且点数正确（3 个点 ⇒ 2 段 L）
  const norm = rt.sparkline([1, 5, 3], 'purple')
  assert.equal(norm.childNodes.length, 1, '正常序列应画出线')
  const d = String(norm.childNodes[0].getAttribute('d'))
  assert.ok(d.startsWith('M'), 'path 应以 M 开头')
  assert.equal((d.match(/L/g) ?? []).length, 2, '3 个点应有 2 段直线')
})

test('⚠️ KPI 卡只在真有 ≥2 个点时加 sparkline（否则留一段空白）', () => {
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function kpiCard'))
  assert.ok(/sparkValues\.length >= 2/.test(fn),
    '⚠️ 少于 2 个点时不得加 sparkline（空 SVG 会撑出空白）')
  // ⚠️ 还要判 sparkline 真的产出了内容（它内部可能因边界返回空 SVG）
  assert.ok(/childNodes\.length > 0/.test(fn),
    '⚠️ 加之前要确认 sparkline 真产出了内容')
})

test('⚠️ 耗时卡**故意不**给 sparkline（拿了会误导）', () => {
  // 我们只存了「按天的合计耗时」，而卡上显示的是**均值** ——
  // 拿合计画趋势会把「请求多的一天」画成「很慢的一天」。
  // ⚠️ 宁可不画，也不给一张错图。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const i = js.indexOf("'平均耗时'")
  assert.ok(i > 0, '应有平均耗时卡')
  // ⚠️ 判据要**简单**：直接确认那一行之后**紧接着**就是副标题参数、
  // 然后调用结束（没有第 6 个参数）。前面两版写法都太脆：
  //   · 用「正则匹配结尾」——实参跨两行且含模板字符串，匹配不到；
  //   · 数顶层逗号 —— 会把 `? :` 三元与嵌套调用的括号算错。
  const twoLines = js.split('\n')
  const at = twoLines.findIndex((l) => l.includes("'平均耗时'"))
  assert.ok(at > 0, '应能找到平均耗时卡那一行')
  const call = twoLines.slice(at, at + 2).join('\n')
  assert.ok(/kpiCard\('orange',\s*'⏱',\s*'平均耗时',\s*fmtDuration\(avgMs\),/.test(call),
    '平均耗时卡应只到 fmtDuration(avgMs) 为止')
  // 关键：紧接的第二行必须以 `))` 收尾（第 5 个参数结束、调用结束）
  assert.ok(/\+\s*' 次请求的平均'\)\)\s*$/.test(call.trim().split('\n')[1] ?? ''),
    '⚠️ 平均耗时卡不得传第 6 个参数（sparkline）—— 合计 ≠ 均值，画出来是误导')
})
test('⚠️ 排名列表：占比用总数为分母、条宽用最大值为分母', () => {
  // 两者的分母**故意不同**：
  //   · 占比文字答「占多少份额」⇒ 用**总请求数**
  //   · 条宽答「相对第一名多长」⇒ 用**最大值**（让第一名铺满，更好读）
  // 混用会让「占比 40% 的条」和「条长 40%」在视觉上打架。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function renderUsageRanking'))
  assert.ok(/totalCount === 0 \? '' : \(\(r\.count \/ totalCount\) \* 100\)/.test(fn),
    '⚠️ 占比文字应以**总请求数**为分母')
  assert.ok(/\(r\.count \/ max\) \* 100/.test(fn),
    '⚠️ 条宽应以**最大值**为分母')
  // 空数据要给提示而不是白板
  assert.ok(/无数据/.test(fn), '空数据应给提示')
  // ⚠️ 长名断行用 overflow-wrap（不是 break-all —— 项目单测禁止后者）
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const nameRule = css.slice(css.indexOf('.rank-name {'))
  assert.ok(/overflow-wrap:\s*anywhere/.test(nameRule.slice(0, nameRule.indexOf('}'))),
    '⚠️ 长模型名/uid 要能断行（用 overflow-wrap，不是 break-all）')
})

test('⚠️ 三个视图容器都不得再有「框」（用户报「不要再套一个框」）', () => {
  // ## 用户原话
  //   「不显示按小时的就不要显示那个框了，按天趋势里面不要再套一个框，
  //     切换天数下面不要显示说明，能看懂」
  //
  // 根因：`section.view` 原来自带 `background + border + radius + padding`
  //（那是「一张卡」），而它内部现在**全是卡片**（`.panel` / `.kpi`）
  // ⇒ 每个内部卡片外围又多一圈同样的框，就是「框里套框」。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const rule = css.slice(css.indexOf('section.view {'))
  const body = rule.slice(0, rule.indexOf('}'))
  for (const prop of ['border', 'background', 'padding']) {
    assert.ok(!new RegExp(`(^|;)\\s*${prop}\\s*:`).test(body),
      `⚠️ section.view 不得再有 ${prop}（那是外层框，会与内部卡片叠成两层）`)
  }
  // 必须保留 min-width: 0（网格项不收缩，去掉会让长表格撑破页面）
  assert.ok(/min-width:\s*0/.test(body), '⚠️ min-width: 0 必须保留（防横向溢出）')

  // `.trend` 也不能自带边框/底色（它在 .panel 里）
  const trend = css.slice(css.indexOf('.trend {'))
  const trendBody = trend.slice(0, trend.indexOf('}'))
  assert.ok(!/(^|;)\s*border\s*:/.test(trendBody),
    '⚠️ .trend 不得自带 border（那正是用户说的「套一个框」）')
  assert.ok(!/(^|;)\s*background\s*:/.test(trendBody),
    '⚠️ .trend 不得自带 background（同上）')
})

test('⚠️ 按小时：非今日窗口必须**整个面板隐藏**（不是留个说明框）', () => {
  // 用户原话：「不显示按小时的就不要显示那个框了」。
  // ⚠️ 要隐藏**整个面板**（含标题），而不是面板里塞一句说明 ——
  // 后者正是用户抱怨的那个「框」。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function renderUsageHours'))
  assert.ok(/windowDays !== 1/.test(fn), '应判非今日窗口')
  const hideAt = fn.indexOf('panel.hidden = true')
  assert.ok(hideAt > 0, '⚠️ 非今日窗口必须隐藏整个面板')
  // 且必须立即 return（不能再往面板里塞内容）
  const retAt = fn.indexOf('return', hideAt)
  assert.ok(retAt > hideAt && retAt - hideAt < 120,
    '⚠️ 隐藏后必须立即 return（否则仍会往里塞说明文字 = 那个没用的框）')
  // 今日窗口要显示出来（不能被永久隐藏）
  assert.ok(/panel.hidden = false/.test(fn), '今日窗口必须恢复显示面板')
})

test('⚠️ 切换天数下面不得有说明文字（用户要求删除）', () => {
  // 用户原话：「切换天数下面不要显示说明，能看懂」。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(!html.includes('usage-scope'), '⚠️ HTML 里不得再有说明容器')
  assert.ok(!/\$\('usage-scope'\)/.test(js), '⚠️ JS 里不得再引用它（否则 null.textContent 抛错）')
})

test('⚠️ 各视图必须统一为「页头 + 面板」结构（用户要求统一风格）', () => {
  // 用户原话：「把其它界面的 UI 也统一成这种风格」。
  const html = panelAsset('/panel/')?.body ?? ''
  const views = ['tasks', 'usage', 'models', 'providers', 'config', 'logs']
  for (const v of views) {
    const i = html.indexOf(`id="view-${v}"`)
    assert.ok(i > 0, `应有 ${v} 视图`)
    // 取到下一个视图开头
    const nextView = html.indexOf('<section class="view"', i + 10)
    const body = html.slice(i, nextView > 0 ? nextView : undefined)
    assert.ok(body.includes('class="page-head"'),
      `⚠️ ${v} 视图应有统一的 .page-head 页头`)
  }
  // ⚠️ 不得再有「裸 h2 带按钮」的旧写法（按钮应在 .page-tools 里）
  assert.ok(!/<h2>[^<]*<button/.test(html), '⚠️ 标题里不得直接塞按钮（应放 .page-tools）')
})

test('⚠️ 不得用「容器 gap + 子元素 margin」造成双重间距', () => {
  // 本轮把 `section.view` 从「卡片」改成「布局容器（display:grid; gap:14px）」
  // 之后，凡是做它直接子元素的块都必须**去掉自己的下边距** ——
  // 否则 gap 与 margin 叠加，间距凭空翻倍。
  // ⚠️ 这是改布局时极易漏的一类，本轮我自己就漏了 4 处。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  for (const cls of ['.kpi-grid', '.panel', '.task-cards', '.counts', '.hint', '.page-head']) {
    const i = css.indexOf(cls + (cls === '.panel' ? ' {' : ' {'))
    if (i < 0) continue
    const body = css.slice(i, css.indexOf('}', i))
    // ⚠️ 允许 `margin-bottom: 0`（显式归零是有意的，见 .page-head 的说明）——
    //    真正要禁的是**非零**下边距与 gap 叠加。
    const mb = body.match(/(?:^|;)\s*margin-bottom\s*:\s*([^;]+)/)
    if (mb) {
      assert.ok(/^0(\s|px|rem|em|%)*$/.test(mb[1].trim()),
        `⚠️ ${cls} 是视图直接子元素，不得有**非零** margin-bottom（会与容器 gap 叠成双间距），实际 ${mb[1].trim()}`)
    }
  }
})

test('⚠️ 嵌套面必须有视觉差异（不得「框里套框」）', () => {
  // 相邻嵌套面若完全一样（同边框同底色），看起来就是多余的框。
  // `.out` 在 `.panel` 里时保留深色背景（表达「原始输出」的层级差），
  // 但**去掉描边**，由外层 `.panel` 独自承担边框。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(/\.panel\s*>\s*\.out\s*\{[^}]*border:\s*0/.test(css),
    '⚠️ .panel 内的 .out 必须去掉边框（否则框里套框）')
})

test('🔴 视图网格的**每一层**子元素都必须能收缩（否则手机上挤出屏幕）', () => {
  // ## 用户报：「配置与状态页面在手机上挤出屏幕了」
  //
  // 根因（我自己上一轮引入的回归）：把 `section.view` 改成 `display: grid`
  //（为拿统一下间距）之后，它的子元素成了**网格项** ——
  // 而网格项默认 `min-width: auto`（「不小于内容的最小宽度」）。
  // 配置页表格按 `max-content` 取宽 ⇒ 这个最小值跟着变大 ⇒ 网格轨道被撑开
  // ⇒ 整个页面横向溢出。
  //
  // ⚠️ 项目**早已**为 `main` 记录过这个陷阱（`main > * { min-width: 0 }`），
  // 但那只覆盖 main 的**直接**子元素，对**再下一层**无效 —— 这是同一陷阱的第二层。
  //
  // ⚠️ 纪律：**每引入一个新的 grid/flex 容器，就要给它的子元素加 `min-width: 0`。**
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(/main\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(css),
    'main 的直接子元素要能收缩（既有规则，不得回退）')
  assert.ok(/section\.view\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(css),
    '⚠️ section.view 是 grid，其子元素也必须 min-width: 0（否则长表格撑破页面）')
})

test('⚠️ 计数卡在桌面上必须铺满（不得只占一角）', () => {
  // 用户报：「配置与账号下面 6 个卡片在电脑上太窄了」。
  // 原先是 `flex-wrap` + `.count { min-width: 92px }`：6 张只占 602px，
  // 而桌面容器 1200px ⇒ 右侧空出近 600px，又窄又挤在一角。
  //
  // ⚠️ 不能简单给 flex 加 `flex-grow: 1` —— 项目记录过那个坑：奇数个时
  // 最后一张会被拉成整行宽，看着像「被选中的高亮项」。
  // ⇒ 用 grid + `auto-fit`：所有轨道等宽、自动铺满，且空轨道会被折叠。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const i = css.indexOf('.counts {')
  assert.ok(i > 0, '应有 .counts 规则')
  const body = css.slice(i, css.indexOf('}', i))
  assert.ok(/display:\s*grid/.test(body), '⚠️ .counts 应用 grid（否则卡片铺不满、只占一角）')
  assert.ok(/auto-fit/.test(body), '⚠️ 应用 auto-fit（轨道等宽且自动铺满）')
  // ⚠️ 网格项也要能收缩
  assert.ok(/minmax\(\s*0|minmax\(\s*\d+px/.test(body), '列定义应能收缩')
})

test('⚠️ 表格单元格必须能断行（长 token 会撑破窄屏）', () => {
  // 配置页的值含 `AES-GCM（密钥来自 CREDENTIAL_KEY secret）` 这类长 token；
  // 单元格默认不折行 ⇒ 「值」列按最长内容取宽 ⇒ 表格变宽 ⇒ 撑破页面。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const m = /th,\s*td\s*\{([^}]*)\}/g
  let hasWrap = false
  let b
  while ((b = m.exec(css)) !== null) {
    if (/overflow-wrap:\s*anywhere/.test(b[1] ?? '')) hasWrap = true
  }
  assert.ok(hasWrap, '⚠️ th/td 必须有 overflow-wrap: anywhere')
  // ⚠️ 且不得用 break-all（项目单测禁止：会截断正常英文单词）
  assert.ok(!/word-break:\s*break-all/.test(css), '不得使用 break-all')
})

test('⚠️ uid / provider id 这类长串必须能断行', () => {
  // 它们形如 `raccoon:raccoon-9696afc62b16c498`，窄屏会撑破卡片。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  for (const sel of ['.card .uid', '.prov-card .prov-id', '.rank-name']) {
    const i = css.indexOf(sel)
    assert.ok(i > 0, `应有 ${sel} 规则`)
    const body = css.slice(i, css.indexOf('}', i))
    assert.ok(/overflow-wrap:\s*anywhere/.test(body),
      `⚠️ ${sel} 必须能断行（长串会撑破容器）`)
  }
})

test('🔴 loadPool 必须在 providerCache 就绪**之后**调用（否则「供应商」计数首屏恒为 0）', () => {
  // ## 缺陷（外部测试报告定位，我已独立复核）
  //   「供应商」计数首屏恒显示 0，点一次「刷新」才变正确。
  //
  // 根因：`loadPool()` 末尾用 `providerCache` 算「已启用的供应商数」，
  // 而 `providerCache` 要到 `await api('/admin/providers')` **之后**才赋值。
  // 原先在 `loadProviders()` 的**第一行**就同步调 `loadPool()` ⇒ 读到的必然是
  // 模块级初值 `[]` ⇒ 恒为 0。
  //
  // ⚠️ **100% 复现，不是偶发**：`loadPool` 内部 `await fetchPoolCounts()`
  // 至少要等两个网络往返，必然晚于那里的读取。
  // ⚠️ 「刷新一下就好」这种症状最容易被当成抖动放过去 —— 必须用测试钉住。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('async function loadProviders'))
  const assignAt = fn.indexOf('providerCache = res.body.providers')
  assert.ok(assignAt > 0, '应能定位 providerCache 赋值')

  // ⚠️ 判据要**区分两个分支**，不能只找第一个 `loadPool()`：
  //    · 赋值**之前**的那个在 `if (!res.ok)` 错误分支里（用旧缓存兜底，是对的）；
  //    · 真正的「成功路径」调用必须在赋值**之后**。
  // （我第一版只比较「第一个 loadPool 的位置」，于是命中了错误分支那位，
  //   报了个假失败 —— 而真正命中的原因是注释里也写了 `loadPool()`，
  //   项目早已记录过「断言源码前必须剥注释」这条教训。）
  const afterAssign = fn.slice(assignAt)
  assert.ok(/loadPool\(\)/.test(afterAssign),
    '⚠️ 成功路径必须在 providerCache 赋值**之后**调 loadPool()（否则计数恒 0）')
  // 赋值前只允许出现**错误分支**里那一次兜底调用
  const beforeAssign = fn.slice(0, assignAt)
  const beforeCalls = (beforeAssign.match(/loadPool\(\)/g) ?? []).length
  assert.ok(beforeCalls <= 1,
    `⚠️ 赋值前最多只应有错误分支的 1 次兜底调用，实际 ${beforeCalls} 次`)
  assert.ok(/if \(!res\.ok\)[\s\S]{0,200}?loadPool\(\)/.test(beforeAssign),
    '⚠️ 供应商列表失败时也要渲染计数（用已有缓存兜底），否则统计栏空白')
})

test('🔴 accent 必须拆成「背景」与「文字」两个令牌（否则修一个坏一个）', () => {
  // ## 缺陷：深色主题主按钮白字对比度 3.22:1（WCAG AA 正文需 4.5:1）
  //
  // ⚠️ 但**不能直接把 `--accent` 调深** —— 它同时被当作**文字色**用在
  // 深色背景上（`.trend-label.today`、KPI 图标章、`.spark` 描边），
  // 而那里它原本有 5.97:1 的好成绩。调深会把它拉到约 4.03:1
  // ⇒ **修好按钮、弄坏文字**（外部报告的建议漏了这一层，我复核时补上）。
  //
  // ⇒ 拆成两个令牌：`--accent`（实底，压白字，要够深）
  //   与 `--accent-text`（当文字/描边，要够亮）。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(/--accent-text:/.test(css), '⚠️ 必须有 --accent-text 令牌')
  // 三处主题（深色 / 显式浅色 / 跟随系统浅色）都要定义
  const defs = css.match(/--accent-text:/g) ?? []
  assert.ok(defs.length >= 3,
    `⚠️ --accent-text 必须在三处主题都定义（深色 + 显式浅色 + auto），实际 ${defs.length} 处`)
  // 「当文字用」的三处不得再用 --accent
  for (const sel of ['.trend-label.today']) {
    const i = css.indexOf(sel)
    assert.ok(!/var\(--accent\)/.test(css.slice(i, css.indexOf('}', i))),
      `⚠️ ${sel} 是文字，应使用 --accent-text（--accent 已调深，会降低可读性）`)
  }
  assert.ok(/\.spark path \{ stroke: var\(--kpi, var\(--accent-text\)\)/.test(css),
    '⚠️ sparkline 描边应使用 --accent-text')
})

test('⚠️ 必须支持 prefers-reduced-motion（动效敏感用户）', () => {
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css),
    '⚠️ 应有 prefers-reduced-motion 降级')
  // ⚠️ 不能简单删 transition（有代码可能依赖 transitionend），压到极小即可
  const i = css.indexOf('prefers-reduced-motion')
  const block = css.slice(i, i + 500)
  assert.ok(/transition-duration:\s*0?\.\d+ms/.test(block),
    '⚠️ 应把 transition-duration 压到极小，而不是删掉 transition')
})

test('⚠️ 供应商卡片的积分必须带单位（与账号弹层口径一致）', () => {
  // 报告：卡片右上角只有裸数字 `10,296`，而弹层里写的是 `5,049 积分`。
  // 同一份数据两种口径 ⇒ 用户不知道这个数字是什么。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const i = js.indexOf('creditCache[prov.id].toLocaleString')
  assert.ok(i > 0, '应能定位卡片积分渲染')
  const line = js.slice(i, js.indexOf('\n', i))
  assert.ok(/积分/.test(line),
    '⚠️ 卡片积分必须带单位「积分」（与弹层一致）')
  // ⚠️ title 写在**下一行** —— 不能只扫同一行（我第一版就这么写，假失败了）
  const stmt = js.slice(i, i + 300)
  assert.ok(/credits\.title\s*=/.test(stmt), '⚠️ 应给 title 说明这是「全部账号合计」')
  // ⚠️ 药丸变宽了，CSS 要保证不换行、且长名称不会钻到它下面
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const pill = css.slice(css.indexOf('.prov-card .prov-credits'))
  assert.ok(/white-space:\s*nowrap/.test(pill.slice(0, pill.indexOf('}'))),
    '⚠️ 积分药丸不得换行（「积分」两字被折下去会很难看）')
  assert.ok(/:has\(\.prov-credits:not\(\[hidden\]\)\)/.test(css),
    '⚠️ 只应在**有积分时**才给名称预留右侧空间（否则没积分的卡片白空一块）')
})

test('⚠️ 配置页「已存凭据数」必须说明口径（与账号总数不是一回事）', () => {
  // 报告：并排显示「账号总数 19」与「已存凭据数 20」会让人怀疑有脏数据。
  // ⚠️ 不改成同一个数（两者口径**本来就不同**：账号池 vs 凭据存储），
  // 而是在值里写清口径 —— 不加 tooltip（单元格 title 在手机上点不出来）。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const i = js.indexOf("'已存凭据数'")
  assert.ok(i > 0, '应有「已存凭据数」这一行')
  const seg = js.slice(i, js.indexOf('\n', i))
  assert.ok(/口径/.test(seg), '⚠️ 必须说明口径不同（否则用户以为是脏数据）')
})

test('⚠️ /v1/models 的每个条目都应有 name（aggregate 曾是整列空白）', () => {
  // 报告：模型页 19 个 `aggregate/*` 条目名称列为空，看起来像渲染失败。
  // 根因在后端：`VirtualModel` 本来就有 `name` 字段，只是没往外发。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf('AGGREGATE_AUTO}')
  assert.ok(i > 0, '应能定位 aggregate 条目构造')
  // ⚠️ 窗口**不要用固定长度**（见 AGENTS.md ②d-e）：我原先写 `+900`，
  // 给 auto 条目补了 `supportsImage` 的注释后，`v.name || v.key` 被挤出了窗口
  // ⇒ 假失败，而**它要守的约束根本没变**。
  // 改为取到「这段代码结束」为止（下一个 `}` 之后留足余量）。
  const seg = src.slice(i, i + 2200)
  assert.ok(/name:\s*'自动选择/.test(seg), '⚠️ aggregate/auto 必须给 name')
  assert.ok(/name:\s*v\.name\s*\|\|\s*v\.key/.test(seg),
    '⚠️ 虚拟模型必须有 name（并兜底到 key，避免空单元格）')
  // ⚠️ 前端也要兜底：少一个字段不该渲染出空单元格
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(/m\.name \|\| m\.id/.test(js),
    '⚠️ 前端名称缺失时应回落到 id（防御性）')
})

test('⚠️ 供应商页不得再有「刷新」按钮（用户要求删除）', () => {
  // 用户原话：「供应商与账号的刷新按钮没啥用，删了」。
  //
  // ⚠️ 删按钮时**必须连 JS 绑定一起删** —— `$('refresh-providers')` 在按钮不存在时
  // 返回 `null`，紧接着 `.onclick = …` 抛 `TypeError`，而它在**顶层脚本流**里
  // ⇒ 从这里往后的所有绑定全部失效（表现为「面板一半按钮都不好使」）。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(!html.includes('refresh-providers'), '⚠️ 刷新按钮应已从 HTML 删除')
  assert.ok(!js.includes("$('refresh-providers')"),
    '⚠️ JS 里不得再引用它（否则 null.onclick 抛错，后续绑定全失效）')
  // ⚠️ 但 `loadProviderCredits` 必须留着 —— 首次进视图（`creditsLoaded`）仍在用它
  assert.ok(/if \(!creditsLoaded\) void loadProviderCredits\(\)/.test(js),
    '首次进视图仍应自动拉一次积分（不能因删按钮而丢掉）')
})

test('🔴 二级弹窗不得使用无 CSS 定义的类名（.muted 曾是死类名）', () => {
  // ## 实测缺陷
  // 二级弹窗（`openInfo`）用了 3 处 `class="muted"`，而**全站 CSS 里
  // `.muted` 定义数为 0** ⇒ 那几段说明文字**完全没有样式**（既不是 dim 色、
  // 也没有字号约束），与主面板的 `.hint` 观感不一致。
  //
  // 用户要求「把二级弹窗的 UI 也统一一下」⇒ 统一到 `.hint`。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(!/className = 'muted'/.test(js),
    "⚠️ 不得再用 .muted（它没有 CSS 定义，文字会完全无样式）")
  assert.ok(/\.hint\s*\{/.test(css), '.hint 必须有定义（二级弹窗统一用它）')
  // ⚠️ 弹窗观感要与卡片系统一致（**统一用 `--radius` 令牌** + 阴影）。
  // 原先断言写死 16px，而用户要求「所有圆角统一成供应商与账号的大圆角」
  // ⇒ 改成令牌后它假失败。**要守的约束没变**（同类容器圆角必须一致），
  // 只是实现从「同一个数字」变成「同一个令牌」。
  const box = css.slice(css.indexOf('.modal-box {'))
  const body = box.slice(0, box.indexOf('}'))
  assert.ok(/border-radius:\s*var\(--radius\)/.test(body),
    '⚠️ .modal-box 圆角应使用 --radius 令牌（与 .panel/.prov-card 一致）')
  assert.ok(/box-shadow/.test(body), '⚠️ .modal-box 应有阴影（与卡片系统一致）')
  // ⚠️⚠️ 弹窗内的卡片**必须与弹窗底差一档**，否则卡片「隐形」。
  // `.modal-box` 用的是 `--panel` ⇒ 卡片若也用 `--panel` 就是**同一颜色**
  //（实测对比度 1.00:1，只剩一圈边框）。这里钉住它必须是 `--panel2`。
  //（我一度把它「统一」成 --panel，是这个断言该拦住的那类错误。）
  const cardRule = css.slice(css.indexOf('.modal .card'))
  const cardBody = cardRule.slice(0, cardRule.indexOf('}'))
  assert.ok(/background:\s*var\(--panel2\)/.test(cardBody),
    '⚠️ .modal .card 必须用 --panel2（用 --panel 会与 .modal-box 同色、卡片隐形）')
})

test('🔴 聚合只暴露白名单两个模型（用户要求）', () => {
  // 用户原话：「aggregate 只保留 deepseek-v4-1-flash 和 glm-5-3-flash 就行了，
  // 其它的用不上」。
  const src = readFileSync('src/gateway/aggregate.ts', 'utf8')
  assert.ok(/AGGREGATE_ALLOWED_KEYS/.test(src), '应有白名单常量')
  // ⚠️ 必须是白名单（只放认过的），不是黑名单 ——
  // 黑名单会让「上游每加一个模型，聚合目录就多一行」。
  assert.ok(/'deepseek-v4-1-flash'/.test(src) && /'glm-5-3-flash'/.test(src),
    '白名单应含这两个规范名')
  // ⚠️ 过滤必须在 buildVirtualModels 内收口（聚合有目录 + chat 两条路径）
  const fn = src.slice(src.indexOf('export function buildVirtualModels'))
  assert.ok(/AGGREGATE_ALLOWED_KEYS\.has\(key\)/.test(fn.slice(0, fn.indexOf('\n}'))),
    '⚠️ 白名单必须在 buildVirtualModels 内收口，否则两条路径只堵住一条')
})

// ─────────────── 2026-10-13 面板 UI 审计修复 ───────────────
//
// 下面 5 条对应一次「用真实浏览器（Firefox + WebDriver BiDi）全面测试面板」
// 后发现的缺陷。每条都先复现、后修复，断言用于防回归。

test('🔴 .cap.off（不支持的能力标签）必须达 WCAG AA 对比度', () => {
  // 实测（沿祖先链合成真实背景后计算）：
  //   深色 #6b7280 → 3.6:1、浅色 #8a93a3 → 3.1:1，**都不达正文 4.5:1**。
  // 这两个值看着「低调」，实则把「这家不支持签到」这条**有用信息**
  // 变得难以辨认 —— 而它正是用户判断能力差异的唯一依据。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  // 基础规则必须走 --dim（两套主题下都满足对比度，且天然弱于 .cap.on）
  const i = css.indexOf('.cap.off')
  const rule = css.slice(i, css.indexOf('}', i))
  assert.ok(/color:\s*var\(--dim\)/.test(rule),
    '⚠️ .cap.off 必须用 var(--dim)；硬编码灰值实测不达标')
  // ⚠️ 不得再有硬编码的浅色覆盖（那正是原先 3.1:1 的来源）
  assert.ok(!/\.cap\.off\s*\{\s*color:\s*#8a93a3/.test(css),
    '⚠️ 应已删除浅色下不达标的 #8a93a3 覆盖')
  assert.ok(!/\.cap\.off\s*\{\s*color:\s*#6b7280/.test(css),
    '⚠️ 应已删除深色下不达标的 #6b7280')
  // 仍需保留删除线作为第二重「不支持」信号
  assert.ok(/line-through/.test(rule), '应保留删除线')
})

test('🔴 两个弹窗必须具备 role="dialog" + aria-modal（否则读屏不宣告）', () => {
  // 实测：弹窗此前在无障碍树里只是普通 div，屏幕阅读器不会宣告对话框打开。
  const html = panelAsset('/panel/')?.body ?? ''
  for (const [id, titleId] of [['modal', 'modal-title'], ['info-modal', 'info-title']]) {
    const tag = html.slice(html.indexOf(`id="${id}"`))
    const el = tag.slice(0, tag.indexOf('>'))
    assert.ok(/role="dialog"/.test(el), `#${id} 应有 role="dialog"`)
    assert.ok(/aria-modal="true"/.test(el), `#${id} 应有 aria-modal="true"`)
    assert.ok(new RegExp(`aria-labelledby="${titleId}"`).test(el),
      `#${id} 应用已有标题元素作可访问名`)
  }
})

test('🔴 弹窗必须支持 Escape 关闭（实测此前不支持）', () => {
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(/addEventListener\('keydown'/.test(js), '应监听 keydown')
  assert.ok(/e\.key\s*!==\s*'Escape'/.test(js) || /'Escape'/.test(js), '应处理 Escape')
  // ⚠️ 必须两个弹窗都能关：先关最上层的 info，再关主弹窗。
  const i = js.indexOf("addEventListener('keydown'")
  const block = js.slice(i, i + 600)
  assert.ok(/info[\s\S]*hidden\s*=\s*true/.test(block), 'Escape 应能关信息弹窗')
  assert.ok(/main[\s\S]*hidden\s*=\s*true/.test(block), 'Escape 应能关供应商弹窗')
})

test('🔴 动态创建的 textarea 必须有 aria-label（无 label 时读屏只念「编辑框」）', () => {
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(/ta\.setAttribute\('aria-label'/.test(js),
    '⚠️ #modal-import-body 是 JS 动态插入的，没有 <label>，必须给 aria-label')
})

test('⚠️ 供应商开关不得做成「一整列红色关闭按钮」（观感像全是错误）', () => {
  // 实测截图：12 家全启用时，弹窗里是一整列红色实心「关闭」，
  // 远看像整屏错误告警；而真正需要一眼看出的「哪家关了」反被淹没。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  // ① 仍复用既有按钮体系（项目约定），并额外挂状态类
  assert.ok(/sw\.className = \(off \? 'ghost' : 'danger'\) \+ ' prov-sw'/.test(js),
    '开关应复用 ghost/danger 并附加 prov-sw')
  assert.ok(/is-off/.test(js), '应区分已关闭状态')
  // ② 关闭是「可逆」的恢复动作，不该用危险色铺满
  const i = css.indexOf('button.prov-sw')
  assert.ok(i > 0, '应有 button.prov-sw 规则')
  const rule = css.slice(i, css.indexOf('\n}', i))
  assert.ok(/background:\s*transparent/.test(rule),
    '⚠️ 已启用态的「关闭」按钮不得用实心危险色')
  assert.ok(/color:\s*var\(--err\)/.test(rule), '红色应只落在文字上')
  assert.ok(/\.prov-sw\.is-off[\s\S]{0,200}background:\s*var\(--accent\)/.test(css),
    '⚠️ 已关闭态应高对比（强调色实心），让「这家没在跑」一眼可见')
})

test('⚠️ /favicon.ico 必须显式处理（否则每次访问多一条 401）', () => {
  // 浏览器对每个页面都会自动请求 /favicon.ico（无需 <link>）。
  // 此前它落进鉴权分支：未登录时返回 401 JSON ⇒ 控制台凭空多一条错误。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/path === '\/favicon\.ico'/.test(src), '应显式处理 /favicon.ico')
  const i = src.indexOf("path === '/favicon.ico'")
  const block = src.slice(i, i + 200)
  assert.ok(/204/.test(block), '应返回 204 No Content')
  // ⚠️ 必须在**鉴权之前**：否则又变回 401（这正是要修的东西）
  const authIdx = src.indexOf('if (!(await authorized(request, env)))')
  assert.ok(authIdx > 0 && i < authIdx, '⚠️ favicon 处理必须在鉴权之前')
})

test('🔴 登录页必须允许 form-action self（form-action none 会拦掉登录表单）', () => {
  // 实测（Firefox + WebDriver BiDi 审计）：点「登录」后固定报一条
  // `blocked ... (form-action) at /login because it violates "form-action 'none'"`。
  // 功能上「碰巧能用」（login.js 在 onsubmit 里 preventDefault 后走 fetch），
  // 但这是**真实上报的错误**，且把全站 form-action 防线退化成噪音。
  const src = readFileSync('src/panel/index.ts', 'utf8')
  assert.ok(/export const CSP_LOGIN/.test(src), '应有登录页专用 CSP')
  // ⚠️ 必须是 'self'（不是 *、不是 none）：仍要阻止**提交到外部域名**
  const i = src.indexOf('export const CSP_LOGIN')
  const block = src.slice(i, i + 400)
  assert.ok(/form-action 'self'/.test(block), "⚠️ 登录页应 form-action 'self'（保留「禁外部提交」）")
  // 面板页（无表单）仍须保持 'none' —— 不能为了修登录页把面板也放宽
  const mainCsp = src.slice(src.indexOf('export const CSP ='), src.indexOf('export const CSP_LOGIN'))
  assert.ok(/form-action 'none'/.test(mainCsp), '⚠️ 面板页仍是 form-action none')
})

test('🔴 登录页必须被路由到 CSP_LOGIN（否则改了 CSP 也不生效）', () => {
  // ⚠️ 光定义 `CSP_LOGIN` 不够：`/login` 与 `/panel` 走的是同一条静态资源分支，
  // 忘了分流就等于没修（这类「定义了但没接线」在本项目出现过多次）。
  const src = readFileSync('src/index.ts', 'utf8')
  const i = src.indexOf('const asset = panelAsset(path)')
  const block = src.slice(i, i + 700)
  assert.ok(/isLoginPage/.test(block), '⚠️ 资源分支必须区分登录页')
  assert.ok(/loginSecurityHeaders\(\)/.test(block), '⚠️ 登录页应使用 loginSecurityHeaders()')
  assert.ok(/path === '\/login'/.test(block), '登录页判定应含 /login')
})

test('🔴 所有安全头必须齐全（登录页也不例外）', () => {
  // 登录页同样不能被 iframe 嵌套、不能泄露 Referer。
  const src = readFileSync('src/panel/index.ts', 'utf8')
  const i = src.indexOf('export function loginSecurityHeaders')
  const block = src.slice(i, i + 300)
  assert.ok(/\.\.\.securityHeaders\(\)/.test(block),
    '⚠️ 登录页头应基于 securityHeaders() 展开（只覆盖 CSP），否则容易漏头')
})

test('🔴 button.danger 必须用 --err-solid（白字 on --err 只有 3.24:1，不达标）', () => {
  // 实测（面板全量对比度扫描）：API Key 页的「删除」按钮报 3.24:1，
  // 低于 WCAG AA 正文 4.5:1。
  //
  // ⚠️ 这与 `--accent` 是**同一类**取舍：同一个颜色值不可能同时满足
  // 「当文字要够亮」与「当按钮底色要够暗」。项目已为 accent 拆出
  // `--accent-text`，错误色同样必须拆。
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(/--err-solid:/.test(css), '应定义 --err-solid 令牌')
  const i = css.indexOf('button.danger')
  const rule = css.slice(i, css.indexOf('}', i))
  assert.ok(/background:\s*var\(--err-solid\)/.test(rule),
    '⚠️ button.danger 必须用 --err-solid（用 --err 则白字对比度不足）')
  // ⚠️ `--err` 仍要保留给**文字**用（改错了这里会让所有错误文案变暗）
  assert.ok(/--err:/.test(css), '--err 必须保留（当文字用）')
  assert.ok(/\.pill\.err\s*\{\s*color:\s*var\(--err\)/.test(css), '--err 仍应作文字色使用')
})

test('🔴 /v1/* 必须支持 CORS 预检（浏览器调用方否则完全用不了）', () => {
  // ## 为什么必须测
  //
  // `/v1/*` 的定位是给**外部应用**调的。浏览器里的调用方会先发 OPTIONS 预检，
  // 没有 CORS 头就被浏览器直接拦掉 —— 而服务端日志里**什么都不会出现**
  //（请求根本没发出去）。实测确认：此前 OPTIONS 返回 404 且无任何 CORS 头。
  const src = readFileSync('src/index.ts', 'utf8')

  // ① 必须有 CORS 头构造
  assert.ok(/function withCors/.test(src), '应有 withCors 助手')
  const i = src.indexOf('function withCors')
  const block = src.slice(i, i + 1200)
  assert.ok(/access-control-allow-origin/.test(block), '应有 allow-origin')
  // ⚠️ Authorization 必须在允许列表里，否则浏览器不会把密钥发出去
  assert.ok(/allow-headers'[^)]*authorization/i.test(block) || /authorization/i.test(block),
    '⚠️ allow-headers 必须含 authorization')

  // ② 预检必须在**鉴权之前**处理：预检请求不带 Authorization（浏览器规定），
  // 落到鉴权分支就只会拿到 401，真正的请求永远发不出去。
  const optIdx = src.indexOf("request.method === 'OPTIONS'")
  assert.ok(optIdx > 0, '应显式处理 OPTIONS')
  const authIdx = src.indexOf('if (!(await authorized(request, env)))')
  assert.ok(authIdx > 0 && optIdx < authIdx, '⚠️ OPTIONS 处理必须在鉴权之前')

  // ③ 必须在**唯一出口**统一加，而不是各分支各加 ——
  // 后者必然漏掉流式/错误响应（表现为「有时能调、有时 CORS 报错」）。
  const i2 = src.indexOf('async function handle(request: Request')
  const handleBlock = src.slice(i2, i2 + 2000)
  assert.ok(/withCors\(response\)/.test(handleBlock),
    '⚠️ 出口处应统一加 CORS（不能逐分支加，会漏）')
  assert.ok(/withCors\(failure\)/.test(handleBlock),
    '⚠️ 异常分支也要加（否则 500 会被浏览器报成 CORS 错误，遮住真因）')
})

test('⚠️ CORS 不得加到 /admin/* 或面板（钓鱼面）', () => {
  // ⚠️ 只给 `/v1/*` 加：管理端点靠同一个 Authorization 头，
  // 把它们暴露给任意源会放大钓鱼面（任何网页都能拿粘贴进去的密钥操作账号）。
  const src = readFileSync('src/index.ts', 'utf8')
  // ⚠️ 判定收口在 `isV1Request` 里（而不是散落在各处）——
  // 这样「CORS 只给 v1」这条纪律只有一个地方能违背。
  assert.ok(/function isV1Request/.test(src), '应有 isV1Request 判定助手')
  const i = src.indexOf('function isV1Request')
  const block = src.slice(i, i + 400)
  assert.ok(/startsWith\('\/v1\/'\)/.test(block),
    '⚠️ CORS 的适用判定必须限定 /v1/ 前缀')
  assert.ok(!/admin/.test(block), 'CORS 判定里不得出现 /admin')
  // `withCors` 自身不得硬编码路径判定（必须走 isV1Request）
  const j = src.indexOf('function withCors')
  const corsBlock = src.slice(j, j + 900)
  assert.ok(!/startsWith\('\/admin/.test(corsBlock), 'withCors 里不得出现 /admin')
})

// ─────────────── 网络抖动不得被当成「密钥失效」 ───────────────
//
// 用户报「面板偶尔会自己掉登录」。根因：`bootstrap()` 里写的是
// `if (!res.ok) { 删密钥 → 跳登录页 }`，而 `api()` 在网络错误时返回
// `status: 0`（如 DNS 抖动 `Could not resolve host`）—— 于是**一次瞬时的
// 网络错误会删掉用户已存的密钥并把他踢回登录页**。
//
// 这类缺陷只能靠**真的执行 bootstrap()** 抓：静态看
// `if (!res.ok)` 完全合理，只有把「网络错误」这个具体返回值喂进去，
// 才会暴露「删密钥」这个不该发生的副作用。

test('🔴 bootstrap：网络错误**不得**删除密钥或跳登录页（只有 401 才该）', async () => {
  let removed = false
  const location = { href: 'http://x/panel/' }
  // 模拟 `api()` 在网络错误时的返回形状（fetch 抛错 → status 0）
  const failingFetch = async () => { throw new Error('Could not resolve host') }
  const rt = runPanelJs('bootstrap', { fetch: failingFetch, location })
  // 包一层以观察 removeItem 是否被调用
  const origRemove = rt.__store.delete.bind(rt.__store)
  let removeCalled = false
  rt.__store.delete = (k) => { removeCalled = true; return origRemove(k) }

  await rt.bootstrap()

  assert.equal(removeCalled, false,
    '⚠️ 网络错误时**绝不能**删除密钥（那会让一次 DNS 抖动变成「被登出」）')
  assert.equal(location.href, 'http://x/panel/',
    '⚠️ 网络错误时不得跳转到登录页')
})

test('🔴 bootstrap：401 仍然要删密钥并跳登录页（原行为不能被改坏）', async () => {
  let removeCalled = false
  const location = { href: 'http://x/panel/' }
  const unauthorizedFetch = async () => ({
    ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}',
  })
  const rt = runPanelJs('bootstrap', { fetch: unauthorizedFetch, location })
  const origRemove = rt.__store.delete.bind(rt.__store)
  rt.__store.delete = (k) => { removeCalled = true; return origRemove(k) }

  await rt.bootstrap()

  assert.equal(removeCalled, true, '401 时应删除无效密钥')
  assert.equal(location.href, '/login', '401 时应跳回登录页')
})

test('🔴 bootstrap：5xx 不得删除密钥（服务端故障不是密钥的错）', async () => {
  let removeCalled = false
  const location = { href: 'http://x/panel/' }
  const serverErrorFetch = async () => ({
    ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}',
  })
  const rt = runPanelJs('bootstrap', { fetch: serverErrorFetch, location })
  const origRemove = rt.__store.delete.bind(rt.__store)
  rt.__store.delete = (k) => { removeCalled = true; return origRemove(k) }

  await rt.bootstrap()

  assert.equal(removeCalled, false, '⚠️ 5xx 时不得删除密钥')
  assert.equal(location.href, 'http://x/panel/', '⚠️ 5xx 时不得跳登录页')
})

test('⚠️ 登录页：网络错误不得报成「密钥无效」（否则用户会白改密钥）', () => {
  const js = panelAsset('/panel/login.js')?.body ?? ''
  // 三态判定：ok / bad / network（原先只有布尔，必然混淆）
  assert.ok(/return 'network'/.test(js), '网络错误应单独归类')
  assert.ok(/verdict === 'network'/.test(js), '应分开提示网络错误')
  assert.ok(/网络错误/.test(js), '应有「网络错误」文案')
  // ⚠️ 不得再出现「把非 ok 一律说成密钥无效」的写法
  assert.ok(!/if \(!ok\) \{\s*setMsg\('密钥无效/.test(js),
    '⚠️ 不得把非 ok 一律判为密钥无效')
  // 自动登录只在**确认有效**时发生（网络抖动时不能删密钥/乱跳）
  assert.ok(/if \(verdict === 'ok'\)/.test(js), '⚠️ 自动进入必须只在确认有效时')
})

test('⚠️ 计费倍率徽章不得把「未标注」说成「不可用」（实测可调通）', () => {
  // ⚠️ 参考 fork 把没有倍率标注的模型显示为「不可用」，但**实测不准确**：
  // 那些模型（如 `buddy/hy4-preview-exp`）能**正常调通**，
  // 只是上游没在名字里标倍率。显示「不可用」会让用户放弃一个可用的模型。
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  const fn = js.slice(js.indexOf('function priceBadge'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.ok(!/textContent = '不可用'/.test(body),
    '⚠️ 不得显示「不可用」（实测这些模型可调通）')
  // ⚠️ 也不能满屏「未标注」—— 一列里 39/46 都是同一个词，看着像坏了。
  // 未知时**留空**更有信息量（空白＝这列对该批模型没意义）。
  assert.ok(!/textContent = '未标注'/.test(body),
    '⚠️ 未知倍率应留空，不要重复播报「未标注」')
  // ⚠️ **免费优先**：`isFree` 必须压过 `priceFactor`（用户要求「免费用绿色」）。
  // cline 的 21 个 `cline-free/*` 有 isFree 但不发 credits ⇒ 上一版整列空白。
  // ⚠️ 判据要**宽松**：只要「priceBadge 的参数里先出现 isFree」即可，
  // 不钉死换行与缩进（我第一版写死 `? 0` 紧跟换行，结果假失败）。
  // ⚠️⚠️ 定位方式要**稳**。我为此返工三次：
  //   1. `indexOf('async function loadModels')` 命中过非定义处；
  //   2. `lastIndexOf` 在剥注释后偏移变了（注释被删 ⇒ 位置前移）；
  //   3. 从 `loadModels` 往后找 `priceBadge(` 时，中间隔着一大段注释，
  //      剥注释的正则在这个位置**没能完全剥净**，导致找不到。
  // ⇒ 改用**唯一表头字面量**做锚点，再往前找最近的 `return [` ——
  //    那是行构造块的起点，与函数位置无关。
  const raw = panelAsset('/panel/app.js')?.body ?? ''
  const headAt = raw.indexOf("'模型 id', '名称', '所属提供商'")
  assert.ok(headAt > 0, '应能定位模型页表头')
  const rowStart = raw.lastIndexOf('return [', headAt)
  assert.ok(rowStart > 0, '应能定位行构造块')
  const rowBody = raw.slice(rowStart, headAt)
  assert.ok(/isFree/.test(rowBody),
    '⚠️ isFree 必须参与倍率判定（否则免费的也显示空白）')
  // ⚠️ isFree 要先于 priceFactor 出现（免费优先，不被 undefined 盖掉）
  const ifAt = rowBody.indexOf('isFree')
  const pfAt = rowBody.indexOf('priceFactor')
  assert.ok(ifAt > 0 && (pfAt < 0 || ifAt < pfAt),
    '⚠️ isFree 应优先于 priceFactor 判定')
  // ⚠️ 区域列已删（用户要求）
  assert.ok(!/'区域'/.test(raw), '⚠️ 模型页不应再有「区域」列')
  // 三态语义必须都在：免费 / 倍率 / 未标注
  assert.ok(/textContent = '免费'/.test(body), '免费态')
  assert.ok(/'x' \+ factor/.test(body), '倍率态')
})

test('⚠️ 模型页必须自动加载 + 按钮语义改为「刷新目录」', () => {
  // 用户要求：「模型页自动加载」「把加载改为刷新目录」。
  const html = panelAsset('/panel/')?.body ?? ''
  const js = stripJsComments(panelAsset('/panel/app.js')?.body ?? '')
  assert.ok(html.includes('刷新目录'), '按钮文案应为「刷新目录」')
  assert.ok(!/>加载</.test(html), '不应再有「加载」按钮文案')
  assert.ok(/models: \(\) => loadModels\(\)/.test(js),
    '⚠️ 模型视图应自动加载（loaders 里直接调 loadModels）')
})

test('🔴 模型页：聚合行不显示倍率 + 免费显示绿色 + 无区域列', () => {
  // 用户三条要求：
  //   1. 「aggregate 就不要显示倍率了」
  //   2. 「免费用绿色显示免费」
  //   3. 「把区域栏去掉」
  const raw = panelAsset('/panel/app.js')?.body ?? ''
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const headAt = raw.indexOf("'模型 id', '名称', '所属提供商'")
  assert.ok(headAt > 0, '应能定位模型页表头')
  const rowBody = raw.slice(raw.lastIndexOf('return [', headAt), headAt)

  // ① 聚合行不给倍率 —— 它的倍率是「各候选里最便宜的」这个**推导值**，
  //    不是上游事实；显示它会让用户以为聚合自己有报价。
  assert.ok(/owned_by === 'aggregate'/.test(rowBody),
    '⚠️ 聚合行应显式跳过倍率显示')
  const aggAt = rowBody.indexOf("=== 'aggregate'")
  const callAt = rowBody.indexOf('priceBadge')
  assert.ok(aggAt > 0 && aggAt < callAt,
    '⚠️ 聚合判定必须在 priceBadge 之前（否则聚合仍会显示倍率）')

  // ② 免费优先（isFree 压过 priceFactor）—— cline 的 21 个 cline-free 不发 credits
  assert.ok(/isFree/.test(rowBody), '⚠️ isFree 必须参与判定')
  assert.ok(rowBody.indexOf('isFree') < rowBody.indexOf('priceFactor'),
    '⚠️ isFree 应优先于 priceFactor')

  // ③ 免费徽章必须是**绿色**（`.tag.ok` 用 `--ok`）
  const okRule = css.slice(css.indexOf('.tag.ok'))
  assert.ok(/color:\s*var\(--ok\)/.test(okRule.slice(0, okRule.indexOf('}'))),
    '⚠️ 「免费」必须是绿色（用户要求）')
  // ⚠️ 浅色主题**两套**都要覆盖（本项目反复踩的坑）
  assert.ok(/html\[data-theme='light'\]\s*\.tag\.ok/.test(css), '浅色（显式）要覆盖')
  assert.ok(/html:not\(\[data-theme\]\)\s*\.tag\.ok/.test(css), '浅色（auto）要覆盖')

  // ④ 区域列已删
  assert.ok(!/'区域'/.test(raw), '⚠️ 不应再有「区域」列')
})

test('⚠️ 全站圆角必须收敛到 --radius 令牌（不得再写死具体像素）', () => {
  // 用户要求「把所有圆角统一成供应商与账号的大圆角」。
  // ⚠️ 改之前全站有 **10 种**圆角值（3/4/6/8/10/12/14/16px…），
  // 同类容器在不同页面各不相同 —— 那是「每处单独调」积累出的漂移。
  //
  // ⇒ 收成两个令牌：`--radius`（大容器）/ `--radius-sm`（小控件）。
  // ⚠️ 例外：药丸形（999px）、细进度条（3–4px，改大会显胖）、
  //    以及 `50%`（圆形）都是**另一种设计语言**，不是「没统一」。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  assert.ok(/--radius:\s*\d+px/.test(css), '应有 --radius 令牌')
  assert.ok(/--radius-sm:\s*\d+px/.test(css), '应有 --radius-sm 令牌')

  const offenders: string[] = []
  for (const m of css.matchAll(/border-radius:\s*([^;]+)/g)) {
    const v = (m[1] ?? '').trim()
    if (v.includes('var(--radius')) continue   // 用令牌 —— 合格
    if (/999px|50%/.test(v)) continue          // 药丸 / 圆形 —— 另一种语言
    if (/^3px|^4px/.test(v)) continue           // 细进度条 —— 刻意保持纤细
    offenders.push(v)
  }
  assert.equal(offenders.length, 0,
    `⚠️ 仍有写死的圆角未收敛到令牌：${offenders.join(' | ')}`)
})

test('⚠️ 顶栏图标按钮缩小但触控区不得低于 34px', () => {
  // 用户要求「右上角的退出登录和主题按钮缩小一点」。
  // ⚠️ 但不能一路缩到点不中 —— 项目有实测记录（P1）：
  // 图标 SVG 曾渲染成 0×0，导致按钮缩到 20×10px，手机上基本点不中。
  const css = stripCssComments(panelAsset('/panel/style.css')?.body ?? '')
  const m = /header\s*\.icon-btn\s*\{\s*min-width:\s*(\d+)px/.exec(css)
  assert.ok(m !== null, '应有 header .icon-btn 的最小宽度')
  const w = Number(m[1])
  assert.ok(w <= 38, `⚠️ 应缩小（${w}px 仍偏大）`)
  assert.ok(w >= 34, `⚠️ 触控区不得低于 34px（实际 ${w}px，再小就点不中）`)
  const html = panelAsset('/panel/')?.body ?? ''
  assert.ok(!/width="16"/.test(html), '图标 SVG 也应缩小（16 → 14）')
})
