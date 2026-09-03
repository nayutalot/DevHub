import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Step 7 CSP 取舍（docs/00 约束 #15/#18，docs/06）：
// - build 产物保持 src/renderer/index.html 的严格 meta CSP：
//     default-src 'self'; style-src 'self' 'unsafe-inline'
//   （'unsafe-inline' 仅为 React inline style 属性所需；无外部字体/图片/脚本）。
// - dev 模式 electron-vite 经 dev server 注入 @vite/client（HMR 走
//   ws://localhost:*）与 @vitejs/plugin-react 的 inline preamble script；
//   严格 CSP 会同时阻断二者。因此仅当 index.html 由 dev server 渲染时
//   （transformIndexHtml 的 ctx.server 存在）放宽 script-src 与 connect-src，
//   构建产物永远不受影响。
function devCspRelax(): Plugin {
  return {
    name: 'devhub-dev-csp-relax',
    transformIndexHtml(html, ctx) {
      if (!ctx.server) return html
      return html.replace(
        /content="default-src 'self'; style-src 'self' 'unsafe-inline'"/,
        'content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*"',
      )
    }
  }
}

// electron-vite defaults match our layout exactly:
//   main     entry: src/main/index.ts     -> out/main
//   preload  entry: src/preload/index.ts  -> out/preload
//   renderer root: src/renderer (index.html)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // package.json "main" points at out/main/index.js (CJS); pin the format
      // explicitly so the runtime module system never depends on defaults.
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // sandbox:true 的 preload 只能以 CJS 加载（docs/00 约束 #18）：显式钉死
      // 输出格式，保证 out/preload/index.js 无顶层 import/export ESM 语句。
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  renderer: {
    plugins: [react(), devCspRelax()]
  }
})
