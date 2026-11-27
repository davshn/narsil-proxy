import { useEffect, useState } from 'react'
import type { SharedResult, SharedStatus } from '@shared/types'

/** "Listas compartidas" in Ajustes: the Supabase project, then signing in with Google. */
export function SharedSetup(): React.JSX.Element {
  const [status, setStatus] = useState<SharedStatus>({ configured: false })
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'config' | 'sign-in' | 'sign-out' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.narsil.getSharedStatus().then((result) => setStatus(result.status))
  }, [])

  async function run(label: NonNullable<typeof busy>, call: () => Promise<SharedResult>): Promise<boolean> {
    setBusy(label)
    setError(null)
    const result = await call()
    setBusy(null)
    setStatus(result.status)
    if (!result.ok) setError(result.error ?? 'Algo salió mal.')
    return result.ok
  }

  const showForm = !status.configured || editing

  return (
    <li className={status.email ? 'step step--done' : 'step'}>
      <h3>Listas compartidas</h3>
      <p>Para compartir pendientes con otras personas. Usa tu proyecto de Supabase; el README explica cómo crearlo.</p>
      {showForm ? (
        <form
          className="setup__shared"
          onSubmit={(e) => {
            e.preventDefault()
            void run('config', () => window.narsil.setSharedConfig(url, key)).then((ok) => {
              if (!ok) return
              setEditing(false)
              setUrl('')
              setKey('')
            })
          }}
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://tu-proyecto.supabase.co"
            aria-label="URL del proyecto de Supabase"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Clave pública: sb_publishable_…"
            aria-label="Clave pública del proyecto de Supabase"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="setup__actions">
            {editing && (
              <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            )}
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !url.trim() || !key.trim()}>
              {busy === 'config' ? 'Guardando…' : 'Guardar proyecto'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="setup__shared-project">
            Proyecto: <span title={status.projectUrl}>{status.projectUrl?.replace(/^https:\/\//, '')}</span>{' '}
            <button type="button" className="link-btn" disabled={busy !== null} onClick={() => setEditing(true)}>
              Cambiar
            </button>
          </p>
          {status.email ? (
            <p className="setup__shared-user">
              Conectado como <strong>{status.email}</strong>{' '}
              <button
                type="button"
                className="link-btn"
                disabled={busy !== null}
                onClick={() => void run('sign-out', () => window.narsil.sharedSignOut())}
              >
                Cerrar sesión
              </button>
            </p>
          ) : (
            <div className="setup__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={() => void run('sign-in', () => window.narsil.sharedSignIn())}
              >
                {busy === 'sign-in' ? 'Esperando a tu navegador…' : 'Iniciar sesión con Google'}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="setup__error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
