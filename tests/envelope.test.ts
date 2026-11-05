import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeEnvelope } from '../src/lib/nats/envelope'
import { feedFromStatusReply, resetClock } from '../src/lib/nats/clock'
import { credsLooksValid, decodeJwtExp } from '../src/lib/nats/auth'

function b64url(o: object): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('makeEnvelope (контракт NATS_CONTRACTS_V1)', () => {
  beforeEach(() => resetClock())
  afterEach(() => vi.restoreAllMocks())

  it('без синхронизации часов конверт не создаётся', () => {
    expect(() => makeEnvelope(1, {})).toThrow('Нет синхронизации')
  })

  it('issued_at из серверных часов, целое; v=1; ttl как задан', () => {
    feedFromStatusReply(1790856000.0, 100, 200)
    vi.spyOn(performance, 'now').mockReturnValue(250) // +50 мс к midpoint → serverNow = ...000.05
    const env = makeEnvelope(1, { session_id: 'x', seq: 1, linear_x: 0, angular_z: 0 })
    expect(env.v).toBe(1)
    expect(env.issued_at).toBe(1790856000)
    expect(env.ttl_s).toBe(1)
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(env).length).toBeLessThan(4096) // лимит cmd_vel
  })
})

describe('creds-файл оператора', () => {
  const validCreds = [
    '-----BEGIN NATS USER JWT-----',
    `eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.${b64url({ exp: 1900000000, name: 'ui-operator' })}.c2ln`,
    '------END NATS USER JWT------',
    '',
    '-------BEGIN USER SEED-------',
    'SUAAQWERTYUIOPASDFGHJKLZXCVBNMQWERTYUIOPASDFGHJKLZXCVBNM',
    '-------END USER SEED-------',
  ].join('\n')

  it('распознаёт валидный формат', () => {
    expect(credsLooksValid(validCreds)).toBe(true)
    expect(credsLooksValid('мусор')).toBe(false)
  })

  it('достаёт exp из JWT', () => {
    expect(decodeJwtExp(validCreds)).toBe(1900000000)
  })
})
