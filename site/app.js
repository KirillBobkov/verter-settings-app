/* Operator dashboard. Loading, polling and navigation links only read state. */
(() => {
    'use strict';

    const el = id => document.getElementById(id);
    const names = {idle: 'Ожидание', mapping: 'Картографирование', localization: 'Локализация', navigation: 'Навигация', fault: 'Ошибка режима', unknown: 'Неизвестно'};
    const chargeNames = {charging: 'Заряжается', discharging: 'Разряжается', idle: 'Ток около нуля', unknown: 'Неизвестно'};
    const modeButtons = [...document.querySelectorAll('[data-mode]')];
    let state = null;
    let values = null;
    let received = null;
    let connected = false;
    let refreshing = false;
    let mapsTask = null;
    let schema = null;
    let maps = [];
    let modeSubmitting = false;
    let pendingModeId = null;
    let noteSaving = false;
    let noteDirty = false;
    let modeScope = null;
    let serverClock = null;

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
    const ageSinceReply = () => received === null ? Infinity : Math.max(0, (performance.now() - received) / 1000);
    const freshState = () => connected && !!state && ageSinceReply() < 6.5;
    const errorText = error => String(error?.message || error).slice(0, 350);

    function result(id, message, error = false) {
        el(id).textContent = message;
        el(id).dataset.error = String(error);
    }

    function requestId() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function api(path, body) {
        const sent = performance.now();
        const response = await fetch(path, {
            method: body ? 'POST' : 'GET',
            headers: {'Content-Type': 'application/json'},
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw Error((await response.text()).slice(0, 350) || `HTTP ${response.status}`);
        const data = await response.json();
        if (Number.isFinite(data.at) && performance.now() - sent < 1000)
            serverClock = {at: data.at, midpoint: (sent + performance.now()) / 2};
        if (!data.ok) throw Error(data.error || 'Запрос не подтверждён');
        return data;
    }

    async function command(action, args = {}, showResponse = true) {
        const body = {
            v: 1, id: requestId(),
            issued_at: serverClock ? serverClock.at + (performance.now() - serverClock.midpoint) / 1000 : Date.now() / 1000,
            ttl_s: 30, action, args
        };
        const data = await api('/api/command', body);
        if (showResponse) el('response').textContent = JSON.stringify(data, null, 2);
        return data.result;
    }

    function modeReason(target, ignoreSubmission = false) {
        if (modeSubmitting && !ignoreSubmission) return 'Запрос режима отправляется. Дождитесь ответа.';
        if (!freshState()) return 'Нет свежего состояния робота. Дождитесь связи.';
        const mode = state.mode || {};
        if (mode.stale) return 'Supervisor не отвечает. Состояние режима устарело.';
        if (!mode.execution_enabled) return 'Переключение режимов заблокировано в конфигурации робота.';
        if (mode.operation?.status === 'running') return 'Переключение уже выполняется. Дождитесь завершения.';
        if (state.manual_control?.active) return 'Сначала завершите ручное управление кнопкой «СТОП».';
        if (target === mode.actual) return 'Этот режим уже выбран.';
        if (mode.actual !== 'idle' && target !== 'idle') return 'Сначала завершите текущий режим через «Ожидание».';
        if (mode.actual === 'mapping' && target === 'idle' && !el('discard').checked)
            return 'Сохраните карту, затем подтвердите завершение сессии ниже.';
        if (['localization', 'navigation'].includes(target) && !maps.includes(el('map').value))
            return 'Выберите сохранённую карту.';
        return null;
    }

    function updateControls() {
        const mode = state?.mode || {};
        for (const button of modeButtons) {
            const reason = modeReason(button.dataset.mode);
            button.disabled = !!reason;
            button.title = reason || `Выбрать режим «${names[button.dataset.mode]}»`;
            button.dataset.current = String(freshState() && mode.actual === button.dataset.mode);
        }
        el('map').disabled = modeSubmitting;
        el('refresh-maps').disabled = !!mapsTask || modeSubmitting;
        el('discard-row').hidden = mode.actual !== 'mapping';
        el('discard').disabled = modeSubmitting || !freshState();
        el('save').disabled = !freshState() || noteSaving || !noteDirty;
        let help;
        if (!freshState()) help = 'Действия с режимами недоступны без свежего состояния.';
        else if (state.manual_control?.active) help = 'Ручная сессия активна. Сначала завершите её кнопкой «СТОП».';
        else if (mode.operation?.status === 'running' || modeSubmitting) help = 'Переключение режима выполняется…';
        else if (mode.stale || !mode.execution_enabled) help = modeReason('mapping');
        else if (mode.actual === 'mapping') help = el('discard').checked
            ? 'Завершение подтверждено. Кнопка «Ожидание» завершит сессию SLAM.'
            : 'Сохранение — в окне карты. Для завершения отметьте подтверждение выше.';
        else if (mode.actual !== 'idle') help = 'Для смены режима сначала выберите «Ожидание».';
        else help = maps.includes(el('map').value)
            ? 'Можно запускать выбранный режим. Запрос потребует подтверждения.'
            : 'Для локализации и навигации выберите карту. Картографирование доступно без неё.';
        el('gate').textContent = help;
    }

    function metric(container, label, value) {
        const card = document.createElement('div');
        card.className = 'metric';
        const name = document.createElement('span');
        name.textContent = label;
        const content = document.createElement('strong');
        content.textContent = value;
        card.append(name, content);
        container.append(card);
    }

    function renderBattery() {
        const battery = state?.battery;
        const sample = battery?.sample;
        const age = finite(battery?.sample_age_s) ? battery.sample_age_s + ageSinceReply() : null;
        const stale = !freshState() || !battery || battery.stale || (finite(age) && age > 8);
        const soc = finite(sample?.soc_pct) ? `${number(sample.soc_pct, 0)} %` : '—';
        const charge = stale ? 'Состояние заряда неизвестно' : chargeNames[battery.charging_state] || 'Неизвестно';
        el('summary-battery').textContent = soc;
        el('summary-charge-state').textContent = stale && sample ? 'Последнее показание · устарело' : charge;
        el('summary-battery').classList.toggle('stale', stale);
        el('battery-main-soc').textContent = soc;
        el('battery-charge-state').textContent = charge;
        el('battery-gauge').hidden = !finite(sample?.soc_pct);
        if (finite(sample?.soc_pct)) el('battery-gauge').value = Math.max(0, Math.min(100, sample.soc_pct));
        el('battery').classList.toggle('old-data', stale);
        el('battery-status').textContent = stale ? 'Нет свежих данных' : 'Данные поступают';
        el('battery-status').className = 'badge ' + (stale ? 'stale' : 'fresh');
        el('battery-age').textContent = sample
            ? `${stale ? 'Сохранённое показание. ' : ''}Возраст измерения: ${number(age, 1)} с.${battery.error ? ' ' + battery.error : ''}`
            : battery?.error || 'Измерения BMS пока не получены.';
        el('battery-metrics').replaceChildren();
        if (sample) {
            for (const [label, value] of [
                ['Напряжение', number(sample.voltage_V, 2) + ' В'],
                ['Ток', number(sample.current_A, 2) + ' А'],
                ['Мощность', number(sample.power_W, 1) + ' Вт'],
                ['Осталось', number(sample.remaining_Ah, 1) + ' А·ч']
            ]) metric(el('battery-metrics'), label, value);
        }
        if (!el('battery-details').open) return;
        el('battery-device').textContent = battery?.device
            ? `${battery.device.model || 'JK BMS'} · HW ${battery.device.hardware || '—'} · ПО ${battery.device.software || '—'} · BLE`
            : 'Ожидание устройства BMS';
        el('battery-extra').replaceChildren();
        el('battery-cells').replaceChildren();
        if (sample) {
            for (const [label, value] of [
                ['Разброс ячеек', number(finite(sample.cell_delta_V) ? sample.cell_delta_V * 1000 : null, 0) + ' мВ'],
                ['Температура MOS', number(sample.mos_temperature_C, 1) + ' °C'],
                ['Температура 1', number(sample.temperature_1_C, 1) + ' °C'],
                ['Температура 2', number(sample.temperature_2_C, 1) + ' °C']
            ]) metric(el('battery-extra'), label, value);
            for (const [cell, value] of Object.entries(sample.cells_V || {}))
                metric(el('battery-cells'), 'Ячейка ' + cell, number(value, 3) + ' В');
        }
        el('battery-detail').textContent = 'Заряд/разряд определяется по току с порогом ±0,1 А. Ток около нуля не подтверждает полный заряд. Флаги: ' + (sample?.flags_raw || '—') + '.';
    }

    function renderDiagnostics() {
        if (!el('diagnostics').open) return;
        if (el('state-details').open) el('state').textContent = state ? JSON.stringify(state, null, 2) : 'Состояние недоступно';
        if (el('sources-details').open) {
            el('metrics').replaceChildren();
            for (const [name, item] of Object.entries(state?.telemetry?.sources || {})) {
                const row = document.createElement('p');
                row.className = item.stale || !freshState() ? 'stale' : '';
                row.textContent = `${name} · ${number(item.age_s, 1)} с · ${item.stale ? 'УСТАРЕЛО · ' : ''}${JSON.stringify(item.value)}`;
                el('metrics').append(row);
            }
            if (state?.telemetry?.error) {
                const row = document.createElement('p');
                row.textContent = state.telemetry.error;
                el('metrics').append(row);
            }
        }
        if (el('contracts-details').open) {
            el('contract-values').replaceChildren();
            for (const [key, item] of Object.entries(values || {})) {
                if (key.endsWith('.snapshot') || key === 'service.schema' || !item || !('value' in item)) continue;
                const row = document.createElement('p');
                row.className = item.quality === 'ok' && freshState() ? '' : 'stale';
                const address = document.createElement('code');
                address.textContent = `${state?.robot_id || 'robot'}.${key.split('.')[0]}.update.${key.slice(key.indexOf('.') + 1)}`;
                const value = document.createElement('span');
                value.textContent = ' → ' + JSON.stringify(item.value) + (item.unit ? ' ' + item.unit : '') + ' · ' + item.quality;
                row.append(address, value);
                el('contract-values').append(row);
            }
        }
    }

    function renderState() {
        const fresh = freshState();
        const mode = state?.mode || {};
        const modeName = names[mode.actual] || mode.actual || 'Неизвестно';
        el('robot-identity').textContent = state?.robot_id ? `${state.robot_id} · локальная консоль` : 'Локальное управление и наблюдение';
        el('summary-mode').textContent = fresh ? modeName : 'Неизвестно';
        el('summary-mode-detail').textContent = !fresh ? 'Нет свежего состояния' : mode.stale ? 'Supervisor не отвечает' : mode.operation?.status === 'running' ? 'Переключение выполняется' : mode.map || 'Без активной карты';
        el('mode-badge').textContent = fresh ? modeName : 'Нет связи';
        el('mode-badge').classList.toggle('stale', !fresh || !!mode.stale || !!mode.error);
        el('mode').textContent = fresh
            ? `${modeName}${mode.operation?.status === 'running' ? ' → ' + (names[mode.desired] || mode.desired) : ''}${mode.map ? ' · карта ' + mode.map : ''}${mode.error || mode.operation?.error ? ' · ' + (mode.error || mode.operation.error) : ''}`
            : 'Нет свежего состояния режима. Действия временно недоступны.';
        el('mode-help').textContent = mode.actual === 'mapping'
            ? 'Стройте и сохраняйте карту в отдельном окне карты.'
            : mode.actual === 'localization'
                ? 'В окне карты задайте начальную позу и проверьте совмещение со сканом.'
                : mode.actual === 'navigation'
                    ? 'В окне карты доступны положение и costmap. Этот интерфейс пока хранит описания маршрутов без их запуска.'
                    : 'Картографирование создаёт карту. Локализация определяет положение на сохранённой карте.';
        el('summary-age').textContent = received === null ? '—' : number(ageSinceReply(), 1) + ' с';
        el('summary-age-detail').textContent = fresh ? 'После последнего ответа' : 'Состояние не подтверждено';
        if (fresh) {
            el('connection').textContent = 'Связь с роботом установлена';
            el('connection').classList.remove('stale');
        } else {
            el('connection').classList.add('stale');
            if (connected) el('connection').textContent = 'Нет свежего состояния робота';
        }
        const sources = state?.telemetry?.sources || {};
        const sensorList = [['lidar', 'Лидар'], ['imu', 'IMU'], ['odometry', 'Одометрия']];
        const missing = sensorList.filter(([key]) => !fresh || !sources[key] || sources[key].stale || !finite(sources[key].age_s) || sources[key].age_s > 2);
        el('summary-sensors').textContent = `${3 - missing.length} / 3 свежих`;
        el('summary-sensors').classList.toggle('stale', missing.length > 0);
        el('summary-sensors-detail').textContent = missing.length ? 'Нет свежих: ' + missing.map(([, label]) => label).join(', ') : 'Лидар · IMU · одометрия';
        renderBattery();
        updateControls();
        renderDiagnostics();
    }

    function acceptState(next) {
        if (!next || typeof next !== 'object' || !next.mode) throw Error('Некорректное состояние робота');
        state = next;
        received = performance.now();
        connected = next.transport?.connected !== false;
        const scope = (next.mode.actual || '') + ':' + (next.mode.pid || '');
        if (scope !== modeScope) {
            el('discard').checked = false;
            modeScope = scope;
        }
        if (!noteDirty && document.activeElement !== el('note')) el('note').value = next.settings?.note || '';
        if (!el('map').value && next.mode.actual !== 'idle' && maps.includes(next.mode.map)) el('map').value = next.mode.map;
        const operation = next.mode.operation;
        if (pendingModeId && operation?.id === pendingModeId) {
            if (operation.status === 'succeeded') {
                result('mode-result', `Режим «${names[next.mode.actual] || next.mode.actual}» подтверждён.`);
                pendingModeId = null;
            } else if (operation.status === 'failed') {
                result('mode-result', 'Переключение не выполнено: ' + (operation.error || next.mode.error || 'проверьте состояние компонентов'), true);
                pendingModeId = null;
            }
        }
        renderState();
    }

    async function refresh() {
        if (refreshing || document.hidden) return;
        refreshing = true;
        try {
            const data = await api('/api/metrics');
            const next = data.result?.['service.snapshot']?.value;
            if (!next) throw Error('В ответе нет состояния робота');
            values = data.result;
            acceptState(next);
        } catch (error) {
            connected = false;
            el('connection').textContent = 'Нет связи: ' + errorText(error);
            renderState();
        } finally {
            refreshing = false;
        }
    }

    async function loadMaps(forceSchema = false) {
        if (mapsTask) return mapsTask;
        mapsTask = (async () => {
            el('map-status').textContent = 'Обновление списка карт…';
            const results = await Promise.allSettled([
                forceSchema || !schema ? command('schema.get', {}, false) : Promise.resolve(schema),
                api('/api/map?part=saved')
            ]);
            const previous = el('map').value;
            if (results[0].status === 'fulfilled') schema = results[0].value;
            const ids = new Set(Array.isArray(schema?.maps) ? schema.maps.filter(id => typeof id === 'string') : []);
            if (results[1].status === 'fulfilled') {
                const savedMaps = results[1].value.result?.maps;
                for (const map of Array.isArray(savedMaps) ? savedMaps : [])
                    if (typeof map.name === 'string' && map.grid !== false) ids.add(map.name);
            }
            if (results.every(value => value.status === 'rejected')) {
                el('map-status').textContent = 'Список не обновлён: ' + errorText(results[1].reason);
                el('map-status').classList.add('stale');
                return;
            }
            maps = [...ids].sort((left, right) => left.localeCompare(right));
            el('map').replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = maps.length ? 'Выберите сохранённую карту' : 'Сохранённых карт нет';
            el('map').append(placeholder);
            for (const id of maps) {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id;
                el('map').append(option);
            }
            const activeMap = state?.mode?.actual !== 'idle' ? state?.mode?.map : '';
            el('map').value = maps.includes(previous) ? previous : maps.includes(activeMap) ? activeMap : '';
            el('map-status').textContent = results[1].status === 'rejected'
                ? 'Доступен каталог API; сохранённые карты сейчас не обновились.'
                : maps.length ? `Доступно карт: ${maps.length}` : 'Сначала постройте и сохраните карту в окне карты.';
            el('map-status').classList.toggle('stale', results[1].status === 'rejected');
        })();
        updateControls();
        try { await mapsTask; }
        finally { mapsTask = null; updateControls(); }
    }

    async function selectMode(target) {
        const blocked = modeReason(target);
        if (blocked) { result('mode-result', blocked, true); return; }
        modeSubmitting = true;
        updateControls();
        try {
            // Recheck immediately before confirmation: a manual lease may have
            // started since the regular two-second dashboard update.
            const current = await api('/api/state');
            acceptState(current.result);
            const reason = modeReason(target, true);
            if (reason) throw Error(reason);
            const map = el('map').value;
            const question = target === 'idle'
                ? `Завершить режим «${names[state.mode.actual] || state.mode.actual}»? Робот должен быть неподвижен. Завершение может отправить нулевую скорость.${state.mode.actual === 'mapping' ? ' Убедитесь, что нужная карта сохранена.' : ''}`
                : `Запустить режим «${names[target]}»${['localization', 'navigation'].includes(target) ? ' на карте «' + map + '»' : ''}? Подтвердите, что робот неподвижен и управление сейчас не используется. Цель движения этим действием не задаётся.`;
            if (!window.confirm(question)) { result('mode-result', 'Запрос отменён. Режим не изменён.'); return; }
            const args = {mode: target};
            if (target === 'idle' && state.mode.actual === 'mapping') args.discard = el('discard').checked;
            if (['localization', 'navigation'].includes(target)) args.map = map;
            result('mode-result', 'Запрос отправляется…');
            const updated = await command('mode.set', args);
            pendingModeId = updated?.operation?.id || null;
            if (updated?.actual) state.mode = updated;
            result('mode-result', updated?.operation?.status === 'running' ? 'Запрос принят. Ожидается запуск компонентов…' : 'Запрос режима принят.');
        } catch (error) {
            result('mode-result', 'Режим не подтверждён: ' + errorText(error), true);
        } finally {
            modeSubmitting = false;
            updateControls();
            refresh();
        }
    }

    el('refresh').onclick = async () => {
        el('refresh').disabled = true;
        try { await Promise.all([refresh(), loadMaps()]); }
        finally { el('refresh').disabled = false; }
    };
    el('refresh-maps').onclick = () => loadMaps();
    el('map').onchange = updateControls;
    el('discard').onchange = updateControls;
    for (const button of modeButtons) button.onclick = () => selectMode(button.dataset.mode);
    el('note').addEventListener('input', () => { noteDirty = true; result('note-result', 'Есть несохранённые изменения.'); updateControls(); });
    el('save').onclick = async () => {
        if (!freshState() || noteSaving || !noteDirty) return;
        noteSaving = true;
        updateControls();
        const text = el('note').value;
        try {
            await command('settings.set', {note: text});
            const unchanged = el('note').value === text;
            if (unchanged) noteDirty = false;
            if (state) state.settings = {...state.settings, note: text};
            result('note-result', unchanged ? 'Заметка сохранена.' : 'Предыдущий текст сохранён. Есть новые несохранённые изменения.');
        } catch (error) { result('note-result', 'Заметка не сохранена: ' + errorText(error), true); }
        finally { noteSaving = false; updateControls(); }
    };
    el('ping').onclick = async () => {
        try {
            const sent = performance.now();
            await command('ping');
            result('api-result', `Backend отвечает · ${Math.round(performance.now() - sent)} мс`);
        } catch (error) { result('api-result', errorText(error), true); }
    };
    el('schema').onclick = async () => {
        try {
            schema = await command('schema.get');
            await loadMaps();
            el('response-details').open = true;
            result('api-result', 'Словарь получен; ответ раскрыт ниже.');
        } catch (error) { result('api-result', errorText(error), true); }
    };
    for (const id of ['diagnostics', 'sources-details', 'state-details', 'contracts-details'])
        el(id).addEventListener('toggle', renderDiagnostics);
    el('battery-details').addEventListener('toggle', renderBattery);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { refresh(); loadMaps(); }
    });
    window.VerterDashboard = Object.freeze({
        snapshot() {
            return {
                connected: freshState(), mode: state?.mode?.actual || 'unknown',
                selectedMap: el('map').value, mapNames: [...maps], mapsReady: maps.length > 0,
                modeSubmitting, noteDirty,
                modeReasons: Object.fromEntries(modeButtons.map(button => [button.dataset.mode, modeReason(button.dataset.mode)]))
            };
        }
    });
    // Learn server time from the first GET before forming a NATS envelope.
    refresh().then(() => loadMaps());
    setInterval(refresh, 2000);
    setInterval(() => { if (!document.hidden) renderState(); }, 1000);
    setInterval(() => { if (!document.hidden) loadMaps(); }, 30000);
})();
