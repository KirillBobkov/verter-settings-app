# verter-settings-app — веб-интерфейс робота Verter

React-приложение (GitHub Pages), подключающееся напрямую к NATS-хабу робота
`verter_01` по wss. Замена SSH-туннеля к локальному UI :8088. Полный план
миграции — репозиторий `nats-hub`, `docs/PLAN.md` (Часть D).

## Стек

Vite 8 · React 19 · TypeScript 6 · react-router-dom 7 (HashRouter) ·
@nats-io/nats-core/kv/jetstream 3.4 (WebSocket-клиент NATS) · zustand 5 ·
vitest 5 · eslint 9 (flat). Node 22 (Node 20 — EOL, не использовать).

## Быстрый старт

```sh
npm ci
npm run dev        # http://localhost:5173 (Origin уже в allowed_origins хаба)
npm run lint && npm run typecheck && npm run test -- --run && npm run build
```

Для подключения нужен файл кредов `ui-<имя>.creds` (см. docs/OPERATORS.md).
Без кредов приложение откроется, но будет ждать их на «Настройках».

## Архитектура

```
GitHub Pages (этот репозиторий)  ──wss:443──►  NATS-хаб (VPS)  ◄──leaf:7422 TLS──  робот verter_01
```

- **Никаких кредов в коде/бандле/репо.** Креды вводит оператор (localStorage).
- `src/lib/nats/` — единственный слой работы с NATS:
  - `connection.ts` — wsconnect + credsAuthenticator, бесконечный reconnect;
  - `clock.ts` — серверные часы Jetson (образцы из reply `cmd_vel.command.status`,
    допуск будущего 0.5 с; без свежей синхронизации motion-команды не отправляются);
  - `envelope.ts` — командный конверт v1 (без поля action!);
  - `request.ts` — request/reply с таймаутами по классу команды, без авто-ретраев;
  - `kv.ts` — bucket `VERTER_01_STATE` через JetStream-домен `verter_01`
    (KV физически на роботе, хаб только маршрутизирует);
  - `subjects.ts` — реестр субъектов и таймауты.
- `public/config.json` — runtime-конфиг (адрес хаба не инлайнится в бандл;
  меняется без пересборки, override в «Настройках»).
- Роутинг — HashRouter (`#/`, `#/map`, …): GitHub Pages не делает SPA-реврайтов.

## Деплой

`git push origin main` → GitHub Actions (`lint → typecheck → test → build → Pages`).
Однократно: Settings → Pages → Source = **GitHub Actions**.
После первого деплоя заменить в `public/config.json` адрес хаба на реальный
и проверить, что Origin сайта есть в `allowed_origins` хаба.

## Дорожная карта (фазировка из плана, Часть D)

| Фаза | Что входит | Статус |
|---|---|---|
| M0 | Каркас, NATS-слой, «Настройки» (креды, адрес, JWT-экспирация), мониторинг-скелет, CI | ✅ этот коммит |
| M1 | Полный мониторинг (снимок, BMS-панель, режимы, заметка, контракт) + DrivePad (порт drive.js: шаги 0.01 м/с / 0.05 рад/с, lease 1 с, keepalive 200 мс, клавиатура) | ⏳ |
| M2 | Живая карта (map.update.*, чанковая загрузка, OpenLayers, скан, модель робота) | ⏳ |
| M3 | История BMS (графики, клиентский экспорт CSV/TXT) + локализация/точки/маршруты | ⏳ |
| M4 | Лидар через NATS; камера: статус+сигналинг, заглушка TURN | ⏳ |

Контракты робота — копии в `docs/contracts/` (синхронизировать при изменении
версии контракта в репозитории робота).

## Безопасность

- Scoped-ключ `ui` хаба ограничивает клиента субъектами `verter_01.*` и
  read-only KV; подробности — `docs/hub.md`.
- Программный стоп ≠ аппаратный аварийный выключатель; ручное управление не
  включает объезд препятствий (подпись продублирована в футере UI).
