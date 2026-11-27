import { WEEKDAYS, type Weekday, type WeeklyRepeat } from '@shared/types'

/** JavaScript's getDay() of each calendar code (Sunday is 0). */
const JS_DAY: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 }
const GRAPH_DAY: Record<Weekday, string> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The local wall time `YYYY-MM-DDTHH:MM:SS`, for calendars that take a time zone name beside it. */
export function localWallTime(d: Date): string {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `YYYY-MM-DD` as a real local calendar day, or null (2027-02-30 is not one). */
function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return localDate(day) === value ? day : null
}

/** Moves a local time by whole days, keeping the wall-clock time across daylight-saving changes. */
function addDays(d: Date, days: number): Date {
  const moved = new Date(d)
  moved.setDate(moved.getDate() + days)
  return moved
}

/**
 * Checks a weekly series and moves the meeting to its first real occurrence: the first chosen
 * day on or after its date, at the same local time. Calendars disagree on a start that does not
 * match the pattern, so Narsil never sends one.
 */
export function planWeekly(start: Date, end: Date, repeat: WeeklyRepeat): { start: Date; end: Date; repeat: WeeklyRepeat } {
  const days = WEEKDAYS.filter((day) => repeat.days.includes(day))
  if (days.length === 0) throw new Error('Elige al menos un día para repetir la reunión.')
  const until = parseDay(repeat.until)
  if (!until) throw new Error('La fecha final de la repetición no es válida.')
  const wanted = new Set(days.map((day) => JS_DAY[day]))
  let shift = 0
  while (!wanted.has((start.getDay() + shift) % 7)) shift += 1
  const first = addDays(start, shift)
  if (localDate(first) > repeat.until) throw new Error('La fecha final debe ser igual o posterior a la primera reunión.')
  return { start: first, end: addDays(end, shift), repeat: { days, until: repeat.until } }
}

/** Google Calendar's RRULE. UNTIL is the last local second of the end date, in UTC as Google requires. */
export function googleRecurrence(repeat: WeeklyRepeat): string[] {
  const until = parseDay(repeat.until)
  if (!until) throw new Error('La fecha final de la repetición no es válida.')
  until.setHours(23, 59, 59, 0)
  const stamp = until
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  return [`RRULE:FREQ=WEEKLY;BYDAY=${repeat.days.join(',')};UNTIL=${stamp}`]
}

/** Microsoft Graph's patternedRecurrence, from the first meeting's local date to the end date. */
export function graphRecurrence(
  start: Date,
  repeat: WeeklyRepeat,
  timeZone: string
): {
  pattern: { type: 'weekly'; interval: 1; daysOfWeek: string[]; firstDayOfWeek: 'monday' }
  range: { type: 'endDate'; startDate: string; endDate: string; recurrenceTimeZone: string }
} {
  return {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: repeat.days.map((day) => GRAPH_DAY[day]), firstDayOfWeek: 'monday' },
    range: { type: 'endDate', startDate: localDate(start), endDate: repeat.until, recurrenceTimeZone: timeZone }
  }
}
