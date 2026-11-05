import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useConnection } from '../stores/connection'
import { useRobotUpdates } from '../hooks/useRobotUpdates'
import { command, RobotRequestError } from '../lib/nats/request'
import { makeEnvelope } from '../lib/nats/envelope'
import { serviceSubject, REQUEST_TIMEOUTS_MS } from '../lib/nats/subjects'
import type { RobotSnapshot } from '../lib/contracts/types'

export function MonitorPage() {
  const { nc, config } = useConnection()
  const robotId = config?.robotId ?? 'verter_01'
  const updates = useRobotUpdates()
  const [snapshot, setSnapshot] = useState<RobotSnapshot | null>(null)
  const [note, setNote] = useState('')
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshState = useCallback(async () => {
    if (!nc) return
    try {
      const reply = await command<RobotSnapshot>(
        nc,
        serviceSubject(robotId, 'state_get'),
        makeEnvelope(30, {}),
        REQUEST_TIMEOUTS_MS.service,
      )
      setSnapshot(reply.result)
      setNote((reply.result as unknown as { settings?: { note?: string } }).settings?.note ?? '')
    } catch (err) {
      setLastReply(`state_get: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [nc, robotId])

  useEffect(() => {
    // Начальная загрузка снимка при появлении соединения; обновления приходят
    // по подписке useRobotUpdates. Правило set-state-in-effect не различает
    // асинхронную выборку — глушим осознанно.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshState()
  }, [refreshState])

  async function run(name: string, args: unknown, timeout: number) {
    if (!nc) return
    setBusy(true)
    try {
      const reply = await command<RobotSnapshot>(
        nc,
        serviceSubject(robotId, name),
        makeEnvelope(30, args),
        timeout,
      )
      setLastReply(JSON.stringify(reply, null, 2))
      if (name === 'state_get') setSnapshot(reply.result)
    } catch (err) {
      const text =
        err instanceof RobotRequestError || err instanceof Error ? err.message : String(err)
      setLastReply(`Ошибка: ${text}`)
    } finally {
      setBusy(false)
    }
  }

  if (!nc) {
    return (
      <section className="card">
        <h2>Мониторинг</h2>
        <p>
          Нет соединения с роботом. Введите креды на <Link to="/settings">странице «Настройки»</Link>.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <h2>Состояние робота {robotId}</h2>
        {snapshot ? (
          <table>
            <tbody>
              <tr><td>boot_id</td><td className="mono">{snapshot.boot_id}</td></tr>
              <tr><td>uptime</td><td>{Math.floor(snapshot.uptime_s / 60)} мин</td></tr>
              <tr><td>режим</td><td>{snapshot.mode?.actual ?? '—'}</td></tr>
              <tr>
                <td>операция</td>
                <td>{snapshot.mode?.operation?.status ?? '—'} {snapshot.mode?.stale ? '(устарело)' : ''}</td>
              </tr>
              <tr><td>обновлено</td><td>{new Date(snapshot.updated_at * 1000).toLocaleTimeString('ru-RU')}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Загрузка снимка…</p>
        )}
        <div className="row">
          <button disabled={busy} onClick={() => void run('ping', {}, REQUEST_TIMEOUTS_MS.service)}>Ping</button>
          <button disabled={busy} onClick={() => void refreshState()}>Обновить снимок</button>
          <button disabled={busy} onClick={() => void run('schema_get', {}, REQUEST_TIMEOUTS_MS.service)}>Словарь API</button>
        </div>
      </section>

      <section className="card">
        <h2>Заметка оператора</h2>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} cols={60} maxLength={500} />
        <div className="row">
          <button disabled={busy} onClick={() => void run('note_set', { note }, REQUEST_TIMEOUTS_MS.service)}>
            Сохранить заметку
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Живые метрики</h2>
        {updates.length === 0 ? (
          <p className="muted">Ожидание обновлений (bridge публикует примерно раз в 2 с)…</p>
        ) : (
          <table>
            <thead><tr><th>Субъект</th><th>Значение</th><th>Качество</th></tr></thead>
            <tbody>
              {updates.map((m, i) => (
                <tr key={`${m.subject}-${i}`}>
                  <td className="mono small">{m.subject}</td>
                  <td>{JSON.stringify(m.envelope.value)}</td>
                  <td>{m.envelope.quality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {lastReply && (
        <section className="card">
          <h2>Последний ответ</h2>
          <pre>{lastReply}</pre>
        </section>
      )}
    </>
  )
}
