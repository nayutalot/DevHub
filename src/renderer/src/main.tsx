import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/global.css'

// Step 7：四视图（Dashboard / Projects / Environment / Services）+ 侧边导航 +
// 全局刷新上下文 —— docs/06-ui-ia.md。全部数据经 window.devhub.invoke（docs/04）。

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('#root element not found')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
