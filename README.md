# verter-settings-app — веб-интерфейс робота Verter

Оригинальный интерфейс робота (`verter-robot/services/nats_bridge/static`),
размещённый на GitHub Pages и подключённый напрямую к NATS-хабу по wss.
Код страниц не изменён — добавлена только прослойка, выполняющая те же
HTTP-вызовы `/api/*` через NATS (зеркало `robot_nats/web.py`).

## Архитектура

```
GitHub Pages (site/, статика)  ──wss:443──►  NATS-хаб (VPS)  ◄──leaf:7422──  робот verter_01
```

| Файл | Назначение |
|---|---|
| `site/index.html`, `app.js`, `drive.js`, `map.*`, `battery-history.*`, … | Оригинальные страницы робота (копия 1:1) |
| `site/lib/nats-core.iife.js` | Браузерный бандл `@nats-io/nats-core@3.4.0` (esbuild; SHA в `lib/manifest.json`) |
| `site/nats-api-core.js` | Ядро: action→subject, конверты, таймауты — зеркало `web.py`. E2E-проверен на живом хабе |
| `site/api-shim.js` | Перехват `fetch('/api/*')`, панель настроек NATS (⚙ справа внизу), клиентский экспорт батареи |
| `site/config.js` | Адрес хаба и robotId (runtime, без пересборки) |

Отличия от локальной версии: окна камеры (8089) и лидара (8090) скрыты —
они живут на роботе и недоступны с GitHub Pages; экспорт батареи выполняется
в браузере (постранично `battery.history {raw:true}` → CSV/TXT как в
`history_export.py`); ссылки `/map`, `/battery-history` ведут на `map.html`,
`battery-history.html`.

## Первый вход

1. Откройте сайт, щёлкните **⚙ справа внизу**.
2. Вставьте креды `ui-<имя>.creds` (выдаёт администратор хаба; передаются по
   защищённому каналу), при необходимости укажите другой сервер.
3. «Сохранить и подключиться». Креды хранятся только в localStorage браузера.

## Деплой

`git push origin main` → GitHub Actions (проверка синтаксиса JS → Pages).
Однократно: Settings → Pages → Source = GitHub Actions.

## Локальная проверка

```sh
cd site && python3 -m http.server 5173   # origin http://localhost:5173 уже разрешён на хабе
```

E2E ядра против живого хаба (Node 22+, креды в ~/nats-hub):
см. историю — сценарий покрывает state/metrics/drive/map/history/ping/cmd_vel.

## Дорожная карта

- [x] Миграция оригинального UI 1:1 + NATS-прослойка (этот коммит)
- [ ] React-версия (M1 мониторинг+управление → M4) — после обкатки статической

Контракты робота — `docs/contracts/`. План целиком — репозиторий `nats-hub`.
