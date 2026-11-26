import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin
} from '@azure/msal-node'
import type { AccountConnection, AddedAccount, ProviderAuth } from '../../app/ports'
import type { SecretName, SecureStore } from '../secureStore'
import { GraphClient } from './graphClient'
import { OutlookCalendar } from './outlookCalendar'
import { OutlookMail } from './outlookMail'

/** `common` accepts both personal Microsoft accounts and work or school accounts. */
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common'

export const MICROSOFT_SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'User.Read', 'offline_access']

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOGIN_TIMEOUT_MS = 5 * 60_000

// MSAL serves these pages from its loopback server without a charset header, so declare it here.
const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Narsil</title><h2>Narsil está conectado a Microsoft.</h2><p>Ya puedes cerrar esta pestaña.</p>'
const ERROR_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Narsil</title><h2>Narsil no pudo conectarse a Microsoft.</h2><p>Ya puedes cerrar esta pestaña y volver a intentarlo.</p>'

function accountSecret(accountId: string): SecretName {
  return `microsoft-account.${accountId}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Microsoft accounts (Outlook.com, Hotmail, Microsoft 365) through MSAL Node and Microsoft Graph.
 *
 * One MSAL token cache holds every Microsoft account, encrypted in the `microsoft-cache` secret.
 * Each Narsil account id maps to MSAL's `homeAccountId` in `microsoft-account.<accountId>`.
 */
export class MicrosoftProvider implements ProviderAuth {
  readonly kind = 'microsoft'
  private app: PublicClientApplication | null = null
  private pending: Promise<AddedAccount> | null = null
  /**
   * Accounts returned by addAccount that the core has not connected yet. If the core rejects one
   * (for example a duplicate), it shares the MSAL cache entry of an account that is still in use,
   * so discarding it must only forget the mapping.
   */
  private readonly unconnected = new Set<string>()

  constructor(private readonly store: SecureStore) {}

  isConfigured(): boolean {
    return this.store.has('microsoft-client')
  }

  saveClientId(clientId: string): void {
    const trimmed = clientId.trim()
    if (!GUID.test(trimmed)) throw new Error('El Application (client) ID de Microsoft debe ser un GUID.')
    this.store.set('microsoft-client', trimmed)
    this.app = null
  }

  addAccount(): Promise<AddedAccount> {
    // A second click while the browser is open joins the sign-in already in progress.
    this.pending ??= this.runAddAccount().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  async removeAccount(accountId: string): Promise<void> {
    try {
      const secret = accountSecret(accountId)
      if (this.unconnected.delete(accountId)) {
        this.store.delete(secret)
        return
      }
      const homeAccountId = this.store.get(secret)
      const app = this.getApp()
      if (homeAccountId && app) {
        try {
          const cache = app.getTokenCache()
          const account = await cache.getAccountByHomeId(homeAccountId)
          if (account) await cache.removeAccount(account)
        } catch {
          // Forgetting the mapping below is what disconnects the account from Narsil.
        }
      }
      this.store.delete(secret)
    } catch {
      // Unknown or malformed ids have nothing to remove.
    }
  }

  connect(accountId: string): AccountConnection | null {
    let homeAccountId: string | null
    try {
      homeAccountId = this.store.get(accountSecret(accountId))
    } catch {
      return null
    }
    const app = this.getApp()
    if (!homeAccountId || !app) return null
    this.unconnected.delete(accountId)
    const graph = new GraphClient(() => this.accessToken(app, homeAccountId))
    return { mail: new OutlookMail(graph, accountId), calendar: new OutlookCalendar(graph, accountId) }
  }

  private async runAddAccount(): Promise<AddedAccount> {
    const app = this.getApp()
    if (!app) throw new Error('Primero configura el Application (client) ID de Microsoft.')

    let result
    try {
      result = await withTimeout(
        app.acquireTokenInteractive({
          scopes: MICROSOFT_SCOPES,
          prompt: 'select_account',
          openBrowser: async (url) => {
            try {
              await shell.openExternal(url)
            } catch (error) {
              throw new Error(`No se pudo abrir tu navegador: ${errorText(error)}`)
            }
          },
          successTemplate: SUCCESS_PAGE,
          errorTemplate: ERROR_PAGE
        }),
        LOGIN_TIMEOUT_MS,
        'Se agotó el tiempo para iniciar sesión en Microsoft.'
      )
    } catch (error) {
      throw new Error(`Falló el inicio de sesión en Microsoft: ${errorText(error)}`)
    }

    const account = result.account
    if (!account) throw new Error('Microsoft no devolvió una cuenta al iniciar sesión.')
    const email = (await this.mailboxAddress(result.accessToken)) ?? account.username
    if (!email) throw new Error('No se pudo leer la dirección de correo de la cuenta de Microsoft.')

    const accountId = randomUUID()
    this.store.set(accountSecret(accountId), account.homeAccountId)
    this.unconnected.add(accountId)
    return { accountId, email }
  }

  /** The mailbox address from `/me`; personal accounts often have no `mail`, so it may be undefined. */
  private async mailboxAddress(accessToken: string): Promise<string | undefined> {
    try {
      const graph = new GraphClient(async () => accessToken)
      const me = await graph.request<{ mail?: string | null }>('GET', '/me', { query: { $select: 'mail' } })
      return me?.mail?.trim() || undefined
    } catch {
      return undefined
    }
  }

  private async accessToken(app: PublicClientApplication, homeAccountId: string): Promise<string> {
    let account: AccountInfo | null
    try {
      account = await app.getTokenCache().getAccountByHomeId(homeAccountId)
    } catch (error) {
      throw new Error(`No se pudo leer la sesión de Microsoft: ${errorText(error)}`)
    }
    if (!account) throw new Error('La sesión de esta cuenta de Microsoft ya no existe; quítala y vuelve a agregarla.')
    try {
      const result = await app.acquireTokenSilent({ account, scopes: MICROSOFT_SCOPES })
      return result.accessToken
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new Error('Microsoft pide volver a iniciar sesión en esta cuenta; quítala y vuelve a agregarla.')
      }
      throw new Error(`No se pudo renovar la sesión de Microsoft: ${errorText(error)}`)
    }
  }

  private getApp(): PublicClientApplication | null {
    if (this.app) return this.app
    const clientId = this.store.get('microsoft-client')
    if (!clientId) return null
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (context) => {
        const serialized = this.store.get('microsoft-cache')
        if (serialized) context.tokenCache.deserialize(serialized)
      },
      afterCacheAccess: async (context) => {
        if (context.cacheHasChanged) this.store.set('microsoft-cache', context.tokenCache.serialize())
      }
    }
    this.app = new PublicClientApplication({
      auth: { clientId, authority: MICROSOFT_AUTHORITY },
      cache: { cachePlugin }
    })
    return this.app
  }
}
