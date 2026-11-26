import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuth2Client } from 'google-auth-library'
import type { AccountSettings } from '@shared/types'

const api = vi.hoisted(() => ({
  users: {
    messages: {
      list: vi.fn(async (_params: unknown) => ({ data: { messages: [{ id: 'm1' }, { id: 'm2' }] } })),
      modify: vi.fn(async (_params: unknown) => ({ data: {} }))
    },
    labels: {
      list: vi.fn(async (_params: unknown) => ({ data: { labels: [] as unknown[] } })),
      create: vi.fn(async (_params: unknown) => ({ data: { id: 'Label_9', name: 'Facturas' } as { id?: string; name?: string } }))
    }
  }
}))

vi.mock('@googleapis/gmail', () => ({ gmail: () => api }))

const { GmailService } = await import('../src/main/adapters/gmail')

const service = () => new GmailService({} as OAuth2Client, 'g1')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GmailService.listUnread', () => {
  it.each<[AccountSettings, string]>([
    [{ includeCategories: false, windowDays: 2 }, 'in:inbox is:unread newer_than:2d -category:promotions -category:social'],
    [{ includeCategories: false, windowDays: 7 }, 'in:inbox is:unread newer_than:7d -category:promotions -category:social'],
    [{ includeCategories: false, windowDays: 30 }, 'in:inbox is:unread newer_than:30d -category:promotions -category:social'],
    [{ includeCategories: true, windowDays: 2 }, 'in:inbox is:unread newer_than:2d'],
    [{ includeCategories: true, windowDays: 7 }, 'in:inbox is:unread newer_than:7d'],
    [{ includeCategories: true, windowDays: 30 }, 'in:inbox is:unread newer_than:30d']
  ])('queries Gmail for %j with %s', async (settings, query) => {
    expect(await service().listUnread(settings)).toEqual(['m1', 'm2'])
    expect(api.users.messages.list).toHaveBeenCalledWith({ userId: 'me', q: query, maxResults: 20 })
  })
})

describe('GmailService folders', () => {
  it('lists only user labels, sorted by name', async () => {
    api.users.labels.list.mockResolvedValueOnce({
      data: {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_2', name: 'Viajes', type: 'user' },
          { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
          { id: 'Label_1', name: 'Facturas', type: 'user' },
          { id: 'Label_3', name: 'facturas/2026', type: 'user' }
        ]
      }
    })

    expect(await service().listFolders()).toEqual([
      { id: 'Label_1', name: 'Facturas' },
      { id: 'Label_3', name: 'facturas/2026' },
      { id: 'Label_2', name: 'Viajes' }
    ])
    expect(api.users.labels.list).toHaveBeenCalledWith({ userId: 'me' })
  })

  it('creates a label that shows in the label list and the message list', async () => {
    expect(await service().createFolder('Facturas')).toEqual({ id: 'Label_9', name: 'Facturas' })
    expect(api.users.labels.create).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { name: 'Facturas', labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    })
  })

  it('rejects a created label without an id', async () => {
    api.users.labels.create.mockResolvedValueOnce({ data: {} })
    await expect(service().createFolder('Facturas')).rejects.toThrow('Google no devolvió la etiqueta creada.')
  })

  it('moves a message: adds the label and removes INBOX and UNREAD', async () => {
    await service().moveToFolder('m1', 'Label_1')
    expect(api.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'm1',
      requestBody: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX', 'UNREAD'] }
    })
  })
})
