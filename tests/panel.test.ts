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
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  // 简单起见：断言关键标识符存在（比跨行正则更稳）
  assert.ok(src.includes('byProvider'), '/v1/models 应按供应商分组账号')
  assert.ok(/for \(const \[providerId, list\] of byProvider\)/.test(src), '应逐个有账号的供应商拉目录')
  assert.ok(src.includes('provider.capabilities.listModels'), '应只对有列模能力的供应商拉目录')
})

test('⚠️ 面板视图（账号池已并入供应商）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const views = ['providers', 'tasks', 'usage', 'packages', 'models', 'config', 'logs']
  for (const v of views) {
    assert.ok(html.includes(`data-view="${v}"`), `缺少视图：${v}`)
    assert.ok(html.includes(`id="view-${v}"`), `缺少视图容器：${v}`)
  }
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

test('⚠️ 登录下拉必须先清空再填（否则选项重复累积）', () => {
  // 实测 bug：HTML 里硬编码了一个 option，JS 又追加且不清空，
  // 而 loadProviders 会被多次调用 → 下拉项重复。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const html = panelAsset('/panel/')?.body ?? ''
  // HTML 里不该有硬编码的登录供应商 option
  const selectBlock = /<select id="login-provider">([\s\S]*?)<\/select>/.exec(html)
  assert.notEqual(selectBlock, null, '应有 login-provider 下拉')
  assert.ok(!selectBlock[1].includes('<option'), 'HTML 里不该硬编码 option（应由 JS 统一填）')
  // JS 必须先 clear 再 append
  assert.ok(/clear\(loginSelect\)/.test(js), '填选项前必须先 clear')
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
