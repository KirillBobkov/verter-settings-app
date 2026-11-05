/**
 * KV робота: bucket VERTER_01_STATE живёт в JetStream-домене verter_01 НА РОБОТЕ;
 * через leaf-линк хаба доменные субъекты $JS.verter_01.API.* маршрутизируются
 * к нему. Домен задаётся на JetStream-клиенте (Kvm опций не принимает).
 * watch() создаёт ephemeral push-consumer с flow_control — поэтому в ACL
 * хаба нужен publish $JS.FC.>.
 */
import type { NatsConnection } from '@nats-io/nats-core'
import { jetstream } from '@nats-io/jetstream'
import { Kvm, type KvEntry, type KvWatchEntry, type KV } from '@nats-io/kv'
import { BUCKET, JS_DOMAIN } from './subjects'

export async function openRobotKv(nc: NatsConnection): Promise<KV> {
  const js = jetstream(nc, { domain: JS_DOMAIN }) // доменные $JS.verter_01.API.* — основной путь
  const kvm = new Kvm(js)
  return kvm.open(BUCKET)
}

export type { KvEntry, KvWatchEntry, KV }
