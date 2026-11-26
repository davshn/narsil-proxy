import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Rule } from '@shared/types'

export interface RulesRepository {
  load(): Rule[]
  save(rules: Rule[]): void
}

const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  action: z.enum(['archive', 'delete', 'save']),
  conditions: z.object({ from: z.string(), subject: z.string(), body: z.string() })
})

/** Rules are not secret, so they live as plain JSON in the app's userData folder. */
export class RulesFileStore implements RulesRepository {
  private readonly file = join(app.getPath('userData'), 'rules.json')

  load(): Rule[] {
    if (!existsSync(this.file)) return []
    const parsed = z.array(RuleSchema).safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
    if (!parsed.success) throw new Error(`El archivo de reglas está dañado: ${this.file}`)
    return parsed.data
  }

  save(rules: Rule[]): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    // Write then rename so a crash mid-write never leaves a half-written rules file.
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(rules, null, 2))
    renameSync(temp, this.file)
  }
}
