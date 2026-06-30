import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/500.css'
import '@fontsource/noto-sans-jp/700.css'
import 'highlight.js/styles/github.css'
import './index.css'
import App from './App.tsx'
import { PresenterWindow } from './components/PresenterWindow.tsx'

// The detached presenter window loads the same bundle with `?role=presenter`; it
// mounts the lightweight mirror instead of the full app (no folder restore, etc.).
const role = new URLSearchParams(window.location.search).get('role')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{role === 'presenter' ? <PresenterWindow /> : <App />}</StrictMode>,
)
