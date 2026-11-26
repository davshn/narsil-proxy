import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library'
import { z } from 'zod'
import type { SecureStore } from './secureStore'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly'
]

const LOGIN_TIMEOUT_MS = 5 * 60_000

/** Shape of the "Desktop app" OAuth client JSON downloaded from Google Cloud Console. */
const ClientFileSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) })
})

interface ClientConfig {
  clientId: string
  clientSecret: string
}

export function parseClientFile(json: string): ClientConfig {
  const parsed = ClientFileSchema.safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new Error('Este no es un archivo de cliente OAuth de Google tipo "App de escritorio" (falta la sección "installed").')
  }
  return { clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret }
}

export class GoogleAuth {
  private client: OAuth2Client | null = null
  private pending: Promise<void> | null = null

  constructor(private readonly store: SecureStore) {}

  hasClientConfig(): boolean {
    return this.store.has('google-client')
  }

  saveClientConfig(json: string): void {
    const config = parseClientFile(json)
    this.store.set('google-client', JSON.stringify(config))
    this.client = null
  }

  isConnected(): boolean {
    return this.store.has('google-tokens')
  }

  /** Returns an authorized client, or null when the user has not connected Google yet. */
  getAuthorizedClient(): OAuth2Client | null {
    if (!this.isConnected()) return null
    const client = this.getClient()
    const tokens = this.store.get('google-tokens')
    if (!client || !tokens) return null
    client.setCredentials(JSON.parse(tokens) as Credentials)
    return client
  }

  /** Runs the OAuth loopback flow with PKCE in the user's default browser. */
  connect(): Promise<void> {
    // A second click while the browser is open joins the sign-in already in progress.
    this.pending ??= this.runConnect().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async runConnect(): Promise<void> {
    const client = this.getClient()
    if (!client) throw new Error('Primero carga tu archivo de cliente OAuth de Google.')

    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    const state = randomBytes(16).toString('hex')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const code = await this.waitForCode(server, state, () => {
        const url = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: GOOGLE_SCOPES,
          state,
          redirect_uri: redirectUri,
          code_challenge_method: CodeChallengeMethod.S256,
          ...(codeChallenge ? { code_challenge: codeChallenge } : {})
        })
        return shell.openExternal(url)
      })
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
      this.store.set('google-tokens', JSON.stringify(tokens))
      client.setCredentials(tokens)
    } finally {
      server.close()
    }
  }

  async disconnect(): Promise<void> {
    const client = this.getAuthorizedClient()
    try {
      await client?.revokeCredentials()
    } catch {
      // The token may already be invalid; removing it locally is what matters.
    }
    // Drop the client so a refresh finishing now cannot write tokens back.
    this.client?.removeAllListeners('tokens')
    this.client = null
    this.store.delete('google-tokens')
  }

  private getClient(): OAuth2Client | null {
    if (this.client) return this.client
    const raw = this.store.get('google-client')
    if (!raw) return null
    const config = JSON.parse(raw) as ClientConfig
    const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret })
    // Persist refreshed access tokens, keeping the refresh token Google only sends once.
    client.on('tokens', (fresh) => {
      const previous = this.store.get('google-tokens')
      const merged = { ...(previous ? (JSON.parse(previous) as Credentials) : {}), ...fresh }
      this.store.set('google-tokens', JSON.stringify(merged))
    })
    this.client = client
    return client
  }

  private waitForCode(server: Server, state: string, openBrowser: () => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Se agotó el tiempo para iniciar sesión en Google.')), LOGIN_TIMEOUT_MS)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        // Requests without our state did not come from Google's redirect: ignore them.
        if (url.searchParams.get('state') !== state) {
          res.writeHead(404).end()
          return
        }
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        if (error || !code) {
          res.end('<h2>Narsil no pudo conectarse a Google.</h2><p>Ya puedes cerrar esta pestaña.</p>')
          fail(new Error(`Falló el inicio de sesión en Google: ${error ?? 'no se recibió código de autorización'}`))
          return
        }
        res.end('<h2>Narsil está conectado a Google.</h2><p>Ya puedes cerrar esta pestaña.</p>')
        clearTimeout(timer)
        resolve(code)
      })
      openBrowser().catch((error: unknown) =>
        fail(new Error(`No se pudo abrir tu navegador: ${error instanceof Error ? error.message : String(error)}`))
      )
    })
  }
}
