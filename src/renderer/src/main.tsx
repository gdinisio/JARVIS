import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container is missing.')

// StrictMode is deliberately omitted: its double-invoked effects would open
// and close the microphone twice in development.
createRoot(container).render(<App />)
