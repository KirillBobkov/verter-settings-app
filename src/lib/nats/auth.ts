/**
 * Креды оператора: только ручной ввод (страница «Настройки»), хранение в
 * localStorage. Никаких кредов в коде, бандле или репозитории.
 */

const STORAGE_KEY = 'verter.ui.creds'

export function loadCreds(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveCreds(creds: string): void {
  localStorage.setItem(STORAGE_KEY, creds)
}

export function forgetCreds(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** Учетные данные содержат JWT (строка eyJ...) и seed (строка SU...). */
export function credsLooksValid(creds: string): boolean {
  const hasJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/m.test(creds)
  const hasSeed = /^SU[A-Za-z0-9]{54}$/m.test(creds)
  const hasMarkers = creds.includes('-----BEGIN NATS USER JWT-----') && creds.includes('-----BEGIN USER SEED')
  return hasMarkers && hasJwt && hasSeed
}

/** Unix-время истечения JWT (payload.exp) или null. */
export function decodeJwtExp(credsText: string): number | null {
  const jwt = credsText
    .split(/-----[A-Z ]+-----/)
    .map((s) => s.trim())
    .find((b) => b.startsWith('eyJ'))
  if (!jwt) return null
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** Имя пользователя из JWT (payload.name) или null. */
export function decodeJwtName(credsText: string): string | null {
  const jwt = credsText
    .split(/-----[A-Z ]+-----/)
    .map((s) => s.trim())
    .find((b) => b.startsWith('eyJ'))
  if (!jwt) return null
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.name === 'string' ? payload.name : null
  } catch {
    return null
  }
}
