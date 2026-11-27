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
    listFolders: vi.fn(async () => [{ id: 'L1', name: 'Facturas' }]),
    applyAction: vi.fn(async () => undefined),
    sendReply: vi.fn(async () => undefined),
    createMeeting: vi.fn(async (_accountId: string, input) => ({ id: 'a1:new', accountId: 'a1', ...input })),
    saveRule: vi.fn(async () => undefined),
    saveServerRule: vi.fn(async () => undefined)
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

describe('mail actions through MCP', () => {
  it.each([
    ['archive_email', 'archive', { key: 'a1:m1' }, { archived: 'a1:m1' }],
    ['delete_email', 'delete', { key: 'a1:m1' }, { deleted: 'a1:m1' }]
  ] as const)('%s acts on the email by its key', async (tool, action, args, answer) => {
    const { handlers, service } = setup()
    expect(await handlers[tool](args)).toEqual(answer)
    expect(service.applyAction).toHaveBeenCalledWith('a1:m1', action, undefined)
  })

  it('move_email moves the email to the folder', async () => {
    const { handlers, service } = setup()
    expect(await handlers.move_email({ key: 'a1:m1', folderId: 'L1' })).toEqual({ moved: 'a1:m1', folderId: 'L1' })
    expect(service.applyAction).toHaveBeenCalledWith('a1:m1', 'save', 'L1')
  })

  it('reply_email sends the reply from the account that received it', async () => {
    const { handlers, service } = setup()
    expect(await handlers.reply_email({ key: 'a1:m1', body: 'Gracias, la reviso hoy.' })).toEqual({ replied: 'a1:m1' })
    expect(service.sendReply).toHaveBeenCalledWith('a1:m1', 'Gracias, la reviso hoy.')
  })

  it('sends the reply text exactly as written, and refuses one that is only spaces', async () => {
    const { handlers, service } = setup()
    const body = '  Hola,\n\n  Ana\n'
    await handlers.reply_email({ key: 'a1:m1', body })
    expect(service.sendReply).toHaveBeenCalledWith('a1:m1', body)
    await expect(handlers.reply_email({ key: 'a1:m1', body: '  \n ' })).rejects.toThrow()
    expect(service.sendReply).toHaveBeenCalledTimes(1)
  })

  it('passes the service error back, so Claude can read it', async () => {
    const { handlers, service } = setup()
    vi.mocked(service.applyAction).mockRejectedValueOnce(new Error('Este correo ya no está en la lista.'))
    await expect(handlers.archive_email({ key: 'a1:gone' })).rejects.toThrow('Este correo ya no está en la lista.')
  })

  it('rejects a move without a folder and a reply without text', async () => {
    const { handlers, service } = setup()
    await expect(handlers.move_email({ key: 'a1:m1' })).rejects.toThrow()
    await expect(handlers.reply_email({ key: 'a1:m1', body: '' })).rejects.toThrow()
    expect(service.applyAction).not.toHaveBeenCalled()
    expect(service.sendReply).not.toHaveBeenCalled()
  })
})

describe('meetings and rules through MCP', () => {
  it('create_meeting adds it to the account calendar and returns it', async () => {
    const { handlers, service } = setup()
    const input = { title: 'Revisión', start: '2026-11-28T15:00:00.000Z', end: '2026-11-28T15:30:00.000Z', location: 'Meet' }
    expect(await handlers.create_meeting({ accountId: 'a1', ...input })).toEqual({ id: 'a1:new', accountId: 'a1', ...input })
    expect(service.createMeeting).toHaveBeenCalledWith('a1', input)
  })

  it('create_meeting passes a weekly series to the service, which plans and checks it', async () => {
    const { handlers, service } = setup()
    const input = {
      title: 'Clase de inglés',
      start: '2026-12-01T19:00:00-05:00',
      end: '2026-12-01T20:00:00-05:00',
      repeat: { days: ['TU', 'TH'], until: '2027-03-16' }
    }
    await handlers.create_meeting({ accountId: 'a1', ...input })
    expect(service.createMeeting).toHaveBeenCalledWith('a1', input)
  })

  it('create_meeting refuses a series with an unknown day or a badly written end date', async () => {
    const { handlers, service } = setup()
    const base = { accountId: 'a1', title: 'Clase', start: '2026-12-01T19:00:00-05:00', end: '2026-12-01T20:00:00-05:00' }
    await expect(handlers.create_meeting({ ...base, repeat: { days: ['martes'], until: '2027-03-16' } })).rejects.toThrow()
    await expect(handlers.create_meeting({ ...base, repeat: { days: ['TU'], until: '16/03/2027' } })).rejects.toThrow()
    expect(service.createMeeting).not.toHaveBeenCalled()
  })

  it('create_rule adds an enabled local rule, with empty conditions left out', async () => {
    const { handlers, service } = setup()
    expect(await handlers.create_rule({ name: 'Boletines', from: 'news@x.com', action: 'archive' })).toEqual({ localRules: [] })
    expect(service.saveRule).toHaveBeenCalledWith({
      name: 'Boletines',
      enabled: true,
      conditions: { from: 'news@x.com', subject: '', body: '' },
      action: 'archive'
    })
  })

  it('create_rule passes the folder of a save rule', async () => {
    const { handlers, service } = setup()
    const folder = { accountId: 'a1', id: 'L1', name: 'Facturas' }
    await handlers.create_rule({ name: 'Facturas', subject: 'factura', action: 'save', folder })
    expect(service.saveRule).toHaveBeenCalledWith(expect.objectContaining({ action: 'save', folder }))
  })

  it('create_server_rule creates it in the account and returns that account rules', async () => {
    const { handlers, service } = setup()
    const result = await handlers.create_server_rule({ accountId: 'a1', name: 'Facturas', subject: 'factura', action: 'move', folderId: 'L1', folderName: 'Facturas' })
    expect(service.saveServerRule).toHaveBeenCalledWith({
      accountId: 'a1',
      name: 'Facturas',
      conditions: { from: '', subject: 'factura', body: '' },
      action: 'move',
      folderId: 'L1',
      folderName: 'Facturas'
    })
    expect(result).toEqual({ accountId: 'a1', account: 'yo@gmail.com', rules: [], loaded: true, needsReconnect: false })
  })

  it('never accepts an id, so rules can only be created', async () => {
    const { handlers, service } = setup()
    await expect(handlers.create_rule({ id: 'r1', name: 'x', action: 'archive' })).rejects.toThrow()
    await expect(handlers.create_server_rule({ id: 'f1', accountId: 'a1', name: 'x', action: 'archive' })).rejects.toThrow()
    expect(service.saveRule).not.toHaveBeenCalled()
    expect(service.saveServerRule).not.toHaveBeenCalled()
  })
})
