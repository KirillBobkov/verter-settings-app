/** Зеркало конвертов робота (docs/NATS_CONTRACTS_V1.md). */

/** Конверт метрики в public subject и KV. */
export interface MetricEnvelope {
  v: 1
  value: number | boolean | string | object | null
  unit: string | null
  sample_at: number | null
  updated_at: number
  sample_id: string | null
  quality: 'ok' | 'stale' | 'unavailable'
  max_age_s: number
}

export interface BmsStatus {
  status: string
  connected: boolean
  error: string | null
  device: { model: string; hardware: string; software: string } | null
  heartbeat_age_s: number | null
  sample_age_s: number | null
  rssi_at_connect_dbm: number | null
}

export interface ModeState {
  owner: string
  actual: string
  desired: string
  stale: boolean
  operation: {
    id: string | null
    status: 'running' | 'succeeded' | 'failed' | null
    requested_mode: string | null
    error: string | null
  } | null
  execution_enabled: boolean
}

export interface RobotSnapshot {
  v: number
  robot_id: string
  boot_id: string
  updated_at: number
  uptime_s: number
  mode: ModeState
  battery?: unknown
  movement_api?: unknown
  manual_control?: unknown
}
