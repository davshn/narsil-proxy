import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuth2Client } from 'google-auth-library'

const api = vi.hoisted(() => ({
  events: {
    list: vi.fn(async (_params: unknown) => ({ data: { items: [] as unknown[] } })),
    insert: vi.fn(async (params: { requestBody?: Record<string, unknown> }) => ({
      data: { id: 'ev-new', status: 'confirmed', ...params.requestBody }
    }))
  }
}))

vi.mock('@googleapis/calendar', () => ({ calendar: () => api }))

const { CalendarService } = await import('../src/main/adapters/calendar')
const { ReconnectRequiredError } = await import('../src/main/app/ports')

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const service = (scope?: string) =>
  new CalendarService({ credentials: scope === undefined ? {} : { scope } } as OAuth2Client, 'g1')

const NEW = { title: 'Revisión', start: '2026-11-26T15:00:00.000Z', end: '2026-11-26T15:30:00.000Z', location: 'Sala 2' }
const MEETING_RECONNECT = 'Reconecta esta cuenta para agregar reuniones.'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Google Calendar new meetings', () => {
  it('inserts the event on the primary calendar with explicit-offset times and the local time zone', async () => {
    const created = await service(`https://www.googleapis.com/auth/gmail.modify ${EVENTS_SCOPE}`).createEvent(NEW)

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(api.events.insert).toHaveBeenCalledWith({
      calendarId: 'primary',
      requestBody: {
        summary: 'Revisión',
        location: 'Sala 2',
        start: { dateTime: '2026-11-26T15:00:00.000Z', timeZone },
        end: { dateTime: '2026-11-26T15:30:00.000Z', timeZone }
      }
    })
    expect(created).toEqual({
      id: 'g1:ev-new',
      accountId: 'g1',
      title: 'Revisión',
      start: '2026-11-26T15:00:00.000Z',
      end: '2026-11-26T15:30:00.000Z',
      location: 'Sala 2'
    })
  })

  it('leaves the location out when there is none', async () => {
    await service().createEvent({ title: 'Café', start: NEW.start, end: NEW.end })
    const body = api.events.insert.mock.calls[0]?.[0].requestBody
    expect(body).not.toHaveProperty('location')
  })

  it('adds a weekly RRULE when the meeting repeats', async () => {
    await service().createEvent({ ...NEW, repeat: { days: ['TU', 'TH'], until: '2027-03-16' } })
    const body = api.events.insert.mock.calls[0]?.[0].requestBody
    expect(body?.recurrence).toEqual([expect.stringMatching(/^RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=2027031\dT\d{6}Z$/)])
    expect(body?.start).toEqual({ dateTime: NEW.start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  })

  it('sends no recurrence for a single meeting', async () => {
    await service().createEvent(NEW)
    expect(api.events.insert.mock.calls[0]?.[0].requestBody).not.toHaveProperty('recurrence')
  })

  it('needs a reconnect without a request when the stored grant only reads the calendar', async () => {
    const old = service(`https://www.googleapis.com/auth/gmail.modify ${READONLY_SCOPE}`)

    const error = await old.createEvent(NEW).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ReconnectRequiredError)
    expect((error as Error).message).toBe(MEETING_RECONNECT)
    expect(api.events.insert).not.toHaveBeenCalled()
    // Reading keeps working with the old grant.
    await expect(old.upcoming(new Date('2026-11-26T12:00:00Z'))).resolves.toEqual([])
    expect(api.events.list).toHaveBeenCalledTimes(1)
  })

  it("turns Google's 403 insufficientPermissions into ReconnectRequiredError", async () => {
    api.events.insert.mockRejectedValueOnce(
      Object.assign(new Error('Request had insufficient authentication scopes.'), {
        code: 403,
        errors: [{ reason: 'insufficientPermissions' }]
      })
    )
    const error = await service().createEvent(NEW).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReconnectRequiredError)
    expect((error as Error).message).toBe(MEETING_RECONNECT)
  })

  it('passes other errors through unchanged', async () => {
    api.events.insert.mockRejectedValueOnce(Object.assign(new Error('Backend Error'), { code: 500 }))
    await expect(service().createEvent(NEW)).rejects.toThrow('Backend Error')
  })
})
