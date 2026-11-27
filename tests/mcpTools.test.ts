import { describe, expect, it, vi } from 'vitest'
import type { AppStatus, InboxItem, Meeting, PendingTask } from '@shared/types'
import { MCP_TOOL_NAMES } from '../src/mcp/protocol'
import { TaskList, type TasksRepository } from '../src/main/app/tasks'
import { createMcpHandlers, type McpServiceView } from '../src/main/app/mcpTools'

class MemoryRepo implements TasksRepository {
  tasks: PendingTask[] = []
  load(): PendingTask[] {
    return structuredClone(this.tasks)
  }
  save(tasks: PendingTask[]): void {
    this.tasks = structuredClone(tasks)
  }
}

const status: AppStatus = {
  accounts: [
    { id: 'a1', provider: 'google', email: 'yo@gmail.com', settings: { includeCategories: false, windowDays: 2 } },
    { id: 'a2', provider: 'microsoft', email: 'yo@outlook.com', settings: { includeCategories: true, windowDays: 7 }, needsReconnect: true }
  ],
  hasGoogleClient: true,
  hasMicrosoftClient: true,
  hasAnthropicKey: true,
  lastError: 'Sin conexión'
}

const item: InboxItem = {
  key: 'a1:m1',
  email: {
    id: 'm1',
    accountId: 'a1',
    threadId: 't1',
    from: 'Ana <ana@x.com>',
    replyTo: 'ana@x.com',
    subject: 'Factura',
    snippet: 'Adjunto la factura',
    receivedAt: '2026-11-26T10:00:00.000Z',
    webLink: 'https://mail.google.com/mail/?authuser=yo%40gmail.com#all/m1'
  },
  triage: { summary: 'Envía una factura', recommendedAction: 'save', reason: 'Es un documento', replies: [] }
}

const meeting: Meeting = { id: 'a2:e1', accountId: 'a2', title: 'Daily', start: '2026-11-27T13:00:00.000Z', end: '2026-11-27T13:15:00.000Z' }

function setup(): { handlers: ReturnType<typeof createMcpHandlers>; repo: MemoryRepo; changed: ReturnType<typeof vi.fn>; service: McpServiceView } {
  const repo = new MemoryRepo()
  let n = 0
  const tasks = new TaskList(repo, { newId: () => `t${++n}`, now: () => new Date('2026-11-26T12:00:00Z') })
  const service: McpServiceView = {
    status: () => status,
    inboxItems: () => [item],
    upcomingMeetings: () => [meeting],
    rules: () => [],
    serverRules: () => [{ accountId: 'a1', rules: [], loaded: true, needsReconnect: false }],
    listFolders: vi.fn(async () => [{ id: 'L1', name: 'Facturas' }])
  }
  const changed = vi.fn()
  return { handlers: createMcpHandlers({ service, tasks, tasksChanged: changed }), repo, changed, service }
}

describe('createMcpHandlers', () => {
  it('has a handler for every advertised tool', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual([...MCP_TOOL_NAMES].sort())
  })

  it('get_status lists the accounts without their settings', async () => {
    expect(await setup().handlers.get_status({})).toEqual({
      accounts: [
        { id: 'a1', provider: 'google', email: 'yo@gmail.com', needsReconnect: false },
        { id: 'a2', provider: 'microsoft', email: 'yo@outlook.com', needsReconnect: true }
      ],
      canTriage: true,
      lastError: 'Sin conexión'
    })
  })

  it('get_inbox returns each email with its account address and triage', async () => {
    expect(await setup().handlers.get_inbox({})).toEqual([
      {
        key: 'a1:m1',
        account: 'yo@gmail.com',
        from: 'Ana <ana@x.com>',
        subject: 'Factura',
        snippet: 'Adjunto la factura',
        receivedAt: '2026-11-26T10:00:00.000Z',
        webLink: 'https://mail.google.com/mail/?authuser=yo%40gmail.com#all/m1',
        triage: item.triage
      }
    ])
  })

  it('get_meetings adds the account address', async () => {
    expect(await setup().handlers.get_meetings({})).toEqual([{ ...meeting, account: 'yo@outlook.com' }])
  })

  it('get_rules returns local rules and each account\'s server rules', async () => {
    expect(await setup().handlers.get_rules({})).toEqual({
      localRules: [],
      accounts: [{ accountId: 'a1', account: 'yo@gmail.com', rules: [], loaded: true, needsReconnect: false }]
    })
  })

  it('list_folders asks the service for that account', async () => {
    const { handlers, service } = setup()
    expect(await handlers.list_folders({ accountId: 'a1' })).toEqual([{ id: 'L1', name: 'Facturas' }])
    expect(service.listFolders).toHaveBeenCalledWith('a1')
  })

  it('rejects arguments that do not match the tool', async () => {
    const { handlers } = setup()
    await expect(handlers.list_folders({})).rejects.toThrow()
    await expect(handlers.set_task_status({ id: 't1', status: 'lista' })).rejects.toThrow()
    await expect(handlers.get_inbox({ extra: 1 })).rejects.toThrow()
  })
})

describe('Pendientes through MCP', () => {
  it('adds a task as todo, stores it and tells the window', async () => {
    const { handlers, repo, changed } = setup()
    const result = await handlers.save_task({ name: 'Llamar a Ana', project: 'Casa' })
    const task: PendingTask = { id: 't1', name: 'Llamar a Ana', description: '', project: 'Casa', status: 'todo', createdAt: '2026-11-26T12:00:00.000Z' }
    expect(result).toEqual(task)
    expect(repo.tasks).toEqual([task])
    expect(changed).toHaveBeenCalledWith([task])
    expect(await handlers.list_tasks({})).toEqual([task])
  })

  it('needs a name for a new task', async () => {
    const { handlers, changed } = setup()
    await expect(handlers.save_task({ project: 'Casa' })).rejects.toThrow('Escribe un nombre para la tarea.')
    expect(changed).not.toHaveBeenCalled()
  })

  it('edits only the fields it is given', async () => {
    const { handlers } = setup()
    await handlers.save_task({ name: 'Uno', project: 'A', description: 'Detalle' })
    expect(await handlers.save_task({ id: 't1', project: 'B' })).toMatchObject({ name: 'Uno', project: 'B', description: 'Detalle' })
  })

  it('reports a missing task when editing', async () => {
    await expect(setup().handlers.save_task({ id: 'gone', name: 'x' })).rejects.toThrow('Esa tarea ya no existe.')
  })

  it('changes the status and deletes, telling the window each time', async () => {
    const { handlers, repo, changed } = setup()
    await handlers.save_task({ name: 'Uno' })
    expect(await handlers.set_task_status({ id: 't1', status: 'in-progress' })).toMatchObject({ id: 't1', status: 'in-progress' })
    expect(repo.tasks[0]?.status).toBe('in-progress')
    expect(await handlers.delete_task({ id: 't1' })).toEqual({ deleted: 't1' })
    expect(repo.tasks).toEqual([])
    expect(changed).toHaveBeenCalledTimes(3)
    expect(changed).toHaveBeenLastCalledWith([])
  })
})
