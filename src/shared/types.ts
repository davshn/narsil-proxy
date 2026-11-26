/** Types shared by the main process, the preload bridge and the renderer. */

export type EmailAction = 'reply' | 'archive' | 'delete' | 'save'

export type ProviderKind = 'google' | 'microsoft'

/** How many days back Narsil looks for unread mail. */
export type InboxWindowDays = 2 | 7 | 30

export const INBOX_WINDOW_DAYS: readonly InboxWindowDays[] = [2, 7, 30]

/** Which unread mail Narsil reviews for one account. */
export interface AccountSettings {
  /**
   * Gmail: also review the Promotions and Social tabs.
   * Outlook: also review the "Other" tab of Focused Inbox.
   */
  includeCategories: boolean
  windowDays: InboxWindowDays
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = { includeCategories: false, windowDays: 2 }

/** A connected mailbox. `id` is an opaque randomUUID assigned when the account is added. */
export interface Account {
  id: string
  provider: ProviderKind
  email: string
  settings: AccountSettings
}

/** A Gmail user label or an Outlook mail folder. `name` shows nesting as `Parent/Child`. */
export interface MailFolder {
  id: string
  name: string
}

/** Where a local save rule moves mail: a folder of one account. */
export interface RuleFolder {
  accountId: string
  id: string
  name: string
}

export interface EmailSummary {
  /** The provider's message id; unique only within its account. */
  id: string
  accountId: string
  threadId: string
  from: string
  /** Where a reply goes: the Reply-To header when present, otherwise From. */
  replyTo: string
  subject: string
  snippet: string
  /** ISO 8601 timestamp. */
  receivedAt: string
}

export interface ReplyOption {
  label: string
  body: string
}

export interface Triage {
  summary: string
  recommendedAction: EmailAction
  reason: string
  replies: ReplyOption[]
}

export type RuleAction = Exclude<EmailAction, 'reply'>

/** Case-insensitive "contains" checks; an empty string means no condition on that field. */
export interface RuleConditions {
  from: string
  subject: string
  body: string
}

/**
 * A local rule. `save` means "move to `folder`", and then the rule only acts on mail of the
 * folder's account. A `save` rule stored before folders existed has no folder and archives.
 */
export interface Rule {
  id: string
  name: string
  enabled: boolean
  conditions: RuleConditions
  action: RuleAction
  folder?: RuleFolder
}

/** A rule as the user edits it; without `id` it is a new rule. A `save` rule needs `folder`. */
export interface RuleInput {
  id?: string
  name: string
  enabled: boolean
  conditions: RuleConditions
  action: RuleAction
  folder?: RuleFolder
}

/** One action a rule took (or tried to take) on an email. */
export interface RuleActivity {
  id: string
  ruleName: string
  /** The action actually taken: an old `save` rule without a folder records `archive`. */
  action: RuleAction
  /** The destination folder of a `save` action. */
  folderName?: string
  from: string
  subject: string
  /** ISO 8601 timestamp. */
  at: string
  error?: string
}

export interface InboxItem {
  /** Unique across accounts: `${accountId}:${email.id}`. IPC actions address emails by this key. */
  key: string
  email: EmailSummary
  triage: Triage | null
  triageError?: string
}

export interface Meeting {
  /** Unique across accounts: `${accountId}:${providerEventId}`. */
  id: string
  accountId: string
  title: string
  /** ISO 8601 timestamp. */
  start: string
  /** ISO 8601 timestamp. */
  end: string
  location?: string
  link?: string
}

export interface ReminderAlert {
  key: string
  meeting: Meeting
  /** The configured threshold that fired: 15 or 5. */
  thresholdMinutes: number
  /** Whole minutes left until the meeting starts when the alert fired. */
  minutesUntil: number
}

export interface AppStatus {
  accounts: Account[]
  hasGoogleClient: boolean
  hasMicrosoftClient: boolean
  hasAnthropicKey: boolean
  lastError?: string
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface FoldersResult extends ActionResult {
  folders?: MailFolder[]
}

export interface FolderResult extends ActionResult {
  folder?: MailFolder
}

export interface NarsilApi {
  getStatus(): Promise<AppStatus>
  importGoogleClient(): Promise<ActionResult>
  setMicrosoftClientId(clientId: string): Promise<ActionResult>
  addAccount(provider: ProviderKind): Promise<ActionResult>
  removeAccount(accountId: string): Promise<ActionResult>
  setAnthropicKey(key: string): Promise<ActionResult>
  getInbox(): Promise<InboxItem[]>
  getMeetings(): Promise<Meeting[]>
  refresh(): Promise<ActionResult>
  /** `save` moves the email to `folderId`, which it requires. */
  applyAction(key: string, action: Exclude<EmailAction, 'reply'>, folderId?: string): Promise<ActionResult>
  listFolders(accountId: string): Promise<FoldersResult>
  /** The name is trimmed and must be 1-100 characters; `/` nests Gmail labels. */
  createFolder(accountId: string, name: string): Promise<FolderResult>
  /** Saves the account's inbox settings, then reviews that account's inbox again with them. */
  setAccountSettings(accountId: string, settings: AccountSettings): Promise<ActionResult>
  sendReply(key: string, body: string): Promise<ActionResult>
  setExpanded(expanded: boolean): Promise<void>
  getRules(): Promise<Rule[]>
  saveRule(input: RuleInput): Promise<ActionResult>
  deleteRule(id: string): Promise<ActionResult>
  getRuleActivity(): Promise<RuleActivity[]>
  onRulesChanged(listener: (rules: Rule[]) => void): () => void
  onRuleActivityChanged(listener: (activity: RuleActivity[]) => void): () => void
  onInboxChanged(listener: (items: InboxItem[]) => void): () => void
  onMeetingsChanged(listener: (meetings: Meeting[]) => void): () => void
  onReminder(listener: (alert: ReminderAlert) => void): () => void
  onStatusChanged(listener: (status: AppStatus) => void): () => void
  /** A new-mail notification was clicked: show that email, or just the mail list (null) for a group. */
  onFocusEmail(listener: (key: string | null) => void): () => void
}

export const IPC = {
  getStatus: 'narsil:get-status',
  importGoogleClient: 'narsil:import-google-client',
  setMicrosoftClientId: 'narsil:set-microsoft-client-id',
  addAccount: 'narsil:add-account',
  removeAccount: 'narsil:remove-account',
  setAnthropicKey: 'narsil:set-anthropic-key',
  getInbox: 'narsil:get-inbox',
  getMeetings: 'narsil:get-meetings',
  refresh: 'narsil:refresh',
  applyAction: 'narsil:apply-action',
  listFolders: 'narsil:list-folders',
  createFolder: 'narsil:create-folder',
  setAccountSettings: 'narsil:set-account-settings',
  sendReply: 'narsil:send-reply',
  setExpanded: 'narsil:set-expanded',
  getRules: 'narsil:get-rules',
  saveRule: 'narsil:save-rule',
  deleteRule: 'narsil:delete-rule',
  getRuleActivity: 'narsil:get-rule-activity',
  rulesChanged: 'narsil:rules-changed',
  ruleActivityChanged: 'narsil:rule-activity-changed',
  inboxChanged: 'narsil:inbox-changed',
  meetingsChanged: 'narsil:meetings-changed',
  reminder: 'narsil:reminder',
  statusChanged: 'narsil:status-changed',
  focusEmail: 'narsil:focus-email'
} as const
