import type { Meeting } from '@shared/types'

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
  /** The calendar's account email, or undefined when only one account is connected. */
  accountLabel(accountId: string): string | undefined
}

export function Meetings({ meetings, accountLabel }: MeetingsProps): React.JSX.Element {
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
