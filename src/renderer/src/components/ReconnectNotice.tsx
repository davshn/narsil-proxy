import { useState } from 'react'
import type { Account } from '@shared/types'

interface ReconnectNoticeProps {
  account: Account
}

/** Shown for an account connected before Narsil asked for the rule and calendar write permissions. */
export function ReconnectNotice({ account }: ReconnectNoticeProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reconnect(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await window.narsil.reconnectAccount(account.id)
    setBusy(false)
    if (!result.ok) setError(result.error ?? 'No se pudo reconectar la cuenta.')
  }

  return (
    <div className="reconnect" role="status">
      <p className="reconnect__text">Reconecta esta cuenta para administrar sus reglas y agregar reuniones.</p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        aria-label={`Reconectar ${account.email}`}
        onClick={() => void reconnect()}
      >
        {busy ? 'Esperando a tu navegador…' : 'Reconectar'}
      </button>
      {error && (
        <p className="reconnect__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
