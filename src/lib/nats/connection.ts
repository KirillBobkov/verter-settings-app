/**
 * Единственное ws-соединение с хабом. Все запросы мультиплексируются
 * на авто-inbox (request/reply). Порт схемы robot_nats/web.py из доков робота.
 */
import { wsconnect, credsAuthenticator, type NatsConnection } from '@nats-io/nats-core'

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export async function connect(url: string, credsText: string): Promise<NatsConnection> {
  return wsconnect({
    servers: url, // полная форма: wss://<хаб>:443
    name: `verter-ui-${Math.random().toString(36).slice(2, 8)}`, // видно в /connz хаба
    maxReconnectAttempts: -1, // бесконечно, как python-клиент робота
    reconnectTimeWait: 2000,
    waitOnFirstConnect: true,
    authenticator: credsAuthenticator(new TextEncoder().encode(credsText)),
  })
}

/** Подписка на изменения статуса соединения (события — ОБЪЕКТЫ с полем type). */
export function watchStatus(nc: NatsConnection, onChange: (type: string) => void): () => void {
  let stopped = false
  void (async () => {
    for await (const s of nc.status()) {
      if (stopped) break
      onChange(s.type)
    }
  })().catch(() => {
    /* цикл завершается при закрытии соединения */
  })
  return () => {
    stopped = true
  }
}
