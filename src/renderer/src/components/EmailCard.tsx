import { useState } from 'react'
import type { EmailAction, InboxItem } from '@shared/types'
import { FolderPicker } from './FolderPicker'

type QuickAction = Exclude<EmailAction, 'reply'>

const ACTION_LABEL: Record<EmailAction, string> = {
  reply: 'Responder',
  archive: 'Archivar',
  delete: 'Eliminar',
  save: 'Guardar'
}

const ACTION_HINT: Record<QuickAction, string> = {
  archive: 'Quitar de la bandeja de entrada y conservar en Todos',
  delete: 'Mover a la papelera (recuperable durante 30 días)',
  save: 'Mover a una carpeta o etiqueta'
}

interface EmailCardProps {
  item: InboxItem
  /** The receiving account's email, shown only when several accounts are connected. */
  accountLabel?: string | undefined
  /** True briefly after a notification for this email was clicked. */
  highlighted?: boolean
  /** `save` passes the folder the email moves to. */
  onAction(key: string, action: QuickAction, folderId?: string): Promise<string | null>
  onReply(key: string, body: string): Promise<string | null>
  /** Opens a rule draft for this sender on the account that received the email. */
  onCreateRule(from: string, accountId: string): void
}

function address(mailbox: string): string {
  return (/<([^>]+)>/.exec(mailbox)?.[1] ?? mailbox).trim().toLowerCase()
}

function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  return match?.[1] ?? from
}

export function EmailCard({
  item,
  accountLabel,
  highlighted = false,
  onAction,
  onReply,
  onCreateRule
}: EmailCardProps): React.JSX.Element {
  const { email, triage } = item
  const [draft, setDraft] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recommended = triage?.recommendedAction
  // A Reply-To that differs from From is a common phishing trick, so call it out.
  const redirected = address(email.replyTo) !== address(email.from)

  async function act(fn: () => Promise<string | null>): Promise<void> {
    setBusy(true)
    setError(null)
    const failure = await fn()
    setBusy(false)
    if (failure) setError(failure)
  }

  const quick: QuickAction[] = ['save', 'archive', 'delete']

  return (
    <article className={highlighted ? 'mail mail--focus' : 'mail'} data-key={item.key} aria-busy={busy}>
      <header className="mail__head">
        <span className="mail__from" title={email.from}>
          {senderName(email.from)}
        </span>
        <time className="mail__time" dateTime={email.receivedAt}>
          {new Date(email.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </header>
      {accountLabel && (
        <span className="account-tag" title={`Recibido en ${accountLabel}`}>
          {accountLabel}
        </span>
      )}
      <h3 className="mail__subject">
        {/* The main process opens https links in the default browser and never in this window. */}
        {email.webLink ? (
          <a href={email.webLink} target="_blank" rel="noreferrer" title="Abrir este correo en el navegador">
            {email.subject}
          </a>
        ) : (
          email.subject
        )}
      </h3>

      {triage ? (
        <p className="mail__summary">
          {triage.summary}
          <span className="mail__advice">
            Narsil sugiere <strong>{ACTION_LABEL[triage.recommendedAction].toLowerCase()}</strong>: {triage.reason}
          </span>
        </p>
      ) : (
        <p className="mail__summary mail__summary--pending">{item.triageError ?? 'Leyendo este correo…'}</p>
      )}

      {triage && triage.replies.length > 0 && draft === null && (
        <div className="mail__replies" role="group" aria-label="Respuestas sugeridas">
          {triage.replies.map((reply, index) => (
            <button
              key={index}
              type="button"
              className={recommended === 'reply' ? 'pill pill--lead' : 'pill'}
              onClick={() => setDraft(reply.body)}
              title={reply.body}
            >
              {reply.label}
            </button>
          ))}
          <button type="button" className="pill pill--ghost" onClick={() => setDraft('')}>
            Escribir la mía
          </button>
        </div>
      )}

      {draft !== null && (
        <div className="mail__draft">
          <p className={redirected ? 'mail__to mail__to--warn' : 'mail__to'}>
            Para: {email.replyTo}
            {redirected && <span> (no es la dirección del remitente)</span>}
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            aria-label={`Respuesta a ${senderName(email.from)}`}
            autoFocus
          />
          <div className="mail__draft-actions">
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !draft.trim()}
              onClick={() => void act(() => onReply(item.key, draft))}
            >
              {busy ? 'Enviando…' : 'Enviar respuesta'}
            </button>
          </div>
        </div>
      )}

      {draft === null && picking && (
        <div className="mail__picker">
          <p className="mail__picker-title">Guardar en</p>
          <FolderPicker
            accountId={email.accountId}
            busy={busy}
            onPick={(folder) => void act(() => onAction(item.key, 'save', folder.id))}
            onCancel={() => setPicking(false)}
          />
        </div>
      )}

      {draft === null && !picking && (
        <div className="mail__actions">
          <button
            type="button"
            className="link-btn mail__rule"
            title="Crear una regla para los correos de este remitente"
            onClick={() => onCreateRule(email.from, email.accountId)}
          >
            Crear regla
          </button>
          {quick.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn--${action}${recommended === action ? ' btn--lead' : ''}`}
              title={ACTION_HINT[action]}
              disabled={busy}
              onClick={() => (action === 'save' ? setPicking(true) : void act(() => onAction(item.key, action)))}
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mail__error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
