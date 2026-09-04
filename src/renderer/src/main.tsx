import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'
import App from './App'
import TermWindowApp from './components/TermWindowApp'
import GraphApp from './graph/GraphApp'
import PreviewApp from './preview/PreviewApp'

const hash = window.location.hash
const page = hash.startsWith('#/graph') ? (
  <GraphApp />
) : hash.startsWith('#/preview') ? (
  <PreviewApp />
) : hash.startsWith('#/term/') ? (
  <TermWindowApp />
) : (
  <App />
)

createRoot(document.getElementById('root')!).render(page)
