import { useState } from 'react'
import type { Account } from '@shared/types'
import { ReconnectNotice } from './ReconnectNotice'
import { defaultTimes, shiftEnd, toIso } from './meetingTimes'

/** The app checks these again; the inputs only keep typing within them. */
const MAX_TITLE = 200
const MAX_LOCATION = 200

interface MeetingFormProps {
  /** Connected accounts; the first one is preselected. Never empty. */
  accounts: Account[]
  onCancel(): void
  /** The meeting was added and the account's calendar read again. */
  onCreated(): void
}

/** "Agregar reunión": adds a meeting to the chosen account's primary calendar, in local time. */
export function MeetingForm({ accounts, onCancel, onCreated }: MeetingFormProps): React.JSX.Element {
  const [initial] = useState(() => defaultTimes(new Date()))
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(initial.date)
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = accounts.find((a) => a.id === accountId)

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await window.narsil.createMeeting(accountId, {
      title,
      start: toIso(date, start),
      end: toIso(date, end),
      ...(location.trim() ? { location } : {})
    })
    setBusy(false)
    if (result.ok) onCreated()
    else setError(result.error ?? 'No se pudo agregar la reunión.')
  }

  return (
    <form
      className="meeting-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3>Agregar reunión</h3>
      <label>
        Título
        <input value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="Revisión semanal" />
      </label>
      <label>
        Cuenta
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>
      {account?.needsReconnect && <ReconnectNotice account={account} />}
      <div className="meeting-form__when">
        <label className="meeting-form__date">
          Fecha
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Inicio
          <input
            type="time"
            value={start}
            onChange={(e) => {
              setEnd(shiftEnd(start, end, e.target.value))
              setStart(e.target.value)
            }}
          />
        </label>
        <label>
          Fin
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label>
        Ubicación
        <input value={location} maxLength={MAX_LOCATION} onChange={(e) => setLocation(e.target.value)} placeholder="Opcional" />
      </label>
      {error && !account?.needsReconnect && (
        <p className="meeting-form__error" role="alert">
          {error}
        </p>
      )}
      <div className="meeting-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !accountId}>
          {busy ? 'Agregando…' : 'Agregar'}
        </button>
      </div>
    </form>
  )
}
