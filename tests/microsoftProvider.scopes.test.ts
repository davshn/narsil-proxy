import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureStore } from '../src/main/adapters/secureStore'

const msal = vi.hoisted(() => {
  const account = { homeAccountId: 'home-1', username: 'ana@outlook.com' }
  const cache = { getAccountByHomeId: vi.fn(async () => account), removeAccount: vi.fn(async () => {}) }
  const granted = { scopes: new Set<string>() }
  class InteractionRequiredAuthError extends Error {}
  const acquireTokenSilent = vi.fn(async (req: { scopes: string[] }) => {
    if (req.scopes.some((s) => !granted.scopes.has(s))) throw new InteractionRequiredAuthError('consent_required')
    return { accessToken: 'tok' }
  })
  class PublicClientApplication {
    getTokenCache = () => cache
    acquireTokenSilent = acquireTokenSilent
    acquireTokenInteractive = vi.fn()
  }
  return { granted, PublicClientApplication, InteractionRequiredAuthError }
})
vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: msal.PublicClientApplication,
  InteractionRequiredAuthError: msal.InteractionRequiredAuthError
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))
const { MicrosoftProvider } = await import('../src/main/adapters/microsoft/provider')

function store(): SecureStore {
  const data = new Map(Object.entries({ 'microsoft-client': '11111111-2222-3333-4444-555555555555', 'microsoft-account.acc-1': 'home-1' }))
  return {
    get: (n: string) => data.get(n) ?? null,
    getStrict: (n: string) => data.get(n) ?? null,
    set: () => {},
    delete: () => {},
    has: (n: string) => data.has(n),
    list: () => []
  } as unknown as SecureStore
}

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  )
)
afterEach(() => vi.unstubAllGlobals())

describe('Outlook accounts consented before meetings could be added', () => {
  it('still list rules with MailboxSettings.ReadWrite and Calendars.Read', async () => {
    msal.granted.scopes = new Set([
      'Mail.ReadWrite',
      'Mail.Send',
      'MailboxSettings.ReadWrite',
      'Calendars.Read',
      'User.Read',
      'offline_access'
    ])
    const connection = new MicrosoftProvider(store()).connect('acc-1')!
    await expect(connection.rules.list()).resolves.toBeDefined()
  })

  it('read mail and calendar silently with Calendars.Read only', async () => {
    msal.granted.scopes = new Set(['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'User.Read', 'offline_access'])
    const connection = new MicrosoftProvider(store()).connect('acc-1')!
    await expect(connection.mail.listUnread({ includeCategories: false, windowDays: 2 })).resolves.toBeDefined()
    await expect(connection.calendar.upcoming(new Date('2026-11-25T12:00:00Z'))).resolves.toEqual([])
  })
})
