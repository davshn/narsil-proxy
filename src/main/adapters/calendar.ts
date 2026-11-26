import { calendar, type calendar_v3 } from '@googleapis/calendar'
import type { OAuth2Client } from 'google-auth-library'
import type { Meeting, NewMeeting } from '@shared/types'
import { toMeeting } from '../domain/reminders'
import { MEETING_RECONNECT, ReconnectRequiredError, type CalendarProvider } from '../app/ports'
import { GOOGLE_CALENDAR_SCOPE } from './googleAuth'
import { isInsufficientScope } from './google/gmailRules'

const LOOKAHEAD_MS = 24 * 60 * 60_000
/** The full calendar scope also lets Narsil add events. */
const WRITE_SCOPES = [GOOGLE_CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar']

/** Google Calendar for one connected account. */
export class CalendarService implements CalendarProvider {
  private readonly api: calendar_v3.Calendar

  constructor(
    private readonly auth: OAuth2Client,
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

  /**
   * Inserts the event on the primary calendar. The ISO times carry their offset; the local time
   * zone tells Google which zone the event belongs to. A grant known to lack the write scope
   * (accounts connected with `calendar.readonly`) fails fast without a request, and Google's 403
   * maps to the same ReconnectRequiredError.
   */
  async createEvent(input: NewMeeting): Promise<Meeting> {
    const granted = this.auth.credentials?.scope
    if (typeof granted === 'string') {
      const scopes = granted.split(/\s+/)
      if (!WRITE_SCOPES.some((scope) => scopes.includes(scope))) throw new ReconnectRequiredError(MEETING_RECONNECT)
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const requestBody: calendar_v3.Schema$Event = {
      summary: input.title,
      ...(input.location ? { location: input.location } : {}),
      start: { dateTime: input.start, timeZone },
      end: { dateTime: input.end, timeZone }
    }
    let res: { data: calendar_v3.Schema$Event }
    try {
      res = await this.api.events.insert({ calendarId: 'primary', requestBody })
    } catch (error) {
      if (isInsufficientScope(error)) throw new ReconnectRequiredError(MEETING_RECONNECT)
      throw error
    }
    const meeting = toMeeting(res.data, this.accountId)
    if (!meeting) throw new Error('Google no devolvió la reunión creada.')
    return meeting
  }
}
