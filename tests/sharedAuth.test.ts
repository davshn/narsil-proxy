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
      await storage.setItem('sb-auth', JSON.stringify({ user: { email: 'ana@gmail.com' } }))
      return { data: { session: { user: { email: 'ana@gmail.com' } } }, error: null }
    }),
    getSession: vi.fn(async () => {
      const raw = await storage.getItem('sb-auth')
      return { data: { session: raw ? (JSON.parse(raw) as { user: { email: string } }) : null } }
    }),
    signOut: vi.fn(async () => {
      await storage.removeItem('sb-auth')
      return { error: null }
    }),
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

  it('saving another project forgets the old session', async () => {
    const { auth, secrets } = setup('?code=good-code')
    await auth.signIn()
    const status = await auth.setConfig('https://zyxwvutsrqponmlk.supabase.co', 'sb_publishable_other')
    expect(status).toEqual({ configured: true, projectUrl: 'https://zyxwvutsrqponmlk.supabase.co' })
    expect(secrets.get('shared-session')).toBeNull()
  })
})
