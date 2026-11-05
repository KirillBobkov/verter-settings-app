/**
 * Командный конверт робота (NATS_CONTRACTS_V1). Поле `action` на прямых
 * субъектах НЕ допускается — сервер отвечает ошибкой. Исключение: домен camera,
 * где action обязателен и равен 'camera.<операция>' (вводится в M4).
 *
 * issued_at — из clock.ts (serverNow): cmd_vel допускает будущее ≤0.5 с.
 */
import { serverNow } from './clock'
export { hasSync } from './clock'

export type Envelope = {
  v: 1
  id: string
  issued_at: number
  ttl_s: number
  args: unknown
}

export type Reply<T = unknown> =
  | { v: 1; id: string | null; ok: true; at: number; result: T }
  | { v: 1; id: string | null; ok: false; at: number; error: string }

export function makeEnvelope(ttl_s: number, args: unknown): Envelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    issued_at: Math.floor(serverNow()),
    ttl_s,
    args,
  }
}

/**
 * Bootstrap-конверт ТОЛЬКО для опроса cmd_vel.command.status: до первой
 * синхронизации берём локальные часы. В исходном UI эту роль исполнял
 * HTTP-шлюз (web.py собирал конверт статуса серверными часами); при прямом
 * NATS-клиенте первый запрос идёт с локальной оценкой — если часы браузера
 * сбиты, запрос отвергается как expired, но даже ошибочный ответ несёт `at`
 * и кормит clock.ts. Со второго опроса (250 мс) ходят точные конверты.
 */
export function makeStatusEnvelope(): Envelope {
  const issued = (() => {
    try {
      return Math.floor(serverNow())
    } catch {
      return Math.floor(Date.now() / 1000)
    }
  })()
  return { v: 1, id: crypto.randomUUID(), issued_at: issued, ttl_s: 1, args: {} }
}

/** Лимиты размера запроса, проверяемые backend. */
export const REQUEST_LIMITS = {
  service: 16 * 1024,
  cmdVel: 4096,
  camera: 65536,
} as const
