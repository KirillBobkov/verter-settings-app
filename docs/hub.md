# Адрес хаба и происхождение wss

UI подключается напрямую к NATS-хабу по защищённому WebSocket:

- URL по умолчанию: `public/config.json` → `natsWsUrl` (например `wss://nats.example.com:443`).
- Override для staging: «Настройки» → поле override (localStorage), без пересборки.
- Origin `https://<owner>.github.io` должен быть в `allowed_origins` конфига хаба
  (репозиторий nats-hub, `config/nats-server.conf.template`).

Схема аутентификации: индивидуальные user-креды (JWT+seed) аккаунта `ROBOTS`
хаба, scoped-ключ `ui` (права только на субъекты `verter_01.*` и KV-чтение).
Подробности топологии — в репозитории `nats-hub` (README, «Состав» и Часть C
плана в docs/PLAN.md).

Контракты робота (субъекты, конверты, TTL) — `docs/contracts/` и оригиналы
в репозитории робота `verter-robot/docs/NATS_CONTRACTS_V1.md`.
