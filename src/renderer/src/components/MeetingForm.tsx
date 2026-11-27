import { useState } from 'react'
import { WEEKDAYS, type Account, type Weekday } from '@shared/types'
import { ReconnectNotice } from './ReconnectNotice'
import { addDays, defaultTimes, shiftEnd, toIso, weekdayOf } from './meetingTimes'

/** The app checks these again; the inputs only keep typing within them. */
const MAX_TITLE = 200
const MAX_LOCATION = 200

/** A new series runs eight weeks unless the user picks another end date. */
const DEFAULT_REPEAT_DAYS = 7 * 8

const DAY_NAMES: Record<Weekday, { short: string; long: string }> = {
  MO: { short: 'L', long: 'lunes' },
  TU: { short: 'M', long: 'martes' },
  WE: { short: 'X', long: 'miércoles' },
  TH: { short: 'J', long: 'jueves' },
  FR: { short: 'V', long: 'viernes' },
  SA: { short: 'S', long: 'sábado' },
  SU: { short: 'D', long: 'domingo' }
}

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
  const [repeating, setRepeating] = useState(false)
  const [days, setDays] = useState<Weekday[]>([])
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = accounts.find((a) => a.id === accountId)

  /** Turning repetition on starts with the chosen date's weekday and an eight-week end. */
  function toggleRepeat(on: boolean): void {
    setRepeating(on)
    if (!on) return
    const day = weekdayOf(date)
    if (days.length === 0 && day) setDays([day])
    if (!until) setUntil(addDays(date, DEFAULT_REPEAT_DAYS))
  }

  function toggleDay(day: Weekday, on: boolean): void {
    setDays((current) => (on ? [...current, day] : current.filter((d) => d !== day)))
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await window.narsil.createMeeting(accountId, {
      title,
      start: toIso(date, start),
      end: toIso(date, end),
      ...(location.trim() ? { location } : {}),
      ...(repeating ? { repeat: { days, until } } : {})
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
      <label className="meeting-form__repeat">
        <input type="checkbox" checked={repeating} onChange={(e) => toggleRepeat(e.target.checked)} />
        Repetir cada semana
      </label>
      {repeating && (
        <fieldset className="meeting-form__series">
          <legend>Los días</legend>
          <div className="meeting-form__days">
            {WEEKDAYS.map((day) => (
              <label key={day} className="day-toggle" title={DAY_NAMES[day].long}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  aria-label={DAY_NAMES[day].long}
                  onChange={(e) => toggleDay(day, e.target.checked)}
                />
                <span aria-hidden="true">{DAY_NAMES[day].short}</span>
              </label>
            ))}
          </div>
          <label>
            Hasta
            <input type="date" value={until} min={date} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <p className="meeting-form__hint">
            Si la fecha no cae en uno de estos días, la primera reunión será el siguiente día elegido.
          </p>
        </fieldset>
      )}
      <label>
        Ubicación
        <input value={location} maxLength={MAX_LOCATION} onChange={(e) => setLocation(e.target.value)} placeholder="Opcional" />
      </label>
      {/* The reconnect notice above already says it; any other error must still show. */}
      {error && !(account?.needsReconnect && error.startsWith('Reconecta esta cuenta')) && (
        <p className="meeting-form__error" role="alert">
          {error}
        </p>
      )}
      <div className="meeting-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !accountId || (repeating && days.length === 0)}>
          {busy ? 'Agregando…' : repeating ? 'Agregar serie' : 'Agregar'}
        </button>
      </div>
    </form>
  )
}
