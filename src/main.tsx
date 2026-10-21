import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.ts'
import App from './App.tsx'
import NoticeHost from './components/NoticeHost.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <NoticeHost />
  </StrictMode>,
)
