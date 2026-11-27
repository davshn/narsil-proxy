import { createClient } from '@supabase/supabase-js'
import type { AuthClient, SessionStorage, SharedConfig } from '../app/sharedAuth'

/**
 * Supabase's auth client for the main process: PKCE, the session kept in Narsil's encrypted
 * storage, and no URL detection, which only applies inside a browser page.
 */
export function makeSupabaseAuth(config: SharedConfig, storage: SessionStorage): AuthClient {
  const client = createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  })
  return {
    signInWithOAuth: (credentials) => client.auth.signInWithOAuth(credentials),
    exchangeCodeForSession: (code) => client.auth.exchangeCodeForSession(code),
    getSession: () => client.auth.getSession(),
    signOut: (options) => client.auth.signOut(options)
  }
}
