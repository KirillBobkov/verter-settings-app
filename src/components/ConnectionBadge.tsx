import { useConnection } from '../stores/connection'

function label(state: string, connectedAt: number | null, error: string | null): string {
  switch (state) {
    case 'connected':
      return `NATS подключён${connectedAt ? ` · ${new Date(connectedAt).toLocaleTimeString('ru-RU')}` : ''}`
    case 'connecting':
      return 'Подключение…'
    case 'reconnecting':
      return 'Переподключение…'
    case 'error':
      return `Нет связи${error ? `: ${error}` : ''}`
    default:
      return 'Не подключён'
  }
}

export function ConnectionBadge() {
  const { state, connectedAt, error } = useConnection()
  const cls = state === 'connected' ? 'ok' : state === 'reconnecting' || state === 'connecting' ? 'warn' : 'bad'
  return <span className={`badge badge-${cls}`}>{label(state, connectedAt, error)}</span>
}
