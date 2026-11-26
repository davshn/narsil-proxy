import { useState } from 'react'
import type { Account, Meeting } from '@shared/types'
import { MeetingForm } from './MeetingForm'

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function dayLabel(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'day')
    return relative.charAt(0).toUpperCase() + relative.slice(1)
  }
  return date.toLocaleDateString([], { weekday: 'long' })
}

interface MeetingsProps {
  meetings: Meeting[]
  /** Connected accounts, for "Agregar reunión". */
  accounts: Account[]
  /** The calendar's account email, or undefined when only one account is connected. */
  accountLabel(accountId: string): string | undefined
  /** A meeting was added. */
  onCreated(): void
}

export function Meetings({ meetings, accounts, accountLabel, onCreated }: MeetingsProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  return (
    <section aria-label="Reuniones">
      {adding && accounts.length > 0 ? (
        <MeetingForm
          accounts={accounts}
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false)
            onCreated()
          }}
        />
      ) : (
        accounts.length > 0 && (
          <div className="meetings__head">
            <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
              Agregar reunión
            </button>
          </div>
        )
      )}
      <MeetingList meetings={meetings} accountLabel={accountLabel} />
    </section>
  )
}

function MeetingList({ meetings, accountLabel }: Pick<MeetingsProps, 'meetings' | 'accountLabel'>): React.JSX.Element {
  if (meetings.length === 0) {
    return <p className="empty">No tienes reuniones en las próximas 24 horas. Narsil te avisará 15 y 5 minutos antes de la siguiente.</p>
  }
  return (
    <ul className="meetings">
      {meetings.map((m) => (
        <li key={`${m.id}-${m.start}`} className="meeting">
          <div className="meeting__when">
            <span className="meeting__time">{time(m.start)}</span>
            <span className="meeting__day">{dayLabel(m.start)}</span>
          </div>
          <div className="meeting__what">
            <span className="meeting__title">{m.title}</span>
            {accountLabel(m.accountId) && <span className="account-tag">{accountLabel(m.accountId)}</span>}
            {m.location && <span className="meeting__place">{m.location}</span>}
            {m.link && (
              <a className="meeting__link" href={m.link} target="_blank" rel="noreferrer">
                Unirse a la llamada
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
