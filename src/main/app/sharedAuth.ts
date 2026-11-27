import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SharedStatus } from '@shared/types'

/** Fixed because Supabase only returns to redirect URLs listed in the project; the README lists this one. */
export const SHARED_REDIRECT_PORT = 47813
export const SHARED_REDIRECT_PATH = '/auth/callback'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** The Supabase project shared lists live in. Both values are public by design. */
export interface SharedConfig {
  url: string
  publishableKey: string
}

export interface SharedConfigRepository {
  load(): SharedConfig | null
  save(config: SharedConfig): void
}

/** Where the Supabase session is kept encrypted: one secret holding every key the client stores. */
export interface SharedSecrets {
  get(name: 'shared-session'): string | null
  set(name: 'shared-session', value: string): void
  delete(name: 'shared-session'): void
}

/** The storage the Supabase client reads and writes its session and PKCE verifier through. */
export interface SessionStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

interface Session {
  user: { email?: string | null }
}

/** The part of Supabase's auth client Narsil uses. */
export interface AuthClient {
  signInWithOAuth(credentials: {
    provider: 'google'
    options: { redirectTo: string; skipBrowserRedirect: true }
  }): Promise<{ data: { url: string | null }; error: { message: string } | null }>
  exchangeCodeForSession(code: string): Promise<{ data: { session: Session | null }; error: { message: string } | null }>
  getSession(): Promise<{ data: { session: Session | null } }>
  signOut(options: { scope: 'local' }): Promise<{ error: { message: string } | null }>
}

export interface SharedAuthDeps {
  configs: SharedConfigRepository
  secrets: SharedSecrets
  makeClient(config: SharedConfig, storage: SessionStorage): AuthClient
  openBrowser(url: string): Promise<void> | void
  /** Tests pass 0 for a free port. */
  port?: number
  timeoutMs?: number
}

const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]+$/
const LEGACY_ANON = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** A project URL and public key, trimmed, or a Spanish error. Secret keys are refused outright. */
export function validSharedConfig(rawUrl: string, rawKey: string): SharedConfig {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('La URL del proyecto no es válida.')
  }
  if (url.protocol !== 'https:') throw new Error('La URL del proyecto debe empezar por https://.')
  const key = rawKey.trim()
  if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
    throw new Error('Esa es una clave secreta. Pega la clave pública (publishable o anon), nunca la secreta.')
  }
  if (!PUBLISHABLE.test(key) && !LEGACY_ANON.test(key)) throw new Error('La clave pública no es válida.')
  return { url: url.origin, publishableKey: key }
}

/** Keeps the client's keys in one encrypted secret, so the session survives restarts. */
function secretStorage(secrets: SharedSecrets): SessionStorage {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(secrets.get('shared-session') ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }
  const write = (values: Record<string, string>): void => {
    if (Object.keys(values).length === 0) secrets.delete('shared-session')
    else secrets.set('shared-session', JSON.stringify(values))
  }
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => write({ ...read(), [key]: value }),
    removeItem: (key) => {
      const values = read()
      delete values[key]
      write(values)
    }
  }
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><title>Narsil</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${text}</p></body></html>`

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Signing in to shared lists: Google through Supabase, PKCE, back to a loopback page. */
export class SharedAuth {
  private client: AuthClient | null = null

  constructor(private readonly deps: SharedAuthDeps) {}

  async status(): Promise<SharedStatus> {
    const config = this.deps.configs.load()
    if (!config) return { configured: false }
    const { data } = await this.auth(config).getSession()
    const email = data.session?.user.email
    return { configured: true, projectUrl: config.url, ...(email ? { email } : {}) }
  }

  /** Saves the project; a session from another project means nothing here, so it is dropped. */
  async setConfig(url: string, publishableKey: string): Promise<SharedStatus> {
    const config = validSharedConfig(url, publishableKey)
    this.deps.configs.save(config)
    this.client = null
    this.deps.secrets.delete('shared-session')
    return this.status()
  }

  async signIn(): Promise<SharedStatus> {
    const config = this.deps.configs.load()
    if (!config) throw new Error('Guarda primero la URL y la clave pública del proyecto.')
    const auth = this.auth(config)
    const { server, port } = await this.listen()
    try {
      const redirectTo = `http://127.0.0.1:${port}${SHARED_REDIRECT_PATH}`
      const { data, error } = await auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } })
      if (error || !data.url) throw new Error(`Supabase no inició el inicio de sesión: ${error?.message ?? 'sin URL'}`)
      const callback = this.callback(server)
      await this.deps.openBrowser(data.url)
      const { params, res } = await callback
      const denied = params.get('error_description') ?? params.get('error')
      const code = params.get('code')
      if (denied || !code) {
        respond(res, 'No se pudo iniciar sesión', 'Vuelve a Narsil para ver qué pasó.')
        throw new Error(`Google no completó el inicio de sesión: ${denied ?? 'no llegó el código'}`)
      }
      const exchange = await auth.exchangeCodeForSession(code)
      if (exchange.error || !exchange.data.session) {
        respond(res, 'No se pudo iniciar sesión', 'Vuelve a Narsil para ver qué pasó.')
        throw new Error(`Supabase no aceptó el inicio de sesión: ${exchange.error?.message ?? 'sin sesión'}`)
      }
      respond(res, 'Listo', 'Ya puedes volver a Narsil y cerrar esta pestaña.')
      return await this.status()
    } finally {
      server.close()
    }
  }

  async signOut(): Promise<SharedStatus> {
    const config = this.deps.configs.load()
    if (config) await this.auth(config).signOut({ scope: 'local' })
    this.deps.secrets.delete('shared-session')
    return this.status()
  }

  private auth(config: SharedConfig): AuthClient {
    this.client ??= this.deps.makeClient(config, secretStorage(this.deps.secrets))
    return this.client
  }

  private async listen(): Promise<{ server: Server; port: number }> {
    const server = createServer()
    const port = this.deps.port ?? SHARED_REDIRECT_PORT
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`El puerto ${port} está ocupado. Cierra el otro inicio de sesión abierto y vuelve a intentarlo.`)
            : error
        )
      )
      server.listen(port, '127.0.0.1', resolve)
    })
    return { server, port: (server.address() as AddressInfo).port }
  }

  /** The first request to the callback path, or a timeout; anything else gets a 404. */
  private callback(server: Server): Promise<{ params: URLSearchParams; res: ServerResponse }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('El inicio de sesión tardó demasiado. Vuelve a intentarlo.')),
        this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS
      )
      server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== SHARED_REDIRECT_PATH) {
          res.writeHead(404).end()
          return
        }
        clearTimeout(timer)
        resolve({ params: url.searchParams, res })
      })
    })
  }
}

function respond(res: ServerResponse, title: string, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(escapeHtml(title), escapeHtml(text)))
}
