import { useEffect, useState } from 'react'
import type { Account, Rule, RuleAction, RuleActivity, RuleInput } from '@shared/types'
import { describeConditions, describeRuleAction } from '@shared/rules'
import { FolderPicker } from './FolderPicker'

const ACTION_LABEL: Record<RuleAction, string> = {
  save: 'Mover a carpeta',
  archive: 'Archivar',
  delete: 'Eliminar (a la papelera)'
}

function done(entry: RuleActivity): string {
  if (entry.action === 'archive') return 'archivó'
  if (entry.action === 'delete') return 'movió a la papelera'
  return entry.folderName ? `movió a "${entry.folderName}"` : 'movió a una carpeta'
}

function failed(entry: RuleActivity): string {
  if (entry.action === 'archive') return 'no pudo archivar'
  if (entry.action === 'delete') return 'no pudo mover a la papelera'
  return entry.folderName ? `no pudo mover a "${entry.folderName}"` : 'no pudo mover a una carpeta'
}

const EMPTY: RuleInput = {
  name: '',
  enabled: true,
  action: 'archive',
  conditions: { from: '', subject: '', body: '' }
}

interface RulesProps {
  rules: Rule[]
  activity: RuleActivity[]
  /** Connected accounts; a "Mover a carpeta" rule uses a folder of one of them. */
  accounts: Account[]
  /** A draft handed over from an email card; opens the form prefilled. */
  incomingDraft: RuleInput | null
  onDraftTaken(): void
}

export function Rules({ rules, activity, accounts, incomingDraft, onDraftTaken }: RulesProps): React.JSX.Element {
  const [draft, setDraft] = useState<RuleInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (incomingDraft) {
      setDraft(incomingDraft)
      setError(null)
      onDraftTaken()
    }
  }, [incomingDraft, onDraftTaken])

  async function save(input: RuleInput): Promise<boolean> {
    setBusy(true)
    setError(null)
    // An account was chosen but no folder yet: leave it out so the main process explains what is missing.
    const { folder, ...withoutFolder } = input
    const result = await window.narsil.saveRule(folder?.id ? input : withoutFolder)
    setBusy(false)
    if (!result.ok) setError(result.error ?? 'No se pudo guardar la regla.')
    return result.ok
  }

  const setCondition = (field: keyof RuleInput['conditions'], value: string): void =>
    setDraft((d) => (d ? { ...d, conditions: { ...d.conditions, [field]: value } } : d))

  const accountEmail = (accountId: string): string | undefined => accounts.find((a) => a.id === accountId)?.email
  /** The account whose folders the form lists: the chosen folder's, or the first account. */
  const folderAccountId = draft?.folder?.accountId ?? accounts[0]?.id

  return (
    <section className="rules" aria-label="Reglas">
      {draft ? (
        <form
          className="rule-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save(draft).then((ok) => ok && setDraft(null))
          }}
        >
          <h3>{draft.id ? 'Editar regla' : 'Nueva regla'}</h3>
          <p className="rule-form__hint">
            Se aplica a los correos nuevos y a los que ya están en la lista. Deben cumplirse todas las condiciones que llenes.
          </p>
          <label>
            Nombre
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Opcional" />
          </label>
          <label>
            Remitente contiene
            <input value={draft.conditions.from} onChange={(e) => setCondition('from', e.target.value)} placeholder="tienda.com" />
          </label>
          <label>
            Asunto contiene
            <input value={draft.conditions.subject} onChange={(e) => setCondition('subject', e.target.value)} placeholder="oferta" />
          </label>
          <label>
            Texto contiene
            <input value={draft.conditions.body} onChange={(e) => setCondition('body', e.target.value)} placeholder="darse de baja" />
          </label>
          <label>
            Acción
            <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as RuleAction })}>
              {(Object.keys(ACTION_LABEL) as RuleAction[]).map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </label>
          {draft.action === 'save' &&
            (folderAccountId === undefined ? (
              <p className="rule-form__hint">Conecta una cuenta para elegir una carpeta.</p>
            ) : (
              <>
                {accounts.length > 1 && (
                  <label>
                    Cuenta
                    <select
                      value={folderAccountId}
                      // Folders belong to one mailbox: choose again in the new account.
                      onChange={(e) => setDraft({ ...draft, folder: { accountId: e.target.value, id: '', name: '' } })}
                    >
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.email}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="rule-form__folder">
                  <span>
                    Carpeta{draft.folder?.id ? `: ${draft.folder.name}` : ''}
                  </span>
                  <FolderPicker
                    accountId={folderAccountId}
                    selectedId={draft.folder?.id}
                    busy={busy}
                    onPick={(folder) =>
                      setDraft({ ...draft, folder: { accountId: folderAccountId, id: folder.id, name: folder.name } })
                    }
                  />
                </div>
                <p className="rule-form__hint">
                  Solo actúa sobre los correos de {accountEmail(folderAccountId) ?? 'esa cuenta'}.
                </p>
              </>
            ))}
          {error && (
            <p className="rules__error" role="alert">
              {error}
            </p>
          )}
          <div className="rule-form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar regla'}
            </button>
          </div>
        </form>
      ) : (
        <div className="rules__head">
          <button type="button" className="btn btn--primary" onClick={() => setDraft(EMPTY)}>
            Nueva regla
          </button>
        </div>
      )}

      {rules.length === 0 ? (
        !draft && (
          <p className="empty">
            Todavía no tienes reglas. Crea una aquí o desde un correo con “Crear regla”.
          </p>
        )
      ) : (
        <ul className="rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className={rule.enabled ? 'rule' : 'rule rule--off'}>
              <div className="rule__text">
                <span className="rule__name">{rule.name}</span>
                <span className="rule__when">
                  {describeConditions(rule.conditions)}: {describeRuleAction(rule)}
                  {rule.action === 'save' && rule.folder && accounts.length > 1 && ` (${accountEmail(rule.folder.accountId) ?? 'cuenta quitada'})`}
                </span>
              </div>
              <div className="rule__controls">
                <label className="rule__toggle">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => void save({ ...rule, enabled: !rule.enabled })}
                  />
                  Activa
                </label>
                <button type="button" className="link-btn" onClick={() => setDraft(rule)}>
                  Editar
                </button>
                <button type="button" className="link-btn link-btn--danger" onClick={() => void window.narsil.deleteRule(rule.id)}>
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {activity.length > 0 && (
        <>
          <h3 className="rules__subhead">Actividad reciente</h3>
          <ul className="activity">
            {activity.map((entry) => (
              <li key={entry.id} className={entry.error ? 'activity__item activity__item--error' : 'activity__item'}>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
                <span>
                  <strong>{entry.ruleName}</strong> {entry.error ? failed(entry) : done(entry)} “{entry.subject}”
                  {entry.error && <span className="activity__error">: {entry.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
