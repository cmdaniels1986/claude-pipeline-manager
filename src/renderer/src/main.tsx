import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'
import App from './App'
import GraphApp from './graph/GraphApp'

const isGraph = window.location.hash.startsWith('#/graph')

createRoot(document.getElementById('root')!).render(isGraph ? <GraphApp /> : <App />)
