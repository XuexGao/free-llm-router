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
import loginHtml from './assets/login.html'
import loginJs from './assets/login.js.txt'

/**
 * 内容安全策略（严格版，**无需 unsafe-inline**）。
 *
 * - `default-src 'none'`：默认全禁，逐个开口；
 * - `script-src 'self'`：只跑同源的 `app.js`；
 * - `style-src 'self' 'unsafe-inline'`：允许内联样式属性（**不会导致脚本执行**）；
 * - `connect-src 'self'`：前端 fetch 只能打本服务（防把密钥发去外部域）；
 * - `frame-ancestors 'none'`：禁止被 iframe 嵌套（防点击劫持）；
 * - `base-uri 'none'`：禁止注入 `<base>` 改写相对路径；
 * - `form-action 'none'`：**仅用于不含表单的页面**（面板 app.js 全用 fetch，没有 `<form>`）。
 *
 * ⚠️⚠️ **登录页必须用另一套 CSP**（见 `CSP_LOGIN`）——
 * `/login` 有一个真实的 `<form>`，而 `form-action 'none'` 会把它**拦掉**：
 * 浏览器每提交一次都在控制台报一条 CSP 违规。实测（Firefox + BiDi 审计）：
 * 点「登录」后固定出现
 * `blocked ... (form-action) at /login because it violates "form-action 'none'"`。
 *
 * 功能上它「碰巧能用」——因为 `login.js` 在 `onsubmit` 里
 * `e.preventDefault()` 后用 fetch 自己发请求，表单从未真的导航。
 * 但这是一条**真实上报的错误**，且把「全站 form-action:none」
 * 这个真实防线退化成了噪音：真正的表单劫持会被淹没。
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

/**
 * 登录页专用的 CSP：与 `CSP` 只差 `form-action`。
 *
 * ## 为什么不能简单地去掉 `form-action`（而要让登录页显式允许）
 *
 * 登录页确实会把表单提交到**自己的源** —— 即使 JS 已 `preventDefault()`，
 * 声明 `form-action 'self'` 也能保证「即便 JS 挂了/被阻止，表单也不可能
 * 提交到外部域名」（那等于把密钥送到别人服务器）。
 *
 * ⚠️ 用 `'self'` 而**不是**放开成 `*`：前者保留了「禁外部提交」这个
 * 真正要防的东西，只是把边界从「完全不能提交」放宽到「只能提交给自己」。
 */
export const CSP_LOGIN =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'"

/**
 * 面板统一安全响应头（页面与静态资源都要）。
 *
 * ## 🔴 `X-Robots-Tag: noindex` —— 面板**绝不能被搜索引擎收录**
 *
 * 本服务的面板挂在**公网**上（自定义域或 `workers.dev`）。一旦被索引，
 * 「`site:<域名> panel`」就能搜到管理界面 URL —— 虽然它**仍然要密钥**
 * （`securityHeaders` 之外还有 `/admin/*` 的鉴权），但：
 *
 * 1. 管理入口本身是**不应公开**的资产（攻击面收窄原则）；
 * 2. 页面标题/路径会出现在搜索结果里，等于对外宣告「这里跑着一个
 *    多供应商账号池」—— 而本项目的定位是**个人自用**（§3.1 红线）；
 * 3. `robots.txt` 对一个**还没被收录**的新域有效，但对已被收录的无效
 *    （而且它可能压根不会被访问）。
 *
 * ⇒ 用**响应头**而非 `robots.txt`：头是每个响应都带的，与是否被抓
 * `robots.txt` 无关。`noindex, nofollow` 同时禁止索引与沿链接爬取。
 *
 * ⚠️ 登录页（`loginSecurityHeaders`）继承了本函数 ⇒ 自动也带这个头，
 * 那正是我们要的（登录页更不该被索引）。
 */
export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // ⚠️ 见上：面板与登录页都不得被搜索引擎收录
    'x-robots-tag': 'noindex, nofollow',
    'cache-control': 'no-store',
  }
}

/**
 * 登录页的安全头（与 `securityHeaders()` 只差 CSP）。
 *
 * ⚠️ 其余头（nosniff / frame-ancestors / referrer-policy / no-store）
 * 必须完全一致 —— 登录页同样不能被嵌套、不能泄露 Referer。
 */
export function loginSecurityHeaders(): Record<string, string> {
  return { ...securityHeaders(), 'content-security-policy': CSP_LOGIN }
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
    case '/login':
    case '/login/':
      return { body: loginHtml, contentType: 'text/html; charset=utf-8' }
    case '/panel/login.js':
      return { body: loginJs, contentType: 'application/javascript; charset=utf-8' }
    default:
      return undefined
  }
}
