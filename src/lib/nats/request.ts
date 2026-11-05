/**
 * Хелпер request/reply. Никаких авто-ретраев изменяющих команд:
 * «подтверждение ≠ завершение»; при таймауте читать состояние, повтор — руками.
 */
import type { NatsConnection } from '@nats-io/nats-core'
import type { Envelope, Reply } from './envelope'

export class RobotRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'no-responders' | 'transport',
  ) {
    super(message)
  }
}

export async function robotRequest(
  nc: NatsConnection,
  subject: string,
  env: Envelope,
  timeoutMs: number,
): Promise<Reply> {
  let m
  try {
    m = await nc.request(subject, JSON.stringify(env), { timeout: timeoutMs })
  } catch (err) {
    const name = err instanceof Error ? err.message : String(err)
    if (/timeout/i.test(name)) throw new RobotRequestError('Таймаут ожидания ответа', 'timeout')
    if (/no responders/i.test(name)) throw new RobotRequestError('Нет ответившего (робот/bridge офлайн?)', 'no-responders')
    throw new RobotRequestError(`Ошибка запроса: ${name}`, 'transport')
  }
  return m.json<Reply>()
}

/** Успешный ответ команды (ошибки бросаются исключением). */
export type CommandOk<T> = Extract<Reply<T>, { ok: true }>

/** Команда с конвертом и словарём таймаутов — сокращение для UI. */
export async function command<T = unknown>(
  nc: NatsConnection,
  subject: string,
  env: Envelope,
  timeoutMs: number,
): Promise<CommandOk<T>> {
  const reply = await robotRequest(nc, subject, env, timeoutMs)
  if (!reply.ok) throw new Error(reply.error)
  return reply as CommandOk<T>
}
