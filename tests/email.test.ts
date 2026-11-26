import { describe, expect, it } from 'vitest'
import { buildReplyRaw, htmlToText, parseMessage, replySubject } from '../src/main/domain/email'

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const decodeRaw = (raw: string): string => Buffer.from(raw, 'base64url').toString('utf8')

const baseMessage = {
  id: 'm1',
  threadId: 't1',
  snippet: 'Hola, ¿nos vemos mañana?',
  internalDate: String(Date.parse('2026-11-25T10:00:00Z')),
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Ana <ana@example.com>' },
      { name: 'subject', value: 'Reunión' },
      { name: 'Message-ID', value: '<abc@mail.example.com>' },
      { name: 'References', value: '<root@mail.example.com>' }
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('Hola, ¿nos vemos mañana?') } },
      { mimeType: 'text/html', body: { data: b64url('<p>Hola</p>') } }
    ]
  }
}

describe('parseMessage', () => {
  it('extracts the summary fields with case-insensitive headers', () => {
    const parsed = parseMessage(baseMessage)
    expect(parsed.summary).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'Ana <ana@example.com>',
      subject: 'Reunión',
      snippet: 'Hola, ¿nos vemos mañana?',
      receivedAt: '2026-11-25T10:00:00.000Z',
      replyTo: 'Ana <ana@example.com>'
    })
    expect(parsed.messageId).toBe('<abc@mail.example.com>')
    expect(parsed.references).toBe('<root@mail.example.com>')
  })

  it('prefers the text/plain part and decodes UTF-8', () => {
    expect(parseMessage(baseMessage).bodyText).toBe('Hola, ¿nos vemos mañana?')
  })

  it('falls back to stripped HTML when there is no text part', () => {
    const htmlOnly = {
      ...baseMessage,
      payload: {
        ...baseMessage.payload,
        mimeType: 'text/html',
        parts: undefined,
        body: { data: b64url('<style>p{}</style><p>Hola&nbsp;<b>Ana</b> &amp; equipo</p>') }
      }
    }
    expect(parseMessage(htmlOnly).bodyText).toBe('Hola Ana & equipo')
  })

  it('replies to Reply-To when present, otherwise to From', () => {
    expect(parseMessage(baseMessage).replyTo).toBe('Ana <ana@example.com>')
    const withReplyTo = {
      ...baseMessage,
      payload: {
        ...baseMessage.payload,
        headers: [...baseMessage.payload.headers, { name: 'Reply-To', value: 'team@example.com' }]
      }
    }
    expect(parseMessage(withReplyTo).replyTo).toBe('team@example.com')
  })

  it('uses placeholders when subject and sender are missing', () => {
    const bare = { id: 'm2', threadId: 't2', payload: { headers: [] } }
    const parsed = parseMessage(bare)
    expect(parsed.summary.subject).toBe('(Sin asunto)')
    expect(parsed.summary.from).toBe('(Remitente desconocido)')
    expect(parsed.bodyText).toBe('')
  })
})

describe('replySubject', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Reunión')).toBe('Re: Reunión')
    expect(replySubject('RE: Reunión')).toBe('RE: Reunión')
    expect(replySubject('')).toBe('Re:')
  })
})

describe('buildReplyRaw', () => {
  const raw = buildReplyRaw({
    to: 'Ana <ana@example.com>',
    subject: 'Reunión',
    inReplyTo: '<abc@mail.example.com>',
    references: '<root@mail.example.com>',
    body: 'Sí, mañana a las 10 está perfecto.'
  })
  const decoded = decodeRaw(raw)
  const [headerBlock = '', bodyBlock = ''] = decoded.split('\r\n\r\n')

  it('threads the reply with In-Reply-To and a References chain', () => {
    expect(headerBlock).toContain('To: Ana <ana@example.com>')
    expect(headerBlock).toContain('In-Reply-To: <abc@mail.example.com>')
    expect(headerBlock).toContain('References: <root@mail.example.com> <abc@mail.example.com>')
  })

  it('encodes a non-ASCII subject as RFC 2047 and the body as UTF-8 base64', () => {
    expect(headerBlock).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Reunión').toString('base64')}?=`)
    expect(headerBlock).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(headerBlock).toContain('Content-Transfer-Encoding: base64')
    expect(Buffer.from(bodyBlock.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'Sí, mañana a las 10 está perfecto.'
    )
  })

  it('strips CR and LF from header values to prevent header injection', () => {
    const injected = decodeRaw(
      buildReplyRaw({ to: 'a@example.com\r\nBcc: evil@example.com', subject: 'Hi\nBcc: x', body: 'ok' })
    )
    const headers = injected.split('\r\n\r\n')[0] ?? ''
    expect(headers.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false)
  })
})

describe('htmlToText', () => {
  it('does not throw on out-of-range numeric entities', () => {
    expect(htmlToText('<p>Hi &#99999999; &#x110000; there</p>')).toBe('Hi � � there')
    expect(htmlToText('<p>caf&#233; &#x2603;</p>')).toBe('café ☃')
  })
})

describe('parseMessage reply target', () => {
  it('exposes the reply address in the summary so the user can see it', () => {
    const withReplyTo = {
      ...baseMessage,
      payload: {
        ...baseMessage.payload,
        headers: [...baseMessage.payload.headers, { name: 'Reply-To', value: 'other@example.net' }]
      }
    }
    expect(parseMessage(withReplyTo).summary.replyTo).toBe('other@example.net')
    expect(parseMessage(baseMessage).summary.replyTo).toBe('Ana <ana@example.com>')
  })
})
