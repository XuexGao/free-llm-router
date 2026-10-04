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

// ⚠️ wrangler 内置的 CompiledWasm 默认规则
// （`wrangler-dist/cli.js:150957`：`{ type: "CompiledWasm", globs: ["**/*.wasm"] }`）
// 让 `.wasm` import 直接得到 **`WebAssembly.Module`**（不是数组缓冲区）。
// `@cloudflare/workers-types` 未提供这个声明（已 grep 确认），故在这里补上。
//
// ⚠️ 声明的是 `WebAssembly.Module` 而**不是** `Uint8Array`/`ArrayBuffer`：
// 前者可以用 `WebAssembly.instantiate(module, imports)` 复用已编译的模块，
// 后者每次都要重新编译 298KB —— 差别在冷启动路径上很实在。
declare module '*.wasm' {
  const mod: WebAssembly.Module
  export default mod
}
declare module '*/assets/login.html' {
  const content: string
  export default content
}
declare module '*/assets/login.js.txt' {
  const content: string
  export default content
}
