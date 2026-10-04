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
    /data\.push\(\{ \.\.\.base, id: `\$\{providerId\}\/\$\{m\.id\}` \}\)/.test(src),
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
  // 主题按钮也必须是 SVG（三态图标）
  assert.ok(/THEME_ICON\s*=\s*\{[\s\S]{0,400}<svg/.test(js), '主题图标必须是 SVG')
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
  assert.ok(wrapped >= 5, `应有至少 5 处 wrapTable(buildTable(...))，实际 ${wrapped}`)

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
