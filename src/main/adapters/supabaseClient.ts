import { createClient } from '@supabase/supabase-js'
import type { AuthClient, SessionStorage, SharedConfig } from '../app/sharedAuth'

/**
 * Supabase's client for the main process: PKCE, the session kept in Narsil's encrypted
 * storage, and no URL detection, which only applies inside a browser page.
 */
export function makeSupabaseAuth(config: SharedConfig, storage: SessionStorage): AuthClient {
  const client = createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  })
  return {
    signInWithOAuth: (credentials) => client.auth.signInWithOAuth(credentials),
    exchangeCodeForSession: (code, options) => client.auth.exchangeCodeForSession(code, options),
    getSession: () => client.auth.getSession(),
    signOut: (options) => client.auth.signOut(options),
    stopAutoRefresh: () => client.auth.stopAutoRefresh(),
    // PostgREST answers at most the project's "max rows" (1000 by default) per request.
    select: async (table, columns) => {
      const { data, error } = await client.from(table).select(columns)
      return { data: data as unknown[] | null, error }
    },
    write: async (write) => {
      // No generated database types: the row shapes are checked by SharedLists and by the database.
      const rows = client.from(write.table)
      const { error, count } =
        write.kind === 'insert'
          ? await rows.insert(write.values as never, { count: 'exact' })
          : write.kind === 'update'
            ? await rows.update(write.values as never, { count: 'exact' }).match(write.match)
            : await rows.delete({ count: 'exact' }).match(write.match)
      return { error, count }
    }
  }
}
