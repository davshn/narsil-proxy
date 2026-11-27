import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { PendingTask } from '@shared/types'
import { McpPipeServer } from '../src/main/adapters/mcpPipe'
import { createMcpHandlers } from '../src/main/app/mcpTools'
import { TaskList, type TasksRepository } from '../src/main/app/tasks'
import { createBridge } from '../src/mcp/bridge'
import { MCP_TOOL_NAMES } from '../src/mcp/protocol'
import { NARSIL_CLOSED } from '../src/mcp/narsilClient'

const dir = mkdtempSync(join(tmpdir(), 'narsil-bridge-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

class MemoryRepo implements TasksRepository {
  tasks: PendingTask[] = []
  load(): PendingTask[] {
    return structuredClone(this.tasks)
  }
  save(tasks: PendingTask[]): void {
    this.tasks = structuredClone(tasks)
  }
}

let pipe: McpPipeServer | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  await pipe?.stop()
  client = undefined
  pipe = undefined
})

let n = 0
/** A real MCP client talking to the bridge, which talks to a Narsil pipe when `withNarsil`. */
async function connectClient(withNarsil: boolean): Promise<{ client: Client; repo: MemoryRepo }> {
  const file = join(dir, `mcp-${++n}.json`)
  const repo = new MemoryRepo()
  if (withNarsil) {
    const tasks = new TaskList(repo, { newId: () => 't1', now: () => new Date('2026-11-26T12:00:00Z') })
    const service = {
      status: () => ({ accounts: [], hasGoogleClient: false, hasMicrosoftClient: false, hasAnthropicKey: false }),
      inboxItems: () => [],
      upcomingMeetings: () => [],
      rules: () => [],
      serverRules: () => [],
      listFolders: async () => [],
      applyAction: async () => undefined,
      sendReply: async () => undefined,
      createMeeting: async () => Promise.reject(new Error('unused')),
      saveRule: async () => undefined,
      saveServerRule: async () => undefined
    }
    pipe = new McpPipeServer(createMcpHandlers({ service, tasks, tasksChanged: () => undefined, shared: { apply: async () => ({ ok: true, state: { signedIn: false, snapshot: null } }), refresh: async () => ({ signedIn: false, snapshot: null }), state: () => ({ signedIn: false, snapshot: null }) } }), { file })
    await pipe.start()
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createBridge(file).connect(serverSide)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return { client, repo }
}

const text = (result: Awaited<ReturnType<Client['callTool']>>): string => (result.content as { text: string }[])[0]?.text ?? ''

describe('the MCP bridge', () => {
  it('advertises every tool with its annotations, and nothing about accounts or keys', async () => {
    const { client } = await connectClient(false)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort())
    expect(tools.find((t) => t.name === 'get_inbox')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'delete_task')?.annotations?.destructiveHint).toBe(true)
    for (const name of ['archive_email', 'delete_email', 'move_email', 'reply_email', 'create_rule', 'create_server_rule']) {
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    }
    expect(tools.find((t) => t.name === 'create_meeting')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(tools.some((t) => /account|key|client|setting/i.test(t.name))).toBe(false)
    // Every tool that changes mail or rules tells the model to ask the user first.
    for (const tool of tools.filter((t) => t.annotations?.destructiveHint)) {
      expect(tool.description, tool.name).toMatch(/Confirm with the user first/)
    }
    expect(client.getInstructions()).toMatch(/send, archive, delete and move mail/)
  })

  it('creates a task in Narsil and returns it as JSON', async () => {
    const { client, repo } = await connectClient(true)
    const result = await client.callTool({ name: 'save_task', arguments: { name: 'Probar el MCP', project: 'Narsil' } })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(text(result))).toMatchObject({ id: 't1', name: 'Probar el MCP', project: 'Narsil', status: 'todo' })
    expect(repo.tasks).toHaveLength(1)
    const listed = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect(listed.isError).toBeFalsy()
    expect(JSON.parse(text(listed))).toHaveLength(1)
    const status = await client.callTool({ name: 'get_status' })
    expect(JSON.parse(text(status))).toEqual({ accounts: [], canTriage: false })
  })

  it('returns a tool failure as an error result Claude can read', async () => {
    const { client } = await connectClient(true)
    const result = await client.callTool({ name: 'delete_task', arguments: { id: 'nada' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Esa tarea ya no existe.')
  })

  it('says clearly that Narsil is closed', async () => {
    const { client } = await connectClient(false)
    const result = await client.callTool({ name: 'list_tasks', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(NARSIL_CLOSED)
  })
})
