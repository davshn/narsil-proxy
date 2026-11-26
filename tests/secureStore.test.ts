import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ userData: '', encryption: true }))

// A reversible stand-in for DPAPI: anything without the prefix fails to decrypt, like a damaged file.
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  safeStorage: {
    isEncryptionAvailable: () => env.encryption,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (data: Buffer) => {
      const text = data.toString()
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text.slice(4)
    }
  }
}))

const { SecureStore } = await import('../src/main/adapters/secureStore')

const root = mkdtempSync(join(tmpdir(), 'narsil-securestore-'))
let count = 0

beforeEach(() => {
  env.userData = join(root, String(count++))
  env.encryption = true
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const secretsDir = (): string => join(env.userData, 'secrets')

describe('SecureStore', () => {
  it('round-trips a secret and leaves no temporary file behind after an atomic write', () => {
    const store = new SecureStore()
    store.set('accounts', '[1]')
    store.set('accounts', '[2]')

    expect(store.get('accounts')).toBe('[2]')
    expect(store.getStrict('accounts')).toBe('[2]')
    expect(readdirSync(secretsDir())).toEqual(['accounts.bin'])
  })

  it('reads a secret that cannot be decrypted as null leniently and as an error strictly', () => {
    const store = new SecureStore()
    store.set('accounts', '[]')
    writeFileSync(join(secretsDir(), 'accounts.bin'), 'garbage')

    expect(store.get('accounts')).toBeNull()
    expect(() => store.getStrict('accounts')).toThrow(new Error('No se pudo descifrar el secreto accounts.'))
  })

  it('reads a missing secret as null even strictly', () => {
    expect(new SecureStore().getStrict('accounts')).toBeNull()
  })

  it('refuses a strict read of an existing secret when encryption is unavailable', () => {
    const store = new SecureStore()
    store.set('accounts', '[]')
    env.encryption = false

    expect(store.get('accounts')).toBeNull()
    expect(() => store.getStrict('accounts')).toThrow('El cifrado del sistema no está disponible')
  })

  it('lists the stored secret names that start with a prefix', () => {
    const store = new SecureStore()
    expect(store.list('google-tokens.')).toEqual([])
    store.set('google-tokens.a1', '{}')
    store.set('google-tokens.b2', '{}')
    store.set('google-tokens', '{}')
    store.set('microsoft-account.m1', 'home')
    writeFileSync(join(secretsDir(), 'google-tokens.c3.bin.123.tmp'), 'partial')

    expect(store.list('google-tokens.').sort()).toEqual(['google-tokens.a1', 'google-tokens.b2'])
    expect(store.list('microsoft-account.')).toEqual(['microsoft-account.m1'])
  })

  it('validates every name, including list prefixes', () => {
    const store = new SecureStore()
    expect(() => store.list('../x')).toThrow('Invalid secret name')
    expect(() => store.getStrict('google-tokens.../x')).toThrow('Invalid secret name')
    expect(() => store.set('google-tokens./x', '{}')).toThrow('Invalid secret name')
  })
})
