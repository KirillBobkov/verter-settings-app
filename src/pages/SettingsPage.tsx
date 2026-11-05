import { useEffect, useState } from 'react'
import { useConnection } from '../stores/connection'
import {
  loadCreds,
  saveCreds,
  forgetCreds,
  sanitizeCreds,
  decodeJwtExp,
  decodeJwtName,
} from '../lib/nats/auth'
import { getWsUrlOverride, setWsUrlOverride } from '../lib/config/runtime-config'

export function SettingsPage() {
  const { config, reconnect, disconnect } = useConnection()
  const [creds, setCreds] = useState('')
  const [override, setOverride] = useState(getWsUrlOverride() ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const existing = loadCreds()
  const exp = existing ? decodeJwtExp(existing) : null
  const name = existing ? decodeJwtName(existing) : null
  const expSoon = exp !== null && exp * 1000 - nowMs < 3 * 24 * 3600 * 1000

  async function onSave() {
    const trimmed = creds.trim()
    if (trimmed) {
      // normalize: склеить разорванные переносами JWT/seed, отбросить лишнее
      const sanitized = sanitizeCreds(trimmed)
      if (!sanitized) {
        setMsg('Креды не похожи на nats-creds: нужны блоки NATS USER JWT и USER NKEY SEED')
        return
      }
      saveCreds(sanitized)
    }
    const urlOverride = override.trim()
    setWsUrlOverride(/^wss?:\/\//.test(urlOverride) ? urlOverride : null)
    setMsg(trimmed ? 'Креды сохранены, подключаюсь…' : 'Настройки сохранены, подключаюсь…')
    await reconnect()
  }

  async function onForget() {
    forgetCreds()
    setWsUrlOverride(null)
    setOverride('')
    setCreds('')
    await disconnect()
    setMsg('Креды и адрес забыты')
  }

  return (
    <section className="card">
      <h2>Настройки</h2>
      <p className="muted">
        Креды выдаёт администратор хаба (см. docs/OPERATORS.md) и передаёт по защищённому
        каналу. Они хранятся только в localStorage этого браузера и отправляются на GitHub
        Pages не будут.
      </p>

      {existing && (
        <p>
          Текущие креды: <b>{name ?? 'имя неизвестно'}</b>
          {exp && (
            <>
              {' · действуют до '}
              <span className={expSoon ? 'warn-text' : ''}>
                {new Date(exp * 1000).toLocaleString('ru-RU')}
              </span>
              {expSoon && ' — скоро истекут, запросите новые'}
            </>
          )}
        </p>
      )}

      <label>
        Сервер (по умолчанию из config.json)
        <input value={config?.natsWsUrl ?? ''} disabled size={40} />
      </label>
      <p className="muted">Адрес по умолчанию из config.json; для смены — override ниже.</p>
      <label>
        Override адреса (для staging, необязательно)
        <input value={override} onChange={(e) => setOverride(e.target.value)} size={40} placeholder="wss://nats-staging.example.com:443" />
      </label>
      <label>
        Креды (вставьте содержимое файла ui-{'<имя>'}.creds)
        <textarea
          value={creds}
          onChange={(e) => setCreds(e.target.value)}
          rows={6}
          cols={60}
          spellCheck={false}
          placeholder={'-----BEGIN NATS USER JWT-----\neyJ...\n-----END NATS USER JWT-----\n\n-------BEGIN USER SEED-------\nSU...\n-------END USER SEED-------'}
        />
      </label>
      <div className="row">
        <button onClick={() => void onSave()}>Сохранить и подключиться</button>
        <button className="danger" onClick={() => void onForget()}>
          Забыть креды и адрес
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  )
}
