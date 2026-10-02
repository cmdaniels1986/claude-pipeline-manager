import { useState } from 'react'
import type { LinkedMemoryInfo, SharedMemoryEntry, SharedMemoryState } from '../../../shared/types'

/** a file inside a folder, using the folder's own separator (no `path` in the renderer) */
function inFolder(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + file
}

function linkedMeta(l: LinkedMemoryInfo): string {
  if (!l.exists) return 'not found — is the drive or sync app running?'
  if (l.duplicateOf === 'global') return 'same folder as your Global Memory'
  if (l.duplicateOf === 'machine') return 'already loaded (memory on this machine)'
  if (l.kind === 'file') return 'memory file · loaded in full'
  return `${l.entries} ${l.entries === 1 ? 'entry' : 'entries'}`
}

/**
 * Global Memory + linked memory, shown inside the memory check. Global Memory is
 * a folder you choose (ideally shared — Google Drive, OneDrive, Dropbox) that
 * terminals write to when you say "save this to global memory"; anyone who picks
 * the same folder loads it and can add to it. Linked memory is someone else's
 * memory you browsed to (a MEMORY.md, a memory folder, or one file), loaded into
 * every new terminal read-only.
 */
export function SharedMemoryPanel({
  shared,
  onChange
}: {
  shared: SharedMemoryState | null
  onChange: (state: SharedMemoryState) => void
}): React.JSX.Element {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [showEntries, setShowEntries] = useState(false)
  const g = shared?.global ?? null
  const linked = shared?.linked ?? []
  const entries: SharedMemoryEntry[] = [...(g?.entries ?? [])].sort((a, b) =>
    (b.updated ?? '').localeCompare(a.updated ?? '')
  )

  const refresh = async (): Promise<void> => onChange(await window.api.memoryShared())

  const chooseGlobal = async (): Promise<void> => {
    const r = await window.api.memoryChooseGlobal()
    if (r.canceled) return
    onChange(r.state)
    setNote(
      r.error
        ? { ok: false, text: r.error }
        : { ok: true, text: `Global Memory now saves to ${r.state.global?.dir}. New terminals load it.` }
    )
  }

  const stopGlobal = async (): Promise<void> => {
    if (!g) return
    const sure = window.confirm(
      `Stop using this folder as Global Memory?\n\n${g.dir}\n\nNothing is deleted — the folder and its memories stay where they are. New terminals just stop loading it and can't save to it.`
    )
    if (!sure) return
    onChange(await window.api.memoryClearGlobal())
    setNote(null)
  }

  const addFiles = async (): Promise<void> => {
    const r = await window.api.memoryImportToGlobal()
    if (r.canceled) return
    if (r.error) {
      setNote({ ok: false, text: r.error })
      return
    }
    const done = [
      r.added.length ? `added ${r.added.length}` : '',
      r.updated.length ? `updated ${r.updated.length}` : ''
    ].filter(Boolean)
    const skipped = r.skipped.map((s) => `${s.file} (${s.reason})`)
    setNote({
      ok: done.length > 0,
      text: [
        done.length ? `✓ Global Memory: ${done.join(', ')}.` : 'Nothing was added.',
        skipped.length ? `Skipped ${skipped.join('; ')}.` : ''
      ]
        .filter(Boolean)
        .join(' ')
    })
    await refresh()
  }

  const link = async (kind: 'file' | 'folder'): Promise<void> => {
    const r = await window.api.memoryLink(kind)
    if (!r.canceled) onChange(r.state)
  }

  const removeEntry = async (e: SharedMemoryEntry): Promise<void> => {
    const sure = window.confirm(`Delete “${e.title}” from Global Memory?\n\nIt's removed for everyone who uses this folder.`)
    if (!sure) return
    const r = await window.api.memoryRemoveGlobal(e.name)
    if (!r.ok) setNote({ ok: false, text: r.error ?? 'Could not delete it.' })
    await refresh()
  }

  const reveal = async (path: string): Promise<void> => {
    const r = await window.api.memoryReveal(path)
    if (!r.ok) setNote({ ok: false, text: r.error ?? `Couldn't open ${path}` })
  }

  return (
    <div className="shared-mem">
      <div className="shared-mem-section">
        <div className="shared-mem-head">
          <span className="shared-mem-title">🌐 Global Memory</span>
          {g ? (
            <>
              <code className="shared-mem-path" title={g.dir}>
                {g.dir}
              </code>
              <span className="shared-mem-meta">
                {g.exists ? `${entries.length} ${entries.length === 1 ? 'memory' : 'memories'}` : '⚠ unreachable'}
              </span>
              <span className="spacer" />
              <button onClick={() => void addFiles()} title="Copy memory files (for example from your own memory) into Global Memory">
                ＋ Add memory files…
              </button>
              <button className="icon-button" onClick={() => void reveal(g.dir)} title="Open the Global Memory folder">
                Open
              </button>
              <button className="icon-button" onClick={() => void chooseGlobal()} title="Save Global Memory to a different folder">
                Change…
              </button>
              <button
                className="icon-button"
                onClick={() => void stopGlobal()}
                title="Stop loading and saving Global Memory (the files are kept)"
              >
                Stop using
              </button>
            </>
          ) : (
            <>
              <span className="shared-mem-meta">not set</span>
              <span className="spacer" />
              <button className="primary" onClick={() => void chooseGlobal()}>
                Choose location…
              </button>
            </>
          )}
        </div>
        <div className="shared-mem-hint">
          {g ? (
            <>
              Tell any terminal <em>“save this to global memory”</em> and it lands here. Anyone who picks this same folder
              as their Global Memory loads it and can add to it, or they can Link it below to just read it.
            </>
          ) : (
            <>
              Where terminals save when you say <em>“save this to global memory”</em>. Pick a shared or synced folder
              (Google Drive, OneDrive, Dropbox…) so other people working on the codebase can load it too.
            </>
          )}
        </div>
        {g && entries.length > 0 && (
          <button className="icon-button shared-mem-toggle" onClick={() => setShowEntries((v) => !v)}>
            {showEntries ? 'Hide memories ▴' : 'Show memories ▾'}
          </button>
        )}
        {g && showEntries && (
          <div className="shared-mem-list">
            {entries.map((e) => (
              <div className="shared-mem-row" key={e.file}>
                <button
                  className="icon-button shared-mem-entry"
                  onClick={() => void reveal(inFolder(g.dir, e.file))}
                  title={`Open ${e.file}`}
                >
                  {e.title}
                </button>
                <span className="shared-mem-desc" title={e.description}>
                  {e.description}
                </span>
                <span className="shared-mem-meta">
                  {[e.type, e.author, e.updated?.slice(0, 10)].filter(Boolean).join(' · ')}
                </span>
                <button
                  className="icon-button"
                  onClick={() => void removeEntry(e)}
                  title="Delete from Global Memory (for everyone)"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shared-mem-section">
        <div className="shared-mem-head">
          <span className="shared-mem-title">🔗 Linked memory</span>
          <span className="shared-mem-meta">{linked.length ? `${linked.length} linked · read-only` : 'none'}</span>
          <span className="spacer" />
          <button onClick={() => void link('file')} title="Pick a MEMORY.md to load a whole memory folder, or any single memory file">
            ＋ Link file…
          </button>
          <button onClick={() => void link('folder')} title="Pick a folder of memory files">
            ＋ Link folder…
          </button>
        </div>
        {linked.length === 0 ? (
          <div className="shared-mem-hint">
            Load someone else’s memory into your terminals, such as a teammate’s Global Memory folder. Pick a MEMORY.md, a
            memory folder, or a single memory file.
          </div>
        ) : (
          <div className="shared-mem-list">
            {linked.map((l) => (
              <div className={`shared-mem-row${l.exists ? '' : ' missing'}`} key={l.id}>
                <span className="mem-bank-check">{!l.exists ? '⚠' : l.duplicateOf ? '•' : '✓'}</span>
                <code className="shared-mem-path" title={l.path}>
                  {l.path}
                </code>
                <span className="shared-mem-meta">{linkedMeta(l)}</span>
                <span className="spacer" />
                {l.exists && (
                  <button className="icon-button" onClick={() => void reveal(l.path)} title="Open it">
                    Open
                  </button>
                )}
                <button
                  className="icon-button"
                  onClick={() => void window.api.memoryUnlink(l.id).then(onChange)}
                  title="Unlink (the files stay where they are)"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {note && (
        <div className={`shared-mem-note ${note.ok ? 'ok' : 'bad'}`}>
          <span>{note.text}</span>
          <button className="icon-button" onClick={() => setNote(null)} title="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
