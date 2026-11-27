import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TASK_STATUSES, type PendingTask } from '@shared/types'
import type { TasksRepository } from '../app/tasks'

const Fields = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  project: z.string(),
  createdAt: z.string()
}

const TaskSchema = z.union([
  z.object({ ...Fields, status: z.enum(TASK_STATUSES) }),
  // Saved before tasks had a status: a done task is finished, any other is still to do.
  z.object({ ...Fields, done: z.boolean() }).transform(({ done, ...task }): PendingTask => ({ ...task, status: done ? 'done' : 'todo' }))
])

/** Tasks are not secret, so they live as plain JSON in the app's userData folder, like the rules. */
export class TasksFileStore implements TasksRepository {
  private readonly file = join(app.getPath('userData'), 'tasks.json')

  load(): PendingTask[] {
    if (!existsSync(this.file)) return []
    const parsed = z.array(TaskSchema).safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
    if (!parsed.success) throw new Error(`El archivo de pendientes está dañado: ${this.file}`)
    return parsed.data
  }

  save(tasks: PendingTask[]): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    // Write then rename so a crash mid-write never leaves a half-written file.
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(tasks, null, 2))
    renameSync(temp, this.file)
  }
}
