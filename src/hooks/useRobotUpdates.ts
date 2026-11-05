import { useEffect, useState } from 'react'
import { useConnection } from '../stores/connection'
import { allUpdates } from '../lib/nats/subjects'
import type { MetricEnvelope } from '../lib/contracts/types'

export interface LiveMetric {
  subject: string
  at: number
  envelope: MetricEnvelope
}

/** Живые метрики робота: подписка verter_01.*.update.> (interest-based через leaf). */
export function useRobotUpdates(max = 40): LiveMetric[] {
  const nc = useConnection((s) => s.nc)
  const [metrics, setMetrics] = useState<LiveMetric[]>([])

  useEffect(() => {
    if (!nc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс при разрыве соединения
      setMetrics([])
      return
    }
    const sub = nc.subscribe(allUpdates('verter_01'))
    void (async () => {
      for await (const m of sub) {
        let env: MetricEnvelope
        try {
          env = m.json<MetricEnvelope>()
        } catch {
          continue
        }
        setMetrics((prev) => {
          const next = [{ subject: m.subject, at: Date.now(), envelope: env }, ...prev]
          return next.slice(0, max)
        })
      }
    })().catch(() => undefined)
    return () => {
      sub.unsubscribe()
    }
  }, [nc, max])

  return metrics
}
