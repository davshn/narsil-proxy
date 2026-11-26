import { useState } from 'react'
import type { ActionResult, AppStatus } from '@shared/types'

interface SetupProps {
  status: AppStatus
}

export function Setup({ status }: SetupProps): React.JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<ActionResult>): Promise<void> {
    setBusy(label)
    setMessage(null)
    const result = await fn()
    setBusy(null)
    if (!result.ok) setMessage(result.error ?? 'Algo salió mal.')
  }

  return (
    <section className="setup" aria-label="Ajustes">
      <p className="setup__intro">Narsil necesita tres cosas para poder revisar tu correo y tu calendario.</p>
      <ol className="setup__steps">
        <li className={status.hasGoogleClient ? 'step step--done' : 'step'}>
          <h3>Archivo de cliente de Google</h3>
          <p>El JSON del cliente OAuth tipo “App de escritorio” de tu proyecto de Google Cloud. El README explica cómo obtenerlo.</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() => void run('client', () => window.narsil.importGoogleClient())}
          >
            {status.hasGoogleClient ? 'Reemplazar archivo de cliente' : 'Elegir archivo de cliente'}
          </button>
        </li>
        <li className={status.googleConnected ? 'step step--done' : 'step'}>
          <h3>Cuenta de Google</h3>
          <p>Abre tu navegador para que autorices a Narsil a leer Gmail, actuar sobre tus correos y leer tu calendario.</p>
          {status.googleConnected ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy !== null}
              onClick={() => void run('disconnect', () => window.narsil.disconnectGoogle())}
            >
              Desconectar Google
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null || !status.hasGoogleClient}
              onClick={() => void run('connect', () => window.narsil.connectGoogle())}
            >
              {busy === 'connect' ? 'Esperando a tu navegador…' : 'Conectar Google'}
            </button>
          )}
        </li>
        <li className={status.hasAnthropicKey ? 'step step--done' : 'step'}>
          <h3>API key de Anthropic</h3>
          <p>Se usa para resumir cada correo y redactar respuestas. Se guarda cifrada en este equipo.</p>
          <form
            className="setup__key"
            onSubmit={(e) => {
              e.preventDefault()
              void run('key', () => window.narsil.setAnthropicKey(key)).then(() => setKey(''))
            }}
          >
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status.hasAnthropicKey ? 'Clave guardada. Pega una nueva para reemplazarla' : 'sk-ant-…'}
              aria-label="API key de Anthropic"
              autoComplete="off"
            />
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !key.trim()}>
              Guardar clave
            </button>
          </form>
        </li>
      </ol>
      {message && (
        <p className="setup__error" role="alert">
          {message}
        </p>
      )}
    </section>
  )
}
