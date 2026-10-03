// Wrangler Text 模块规则产出的 import 形状（都是字符串）。
// 见 wrangler.jsonc 的 rules 配置。
declare module '*.html' {
  const content: string
  export default content
}
declare module '*.css' {
  const content: string
  export default content
}
declare module '*/assets/app.js' {
  const content: string
  export default content
}
declare module '*/assets/style.css.txt' {
  const content: string
  export default content
}
declare module '*/assets/app.js.txt' {
  const content: string
  export default content
}
