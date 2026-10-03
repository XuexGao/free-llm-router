#!/usr/bin/env bash
# 单测运行脚本。
#
# 为什么不用 `node --test --experimental-strip-types`：
# Node 的类型剥离**不做路径重写**，而本项目源码按 ESM 规范写 `.js` 后缀
# （`import './headers.js'` 指向 `headers.ts`）—— 这是 TypeScript 的标准做法，
# 但 Node 不认，会报 ERR_MODULE_NOT_FOUND。
#
# 故先用 esbuild 打包成真正的 .mjs 再跑测试。esbuild 来自 wrangler 的依赖，
# 无需额外安装。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=".build/tests"
rm -rf "$OUT"
mkdir -p "$OUT"

for f in tests/*.test.ts; do
  name=$(basename "$f" .test.ts)
  # --external:cloudflare:workers 是必需的：actions.ts 会（通过类型与常量）
  # 拽进 TaskRunnerDO，而后者 import 'cloudflare:workers'（Workers 运行时内置模块）。
  # 单测在 Node 下跑，标记为 external 即可 —— 测试不会真的实例化 DO。
  # --loader 让面板的静态资源在单测里也当**字符串**导入（与 wrangler 的
  # Text 规则一致）。不配的话 esbuild 会因为不知道 .html/.css.txt 怎么处理而报错。
  ./node_modules/.bin/esbuild "$f" \
    --bundle --format=esm --platform=node \
    --external:cloudflare:workers \
    --loader:.html=text --loader:.css.txt=text --loader:.js.txt=text \
    --loader:.wasm=file \
    --outfile="$OUT/$name.test.mjs" --log-level=warning
done

node --test "$OUT"/*.test.mjs
