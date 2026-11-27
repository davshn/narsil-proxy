import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { MCP_MAX_LINE, McpDiscoverySchema, type McpDiscovery, type McpResponse } from './protocol'

export const NARSIL_CLOSED = 'Narsil no está abierta. Ábrela en este equipo y vuelve a intentarlo.'

/** The slowest tool asks Gmail or Outlook for folders; past this the call is given up. */
const TIMEOUT_MS = 30_000

function readDiscovery(file: string): McpDiscovery {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(NARSIL_CLOSED)
  }
  let parsed
  try {
    parsed = McpDiscoverySchema.safeParse(JSON.parse(raw))
  } catch {
    parsed = undefined
  }
  if (!parsed?.success) throw new Error(NARSIL_CLOSED)
  return parsed.data
}

let nextId = 1

/**
 * Runs one tool in the running Narsil and returns its result. Throws NARSIL_CLOSED when no
 * Narsil is listening, and the tool's own message when the tool fails.
 */
export async function callNarsil(file: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const discovery = readDiscovery(file)
  const id = nextId++
  return await new Promise((resolve, reject) => {
    let answered = false
    let buffer = ''
    const finish = (error: Error | null, value?: unknown): void => {
      if (answered) return
      answered = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Narsil tardó demasiado en responder.')), TIMEOUT_MS)
    const socket = connect(discovery.pipe, () => {
      socket.write(`${JSON.stringify({ token: discovery.token, id, tool, args })}\n`)
    })
    socket.setEncoding('utf8')
    // The pipe is gone (Narsil closed or crashed and left the file behind).
    socket.on('error', () => finish(new Error(NARSIL_CLOSED)))
    socket.on('close', () => finish(new Error(NARSIL_CLOSED)))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MCP_MAX_LINE) return finish(new Error('La respuesta de Narsil es demasiado grande.'))
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let answer: McpResponse
      try {
        answer = JSON.parse(buffer.slice(0, newline)) as McpResponse
      } catch {
        return finish(new Error('Narsil respondió algo que no se entiende.'))
      }
      if (answer.ok) finish(null, answer.result)
      else finish(new Error(answer.error))
    })
  })
}
