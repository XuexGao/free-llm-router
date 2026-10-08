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
  const m = /@media\s*\(max-width:\s*(\d+)px\)\s*\{[^@]*?\.count\s*\{[^}]*flex:\s*1\s+1\s+100%/.exec(css)
  assert.notEqual(m, null, '应存在把计数块收成一列的断点')
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

test('⚠️ 积分包必须显式处理 skipped（否则渲染成「可用 undefined」）', () => {
  // 线上实测（P2）：opencode 匿名通道那行显示 **「可用 undefined」**。
  // 后端其实是对的 —— 它对该账号返回
  // `{skipped:true, reason:'该供应商不支持查余额'}`（既无 error 也无 total），
  // 是前端只判 `a.error` 就落到 else 分支，把 undefined 拼进了字符串。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  assert.ok(/a\.skipped/.test(js), '应处理 skipped（后端用它标记「该供应商不支持查余额」）')
  // 同时要有 total 非数字的兜底（与 loadProviderCredits 同口径）
  assert.ok(/typeof a\.total !== 'number'/.test(js), '应对非数字 total 兜底，不让 undefined 流到界面')
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
  assert.ok(jsCode.includes('err-msg'), '长错误应走 .err-msg 块级样式换行显示')
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
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  // 行可拖 + 有手柄
  assert.ok(/row\.draggable = true/.test(js), '行必须是 draggable')
  assert.ok(/ondragstart/.test(js) && /ondrop/.test(js), '要处理 dragstart 与 drop')
  assert.ok(js.includes('drag-handle'), '要有拖动手柄')
  assert.ok(/drag-handle/.test(css), '手柄要有样式（cursor: grab）')
  // ⚠️ `dragover` 必须 preventDefault，否则浏览器拒绝 drop（静默失效）
  assert.ok(/ondragover = \(e\) => \{ e\.preventDefault\(\)/.test(js),
    '⚠️ dragover 必须 preventDefault，否则 drop 不触发')
  // ⚠️ 不能再有上移/下移按钮（用户要的是拖动）
  assert.ok(!/up\.textContent = '↑'/.test(js), '不应保留「上移」按钮')
})

test('⚠️ 供应商管理弹窗必须复用现有 .card 样式（视觉统一）', () => {
  // 用户报：「打开后的风格也不统一」。故弹窗里的行要用**现有的** `.card`
  //（与「账号」页同款），不是自己造一套 `.prow`。
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  const i = js.indexOf('function openProviderManager')
  const block = js.slice(i, i + 3200)
  assert.ok(/row\.className = 'card'/.test(block), '管理行应复用 .card 样式')
  // ⚠️ 按钮也复用现有的 ghost / danger（不另立样式）
  assert.ok(/sw\.className = off \? 'ghost' : 'danger'/.test(block), '开关应复用 ghost/danger')
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

test('⚠️ 每个账号卡片必须单独显示积分（用户要求）', () => {
  const js = panelAsset('/panel/app.js')?.body ?? ''
  const css = panelAsset('/panel/style.css')?.body ?? ''
  assert.ok(js.includes('acct-credits'), '账号卡片要有积分元素')
  // ⚠️ 数据必须来自已有的 `/admin/accounts`（`a.credits`），
  // **不能**为每个账号再打一次上游 —— 那既慢又消耗额度。
  assert.ok(/a\.credits/.test(js), '积分应取账号自身字段，不额外请求')
  assert.ok(/acct-credits/.test(css), '要有样式')
  // 查不到时显示 `—` 而不是 0（显示 0 会让人以为额度用光）
  assert.ok(js.includes("cr.textContent = '—'"), '未查到应显示破折号而非 0')
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
