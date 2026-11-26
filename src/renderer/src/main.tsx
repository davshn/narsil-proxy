import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyThemeOfTheHour } from './theme'
import './styles.css'

// Before the first paint, so the window never flashes the other theme.
applyThemeOfTheHour()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
