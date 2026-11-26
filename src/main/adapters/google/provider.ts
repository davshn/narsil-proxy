import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { OAuth2Client, type Credentials } from 'google-auth-library'
import type { AccountConnection, AddedAccount, ProviderAuth } from '../../app/ports'
import { LEGACY_GOOGLE_ACCOUNT_ID, type SecretStore } from '../../app/accounts'
import { GMAIL_SETTINGS_SCOPE, GOOGLE_SCOPES, parseClientFile, signInWithBrowser, type ClientConfig } from '../googleAuth'
import { GmailService, fetchProfileEmail } from '../gmail'
import { CalendarService } from '../calendar'
import { GmailRules } from './gmailRules'

/** Seams for tests; production uses the defaults. */
export interface GoogleProviderOptions {
  openExternal?: (url: string) => Promise<void>
  createClient?: (config: ClientConfig) => OAuth2Client
  fetchProfileEmail?: (client: OAuth2Client) => Promise<string>
  newId?: () => string
}

const tokenSecret = (accountId: string) => `google-tokens.${accountId}` as const

/** What mail and calendar need. Without the filter scope only the rules ask for a reconnect. */
const REQUIRED_SCOPES = GOOGLE_SCOPES.filter((scope) => scope !== GMAIL_SETTINGS_SCOPE)

const MISSING_SCOPES = 'Google no concedió todos los permisos. Vuelve a intentarlo y marca todas las casillas.'

/**
 * Rejects a grant where the user unticked a mail or calendar permission on Google's consent
 * screen. Google always reports the granted scopes; a response without them is not judged here.
 */
function requireMailScopes(tokens: Credentials): void {
  if (typeof tokens.scope !== 'string') return
  const granted = new Set(tokens.scope.split(/\s+/))
  if (REQUIRED_SCOPES.some((scope) => !granted.has(scope))) throw new Error(MISSING_SCOPES)
}

/** Ids are randomUUIDs; anything else cannot name a stored account. */
const ACCOUNT_ID = /^[a-z0-9-]{1,64}$/i

/**
 * Gmail and Google Calendar accounts. All accounts share the user's own OAuth client
 * (secret `google-client`); each account keeps its tokens in `google-tokens.<accountId>`
 * and gets its own OAuth2Client, so refreshed tokens land in that account's secret.
 */
export class GoogleProvider implements ProviderAuth {
  readonly kind = 'google'
  private readonly clients = new Map<string, OAuth2Client>()
  /**
   * Accounts signed in by addAccount that were never connected. Removing one only forgets
   * it: a rejected duplicate shares Google's grant with the account already connected, and
   * revoking its token would sign that account out too.
   */
  private readonly unconfirmed = new Set<string>()
  private pending: Promise<AddedAccount> | null = null
  /** The reconnect sign-in in flight per account; a second click joins it. */
  private readonly reconnecting = new Map<string, Promise<void>>()
  private readonly openExternal: (url: string) => Promise<void>
  private readonly createClient: (config: ClientConfig) => OAuth2Client
  private readonly fetchProfileEmail: (client: OAuth2Client) => Promise<string>
  private readonly newId: () => string

  constructor(
    private readonly store: SecretStore,
    options: GoogleProviderOptions = {}
  ) {
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.createClient =
      options.createClient ?? ((config) => new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret }))
    this.fetchProfileEmail = options.fetchProfileEmail ?? fetchProfileEmail
    this.newId = options.newId ?? randomUUID
  }

  isConfigured(): boolean {
    return this.store.has('google-client')
  }

  saveClientConfig(json: string): void {
    const config = parseClientFile(json)
    this.store.set('google-client', JSON.stringify(config))
    // Existing clients carry the old client id; the next connect() builds new ones.
    for (const id of [...this.clients.keys()]) this.dropClient(id)
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
   * Signs in again and stores the new tokens under the same id. The old tokens are never revoked:
   * Google revokes the whole grant, which would sign the new tokens out too.
   */
  private async runReconnect(accountId: string, email: string): Promise<void> {
    if (!ACCOUNT_ID.test(accountId) || !this.store.has(tokenSecret(accountId))) throw new Error('Esta cuenta ya no está conectada.')
    const config = this.clientConfig()
    if (!config) throw new Error('Primero carga tu archivo de cliente OAuth de Google.')
    const client = this.createClient(config)
    const tokens = await signInWithBrowser(client, this.openExternal, email)
    requireMailScopes(tokens)
    client.setCredentials(tokens)
    const signedIn = (await this.fetchProfileEmail(client)).trim()
    if (signedIn.toLowerCase() !== email.trim().toLowerCase()) {
      throw new Error(`Iniciaste sesión con ${signedIn}, pero esta cuenta es ${email}. Vuelve a intentarlo con ${email}.`)
    }
    // The account may have been removed while the browser was open: never store its tokens again.
    if (!this.store.has(tokenSecret(accountId))) throw new Error('Esta cuenta ya no está conectada.')
    // Drop the cached client first so a refresh of the old tokens cannot overwrite the new ones.
    this.dropClient(accountId)
    this.store.set(tokenSecret(accountId), JSON.stringify(tokens))
  }

  private async runAddAccount(): Promise<AddedAccount> {
    const config = this.clientConfig()
    if (!config) throw new Error('Primero carga tu archivo de cliente OAuth de Google.')
    const client = this.createClient(config)
    const tokens = await signInWithBrowser(client, this.openExternal)
    requireMailScopes(tokens)
    client.setCredentials(tokens)
    const email = await this.fetchProfileEmail(client)
    const accountId = this.newId()
    this.store.set(tokenSecret(accountId), JSON.stringify(tokens))
    this.unconfirmed.add(accountId)
    return { accountId, email }
  }

  async removeAccount(accountId: string): Promise<void> {
    if (!ACCOUNT_ID.test(accountId)) return
    const name = tokenSecret(accountId)
    const neverConnected = this.unconfirmed.delete(accountId)
    // Drop the client first so a refresh finishing now cannot write tokens back.
    this.dropClient(accountId)
    const raw = this.store.get(name)
    const config = this.clientConfig()
    if (raw && config && !neverConnected) {
      try {
        const tokens = JSON.parse(raw) as Credentials
        const token = tokens.refresh_token ?? tokens.access_token
        if (token) await this.createClient(config).revokeToken(token)
      } catch {
        // The token may already be invalid; removing it locally is what matters.
      }
    }
    this.store.delete(name)
    // A migration interrupted before its last step leaves the same tokens in the legacy secret;
    // without this the next start would migrate the removed account back.
    if (accountId === LEGACY_GOOGLE_ACCOUNT_ID) this.store.delete('google-tokens')
  }

  connect(accountId: string): AccountConnection | null {
    if (!ACCOUNT_ID.test(accountId)) return null
    this.unconfirmed.delete(accountId)
    const client = this.authorizedClient(accountId)
    if (!client) return null
    return {
      mail: new GmailService(client, accountId),
      calendar: new CalendarService(client, accountId),
      rules: new GmailRules(client, accountId)
    }
  }

  /** The mailbox address for raw token JSON. Used to migrate the legacy single account. */
  async emailForTokens(tokens: string): Promise<string> {
    const config = this.clientConfig()
    if (!config) throw new Error('Falta el archivo de cliente OAuth de Google.')
    const client = this.createClient(config)
    client.setCredentials(JSON.parse(tokens) as Credentials)
    return this.fetchProfileEmail(client)
  }

  private authorizedClient(accountId: string): OAuth2Client | null {
    const cached = this.clients.get(accountId)
    if (cached) return cached
    const name = tokenSecret(accountId)
    const raw = this.store.get(name)
    const config = this.clientConfig()
    if (!raw || !config) return null
    const client = this.createClient(config)
    client.setCredentials(JSON.parse(raw) as Credentials)
    // Persist refreshed access tokens, keeping the refresh token Google only sends once.
    client.on('tokens', (fresh) => {
      if (this.clients.get(accountId) !== client) return
      const previous = this.store.get(name)
      const merged = { ...(previous ? (JSON.parse(previous) as Credentials) : {}), ...fresh }
      this.store.set(name, JSON.stringify(merged))
    })
    this.clients.set(accountId, client)
    return client
  }

  private dropClient(accountId: string): void {
    this.clients.get(accountId)?.removeAllListeners('tokens')
    this.clients.delete(accountId)
  }

  private clientConfig(): ClientConfig | null {
    const raw = this.store.get('google-client')
    return raw ? (JSON.parse(raw) as ClientConfig) : null
  }
}
