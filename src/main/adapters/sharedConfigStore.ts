import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SharedConfig, SharedConfigRepository } from '../app/sharedAuth'

const ConfigSchema = z.object({ url: z.string().min(1), publishableKey: z.string().min(1) })

/** The shared-lists project. Both values are public, so they live as plain JSON in userData. */
export class SharedConfigFileStore implements SharedConfigRepository {
  private readonly file = join(app.getPath('userData'), 'shared.json')

  load(): SharedConfig | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(config: SharedConfig): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(config, null, 2))
    renameSync(temp, this.file)
  }
}
