import { describe, expect, it } from 'vitest'
import {
  describeRuleAction,
  describeServerRuleAction,
  emailAddress,
  findMatchingRule,
  normalizeRule,
  normalizeServerRule,
  ruleDraftFromEmail,
  serverActionForLocal,
  serverRuleDraftFromEmail
} from '@shared/rules'
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
    const r = normalizeRule({ name: '', enabled: true, action: 'archive', conditions: { from: 'banco.com', subject: '', body: '' } }, 'x')
    expect(r.name).toBe('Remitente contiene "banco.com"')
  })

  it('requires a folder for a save rule', () => {
    expect(() =>
      normalizeRule({ name: '', enabled: true, action: 'save', conditions: { from: 'banco.com', subject: '', body: '' } }, 'x')
    ).toThrow('Elige la carpeta donde se guardan estos correos.')
  })

  it('keeps the folder of a save rule and drops it for other actions', () => {
    const folder = { accountId: 'g1', id: 'Label_1', name: ' Bancos ' }
    const conditions = { from: 'banco.com', subject: '', body: '' }
    expect(normalizeRule({ name: 'B', enabled: true, action: 'save', conditions, folder }, 'x').folder).toEqual({
      accountId: 'g1',
      id: 'Label_1',
      name: 'Bancos'
    })
    expect(normalizeRule({ name: 'B', enabled: true, action: 'archive', conditions, folder }, 'x')).not.toHaveProperty('folder')
  })
})

describe('findMatchingRule with folders', () => {
  const conditions = { from: 'shop.example', subject: '', body: '' }

  it('still matches a local rule on any account', () => {
    const r = rule({ conditions })
    expect(findMatchingRule([r], { ...email, accountId: 'g2' })).toBe(r)
  })

  it('matches an old save rule without a folder on any account', () => {
    const r = rule({ action: 'save', conditions })
    expect(findMatchingRule([r], { ...email, accountId: 'g2' })).toBe(r)
  })

  it('matches a save rule only on the account its folder belongs to', () => {
    const r = rule({ action: 'save', conditions, folder: { accountId: 'g1', id: 'Label_1', name: 'Tiendas' } })
    const fallback = rule({ id: 'r2', action: 'archive', conditions })
    expect(findMatchingRule([r, fallback], { ...email, accountId: 'g1' })).toBe(r)
    expect(findMatchingRule([r, fallback], { ...email, accountId: 'g2' })).toBe(fallback)
  })
})

describe('describeRuleAction', () => {
  it('names the folder of a save rule and marks an old one without a folder as archive', () => {
    expect(describeRuleAction(rule({ action: 'save', folder: { accountId: 'g1', id: 'L', name: 'Bancos' } }))).toBe(
      'mover a la carpeta "Bancos"'
    )
    expect(describeRuleAction(rule({ action: 'save' }))).toBe('archivar (regla anterior sin carpeta)')
    expect(describeRuleAction(rule({ action: 'archive' }))).toBe('archivar')
    expect(describeRuleAction(rule({ action: 'delete' }))).toBe('mover a la papelera')
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

describe('server rules', () => {
  const conditions = { from: ' shop.example ', subject: '', body: '' }

  it('normalizes a server rule: trims conditions, names it from them and drops the folder unless it moves', () => {
    expect(normalizeServerRule({ name: ' ', conditions, action: 'archive', folderId: 'L1', folderName: 'X' })).toEqual({
      name: 'Remitente contiene "shop.example"',
      conditions: { from: 'shop.example', subject: '', body: '' },
      action: 'archive'
    })
    expect(normalizeServerRule({ name: 'Tienda', conditions, action: 'move', folderId: 'L1', folderName: ' Compras ' })).toEqual({
      name: 'Tienda',
      conditions: { from: 'shop.example', subject: '', body: '' },
      action: 'move',
      folderId: 'L1',
      folderName: 'Compras'
    })
  })

  it('rejects a server rule without conditions, and a move without a folder', () => {
    expect(() => normalizeServerRule({ name: 'x', conditions: { from: ' ', subject: '', body: '' }, action: 'delete' })).toThrow(
      'Agrega al menos una condición.'
    )
    expect(() => normalizeServerRule({ name: 'x', conditions, action: 'move' })).toThrow(
      'Elige la carpeta donde se guardan estos correos.'
    )
  })

  it('drafts a server rule from an email on that email account', () => {
    expect(serverRuleDraftFromEmail(email.from, 'g2')).toEqual({
      accountId: 'g2',
      name: 'Correos de promo@shop.example',
      action: 'archive',
      conditions: { from: 'promo@shop.example', subject: '', body: '' }
    })
  })

  it('describes server rule actions', () => {
    expect(describeServerRuleAction({ action: 'archive' })).toBe('archivar')
    expect(describeServerRuleAction({ action: 'delete' })).toBe('mover a la papelera')
    expect(describeServerRuleAction({ action: 'move', folderName: 'Compras' })).toBe('mover a la carpeta "Compras"')
  })

  it('maps a local rule to the server action that replaces it', () => {
    expect(serverActionForLocal('archive')).toBe('archive')
    expect(serverActionForLocal('delete')).toBe('delete')
    expect(serverActionForLocal('save')).toBe('move')
  })
})
