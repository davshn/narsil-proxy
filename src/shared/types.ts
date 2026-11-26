/** Types shared by the main process, the preload bridge and the renderer. */

export type EmailAction = 'reply' | 'archive' | 'delete' | 'save'

export interface EmailSummary {
  id: string
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

export interface Rule {
  id: string
  name: string
  enabled: boolean
  conditions: RuleConditions
  action: RuleAction
}

/** A rule as the user edits it; without `id` it is a new rule. */
export interface RuleInput {
  id?: string
  name: string
  enabled: boolean
  conditions: RuleConditions
  action: RuleAction
}

/** One action a rule took (or tried to take) on an email. */
export interface RuleActivity {
  id: string
  ruleName: string
  action: RuleAction
  from: string
  subject: string
  /** ISO 8601 timestamp. */
  at: string
  error?: string
}

export interface InboxItem {
  email: EmailSummary
  triage: Triage | null
  triageError?: string
}

export interface Meeting {
  id: string
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
  hasGoogleClient: boolean
  googleConnected: boolean
  hasAnthropicKey: boolean
  lastError?: string
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface NarsilApi {
  getStatus(): Promise<AppStatus>
  importGoogleClient(): Promise<ActionResult>
  connectGoogle(): Promise<ActionResult>
  disconnectGoogle(): Promise<ActionResult>
  setAnthropicKey(key: string): Promise<ActionResult>
  getInbox(): Promise<InboxItem[]>
  getMeetings(): Promise<Meeting[]>
  refresh(): Promise<ActionResult>
  applyAction(emailId: string, action: Exclude<EmailAction, 'reply'>): Promise<ActionResult>
  sendReply(emailId: string, body: string): Promise<ActionResult>
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
}

export const IPC = {
  getStatus: 'narsil:get-status',
  importGoogleClient: 'narsil:import-google-client',
  connectGoogle: 'narsil:connect-google',
  disconnectGoogle: 'narsil:disconnect-google',
  setAnthropicKey: 'narsil:set-anthropic-key',
  getInbox: 'narsil:get-inbox',
  getMeetings: 'narsil:get-meetings',
  refresh: 'narsil:refresh',
  applyAction: 'narsil:apply-action',
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
  statusChanged: 'narsil:status-changed'
} as const
