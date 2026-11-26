import { useState } from 'react'
import type { EmailAction, InboxItem } from '@shared/types'

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
  save: 'Destacar y mantener en la bandeja de entrada'
}

interface EmailCardProps {
  item: InboxItem
  onAction(id: string, action: QuickAction): Promise<string | null>
  onReply(id: string, body: string): Promise<string | null>
}

function address(mailbox: string): string {
  return (/<([^>]+)>/.exec(mailbox)?.[1] ?? mailbox).trim().toLowerCase()
}

function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  return match?.[1] ?? from
}

export function EmailCard({ item, onAction, onReply }: EmailCardProps): React.JSX.Element {
  const { email, triage } = item
  const [draft, setDraft] = useState<string | null>(null)
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
    <article className="mail" aria-busy={busy}>
      <header className="mail__head">
        <span className="mail__from" title={email.from}>
          {senderName(email.from)}
        </span>
        <time className="mail__time" dateTime={email.receivedAt}>
          {new Date(email.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </header>
      <h3 className="mail__subject">{email.subject}</h3>

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
              onClick={() => void act(() => onReply(email.id, draft))}
            >
              {busy ? 'Enviando…' : 'Enviar respuesta'}
            </button>
          </div>
        </div>
      )}

      {draft === null && (
        <div className="mail__actions">
          {quick.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn--${action}${recommended === action ? ' btn--lead' : ''}`}
              title={ACTION_HINT[action]}
              disabled={busy}
              onClick={() => void act(() => onAction(email.id, action))}
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
