import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SecretName = 'google-client' | 'google-tokens' | 'anthropic-key'

/**
 * Stores secrets encrypted with the OS keychain (DPAPI on Windows) under the
 * app's userData folder. Refuses to write plaintext when encryption is unavailable.
 */
export class SecureStore {
  private readonly dir = join(app.getPath('userData'), 'secrets')

  private file(name: SecretName): string {
    return join(this.dir, `${name}.bin`)
  }

  get(name: SecretName): string | null {
    const path = this.file(name)
    if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(readFileSync(path))
    } catch {
      return null
    }
  }

  set(name: SecretName, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('El cifrado del sistema no está disponible; no se guardarán secretos en texto plano.')
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(name), safeStorage.encryptString(value), { mode: 0o600 })
  }

  delete(name: SecretName): void {
    rmSync(this.file(name), { force: true })
  }

  has(name: SecretName): boolean {
    return this.get(name) !== null
  }
}
