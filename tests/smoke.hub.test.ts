/**
 * Дымовой тест клиентского слоя против ЛОКАЛЬНОГО репетиционного стенда
 * (см. nats-hub README, «Локальная репетиция»): хаб на wss://127.0.0.1:18443,
 * leaf-«робот» на 14223 с fake-bridge. Запускается только при SMOKE_HUB=1:
 *
 *   SMOKE_HUB=1 npx vitest run tests/smoke.hub.test.ts
 *
 * Требует Node 22+ (глобальный WebSocket). В обычном CI (без стенда) — пропускается.
 */
import { describe, it, expect } from 'vitest'

const SMOKE = !!process.env.SMOKE_HUB

describe.skipIf(!SMOKE)('дым: клиентский слой против репетиционного хаба', () => {
  it('connect + статус + clock + ping + updates + kv watch', async () => {
    const { readFileSync } = await import('node:fs')
    const { connect } = await import('../src/lib/nats/connection')
    const { makeEnvelope, makeStatusEnvelope } = await import('../src/lib/nats/envelope')
    const { command } = await import('../src/lib/nats/request')
    const { feedFromStatusReply, serverNow, syncFresh } = await import('../src/lib/nats/clock')
    const { serviceSubject, cmdVelSubject, allUpdates, REQUEST_TIMEOUTS_MS } = await import(
      '../src/lib/nats/subjects'
    )
    const { openRobotKv } = await import('../src/lib/nats/kv')

    const creds = readFileSync('/tmp/hubtest/ui-operator.creds', 'utf8')
    const nc = await connect('wss://127.0.0.1:18443', creds)
    expect(nc).toBeTruthy()

    // 1) статус (bootstrap-конверт) -> кормим часы (как будет делать DrivePad каждые 250 мс)
    const sentAt = performance.now()
    const st = await command(nc, cmdVelSubject('verter_01', 'status'), makeStatusEnvelope(), REQUEST_TIMEOUTS_MS.cmdVel)
    const receivedAt = performance.now()
    expect(st.result).toHaveProperty('enabled', true)
    feedFromStatusReply(st.at, sentAt, receivedAt)
    expect(syncFresh(5000)).toBe(true)
    const skew = Math.abs(serverNow() - Date.now() / 1000)
    expect(skew).toBeLessThan(5) // часы стенда и теста близки

    // 2) подписка на обновления ДО запросов (интерес протягивается через leaf)
    const got: string[] = []
    const sub = nc.subscribe(allUpdates('verter_01'))
    const updatesPromise = new Promise<string>((resolve) => {
      void (async () => {
        for await (const m of sub) {
          got.push(m.subject)
          resolve(m.subject)
        }
      })().catch(() => undefined)
    })

    // 3) ping с issued_at из серверных часов
    const pong = await command(nc, serviceSubject('verter_01', 'ping'), makeEnvelope(5, {}), 3000)
    expect(pong.result).toEqual({ pong: true, boot_id: 'fake-bridge' })

    // 4) живое обновление battery.update.soc от fake-bridge
    await expect(updatesPromise).resolves.toBe('verter_01.battery.update.soc')

    // 5) KV через leaf: watch с flow-control (путь браузера)
    const kv = await openRobotKv(nc)
    const entry = await kv.get('battery.soc')
    expect(entry).toBeTruthy()
    const metric = entry!.json() as { v: number; unit: string; value: number }
    expect(metric).toMatchObject({ v: 1, unit: '%' })
    expect(typeof metric.value).toBe('number')
    const watch = await kv.watch()
    const first = await new Promise<{ key: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('kv watch: нет начального значения')), 8000)
      void (async () => {
        for await (const e of watch) {
          clearTimeout(t)
          resolve({ key: e.key })
          break
        }
      })().catch(reject)
    })
    expect(['battery.soc', 'service.note']).toContain(first.key)

    sub.unsubscribe()
    await nc.drain()
    expect(got.length).toBeGreaterThan(0)
  }, 30000)
})
