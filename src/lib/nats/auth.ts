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

/**
 * Приводит вставленные креды к каноническому виду: вырезает JWT и seed,
 * склеивая разорванные переносами строк значения (при копировании из
 * терминала/мессенджера длинные строки рвутся — это чиним). Комментарии
 * из исходного файла отбрасываются.
 */
export function sanitizeCreds(creds: string): string | null {
  const jwt = creds.match(/BEGIN NATS USER JWT-+\s*([A-Za-z0-9_.-]+)\s*-+END/)?.[1] ?? ''
  const seed = creds.match(/^SU[A-Za-z0-9]{56}$/m)?.[0] ?? ''
  if (!jwt || !seed) return null
  return [
    '-----BEGIN NATS USER JWT-----',
    jwt.replace(/\s+/g, ''),
    '------END NATS USER JWT------',
    '',
    '-----BEGIN USER NKEY SEED-----',
    seed,
    '------END USER NKEY SEED------',
    '',
  ].join('\n')
}

/** Валидны ли креды (формат nats CLI: блоки NATS USER JWT и USER NKEY SEED). */
export function credsLooksValid(creds: string): boolean {
  const hasJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/m.test(creds)
  const hasSeed = /^SU[A-Za-z0-9]{56}$/m.test(creds)
  const hasMarkers = /BEGIN NATS USER JWT/.test(creds) && /USER NKEY SEED/.test(creds)
  return hasMarkers && hasJwt && hasSeed
}

/** Unix-время истечения JWT (payload.exp) или null. */
export function decodeJwtExp(credsText: string): number | null {
  const payload = decodeJwtPayload(credsText)
  return payload ? (typeof payload.exp === 'number' ? payload.exp : null) : null
}

/** Имя пользователя из JWT (payload.name) или null. */
export function decodeJwtName(credsText: string): string | null {
  const payload = decodeJwtPayload(credsText)
  return payload ? (typeof payload.name === 'string' ? payload.name : null) : null
}

function decodeJwtPayload(credsText: string): Record<string, unknown> | null {
  const jwt = credsText
    .split(/-----?[A-Z ]*NATS USER JWT-*/)
    .map((s) => s.trim())
    .find((b) => b.startsWith('eyJ'))
  if (!jwt) return null
  try {
    return JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}
