import { useEffect, useState } from 'react'
import type {
  Account,
  AccountRules,
  Rule,
  RuleActivity,
  ServerRule,
  ServerRuleAction,
  ServerRuleInput
} from '@shared/types'
import { describeConditions, describeRuleAction, describeServerRuleAction } from '@shared/rules'
import { FolderPicker } from './FolderPicker'
import { ReconnectNotice } from './ReconnectNotice'

const ACTION_LABEL: Record<ServerRuleAction, string> = {
  move: 'Mover a carpeta',
  archive: 'Archivar',
  delete: 'Eliminar'
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

const emptyDraft = (accountId: string): ServerRuleInput => ({
  accountId,
  name: '',
  action: 'archive',
  conditions: { from: '', subject: '', body: '' }
})

/** A server rule as the form edits it. */
function draftOf(rule: ServerRule): ServerRuleInput {
  return {
    id: rule.id,
    accountId: rule.accountId,
    name: rule.name,
    conditions: rule.conditions,
    action: rule.action,
    ...(rule.folderId ? { folderId: rule.folderId, folderName: rule.folderName ?? '' } : {}),
    ...(rule.enabled === false ? { enabled: false } : {})
  }
}

/** A local rule being moved to an account with "Pasar a una cuenta…". */
interface Conversion {
  ruleId: string
  accountId: string
  folderId?: string
  folderName?: string
  /** The user accepted that a disabled local rule becomes an always-on rule in the account. */
  confirmEnabled?: boolean
}

interface RulesProps {
  /** Local rules, kept running in Narsil until each is moved to an account. */
  rules: Rule[]
  /** Gmail filters and Outlook inbox rules of each connected account. */
  serverRules: AccountRules[]
  activity: RuleActivity[]
  accounts: Account[]
  /** A draft handed over from an email card ("Crear regla"); opens the form prefilled. */
  incomingDraft: ServerRuleInput | null
  onDraftTaken(): void
}

export function Rules({ rules, serverRules, activity, accounts, incomingDraft, onDraftTaken }: RulesProps): React.JSX.Element {
  const [draft, setDraft] = useState<ServerRuleInput | null>(null)
  const [conversion, setConversion] = useState<Conversion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  /** The server rule whose "Borrar" waits for confirmation. */
  const [confirmDelete, setConfirmDelete] = useState<{ accountId: string; ruleId: string } | null>(null)

  useEffect(() => {
    void window.narsil.reloadServerRules()
  }, [])

  useEffect(() => {
    if (incomingDraft) {
      setDraft(incomingDraft)
      setConversion(null)
      setError(null)
      onDraftTaken()
    }
  }, [incomingDraft, onDraftTaken])

  const accountOf = (accountId: string): Account | undefined => accounts.find((a) => a.id === accountId)
  const accountEmail = (accountId: string): string => accountOf(accountId)?.email ?? 'cuenta quitada'

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, setMessage: (m: string | null) => void): Promise<boolean> {
    setBusy(true)
    setMessage(null)
    const result = await fn()
    setBusy(false)
    if (!result.ok) setMessage(result.error ?? 'Algo salió mal.')
    return result.ok
  }

  const save = (input: ServerRuleInput): Promise<boolean> => act(() => window.narsil.saveServerRule(input), setError)

  const setCondition = (field: keyof ServerRuleInput['conditions'], value: string): void =>
    setDraft((d) => (d ? { ...d, conditions: { ...d.conditions, [field]: value } } : d))

  const draftAccount = draft ? accountOf(draft.accountId) : undefined
  const draftNeedsReconnect = draft ? serverRules.find((a) => a.accountId === draft.accountId)?.needsReconnect === true : false

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
            Se guarda en la cuenta y funciona aunque tu equipo esté apagado. Al crearla, también se aplica a los correos de esa
            cuenta que ya están en la lista. Deben cumplirse todas las condiciones que llenes.
          </p>
          <label>
            Cuenta
            <select
              value={draft.accountId}
              // Editing replaces the rule on its own account; folders belong to one mailbox.
              disabled={Boolean(draft.id)}
              onChange={(e) => {
                const { folderId: _id, folderName: _name, ...rest } = draft
                setDraft({ ...rest, accountId: e.target.value })
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </label>
          {draftNeedsReconnect && draftAccount && <ReconnectNotice account={draftAccount} />}
          <label>
            Nombre
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Opcional" />
          </label>
          {draftAccount?.provider === 'google' && (
            <p className="rule-form__hint">Gmail no guarda nombres de filtros: Narsil lo mostrará con sus condiciones.</p>
          )}
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
            <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as ServerRuleAction })}>
              {(Object.keys(ACTION_LABEL) as ServerRuleAction[]).map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </label>
          {draft.action === 'move' && (
            <div className="rule-form__folder">
              <span>Carpeta{draft.folderId ? `: ${draft.folderName ?? ''}` : ''}</span>
              <FolderPicker
                accountId={draft.accountId}
                selectedId={draft.folderId}
                busy={busy}
                onPick={(folder) => setDraft({ ...draft, folderId: folder.id, folderName: folder.name })}
              />
            </div>
          )}
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
          <button
            type="button"
            className="btn btn--primary"
            disabled={accounts.length === 0}
            title={accounts.length === 0 ? 'Primero agrega una cuenta en Ajustes.' : undefined}
            onClick={() => {
              const first = accounts[0]
              if (!first) return
              setError(null)
              setConversion(null)
              setDraft(emptyDraft(first.id))
            }}
          >
            Nueva regla
          </button>
        </div>
      )}

      {listError && (
        <p className="rules__error" role="alert">
          {listError}
        </p>
      )}

      <h3 className="rules__subhead">Reglas en tus cuentas</h3>
      {serverRules.length === 0 ? (
        <p className="empty">Agrega una cuenta en Ajustes para crear reglas.</p>
      ) : (
        serverRules.map((group) => {
          const account = accountOf(group.accountId)
          return (
            <div key={group.accountId} className="rule-group">
              <h4 className="rule-group__title" title={accountEmail(group.accountId)}>
                {accountEmail(group.accountId)}
              </h4>
              {group.needsReconnect && account && <ReconnectNotice account={account} />}
              {group.error && <p className="rules__error">{group.error}</p>}
              {!group.loaded && !group.needsReconnect && <p className="rule-group__note">Cargando reglas…</p>}
              {group.loaded && !group.needsReconnect && !group.error && group.rules.length === 0 && (
                <p className="rule-group__note">Esta cuenta no tiene reglas.</p>
              )}
              {group.rules.length > 0 && (
                <ul className="rule-list">
                  {group.rules.map((rule) => {
                    const confirming = confirmDelete?.accountId === rule.accountId && confirmDelete.ruleId === rule.id
                    const classes = ['rule', !rule.managedByNarsil && 'rule--foreign', rule.enabled === false && 'rule--off']
                    return (
                      <li key={rule.id} className={classes.filter(Boolean).join(' ')}>
                        <div className="rule__text">
                          <span className="rule__name">{rule.name}</span>
                          <span className="rule__when">
                            {rule.managedByNarsil
                              ? `${describeConditions(rule.conditions)}: ${describeServerRuleAction(rule)}`
                              : 'Creada fuera de Narsil. Solo puedes borrarla.'}
                          </span>
                          {rule.enabled === false && <span className="rule__state">Desactivada en Outlook</span>}
                        </div>
                        {confirming ? (
                          <div className="rule__confirm" role="group" aria-label="Confirmar borrado">
                            <span>¿Borrar esta regla de {accountEmail(rule.accountId)}? No se puede deshacer.</span>
                            <button
                              type="button"
                              className="link-btn link-btn--danger"
                              disabled={busy}
                              onClick={() =>
                                void act(() => window.narsil.deleteServerRule(rule.accountId, rule.id), setListError).then(
                                  () => setConfirmDelete(null)
                                )
                              }
                            >
                              Borrar
                            </button>
                            <button type="button" className="link-btn" disabled={busy} onClick={() => setConfirmDelete(null)}>
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div className="rule__controls">
                            {rule.managedByNarsil && (
                              <button
                                type="button"
                                className="link-btn"
                                disabled={busy}
                                onClick={() => {
                                  setError(null)
                                  setConversion(null)
                                  setDraft(draftOf(rule))
                                }}
                              >
                                Editar
                              </button>
                            )}
                            <button
                              type="button"
                              className="link-btn link-btn--danger"
                              disabled={busy}
                              onClick={() => {
                                setListError(null)
                                setConfirmDelete({ accountId: rule.accountId, ruleId: rule.id })
                              }}
                            >
                              Borrar
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })
      )}

      {rules.length > 0 && (
        <>
          <h3 className="rules__subhead">Reglas locales</h3>
          <p className="rule-group__note">
            Solo funcionan mientras Narsil está abierto en este equipo. Pásalas a una cuenta para que funcionen siempre.
          </p>
          <ul className="rule-list">
            {rules.map((rule) => (
              <li key={rule.id} className={rule.enabled ? 'rule rule--local' : 'rule rule--local rule--off'}>
                <div className="rule__row">
                  <div className="rule__text">
                    <span className="rule__name">{rule.name}</span>
                    <span className="rule__when">
                      {describeConditions(rule.conditions)}: {describeRuleAction(rule)}
                      {rule.action === 'save' && rule.folder && accounts.length > 1 && ` (${accountEmail(rule.folder.accountId)})`}
                    </span>
                  </div>
                  <div className="rule__controls">
                    <label className="rule__toggle">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busy}
                        onChange={() => void act(() => window.narsil.saveRule({ ...rule, enabled: !rule.enabled }), setListError)}
                      />
                      Activa
                    </label>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || accounts.length === 0}
                      onClick={() => {
                        setError(null)
                        setDraft(null)
                        setConversion({ ruleId: rule.id, accountId: rule.folder?.accountId ?? accounts[0]?.id ?? '' })
                      }}
                    >
                      Pasar a una cuenta…
                    </button>
                    <button
                      type="button"
                      className="link-btn link-btn--danger"
                      disabled={busy}
                      onClick={() => void act(() => window.narsil.deleteRule(rule.id), setListError)}
                    >
                      Borrar
                    </button>
                  </div>
                </div>
                {conversion?.ruleId === rule.id && (
                  <ConvertPanel
                    rule={rule}
                    conversion={conversion}
                    accounts={accounts}
                    busy={busy}
                    error={error}
                    onChange={setConversion}
                    onCancel={() => setConversion(null)}
                    onConvert={() => {
                      const { ruleId, confirmEnabled: _confirmed, ...target } = conversion
                      void act(() => window.narsil.convertLocalRule(ruleId, target), setError).then((ok) => ok && setConversion(null))
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
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

interface ConvertPanelProps {
  rule: Rule
  conversion: Conversion
  accounts: Account[]
  busy: boolean
  error: string | null
  onChange(next: Conversion): void
  onCancel(): void
  onConvert(): void
}

/**
 * "Pasar a una cuenta…": a save rule with a folder goes to that folder's account; any other rule
 * picks an account, and an old save rule without a folder also picks the folder.
 */
function ConvertPanel({ rule, conversion, accounts, busy, error, onChange, onCancel, onConvert }: ConvertPanelProps): React.JSX.Element {
  const fixed = rule.action === 'save' && rule.folder ? rule.folder : null
  const needsFolder = rule.action === 'save' && !rule.folder
  const needsConfirm = !rule.enabled && conversion.confirmEnabled !== true
  const email = (id: string): string => accounts.find((a) => a.id === id)?.email ?? 'cuenta quitada'

  return (
    <div className="rule-convert" role="group" aria-label={`Pasar ${rule.name} a una cuenta`}>
      {fixed ? (
        <p className="rule-form__hint">
          Se creará en {email(fixed.accountId)} y moverá los correos a “{fixed.name}”. Después se borra la regla local.
        </p>
      ) : (
        <>
          <label className="rule-convert__field">
            Cuenta
            <select
              value={conversion.accountId}
              disabled={busy}
              onChange={(e) =>
                onChange({
                  ruleId: conversion.ruleId,
                  accountId: e.target.value,
                  ...(conversion.confirmEnabled ? { confirmEnabled: true } : {})
                })
              }
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </label>
          {needsFolder && (
            <div className="rule-form__folder">
              <span>Carpeta{conversion.folderId ? `: ${conversion.folderName ?? ''}` : ''}</span>
              <FolderPicker
                accountId={conversion.accountId}
                selectedId={conversion.folderId}
                busy={busy}
                onPick={(folder) => onChange({ ...conversion, folderId: folder.id, folderName: folder.name })}
              />
            </div>
          )}
          <p className="rule-form__hint">Después de crearla en la cuenta, se borra la regla local.</p>
        </>
      )}
      {!rule.enabled && (
        <label className="rule-convert__confirm">
          <input
            type="checkbox"
            checked={conversion.confirmEnabled === true}
            disabled={busy}
            onChange={(e) => onChange({ ...conversion, confirmEnabled: e.target.checked })}
          />
          Esta regla está desactivada; al pasarla a la cuenta quedará activa.
        </label>
      )}
      {error && (
        <p className="rules__error" role="alert">
          {error}
        </p>
      )}
      <div className="rule-form__actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || needsConfirm || (needsFolder && !conversion.folderId)}
          onClick={onConvert}
        >
          {busy ? 'Pasando…' : 'Pasar'}
        </button>
      </div>
    </div>
  )
}
