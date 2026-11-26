import type { Meeting, NewMeeting } from '@shared/types'
import { MEETING_RECONNECT, ReconnectRequiredError, type CalendarProvider } from '../../app/ports'
import { toMeetingFromGraph, type GraphEventLike } from '../../domain/graph'
import { GraphError, type GraphClient } from './graphClient'

const LOOKAHEAD_MS = 24 * 60 * 60_000
const EVENT_FIELDS =
  'id,subject,start,end,location,isAllDay,isCancelled,responseStatus,onlineMeeting,onlineMeetingUrl,webLink'
const UTC_TIMES = { Prefer: 'outlook.timezone="UTC"' }

/** Graph's dateTimeTimeZone in UTC: the wall time without a zone designator, plus `UTC`. */
function utcDateTime(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(iso).toISOString().slice(0, -1), timeZone: 'UTC' }
}

/** Outlook calendar for one account through Microsoft Graph. */
export class OutlookCalendar implements CalendarProvider {
  /**
   * @param graph reads with the calendar scope the account granted.
   * @param writeGraph adds meetings; it asks for Calendars.ReadWrite.
   */
  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string,
    private readonly writeGraph: GraphClient = graph
  ) {}

  /** Timed meetings on the default calendar from now until 24 hours ahead, sorted by start. */
  async upcoming(now = new Date()): Promise<Meeting[]> {
    const res = await this.graph.request<{ value?: GraphEventLike[] }>('GET', '/me/calendarView', {
      query: {
        startDateTime: now.toISOString(),
        endDateTime: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
        $top: '50',
        $select: EVENT_FIELDS
      },
      headers: UTC_TIMES
    })
    return (res?.value ?? [])
      .flatMap((event) => {
        const meeting = toMeetingFromGraph(event, this.accountId)
        return meeting ? [meeting] : []
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  }

  /**
   * Adds the meeting to the default calendar in UTC, so the instant never depends on matching a
   * Windows time zone name; Outlook shows it in the user's own zone. Graph answers 403
   * ErrorAccessDenied to a token without Calendars.ReadWrite.
   */
  async createEvent(input: NewMeeting): Promise<Meeting> {
    const body = {
      subject: input.title,
      start: utcDateTime(input.start),
      end: utcDateTime(input.end),
      ...(input.location ? { location: { displayName: input.location } } : {})
    }
    let created: GraphEventLike | undefined
    try {
      created = await this.writeGraph.request<GraphEventLike>('POST', '/me/events', { body, headers: UTC_TIMES })
    } catch (error) {
      if (error instanceof GraphError && error.status === 403 && error.code === 'ErrorAccessDenied') {
        throw new ReconnectRequiredError(MEETING_RECONNECT)
      }
      throw error
    }
    const meeting = created ? toMeetingFromGraph(created, this.accountId) : null
    if (!meeting) throw new Error('Outlook no devolvió la reunión creada.')
    return meeting
  }
}
