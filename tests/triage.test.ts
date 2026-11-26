import { describe, expect, it } from 'vitest'
import { MAX_BODY_CHARS, MAX_REPLIES, buildTriageInput, normalizeTriage } from '../src/main/domain/triage'
import type { ParsedEmail } from '../src/main/domain/email'

const email: ParsedEmail = {
  summary: {
    id: 'm1',
    threadId: 't1',
    from: 'Ana <ana@example.com>',
    subject: 'Reunión',
    snippet: 'Hola',
    receivedAt: '2026-11-25T10:00:00.000Z'
  },
  bodyText: 'Hola, ¿nos vemos mañana?',
  replyTo: 'Ana <ana@example.com>'
}

describe('buildTriageInput', () => {
  it('wraps sender, subject and body as untrusted email data', () => {
    const input = buildTriageInput(email)
    expect(input).toContain('<email>')
    expect(input).toContain('<from>Ana <ana@example.com></from>')
    expect(input).toContain('<subject>Reunión</subject>')
    expect(input).toContain('<body>\nHola, ¿nos vemos mañana?\n</body>')
    expect(input).toContain('</email>')
  })

  it('falls back to the snippet when the body is empty', () => {
    expect(buildTriageInput({ ...email, bodyText: '' })).toContain('<body>\nHola\n</body>')
  })

  it('caps very long bodies and says so', () => {
    const input = buildTriageInput({ ...email, bodyText: 'a'.repeat(MAX_BODY_CHARS + 500) })
    expect(input).toContain('a'.repeat(MAX_BODY_CHARS))
    expect(input).not.toContain('a'.repeat(MAX_BODY_CHARS + 1))
    expect(input).toContain('[Body truncated: 500 more characters not shown]')
  })
})

describe('normalizeTriage', () => {
  it(`keeps at most ${MAX_REPLIES} non-empty replies`, () => {
    const triage = normalizeTriage({
      summary: ' Ana asks to meet ',
      recommendedAction: 'reply',
      reason: 'Direct question',
      replies: [
        { label: 'Yes', body: 'Sí' },
        { label: 'Empty', body: '   ' },
        { label: 'No', body: 'No puedo' },
        { label: 'Later', body: 'Te confirmo luego' },
        { label: 'Extra', body: 'Otra' }
      ]
    })
    expect(triage.summary).toBe('Ana asks to meet')
    expect(triage.replies.map((r) => r.label)).toEqual(['Yes', 'No', 'Later'])
  })

  it('downgrades a reply recommendation without usable replies to save', () => {
    const triage = normalizeTriage({ summary: 's', recommendedAction: 'reply', reason: 'r', replies: [] })
    expect(triage.recommendedAction).toBe('save')
  })
})
