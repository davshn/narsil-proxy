import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { MCP_MAX_LINE, McpRequestSchema, type McpDiscovery, type McpResponse } from '../../mcp/protocol'
import type { McpHandler } from '../app/mcpTools'

export interface McpPipeOptions {
  /** Where to write how to reach this server (see mcpDiscoveryFile). */
  file: string
}

/**
 * Serves the MCP bridge over a Windows named pipe with a random name. Each line is one JSON
 * request carrying the token from the discovery file; a request without it never runs.
 */
export class McpPipeServer {
  private server: Server | undefined
  private readonly discovery: McpDiscovery = {
    pipe: `\\\\.\\pipe\\narsil-mcp-${randomBytes(16).toString('hex')}`,
    token: randomBytes(32).toString('hex'),
    pid: process.pid
  }

  constructor(
    private readonly handlers: Partial<Record<string, McpHandler>>,
    private readonly options: McpPipeOptions
  ) {}

  async start(): Promise<void> {
    const server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.discovery.pipe, () => resolve())
    })
    this.server = server
    mkdirSync(dirname(this.options.file), { recursive: true })
    writeFileSync(this.options.file, JSON.stringify(this.discovery), { mode: 0o600 })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    // Another Narsil may have started since; only remove the file this one wrote.
    try {
      if (JSON.parse(readFileSync(this.options.file, 'utf8')).token === this.discovery.token) rmSync(this.options.file, { force: true })
    } catch {
      // Already gone or unreadable: nothing of ours to remove.
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private serve(socket: Socket): void {
    let buffer = ''
    // One request at a time per connection keeps answers in order.
    let queue = Promise.resolve()
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MCP_MAX_LINE && !buffer.includes('\n')) {
        socket.end(`${JSON.stringify({ id: -1, ok: false, error: 'Solicitud demasiado grande.' } satisfies McpResponse)}\n`)
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        queue = queue.then(async () => {
          const answer = await this.answer(line)
          if (!socket.destroyed) socket.write(`${JSON.stringify(answer)}\n`)
        })
      }
    })
  }

  private async answer(line: string): Promise<McpResponse> {
    let parsed
    try {
      parsed = McpRequestSchema.safeParse(JSON.parse(line))
    } catch {
      parsed = undefined
    }
    if (!parsed?.success) return { id: -1, ok: false, error: 'Solicitud no válida.' }
    const { id, token, tool, args } = parsed.data
    if (!this.tokenMatches(token)) return { id, ok: false, error: 'Token no válido.' }
    const handler = Object.hasOwn(this.handlers, tool) ? this.handlers[tool] : undefined
    if (!handler) return { id, ok: false, error: `Narsil no tiene la herramienta ${tool}.` }
    try {
      return { id, ok: true, result: (await handler(args)) ?? null }
    } catch (error) {
      return { id, ok: false, error: describe(error) }
    }
  }

  private tokenMatches(token: string): boolean {
    const expected = Buffer.from(this.discovery.token)
    const given = Buffer.from(token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

/** A zod failure becomes its issues; anything else its message. */
function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
    return `Argumentos no válidos: ${error.issues.map((i: { path?: unknown[]; message?: string }) => `${(i.path ?? []).join('.') || '(raíz)'}: ${i.message}`).join('; ')}`
  }
  return error instanceof Error ? error.message : String(error)
}
