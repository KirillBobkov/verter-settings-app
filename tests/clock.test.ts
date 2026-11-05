import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { feedFromStatusReply, serverNow, hasSync, syncFresh, resetClock } from '../src/lib/nats/clock'

// performance.now() мокаем: ассерты не должны зависеть от реального аптайма
// процесса (на быстром CI-раннере он меньше фейковых таймстампов образцов).
describe('clock: синхронизация с часами Jetson (порт drive.js)', () => {
  beforeEach(() => {
    resetClock()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('отбрасывает образцы с RTT >= 800 мс', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    feedFromStatusReply(1000.0, 0, 900) // rtt 900
    expect(hasSync()).toBe(false)
    feedFromStatusReply(1000.0, 0, 799.9) // rtt 799.9 — проходит
    expect(hasSync()).toBe(true)
  })

  it('экстраполирует время по performance.now()', () => {
    feedFromStatusReply(1000.0, 100, 300) // rtt 200, midpoint 200
    vi.spyOn(performance, 'now').mockReturnValue(400) // на 200 мс позже midpoint
    expect(serverNow()).toBeCloseTo(1000.2, 6)
  })

  it('не заменяет свежий лучший образец худшим RTT', () => {
    feedFromStatusReply(1000.0, 100, 200) // rtt 100, midpoint 150
    feedFromStatusReply(1005.0, 1000, 1300) // rtt 300, прошло <3 c → игнор
    vi.spyOn(performance, 'now').mockReturnValue(400)
    expect(serverNow()).toBeCloseTo(1000.25, 6) // остался первый образец
  })

  it('синхронизация протухает по maxAge', () => {
    feedFromStatusReply(1000.0, 100, 200)
    vi.spyOn(performance, 'now').mockReturnValue(200)
    expect(syncFresh(5000)).toBe(true)
    expect(syncFresh(0)).toBe(true) // ровно на границе ещё свежо
    vi.spyOn(performance, 'now').mockReturnValue(201)
    expect(syncFresh(0)).toBe(false)
    expect(syncFresh(5000)).toBe(true)
  })

  it('serverNow бросает без синхронизации', () => {
    expect(() => serverNow()).toThrow('Нет синхронизации')
  })
})
