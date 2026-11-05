/**
 * Стор соединения с хабом: единая точка жизненного цикла ws-подключения.
 * Креды и адрес — из localStorage (вводятся оператором на «Настройках»).
 */
import { create } from 'zustand'
import type { NatsConnection } from '@nats-io/nats-core'
import { connect, watchStatus, type ConnState } from '../lib/nats/connection'
import { loadCreds } from '../lib/nats/auth'
import { loadRuntimeConfig, type RuntimeConfig } from '../lib/config/runtime-config'

interface ConnectionStore {
  config: RuntimeConfig | null
  nc: NatsConnection | null
  state: ConnState
  error: string | null
  connectedAt: number | null
  init: () => Promise<void>
  reconnect: () => Promise<void>
  disconnect: () => Promise<void>
  applyConfig: (cfg: RuntimeConfig) => void
}

let stopStatusWatch: (() => void) | null = null

export const useConnection = create<ConnectionStore>((set, get) => ({
  config: null,
  nc: null,
  state: 'idle',
  error: null,
  connectedAt: null,

  init: async () => {
    const cfg = await loadRuntimeConfig()
    set({ config: cfg })
    if (loadCreds()) await doConnect(cfg, set, get)
  },

  reconnect: async () => {
    const cfg = get().config ?? (await loadRuntimeConfig())
    set({ config: cfg })
    await doConnect(cfg, set, get)
  },

  disconnect: async () => {
    stopStatusWatch?.()
    stopStatusWatch = null
    const nc = get().nc
    set({ nc: null, state: 'idle', connectedAt: null, error: null })
    await nc?.close().catch(() => undefined)
  },

  applyConfig: (cfg) => set({ config: cfg }),
}))

async function doConnect(
  cfg: RuntimeConfig,
  set: (p: Partial<ConnectionStore>) => void,
  get: () => ConnectionStore,
): Promise<void> {
  const creds = loadCreds()
  if (!creds) {
    set({ state: 'idle', error: 'Нет кредов — введите на странице «Настройки»' })
    return
  }
  stopStatusWatch?.()
  await get().nc?.close().catch(() => undefined)
  set({ state: 'connecting', error: null, nc: null, connectedAt: null })
  try {
    const nc = await connect(cfg.natsWsUrl, creds)
    stopStatusWatch = watchStatus(nc, (type) => {
      const cur = get()
      if (!cur.nc) return
      if (type === 'disconnect') set({ state: 'reconnecting' })
      else if (type === 'reconnect') set({ state: 'connected', connectedAt: Date.now(), error: null })
    })
    set({ nc, state: 'connected', connectedAt: Date.now(), error: null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    set({ state: 'error', error: msg, nc: null })
  }
}
