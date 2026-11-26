import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
  type InteractiveRequest
} from '@azure/msal-node'
import { ReconnectRequiredError, type AccountConnection, type AddedAccount, type ProviderAuth } from '../../app/ports'
import type { SecretName, SecureStore } from '../secureStore'
import { GraphClient } from './graphClient'
import { OutlookCalendar } from './outlookCalendar'
import { OutlookMail } from './outlookMail'
import { OutlookRules } from './outlookRules'

/** `common` accepts both personal Microsoft accounts and work or school accounts. */
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common'

/** What mail and calendar need; accounts connected before rules lived in Outlook granted only these. */
export const MAIL_SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'User.Read', 'offline_access']

/** Every scope a sign-in asks for: MailboxSettings.ReadWrite lets Narsil manage inbox rules. */
export const MICROSOFT_SCOPES = [
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.ReadWrite',
  'Calendars.Read',
  'User.Read',
  'offline_access'
]

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOGIN_TIMEOUT_MS = 5 * 60_000

// MSAL serves these pages from its loopback server without a charset header, so declare it here.
const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Narsil</title><h2>Narsil está conectado a Microsoft.</h2><p>Ya puedes cerrar esta pestaña.</p>'
const ERROR_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Narsil</title><h2>Narsil no pudo conectarse a Microsoft.</h2><p>Ya puedes cerrar esta pestaña y volver a intentarlo.</p>'

const ACCOUNT_PREFIX = 'microsoft-account.'

function accountSecret(accountId: string): SecretName {
  return `microsoft-account.${accountId}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class SignInTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SignInTimeoutError(message)), ms)
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
  /** The reconnect sign-in in flight per account; a second click joins it. */
  private readonly reconnecting = new Map<string, Promise<void>>()
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

  reconnect(accountId: string, email: string): Promise<void> {
    let pending = this.reconnecting.get(accountId)
    if (!pending) {
      pending = this.runReconnect(accountId, email).finally(() => this.reconnecting.delete(accountId))
      this.reconnecting.set(accountId, pending)
    }
    return pending
  }

  /**
   * Signs in again as the account mapped to `accountId`, asking for every scope; MSAL replaces
   * its tokens in the shared cache. Another mailbox is rejected and its new cache entry dropped.
   */
  private async runReconnect(accountId: string, email: string): Promise<void> {
    let homeAccountId: string | null
    try {
      homeAccountId = this.store.get(accountSecret(accountId))
    } catch {
      homeAccountId = null
    }
    if (!homeAccountId) throw new Error('Esta cuenta ya no está conectada.')
    const app = this.getApp()
    if (!app) throw new Error('Primero configura el Application (client) ID de Microsoft.')
    let current: AccountInfo | null
    try {
      current = await app.getTokenCache().getAccountByHomeId(homeAccountId)
    } catch {
      current = null
    }
    const result = await this.signIn(app, current ? { account: current } : { loginHint: email })
    const account = result.account
    if (!account) throw new Error('Microsoft no devolvió una cuenta al iniciar sesión.')
    const signedIn = (await this.mailboxAddress(result.accessToken)) ?? account.username
    const sameAccount = account.homeAccountId === homeAccountId
    if (!sameAccount && signedIn.toLowerCase() !== email.trim().toLowerCase()) {
      if (!this.mappedAccountId(account.homeAccountId)) {
        await app
          .getTokenCache()
          .removeAccount(account)
          .catch(() => undefined)
      }
      throw new Error(`Iniciaste sesión con ${signedIn}, pero esta cuenta es ${email}. Vuelve a intentarlo con ${email}.`)
    }
    if (!sameAccount) this.store.set(accountSecret(accountId), account.homeAccountId)
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
      // Another mapping may share the MSAL account; removing it would sign that one out too.
      if (homeAccountId && app && !this.mappedAccountId(homeAccountId, accountId)) {
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
    const graph = new GraphClient(() => this.accessToken(app, homeAccountId, MAIL_SCOPES))
    // Rules need MailboxSettings.ReadWrite, which older accounts never granted: ask for it apart,
    // so a missing consent only blocks the rules and never the mail.
    const rulesGraph = new GraphClient(() => this.accessToken(app, homeAccountId, MICROSOFT_SCOPES, true))
    return {
      mail: new OutlookMail(graph, accountId),
      calendar: new OutlookCalendar(graph, accountId),
      rules: new OutlookRules(rulesGraph, accountId)
    }
  }

  private async runAddAccount(): Promise<AddedAccount> {
    const app = this.getApp()
    if (!app) throw new Error('Primero configura el Application (client) ID de Microsoft.')
    const result = await this.signIn(app, { prompt: 'select_account' })

    const account = result.account
    if (!account) throw new Error('Microsoft no devolvió una cuenta al iniciar sesión.')
    const email = (await this.mailboxAddress(result.accessToken)) ?? account.username
    if (!email) throw new Error('No se pudo leer la dirección de correo de la cuenta de Microsoft.')

    // The same Microsoft account signed in again keeps its id, whatever address /me returned.
    const existing = this.mappedAccountId(account.homeAccountId)
    if (existing) return { accountId: existing, email }

    const accountId = randomUUID()
    this.store.set(accountSecret(accountId), account.homeAccountId)
    this.unconnected.add(accountId)
    return { accountId, email }
  }

  /** The interactive browser sign-in with every scope, timed out after LOGIN_TIMEOUT_MS. */
  private async signIn(
    app: PublicClientApplication,
    extra: Pick<InteractiveRequest, 'prompt' | 'account' | 'loginHint'>
  ): Promise<AuthenticationResult> {
    const interactive = app.acquireTokenInteractive({
      ...extra,
      scopes: MICROSOFT_SCOPES,
      openBrowser: async (url) => {
        try {
          await shell.openExternal(url)
        } catch (error) {
          throw new Error(`No se pudo abrir tu navegador: ${errorText(error)}`)
        }
      },
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE
    })
    let result: AuthenticationResult
    try {
      result = await withTimeout(interactive, LOGIN_TIMEOUT_MS, 'Se agotó el tiempo para iniciar sesión en Microsoft.')
    } catch (error) {
      if (error instanceof SignInTimeoutError) this.discardLateSignIn(app, interactive)
      throw new Error(`Falló el inicio de sesión en Microsoft: ${errorText(error)}`)
    }
    return result
  }

  /** The Narsil account id mapped to an MSAL `homeAccountId`, ignoring `except`. */
  private mappedAccountId(homeAccountId: string, except?: string): string | null {
    for (const name of this.store.list(ACCOUNT_PREFIX)) {
      const id = name.slice(ACCOUNT_PREFIX.length)
      if (id && id !== except && this.store.get(name) === homeAccountId) return id
    }
    return null
  }

  /**
   * MSAL keeps its loopback server waiting after our timeout. If the user still finishes that
   * sign-in, MSAL caches an account Narsil never mapped: remove it, unless a mapping uses it.
   */
  private discardLateSignIn(app: PublicClientApplication, interactive: Promise<AuthenticationResult>): void {
    interactive
      .then(async (late) => {
        const account = late?.account
        if (!account) return
        // A newer sign-in may be about to map this same account; decide once it settles.
        await this.pending?.catch(() => undefined)
        if (this.mappedAccountId(account.homeAccountId)) return
        await app.getTokenCache().removeAccount(account)
      })
      .catch(() => undefined)
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

  /** A token for `scopes`; for the rules, a needed consent means the account must reconnect. */
  private async accessToken(
    app: PublicClientApplication,
    homeAccountId: string,
    scopes: string[],
    forRules = false
  ): Promise<string> {
    let account: AccountInfo | null
    try {
      account = await app.getTokenCache().getAccountByHomeId(homeAccountId)
    } catch (error) {
      throw new Error(`No se pudo leer la sesión de Microsoft: ${errorText(error)}`)
    }
    if (!account) throw new Error('La sesión de esta cuenta de Microsoft ya no existe; quítala y vuelve a agregarla.')
    try {
      const result = await app.acquireTokenSilent({ account, scopes })
      return result.accessToken
    } catch (error) {
      if (forRules && error instanceof InteractionRequiredAuthError) throw new ReconnectRequiredError()
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
