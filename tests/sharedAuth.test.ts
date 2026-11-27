import { get } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  SharedAuth,
  validSharedConfig,
  type AuthClient,
  type SessionStorage,
  type SharedConfig,
  type SharedConfigRepository,
  type SharedSecrets
} from '../src/main/app/sharedAuth'

const CONFIG: SharedConfig = { url: 'https://abcdefghijklmnop.supabase.co', publishableKey: 'sb_publishable_abc123' }

class MemoryConfigs implements SharedConfigRepository {
  constructor(public config: SharedConfig | null = null) {}
  load(): SharedConfig | null {
    return this.config
  }
  save(config: SharedConfig): void {
    this.config = config
  }
}

class MemorySecrets implements SharedSecrets {
  values = new Map<string, string>()
  get(name: 'shared-session'): string | null {
    return this.values.get(name) ?? null
  }
  set(name: 'shared-session', value: string): void {
    this.values.set(name, value)
  }
  delete(name: 'shared-session'): void {
    this.values.delete(name)
  }
}

/** A fake Supabase auth client: stores the session through the storage it was given, like the real one. */
function fakeClient(storage: SessionStorage, overrides: Partial<AuthClient> = {}): AuthClient & { redirectTo?: string } {
  const client: AuthClient & { redirectTo?: string } = {
    signInWithOAuth: vi.fn(async ({ options }) => {
      client.redirectTo = options.redirectTo
      return { data: { url: 'https://accounts.example/auth?challenge=xyz' }, error: null }
    }),
    exchangeCodeForSession: vi.fn(async (code: string) => {
      if (code !== 'good-code') return { data: { session: null }, error: { message: 'invalid code' } }
      await storage.setItem('sb-auth', JSON.stringify({ user: { id: 'u-ana', email: 'ana@gmail.com' } }))
      return { data: { session: { user: { id: 'u-ana', email: 'ana@gmail.com' } } }, error: null }
    }),
    getSession: vi.fn(async () => {
      const raw = await storage.getItem('sb-auth')
      return { data: { session: raw ? (JSON.parse(raw) as { user: { id: string; email: string } }) : null }, error: null }
    }),
    signOut: vi.fn(async () => {
      await storage.removeItem('sb-auth')
      return { error: null }
    }),
    stopAutoRefresh: vi.fn(async () => undefined),
    select: vi.fn(async (table: string) => ({ data: [{ table }], error: null })),
    write: vi.fn(async () => ({ error: null, count: 1 })),
    ...overrides
  }
  return client
}

/** Plays the browser: once Narsil opens the provider URL, Google sends the user back with `query`. */
function setup(query: string | null, options: { config?: SharedConfig | null; overrides?: Partial<AuthClient> } = {}) {
  const configs = new MemoryConfigs(options.config === undefined ? CONFIG : options.config)
  const secrets = new MemorySecrets()
  let client: ReturnType<typeof fakeClient> | undefined
  const page: { loaded: Promise<string> } = { loaded: Promise.resolve('') }
  const auth = new SharedAuth({
    configs,
    secrets,
    port: 0,
    timeoutMs: 2000,
    makeClient: (_config, storage) => (client = fakeClient(storage, options.overrides)),
    // Like shell.openExternal: returns at once, while the browser goes on its own.
    openBrowser: () => {
      if (query === null || !client?.redirectTo) return
      const target = `${client.redirectTo}${query}`
      page.loaded = new Promise<string>((resolve) => {
        get(target, (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve(body))
        })
      })
    }
  })
  return { auth, configs, secrets, client: () => client, page }
}

describe('validSharedConfig', () => {
  it('trims and keeps a Supabase project URL and a publishable key', () => {
    expect(validSharedConfig(' https://abcdefghijklmnop.supabase.co/ ', ' sb_publishable_abc123 ')).toEqual(CONFIG)
  })

  it('accepts a legacy anon key, which is a JWT', () => {
    const anon = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl'
    expect(validSharedConfig(CONFIG.url, anon).publishableKey).toBe(anon)
  })

  it.each([
    ['http://abcdefghijklmnop.supabase.co', 'La URL del proyecto debe empezar por https://.'],
    ['no es una url', 'La URL del proyecto no es válida.']
  ])('rejects the URL %s', (url, message) => {
    expect(() => validSharedConfig(url, CONFIG.publishableKey)).toThrow(message)
  })

  it('refuses a secret or service_role key, which would give full access', () => {
    expect(() => validSharedConfig(CONFIG.url, 'sb_secret_abc123')).toThrow(
      'Esa es una clave secreta. Pega la clave pública (publishable o anon), nunca la secreta.'
    )
  })

  it('rejects a key that is neither publishable nor anon', () => {
    expect(() => validSharedConfig(CONFIG.url, 'hola')).toThrow('La clave pública no es válida.')
  })

  // A legacy key is a JWT: its role is inside the base64url payload, never in the raw text.
  const jwt = (payload: object): string =>
    [{ alg: 'HS256', typ: 'JWT' }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.c2ln'

  it('refuses a legacy service_role JWT, which bypasses every database rule', () => {
    expect(() => validSharedConfig(CONFIG.url, jwt({ iss: 'supabase', role: 'service_role' }))).toThrow(
      'Esa es una clave secreta. Pega la clave pública (publishable o anon), nunca la secreta.'
    )
  })

  it('refuses a JWT whose payload is not an anon role or cannot be read', () => {
    expect(() => validSharedConfig(CONFIG.url, jwt({ iss: 'supabase', role: 'authenticated' }))).toThrow('La clave pública no es válida.')
    expect(() => validSharedConfig(CONFIG.url, 'eyJhbGciOiJIUzI1NiJ9.bm8tanNvbg.c2ln')).toThrow('La clave pública no es válida.')
  })
})

describe('SharedAuth', () => {
  it('is not configured until a project is saved', async () => {
    const { auth } = setup(null, { config: null })
    expect(await auth.status()).toEqual({ configured: false })
    await expect(auth.signIn()).rejects.toThrow('Guarda primero la URL y la clave pública del proyecto.')
  })

  it('signs in with Google through PKCE and the loopback redirect, and stores the session encrypted', async () => {
    const { auth, client, secrets, page } = setup('?code=good-code')
    const status = await auth.signIn()
    expect(status).toEqual({ configured: true, projectUrl: CONFIG.url, email: 'ana@gmail.com' })
    expect(client()?.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/), skipBrowserRedirect: true }
    })
    expect(client()?.exchangeCodeForSession).toHaveBeenCalledWith('good-code')
    expect(await page.loaded).toContain('Ya puedes volver a Narsil')
    expect(JSON.parse(secrets.get('shared-session') ?? '{}')).toHaveProperty('sb-auth')
  })

  it('reports what Google answered when the user cancels', async () => {
    const { auth, page } = setup('?error=access_denied&error_description=The+user+denied+access')
    await expect(auth.signIn()).rejects.toThrow('Google no completó el inicio de sesión: The user denied access')
    expect(await page.loaded).toContain('No se pudo iniciar sesión')
  })

  it('reports a code Supabase refuses', async () => {
    const { auth } = setup('?code=bad-code')
    await expect(auth.signIn()).rejects.toThrow('Supabase no aceptó el inicio de sesión: invalid code')
  })

  it('gives up when the browser never comes back', async () => {
    const { auth } = setup(null)
    await expect(auth.signIn()).rejects.toThrow('El inicio de sesión tardó demasiado. Vuelve a intentarlo.')
  })

  it('passes the flow id Supabase put in the redirect, so the right verifier is used', async () => {
    const { auth, client } = setup('?code=good-code&sb_flow_id=flow-7')
    await auth.signIn()
    expect(client()?.exchangeCodeForSession).toHaveBeenCalledWith('good-code', { flowId: 'flow-7' })
  })

  it('leaves no timer behind when the browser cannot open', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const auth = new SharedAuth({
        configs: new MemoryConfigs(CONFIG),
        secrets: new MemorySecrets(),
        port: 0,
        timeoutMs: 20,
        makeClient: (_config, storage) => fakeClient(storage),
        openBrowser: () => {
          throw new Error('no browser')
        }
      })
      await expect(auth.signIn()).rejects.toThrow('no browser')
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the session across restarts, then signs out and forgets it', async () => {
    const { auth, secrets, configs } = setup('?code=good-code')
    await auth.signIn()
    const again = new SharedAuth({
      configs,
      secrets,
      makeClient: (_config, storage) => fakeClient(storage),
      openBrowser: async () => undefined
    })
    expect((await again.status()).email).toBe('ana@gmail.com')
    expect(await again.signOut()).toEqual({ configured: true, projectUrl: CONFIG.url })
    expect(secrets.get('shared-session')).toBeNull()
  })

  it('saving another project forgets the old session and stops the old client refreshing it', async () => {
    const { auth, secrets, client } = setup('?code=good-code')
    await auth.signIn()
    const old = client()
    const status = await auth.setConfig('https://zyxwvutsrqponmlk.supabase.co', 'sb_publishable_other')
    expect(status).toEqual({ configured: true, projectUrl: 'https://zyxwvutsrqponmlk.supabase.co' })
    expect(old?.stopAutoRefresh).toHaveBeenCalled()
    expect(secrets.get('shared-session')).toBeNull()
  })

  it('hands the sync the signed-in user and a way to read rows with their session', async () => {
    const { auth, client } = setup('?code=good-code')
    await auth.signIn()
    const session = await auth.session()
    expect(session).toMatchObject({ id: 'u-ana', email: 'ana@gmail.com' })
    expect(await session?.select('lists', 'id')).toEqual({ data: [{ table: 'lists' }], error: null })
    expect(client()?.select).toHaveBeenCalledWith('lists', 'id')
    const write = { kind: 'delete', table: 'lists', match: { id: 'l-1' } } as const
    expect(await session?.write(write)).toEqual({ error: null, count: 1 })
    expect(client()?.write).toHaveBeenCalledWith(write)
  })

  it('has no session before a project is saved or after signing out', async () => {
    expect(await setup(null, { config: null }).auth.session()).toBeNull()
    const { auth } = setup('?code=good-code')
    await auth.signIn()
    await auth.signOut()
    expect(await auth.session()).toBeNull()
  })

  it('lowercases the email, as the database stores it', async () => {
    const session = { user: { id: 'u-ana', email: 'Ana@Gmail.com' } }
    const { auth } = setup(null, { overrides: { getSession: async () => ({ data: { session }, error: null }) } })
    expect((await auth.session())?.email).toBe('ana@gmail.com')
  })

  it('fails, instead of reporting a sign-out, when the session cannot be read', async () => {
    const { auth } = setup(null, {
      overrides: { getSession: async () => ({ data: { session: null }, error: { message: 'TypeError: fetch failed' } }) }
    })
    await expect(auth.session()).rejects.toThrow('TypeError: fetch failed')
  })
})
