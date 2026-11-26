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

export function Meetings({ meetings }: { meetings: Meeting[] }): React.JSX.Element {
  if (meetings.length === 0) {
    return <p className="empty">No meetings in the next 24 hours. Narsil will remind you 15 and 5 minutes before the next one.</p>
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
            {m.location && <span className="meeting__place">{m.location}</span>}
            {m.link && (
              <a className="meeting__link" href={m.link} target="_blank" rel="noreferrer">
                Join call
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
