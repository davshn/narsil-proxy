export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'

/** Returns a fresh access token for one account; called before every Graph request. */
export type AccessTokenSource = () => Promise<string>

export interface GraphRequest {
  /** Query parameters. Keys are sent literally (`$filter`); values are URL-encoded. */
  query?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
}

const MAX_ERROR_DETAIL = 200

/** Percent-encodes a message id for use as one path segment. */
export function pathSegment(id: string): string {
  return encodeURIComponent(id)
}

function buildUrl(path: string, query: Record<string, string> | undefined): string {
  const params = Object.entries(query ?? {}).map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return `${GRAPH_BASE_URL}${path}${params.length ? `?${params.join('&')}` : ''}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function graphErrorField(payload: unknown, field: 'message' | 'code'): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as { error?: Record<string, unknown> }).error?.[field]
  return typeof value === 'string' && value ? value.slice(0, MAX_ERROR_DETAIL) : undefined
}

/** A non-2xx Graph answer. `code` is Graph's error code, e.g. `ErrorAccessDenied`. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(message)
    this.name = 'GraphError'
  }
}

/** Minimal Microsoft Graph v1.0 client over the global `fetch`. */
export class GraphClient {
  constructor(private readonly accessToken: AccessTokenSource) {}

  async request<T = unknown>(method: string, path: string, options: GraphRequest = {}): Promise<T | undefined> {
    const token = await this.accessToken()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...options.headers }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    let response: Response
    try {
      response = await fetch(buildUrl(path, options.query), init)
    } catch (error) {
      throw new Error(`No se pudo contactar a Microsoft Graph: ${error instanceof Error ? error.message : String(error)}`)
    }

    const payload = await readJson(response)
    if (!response.ok) {
      const detail = graphErrorField(payload, 'message')
      throw new GraphError(
        `Microsoft Graph respondió con el estado ${response.status}${detail ? `: ${detail}` : '.'}`,
        response.status,
        graphErrorField(payload, 'code')
      )
    }
    return payload as T | undefined
  }
}
