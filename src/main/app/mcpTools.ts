import { z } from 'zod'
import { MCP_TOOLS, type McpToolName } from '../../mcp/protocol'
import type { PendingTask } from '@shared/types'
import type { NarsilService } from './narsilService'
import type { TaskList } from './tasks'

/** What the bridge may read from the service: no accounts, credentials or mail actions. */
export type McpServiceView = Pick<NarsilService, 'status' | 'inboxItems' | 'upcomingMeetings' | 'rules' | 'serverRules' | 'listFolders'>

export interface McpToolDeps {
  service: McpServiceView
  /** The same list the "Pendientes" tab uses. */
  tasks: TaskList
  /** A tool changed the tasks; the open window must show them. */
  tasksChanged(tasks: PendingTask[]): void
}

/** Runs one tool with the arguments Claude sent; throws with a message Claude can read. */
export type McpHandler = (args: Record<string, unknown>) => Promise<unknown>

/** The tool's own schema, checked again here: the pipe accepts any JSON. */
function parse<N extends McpToolName>(name: N, args: Record<string, unknown>): z.infer<z.ZodObject<(typeof MCP_TOOLS)[N]['input']>> {
  return z.strictObject(MCP_TOOLS[name].input).parse(args) as z.infer<z.ZodObject<(typeof MCP_TOOLS)[N]['input']>>
}

export function createMcpHandlers({ service, tasks, tasksChanged }: McpToolDeps): Record<McpToolName, McpHandler> {
  const emailOf = (accountId: string): string | undefined => service.status().accounts.find((a) => a.id === accountId)?.email

  /** Stores a change, tells the window, and answers with the task it touched. */
  const change = (list: PendingTask[], id: string): PendingTask | undefined => {
    tasksChanged(list)
    return list.find((task) => task.id === id)
  }

  return {
    get_status: async (args) => {
      parse('get_status', args)
      const status = service.status()
      return {
        accounts: status.accounts.map((a) => ({ id: a.id, provider: a.provider, email: a.email, needsReconnect: a.needsReconnect ?? false })),
        canTriage: status.hasAnthropicKey,
        ...(status.lastError ? { lastError: status.lastError } : {})
      }
    },
    get_inbox: async (args) => {
      parse('get_inbox', args)
      return service.inboxItems().map(({ key, email, triage, triageError }) => ({
        key,
        account: emailOf(email.accountId),
        from: email.from,
        subject: email.subject,
        snippet: email.snippet,
        receivedAt: email.receivedAt,
        ...(email.webLink ? { webLink: email.webLink } : {}),
        triage,
        ...(triageError ? { triageError } : {})
      }))
    },
    get_meetings: async (args) => {
      parse('get_meetings', args)
      return service.upcomingMeetings().map((meeting) => ({ ...meeting, account: emailOf(meeting.accountId) }))
    },
    get_rules: async (args) => {
      parse('get_rules', args)
      return {
        localRules: service.rules(),
        accounts: service.serverRules().map((group) => ({ ...group, account: emailOf(group.accountId) }))
      }
    },
    list_folders: async (args) => service.listFolders(parse('list_folders', args).accountId),
    list_tasks: async (args) => {
      parse('list_tasks', args)
      return tasks.list()
    },
    save_task: async (args) => {
      const input = parse('save_task', args)
      // Claude often sends only what changes; keep the rest of an edited task.
      const before = tasks.list()
      const current = input.id === undefined ? undefined : before.find((task) => task.id === input.id)
      if (input.id !== undefined && !current) throw new Error('Esa tarea ya no existe.')
      const list = tasks.save({
        ...(input.id === undefined ? {} : { id: input.id }),
        name: input.name ?? current?.name ?? '',
        project: input.project ?? current?.project ?? '',
        description: input.description ?? current?.description ?? ''
      })
      // A new task is the one whose id was not there before.
      const known = new Set(before.map((task) => task.id))
      const id = input.id ?? list.find((task) => !known.has(task.id))?.id ?? ''
      return change(list, id)
    },
    set_task_status: async (args) => {
      const { id, status } = parse('set_task_status', args)
      return change(tasks.setStatus(id, status), id)
    },
    delete_task: async (args) => {
      const { id } = parse('delete_task', args)
      tasksChanged(tasks.remove(id))
      return { deleted: id }
    }
  }
}
