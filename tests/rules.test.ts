import { describe, expect, it } from 'vitest'
import { emailAddress, findMatchingRule, normalizeRule, ruleDraftFromEmail } from '@shared/rules'
import type { Rule } from '@shared/types'

const email = { from: 'Ofertas Top <promo@Shop.example>', subject: '70% de descuento solo HOY', body: 'Compra ya. Darse de baja aquí.' }

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Promos',
    enabled: true,
    action: 'delete',
    conditions: { from: '', subject: '', body: '' },
    ...overrides
  }
}

describe('findMatchingRule', () => {
  it('matches a sender condition case-insensitively', () => {
    const r = rule({ conditions: { from: 'shop.example', subject: '', body: '' } })
    expect(findMatchingRule([r], email)).toBe(r)
  })

  it('requires every non-empty condition to match', () => {
    const both = rule({ conditions: { from: 'shop.example', subject: 'descuento', body: '' } })
    const wrongSubject = rule({ conditions: { from: 'shop.example', subject: 'factura', body: '' } })
    expect(findMatchingRule([both], email)).toBe(both)
    expect(findMatchingRule([wrongSubject], email)).toBeNull()
  })

  it('matches on body text', () => {
    const r = rule({ conditions: { from: '', subject: '', body: 'darse de baja' } })
    expect(findMatchingRule([r], email)).toBe(r)
  })

  it('skips disabled rules', () => {
    const r = rule({ enabled: false, conditions: { from: 'shop.example', subject: '', body: '' } })
    expect(findMatchingRule([r], email)).toBeNull()
  })

  it('never matches a rule without conditions', () => {
    expect(findMatchingRule([rule()], email)).toBeNull()
  })

  it('returns the first matching rule in list order', () => {
    const first = rule({ id: 'a', action: 'archive', conditions: { from: 'shop', subject: '', body: '' } })
    const second = rule({ id: 'b', conditions: { from: 'shop', subject: '', body: '' } })
    expect(findMatchingRule([first, second], email)?.id).toBe('a')
  })
})

describe('normalizeRule', () => {
  it('trims fields and keeps the given id', () => {
    const r = normalizeRule(
      { name: '  Promos ', enabled: true, action: 'archive', conditions: { from: ' shop.example ', subject: '', body: ' ' } },
      'id-1'
    )
    expect(r).toEqual({
      id: 'id-1',
      name: 'Promos',
      enabled: true,
      action: 'archive',
      conditions: { from: 'shop.example', subject: '', body: '' }
    })
  })

  it('rejects a rule without any condition', () => {
    expect(() =>
      normalizeRule({ name: 'Todo', enabled: true, action: 'delete', conditions: { from: ' ', subject: '', body: '' } }, 'x')
    ).toThrow('Agrega al menos una condición.')
  })

  it('names an unnamed rule after its conditions', () => {
    const r = normalizeRule({ name: '', enabled: true, action: 'save', conditions: { from: 'banco.com', subject: '', body: '' } }, 'x')
    expect(r.name).toBe('Remitente contiene "banco.com"')
  })
})

describe('ruleDraftFromEmail', () => {
  it('prefills the sender address and archive action', () => {
    expect(ruleDraftFromEmail(email.from)).toEqual({
      name: 'Correos de promo@shop.example',
      enabled: true,
      action: 'archive',
      conditions: { from: 'promo@shop.example', subject: '', body: '' }
    })
  })

  it('extracts the address from a display name or a bare address', () => {
    expect(emailAddress('Ana <ANA@example.com>')).toBe('ana@example.com')
    expect(emailAddress(' bob@example.com ')).toBe('bob@example.com')
  })
})
