/** Date and time helpers for the "Agregar reunión" form. Times are local `HH:MM`, dates `YYYY-MM-DD`. */

const DEFAULT_MINUTES = 30
const LAST_MINUTE = 23 * 60 + 59

const pad = (n: number): string => String(n).padStart(2, '0')

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Minutes since midnight of `HH:MM`, or NaN. */
export function minutesOf(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN
}

const timeOf = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

/**
 * The form's defaults: the next half hour after `now` (10:07 → 10:30, 10:30 → 11:00) on its own
 * day, lasting 30 minutes but never past that day's 23:59.
 */
export function defaultTimes(now: Date): { date: string; start: string; end: string } {
  const start = new Date(now)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60)
  const startMinutes = start.getHours() * 60 + start.getMinutes()
  return { date: localDate(start), start: localTime(start), end: timeOf(Math.min(startMinutes + DEFAULT_MINUTES, LAST_MINUTE)) }
}

/** The end after Inicio moves from `oldStart` to `newStart`, keeping the duration (30 min if it had none). */
export function shiftEnd(oldStart: string, oldEnd: string, newStart: string): string {
  const begin = minutesOf(newStart)
  if (Number.isNaN(begin)) return oldEnd
  const duration = minutesOf(oldEnd) - minutesOf(oldStart)
  const keep = Number.isNaN(duration) || duration <= 0 ? DEFAULT_MINUTES : duration
  return timeOf(Math.min(begin + keep, LAST_MINUTE))
}

/** The local date and time as an ISO instant; unparseable input stays as typed so the app can reject it. */
export function toIso(date: string, time: string): string {
  const at = new Date(`${date}T${time}`)
  return Number.isNaN(at.getTime()) ? `${date}T${time}` : at.toISOString()
}
