import { useState } from 'react'
import { INBOX_WINDOW_DAYS, type Account, type ActionResult, type AccountSettings, type AppStatus, type InboxWindowDays, type ProviderKind } from '@shared/types'
import { ReconnectNotice } from './ReconnectNotice'

interface SetupProps {
  status: AppStatus
}

const PROVIDER_NAME: Record<ProviderKind, string> = { google: 'Google', microsoft: 'Microsoft' }

/** What "include categories" means for each provider. */
const CATEGORIES_LABEL: Record<ProviderKind, string> = {
  google: 'Incluir Promociones y Social',
  microsoft: 'Incluir la bandeja Otros'
}

export function Setup({ status }: SetupProps): React.JSX.Element {
  const [key, setKey] = useState('')
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<ActionResult>): Promise<boolean> {
    setBusy(label)
    setMessage(null)
    const result = await fn()
    setBusy(null)
    if (!result.ok) setMessage(result.error ?? 'Algo salió mal.')
    return result.ok
  }

  function changeSettings(account: Account, next: AccountSettings): void {
    void run(`settings-${account.id}`, () => window.narsil.setAccountSettings(account.id, next))
  }

  function addButton(provider: ProviderKind, configured: boolean): React.JSX.Element {
    const label = `add-${provider}`
    return (
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy !== null || !configured}
        title={configured ? undefined : `Primero completa el paso de ${PROVIDER_NAME[provider]}.`}
        onClick={() => void run(label, () => window.narsil.addAccount(provider))}
      >
        {busy === label ? 'Esperando a tu navegador…' : `Agregar cuenta de ${PROVIDER_NAME[provider]}`}
      </button>
    )
  }

  return (
    <section className="setup" aria-label="Ajustes">
      <p className="setup__intro">
        Configura Google, Microsoft o ambos, agrega tus cuentas y guarda tu API key de Anthropic.
      </p>
      <ol className="setup__steps">
        <li className={status.hasGoogleClient ? 'step step--done' : 'step'}>
          <h3>Archivo de cliente de Google</h3>
          <p>
            Para cuentas de Gmail: el JSON del cliente OAuth tipo “App de escritorio” de tu proyecto de Google Cloud. El
            README explica cómo obtenerlo.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() => void run('client', () => window.narsil.importGoogleClient())}
          >
            {status.hasGoogleClient ? 'Reemplazar archivo de cliente' : 'Elegir archivo de cliente'}
          </button>
        </li>
        <li className={status.hasMicrosoftClient ? 'step step--done' : 'step'}>
          <h3>ID de aplicación de Microsoft</h3>
          <p>
            Para cuentas de Outlook, Hotmail o Microsoft 365: el ID de aplicación (cliente) de tu registro en Microsoft
            Entra. El README explica cómo obtenerlo.
          </p>
          <form
            className="setup__key"
            onSubmit={(e) => {
              e.preventDefault()
              void run('client-id', () => window.narsil.setMicrosoftClientId(clientId.trim())).then((ok) => {
                if (ok) setClientId('')
              })
            }}
          >
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={status.hasMicrosoftClient ? 'ID guardado. Pega uno nuevo para reemplazarlo' : '00000000-0000-0000-0000-000000000000'}
              aria-label="ID de aplicación (cliente) de Microsoft"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !clientId.trim()}>
              Guardar ID
            </button>
          </form>
        </li>
        <li className={status.accounts.length > 0 ? 'step step--done' : 'step'}>
          <h3>Cuentas</h3>
          <p>
            Tu navegador se abre para que autorices a Narsil a leer tu correo, actuar sobre él, administrar sus reglas y leer tu
            calendario.
          </p>
          {status.accounts.length === 0 ? (
            <p className="accounts__empty">Aún no has agregado ninguna cuenta.</p>
          ) : (
            <ul className="accounts" aria-label="Cuentas conectadas">
              {status.accounts.map((account) => (
                <li key={account.id} className="account">
                  <span className="account__provider">{PROVIDER_NAME[account.provider]}</span>
                  <span className="account__email" title={account.email}>
                    {account.email}
                  </span>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy !== null}
                    aria-label={`Quitar ${account.email}`}
                    onClick={() => void run(`remove-${account.id}`, () => window.narsil.removeAccount(account.id))}
                  >
                    {busy === `remove-${account.id}` ? 'Quitando…' : 'Quitar'}
                  </button>
                  <div className="account__settings" role="group" aria-label={`Qué revisa Narsil en ${account.email}`}>
                    <label className="account__toggle">
                      <input
                        type="checkbox"
                        checked={account.settings.includeCategories}
                        disabled={busy !== null}
                        onChange={(e) => changeSettings(account, { ...account.settings, includeCategories: e.target.checked })}
                      />
                      {CATEGORIES_LABEL[account.provider]}
                    </label>
                    <label className="account__window">
                      Revisar
                      <select
                        value={account.settings.windowDays}
                        disabled={busy !== null}
                        onChange={(e) =>
                          changeSettings(account, { ...account.settings, windowDays: Number(e.target.value) as InboxWindowDays })
                        }
                      >
                        {INBOX_WINDOW_DAYS.map((days) => (
                          <option key={days} value={days}>
                            {days} días
                          </option>
                        ))}
                      </select>
                    </label>
                    {busy === `settings-${account.id}` && <span className="account__busy">Revisando…</span>}
                  </div>
                  {account.needsReconnect && <ReconnectNotice account={account} />}
                </li>
              ))}
            </ul>
          )}
          <div className="setup__actions">
            {addButton('google', status.hasGoogleClient)}
            {addButton('microsoft', status.hasMicrosoftClient)}
          </div>
        </li>
        <li className={status.hasAnthropicKey ? 'step step--done' : 'step'}>
          <h3>API key de Anthropic</h3>
          <p>Se usa para resumir cada correo y redactar respuestas. Se guarda cifrada en este equipo.</p>
          <form
            className="setup__key"
            onSubmit={(e) => {
              e.preventDefault()
              void run('key', () => window.narsil.setAnthropicKey(key)).then(() => setKey(''))
            }}
          >
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status.hasAnthropicKey ? 'Clave guardada. Pega una nueva para reemplazarla' : 'sk-ant-…'}
              aria-label="API key de Anthropic"
              autoComplete="off"
            />
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !key.trim()}>
              Guardar clave
            </button>
          </form>
        </li>
      </ol>
      {message && (
        <p className="setup__error" role="alert">
          {message}
        </p>
      )}
    </section>
  )
}
