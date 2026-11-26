import { useEffect, useState } from 'react'
import type { MailFolder } from '@shared/types'

interface FolderPickerProps {
  /** The account whose folders (Gmail labels or Outlook folders) are listed. */
  accountId: string
  /** The folder currently chosen, highlighted in the list. */
  selectedId?: string | undefined
  /** True while the parent acts on the picked folder. */
  busy?: boolean
  onPick(folder: MailFolder): void
  onCancel?(): void
}

/** Lists one account's folders and creates a new one inline ("Nueva carpeta…"). */
export function FolderPicker({ accountId, selectedId, busy = false, onPick, onCancel }: FolderPickerProps): React.JSX.Element {
  const [folders, setFolders] = useState<MailFolder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let current = true
    setFolders(null)
    setError(null)
    void window.narsil.listFolders(accountId).then((result) => {
      if (!current) return
      if (result.ok) setFolders(result.folders ?? [])
      else setError(result.error ?? 'No se pudieron cargar las carpetas.')
    })
    return () => {
      current = false
    }
  }, [accountId])

  async function create(name: string): Promise<void> {
    setCreating(true)
    setError(null)
    const result = await window.narsil.createFolder(accountId, name)
    setCreating(false)
    if (!result.ok || !result.folder) {
      setError(result.error ?? 'No se pudo crear la carpeta.')
      return
    }
    const folder = result.folder
    setFolders((list) => [...(list ?? []), folder].sort((a, b) => a.name.localeCompare(b.name)))
    setNewName(null)
    onPick(folder)
  }

  const disabled = busy || creating

  return (
    <div className="folders" role="group" aria-label="Carpetas">
      {folders === null && !error && <p className="folders__note">Cargando carpetas…</p>}
      {folders !== null && folders.length === 0 && newName === null && (
        <p className="folders__note">Esta cuenta todavía no tiene carpetas propias.</p>
      )}
      {folders !== null && folders.length > 0 && (
        <ul className="folders__list">
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className={folder.id === selectedId ? 'folder folder--on' : 'folder'}
                aria-pressed={folder.id === selectedId}
                disabled={disabled}
                title={folder.name}
                onClick={() => onPick(folder)}
              >
                {folder.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {newName === null ? (
        <div className="folders__actions">
          <button type="button" className="link-btn" disabled={disabled || folders === null} onClick={() => setNewName('')}>
            Nueva carpeta…
          </button>
          {onCancel && (
            <button type="button" className="link-btn" disabled={disabled} onClick={onCancel}>
              Cancelar
            </button>
          )}
        </div>
      ) : (
        <div className="folders__new">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (newName.trim()) void create(newName)
              }
              if (e.key === 'Escape') setNewName(null)
            }}
            maxLength={100}
            placeholder="Nombre de la carpeta"
            aria-label="Nombre de la nueva carpeta"
            autoFocus
          />
          <button type="button" className="btn btn--primary" disabled={disabled || !newName.trim()} onClick={() => void create(newName)}>
            {creating ? 'Creando…' : 'Crear'}
          </button>
          <button type="button" className="btn btn--ghost" disabled={disabled} onClick={() => setNewName(null)}>
            Cancelar
          </button>
        </div>
      )}
      {error && (
        <p className="folders__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
