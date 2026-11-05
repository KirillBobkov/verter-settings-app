import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// config.json читается ДО монтирования: App ожидает готовый runtime-конфиг
// (адрес хаба не инлайнится в бандл — см. lib/config/runtime-config.ts).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
