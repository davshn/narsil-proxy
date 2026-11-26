import type { AccountSettings, MailFolder, Meeting, ProviderKind } from '@shared/types'
import type { ParsedEmail } from '../domain/email'

/**
 * Ports between the application core (NarsilService) and each email provider.
 * Google and Microsoft each implement ProviderAuth; the core never imports a provider's SDK.
 */

/** Mail operations for one connected account. Message ids are the provider's own ids. */
export interface MailProvider {
  /**
   * Ids of unread inbox messages from the last `settings.windowDays` days, newest first, at most 20.
   * Without `settings.includeCategories` it skips Gmail's Promotions and Social tabs and
   * Outlook's "Other" tab of Focused Inbox.
   */
  listUnread(settings: AccountSettings): Promise<string[]>
  /**
   * A cheap opaque token that changes whenever the inbox may have new mail
   * (Gmail: the mailbox historyId; Outlook: inbox counts plus the newest message id).
   * Equal tokens mean listUnread() would return nothing new.
   */
  changeToken(): Promise<string>
  /** The message with `summary.accountId` set to this account's id. */
  getMessage(id: string): Promise<ParsedEmail>
  /** Removes from the inbox and marks read. The message stays recoverable. */
  archive(id: string): Promise<void>
  /** Moves to the provider's trash / Deleted Items. Never deletes permanently. */
  trash(id: string): Promise<void>
  /**
   * Folders the user can move mail to (Gmail: user labels; Outlook: mail folders without the
   * well-known ones, children as `Parent/Child`), sorted by name.
   */
  listFolders(): Promise<MailFolder[]>
  /** Creates a folder (Gmail: a visible label) with an already validated name. */
  createFolder(name: string): Promise<MailFolder>
  /** Moves out of the inbox into the folder and marks read (Gmail: adds the label). */
  moveToFolder(id: string, folderId: string): Promise<void>
  /** Sends `body` as a reply in the same thread from this account, then marks the message read. */
  reply(email: ParsedEmail, body: string): Promise<void>
}

export interface CalendarProvider {
  /**
   * Timed meetings from now to 24 hours ahead, skipping all-day, cancelled and declined events.
   * Each Meeting has `accountId` set and `id` = `${accountId}:${providerEventId}`.
   */
  upcoming(now?: Date): Promise<Meeting[]>
}

export interface AccountConnection {
  mail: MailProvider
  calendar: CalendarProvider
}

export interface AddedAccount {
  /** New opaque id (randomUUID) the provider uses to find this account's credentials later. */
  accountId: string
  email: string
}

export interface ProviderAuth {
  readonly kind: ProviderKind
  /** True when the app registration (Google client file / Microsoft client id) is configured. */
  isConfigured(): boolean
  /** Interactive browser sign-in for a new account. Rejects if the user cancels or it times out. */
  addAccount(): Promise<AddedAccount>
  /** Revokes or forgets the account's credentials. Never throws for an unknown id. */
  removeAccount(accountId: string): Promise<void>
  /** Mail and calendar for a stored account, or null when its credentials are missing. */
  connect(accountId: string): AccountConnection | null
}
