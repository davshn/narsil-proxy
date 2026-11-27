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
  /**
   * Runtime status, never stored: the account was connected before Narsil asked for the rule
   * or calendar write permissions, so it must sign in again ("Reconectar") before its rules
   * can be managed or meetings added to its calendar.
   */
  needsReconnect?: boolean
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
  /** An https link that opens this message in the provider's web mail, when known. */
  webLink?: string
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

/** What a rule in Gmail or Outlook does with matching mail. */
export type ServerRuleAction = 'archive' | 'delete' | 'move'

/** A rule to create on an account. `move` needs `folderId`; `folderName` is for display. */
export interface NewServerRule {
  name: string
  conditions: RuleConditions
  action: ServerRuleAction
  folderId?: string
  folderName?: string
  /** False for an Outlook rule turned off in Outlook; absent means on. Gmail filters are always on. */
  enabled?: boolean
}

/**
 * A Gmail filter or an Outlook inbox rule. When `managedByNarsil` is false Narsil could not map
 * it (it was made outside Narsil with other conditions or actions): it is read-only and can
 * only be deleted. Gmail filters have no name, so theirs is generated from the conditions.
 */
export interface ServerRule extends NewServerRule {
  id: string
  accountId: string
  managedByNarsil: boolean
}

/** A server rule as the user edits it; with `id` it replaces that rule (remove, then create). */
export interface ServerRuleInput extends NewServerRule {
  id?: string
  accountId: string
}

/** The server rules of one connected account. */
export interface AccountRules {
  accountId: string
  rules: ServerRule[]
  /** False until the first list of this account finished. */
  loaded: boolean
  /** The account lacks the rule permission and must be reconnected. */
  needsReconnect: boolean
  error?: string
}

/** Where "Pasar a una cuenta…" creates a local rule; a local save rule with a folder needs none. */
export interface ConvertTarget {
  accountId: string
  folderId?: string
  folderName?: string
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

/** A meeting to add to an account's primary calendar. Times are ISO 8601 instants. */
export interface NewMeeting {
  title: string
  start: string
  end: string
  location?: string
  /** Makes it a weekly series. Without it the meeting happens once. */
  repeat?: WeeklyRepeat
}

/** Days of the week in calendar (RFC 5545) codes, Monday first. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** A meeting that repeats every week on `days`, local time, until `until` inclusive. */
export interface WeeklyRepeat {
  days: Weekday[]
  /** Local date `YYYY-MM-DD` of the last day the series may fall on. */
  until: string
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

/** Signing in to shared lists. `email` is there while a session is active. */
export interface SharedStatus {
  configured: boolean
  projectUrl?: string
  email?: string
}

/** How far along a task is, in the order the user moves it. Only 'done' counts as finished. */
export const TASK_STATUSES = ['todo', 'started', 'in-progress', 'paused', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Someone the user shares a list with, or the owner of a list they were invited to. */
export interface SharedPerson {
  id: string
  email: string
  /** Empty until the person sets a name. */
  name: string
}

export interface SharedList {
  id: string
  name: string
  ownerId: string
  createdAt: string
  /** False while the list is only an invitation the user has not answered. */
  accepted: boolean
}

export interface SharedMember {
  listId: string
  email: string
  addedAt: string
  /** Null while the invitation waits. */
  acceptedAt: string | null
}

export interface SharedTask {
  id: string
  listId: string
  name: string
  description: string
  status: TaskStatus
  /** Null when nobody is assigned. */
  assigneeEmail: string | null
  /** Profile ids; `updatedBy` is null when that person's account is gone. */
  createdBy: string
  createdAt: string
  updatedBy: string | null
  updatedAt: string
}

/** Everything the signed-in user can read from the shared lists, as of `syncedAt`. */
export interface SharedSnapshot {
  userId: string
  email: string
  people: SharedPerson[]
  lists: SharedList[]
  members: SharedMember[]
  tasks: SharedTask[]
  syncedAt: string
}

/** A shared task to add (no `id`) or edit. A task never moves to another list. */
export interface SharedTaskInput {
  id?: string
  listId: string
  name: string
  /** May be empty. */
  description: string
  /** Null leaves it unassigned. */
  assigneeEmail: string | null
}

/** One change to the shared lists, as the screens and Claude ask for it. */
export type SharedAction =
  | { type: 'createList'; name: string }
  | { type: 'renameList'; listId: string; name: string }
  | { type: 'deleteList'; listId: string }
  | { type: 'invite'; listId: string; email: string }
  | { type: 'acceptInvitation'; listId: string }
  /** Also declines an invitation. */
  | { type: 'leave'; listId: string }
  | { type: 'removeMember'; listId: string; email: string }
  | { type: 'saveTask'; task: SharedTaskInput }
  | { type: 'setTaskStatus'; taskId: string; status: TaskStatus }
  | { type: 'deleteTask'; taskId: string }

/** The shared lists after a change, also when it failed. */
export interface SharedActionResult extends ActionResult {
  state: SharedState
}

/** The shared lists as Narsil last read them; `error` says why the latest sync failed. */
export interface SharedState {
  signedIn: boolean
  snapshot: SharedSnapshot | null
  error?: string
}

/** A to-do the user wrote down in "Pendientes". Stored locally; never sent anywhere. */
export interface PendingTask {
  id: string
  name: string
  /** May be empty. */
  description: string
  /** The project it belongs to; empty when it has none. */
  project: string
  status: TaskStatus
  /** ISO 8601 timestamp. */
  createdAt: string
}

/** A new task, or the edit of task `id`. Fields are trimmed; only the name is required. */
export interface PendingTaskInput {
  id?: string
  name: string
  description: string
  project: string
}

/** The shared-lists sign-in after the call, also when it failed. */
export interface SharedResult extends ActionResult {
  status: SharedStatus
}

/** Every task after the call, also when it failed, so the list always shows what is stored. */
export interface TasksResult extends ActionResult {
  tasks: PendingTask[]
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
  /**
   * Adds a meeting to the account's primary calendar, then reads that calendar again. The title
   * must not be blank and the end must come after the start.
   */
  createMeeting(accountId: string, input: NewMeeting): Promise<ActionResult>
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
  /** The cached server rules of every connected account. */
  getServerRules(): Promise<AccountRules[]>
  /** Lists every account's server rules again. */
  reloadServerRules(): Promise<ActionResult>
  /** Creates a rule on its account, or replaces the rule `id` (remove, then create). */
  saveServerRule(input: ServerRuleInput): Promise<ActionResult>
  deleteServerRule(accountId: string, ruleId: string): Promise<ActionResult>
  /** Creates the server rule that replaces a local rule, then deletes the local one. */
  convertLocalRule(ruleId: string, target?: ConvertTarget): Promise<ActionResult>
  /** Signs in again to the same account to grant the rule and calendar write permissions. */
  reconnectAccount(accountId: string): Promise<ActionResult>
  getTasks(): Promise<TasksResult>
  /** Adds a task, or edits task `input.id`. The name must not be blank. */
  saveTask(input: PendingTaskInput): Promise<TasksResult>
  setTaskStatus(id: string, status: TaskStatus): Promise<TasksResult>
  deleteTask(id: string): Promise<TasksResult>
  getSharedStatus(): Promise<SharedResult>
  /** Saves the Supabase project URL and its public key; a session from another project is dropped. */
  setSharedConfig(url: string, publishableKey: string): Promise<SharedResult>
  /** Opens the browser to sign in with Google and waits for it to come back. */
  sharedSignIn(): Promise<SharedResult>
  sharedSignOut(): Promise<SharedResult>
  /** The shared lists as last synced, from the local copy when offline. */
  getSharedState(): Promise<SharedState>
  /** Syncs now instead of waiting for the next poll. */
  refreshShared(): Promise<SharedState>
  onSharedChanged(listener: (state: SharedState) => void): () => void
  /** Writes one change with the signed-in session, then syncs. */
  sharedAction(action: SharedAction): Promise<SharedActionResult>
  onServerRulesChanged(listener: (rules: AccountRules[]) => void): () => void
  onRulesChanged(listener: (rules: Rule[]) => void): () => void
  /** Tasks changed outside the window, through the MCP bridge. */
  onTasksChanged(listener: (tasks: PendingTask[]) => void): () => void
  onRuleActivityChanged(listener: (activity: RuleActivity[]) => void): () => void
  onInboxChanged(listener: (items: InboxItem[]) => void): () => void
  onMeetingsChanged(listener: (meetings: Meeting[]) => void): () => void
  onReminder(listener: (alert: ReminderAlert) => void): () => void
  onStatusChanged(listener: (status: AppStatus) => void): () => void
  /** A new-mail notification was clicked: show that email, or just the mail list (null) for a group. */
  onFocusEmail(listener: (key: string | null) => void): () => void
  /** A shared-task notification was clicked: show the shared lists. */
  onFocusShared(listener: () => void): () => void
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
  createMeeting: 'narsil:create-meeting',
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
  getServerRules: 'narsil:get-server-rules',
  reloadServerRules: 'narsil:reload-server-rules',
  saveServerRule: 'narsil:save-server-rule',
  deleteServerRule: 'narsil:delete-server-rule',
  convertLocalRule: 'narsil:convert-local-rule',
  reconnectAccount: 'narsil:reconnect-account',
  getTasks: 'narsil:get-tasks',
  saveTask: 'narsil:save-task',
  setTaskStatus: 'narsil:set-task-status',
  deleteTask: 'narsil:delete-task',
  getSharedStatus: 'narsil:get-shared-status',
  setSharedConfig: 'narsil:set-shared-config',
  sharedSignIn: 'narsil:shared-sign-in',
  sharedSignOut: 'narsil:shared-sign-out',
  getSharedState: 'narsil:get-shared-state',
  refreshShared: 'narsil:refresh-shared',
  sharedChanged: 'narsil:shared-changed',
  sharedAction: 'narsil:shared-action',
  serverRulesChanged: 'narsil:server-rules-changed',
  rulesChanged: 'narsil:rules-changed',
  tasksChanged: 'narsil:tasks-changed',
  ruleActivityChanged: 'narsil:rule-activity-changed',
  inboxChanged: 'narsil:inbox-changed',
  meetingsChanged: 'narsil:meetings-changed',
  reminder: 'narsil:reminder',
  statusChanged: 'narsil:status-changed',
  focusEmail: 'narsil:focus-email',
  focusShared: 'narsil:focus-shared'
} as const
