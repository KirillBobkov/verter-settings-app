/**
 * Серверные часы: issued_at должен совпадать с часами Jetson (допуск будущего
 * 0.5 с для cmd_vel, 2 с для остальных). Порт схемы drive.js робота:
 * образец = поле `at` ответа cmd_vel.command.status + performance.now() + RTT/2.
 * Опрос статуса каждые 250 мс выполняется ВСЕГДА — он и кормит этот модуль.
 */

type Sample = { at: number; midpoint: number; received: number; rtt: number }

let s: Sample | null = null

export function feedFromStatusReply(replyAt: number, sentAt: number, receivedAt: number): void {
  const rtt = receivedAt - sentAt // performance.now()
  if (!Number.isFinite(replyAt) || rtt >= 800) return // фильтр RTT < 800 мс
  if (s && rtt > s.rtt && receivedAt - s.received <= 3000) return // лучший образец или протухший (>3 с)
  s = { at: replyAt, midpoint: (sentAt + receivedAt) / 2, received: receivedAt, rtt }
}

/** Текущее время Jetson в Unix seconds. Бросает, если синхронизации ещё нет. */
export function serverNow(): number {
  if (!s) throw new Error('Нет синхронизации времени с Jetson')
  return s.at + (performance.now() - s.midpoint) / 1000
}

export function hasSync(): boolean {
  return s !== null
}

/** Свежесть синхронизации: drive — 5000 мс, map.save/локализация — 10000 мс. */
export function syncFresh(maxAgeMs: number): boolean {
  return !!s && performance.now() - s.received <= maxAgeMs
}

/** Только для тестов. */
export function resetClock(): void {
  s = null
}
