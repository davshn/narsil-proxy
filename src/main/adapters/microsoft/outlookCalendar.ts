import type { Meeting } from '@shared/types'
import type { CalendarProvider } from '../../app/ports'
import { toMeetingFromGraph, type GraphEventLike } from '../../domain/graph'
import type { GraphClient } from './graphClient'

const LOOKAHEAD_MS = 24 * 60 * 60_000
const EVENT_FIELDS =
  'id,subject,start,end,location,isAllDay,isCancelled,responseStatus,onlineMeeting,onlineMeetingUrl,webLink'

/** Outlook calendar for one account through Microsoft Graph. */
export class OutlookCalendar implements CalendarProvider {
  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string
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
      headers: { Prefer: 'outlook.timezone="UTC"' }
    })
    return (res?.value ?? [])
      .flatMap((event) => {
        const meeting = toMeetingFromGraph(event, this.accountId)
        return meeting ? [meeting] : []
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  }
}
