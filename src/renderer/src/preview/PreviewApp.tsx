import { PreviewDock } from '../components/PreviewDock'

/** Popped-out live preview window (hash route /preview). */
export default function PreviewApp(): React.JSX.Element {
  return (
    <div className="app-shell">
      <main className="app-main">
        <PreviewDock popped />
      </main>
    </div>
  )
}
