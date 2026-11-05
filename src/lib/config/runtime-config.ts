/**
 * Runtime-конфиг: public/config.json попадает в dist как есть (не инлайнится,
 * в отличие от VITE_*). Адрес хаба можно переопределить в localStorage
 * (страница «Настройки») без пересборки.
 */

export interface RuntimeConfig {
  natsWsUrl: string
  robotId: string
}

const OVERRIDE_KEY = 'verter.ui.natsWsUrl'

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await fetch('config.json')
  if (!res.ok) throw new Error(`Не удалось загрузить config.json: ${res.status}`)
  const cfg = (await res.json()) as Partial<RuntimeConfig>
  let natsWsUrl = cfg.natsWsUrl
  if (!natsWsUrl || !/^wss?:\/\//.test(natsWsUrl)) throw new Error('config.json: некорректный natsWsUrl')
  try {
    const override = localStorage.getItem(OVERRIDE_KEY)
    if (override && /^wss?:\/\//.test(override)) natsWsUrl = override
  } catch {
    /* localStorage недоступен */
  }
  return { natsWsUrl, robotId: cfg.robotId ?? 'verter_01' }
}

export function getWsUrlOverride(): string | null {
  try {
    return localStorage.getItem(OVERRIDE_KEY)
  } catch {
    return null
  }
}

export function setWsUrlOverride(url: string | null): void {
  if (url === null) localStorage.removeItem(OVERRIDE_KEY)
  else localStorage.setItem(OVERRIDE_KEY, url)
}
