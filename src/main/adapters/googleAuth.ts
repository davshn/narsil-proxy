import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { CodeChallengeMethod, type Credentials, type OAuth2Client } from 'google-auth-library'
import { z } from 'zod'

/** Lets Narsil manage Gmail filters, which hold the user's rules. */
export const GMAIL_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  GMAIL_SETTINGS_SCOPE,
  'https://www.googleapis.com/auth/calendar.readonly'
]

const LOGIN_TIMEOUT_MS = 5 * 60_000

/** Shape of the "Desktop app" OAuth client JSON downloaded from Google Cloud Console. */
const ClientFileSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) })
})

export interface ClientConfig {
  clientId: string
  clientSecret: string
}

export function parseClientFile(json: string): ClientConfig {
  const parsed = ClientFileSchema.safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new Error('Este no es un archivo de cliente OAuth de Google tipo "App de escritorio" (falta la sección "installed").')
  }
  return { clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret }
}

/**
 * Runs the OAuth loopback flow with PKCE in the user's default browser and returns the
 * tokens Google issues. `client` must have no stored credentials. `loginHint` preselects the
 * mailbox in Google's account chooser.
 */
export async function signInWithBrowser(
  client: OAuth2Client,
  openExternal: (url: string) => Promise<void>,
  loginHint?: string
): Promise<Credentials> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const state = randomBytes(16).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    const code = await waitForCode(server, state, () => {
      const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_SCOPES,
        state,
        redirect_uri: redirectUri,
        code_challenge_method: CodeChallengeMethod.S256,
        ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
        ...(loginHint ? { login_hint: loginHint } : {})
      })
      return openExternal(url)
    })
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
    return tokens
  } finally {
    server.close()
  }
}

function waitForCode(server: Server, state: string, openBrowser: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Se agotó el tiempo para iniciar sesión en Google.')), LOGIN_TIMEOUT_MS)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Requests without our state did not come from Google's redirect: ignore them.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (error || !code) {
        res.end('<h2>Narsil no pudo conectarse a Google.</h2><p>Ya puedes cerrar esta pestaña.</p>')
        fail(new Error(`Falló el inicio de sesión en Google: ${error ?? 'no se recibió código de autorización'}`))
        return
      }
      res.end('<h2>Narsil está conectado a Google.</h2><p>Ya puedes cerrar esta pestaña.</p>')
      clearTimeout(timer)
      resolve(code)
    })
    openBrowser().catch((error: unknown) =>
      fail(new Error(`No se pudo abrir tu navegador: ${error instanceof Error ? error.message : String(error)}`))
    )
  })
}
