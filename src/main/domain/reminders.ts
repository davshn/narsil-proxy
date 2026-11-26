import type { Meeting, ReminderAlert } from '@shared/types'

/** Minutes before a meeting at which Narsil alerts, largest first. */
export const REMINDER_THRESHOLDS_MIN = [15, 5] as const

const MINUTE_MS = 60_000

/** The subset of a Google Calendar event that Narsil reads. */
export interface CalendarEventLike {
  id?: string | null
  summary?: string | null
  status?: string | null
  location?: string | null
  hangoutLink?: string | null
  start?: { dateTime?: string | null; date?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null } | null
  attendees?: Array<{ self?: boolean | null; responseStatus?: string | null }> | null
}

/**
 * Maps a Calendar event to a Meeting, or null when it should not trigger reminders:
 * all-day events, cancelled events and events the user declined.
 */
export function toMeeting(event: CalendarEventLike): Meeting | null {
  const startRaw = event.start?.dateTime
  const endRaw = event.end?.dateTime
  if (!event.id || !startRaw || !endRaw) return null
  if (event.status === 'cancelled') return null
  const self = event.attendees?.find((a) => a.self)
  if (self?.responseStatus === 'declined') return null

  const meeting: Meeting = {
    id: event.id,
    title: event.summary?.trim() || '(Untitled meeting)',
    start: new Date(startRaw).toISOString(),
    end: new Date(endRaw).toISOString()
  }
  if (event.location) meeting.location = event.location
  if (event.hangoutLink) meeting.link = event.hangoutLink
  return meeting
}

/** Stable identity of one alert; includes the start so a rescheduled meeting alerts again. */
export function reminderKey(meeting: Meeting, thresholdMinutes: number): string {
  return `${meeting.id}|${meeting.start}|${thresholdMinutes}`
}

/**
 * Returns the alerts due at `now` that are not in `fired`.
 *
 * For each upcoming meeting only the most recent threshold already reached can fire,
 * so starting the app 4 minutes before a meeting yields one 5-minute alert instead of
 * a stale 15-minute alert followed by the 5-minute one.
 */
export function dueReminders(
  meetings: readonly Meeting[],
  now: Date,
  fired: ReadonlySet<string>
): ReminderAlert[] {
  const alerts: ReminderAlert[] = []
  const nowMs = now.getTime()

  for (const meeting of meetings) {
    const startMs = Date.parse(meeting.start)
    if (Number.isNaN(startMs) || nowMs >= startMs) continue

    const reached = REMINDER_THRESHOLDS_MIN.filter((t) => nowMs >= startMs - t * MINUTE_MS)
    const latest = reached.at(-1)
    if (latest === undefined) continue

    const key = reminderKey(meeting, latest)
    if (fired.has(key)) continue

    alerts.push({
      key,
      meeting,
      thresholdMinutes: latest,
      minutesUntil: Math.ceil((startMs - nowMs) / MINUTE_MS)
    })
  }
  return alerts
}
