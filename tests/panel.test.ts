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

test('⚠️ 面板必须有无密钥的引导（否则用户看到一片空白）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const js = panelAsset('/panel/app.js')?.body ?? ''
  // 必须有提示区块
  assert.ok(html.includes('setup-hint'), 'HTML 应有引导区块')
  assert.ok(html.includes('API_KEY'), '应提示用户填密钥')
  // 且 JS 在无密钥时也要渲染视图（而不是 return 什么都不做）
  assert.ok(/key === ''/.test(js) || /key === ""/.test(js), 'JS 应显式处理「无密钥」分支')
  assert.ok(js.includes('switchView'), '无密钥时也应切换视图（让用户看到界面结构）')
})

test('⚠️ 面板必须有 8 个视图（对齐参考项目的信息密度）', () => {
  const html = panelAsset('/panel/')?.body ?? ''
  const views = ['accounts', 'tasks', 'usage', 'packages', 'models', 'providers', 'config', 'logs']
  for (const v of views) {
    assert.ok(html.includes(`data-view="${v}"`), `缺少视图：${v}`)
    assert.ok(html.includes(`id="view-${v}"`), `缺少视图容器：${v}`)
  }
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
