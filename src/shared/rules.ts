import type { Rule, RuleConditions, RuleFolder, RuleInput } from './types'

/** Pure rule and folder logic shared by the main process (matching) and the renderer (drafts). */

export interface RuleTarget {
  from: string
  subject: string
  body: string
  /** The account that received the email; a save rule only acts on its folder's account. */
  accountId?: string
}

export const MAX_FOLDER_NAME = 100

/** Trims a new folder name and checks its length. `/` stays: Gmail nests labels with it. */
export function normalizeFolderName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_FOLDER_NAME) {
    throw new Error(`El nombre de la carpeta debe tener entre 1 y ${MAX_FOLDER_NAME} caracteres.`)
  }
  return trimmed
}

const FIELD_LABEL: Record<keyof RuleConditions, string> = {
  from: 'Remitente',
  subject: 'Asunto',
  body: 'Texto'
}

export function emailAddress(mailbox: string): string {
  return (/<([^>]+)>/.exec(mailbox)?.[1] ?? mailbox).trim().toLowerCase()
}

function hasConditions(conditions: RuleConditions): boolean {
  return Object.values(conditions).some((value) => value.trim() !== '')
}

export function matchesRule(rule: Rule, target: RuleTarget): boolean {
  if (!rule.enabled || !hasConditions(rule.conditions)) return false
  // A folder id only exists in its own mailbox.
  if (rule.action === 'save' && rule.folder && target.accountId !== undefined && target.accountId !== rule.folder.accountId) {
    return false
  }
  return (Object.keys(FIELD_LABEL) as Array<keyof RuleConditions>).every((field) => {
    const needle = rule.conditions[field].trim().toLowerCase()
    return needle === '' || target[field].toLowerCase().includes(needle)
  })
}

/** The first enabled rule, in list order, whose conditions all match. */
export function findMatchingRule(rules: readonly Rule[], target: RuleTarget): Rule | null {
  return rules.find((rule) => matchesRule(rule, target)) ?? null
}

export function describeConditions(conditions: RuleConditions): string {
  return (Object.keys(FIELD_LABEL) as Array<keyof RuleConditions>)
    .filter((field) => conditions[field].trim() !== '')
    .map((field) => `${FIELD_LABEL[field]} contiene "${conditions[field].trim()}"`)
    .join(' y ')
}

/** What a rule does, in lower case, for the rule list. */
export function describeRuleAction(rule: Pick<Rule, 'action' | 'folder'>): string {
  if (rule.action === 'delete') return 'mover a la papelera'
  if (rule.action === 'archive') return 'archivar'
  return rule.folder ? `mover a la carpeta "${rule.folder.name}"` : 'archivar (regla anterior sin carpeta)'
}

/**
 * Trims the input and rejects a rule with no conditions, which would match every email.
 * A save rule needs a folder, unless `keepLegacySave` keeps an old save rule that never had
 * one (it archives); any other action drops the folder.
 */
export function normalizeRule(input: RuleInput, id: string, keepLegacySave = false): Rule {
  const conditions: RuleConditions = {
    from: input.conditions.from.trim(),
    subject: input.conditions.subject.trim(),
    body: input.conditions.body.trim()
  }
  if (!hasConditions(conditions)) throw new Error('Agrega al menos una condición.')
  let folder: RuleFolder | undefined
  if (input.action === 'save' && input.folder?.id && input.folder.accountId) {
    folder = { accountId: input.folder.accountId, id: input.folder.id, name: input.folder.name.trim() }
  } else if (input.action === 'save' && !keepLegacySave) {
    throw new Error('Elige la carpeta donde se guardan estos correos.')
  }
  return {
    id,
    name: input.name.trim() || describeConditions(conditions),
    enabled: input.enabled,
    action: input.action,
    conditions,
    ...(folder ? { folder } : {})
  }
}

/** A starting point for a rule about one sender, used by "Crear regla" on an email. */
export function ruleDraftFromEmail(from: string): RuleInput {
  const address = emailAddress(from)
  return {
    name: `Correos de ${address}`,
    enabled: true,
    action: 'archive',
    conditions: { from: address, subject: '', body: '' }
  }
}
