import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SharedSnapshot } from '@shared/types'
import { SharedSnapshotSchema, type SharedCacheRepository } from '../app/sharedSync'

/**
 * The last shared-lists snapshot, as plain JSON in userData like the personal tasks. It is
 * deleted on sign-out, so another person signing in on this computer never sees it.
 */
export class SharedCacheFileStore implements SharedCacheRepository {
  private readonly file = join(app.getPath('userData'), 'shared-cache.json')

  load(): SharedSnapshot | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed = SharedSnapshotSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      // A damaged copy is only a cache: the next sync writes a fresh one.
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(snapshot: SharedSnapshot): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(snapshot))
    renameSync(temp, this.file)
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
