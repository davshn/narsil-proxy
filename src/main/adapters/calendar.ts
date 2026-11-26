import { calendar, type calendar_v3 } from '@googleapis/calendar'
import type { OAuth2Client } from 'google-auth-library'
import type { Meeting } from '@shared/types'
import { toMeeting } from '../domain/reminders'
import type { CalendarProvider } from '../app/ports'

const LOOKAHEAD_MS = 24 * 60 * 60_000

/** Google Calendar for one connected account. */
export class CalendarService implements CalendarProvider {
  private readonly api: calendar_v3.Calendar

  constructor(
    auth: OAuth2Client,
    private readonly accountId: string
  ) {
    this.api = calendar({ version: 'v3', auth })
  }

  /** Timed meetings on the primary calendar from now until 24 hours ahead. */
  async upcoming(now = new Date()): Promise<Meeting[]> {
    const res = await this.api.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    })
    return (res.data.items ?? []).flatMap((event) => {
      const meeting = toMeeting(event, this.accountId)
      return meeting ? [meeting] : []
    })
  }
}
