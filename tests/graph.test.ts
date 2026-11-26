import { describe, expect, it } from 'vitest'
import { parseGraphMessage, toMeetingFromGraph, type GraphEventLike, type GraphMessageLike } from '../src/main/domain/graph'

const ACCOUNT = 'acc-1'

function message(overrides: Partial<GraphMessageLike> = {}): GraphMessageLike {
  return {
    id: 'AAMk-1',
    conversationId: 'conv-1',
    subject: 'Reporte semanal',
    from: { emailAddress: { name: 'Ana Pérez', address: 'ana@contoso.com' } },
    replyTo: [],
    bodyPreview: 'Hola, adjunto el reporte',
    body: { contentType: 'text', content: '  Hola, adjunto el reporte.\n  ' },
    receivedDateTime: '2026-11-25T10:00:00Z',
    internetMessageId: '<abc@contoso.com>',
    ...overrides
  }
}

function event(overrides: Partial<GraphEventLike> = {}): GraphEventLike {
  return {
    id: 'evt-1',
    subject: 'Revisión de diseño',
    start: { dateTime: '2026-11-26T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-26T15:30:00.0000000', timeZone: 'UTC' },
    location: { displayName: 'Sala 3' },
    isAllDay: false,
    isCancelled: false,
    responseStatus: { response: 'accepted' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    onlineMeetingUrl: null,
    ...overrides
  }
}

describe('parseGraphMessage', () => {
  it('maps the summary fields and sets accountId', () => {
    const parsed = parseGraphMessage(message(), ACCOUNT)
    expect(parsed.summary).toEqual({
      id: 'AAMk-1',
      accountId: ACCOUNT,
      threadId: 'conv-1',
      from: 'Ana Pérez <ana@contoso.com>',
      replyTo: 'Ana Pérez <ana@contoso.com>',
      subject: 'Reporte semanal',
      snippet: 'Hola, adjunto el reporte',
      receivedAt: '2026-11-25T10:00:00.000Z'
    })
    expect(parsed.bodyText).toBe('Hola, adjunto el reporte.')
    expect(parsed.replyTo).toBe('Ana Pérez <ana@contoso.com>')
    expect(parsed.messageId).toBe('<abc@contoso.com>')
  })

  it('uses the Gmail placeholders for a missing subject and sender', () => {
    const parsed = parseGraphMessage(message({ subject: '   ', from: null }), ACCOUNT)
    expect(parsed.summary.subject).toBe('(Sin asunto)')
    expect(parsed.summary.from).toBe('(Remitente desconocido)')
    expect(parsed.replyTo).toBe('(Remitente desconocido)')
  })

  it('formats an address without a name as the bare address', () => {
    const parsed = parseGraphMessage(message({ from: { emailAddress: { name: '', address: 'bot@contoso.com' } } }), ACCOUNT)
    expect(parsed.summary.from).toBe('bot@contoso.com')
  })

  it('replies to the first replyTo address when present', () => {
    const parsed = parseGraphMessage(
      message({
        replyTo: [
          { emailAddress: { name: 'Soporte', address: 'soporte@contoso.com' } },
          { emailAddress: { name: 'Otro', address: 'otro@contoso.com' } }
        ]
      }),
      ACCOUNT
    )
    expect(parsed.replyTo).toBe('Soporte <soporte@contoso.com>')
    expect(parsed.summary.replyTo).toBe('Soporte <soporte@contoso.com>')
    expect(parsed.summary.from).toBe('Ana Pérez <ana@contoso.com>')
  })

  it('falls back to From when replyTo is missing', () => {
    const parsed = parseGraphMessage(message({ replyTo: null }), ACCOUNT)
    expect(parsed.replyTo).toBe('Ana Pérez <ana@contoso.com>')
  })

  it('converts an HTML body to text', () => {
    const parsed = parseGraphMessage(message({ body: { contentType: 'html', content: '<p>Hola&nbsp;<b>equipo</b></p>' } }), ACCOUNT)
    expect(parsed.bodyText).toBe('Hola equipo')
  })
})

describe('toMeetingFromGraph', () => {
  it('maps a timed event with a composite id and normalized UTC times', () => {
    expect(toMeetingFromGraph(event(), ACCOUNT)).toEqual({
      id: 'acc-1:evt-1',
      accountId: ACCOUNT,
      title: 'Revisión de diseño',
      start: '2026-11-26T15:00:00.000Z',
      end: '2026-11-26T15:30:00.000Z',
      location: 'Sala 3',
      link: 'https://teams.microsoft.com/l/meetup-join/abc'
    })
  })

  it('treats Graph times without a zone designator as UTC', () => {
    const meeting = toMeetingFromGraph(
      event({ start: { dateTime: '2026-11-26T08:05:00.0000000', timeZone: 'UTC' } }),
      ACCOUNT
    )
    expect(meeting?.start).toBe('2026-11-26T08:05:00.000Z')
  })

  it('skips all-day, cancelled and declined events', () => {
    expect(toMeetingFromGraph(event({ isAllDay: true }), ACCOUNT)).toBeNull()
    expect(toMeetingFromGraph(event({ isCancelled: true }), ACCOUNT)).toBeNull()
    expect(toMeetingFromGraph(event({ responseStatus: { response: 'declined' } }), ACCOUNT)).toBeNull()
  })

  it('falls back to a placeholder title and omits an empty location', () => {
    const meeting = toMeetingFromGraph(event({ subject: '  ', location: { displayName: '' } }), ACCOUNT)
    expect(meeting?.title).toBe('(Reunión sin título)')
    expect(meeting).not.toHaveProperty('location')
  })

  it('uses onlineMeetingUrl when there is no joinUrl', () => {
    const meeting = toMeetingFromGraph(
      event({ onlineMeeting: null, onlineMeetingUrl: 'https://meet.contoso.com/123' }),
      ACCOUNT
    )
    expect(meeting?.link).toBe('https://meet.contoso.com/123')
  })

  it('keeps only https links', () => {
    expect(toMeetingFromGraph(event({ onlineMeeting: { joinUrl: 'http://insecure.example/join' } }), ACCOUNT)).not.toHaveProperty('link')
    expect(toMeetingFromGraph(event({ onlineMeeting: { joinUrl: 'javascript:alert(1)' } }), ACCOUNT)).not.toHaveProperty('link')
    expect(toMeetingFromGraph(event({ onlineMeeting: null, onlineMeetingUrl: null }), ACCOUNT)).not.toHaveProperty('link')
  })

  it('returns null without an id or start time', () => {
    expect(toMeetingFromGraph(event({ id: null }), ACCOUNT)).toBeNull()
    expect(toMeetingFromGraph(event({ start: null }), ACCOUNT)).toBeNull()
  })
})
