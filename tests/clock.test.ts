import { describe, it, expect, beforeEach } from 'vitest'
import { feedFromStatusReply, serverNow, hasSync, syncFresh, resetClock } from '../src/lib/nats/clock'

describe('clock: синхронизация с часами Jetson (порт drive.js)', () => {
  beforeEach(() => resetClock())

  it('отбрасывает образцы с RTT >= 800 мс', () => {
    feedFromStatusReply(1000.0, 0, 900) // rtt 900
    expect(hasSync()).toBe(false)
    feedFromStatusReply(1000.0, 0, 799.9) // rtt 799.9 — проходит
    expect(hasSync()).toBe(true)
  })

  it('экстраполирует время по performance.now()', () => {
    feedFromStatusReply(1000.0, 100, 300) // rtt 200, midpoint 200
    const now = serverNow()
    // performance.now() >= 300 → serverNow >= 1000 + 0
    expect(now).toBeGreaterThanOrEqual(1000)
    expect(now).toBeLessThan(1100)
  })

  it('не заменяет свежий лучший образец худшим RTT', () => {
    feedFromStatusReply(1000.0, 100, 200) // rtt 100
    feedFromStatusReply(1005.0, 1000, 1300) // rtt 300, прошло <3 c → игнор
    expect(serverNow()).toBeGreaterThanOrEqual(1000)
    expect(serverNow()).toBeLessThan(1010)
  })

  it('синхронизация протухает по maxAge', () => {
    feedFromStatusReply(1000.0, 100, 200)
    expect(syncFresh(5000)).toBe(true)
    expect(syncFresh(0)).toBe(false)
  })

  it('serverNow бросает без синхронизации', () => {
    expect(() => serverNow()).toThrow('Нет синхронизации')
  })
})
