import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SecretName =
  | 'anthropic-key'
  | 'accounts'
  | 'google-client'
  /** Legacy single-account Google tokens, migrated to per-account names on startup. */
  | 'google-tokens'
  | `google-tokens.${string}`
  | 'microsoft-client'
  | 'microsoft-cache'
  | `microsoft-account.${string}`

const SAFE_NAME = /^[a-z0-9][a-z0-9.-]*$/i
const EXTENSION = '.bin'

const NO_ENCRYPTION = 'El cifrado del sistema no está disponible'

function checkName(name: string): void {
  // Names become file names: allow only a safe alphabet so an id can never escape the folder.
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid secret name: ${name}`)
}

/**
 * Stores secrets encrypted with the OS keychain (DPAPI on Windows) under the
 * app's userData folder. Refuses to write plaintext when encryption is unavailable.
 */
export class SecureStore {
  private readonly dir = join(app.getPath('userData'), 'secrets')

  private file(name: SecretName): string {
    checkName(name)
    return join(this.dir, `${name}${EXTENSION}`)
  }

  /** The secret, or null when it is missing or cannot be decrypted. */
  get(name: SecretName): string | null {
    const path = this.file(name)
    if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(readFileSync(path))
    } catch {
      return null
    }
  }

  /** The secret, or null when it is missing. Throws when it exists but cannot be read. */
  getStrict(name: SecretName): string | null {
    const path = this.file(name)
    if (!existsSync(path)) return null
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`${NO_ENCRYPTION}; no se puede leer el secreto ${name}.`)
    let data: Buffer
    try {
      data = readFileSync(path)
    } catch {
      throw new Error(`No se pudo leer el secreto ${name}.`)
    }
    try {
      return safeStorage.decryptString(data)
    } catch {
      throw new Error(`No se pudo descifrar el secreto ${name}.`)
    }
  }

  /** Writes a temporary file next to the secret, then renames it, so a crash never leaves half a secret. */
  set(name: SecretName, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`${NO_ENCRYPTION}; no se guardarán secretos en texto plano.`)
    }
    const target = this.file(name)
    mkdirSync(this.dir, { recursive: true })
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, safeStorage.encryptString(value), { mode: 0o600 })
      renameSync(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  delete(name: SecretName): void {
    rmSync(this.file(name), { force: true })
  }

  has(name: SecretName): boolean {
    return this.get(name) !== null
  }

  /** Names of the stored secrets that start with `prefix`, e.g. `google-tokens.`. */
  list(prefix: string): SecretName[] {
    checkName(prefix)
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(EXTENSION))
      .map((file) => file.slice(0, -EXTENSION.length))
      .filter((name) => name.startsWith(prefix) && SAFE_NAME.test(name)) as SecretName[]
  }
}
