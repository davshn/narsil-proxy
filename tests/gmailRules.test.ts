import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuth2Client } from 'google-auth-library'
import type { NewServerRule } from '@shared/types'

const api = vi.hoisted(() => ({
  users: {
    settings: {
      filters: {
        list: vi.fn(async (_params: unknown) => ({ data: { filter: [] as unknown[] } })),
        create: vi.fn(async (params: { requestBody?: unknown }) => ({ data: { id: 'f-new', ...(params.requestBody as object) } })),
        delete: vi.fn(async (_params: unknown) => ({ data: {} }))
      }
    },
    labels: {
      list: vi.fn(async (_params: unknown) => ({
        data: { labels: [{ id: 'Label_1', name: 'Compras', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }] }
      }))
    }
  }
}))

vi.mock('@googleapis/gmail', () => ({ gmail: () => api }))

const { GmailRules, filterRequestBody, isInsufficientScope } = await import('../src/main/adapters/google/gmailRules')
const { ReconnectRequiredError } = await import('../src/main/app/ports')

const SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic'
const rules = (scope?: string) => new GmailRules({ credentials: scope === undefined ? {} : { scope } } as OAuth2Client, 'g1')
const when = { from: 'shop.example', subject: '', body: '' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Gmail filter request bodies', () => {
  it.each<[NewServerRule, unknown]>([
    [{ name: 'a', conditions: when, action: 'archive' }, { criteria: { from: 'shop.example' }, action: { removeLabelIds: ['INBOX'] } }],
    [{ name: 'd', conditions: when, action: 'delete' }, { criteria: { from: 'shop.example' }, action: { addLabelIds: ['TRASH'] } }],
    [
      { name: 'm', conditions: when, action: 'move', folderId: 'Label_1', folderName: 'Compras' },
      { criteria: { from: 'shop.example' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } }
    ],
    [
      { name: 'q', conditions: { from: '', subject: 'oferta', body: 'darse de baja' }, action: 'archive' },
      { criteria: { subject: 'oferta', query: 'darse de baja' }, action: { removeLabelIds: ['INBOX'] } }
    ]
  ])('builds the filter for %j, leaving empty criteria out', (rule, body) => {
    expect(filterRequestBody(rule)).toEqual(body)
  })

  it('creates the filter and returns it mapped, with a name generated from the conditions', async () => {
    const created = await rules().create({ name: 'Tienda', conditions: when, action: 'move', folderId: 'Label_1', folderName: 'Compras' })

    expect(api.users.settings.filters.create).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { criteria: { from: 'shop.example' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } }
    })
    expect(created).toEqual({
      id: 'f-new',
      accountId: 'g1',
      name: 'Remitente contiene "shop.example"',
      conditions: when,
      action: 'move',
      folderId: 'Label_1',
      folderName: 'Compras',
      managedByNarsil: true
    })
  })

  it('removes a filter by id', async () => {
    await rules().remove('f1')
    expect(api.users.settings.filters.delete).toHaveBeenCalledWith({ userId: 'me', id: 'f1' })
  })
})

describe('Gmail filter list mapping', () => {
  it('maps archive, delete and move filters, naming the label of a move', async () => {
    api.users.settings.filters.list.mockResolvedValueOnce({
      data: {
        filter: [
          { id: 'f1', criteria: { from: 'a.example' }, action: { removeLabelIds: ['INBOX'] } },
          { id: 'f2', criteria: { subject: 'promo' }, action: { addLabelIds: ['TRASH'] } },
          { id: 'f3', criteria: { query: 'factura' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } }
        ]
      }
    })

    expect(await rules().list()).toEqual([
      {
        id: 'f1',
        accountId: 'g1',
        name: 'Remitente contiene "a.example"',
        conditions: { from: 'a.example', subject: '', body: '' },
        action: 'archive',
        managedByNarsil: true
      },
      {
        id: 'f2',
        accountId: 'g1',
        name: 'Asunto contiene "promo"',
        conditions: { from: '', subject: 'promo', body: '' },
        action: 'delete',
        managedByNarsil: true
      },
      {
        id: 'f3',
        accountId: 'g1',
        name: 'Texto contiene "factura"',
        conditions: { from: '', subject: '', body: 'factura' },
        action: 'move',
        folderId: 'Label_1',
        folderName: 'Compras',
        managedByNarsil: true
      }
    ])
    expect(api.users.settings.filters.list).toHaveBeenCalledWith({ userId: 'me' })
  })

  it('shows filters Narsil cannot map as read-only', async () => {
    api.users.settings.filters.list.mockResolvedValueOnce({
      data: {
        filter: [
          { id: 'u1', criteria: { to: 'me@example.com' }, action: { removeLabelIds: ['INBOX'] } },
          { id: 'u2', criteria: { from: 'b.example' }, action: { forward: 'x@example.com' } },
          { id: 'u3', criteria: { from: 'c.example' }, action: { addLabelIds: ['STARRED'] } },
          { id: 'u4', criteria: { from: 'd.example', hasAttachment: true }, action: { addLabelIds: ['TRASH'] } }
        ]
      }
    })

    const listed = await rules().list()

    expect(listed.map((r) => [r.id, r.managedByNarsil])).toEqual([
      ['u1', false],
      ['u2', false],
      ['u3', false],
      ['u4', false]
    ])
    expect(listed[0]?.name).toBe('Filtro de Gmail')
    expect(listed[3]).toMatchObject({ conditions: { from: 'd.example', subject: '', body: '' }, action: 'delete' })
  })
})

describe('Gmail missing rule permission', () => {
  it('recognizes Google 403 insufficient scope errors only', () => {
    expect(isInsufficientScope({ code: 403, errors: [{ reason: 'insufficientPermissions' }] })).toBe(true)
    expect(isInsufficientScope({ status: 403, message: 'Request had insufficient authentication scopes.' })).toBe(true)
    expect(
      isInsufficientScope({ response: { status: 403, data: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } } })
    ).toBe(true)
    expect(isInsufficientScope({ code: 403, errors: [{ reason: 'rateLimitExceeded' }] })).toBe(false)
    expect(isInsufficientScope({ code: 500, message: 'insufficient' })).toBe(false)
  })

  it('turns a 403 insufficient scope into ReconnectRequiredError', async () => {
    api.users.settings.filters.list.mockRejectedValueOnce(
      Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] })
    )
    await expect(rules().list()).rejects.toBeInstanceOf(ReconnectRequiredError)
  })

  it('needs no request when the granted scopes lack the settings scope', async () => {
    const old = rules('https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send')
    await expect(old.list()).rejects.toBeInstanceOf(ReconnectRequiredError)
    await expect(old.remove('f1')).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(api.users.settings.filters.list).not.toHaveBeenCalled()
    expect(api.users.settings.filters.delete).not.toHaveBeenCalled()

    await expect(rules(`https://www.googleapis.com/auth/gmail.modify ${SETTINGS_SCOPE}`).list()).resolves.toEqual([])
  })

  it('passes other errors through unchanged', async () => {
    api.users.settings.filters.list.mockRejectedValueOnce(Object.assign(new Error('Backend Error'), { code: 500 }))
    await expect(rules().list()).rejects.toThrow('Backend Error')
  })
})
