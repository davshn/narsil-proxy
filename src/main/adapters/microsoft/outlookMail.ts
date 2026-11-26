import type { AccountSettings, MailFolder } from '@shared/types'
import type { MailProvider } from '../../app/ports'
import type { ParsedEmail } from '../../domain/email'
import { parseGraphMessage, type GraphMessageLike } from '../../domain/graph'
import { pathSegment, type GraphClient } from './graphClient'

const MAX_MESSAGES = 20
const MAX_FOLDERS = '100'
const DAY_MS = 24 * 60 * 60_000
const MESSAGE_FIELDS = 'id,conversationId,subject,from,replyTo,bodyPreview,body,receivedDateTime,internetMessageId'
const FOLDER_FIELDS = 'id,displayName,childFolderCount'

/** Graph's well-known folder names that are never offered as a place to save mail. */
const HIDDEN_WELL_KNOWN = ['inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'outbox', 'conversationhistory']

/** The `$filter` of unread inbox mail for the settings; "Other" of Focused Inbox only when included. */
export function unreadFilter(settings: AccountSettings, now: number = Date.now()): string {
  const since = new Date(now - settings.windowDays * DAY_MS).toISOString()
  const filter = `isRead eq false and receivedDateTime ge ${since}`
  return settings.includeCategories ? filter : `${filter} and inferenceClassification eq 'focused'`
}

/** Plain text as HTML: escapes markup characters and turns line breaks into `<br>`. */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br>')
}

interface MessageList {
  value?: Array<{ id?: string | null; receivedDateTime?: string | null }>
}

interface InboxFolder {
  unreadItemCount?: number | null
  totalItemCount?: number | null
}

interface GraphFolder {
  id?: string | null
  displayName?: string | null
  childFolderCount?: number | null
}

interface FolderList {
  value?: GraphFolder[]
}

/** Outlook mail for one account through Microsoft Graph. */
export class OutlookMail implements MailProvider {
  /** Well-known folder ids by name; they never change for a mailbox. */
  private wellKnown: Promise<Map<string, string>> | null = null

  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string
  ) {}

  async listUnread(settings: AccountSettings): Promise<string[]> {
    // Graph rejects $orderby combined with this $filter as an inefficient filter: sort locally.
    const res = await this.graph.request<MessageList>('GET', '/me/mailFolders/inbox/messages', {
      query: {
        $filter: unreadFilter(settings),
        $select: 'id,receivedDateTime',
        $top: String(MAX_MESSAGES)
      }
    })
    return (res?.value ?? [])
      .flatMap((m) => (m.id ? [{ id: m.id, at: Date.parse(m.receivedDateTime ?? '') || 0 }] : []))
      .sort((a, b) => b.at - a.at)
      .map((m) => m.id)
  }

  /** `${unreadItemCount}:${totalItemCount}:${newestId}` of the inbox; any new message changes it. */
  async changeToken(): Promise<string> {
    const [folder, newest] = await Promise.all([
      this.graph.request<InboxFolder>('GET', '/me/mailFolders/inbox', {
        query: { $select: 'unreadItemCount,totalItemCount' }
      }),
      // Without $orderby Graph returns the newest message first.
      this.graph.request<MessageList>('GET', '/me/mailFolders/inbox/messages', {
        query: { $top: '1', $select: 'id' }
      })
    ])
    return `${folder?.unreadItemCount ?? ''}:${folder?.totalItemCount ?? ''}:${newest?.value?.[0]?.id ?? ''}`
  }

  async getMessage(id: string): Promise<ParsedEmail> {
    const message = await this.graph.request<GraphMessageLike>('GET', `/me/messages/${pathSegment(id)}`, {
      query: { $select: MESSAGE_FIELDS },
      headers: { Prefer: 'outlook.body-content-type="text"' }
    })
    return parseGraphMessage(message ?? {}, this.accountId)
  }

  /** Marks read, then moves to the Archive folder. Marking first: a move gives the message a new id. */
  async archive(id: string): Promise<void> {
    await this.markRead(id)
    await this.move(id, 'archive')
  }

  /** Moves to Deleted Items, where Outlook keeps it recoverable. Never sends DELETE. */
  async trash(id: string): Promise<void> {
    await this.move(id, 'deleteditems')
  }

  /**
   * Top-level folders and their direct children (as `Parent/Child`), sorted by name. The
   * well-known system folders are left out, but the Inbox's own subfolders are kept.
   */
  async listFolders(): Promise<MailFolder[]> {
    const [wellKnown, top] = await Promise.all([
      this.wellKnownIds(),
      this.graph.request<FolderList>('GET', '/me/mailFolders', { query: { $top: MAX_FOLDERS, $select: FOLDER_FIELDS } })
    ])
    const hidden = new Set(wellKnown.values())
    const inboxId = wellKnown.get('inbox')
    const parents = (top?.value ?? []).flatMap((f) => (f.id ? [{ ...f, id: f.id, name: f.displayName ?? '' }] : []))
    const children = await Promise.all(
      parents
        .filter((parent) => (!hidden.has(parent.id) || parent.id === inboxId) && (parent.childFolderCount ?? 0) > 0)
        .map(async (parent) => {
          const res = await this.graph.request<FolderList>('GET', `/me/mailFolders/${pathSegment(parent.id)}/childFolders`, {
            query: { $top: MAX_FOLDERS, $select: FOLDER_FIELDS }
          })
          return (res?.value ?? []).flatMap((child) =>
            child.id ? [{ id: child.id, name: `${parent.name}/${child.displayName ?? ''}` }] : []
          )
        })
    )
    return [
      ...parents.filter((parent) => !hidden.has(parent.id)).map(({ id, name }) => ({ id, name })),
      ...children.flat()
    ].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Ids of the well-known folders by name. A mailbox may lack one (e.g. Conversation History),
   * so a failed lookup is skipped; the result is kept only once the Inbox resolved.
   */
  private wellKnownIds(): Promise<Map<string, string>> {
    if (this.wellKnown) return this.wellKnown
    const lookup = Promise.all(
      HIDDEN_WELL_KNOWN.map(async (name): Promise<[string, string] | null> => {
        try {
          const folder = await this.graph.request<GraphFolder>('GET', `/me/mailFolders/${name}`, { query: { $select: 'id' } })
          return folder?.id ? [name, folder.id] : null
        } catch {
          return null
        }
      })
    ).then((entries) => new Map(entries.filter((entry): entry is [string, string] => entry !== null)))
    this.wellKnown = lookup
    void lookup.then((ids) => {
      if (!ids.has('inbox') && this.wellKnown === lookup) this.wellKnown = null
    })
    return lookup
  }

  async createFolder(name: string): Promise<MailFolder> {
    const created = await this.graph.request<GraphFolder>('POST', '/me/mailFolders', { body: { displayName: name } })
    if (!created?.id) throw new Error('Microsoft no devolvió la carpeta creada.')
    return { id: created.id, name: created.displayName ?? name }
  }

  /** Marks read, then moves. Marking first: a move gives the message a new id. */
  async moveToFolder(id: string, folderId: string): Promise<void> {
    await this.markRead(id)
    await this.move(id, folderId)
  }

  /**
   * Graph's reply keeps the conversation, recipients and subject of the original message.
   * Graph reads `comment` as HTML, so the plain text is escaped and its line breaks kept.
   */
  async reply(email: ParsedEmail, body: string): Promise<void> {
    await this.graph.request('POST', `/me/messages/${pathSegment(email.summary.id)}/reply`, {
      body: { comment: textToHtml(body) }
    })
    await this.markRead(email.summary.id)
  }

  private async markRead(id: string): Promise<void> {
    await this.graph.request('PATCH', `/me/messages/${pathSegment(id)}`, { body: { isRead: true } })
  }

  private async move(id: string, destinationId: string): Promise<void> {
    await this.graph.request('POST', `/me/messages/${pathSegment(id)}/move`, { body: { destinationId } })
  }
}
