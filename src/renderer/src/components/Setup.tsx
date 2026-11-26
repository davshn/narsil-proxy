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
    if (!result.ok) setMessage(result.error ?? 'Something went wrong.')
  }

  return (
    <section className="setup" aria-label="Setup">
      <p className="setup__intro">Narsil needs three things before it can watch your inbox and calendar.</p>
      <ol className="setup__steps">
        <li className={status.hasGoogleClient ? 'step step--done' : 'step'}>
          <h3>Google client file</h3>
          <p>The OAuth “Desktop app” JSON from your Google Cloud project. The README explains how to get it.</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() => void run('client', () => window.narsil.importGoogleClient())}
          >
            {status.hasGoogleClient ? 'Replace client file' : 'Choose client file'}
          </button>
        </li>
        <li className={status.googleConnected ? 'step step--done' : 'step'}>
          <h3>Google account</h3>
          <p>Opens your browser so you can allow Narsil to read Gmail, act on messages and read your calendar.</p>
          {status.googleConnected ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy !== null}
              onClick={() => void run('disconnect', () => window.narsil.disconnectGoogle())}
            >
              Disconnect Google
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null || !status.hasGoogleClient}
              onClick={() => void run('connect', () => window.narsil.connectGoogle())}
            >
              {busy === 'connect' ? 'Waiting for your browser…' : 'Connect Google'}
            </button>
          )}
        </li>
        <li className={status.hasAnthropicKey ? 'step step--done' : 'step'}>
          <h3>Anthropic API key</h3>
          <p>Used to summarize each email and draft replies. Stored encrypted on this computer.</p>
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
              placeholder={status.hasAnthropicKey ? 'Key saved. Paste a new one to replace it' : 'sk-ant-…'}
              aria-label="Anthropic API key"
              autoComplete="off"
            />
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !key.trim()}>
              Save key
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
