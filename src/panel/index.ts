/**
 * 管理面板的静态资源与安全响应头。
 *
 * ## 资源怎么进 Worker
 *
 * 用 Wrangler 的 **Text 模块规则**（`wrangler.jsonc` 的 `rules`）把三个文件
 * 作为字符串 import 进来，无需构建步骤、无需 Worker Static Assets。
 *
 * ⚠️ 为什么不用 Workers Static Assets：那需要额外的 `assets` binding 与路由优先级
 * 配置，而本项目只有 3 个文件、且必须挂在 `/panel/*` 前缀下并**统一加安全头**。
 * Text import 更直接，也让「安全头对所有面板响应生效」只有一处实现。
 *
 * ## 为什么 JS 单独一个文件，而不是内联进 HTML
 *
 * 内联脚本会迫使 CSP 放开 `script-src 'unsafe-inline'` —— 那等于放弃 XSS 防护
 * （任何注入的 `<script>` 都会执行）。Go 侧（`internal/panel/index.go:24-31`）
 * 明确记录了同样的取舍，本项目沿用。
 *
 * ## 为什么页面本身不需要鉴权，而数据接口必须鉴权
 *
 * 页面不含任何敏感信息（不知道有哪些账号、也不知道 token）。
 * 真正的数据都在 `/admin/*` 与 `/v1/*` 后面，**一律要 Bearer 密钥**。
 * 用户把密钥粘进页面（存 localStorage），页面再带 `Authorization` 头请求。
 *
 * ⚠️ 刻意**不用 cookie**：cookie 会被浏览器自动附带，需要额外的 CSRF 防护；
 * 而 `Authorization` 头不会被自动附带，天然免疫 CSRF。
 */

import panelHtml from './assets/index.html'
// ⚠️ CSS 也用 `.txt` 后缀：Wrangler 对 `.css` 有**内建**的模块处理
// （会把它当成 CSS module 对象而不是字符串），实测线上返回 `[object Object]`。
// 加 `.txt` 让本项目的 Text 规则生效；返回时仍声明 text/css，浏览器无感。
import panelCss from './assets/style.css.txt'
// ⚠️ 面板 JS 的源文件名带 `.txt` 后缀（`app.js.txt`）。
// 原因：esbuild 对 `.js` 文件有自己的 loader 解析，**不会**套用 Wrangler 的
// Text 规则 —— 实测报错 `No matching export in "app.js" for import "default"`。
// 用 `.js.txt` 让 Text 规则生效；服务时仍以 `application/javascript` 返回
// （见下方 panelAsset 的 content-type），因此浏览器侧完全无感。
import panelJs from './assets/app.js.txt'

/**
 * 内容安全策略（严格版，**无需 unsafe-inline**）。
 *
 * - `default-src 'none'`：默认全禁，逐个开口；
 * - `script-src 'self'`：只跑同源的 `app.js`；
 * - `style-src 'self' 'unsafe-inline'`：允许内联样式属性（**不会导致脚本执行**）；
 * - `connect-src 'self'`：前端 fetch 只能打本服务（防把密钥发去外部域）；
 * - `frame-ancestors 'none'`：禁止被 iframe 嵌套（防点击劫持）；
 * - `base-uri 'none'`：禁止注入 `<base>` 改写相对路径。
 */
export const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'"

/** 面板统一安全响应头（页面与静态资源都要）。 */
export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

/** 面板静态资源路由表（路径 → 内容与类型）。 */
export function panelAsset(path: string): { body: string; contentType: string } | undefined {
  switch (path) {
    case '/panel':
    case '/panel/':
      return { body: panelHtml, contentType: 'text/html; charset=utf-8' }
    case '/panel/style.css':
      return { body: panelCss, contentType: 'text/css; charset=utf-8' }
    case '/panel/app.js':
      return { body: panelJs, contentType: 'application/javascript; charset=utf-8' }
    default:
      return undefined
  }
}
