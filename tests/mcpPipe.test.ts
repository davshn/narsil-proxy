import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { McpPipeServer } from '../src/main/adapters/mcpPipe'
import { NARSIL_CLOSED, callNarsil } from '../src/mcp/narsilClient'

const dir = mkdtempSync(join(tmpdir(), 'narsil-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let server: McpPipeServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

let n = 0
async function start(handlers: ConstructorParameters<typeof McpPipeServer>[0]): Promise<string> {
  const file = join(dir, `mcp-${++n}.json`)
  server = new McpPipeServer(handlers, { file })
  await server.start()
  return file
}

/** Sends one raw line and returns the raw answer line. */
function rawCall(pipe: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe, () => socket.write(line))
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\n')) {
        socket.end()
        resolve(data.trim())
      }
    })
    socket.on('error', reject)
  })
}

describe('McpPipeServer and callNarsil', () => {
  it('writes where to reach it, with a long random token, and removes it on stop', async () => {
    const file = await start({})
    const discovery = JSON.parse(readFileSync(file, 'utf8'))
    expect(discovery.pipe).toMatch(/^\\\\\.\\pipe\\narsil-mcp-[0-9a-f]{32}$/)
    expect(discovery.token).toMatch(/^[0-9a-f]{64}$/)
    expect(discovery.pid).toBe(process.pid)
    await server?.stop()
    expect(existsSync(file)).toBe(false)
  })

  it('runs the tool with its arguments and returns the result', async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => ({ echo: args }))
    const file = await start({ list_tasks: handler })
    expect(await callNarsil(file, 'list_tasks', { a: 1 })).toEqual({ echo: { a: 1 } })
    expect(handler).toHaveBeenCalledWith({ a: 1 })
  })

  it('passes the tool error message back', async () => {
    const file = await start({ delete_task: async () => Promise.reject(new Error('Esa tarea ya no existe.')) })
    await expect(callNarsil(file, 'delete_task', { id: 'x' })).rejects.toThrow('Esa tarea ya no existe.')
  })

  it('refuses an unknown tool', async () => {
    const file = await start({})
    await expect(callNarsil(file, 'send_reply', {})).rejects.toThrow('Narsil no tiene la herramienta send_reply.')
  })

  it('refuses a call with the wrong token and never runs the tool', async () => {
    const handler = vi.fn(async () => 'secreto')
    const file = await start({ list_tasks: handler })
    const { pipe } = JSON.parse(readFileSync(file, 'utf8'))
    const answer = JSON.parse(await rawCall(pipe, `${JSON.stringify({ token: 'f'.repeat(64), id: 7, tool: 'list_tasks', args: {} })}\n`))
    expect(answer).toEqual({ id: 7, ok: false, error: 'Token no válido.' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers a line that is not a request', async () => {
    const file = await start({})
    const { pipe } = JSON.parse(readFileSync(file, 'utf8'))
    expect(JSON.parse(await rawCall(pipe, 'hola\n'))).toEqual({ id: -1, ok: false, error: 'Solicitud no válida.' })
  })

  it('says Narsil is closed when there is no discovery file', async () => {
    await expect(callNarsil(join(dir, 'nada.json'), 'list_tasks', {})).rejects.toThrow(NARSIL_CLOSED)
  })

  it('says Narsil is closed when the file is left over from a crash', async () => {
    const file = join(dir, 'viejo.json')
    writeFileSync(file, JSON.stringify({ pipe: '\\\\.\\pipe\\narsil-mcp-nadie-escucha', token: 'a'.repeat(64), pid: 1 }))
    await expect(callNarsil(file, 'list_tasks', {})).rejects.toThrow(NARSIL_CLOSED)
  })
})
