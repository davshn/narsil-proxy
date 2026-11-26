import type { NewServerRule, RuleConditions, ServerRule, ServerRuleAction } from '@shared/types'
import { describeConditions } from '@shared/rules'
import { ReconnectRequiredError, type RuleProvider } from '../../app/ports'
import { GraphError, pathSegment, type GraphClient } from './graphClient'

const RULES_PATH = '/me/mailFolders/inbox/messageRules'

/** The three Outlook predicates Narsil writes, by the condition they hold. */
const PREDICATE: Record<keyof RuleConditions, string> = {
  from: 'senderContains',
  subject: 'subjectContains',
  body: 'bodyContains'
}
/** Actions that may come with Narsil's own; any other action makes a rule read-only. */
const NEUTRAL_ACTIONS = new Set(['moveToFolder', 'delete', 'stopProcessingRules'])

interface GraphRule {
  id?: string | null
  displayName?: string | null
  sequence?: number | null
  isEnabled?: boolean | null
  conditions?: Record<string, unknown> | null
  exceptions?: Record<string, unknown> | null
  actions?: Record<string, unknown> | null
}

interface RuleList {
  value?: GraphRule[]
}

/** True for a value Graph actually set: not null, false, an empty list or an empty object. */
function isSet(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.values(value as object).some(isSet)
  return true
}

/** The messageRule body for a rule. `archiveId` is the Archive folder's id, needed for archive. */
export function messageRuleBody(rule: NewServerRule, sequence: number, archiveId?: string): Record<string, unknown> {
  const conditions: Record<string, string[]> = {}
  for (const field of Object.keys(PREDICATE) as Array<keyof RuleConditions>) {
    if (rule.conditions[field]) conditions[PREDICATE[field]] = [rule.conditions[field]]
  }
  const target =
    rule.action === 'delete' ? { delete: true } : { moveToFolder: rule.action === 'archive' ? archiveId : rule.folderId }
  // stopProcessingRules is one of the rule's actions (messageRuleActions); Graph rejects it on the rule.
  const actions = { ...target, stopProcessingRules: false }
  return { displayName: rule.name, sequence, isEnabled: rule.enabled !== false, conditions, actions }
}

/** The rule an Outlook messageRule is, or a read-only best guess for one Narsil never writes. */
export function messageRuleToServerRule(
  raw: GraphRule,
  accountId: string,
  archiveId: string | undefined,
  folderNames: Map<string, string>
): ServerRule | null {
  if (!raw.id) return null
  const given = raw.conditions ?? {}
  let foreign = isSet(raw.exceptions)
  const conditions: RuleConditions = { from: '', subject: '', body: '' }
  for (const field of Object.keys(PREDICATE) as Array<keyof RuleConditions>) {
    const values = given[PREDICATE[field]]
    if (!isSet(values)) continue
    const list = Array.isArray(values) ? values.map(String) : [String(values)]
    // Several values mean "any of them", which Narsil's single condition cannot say.
    if (list.length > 1) foreign = true
    conditions[field] = list.join(', ')
  }
  const known = new Set(Object.values(PREDICATE))
  if (Object.entries(given).some(([key, value]) => !known.has(key) && isSet(value))) foreign = true
  const actions = raw.actions ?? {}
  if (Object.entries(actions).some(([key, value]) => !NEUTRAL_ACTIONS.has(key) && isSet(value))) foreign = true
  const moveTo = typeof actions.moveToFolder === 'string' && actions.moveToFolder ? actions.moveToFolder : undefined
  const deletes = actions.delete === true
  let action: ServerRuleAction
  if (moveTo && !deletes) action = moveTo === archiveId ? 'archive' : 'move'
  else if (deletes && !moveTo) action = 'delete'
  else {
    foreign = true
    action = deletes ? 'delete' : 'archive'
  }
  const hasCondition = Object.values(conditions).some((v) => v !== '')
  return {
    id: raw.id,
    accountId,
    name: raw.displayName?.trim() || describeConditions(conditions) || 'Regla de Outlook',
    conditions,
    action,
    ...(action === 'move' && moveTo ? { folderId: moveTo, folderName: folderNames.get(moveTo) ?? '' } : {}),
    ...(raw.isEnabled === false ? { enabled: false } : {}),
    managedByNarsil: !foreign && hasCondition
  }
}

/** Outlook inbox rules of one account through Microsoft Graph. */
export class OutlookRules implements RuleProvider {
  /** The Archive folder's id; it never changes for a mailbox. */
  private archiveId: Promise<string> | null = null

  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string
  ) {}

  async list(): Promise<ServerRule[]> {
    return this.call(async () => {
      const rules = await this.rawRules()
      const archiveId = await this.archiveFolderId().catch(() => undefined)
      const folderIds = new Set(
        rules.flatMap((r) => {
          const id = r.actions?.moveToFolder
          return typeof id === 'string' && id && id !== archiveId ? [id] : []
        })
      )
      const names = new Map(
        await Promise.all([...folderIds].map(async (id): Promise<[string, string]> => [id, await this.folderName(id)]))
      )
      return rules.flatMap((r) => messageRuleToServerRule(r, this.accountId, archiveId, names) ?? [])
    })
  }

  async create(rule: NewServerRule): Promise<ServerRule> {
    return this.call(async () => {
      const existing = await this.rawRules()
      const sequence = Math.max(0, ...existing.map((r) => r.sequence ?? 0)) + 1
      const archiveId = rule.action === 'archive' ? await this.archiveFolderId() : undefined
      const created = await this.graph.request<GraphRule>('POST', RULES_PATH, { body: messageRuleBody(rule, sequence, archiveId) })
      if (!created?.id) throw new Error('Microsoft no devolvió la regla creada.')
      return {
        id: created.id,
        accountId: this.accountId,
        name: rule.name,
        conditions: rule.conditions,
        action: rule.action,
        ...(rule.action === 'move' ? { folderId: rule.folderId ?? '', folderName: rule.folderName ?? '' } : {}),
        ...(rule.enabled === false ? { enabled: false } : {}),
        managedByNarsil: true
      }
    })
  }

  async remove(ruleId: string): Promise<void> {
    await this.call(() => this.graph.request('DELETE', `${RULES_PATH}/${pathSegment(ruleId)}`))
  }

  private async rawRules(): Promise<GraphRule[]> {
    const res = await this.graph.request<RuleList>('GET', RULES_PATH)
    return res?.value ?? []
  }

  private archiveFolderId(): Promise<string> {
    this.archiveId ??= this.graph
      .request<{ id?: string | null }>('GET', '/me/mailFolders/archive', { query: { $select: 'id' } })
      .then((folder) => {
        if (!folder?.id) throw new Error('No se encontró la carpeta Archivo de esta cuenta.')
        return folder.id
      })
    // A failed lookup is retried next time instead of being remembered.
    this.archiveId.catch(() => (this.archiveId = null))
    return this.archiveId
  }

  private async folderName(id: string): Promise<string> {
    try {
      const folder = await this.graph.request<{ displayName?: string | null }>('GET', `/me/mailFolders/${pathSegment(id)}`, {
        query: { $select: 'displayName' }
      })
      return folder?.displayName ?? ''
    } catch {
      return ''
    }
  }

  /** Graph answers 403 ErrorAccessDenied to a token without MailboxSettings.ReadWrite. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request()
    } catch (error) {
      if (error instanceof GraphError && error.status === 403 && error.code === 'ErrorAccessDenied') {
        throw new ReconnectRequiredError()
      }
      throw error
    }
  }
}
