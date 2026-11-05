/**
 * Реестр субъектов робота verter_01 (NATS_CONTRACTS_V1 + ACL хаба).
 * robotId подставляется из runtime-конфига, для verter_01 это 'verter_01'.
 */

export function serviceSubject(robotId: string, name: string): string {
  return `${robotId}.service.command.${name}`
}

export function cmdVelSubject(robotId: string, op: 'status' | 'set' | 'keepalive' | 'stop'): string {
  return `${robotId}.cmd_vel.command.${op}`
}

export function mapSubject(robotId: string, op: 'get' | 'save'): string {
  return `${robotId}.map.command.${op}`
}

export function batterySubject(robotId: string, op: 'history'): string {
  return `${robotId}.battery.command.${op}`
}

/** Все update-потоки робота (battery/service/topic/node/cmd_vel/map/lidar/...). */
export function allUpdates(robotId: string): string {
  return `${robotId}.*.update.>`
}

/** Таймауты по классу команды (порт web.py + map.js робота). */
export const REQUEST_TIMEOUTS_MS = {
  cmdVel: 1200,
  mapGet: 5000,
  mapGetChunk: 6000,
  mapSave: 10000,
  spatial: 10000, // localization / waypoint / route
  service: 20000,
  batteryHistory: 25000,
  camera: 20000,
} as const

export const BUCKET = 'VERTER_01_STATE'
export const JS_DOMAIN = 'verter_01'
