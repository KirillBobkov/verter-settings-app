# Контракт NATS робота — версия 1.7

Документ предназначен для разработчика серверного приложения, локального приложения и веб-интерфейса. Это контракт работающего Python backend. Поле JSON `v` равно **1**, редакция каталога контрактов — **1.7**.

## 1. Подключение и границы реализации

На Jetson NATS слушает `127.0.0.1:4222`; отладочный HTTP — порт 8088, в текущей конфигурации bind `0.0.0.0` с явным Host allowlist. NATS требует учётные данные. Отладочный HTTP в доверенной сети работает без токена; проверки Host/Origin сохранены. Учётные данные передаются разработчику отдельно, в документ их не включать.

Робот: `verter_01`. JetStream domain: `verter_01`. KV bucket: `VERTER_01_STATE`. Эти параметры получать из конфигурации, не зашивать в общий клиент для всех роботов. Категория `<domain>` в subject НЕ является JetStream domain.

Подключение к реальному центральному серверу ещё не настроено: в рабочей конфигурации `leafnodes.remotes` пуст. Подключение и ACL центрального сервера требуют отдельной настройки. Пока удалённый клиент может использовать SSH-туннель:

```sh
ssh -p 3333 -N -L 4222:127.0.0.1:4222 -L 8088:127.0.0.1:8088 jetson@109.195.134.20
```

Реализованы чтение состояния, каталог, метрики, заметка и API режимов. Разрешение переключения режимов задаётся локальным allow_mode_changes; runtime state является источником истины. Ручное управление скоростью реализовано; полный контракт приведён в разделе 8. Запуск/остановка произвольных сервисов/узлов, публикация произвольных ROS-топиков и запись настроек BMS не реализованы.

## 2. Имена subjects

```text
<robot_id>.<domain>.<action>.<name>
```

- `robot_id`: идентификатор робота, один токен без `.`, пробелов, `*`, `>`; рекомендуемый набор `[A-Za-z0-9_-]+`.
- `domain`: `battery`, `service`, `node`, `topic`; `cmd_vel` используется ручным управлением (раздел 8), `camera` — отдельным [API камеры](CAMERA_API_V1.md), `lidar` — [потоковым API лидара](LIDAR_API_V1.md).
- `action`: `update` или `command`.
- `name`: идентификатор метрики/операции, один токен. Имена фиксируются каталогом.

Примеры подписок:

```text
verter_01.battery.update.*       # все показатели батареи, включая snapshot
verter_01.*.update.>             # все обновления робота
*.battery.update.soc            # SOC всех доступных роботов
verter_01.service.update.bms     # состояние сборщика BMS
```

Данные в UTF-8 JSON, числа передаются числами, логические значения — `true`/`false`. NaN/Infinity не допускаются. Отсутствие значения обозначается `null`, не нулём. Клиент должен игнорировать неизвестные добавленные поля и метрики; неизвестную версию `v` — отклонять. Несовместимые изменения требуют новой версии контракта и согласованной миграции.

## 3. Сообщение update и KV-значение

Одинаковый конверт используется в public subject и соответствующем KV-ключе:

```json
{
  "v": 1,
  "value": 77,
  "unit": "%",
  "sample_at": 1790856000.125,
  "updated_at": 1790856000.750,
  "sample_id": "bms-boot-uuid:185",
  "quality": "ok",
  "max_age_s": 8
}
```

Значения примера условные.

| Поле | Тип | Семантика |
|---|---|---|
| `v` | integer | Версия конверта, 1 |
| `value` | number/integer/boolean/string/array/object/null | Тип определяется конкретной метрикой |
| `unit` | string/null | `%`, `V`, `A`, `W`, `Ah`, `degC`, `m`, `rad/s` и др.; null, если единица неприменима |
| `sample_at` | number/null | Unix seconds UTC; время получения исходного измерения на Jetson |
| `updated_at` | number | Unix seconds UTC; время формирования публикации bridge |
| `sample_id` | string/null | Идентификатор исходного кадра/наблюдения; не порядковый номер KV |
| `quality` | string | `ok`, `stale` или `unavailable` |
| `max_age_s` | number | Максимальный допустимый возраст значения для потребителя |

`ok` означает свежесть и наличие данных, а не физическую точность, успешную локализацию или отсутствие аварии. `stale` — прежнее измерение с истёкшей свежестью/потерей источника. `unavailable` — измерение ещё не получено или неприменимо; обычно `value:null`. `battery.charging_state` при неизвестности содержит строку `unknown`. У `service.kv_error` значение null с качеством ok означает отсутствие зарегистрированной ошибки.

Потребитель обязан самостоятельно проверять и `sample_at`, и `updated_at`. Даже если сохранённый `quality` равен ok, считать значение устаревшим, когда возраст любого времени превышает `max_age_s`. Время заметно из будущего также не считать валидным; синхронизировать часы клиента и Jetson. Допуск расхождения часов рекомендуется не более 2 с.

Bridge публикует полный набор примерно раз в 2 с (пауза после прохода). Повторная публикация прежнего кадра обновляет `updated_at`, но НЕ `sample_at` или идентичность измерения. Не нужно считать её новым физическим измерением. BMS получает `sample_id=<boot UUID сборщика>:<счётчик валидных кадров>`. ROS использует идентификатор с boot UUID bridge и временем получения ROS-сообщения; это не аппаратный timestamp сенсора.

Публикации разных метрик и записи разных KV-ключей не атомарны. Показатели одного кадра BMS имеют одинаковые `sample_id` и `sample_at`. Для согласованного чтения всей батареи использовать `battery.snapshot`. Снимок всего робота содержит источники разного возраста и не означает синхронное измерение всех датчиков.

## 4. Каталог батареи

Для каждой строки subject: `<robot_id>.battery.update.<name>`, KV: `battery.<name>`. Максимальный возраст — 8 с.

| name | Тип value | unit | Поле декодера |
|---|---|---|---|
| `soc` | number | % | `soc_pct` |
| `voltage` | number | V | `voltage_V` |
| `current` | number | A | `current_A` |
| `power` | number | W | `power_W` |
| `remaining_capacity` | number | Ah | `remaining_Ah` |
| `full_charge_capacity` | number | Ah | `full_charge_capacity_Ah` |
| `cycles` | integer | null | `cycles` |
| `temperature_mos` | number | degC | `mos_temperature_C` |
| `temperature_1` | number | degC | `temperature_1_C` |
| `temperature_2` | number | degC | `temperature_2_C` |
| `cell_sum` | number | V | `cell_sum_V` |
| `cell_delta` | number | V | `cell_delta_V` |
| `balance_current` | number | A | `balance_current_A` |
| `balance_state` | integer | null | `balance_state` |
| `charging_enabled` | boolean | null | `charging_enabled` |
| `discharging_enabled` | boolean | null | `discharging_enabled` |
| `flags_raw` | string | null | `flags_raw` |

Дополнительные метрики:

| name | Тип value | Описание |
|---|---|---|
| `charging_state` | string | `charging`, `discharging`, `idle`, `unknown` |
| `cell_01_voltage` … `cell_32_voltage` | number, V | Публикуются для присутствующих ячеек; сейчас 7. Нумерация с 01 |
| `snapshot` | object | Полный снимок BMS, формат ниже |

`charging_state` вычисляет backend: ток > +0,1 А → `charging`; < −0,1 А → `discharging`; от −0,1 до +0,1 А включительно → `idle`; устаревшие/отсутствующие данные → `unknown`. Знак тока взят из JK-протокола; независимо измерителем не проверялся. `idle` не означает ни полный заряд, ни отсутствие зарядного устройства.

`charging_enabled` / `discharging_enabled` — разрешение соответствующих MOSFET, а не фактический ток. Поля ёмкости предварительные и требуют сверки с приложением JK. `flags_raw` и числовой `balance_state` передаются без обещания интерпретации для SW19.31; не преобразовывать неизвестные биты в аварии.

Значение `battery.snapshot` содержит:

```text
v, robot_id, boot_id, updated_at, address, source="ble",
status, connected, device={model,hardware,software},
rssi_at_connect_dbm, error, sample_id, sample_at, sample_age_s,
heartbeat_age_s, stale, charging_state,
diagnostics={valid_frames,invalid_checksums,decode_errors,connections},
sample={voltage_V,current_A,soc_pct,power_W,cells_V,
        cell_sum_V,cell_delta_V,remaining_Ah,full_charge_capacity_Ah,cycles,
        mos_temperature_C,temperature_1_C,temperature_2_C,
        balance_current_A,balance_state,charging_enabled,discharging_enabled,
        flags_raw,flags_interpretation,protocol}
```

`cells_V` — объект с ключами `"1"`, `"2"`, … и значениями напряжения. `sample` и `device` могут быть null до получения данных. В первоначальном состоянии `waiting` часть полей снимка ещё отсутствует; обязательны `status`, `connected`, `stale`, `sample_age_s`, `heartbeat_age_s`, `sample`, `device`, `error`, `charging_state`.

Состояния BMS: `waiting`, `starting`, `scanning`, `connecting`, `identifying`, `waiting_sample`, `streaming`, `reconnecting`, `stopped`, `publisher_lost`. `connected:true` само по себе не гарантирует свежего измерения. BLE-пароли и сырые device-info кадры не публикуются.

## 5. Сервисы, ROS-метрики и узлы

Для сервисов subject `<robot_id>.service.update.<name>`, KV `service.<name>`, срок актуальности 8 с:

| name | value |
|---|---|
| `bms` | `{status,connected,error,device,heartbeat_age_s,sample_age_s,rssi_at_connect_dbm,diagnostics}` |
| `bridge` | `{boot_id,uptime_s,ros_error}` |
| `mode` | `{owner,actual,desired,map,map_path,operation,stale,error,updated_at,started_at,execution_enabled,scope,pid,exit_code,localization_verified}` |
| `transport_connected` | boolean, соединение bridge с NATS |
| `kv_error` | string/null, ошибка предыдущего прохода записи KV |
| `note` | string, сохранённая заметка оператора |
| `schema` | Машиночитаемый каталог, такой же объект, как ответ schema_get |
| `snapshot` | Полный снимок робота: `v,robot_id,boot_id,updated_at,uptime_s,mode,telemetry,settings,battery,transport,movement_api,manual_control,manager_replaced` |

`service.mode` отражает единый supervisor. NATS и CLI управляют одними ROS-режимами idle/mapping/localization/navigation. Адаптер bridge не владеет ROS-процессами. Полный контракт принятия операций и наблюдения: [NATS_MODES_V1.md](NATS_MODES_V1.md). Поле manager_replaced сохранено для совместимости и не подтверждает запуск прежнего manager. Для подтверждения положения используется `localization.state.verified` из [LOCALIZATION_API_V1.md](LOCALIZATION_API_V1.md); совместимое поле mode.localization_verified остаётся false.

`service.bms` может иметь quality ok и value.status publisher_lost: это свежее наблюдение bridge о недоступности BMS. При потере самого bridge новых сообщений вообще не будет — обнаруживать это по возрасту. `transport_connected:true` в сохранённом KV не доказывает, что связь существует сейчас.

Для ROS subject `<robot_id>.topic.update.<name>`, KV `topic.<name>`, срок актуальности 5 с:

| name | Источник снимка | Поле | unit |
|---|---|---|---|
| `imu_gyro_z` | imu | `gyro_z` | rad/s |
| `imu_accel_norm` | imu | `accel_norm` | m/s^2 |
| `scan_points` | lidar | `points` | null |
| `scan_valid_points` | lidar | `valid_points` | null |
| `scan_frame` | lidar | `frame` | null |
| `odometry_x` | odometry | `x` | m |
| `odometry_y` | odometry | `y` | m |
| `odometry_vx` | odometry | `vx` | m/s |
| `odometry_wz` | odometry | `wz` | rad/s |
| `localization_x` | localization | `x` | m |
| `localization_y` | localization | `y` | m |
| `localization_covariance` | localization | `covariance` | null |
| `map_width` | map | `width` | cell |
| `map_height` | map | `height` | cell |
| `map_resolution` | map | `resolution` | m/cell |
| `map_to_odom_x` | map_to_odom | `x` | m |
| `map_to_odom_y` | map_to_odom | `y` | m |
| `cmd_vel_publishers` | graph | `cmd_vel_publishers` | null |

Дополнительно:

- `imu_status`: объект исходной диагностики IMU (при ошибке разбора `{"parse_error":true}`).
- `graph`: объект со списками `nodes` (короткие имена), `full_node_names` (полные имена ROS), `cmd_vel_publishers`.
- `ultrasonic_<position>`: number/null, метры. Позиции: `right`, `front_right_outer`, `front_right_inner`, `front_center`, `front_left_inner`, `front_left_outer`, `left`. Порядок взят из прошивки и физически ещё не проверен. Значение 10,0 м исходного массива — sentinel отсутствия эха: в публичной метрике становится null/unavailable. Исходный массив обновляется по одному каналу; время массива не является подтверждённым временем измерения каждого канала.

Статистика лидара не содержит сырых точек. Метрики карты содержат размеры и разрешение, но не всю occupancy grid. Ковариация AMCL передаётся массивом 36 чисел в ROS-порядке; малая ковариация не доказывает правильное положение робота. Нормировка акселерометра остаётся отдельным вопросом калибровки.

Узлы:

- `<robot_id>.node.update.list`, KV `node.list`: список уникальных полных ROS-имён.
- `<robot_id>.node.update.<node_id>`, KV `node.<node_id>`: `{"name":"/sensors/imu","present":true}`.
- `node_id` — UTF-8 полного ROS-имени, закодированное base64url без `=`. Например Python: `base64.urlsafe_b64encode(name.encode()).decode().rstrip('=')`. Это сохраняет namespaces, не создавая дополнительных токенов subject.
- Возраст 5 с. Присутствие в ROS graph не равно исправности узла. Несколько узлов с одинаковым полным именем не различаются этим API.
- Исчезнувший в ходе работы bridge узел публикуется с `present:false`; исчезнувшая ячейка — null/unavailable. После перезапуска bridge старые динамические KV-ключи могут остаться без обновлений: проверять возраст и текущий node.list/список ячеек snapshot. Не считать отсутствие нового сообщения подтверждением присутствия.

## 6. KV

Bucket `VERTER_01_STATE` использует файловое хранение, history=1, лимит bucket 8 MiB, одного значения 256 KiB. Хранится последнее значение каждого ключа; графики истории этим не реализованы. Основные ключи записывает bridge; `camera.*` записывает отдельный сервис камеры. Обычный клиент может читать и watch, но не писать/удалять KV.

```text
battery.soc               -> конверт метрики
battery.voltage           -> конверт метрики
battery.charging_state    -> конверт метрики
battery.snapshot          -> конверт с полным снимком BMS
service.schema            -> конверт с каталогом
service.snapshot          -> конверт с общим состоянием
cmd_vel.target            -> конверт с состоянием ручного управления
service.note              -> конверт с заметкой
node.list                 -> конверт со списком
node.<node_id>            -> конверт с присутствием узла
topic.odometry_x          -> конверт метрики
```

`battery.soc` — имя KV-ключа, а `verter_01.battery.update.soc` — Core NATS subject. Это разные механизмы. Bridge явно записывает ключ и публикует сообщение. Их согласованность не транзакционная. При разрыве между операциями возможно обновление только одного из них. Для начального состояния и восстановления после разрыва читать KV или metrics_get.

KV watch доставляет начальные значения, затем обновления; конечность начального набора в nats-py обозначается событием None. Использовать библиотечный KV API, не строить вручную внутренние `$KV...` subjects. Для независимых роботов использовать отдельные buckets/domains из их каталога.

## 7. Сервисные команды request/reply

Subject выбирает операцию. Поля `action` в новом JSON нет:

```text
verter_01.service.command.ping
```

```json
{
  "v": 1,
  "id": "2f311630-f744-4c33-8545-af45491be649",
  "issued_at": 1790856000.125,
  "ttl_s": 30,
  "args": {}
}
```

Ограничения этого раздела относятся к service.command.*. Для cmd_vel.command.* действуют более короткие сроки из раздела 8.

`id` — UUID, новый для нового запроса. `issued_at` — текущие Unix seconds. `0 < ttl_s <= 30`; допускается время запроса не более чем на 2 с в будущем. Максимальный размер запроса 16 KiB. Принимаются только перечисленные поля. Нужен NATS request/reply с reply inbox `_INBOX.*`; fire-and-forget сообщения игнорируются.

| name команды | args | result |
|---|---|---|
| `ping` | `{}` | `{pong:true,boot_id}` |
| `schema_get` | `{}` | Каталог, в том числе `contract.metrics`, `contract.commands`, `maps` |
| `state_get` | `{}` | Полный снимок робота (без конверта метрики) |
| `metrics_get` | `{}` | Объект `KV-key -> конверт метрики`, сформированный из одного снимка bridge |
| `note_set` | `{"note":"текст до 500 символов"}` | `{"note":"..."}` |
| `mode_set` | `{"mode":"idle|mapping|navigation","map":"map_id","discard":true}` | Подтверждение принятия operation либо ошибка блокировки |

`map` задаётся только для navigation, значение — ID из разрешённого списка maps. `discard` — boolean, обязателен true при выходе из картографирования; предварительное сохранение выполняет оператор. Переключение разрешает локальный allow_mode_changes. Ответ подтверждает принятие; готовность проверять по service.mode.operation.status и stale. Idle завершает режим supervisor, сохраняя hardware/voice/web.

Успех:

```json
{"v":1,"id":"2f311630-f744-4c33-8545-af45491be649","ok":true,"at":1790856000.2,"result":{"pong":true,"boot_id":"..."}}
```

Ошибка:

```json
{"v":1,"id":"2f311630-f744-4c33-8545-af45491be649","ok":false,"at":1790856000.2,"error":"expired"}
```

При некорректном JSON/конверте id может быть null. Основные ошибки: `expired`, `invalid_time_window`, `invalid_envelope`, `unsupported_version`, `invalid_note`, `unexpected_args`, `id_reused_with_different_payload`, `outcome_unknown_after_interruption_inspect_state`, `mode_execution_disabled_by_local_config`. Ошибка внутренней операции может содержать другой диагностический текст; клиент должен обрабатывать любое ok:false.

Для изменяющих команд note_set/mode_set повтор абсолютно того же запроса с тем же id в пределах TTL возвращает сохранённый ответ. Читающие ping/schema_get/state_get/metrics_get каждый раз обрабатываются заново, возвращают актуальный ответ и не записываются в журнал команд; дедупликация id к ним не применяется. Для note_set/mode_set другой payload с тем же id отвергается. Результаты переживают перезапуск backend; записи старше суток очищаются при обработке запросов. TTL проверяется до выдачи кешированного ответа: после истечения TTL запрос отвергается даже при наличии результата. Таймаут клиента не означает, что операция не была исполнена; сначала проверить состояние. Автоматически переотправлять изменяющие запросы с новым id нельзя.

Команды не ставятся в офлайн-очередь JetStream и не воспроизводятся после перезапуска. Новые API запусков/остановок сервисов и узлов отсутствуют. Контракт `<robot_id>.cmd_vel.command.*` реализован и описан в разделе 8; для него отдельный короткий TTL и lease, без офлайн-очереди и без журнала команд.

## 8. Ручное управление через NATS

Путь команды:

```text
Браузер → HTTP POST /api/command → NATS request/reply
        → Python-backend → geometry_msgs/Twist /cmd_vel → драйвер шасси
```

Веб-сервер сам не публикует ROS Twist: он является NATS-клиентом. Серверное приложение может обращаться к тем же subjects напрямую, минуя HTTP. Фактическая скорость возвращается из ROS /odometry/filtered через backend и NATS, а не вычисляется из последнего клика.

| Свойство | service.command.* | cmd_vel.command.* |
|---|---|---|
| Максимальный размер запроса | 16 KiB | 4 KiB |
| Максимальный ttl_s | 30 | 1 |
| Допуск issued_at из будущего | 2 с | 0,5 с |
| Сохранение команд/результатов | Только note_set/mode_set, SQLite | Нет |
| Контроль повторов | id для изменяющих операций | session_id + возрастающий seq для set/keepalive |
| Продление действия движения | Неприменимо | keepalive, lease 1 с |
| Офлайн-очередь и воспроизведение | Нет | Нет |

### Пользовательское поведение

Кнопки крестом: вперёд сверху, назад снизу, влево/вправо по бокам, стоп в центре. Один click изменяет заданную линейную скорость на ±0,01 м/с или угловую на ±0,05 рад/с. Удержание мыши не даёт дополнительных шагов. Противоположная кнопка уменьшает компоненту до нуля, следующие нажатия меняют направление. Одновременно могут быть ненулевыми обе компоненты. Стоп обнуляет обе.

Клавиатура (обновление 2026-10-02): при фокусе внутри панели ручного управления ↑/↓ изменяют linear.x на ±0,01 м/с, ←/→ изменяют angular.z на ±0,05 рад/с; Space вызывает тот же stop, что центральная кнопка. Панель активируется кликом внутри неё или переходом Tab и отмечается рамкой. Одно физическое нажатие — один шаг, автоповтор при удержании игнорируется. Вне панели, при редактировании поля ввода и с модификаторами Alt/Ctrl/Meta/Shift эти сочетания не управляют роботом. Space на сфокусированной кнопке движения останавливает, а не активирует эту кнопку. Фокус сам по себе команд не отправляет. HTTP/NATS-контракты не меняются.

Предел центра робота: ±0,5 м/с. Предел угловой скорости: ±0,5 рад/с. UI ограничивает значения, backend отвергает выход за предел. Никакой проверки движения на реальном роботе при разработке не выполнялось.

В кнопках отображаются ФАКТИЧЕСКИЕ скорости из /odometry/filtered, обновление примерно 250 мс. Вперёд — положительный vx, назад — отрицательный vx. Слева/справа показывается положительный модуль угловой скорости, направление определяет кнопка. Под крестом отдельно показана заданная пара скоростей со знаками ROS: linear.x положительный вперёд, angular.z положительный влево, отрицательный вправо. Кнопки подсвечиваются по одометрии, не по принятой команде.

При возрасте одометрии >1 с или отсутствии данных значения в кнопках неизвестны (—). Для подавления остаточного шума значения |vx|<0,005 м/с и |wz|<0,025 рад/с отображаются как ноль. Одометрия показывает движение по датчикам/оценке, а не гарантированное перемещение относительно пола при проскальзывании.

Страница при загрузке, обновлении и опросе НЕ посылает движение или стоп. Первое нажатие стрелки создаёт новую сессию. После ошибки, потери связи или перезапуска автоматического возобновления нет. Пока страница активна, она продлевает команду каждые 200 мс. При скрытии вкладки/потере фокуса активная страница запрашивает стоп; при резком закрытии/разрыве действует watchdog backend. Новая страница не перенимает действующую сессию: стрелки недоступны, пока управление занято; кнопка стоп остаётся доступной.

### NATS API

```text
<robot_id>.cmd_vel.command.status       # чтение, ничего не публикует в ROS
<robot_id>.cmd_vel.command.set          # полная пара скоростей
<robot_id>.cmd_vel.command.keepalive    # продление существующей сессии
<robot_id>.cmd_vel.command.stop         # обнуление обеих компонент
<robot_id>.cmd_vel.update.target        # наблюдаемое состояние ручного управления
```

KV `cmd_vel.target` — только состояние; из KV команды никогда не воспроизводятся.

Request/reply JSON, UTF-8, максимум 4096 байт:

```json
{
  "v": 1,
  "id": "a013f75c-91ea-4794-97ec-403279a21d7c",
  "issued_at": 1790856000.125,
  "ttl_s": 1,
  "args": {
    "session_id": "c04f92f4-94aa-441c-a820-031d3e29c2df",
    "seq": 1,
    "linear_x": 0.01,
    "angular_z": -0.05
  }
}
```

Это пример данных, не команда для автоматического запуска.

- `v`: строго integer 1; id и session_id — UUID.
- `issued_at`: Unix UTC seconds, часы клиента и Jetson должны быть синхронизированы. Допуск времени из будущего ≤0,5 с.
- `0 < ttl_s <= 1`. Запрос, просроченный к моменту обработки, отвергается.
- set args: ровно session_id, seq, linear_x, angular_z; скорости finite number, не boolean/string.
- keepalive args: ровно session_id, seq. Seq — неотрицательный integer, строго возрастает внутри сессии для set и keepalive.
- stop/status args: `{}`. Stop доступен любому клиенту с правом этого subject.
- Поля action в NATS JSON нет; HTTP /api/command добавляет action="cmd_vel.set" и т.д. и преобразует его в subject.
- Ответ: общий `{v,id,ok,at,result}` или `{v,id,ok:false,at,error}`.

Управление допускает только одну активную сессию. Чужая set/keepalive получает manual_control_busy. Команда в памяти, без SQLite-дедупликации и без офлайн-очереди. Повтор/перестановка seq отвергается и не продлевает lease. После stop/expiry завершённый session_id блокируется на 60 с; старые запросы дополнительно отсекаются по TTL и границе последней остановки/старта процесса. Новое управление должно использовать новый UUID. Session_id — средство согласования, не замена NATS-авторизации.

Принятый set/keepalive действует 1 с по монотонным часам backend. ROS-thread публикует geometry_msgs/Twist в /cmd_vel с частотой до 20 Гц, только после явной команды. Истечение lease или потеря NATS вызывает одну нулевую команду и завершает сессию; публикации затем прекращаются. При пользовательском стопе ноль отправляется на следующем проходе ROS-thread (обычно до 50 мс, не hard real-time). Успешный ответ означает принятие backend, а не подтверждение физической остановки.

ROS publisher создаётся лениво при первой реальной отправке: запуск сервиса, status, чтение KV и загрузка веб-страницы не создают /cmd_vel publisher и не отправляют даже нулевую команду. При штатном завершении активного управления отправляется ноль. При аварийном завершении процесса/ОС Python watchdog работать не может: аппаратный timeout драйвера остаётся отдельным необходимым механизмом.

Примеры ошибок: manual_motion_disabled, ros_publisher_not_ready, manual_control_busy, session_closed, stale_sequence, no_active_session, lease_expired, velocity_limit, invalid_velocity, expired_or_invalid_time, command_precedes_stop_or_start. Клиент обрабатывает любые ok:false и не возобновляет движение автоматически.

status result содержит enabled, ready, active, session_id, seq, linear_x, angular_z, remaining_s, reason, max_linear, max_angular, lease_s и odometry. odometry: `{received_at,age_s,stale,value:{x,y,vx,wz}}` или null. ready означает готовность ROS-thread, не готовность шасси и не проверенную безопасность движения.

### Конфигурация и доступ

В config/nats/bridge.json флаг allow_manual_motion, по умолчанию false. На тестовом Jetson включён для ручной проверки пользователем (allow_manual_motion=true). allow_mode_changes остаётся false. Обычному текущему debug-клиенту installer/migrate_contract выдаёт status всегда, set/keepalive/stop только при allow_manual_motion=true. Все права привязаны к конкретному robot_id. Отдельные роли read-only/operator пока не разделены.

Отладочный HTTP доступен через localhost и Wi-Fi согласно конфигурации ниже, без токена, с Host/Origin guard. Доступ к этому локальному интерфейсу или его SSH-туннелю теперь даёт возможность ручного управления. GET /api/drive выполняет только status; POST /api/command передаёт команды через NATS.

Общего арбитража с навигацией/ESP32 нет: сохраняется согласованное использование одного источника. Ручное управление не включает объезд препятствий/Nav2. Кнопка стоп — программная команда, не аппаратный аварийный выключатель.

### Проверки без движения

Unit-тесты test_motion.py используют sink в Python-список. integration_motion.py поднимает отдельный NATS на loopback:4424 и HTTP:18089 с ros_enabled=false, подменённой готовностью и sink в список. ROS-контекст и publisher в этом тесте не создаются.

Браузерные проверки управления выполняются с подменёнными HTTP-ответами или изолированным backend. На действующем роботе без согласования допускаются только чтение состояния и пассивное наблюдение; нажатия кнопок, stop и цели навигации требуют согласования.

## 9. Совместимость и внутренний источник BMS

Backend также поддерживает совместимые интерфейсы:

- `robots.<robot_id>.v1.request`: совместимый конверт с полем action (`ping`, `schema.get`, `state.get`, `metrics.get`, `settings.set`, `mode.set`).
- `robots.<robot_id>.v1.state`: полный снимок без нового конверта метрики.
- KV `state`, `battery`, `schema`, `settings`: совместимые значения без нового конверта. `settings` — сохранённый источник заметки, `service.note` — её публичное представление.
- `robots.<robot_id>.v1.bms`: внутренний канал BLE-сборщика к bridge, декодированный JSON-снимок. Это не новый клиентский контракт; разработчикам использовать battery.update.* и battery.*.

Для внешних клиентов используются subjects `<robot_id>.<domain>.<action>.<name>`; перечисленные совместимые адреса не заменяют основной контракт. Bridge пишет основные public updates и фрагментированный KV; отдельный сервис камеры пишет только свой раздел `camera.*`. Нельзя публиковать сторонние измерения в battery.update.* в надежде автоматически обновить KV.

## 10. Python-клиент, HTTP и права доступа

Готовый пример: `services/nats_bridge/examples/read_contract.py`. Он читает каталог и SOC, выполняет ping и наблюдает за battery.*. Требуется nats-py. Параметры через переменные окружения: `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `ROBOT_ID`, `NATS_DOMAIN`, `NATS_BUCKET`. Пароли не записывать в исходный код.

Отладочный HTTP:

- `GET /api/metrics`: NATS metrics_get, результат — словарь отдельных метрик.
- `GET /api/state`: NATS state_get, общий снимок.
- `GET /api/drive`: NATS cmd_vel.command.status, заданные скорости, состояние сессии и одометрия. Только чтение.
- `POST /api/command`: JSON-конверт с action; HTTP backend преобразует его в новый command subject. Это формат HTTP-адаптера, не нового NATS-конверта.

Веб-мониторинг использует metrics_get и показывает адреса/значения отдельных метрик. Статус заряда берётся из backend. Кнопка «Сохранить заметку» вызывает note_set и не влияет на батарею/движение.

Текущий локальный debug-клиент имеет право publish в перечисленные service.command.*, совместимый request и cmd_vel.command.status. При allow_manual_motion=true также разрешены cmd_vel.command.set, keepalive и stop своего robot_id. Клиент читает public updates, ответы и конкретный KV bucket (get/watch). Разделение monitor/operator ещё не внедрено. Права JetStream consumer API нужны для watch; они не дают права писать значения KV. Backend остаётся доверенным локальным пользователем с полными правами. Ограниченный BMS-пользователь может только публиковать внутренний канал BMS.


### Сопоставление HTTP и NATS

| HTTP action | NATS subject после преобразования |
|---|---|
| `ping` | `<robot_id>.service.command.ping` |
| `schema.get` | `<robot_id>.service.command.schema_get` |
| `state.get` | `<robot_id>.service.command.state_get` |
| `metrics.get` | `<robot_id>.service.command.metrics_get` |
| `settings.set` | `<robot_id>.service.command.note_set` |
| `mode.set` | `<robot_id>.service.command.mode_set` |
| `cmd_vel.status` | `<robot_id>.cmd_vel.command.status` |
| `cmd_vel.set` | `<robot_id>.cmd_vel.command.set` |
| `cmd_vel.keepalive` | `<robot_id>.cmd_vel.command.keepalive` |
| `cmd_vel.stop` | `<robot_id>.cmd_vel.command.stop` |

Для POST /api/command используются те же поля v/id/issued_at/ttl_s/args плюс action из таблицы. HTTP-адаптер удаляет action перед отправкой в NATS. Не добавлять action в запрос напрямую к новому NATS subject. Таймаут ожидания ответа HTTP-адаптера: 1 с для cmd_vel.*, 20 с для сервисных команд. HTTP 200 требует дополнительной проверки поля ok; timeout/отсутствие NATS-ответа возвращает HTTP 503.

После подключения к центральному серверу права leaf и отдельных локальных ролей потребуют отдельной настройки. Общая изоляция роботов на hub пока не внедрена; один префикс robot_id в имени сам по себе не является контролем доступа.

Примеры всех запросов для разработчика: [NATS_COMMAND_EXAMPLES_V1.json](NATS_COMMAND_EXAMPLES_V1.json). Это статические образцы, не исполняемые команды: UUID и время нужно формировать заново; время в статическом примере не подходит для отправки реальной команды.

## 11. Часы и веб-клиент

Веб-клиент рассчитывает issued_at по полю at read-only ответа cmd_vel.status и performance.now(), с поправкой на половину RTT. Часы ОС не меняются; backend сохраняет строгие TTL и допуск времени из будущего. Принимаются образцы с RTT <800 мс; без образца моложе 5 с новые команды не отправляются. Прямой NATS-клиент должен согласовать часы с Jetson самостоятельно.

## 12. Сеть и отдельный API камеры

Текущая отладочная конфигурация `config/nats/bridge.json`: web_host `0.0.0.0`, web_port 8088; allowed_hosts содержит localhost, 127.0.0.1, ::1 и IP Jetson в Wi-Fi. При изменении IP нужно обновить allowlist и перезапустить bridge при неактивном управлении. Origin должен совпадать с адресом страницы. В production `web_enabled=false` выключает HTTP, сохраняя NATS API и KV.

Камера обслуживается отдельным `verter-camera.service`. [CAMERA_API_V1.md](CAMERA_API_V1.md) определяет ROS RGB/depth, WebRTC, HTTP-видео и NATS-сигнализацию; [CAMERA_CATALOG_V1.json](CAMERA_CATALOG_V1.json) — её машинный каталог. В её NATS-конверте поле action обязательно, в отличие от прямых service/cmd_vel subjects. `service.schema_get` и `metrics_get` не агрегируют отдельный каталог/метрики камеры. Видео не передаётся через KV.

[Установка](INSTALL.md) и [сборка/перезапуск](OPERATIONS.md) описаны отдельно. Комплект [NATS_DEVELOPER_HANDOFF_V1.zip](NATS_DEVELOPER_HANDOFF_V1.zip) содержит контракты, каталоги, статические примеры запросов и читающий Python-клиент; приватной конфигурации в нём нет.

Расположение кода и таблица HTTP endpoints отладочного мониторинга — [services/nats_bridge/README.md](../services/nats_bridge/README.md).

Сканы, модель корпуса и состояние наблюдателя передаются отдельными `lidar.update.scan|model|status` без записи в KV. Формат этих потоковых сообщений отличается от конверта метрик `value/unit`. Базовый каталог и metrics_get их не агрегируют; см. [LIDAR_API_V1.md](LIDAR_API_V1.md) и [LIDAR_CATALOG_V1.json](LIDAR_CATALOG_V1.json).


## История BMS

Контракт версии 1.2 добавляет read-only request/reply
`<robot_id>.battery.command.history` и HTTP `GET /api/battery/history`.
Хранение, аргументы и агрегация: [BMS_HISTORY_V1.md](BMS_HISTORY_V1.md).
KV по-прежнему содержит последние состояния; недельная история хранится отдельно.


Контракт 1.3 добавляет постраничное чтение исходных BMS-наблюдений (`raw=true`)
через тот же subject истории и экспорт CSV/TXT: [BMS_HISTORY_V1.md](BMS_HISTORY_V1.md#экспорт-csv-и-txt).


## Живая карта и положение робота

`<robot_id>.map.command.get` — только чтение metadata/chunk/pose/model/scan/diagnostics/save_status/saved.
`map.update.metadata`, `map.update.pose` и `map.update.scan` — потоки, KV `map.live` — компактная metadata.
Клетки передаются сжатыми частями, робот — в системе map.
Полный контракт, сборка снимка и контрольные суммы: [MAP_API_V1.md](MAP_API_V1.md).

`<robot_id>.map.command.save` принимает args={name}, сохраняет YAML/PGM и
граф SLAM без завершения режима. Подтверждение асинхронное; отслеживайте
metadata.save или map.get save_status. Контракт: [MAP_API_V1.md](MAP_API_V1.md),
инструкция: [MAPPING_GUIDE.md](MAPPING_GUIDE.md).

## Локализация, точки и определения маршрутов

Домены `localization`, `waypoint`, `route` используют общий command-конверт v1. Точный контракт: [LOCALIZATION_API_V1.md](LOCALIZATION_API_V1.md). KV `localization.state`, `waypoint.catalog`, `route.catalog` содержит последние состояния. Initialpose выполняется только явным запросом; определения маршрутов не исполняются.
