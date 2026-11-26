import { useState } from 'react'
import type { EmailAction, InboxItem } from '@shared/types'

type QuickAction = Exclude<EmailAction, 'reply'>

const ACTION_LABEL: Record<EmailAction, string> = {
  reply: 'Reply',
  archive: 'Archive',
  delete: 'Delete',
  save: 'Save'
}

const ACTION_HINT: Record<QuickAction, string> = {
  archive: 'Remove from inbox, keep in All Mail',
  delete: 'Move to Trash (recoverable for 30 days)',
  save: 'Star and keep in inbox'
}

interface EmailCardProps {
  item: InboxItem
  onAction(id: string, action: QuickAction): Promise<string | null>
  onReply(id: string, body: string): Promise<string | null>
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
            Narsil suggests <strong>{ACTION_LABEL[triage.recommendedAction].toLowerCase()}</strong>: {triage.reason}
          </span>
        </p>
      ) : (
        <p className="mail__summary mail__summary--pending">{item.triageError ?? 'Reading this email…'}</p>
      )}

      {triage && triage.replies.length > 0 && draft === null && (
        <div className="mail__replies" role="group" aria-label="Suggested replies">
          {triage.replies.map((reply) => (
            <button
              key={reply.label}
              type="button"
              className={recommended === 'reply' ? 'pill pill--lead' : 'pill'}
              onClick={() => setDraft(reply.body)}
              title={reply.body}
            >
              {reply.label}
            </button>
          ))}
          <button type="button" className="pill pill--ghost" onClick={() => setDraft('')}>
            Write my own
          </button>
        </div>
      )}

      {draft !== null && (
        <div className="mail__draft">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            aria-label={`Reply to ${senderName(email.from)}`}
            autoFocus
          />
          <div className="mail__draft-actions">
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !draft.trim()}
              onClick={() => void act(() => onReply(email.id, draft))}
            >
              {busy ? 'Sending…' : 'Send reply'}
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
