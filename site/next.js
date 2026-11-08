/* Новый интерфейс Verter (редизайн). Транспорт и логика робота — те же
   контракты, что в классических страницах: fetch('/api/*') перехватывает
   api-shim.js и выполняет их через NATS. Ручное управление переиспользует
   drive.js без изменений (те же id панели). Логика карты, локализации,
   точек/маршрутов, сохранения, батареи и диагностики портирована из
   app.js / map.js / localization-ui.js / battery-history.js. */
(() => {
    'use strict';
    const el = id => document.getElementById(id);
    const $ = sel => document.querySelector(sel);
    const names = { idle: 'Ожидание', mapping: 'Картографирование', localization: 'Локализация', navigation: 'Навигация', fault: 'Ошибка режима', unknown: 'Неизвестно' };
    const chargeNames = { charging: 'Заряжается', discharging: 'Разряжается', idle: 'Ток около нуля', unknown: 'Неизвестно' };
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    const number = (v, d = 2) => finite(v) ? v.toFixed(d) : '—';
    const errorText = e => String(e && e.message || e).slice(0, 350);
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : (() => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    })());

    /* ---------- предпочтения, журнал, переключатель интерфейса ---------- */
    const PREFS_KEY = 'verter.ui.prefs';
    const JOURNAL_KEY = 'verter.ui.journal';
    let prefs = { auto: true, sound: true, eng: true, sessionOnly: false };
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* сбой чтения — дефолты */ }
    function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* приватный режим */ } }
    function journal() { try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); } catch (e) { return []; } }
    function log(kind, text) {
        const rows = journal();
        rows.unshift({ t: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), k: kind, x: String(text).slice(0, 200) });
        try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(rows.slice(0, 100))); } catch (e) { /* приватный режим */ }
        renderJournal();
    }
    function renderJournal() {
        const rows = journal();
        el('nx-journal').innerHTML = rows.length ? rows.map(r =>
            `<div class="nx-jrow"><span class="nx-jt">${r.t}</span><span class="nx-dot" data-s="${r.k}"></span><span></span></div>`
                .replace('<span></span>', `<span>${String(r.x).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</span>`)
        ).join('') : '<p class="nx-note">Записей пока нет. Здесь появятся входы, команды и экспорт.</p>';
    }

    /* ---------- навигация ---------- */
    const SECTIONS = ['map', 'drive', 'battery', 'cabinet', 'eng'];
    let section = 'map';
    function show(next) {
        if (!SECTIONS.includes(next)) return;
        section = next;
        document.querySelectorAll('[data-nx-nav]').forEach(b => {
            if (b.dataset.nxNav === next) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
        });
        document.querySelectorAll('[data-nx-sec]').forEach(s => { s.hidden = s.dataset.nxSec !== next; });
    }
    document.querySelectorAll('[data-nx-nav]').forEach(b => b.addEventListener('click', () => show(b.dataset.nxNav)));

    el('nx-ui-toggle').addEventListener('click', () => {
        try { localStorage.setItem('verter.ui.next', '0'); } catch (e) { /* приватный режим */ }
        location.href = 'classic.html';
    });

    /* ---------- API и часы ---------- */
    let serverClock = null;
    let received = null;
    let connected = false;
    let state = null;
    let values = null;
    async function api(path, body, timeout = 10000) {
        const sent = performance.now();
        const response = await fetch(path, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeout)
        });
        if (!response.ok) throw Error((await response.text()).slice(0, 350) || `HTTP ${response.status}`);
        const data = await response.json();
        if (Number.isFinite(data.at) && performance.now() - sent < 1000)
            serverClock = { at: data.at, midpoint: (sent + performance.now()) / 2 };
        if (!data.ok) throw Error(data.error || 'Запрос не подтверждён');
        return data;
    }
    function command(action, args = {}, ttl = 30) {
        const body = {
            v: 1, id: uuid(),
            issued_at: serverClock ? serverClock.at + (performance.now() - serverClock.midpoint) / 1000 : Date.now() / 1000,
            ttl_s: ttl, action, args
        };
        return api('/api/command', body).then(data => {
            el('nx-eng-last').textContent = JSON.stringify(data, null, 2);
            return data.result;
        });
    }

    /* ---------- состояние робота: опрос, KPI, режимы, батарея, заметка ---------- */
    let refreshing = false, mapsTask = null, schema = null, maps = [];
    let modeButtons = [], modeSubmitting = false, pendingModeId = null, noteSaving = false, noteDirty = false, modeScope = null;
    const ageSince = () => received === null ? Infinity : Math.max(0, (performance.now() - received) / 1000);
    const freshState = () => connected && !!state && ageSince() < 6.5;

    function modeReason(target, ignoreSubmission = false) {
        if (modeSubmitting && !ignoreSubmission) return 'Запрос режима отправляется. Дождитесь ответа.';
        if (!freshState()) return 'Нет свежего состояния робота. Дождитесь связи.';
        const mode = state.mode || {};
        if (mode.stale) return 'Supervisor не отвечает. Состояние режима устарело.';
        if (!mode.execution_enabled) return 'Переключение режимов заблокировано в конфигурации робота.';
        if (mode.operation && mode.operation.status === 'running') return 'Переключение уже выполняется. Дождитесь завершения.';
        if (state.manual_control && state.manual_control.active) return 'Сначала завершите ручное управление на экране «Управление».';
        if (target === mode.actual) return 'Этот режим уже выбран.';
        if (mode.actual !== 'idle' && target !== 'idle') return 'Сначала завершите текущий режим через «Ожидание».';
        if (mode.actual === 'mapping' && target === 'idle' && !el('nx-discard').checked)
            return 'Сохраните карту, затем подтвердите завершение сессии ниже.';
        if (['localization', 'navigation'].includes(target) && !maps.includes(el('nx-mode-map').value))
            return 'Выберите сохранённую карту.';
        return null;
    }
    function modeHint() {
        if (!freshState()) return 'Действия с режимами недоступны без свежего состояния.';
        const mode = state.mode || {};
        if (state.manual_control && state.manual_control.active) return 'Ручная сессия активна. Сначала завершите её на экране «Управление».';
        if ((mode.operation && mode.operation.status === 'running') || modeSubmitting) return 'Переключение режима выполняется…';
        if (mode.stale || !mode.execution_enabled) return modeReason('mapping');
        if (mode.actual === 'mapping') return el('nx-discard').checked
            ? 'Завершение подтверждено. Кнопка «Ожидание» завершит сессию SLAM.'
            : 'Сохранение — во вкладке «Сохранение». Для завершения отметьте подтверждение выше.';
        if (mode.actual !== 'idle') return 'Для смены режима сначала выберите «Ожидание».';
        return maps.includes(el('nx-mode-map').value)
            ? 'Можно запускать выбранный режим. Запрос потребует подтверждения.'
            : 'Для локализации и навигации выберите карту. Картографирование доступно без неё.';
    }
    function updateControls() {
        const mode = state && state.mode || {};
        modeButtons.forEach(button => {
            const reason = modeReason(button.dataset.mode);
            button.disabled = !!reason;
            button.title = reason || `Выбрать режим «${names[button.dataset.mode]}»`;
            button.setAttribute('data-on', freshState() && mode.actual === button.dataset.mode ? '' : 'x');
            if (freshState() && mode.actual === button.dataset.mode) button.setAttribute('data-on', '');
            else button.removeAttribute('data-on');
        });
        el('nx-mode-map').disabled = modeSubmitting;
        el('nx-maps-refresh').disabled = !!mapsTask || modeSubmitting;
        el('nx-discard-row').hidden = mode.actual !== 'mapping';
        el('nx-discard').disabled = modeSubmitting || !freshState();
        el('nx-note-save').disabled = !freshState() || noteSaving || !noteDirty;
        el('nx-mode-hint').textContent = modeHint();
    }
    function result(id, message, error = false) {
        el(id).textContent = message;
        el(id).dataset.error = String(error);
    }
    function metric(container, label, value) {
        const card = document.createElement('div');
        card.className = 'nx-mchip';
        const name = document.createElement('span'); name.textContent = label;
        const content = document.createElement('strong'); content.textContent = value;
        card.append(name, content);
        container.append(card);
    }
    function renderBattery() {
        const battery = state && state.battery;
        const sample = battery && battery.sample;
        const age = finite(battery && battery.sample_age_s) ? battery.sample_age_s + ageSince() : null;
        const stale = !freshState() || !battery || battery.stale || (finite(age) && age > 8);
        const soc = finite(sample && sample.soc_pct) ? `${number(sample.soc_pct, 0)} %` : '—';
        el('nx-soc-text').textContent = soc;
        el('nx-soc-arc').setAttribute('stroke-dasharray',
            finite(sample && sample.soc_pct) ? `${Math.max(0, Math.min(100, sample.soc_pct)) * 3.267} 326.7` : '0 326.7');
        const charge = stale ? 'Состояние заряда неизвестно' : chargeNames[battery.charging_state] || 'Неизвестно';
        el('nx-batt-charge').textContent = charge;
        el('nx-batt-badge').textContent = stale ? 'Нет свежих данных' : 'Данные поступают';
        el('nx-batt-badge').setAttribute('data-fresh', String(!stale));
        el('nx-batt-age').textContent = sample
            ? `${stale ? 'Сохранённое показание. ' : ''}Возраст измерения: ${number(age, 1)} с.${battery.error ? ' ' + battery.error : ''}`
            : battery && battery.error || 'Измерения BMS пока не получены.';
        const metrics = el('nx-batt-metrics');
        metrics.replaceChildren();
        if (sample) for (const [label, value] of [
            ['Напряжение', number(sample.voltage_V, 2) + ' В'],
            ['Ток', number(sample.current_A, 2) + ' А'],
            ['Мощность', number(sample.power_W, 1) + ' Вт'],
            ['Осталось', number(sample.remaining_Ah, 1) + ' А·ч'],
            ['Полная ёмкость', number(sample.full_charge_capacity_Ah, 1) + ' А·ч'],
            ['Циклы', String(finite(sample.cycles) ? sample.cycles : '—')]
        ]) metric(metrics, label, value);
        el('nx-batt-device').textContent = battery && battery.device
            ? `${battery.device.model || 'JK BMS'} · HW ${battery.device.hardware || '—'} · ПО ${battery.device.software || '—'} · BLE → NATS`
            : 'Ожидание устройства BMS';
        const extra = el('nx-batt-extra');
        extra.replaceChildren();
        if (sample) for (const [label, value] of [
            ['Разброс ячеек', number(finite(sample.cell_delta_V) ? sample.cell_delta_V * 1000 : null, 0) + ' мВ'],
            ['Сумма ячеек', number(sample.cell_sum_V, 2) + ' В'],
            ['Ток балансировки', number(sample.balance_current_A, 2) + ' А'],
            ['Температура MOS', number(sample.mos_temperature_C, 1) + ' °C'],
            ['Температура 1', number(sample.temperature_1_C, 1) + ' °C'],
            ['Температура 2', number(sample.temperature_2_C, 1) + ' °C']
        ]) metric(extra, label, value);
        const cells = el('nx-batt-cells');
        cells.replaceChildren();
        for (const [cell, value] of Object.entries(sample && sample.cells_V || {})) metric(cells, 'Ячейка ' + cell, number(value, 3) + ' В');
        el('nx-batt-detail').textContent = 'Заряд/разряд определяется по току с порогом ±0,1 А. Ток около нуля не подтверждает полный заряд. Флаги: ' +
            (sample && sample.flags_raw || '—') + ' (сырая битовая маска; смысл битов не подтверждён).';
    }
    function renderState() {
        const fresh = freshState();
        const mode = state && state.mode || {};
        el('nx-kpi-age').textContent = received === null ? '—' : number(ageSince(), 1) + ' с';
        const sources = state && state.telemetry && state.telemetry.sources || {};
        const missing = [['lidar', 'лидар'], ['imu', 'IMU'], ['odometry', 'одометрия']]
            .filter(([key]) => !fresh || !sources[key] || sources[key].stale || !finite(sources[key].age_s) || sources[key].age_s > 2);
        el('nx-kpi-sens').textContent = `${3 - missing.length} / 3` + (missing.length ? ' (нет: ' + missing.map(m => m[1]).join(', ') + ')' : '');
        if (fresh) { el('nx-conn-dot').setAttribute('data-s', 'live'); el('nx-conn-text').textContent = `Подключён · ${number(ageSince(), 1)} с назад`; }
        else { el('nx-conn-dot').setAttribute('data-s', received === null ? 'off' : 'err');
            el('nx-conn-text').textContent = connected ? 'Нет свежего состояния робота' : 'Нет связи'; }
        el('nx-cab-dot').setAttribute('data-s', el('nx-conn-dot').getAttribute('data-s'));
        el('nx-cab-status').textContent = el('nx-conn-text').textContent;
        renderBattery();
        renderEngineerLive();
        updateControls();
    }
    function acceptState(next) {
        if (!next || typeof next !== 'object' || !next.mode) throw Error('Некорректное состояние робота');
        state = next;
        received = performance.now();
        connected = !(next.transport && next.transport.connected === false);
        const scope = (next.mode.actual || '') + ':' + (next.mode.pid || '');
        if (scope !== modeScope) { el('nx-discard').checked = false; modeScope = scope; }
        if (!noteDirty && document.activeElement !== el('nx-note')) el('nx-note').value = next.settings ? next.settings.note || '' : '';
        if (!el('nx-mode-map').value && next.mode.actual !== 'idle' && maps.includes(next.mode.map)) el('nx-mode-map').value = next.mode.map;
        const operation = next.mode.operation;
        if (pendingModeId && operation && operation.id === pendingModeId) {
            if (operation.status === 'succeeded') { result('nx-mode-result', `Режим «${names[next.mode.actual] || next.mode.actual}» подтверждён.`); pendingModeId = null; }
            else if (operation.status === 'failed') { result('nx-mode-result', 'Переключение не выполнено: ' + (operation.error || next.mode.error || 'проверьте состояние компонентов'), true); pendingModeId = null; }
        }
        renderState();
    }
    async function refresh() {
        if (refreshing || document.hidden) return;
        refreshing = true;
        try {
            const data = await api('/api/metrics');
            const next = data.result && data.result['service.snapshot'] && data.result['service.snapshot'].value;
            if (!next) throw Error('В ответе нет состояния робота');
            values = data.result;
            acceptState(next);
        } catch (error) {
            connected = false;
            el('nx-conn-dot').setAttribute('data-s', 'err');
            el('nx-conn-text').textContent = 'Нет связи: ' + errorText(error);
            renderState();
        } finally { refreshing = false; }
    }
    async function loadMaps(forceSchema = false) {
        if (mapsTask) return mapsTask;
        mapsTask = (async () => {
            const results = await Promise.allSettled([
                forceSchema || !schema ? command('schema.get') : Promise.resolve(schema),
                api('/api/map?part=saved')
            ]);
            const previous = el('nx-mode-map').value;
            if (results[0].status === 'fulfilled') schema = results[0].value;
            const ids = new Set(Array.isArray(schema && schema.maps) ? schema.maps.filter(id => typeof id === 'string') : []);
            let savedList = [];
            if (results[1].status === 'fulfilled') savedList = results[1].value.result && results[1].value.result.maps || [];
            for (const m of savedList) if (typeof m.name === 'string' && m.grid !== false) ids.add(m.name);
            if (results.every(r => r.status === 'rejected')) { el('nx-loc-map').replaceChildren(); return; }
            maps = [...ids].sort((a, b) => a.localeCompare(b));
            for (const [selectId, list] of [['nx-mode-map', maps],
                ['nx-loc-map', savedList.filter(m => m && typeof m.name === 'string' && m.grid !== false).map(m => m.name)]]) {
                const select = el(selectId);
                const current = select.value;
                select.replaceChildren();
                for (const name of list) { const o = document.createElement('option'); o.value = name; o.textContent = name; select.append(o); }
                select.value = list.includes(current) ? current : list[0] || '';
            }
            const activeMap = state && state.mode && state.mode.actual !== 'idle' ? state.mode.map : '';
            if (!maps.includes(previous) && maps.includes(activeMap)) el('nx-mode-map').value = activeMap;
        })();
        updateControls();
        try { await mapsTask; } finally { mapsTask = null; updateControls(); }
    }
    async function selectMode(target) {
        const blocked = modeReason(target);
        if (blocked) { result('nx-mode-result', blocked, true); return; }
        modeSubmitting = true;
        updateControls();
        try {
            const current = await api('/api/state');
            acceptState(current.result);
            const reason = modeReason(target, true);
            if (reason) throw Error(reason);
            const map = el('nx-mode-map').value;
            const question = target === 'idle'
                ? `Завершить режим «${names[state.mode.actual] || state.mode.actual}»? Робот должен быть неподвижен. Завершение может отправить нулевую скорость.${state.mode.actual === 'mapping' ? ' Убедитесь, что нужная карта сохранена.' : ''}`
                : `Запустить режим «${names[target]}»${['localization', 'navigation'].includes(target) ? ' на карте «' + map + '»' : ''}? Подтвердите, что робот неподвижен и управление сейчас не используется. Цель движения этим действием не задаётся.`;
            if (!window.confirm(question)) { result('nx-mode-result', 'Запрос отменён. Режим не изменён.'); return; }
            const args = { mode: target };
            if (target === 'idle' && state.mode.actual === 'mapping') args.discard = el('nx-discard').checked;
            if (['localization', 'navigation'].includes(target)) args.map = map;
            result('nx-mode-result', 'Запрос отправляется…');
            const updated = await command('mode.set', args);
            pendingModeId = updated && updated.operation && updated.operation.id || null;
            if (updated && updated.actual) state.mode = updated;
            result('nx-mode-result', updated && updated.operation && updated.operation.status === 'running'
                ? 'Запрос принят. Ожидается запуск компонентов…' : 'Запрос режима принят.');
            log('cmd', 'mode.set ' + target + ' → принят');
        } catch (error) {
            result('nx-mode-result', 'Режим не подтверждён: ' + errorText(error), true);
            log('err', 'mode.set ' + target + ': ' + errorText(error));
        } finally { modeSubmitting = false; updateControls(); refresh(); }
    }
    modeButtons = [...document.querySelectorAll('.nx-mode-btn')];
    modeButtons.forEach(b => b.addEventListener('click', () => selectMode(b.dataset.mode)));
    el('nx-maps-refresh').addEventListener('click', () => loadMaps(true));
    el('nx-mode-map').addEventListener('change', updateControls);
    el('nx-discard').addEventListener('change', updateControls);
    el('nx-note').addEventListener('input', () => { noteDirty = true; result('nx-note-result', 'Есть несохранённые изменения.'); updateControls(); });
    el('nx-note-save').addEventListener('click', async () => {
        if (!freshState() || noteSaving || !noteDirty) return;
        noteSaving = true; updateControls();
        const text = el('nx-note').value;
        try {
            await command('settings.set', { note: text });
            if (el('nx-note').value === text) noteDirty = false;
            if (state) state.settings = Object.assign({}, state.settings, { note: text });
            result('nx-note-result', el('nx-note').value === text ? 'Заметка сохранена.' : 'Предыдущий текст сохранён. Есть новые несохранённые изменения.');
            log('cmd', 'заметка сохранена');
        } catch (error) { result('nx-note-result', 'Заметка не сохранена: ' + errorText(error), true); }
        finally { noteSaving = false; updateControls(); }
    });

    /* ---------- карта (порт map.js) ---------- */
    const projection = new ol.proj.Projection({ code: 'VERTER_MAP', units: 'm' });
    let image = null, displayed = null, latest = null, lastPose = null, model = null;
    let metaBusy = false, poseBusy = false, lastPoseReply = 0, scanBusy = false, lastScan = null, scanReply = 0, saving = false, saveError = null, saveRequestId = null;
    let metadataReply = null, notifiedSave = null, observedSave = false;
    const raster = new ol.source.ImageCanvas({
        projection, ratio: 1, interpolate: false,
        canvasFunction(extent, resolution, pixelRatio, size) {
            const canvas = document.createElement('canvas');
            canvas.width = size[0]; canvas.height = size[1];
            if (!image || !displayed) return canvas;
            const ctx = canvas.getContext('2d');
            const sx = size[0] / (extent[2] - extent[0]), sy = size[1] / (extent[3] - extent[1]);
            ctx.imageSmoothingEnabled = false;
            ctx.setTransform(sx, 0, 0, -sy, -extent[0] * sx, extent[3] * sy);
            ctx.translate(displayed.origin.x, displayed.origin.y);
            ctx.rotate(displayed.origin.yaw);
            ctx.translate(0, displayed.height * displayed.resolution);
            ctx.scale(displayed.resolution, -displayed.resolution);
            ctx.drawImage(image, 0, 0);
            return canvas;
        }
    });
    const robots = new ol.source.Vector({ wrapX: false });
    const laser = new ol.source.Vector({ wrapX: false });
    const overlays = new ol.source.Vector({ wrapX: false });
    const view = new ol.View({ projection, center: [0, 0], resolution: .02, minResolution: .001, maxResolution: 10 });
    const map = new ol.Map({
        target: 'nx-ol-map', view,
        layers: [
            new ol.layer.Image({ source: raster }),
            new ol.layer.Vector({ source: laser, style: new ol.style.Style({ image: new ol.style.Circle({ radius: 2, fill: new ol.style.Fill({ color: '#c8ed00' }) }) }) }),
            new ol.layer.Vector({ source: robots, style: f => f.get('kind') === 'center'
                ? new ol.style.Style({ image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: '#b5e5ff' }), stroke: new ol.style.Stroke({ color: '#000', width: 1 }) }) })
                : new ol.style.Style({ fill: new ol.style.Fill({ color: f.get('kind') === 'body' ? 'rgba(200,237,0,.4)' : 'rgba(181,229,255,.6)' }),
                    stroke: new ol.style.Stroke({ color: f.get('kind') === 'arrow' ? '#c8ed00' : '#b5e5ff', width: 2 }) }) }),
            new ol.layer.Vector({ source: overlays, style: f => {
                const kind = f.get('kind');
                const color = kind === 'initial' ? '#ffb75e' : kind === 'draft' ? '#ffe28a' : '#70e8c3';
                if (kind === 'route') return new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#be9aff', width: 2, lineDash: [8, 6] }) });
                return new ol.style.Style({
                    image: new ol.style.Circle({ radius: kind === 'point' ? 5 : 7, fill: new ol.style.Fill({ color }), stroke: new ol.style.Stroke({ color: '#000', width: 2 }) }),
                    stroke: new ol.style.Stroke({ color, width: 2 }),
                    text: new ol.style.Text({ text: f.get('label') || '', offsetY: -15, font: '13px system-ui', fill: new ol.style.Fill({ color }), stroke: new ol.style.Stroke({ color: '#000', width: 3 }) })
                });
            } })
        ]
    });
    map.addControl(new ol.control.ScaleLine({ units: 'metric' }));
    map.on('pointermove', e => { el('nx-cursor-info').textContent = `Курсор: x ${e.coordinate[0].toFixed(2)} м · y ${e.coordinate[1].toFixed(2)} м`; });
    map.on('pointerdrag', () => { el('nx-follow').checked = false; });

    function mapState() {
        const available = !!displayed && !!latest && latest.available && displayed.map_id === latest.map_id && displayed.revision === latest.revision;
        const stale = !available || !!latest.stale || document.hidden || metadataReply === null || performance.now() - metadataReply > 3500;
        return { available, stale };
    }
    function poseValid() {
        const st = mapState();
        const age = Math.max(0, lastPose && lastPose.age_s || 0) + (performance.now() - lastPoseReply) / 1000;
        return st.available && !st.stale && lastPose && lastPose.valid === true && lastPose.map_id === displayed.map_id &&
            lastPose.revision === displayed.revision && Number.isFinite(age) && age <= 1.5 &&
            ['x', 'y', 'yaw'].every(k => Number.isFinite(lastPose[k]));
    }
    function scanValid() {
        const st = mapState();
        const age = Math.max(0, lastScan && lastScan.age_s || 0) + (performance.now() - scanReply) / 1000;
        return st.available && !st.stale && lastScan && lastScan.valid === true && lastScan.map_id === displayed.map_id &&
            lastScan.revision === displayed.revision && Number.isFinite(age) && age <= 1.5 &&
            Array.isArray(lastScan.points) && lastScan.points.length <= 1800 &&
            lastScan.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    }
    function world(x, y, origin) {
        return [origin.x + x * Math.cos(origin.yaw) - y * Math.sin(origin.yaw),
            origin.y + x * Math.sin(origin.yaw) + y * Math.cos(origin.yaw)];
    }
    function fit() {
        if (!displayed) return;
        const w = displayed.width * displayed.resolution, h = displayed.height * displayed.resolution;
        const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => world(x, y, displayed.origin));
        view.fit(ol.extent.boundingExtent(corners), { padding: [30, 30, 30, 30], duration: 0 });
        el('nx-follow').checked = false;
    }
    function drawRobot() {
        robots.clear();
        el('nx-fit-robot').disabled = true;
        el('nx-follow').disabled = !poseValid();
        el('nx-follow').title = poseValid() ? 'Следовать за свежим положением робота' : 'Нужно свежее положение робота на отображаемой карте';
        if (!poseValid()) { el('nx-pose-info').textContent = 'Положение робота неизвестно · ' + (lastPose && lastPose.reason || 'ожидание свежего TF map → base_footprint'); return; }
        const pose = lastPose, transform = p => world(p[0], p[1], pose);
        for (const polygon of model && model.polygons || []) {
            const points = polygon.points.map(transform); points.push(points[0]);
            robots.addFeature(new ol.Feature({ geometry: new ol.geom.Polygon([points]), kind: polygon.kind }));
        }
        robots.addFeature(new ol.Feature({ geometry: new ol.geom.Point([pose.x, pose.y]), kind: 'center' }));
        robots.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([[0, 0], [.36, 0], [.28, .05], [.36, 0], [.28, -.05]].map(transform)), kind: 'arrow' }));
        el('nx-pose-info').textContent = `Робот: x ${pose.x.toFixed(2)} м · y ${pose.y.toFixed(2)} м · угол ${(pose.yaw * 180 / Math.PI).toFixed(1)}° · map`;
        el('nx-fit-robot').disabled = false;
        if (el('nx-follow').checked) view.setCenter([pose.x, pose.y]);
    }
    function drawScan() {
        laser.clear();
        if (!el('nx-show-scan').checked) { el('nx-scan-info').textContent = 'Точки лидара скрыты'; return; }
        if (!scanValid()) { el('nx-scan-info').textContent = 'Облако лидара недоступно · ' + (lastScan && lastScan.reason || 'ожидание TF'); return; }
        laser.addFeature(new ol.Feature({ geometry: new ol.geom.MultiPoint(lastScan.points) }));
        el('nx-scan-info').textContent = `Лидар: ${lastScan.points.length} точек · исходных лучей ${lastScan.raw_count} · возраст ${lastScan.age_s.toFixed(2)} с`;
    }
    function validate(metadata) {
        if (metadata.frame_id !== 'map' || metadata.encoding !== 'zlib-int8-row-major' ||
            !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0 ||
            metadata.width * metadata.height > 4194304 || metadata.decoded_bytes !== metadata.width * metadata.height ||
            !Number.isFinite(metadata.resolution) || metadata.resolution <= 0 ||
            !metadata.origin || !['x', 'y', 'yaw'].every(k => Number.isFinite(metadata.origin[k])) ||
            !Number.isInteger(metadata.compressed_bytes) || metadata.compressed_bytes < 1 || metadata.compressed_bytes > 4260000 ||
            !Number.isInteger(metadata.chunk_bytes) || metadata.chunk_bytes < 1 || metadata.chunk_bytes > 65536 ||
            metadata.chunks !== Math.ceil(metadata.compressed_bytes / metadata.chunk_bytes) ||
            !Number.isInteger(metadata.revision) || metadata.revision < 1 || typeof metadata.map_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(metadata.sha256) || !/^[0-9a-f]{64}$/.test(metadata.decoded_sha256))
            throw Error('Некорректные параметры карты');
    }
    function unpack(packed, expected) {
        const parts = []; let length = 0;
        const inflater = new pako.Inflate({ chunkSize: 65536 });
        inflater.onData = chunk => { length += chunk.length; if (length > expected) throw Error('Превышен размер карты'); parts.push(chunk); };
        inflater.push(packed, true);
        if (inflater.err || length !== expected) throw Error('Не удалось распаковать карту');
        const bytes = new Uint8Array(length); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return bytes;
    }
    async function load(metadata) {
        validate(metadata);
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 60000);
        try {
            const packed = new Uint8Array(metadata.compressed_bytes);
            for (let index = 0; index < metadata.chunks; index++) {
                el('nx-map-status').textContent = `Получение карты: ${index + 1}/${metadata.chunks}`;
                const chunk = await api(`/api/map?${new URLSearchParams({ part: 'chunk', map_id: metadata.map_id, revision: metadata.revision, index })}`, undefined, 60000);
                if (chunk.map_id !== metadata.map_id || chunk.revision !== metadata.revision || chunk.index !== index || chunk.chunks !== metadata.chunks)
                    throw Error('Части карты относятся к разным версиям');
                const bytes = Uint8Array.from(atob(chunk.data_b64), v => v.charCodeAt(0));
                const offset = index * metadata.chunk_bytes;
                if (bytes.length !== Math.min(metadata.chunk_bytes, metadata.compressed_bytes - offset)) throw Error('Неверный размер части карты');
                packed.set(bytes, offset);
            }
            if (sha256(packed) !== metadata.sha256) throw Error('Не совпала контрольная сумма карты');
            const raw = unpack(packed, metadata.decoded_bytes);
            if (sha256(raw) !== metadata.decoded_sha256) throw Error('Не совпала контрольная сумма клеток');
            const canvas = document.createElement('canvas'); canvas.width = metadata.width; canvas.height = metadata.height;
            const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(metadata.width, metadata.height);
            for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
                const v = raw[y * metadata.width + x];
                if (v > 100 && v !== 255) throw Error('Некорректная клетка карты');
                const at = ((metadata.height - 1 - y) * metadata.width + x) * 4;
                const gray = v === 255 ? 125 : Math.round(245 - v * 2.2);
                pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = gray; pixels.data[at + 3] = 255;
            }
            ctx.putImageData(pixels, 0, 0);
            const newSession = !displayed || displayed.map_id !== metadata.map_id;
            image = canvas; displayed = metadata; raster.changed();
            el('nx-fit-map').disabled = false; el('nx-map-empty').hidden = true;
            if (newSession) fit();
            drawRobot(); drawScan();
        } finally { clearTimeout(timeout); }
    }
    function renderSave(stateSave) {
        const name = el('nx-save-name');
        const reason = saving || stateSave && stateSave.busy ? 'Дождитесь завершения сохранения' :
            !stateSave || !stateSave.enabled ? 'Сохранение отключено или состояние ещё не получено' :
            !latest || latest.mode !== 'mapping' ? 'Сохранение доступно при картографировании' :
            !mapState().available || mapState().stale ? 'Нужна свежая карта текущей сессии' :
            !name.value || !name.checkValidity() ? 'Введите имя: латиница, цифры, _ или -' : '';
        el('nx-save-btn').disabled = !!reason;
        el('nx-save-btn').title = reason || 'Сохранить карту и граф SLAM с указанным именем';
        if (saveError && stateSave && stateSave.id !== saveRequestId) { el('nx-save-info').textContent = saveError; return; }
        if (!stateSave) return;
        const firstObservation = !observedSave;
        observedSave = true;
        if (stateSave.status === 'running') el('nx-save-info').textContent = `Сохраняется ${stateSave.name}: ${stateSave.stage}`;
        else if (stateSave.status === 'succeeded') {
            el('nx-save-info').textContent = `Сохранено: ${stateSave.name || stateSave.base_path} · карта и граф SLAM`;
            if (stateSave.id && stateSave.id !== notifiedSave) {
                notifiedSave = stateSave.id;
                if ((!firstObservation || stateSave.id === saveRequestId)) {
                    log('ok', `карта сохранена: ${stateSave.name || stateSave.base_path}`);
                    loadMaps(false).catch(() => {});
                }
            }
        } else if (['failed', 'interrupted'].includes(stateSave.status))
            el('nx-save-info').textContent = `Сохранение не завершено: ${stateSave.error}${stateSave.grid_saved ? ' · YAML/PGM уже созданы; выберите новое имя для повторной попытки' : ''}`;
        else el('nx-save-info').textContent = reason || 'Карта готова к сохранению. Сначала остановите робота вручную.';
    }
    async function pollMetadata() {
        if (metaBusy || document.hidden) return;
        metaBusy = true;
        try {
            latest = await api('/api/map?part=metadata', undefined, 6000);
            metadataReply = performance.now();
            renderSave(latest.save);
            if (!latest.available) {
                image = displayed = null; raster.changed(); robots.clear(); laser.clear();
                el('nx-fit-map').disabled = el('nx-fit-robot').disabled = true;
                el('nx-map-empty').hidden = false;
                el('nx-map-empty-text').textContent = latest.mode === 'idle'
                    ? 'Нет активной карты. Выберите сохранённую карту и запустите локализацию либо включите картографирование.'
                    : 'Ожидание карты текущего режима…';
                el('nx-map-status').textContent = `Режим: ${latest.mode} · ${latest.reason}`;
                el('nx-map-info').textContent = 'Карта пока не получена';
            } else {
                if (!displayed || displayed.map_id !== latest.map_id || displayed.revision !== latest.revision) await load(latest);
                el('nx-map-status').textContent = latest.stale ? `Карта устарела · ${latest.error || latest.age_s + ' с'}` : `Карта получена · версия ${latest.revision} · ${latest.age_s} с`;
                el('nx-map-info').textContent = `${latest.width} × ${latest.height} клеток · ${latest.resolution} м/клетку · origin (${latest.origin.x.toFixed(2)}, ${latest.origin.y.toFixed(2)}), ${(latest.origin.yaw * 180 / Math.PI).toFixed(1)}°`;
            }
            el('nx-map-dot').setAttribute('data-s', !latest.available || latest.stale ? 'wait' : 'live');
            drawRobot(); drawScan();
            const diagnostics = await api('/api/map?part=diagnostics', undefined, 6000);
            el('nx-scan-quality').textContent = diagnostics.variable_scan_geometry
                ? `Геометрия /scan меняется: ${diagnostics.beam_count_min}–${diagnostics.beam_count_max} лучей за 10 с. Это требует проверки входных данных SLAM.` : '';
        } catch (error) {
            if (latest) latest.stale = true;
            drawRobot(); drawScan(); renderSave(latest && latest.save);
            el('nx-map-status').textContent = 'Нет обновления карты: ' + error.message;
            el('nx-map-dot').setAttribute('data-s', 'err');
        } finally { metaBusy = false; }
    }
    async function pollPose() {
        if (poseBusy || document.hidden) return;
        poseBusy = true;
        try { lastPose = await api('/api/map?part=pose', undefined, 6000); lastPoseReply = performance.now(); }
        catch (error) { lastPose = { valid: false, reason: error.message }; }
        finally { poseBusy = false; drawRobot(); }
    }
    async function pollScan() {
        if (scanBusy || document.hidden) return;
        scanBusy = true;
        try { lastScan = await api('/api/map?part=scan', undefined, 6000); scanReply = performance.now(); }
        catch (error) { lastScan = { valid: false, reason: error.message }; }
        finally { scanBusy = false; drawScan(); }
    }
    el('nx-show-scan').addEventListener('change', drawScan);
    el('nx-fit-map').addEventListener('click', fit);
    el('nx-fit-robot').addEventListener('click', () => { if (poseValid()) { view.setCenter([lastPose.x, lastPose.y]); view.setResolution(.01); } });
    el('nx-follow').addEventListener('change', drawRobot);
    el('nx-map-empty-btn').addEventListener('click', () => {
        const tabBtn = document.querySelector('[data-nx-tab="loc"]');
        if (tabBtn) tabBtn.click();
    });

    /* ---------- инструменты: локализация, точки, маршруты (порт localization-ui.js) ---------- */
    let locMode = null, locSnapshot = null, locReply = 0, selectedMap = '', points = [], routes = [], routeOrder = [];
    let catalogsReady = false, catalogRevision = null, catalogToken = 0, changing = false, locPolling = false;
    let placement = null, pointerOrigin = null, initialPose = null, pointPose = null, lastScope = '', lastInitialization = '';
    let locError = null;

    const freshLoc = () => !document.hidden && !!locMode && !!locSnapshot && performance.now() - locReply < 4500 && !locMode.stale;
    function activeScope() {
        const viewState = { available: displayed !== null, stale: !mapState().available || mapState().stale };
        return freshLoc() && locMode.actual && ['localization', 'navigation'].includes(locMode.actual) &&
            !viewState.stale && locMode.map === selectedMap && locSnapshot.map === selectedMap &&
            displayed && displayed.saved_map === selectedMap && displayed.frame_id === 'map' &&
            (!locSnapshot.pose || !locSnapshot.pose.map_id || locSnapshot.pose.map_id === displayed.map_id);
    }
    const canPlace = () => !!selectedMap && activeScope() && !changing;
    const canInitialize = () => canPlace() && locMode && locMode.actual === 'localization' && !!locSnapshot.session_id &&
        locSnapshot.enabled !== false && !locSnapshot.initializing;
    function freshPose() {
        const pose = locSnapshot && locSnapshot.pose;
        if (!freshLoc() || !pose) return false;
        const now = performance.now();
        let age = Number.isFinite(pose.age_s) ? pose.age_s + (now - locReply) / 1000 : (now - locReply) / 1000;
        if (Number.isFinite(pose.sample_at) && serverClock) age = serverClock.at + (now - serverClock.midpoint) / 1000 - pose.sample_at;
        return pose.valid !== false && pose.stale !== true && locSnapshot.stale !== true &&
            ['x', 'y', 'yaw'].every(k => Number.isFinite(pose[k])) && Number.isFinite(age) && age >= -1 && age <= 2;
    }
    function normalized(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
    function poseFromFields(prefix) {
        const f = ['x', 'y', 'yaw'].map(n => el(`${prefix}-${n}`));
        if (f.some(i => i.value.trim() === '' || !i.checkValidity())) return null;
        const [x, y, deg] = f.map(i => Number(i.value));
        if (![x, y, deg].every(Number.isFinite)) return null;
        return { x, y, yaw: normalized(deg * Math.PI / 180) };
    }
    function fillPose(prefix, pose) {
        el(`${prefix}-x`).value = pose.x.toFixed(3);
        el(`${prefix}-y`).value = pose.y.toFixed(3);
        el(`${prefix}-yaw`).value = (normalized(pose.yaw) * 180 / Math.PI).toFixed(1);
    }
    function identityReady(prefix) {
        const id = el(`${prefix}-id`), label = el(`${prefix}-label`);
        return !!id.value && id.checkValidity() && !!label.value.trim() && label.value.trim().length <= 100 && label.checkValidity();
    }
    function confirmationReason() {
        if (!freshLoc()) return 'Нужно свежее состояние локализации';
        if (!activeScope()) return 'На экране должна быть выбранная активная карта';
        if (locSnapshot.enabled === false) return 'Изменение начального положения отключено';
        if (locMode.actual !== 'localization') return 'Подтверждение доступно в режиме локализации';
        if (locSnapshot.verified) return 'Положение уже подтверждено';
        if (!locSnapshot.session_id || !locSnapshot.initialization_id || !locSnapshot.ready_for_confirmation || !freshPose())
            return 'Сначала задайте начальную позу и дождитесь свежего положения и лидара';
        if (!el('nx-align').checked) return 'Отметьте визуальную проверку совпадения с картой';
        return '';
    }
    function contextHint() {
        if (locError) return 'Нет свежего состояния: ' + locError;
        if (!freshLoc()) return 'Ожидание связи и состояния робота.';
        if (!selectedMap) return 'Сохранённых карт нет. Постройте и сохраните карту в режиме картографирования.';
        if (locMode.actual === 'idle') return `Выбран каталог «${selectedMap}». Для показа карты запустите её локализацию.`;
        if (locMode.actual === 'mapping') return 'Идёт картографирование. Сохранение — во вкладке «Сохранение».';
        if (locMode.map !== selectedMap || (displayed && displayed.saved_map) !== selectedMap)
            return `Выбран каталог «${selectedMap}», активная карта — «${locMode.map || '—'}». Выбор каталога не переключает режим робота.`;
        if (!activeScope()) return 'Ожидание свежей карты текущей сессии.';
        if (locSnapshot.enabled === false) return 'Задание начальной позы отключено в настройках.';
        if (locSnapshot.verified) return 'Положение подтверждено. Для новой точки заполните ID и название.';
        if (locSnapshot.ready_for_confirmation) return 'Проверьте совпадение модели и лидара с картой, отметьте проверку и подтвердите положение.';
        return 'Выберите начальную позу на карте или введите координаты, отправьте её и дождитесь оценки положения.';
    }
    function setAvailability(id, reason) { const b = el(id); b.disabled = !!reason; b.title = reason || ''; }
    function updateToolControls() {
        el('nx-loc-map').disabled = changing;
        el('nx-loc-refresh').disabled = changing;
        el('nx-loc-start').disabled = changing || !selectedMap || !freshLoc() || locMode.actual !== 'idle' ||
            locMode.execution_enabled === false || (locMode.operation && locMode.operation.status === 'running');
        setAvailability('nx-init-place', changing ? 'Дождитесь завершения действия' :
            !canInitialize() ? 'Нужна активная локализация выбранной карты и разрешение начальной позы' : '');
        setAvailability('nx-init-place-point', '');
        setAvailability('nx-pt-place', changing ? 'Дождитесь завершения действия' :
            !canPlace() ? 'Нужна свежая выбранная карта в режиме локализации или навигации' : '');
        setAvailability('nx-init-apply', changing ? 'Дождитесь завершения действия' : !canInitialize() ? 'Нужна активная локализация выбранной карты' :
            !poseFromFields('nx-init') ? 'Укажите X, Y и угол начального положения' :
            !el('nx-std-xy').checkValidity() || !el('nx-std-yaw').checkValidity() ? 'Проверьте значения начальной неопределённости' : '');
        setAvailability('nx-loc-confirm', changing ? 'Дождитесь завершения действия' : confirmationReason());
        const mapRequired = !selectedMap || !catalogsReady ? 'Выберите карту и дождитесь загрузки каталога' : '';
        setAvailability('nx-pt-save', changing ? 'Дождитесь завершения действия' : mapRequired ||
            !identityReady('nx-pt') ? 'Заполните корректные ID и название точки (до 100 символов)' :
            !poseFromFields('nx-pt') ? 'Введите координаты точки или выберите её на карте' : '');
        setAvailability('nx-pt-cur', changing ? 'Дождитесь завершения действия' : mapRequired ||
            !identityReady('nx-pt') ? 'Сначала заполните ID и название точки' :
            !freshLoc() || locSnapshot.verified !== true || !freshPose() || !activeScope()
                ? 'Нужно подтверждённое свежее положение на выбранной карте' : '');
        setAvailability('nx-rt-add', changing ? 'Дождитесь завершения действия' : mapRequired ||
            !points.length ? 'Сначала сохраните хотя бы одну точку' : routeOrder.length >= 100 ? 'Не более 100 точек' : '');
        setAvailability('nx-rt-save', changing ? 'Дождитесь завершения действия' : mapRequired ||
            !identityReady('nx-rt') ? 'Заполните корректные ID и название маршрута' :
            !routeOrder.length || routeOrder.length > 100 || routeOrder.some(id => !points.some(p => p.id === id))
                ? 'Добавьте от 1 до 100 существующих точек' : '');
        el('nx-pt-new').disabled = changing;
        el('nx-rt-new').disabled = changing;
        if (placement && !canPlace()) cancelPlacement();
        el('nx-place-info').textContent = placement
            ? 'Нажмите точку на карте; удерживайте и протяните указатель для направления. Это только выбор координат.'
            : contextHint();
    }
    function drawPose(pose, kind, label) {
        if (!pose || !['x', 'y', 'yaw'].every(k => Number.isFinite(pose[k]))) return;
        const start = [pose.x, pose.y];
        const length = Math.max(0.25, view.getResolution() * 22);
        const tip = [pose.x + length * Math.cos(pose.yaw), pose.y + length * Math.sin(pose.yaw)];
        overlays.addFeature(new ol.Feature({ geometry: new ol.geom.Point(start), kind, label }));
        overlays.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([start, tip]), kind }));
        const side = length * 0.25;
        overlays.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([
            [tip[0] - side * Math.cos(pose.yaw - 0.5), tip[1] - side * Math.sin(pose.yaw - 0.5)], tip,
            [tip[0] - side * Math.cos(pose.yaw + 0.5), tip[1] - side * Math.sin(pose.yaw + 0.5)]]), kind }));
    }
    function renderOverlay() {
        overlays.clear();
        if (!activeScope()) return;
        for (const point of points) {
            const positions = routeOrder.flatMap((id, i) => id === point.id ? [i + 1] : []);
            drawPose(point, 'point', (positions.length ? positions.join(', ') + ': ' : '') + (point.label || point.id));
        }
        const coords = routeOrder.map(id => (points.find(p => p.id === id))).filter(Boolean).map(p => [p.x, p.y]);
        if (coords.length > 1) overlays.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(coords), kind: 'route' }));
        drawPose(initialPose, 'initial', 'Начальная поза · ещё не отправлена');
        drawPose(pointPose, 'draft', 'Редактируемая точка');
    }
    let suspendedPans = [];
    function cancelPlacement() {
        suspendedPans.forEach(i => i.setActive(true));
        suspendedPans = [];
        placement = null; pointerOrigin = null;
        document.body.classList.remove('nx-placing');
        el('nx-place-cancel').hidden = true;
    }
    function beginPlacement(kind) {
        if (!canPlace() || (kind === 'initial' && !canInitialize())) return;
        cancelPlacement();
        map.getInteractions().getArray().forEach(i => {
            if (typeof ol.interaction.DragPan === 'function' && i instanceof ol.interaction.DragPan && i.getActive()) { suspendedPans.push(i); i.setActive(false); }
        });
        placement = kind;
        document.body.classList.add('nx-placing');
        el('nx-place-cancel').hidden = false;
    }
    function place(coordinate, dragging = false) {
        const prefix = placement === 'initial' ? 'nx-init' : 'nx-pt';
        let pose = poseFromFields(prefix) || { x: coordinate[0], y: coordinate[1], yaw: 0 };
        if (!dragging) { pose = Object.assign({}, pose, { x: coordinate[0], y: coordinate[1] }); pointerOrigin = coordinate.slice(); }
        else {
            const dx = coordinate[0] - pointerOrigin[0], dy = coordinate[1] - pointerOrigin[1];
            if (Math.hypot(dx, dy) > 0.03) pose.yaw = Math.atan2(dy, dx);
        }
        fillPose(prefix, pose);
        if (placement === 'initial') initialPose = pose; else pointPose = pose;
        updateToolControls(); renderOverlay();
    }
    const pointer = new ol.interaction.Pointer({
        handleDownEvent(event) {
            if (!placement || !canPlace() || event.originalEvent.button !== 0) return false;
            place(event.coordinate); return true;
        },
        handleDragEvent(event) { if (placement && pointerOrigin && canPlace()) place(event.coordinate, true); },
        handleUpEvent() { if (placement) { cancelPlacement(); updateToolControls(); } return false; }
    });
    map.addInteraction(pointer);
    view.on('change:resolution', renderOverlay);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && placement) { cancelPlacement(); updateToolControls(); } });

    function locMessage(text, error = false) {
        el('nx-loc-msg').textContent = text;
        el('nx-loc-msg').dataset.error = String(error);
    }
    async function refreshLoc() {
        if (locPolling || document.hidden) return;
        locPolling = true;
        try {
            const metrics = await api('/api/metrics');
            const service = metrics.result['service.snapshot'] && metrics.result['service.snapshot'].value;
            if (!service || !service.mode) throw Error('Нет состояния режима');
            const next = await command('localization.get', {}, 10);
            locMode = service.mode;
            locSnapshot = next;
            locError = null;
            locReply = performance.now();
            const scope = `${next.session_id || ''}|${next.map || ''}|${next.map_revision || ''}`;
            const initialization = `${scope}|${next.initialization_id || ''}`;
            if (lastScope && scope !== lastScope) { initialPose = null; el('nx-init-x').value = ''; el('nx-init-y').value = ''; cancelPlacement(); }
            if (initialization !== lastInitialization) el('nx-align').checked = false;
            if (catalogRevision && next.map === selectedMap && next.map_revision && next.map_revision !== catalogRevision) {
                catalogsReady = false; catalogRevision = null; points = []; routes = []; clearDrafts(); renderCatalogs();
                locMessage('Содержимое выбранной карты изменилось. Обновите каталог и задайте точки заново.', true);
            }
            lastScope = scope; lastInitialization = initialization;
        } catch (error) {
            locError = error.message; locMode = null; locSnapshot = null;
        } finally {
            locPolling = false;
            renderLocState();
        }
    }
    function renderLocState() {
        const st = freshLoc();
        el('nx-loc-mode-info').textContent = !st ? 'Нет свежего состояния режима; действия локализации заблокированы.' :
            locMode.actual === 'idle' ? 'Режим idle. Запуск локализации выполняется кнопкой после подтверждения.' :
            locMode.actual === 'mapping' ? 'Идёт картографирование. Сохраните карту и завершите режим.' :
            `Текущий режим: ${locMode.actual} · карта: ${locMode.map || '—'}. Для другой карты сначала завершите режим.`;
        el('nx-loc-status').dataset.verified = String(st && locSnapshot.verified === true);
        const descriptions = {
            waiting_for_current_session_amcl_pose: 'задайте начальную позу и дождитесь оценки положения',
            fresh_current_session_map_pose_required: 'ожидается свежее положение робота на карте',
            fresh_current_session_map_scan_required: 'ожидается свежий лидар в координатах карты',
            operator_confirmation_required: 'требуется визуальная проверка совпадения',
            initial_pose_publication_in_progress: 'отправляется начальное положение'
        };
        const explanation = descriptions[locSnapshot && locSnapshot.reason] ||
            (locSnapshot && locSnapshot.status === 'publishing' ? 'отправляется начальное положение' : 'ожидание готовности положения');
        el('nx-loc-status').textContent = !st ?
            (locError ? 'Не удалось получить локализацию: ' + locError : 'Локализация недоступна') :
            locSnapshot.verified === true ? 'Положение подтверждено оператором' :
            locSnapshot.session_id ? `Положение не подтверждено · ${explanation}` : 'Нет активной сессии локализации';
        const pose = locSnapshot && locSnapshot.pose;
        el('nx-loc-pose').textContent = freshPose() && pose
            ? `Текущее положение: x ${pose.x.toFixed(2)} м · y ${pose.y.toFixed(2)} м · угол ${(pose.yaw * 180 / Math.PI).toFixed(1)}° · карта ${locSnapshot.map}`
            : 'Текущее положение: нет свежей достоверной позы';
        if (!placement) cancelPlacement();
        updateToolControls(); renderOverlay();
    }
    function clearDrafts() {
        initialPose = null; pointPose = null;
        ['nx-init-x', 'nx-init-y'].forEach(id => el(id).value = '');
        el('nx-align').checked = false;
        el('nx-pt-form-reset');
        el('nx-pt-id').value = ''; el('nx-pt-label').value = '';
        ['nx-pt-x', 'nx-pt-y'].forEach(id => el(id).value = ''); el('nx-pt-yaw').value = '0';
        el('nx-rt-id').value = ''; el('nx-rt-label').value = ''; routeOrder = [];
        cancelPlacement();
    }
    async function mutate(operation) {
        if (changing) return;
        changing = true; cancelPlacement(); updateToolControls();
        try {
            const text = await operation();
            if (text) locMessage(text);
        } catch (error) {
            locMessage('Действие не подтверждено: ' + error.message + '. Автоматического повтора нет; обновите состояние перед повтором.', true);
            log('err', 'инструменты карты: ' + errorText(error));
        } finally { changing = false; renderLocState(); }
    }
    function assertClock() {
        if (!serverClock || performance.now() - serverClock.midpoint > 10000)
            throw Error('Нет свежей синхронизации времени с сервером');
    }
    function requireMap() {
        if (!selectedMap || !catalogsReady) throw Error('Сначала выберите карту и обновите каталог');
    }
    function recordIdentity(prefix) {
        const id = el(`${prefix}-id`), label = el(`${prefix}-label`);
        if (!id.reportValidity() || !label.reportValidity()) throw Error('Заполните ID и название');
        if (!label.value.trim()) throw Error('Название не может состоять из пробелов');
        if (label.value.trim().length > 100) throw Error('Название должно быть не длиннее 100 символов');
        return { id: id.value, label: label.value.trim() };
    }
    async function loadCatalogs() {
        const mapName = selectedMap;
        const token = ++catalogToken;
        catalogsReady = false;
        updateToolControls();
        if (!mapName) { points = []; routes = []; renderCatalogs(); return; }
        try {
            const [pointReply, routeReply] = await Promise.all([
                command('waypoint.list', { map: mapName }, 10), command('route.list', { map: mapName }, 10)]);
            if (token !== catalogToken || mapName !== selectedMap) return;
            if (pointReply.map !== mapName || routeReply.map !== mapName) throw Error('Каталоги относятся к разным версиям карты');
            catalogRevision = pointReply.map_revision || routeReply.map_revision || null;
            points = pointReply.waypoints || [];
            routes = routeReply.routes || [];
            catalogsReady = true;
        } catch (error) {
            if (token !== catalogToken) return;
            points = []; routes = [];
            locMessage('Не удалось получить точки и маршруты: ' + error.message, true);
        }
        if (token === catalogToken) renderCatalogs();
    }
    function renderCatalogs() {
        const list = el('nx-pt-list');
        list.replaceChildren();
        for (const point of points) {
            const row = document.createElement('div'); row.className = 'nx-record';
            const desc = document.createElement('div'); desc.className = 'nx-rdesc';
            desc.append(Object.assign(document.createElement('strong'), { textContent: point.label }),
                Object.assign(document.createElement('span'), { textContent: `${point.id} · x ${point.x.toFixed(2)} · y ${point.y.toFixed(2)} м · ${(point.yaw * 180 / Math.PI).toFixed(1)}°` }));
            const act = document.createElement('div'); act.className = 'nx-act';
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'nx-btn'; edit.style.padding = '4px 10px'; edit.textContent = 'Изменить';
            edit.addEventListener('click', () => { el('nx-pt-id').value = point.id; el('nx-pt-id').readOnly = true; el('nx-pt-label').value = point.label; fillPose('nx-pt', point); pointPose = Object.assign({}, point); updateToolControls(); renderOverlay(); });
            const del = document.createElement('button'); del.type = 'button'; del.className = 'nx-btn nx-btn-danger'; del.style.padding = '4px 10px'; del.textContent = 'Удалить';
            del.addEventListener('click', () => deletePoint(point));
            act.append(edit, del);
            row.append(desc, act);
            list.append(row);
        }
        const sel = el('nx-rt-point');
        const prev = sel.value;
        sel.replaceChildren();
        for (const point of points) { const o = document.createElement('option'); o.value = point.id; o.textContent = `${point.label} · ${point.id}`; sel.append(o); }
        if (points.some(p => p.id === prev)) sel.value = prev;
        const rlist = el('nx-rt-list');
        rlist.replaceChildren();
        for (const route of routes) {
            const row = document.createElement('div'); row.className = 'nx-record';
            const desc = document.createElement('div'); desc.className = 'nx-rdesc';
            desc.append(Object.assign(document.createElement('strong'), { textContent: route.label }),
                Object.assign(document.createElement('span'), { textContent: `${route.id} · ${route.kind === 'through' ? 'Прохождение' : 'Посещение'} · ${route.points.join(' → ')}` }));
            const act = document.createElement('div'); act.className = 'nx-act';
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'nx-btn'; edit.style.padding = '4px 10px'; edit.textContent = 'Изменить';
            edit.addEventListener('click', () => { el('nx-rt-id').value = route.id; el('nx-rt-id').readOnly = true; el('nx-rt-label').value = route.label; el('nx-rt-kind').value = route.kind; routeOrder = route.points.slice(); renderRouteOrder(); updateToolControls(); renderOverlay(); });
            const del = document.createElement('button'); del.type = 'button'; del.className = 'nx-btn nx-btn-danger'; del.style.padding = '4px 10px'; del.textContent = 'Удалить';
            del.addEventListener('click', () => deleteRoute(route));
            act.append(edit, del);
            row.append(desc, act);
            rlist.append(row);
        }
        el('nx-pt-note').textContent = !selectedMap ? 'Выберите сохранённую карту.' :
            !catalogsReady ? 'Каталог недоступен; обновите список перед сохранением.' :
            `Точек: ${points.length}. ID при редактировании сохраняется; для нового ID нажмите «Новая точка».`;
        el('nx-rt-note').textContent = catalogsReady ? `Описаний маршрутов: ${routes.length}. Исполнение не доступно.` : 'Каталог маршрутов пока не получен.';
        renderRouteOrder(); updateToolControls(); renderOverlay();
    }
    function renderRouteOrder() {
        const ol = el('nx-rt-order');
        ol.replaceChildren();
        routeOrder.forEach((id, index) => {
            const point = points.find(p => p.id === id);
            const li = document.createElement('li');
            li.style.marginBottom = '4px';
            li.textContent = point ? `${point.label} · ${id}` : `Недоступная точка: ${id}`;
            const up = document.createElement('button'); up.type = 'button'; up.className = 'nx-btn'; up.style.padding = '2px 8px'; up.textContent = '↑';
            up.disabled = index === 0 || changing;
            up.addEventListener('click', () => { [routeOrder[index - 1], routeOrder[index]] = [routeOrder[index], routeOrder[index - 1]]; renderRouteOrder(); renderOverlay(); });
            const down = document.createElement('button'); down.type = 'button'; down.className = 'nx-btn'; down.style.padding = '2px 8px'; down.textContent = '↓';
            down.disabled = index === routeOrder.length - 1 || changing;
            down.addEventListener('click', () => { [routeOrder[index + 1], routeOrder[index]] = [routeOrder[index], routeOrder[index + 1]]; renderRouteOrder(); renderOverlay(); });
            const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'nx-btn'; rm.style.padding = '2px 8px'; rm.textContent = 'Убрать';
            rm.addEventListener('click', () => { routeOrder.splice(index, 1); renderRouteOrder(); updateToolControls(); renderOverlay(); });
            li.append(' ', up, ' ', down, ' ', rm);
            ol.append(li);
        });
    }
    function deletePoint(point) {
        mutate(async () => {
            requireMap();
            const used = routes.filter(r => r.points.includes(point.id));
            if (used.length) throw Error('Сначала удалите точку из описаний маршрутов: ' + used.map(r => r.label).join(', '));
            if (!window.confirm(`Удалить точку «${point.label}» (${point.id}) с карты ${selectedMap}?`)) return;
            assertClock();
            await command('waypoint.delete', { map: selectedMap, id: point.id }, 10);
            if (el('nx-pt-id').value === point.id) el('nx-pt-new').click();
            await loadCatalogs();
            log('cmd', 'точка удалена: ' + point.id);
            return 'Точка удалена.';
        });
    }
    function deleteRoute(route) {
        mutate(async () => {
            requireMap();
            if (!window.confirm(`Удалить описание маршрута «${route.label}» (${route.id})?`)) return;
            assertClock();
            await command('route.delete', { map: selectedMap, id: route.id }, 10);
            if (el('nx-rt-id').value === route.id) el('nx-rt-new').click();
            await loadCatalogs();
            log('cmd', 'маршрут удалён: ' + route.id);
            return 'Описание маршрута удалено.';
        });
    }
    el('nx-loc-start').addEventListener('click', () => mutate(async () => {
        await refreshLoc();
        if (!freshLoc() || locMode.actual !== 'idle' || locMode.execution_enabled === false || (locMode.operation && locMode.operation.status === 'running'))
            throw Error('Нужен доступный режим idle. Завершите текущий режим.');
        if (!selectedMap) throw Error('Выберите сохранённую карту');
        if (!window.confirm(`Запустить режим локализации на карте «${selectedMap}»? Начальную позу затем нужно задать и подтвердить отдельно.`)) return;
        assertClock();
        await command('mode.set', { mode: 'localization', map: selectedMap });
        await refreshLoc();
        return 'Запрос запуска локализации отправлен. Дождитесь активной сессии и загрузки выбранной карты.';
    }));
    el('nx-init-apply').addEventListener('click', () => mutate(async () => {
        await refreshLoc();
        const pose = poseFromFields('nx-init');
        if (!activeScope() || locMode.actual !== 'localization' || !locSnapshot.session_id || !pose ||
            locSnapshot.enabled === false || locSnapshot.initializing)
            throw Error('Нужны активная локализация выбранной карты и корректная начальная поза');
        const xy = el('nx-std-xy'), ang = el('nx-std-yaw');
        if (!xy.reportValidity() || !ang.reportValidity() || !xy.value || !ang.value) throw Error('Проверьте начальную неопределённость');
        if (!window.confirm(`Отправить начальное положение на карту «${selectedMap}»: x=${pose.x.toFixed(2)} м, y=${pose.y.toFixed(2)} м, угол=${(pose.yaw * 180 / Math.PI).toFixed(1)}°? Прежнее подтверждение положения будет снято.`)) return;
        assertClock();
        await command('localization.initialize', {
            map: selectedMap, session_id: locSnapshot.session_id, ...pose,
            std_xy: Number(xy.value), std_yaw: Number(ang.value) * Math.PI / 180
        }, 10);
        initialPose = null; el('nx-align').checked = false;
        await refreshLoc();
        return 'Начальная поза отправлена. Проверьте совпадение модели и облака с картой, затем подтвердите положение.';
    }));
    el('nx-loc-confirm').addEventListener('click', () => mutate(async () => {
        const initialization = locSnapshot && locSnapshot.initialization_id;
        await refreshLoc();
        if (confirmationReason() || !el('nx-align').checked || !freshPose() || locSnapshot.map !== selectedMap ||
            locMode.actual !== 'localization' || !initialization || locSnapshot.initialization_id !== initialization)
            throw Error('Повторно проверьте положение и активную инициализацию');
        if (!window.confirm('Подтвердить, что реальное положение робота и облако лидара совпадают с выбранной картой?')) return;
        assertClock();
        await command('localization.confirm', { map: selectedMap, session_id: locSnapshot.session_id, initialization_id: initialization }, 10);
        await refreshLoc();
        log('cmd', 'локализация подтверждена');
        return 'Подтверждение положения сохранено.';
    }));
    el('nx-pt-save').addEventListener('click', () => mutate(async () => {
        requireMap();
        const identity = recordIdentity('nx-pt');
        const pose = poseFromFields('nx-pt');
        if (!pose) throw Error('Укажите X, Y и угол точки');
        assertClock();
        await command('waypoint.save', { map: selectedMap, ...identity, ...pose }, 10);
        await loadCatalogs();
        log('cmd', 'точка сохранена: ' + identity.id);
        return 'Точка сохранена. Положение робота не изменяется.';
    }));
    el('nx-pt-cur').addEventListener('click', () => mutate(async () => {
        const identity = recordIdentity('nx-pt');
        await refreshLoc();
        requireMap();
        if (!activeScope() || locSnapshot.verified !== true || !freshPose()) throw Error('Сначала подтвердите свежую локализацию на выбранной карте');
        assertClock();
        await command('waypoint.save', { map: selectedMap, ...identity, source: 'current' }, 10);
        await loadCatalogs();
        log('cmd', 'точка по текущему положению: ' + identity.id);
        return 'Текущее положение сохранено как точка.';
    }));
    el('nx-pt-new').addEventListener('click', () => {
        el('nx-pt-id').value = ''; el('nx-pt-id').readOnly = false;
        el('nx-pt-label').value = ''; ['nx-pt-x', 'nx-pt-y'].forEach(id => el(id).value = ''); el('nx-pt-yaw').value = '0';
        pointPose = null; updateToolControls(); renderOverlay();
    });
    el('nx-rt-new').addEventListener('click', () => {
        el('nx-rt-id').value = ''; el('nx-rt-id').readOnly = false;
        el('nx-rt-label').value = ''; routeOrder = [];
        renderRouteOrder(); updateToolControls(); renderOverlay();
    });
    el('nx-rt-add').addEventListener('click', () => {
        const id = el('nx-rt-point').value;
        if (changing || routeOrder.length >= 100) return;
        if (catalogsReady && points.some(p => p.id === id)) routeOrder.push(id);
        renderRouteOrder(); updateToolControls(); renderOverlay();
    });
    el('nx-rt-save').addEventListener('click', () => mutate(async () => {
        requireMap();
        const identity = recordIdentity('nx-rt');
        if (!routeOrder.length || routeOrder.some(id => !points.some(p => p.id === id)))
            throw Error('Добавьте существующие точки в нужном порядке');
        assertClock();
        await command('route.save', { map: selectedMap, ...identity, kind: el('nx-rt-kind').value, points: routeOrder.slice() }, 10);
        await loadCatalogs();
        log('cmd', 'маршрут сохранён: ' + identity.id);
        return 'Описание маршрута сохранено. Исполнение не запрашивалось.';
    }));
    el('nx-loc-map').addEventListener('change', () => {
        selectedMap = el('nx-loc-map').value;
        catalogRevision = null; catalogsReady = false; points = []; routes = [];
        clearDrafts(); renderCatalogs(); loadCatalogs(); renderLocState();
    });
    el('nx-loc-refresh').addEventListener('click', async () => {
        try {
            await refreshLoc();
            const metrics = await api('/api/map?part=saved');
            const available = (metrics.maps || []).filter(m => m && typeof m.name === 'string' && m.grid !== false).map(m => m.name);
            const sel = el('nx-loc-map');
            sel.replaceChildren();
            for (const name of available) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.append(o); }
            selectedMap = available.includes(selectedMap) ? selectedMap : available[0] || '';
            sel.value = selectedMap;
            await loadCatalogs(); renderLocState();
        } catch (error) { locMessage('Обновление не завершено: ' + error.message, true); }
    });
    el('nx-init-place').addEventListener('click', () => beginPlacement('initial'));
    el('nx-pt-place').addEventListener('click', () => beginPlacement('point'));
    el('nx-place-cancel').addEventListener('click', cancelPlacement);
    el('nx-align').addEventListener('change', updateToolControls);
    ['x', 'y', 'yaw'].forEach(name => {
        el('nx-init-' + name).addEventListener('input', () => { initialPose = poseFromFields('nx-init'); updateToolControls(); renderOverlay(); });
        el('nx-pt-' + name).addEventListener('input', () => { pointPose = poseFromFields('nx-pt'); updateToolControls(); renderOverlay(); });
    });
    ['nx-pt-id', 'nx-pt-label', 'nx-rt-id', 'nx-rt-label'].forEach(id => el(id).addEventListener('input', updateToolControls));
    ['nx-std-xy', 'nx-std-yaw'].forEach(id => el(id).addEventListener('input', updateToolControls));

    /* вкладки инструментов */
    document.querySelectorAll('[data-nx-tab]').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('[data-nx-tab]').forEach(x => { if (x === b) x.setAttribute('aria-selected', 'true'); else x.setAttribute('aria-selected', 'false'); });
        document.querySelectorAll('[data-nx-panel]').forEach(p => {
            const match = p.dataset.nxPanel === b.dataset.nxTab ||
                (b.dataset.nxTab === 'loc' && p.dataset.nxPanel === 'loc');
            p.hidden = !match;
        });
    }));

    /* ---------- история батареи (порт battery-history.js) ---------- */
    const histLabels = {
        soc_pct: ['Уровень заряда (SOC)', '%'], voltage_V: ['Напряжение батареи', 'В'], current_A: ['Ток', 'А'],
        power_W: ['Мощность', 'Вт'], remaining_Ah: ['Остаточная ёмкость', 'А·ч'],
        full_charge_capacity_Ah: ['Ёмкость полного заряда', 'А·ч'], cycles: ['Циклы', ''],
        mos_temperature_C: ['Температура MOS', '°C'], temperature_1_C: ['Температура 1', '°C'],
        temperature_2_C: ['Температура 2', '°C'], cell_sum_V: ['Сумма напряжений ячеек', 'В'],
        cell_delta_V: ['Разброс ячеек', 'В'], balance_current_A: ['Ток балансировки', 'А'],
        balance_state: ['Состояние балансировки', 'код'], charging_enabled: ['Заряд разрешён', '0 / 1'],
        discharging_enabled: ['Разряд разрешён', '0 / 1'], flags_raw: ['Исходные флаги BMS', 'битовая маска']
    };
    const modeColors = ['var(--charge-charging)', 'var(--charge-discharging)', 'var(--charge-idle)', 'var(--charge-unknown)'];
    const modeStateNames = ['Зарядка', 'Разрядка', 'Ток около нуля', 'Нет данных'];
    let histData = null, histBusy = false;
    const histDate = at => new Date(at * 1000).toLocaleString();
    function histSurface(canvas) {
        const box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(box.width * ratio);
        canvas.height = Math.round(box.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        return { ctx, w: box.width, h: box.height };
    }
    function drawHistChart(canvas, key, points, data) {
        const { ctx, w, h } = histSurface(canvas);
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c8ed00';
        const low = Math.min(...points.map(p => p[2])), high = Math.max(...points.map(p => p[3]));
        const padding = Math.max((high - low) * .1, Math.abs(high) * .0001, .001);
        const min = low - padding, max = high + padding;
        const x = at => 57 + (at - data.from) / (data.to - data.from) * (w - 67);
        const y = value => 12 + (max - value) / (max - min) * (h - 38);
        ctx.strokeStyle = '#4c4c4c'; ctx.lineWidth = 1;
        for (let n = 0; n < 4; n++) { const yy = 12 + n * (h - 38) / 3; ctx.beginPath(); ctx.moveTo(57, yy); ctx.lineTo(w - 10, yy); ctx.stroke(); }
        ctx.fillStyle = '#9e9e9e'; ctx.font = '10px system-ui';
        ctx.textAlign = 'left'; ctx.fillText(histDate(data.from), 57, h - 3);
        ctx.textAlign = 'right'; ctx.fillText(histDate(data.to), w - 10, h - 3);
        ctx.textAlign = 'right';
        for (let n = 0; n < 4; n++) ctx.fillText(number(max - n * (max - min) / 3, 2), 52, 15 + n * (h - 38) / 3);
        const half = Math.max(1, data.bucket_s / (data.to - data.from) * (w - 67) / 2);
        ctx.fillStyle = 'rgba(200,237,0,.2)';
        for (const p of points) ctx.fillRect(x(p[0]) - half, y(p[3]), half * 2, Math.max(1, y(p[2]) - y(p[3])));
        ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath();
        let prev = null;
        for (const p of points) {
            if (!prev || p[0] - prev[0] > data.bucket_s * 1.5) ctx.moveTo(x(p[0]), y(p[1]));
            else ctx.lineTo(x(p[0]), y(p[1]));
            prev = p;
        }
        ctx.stroke();
        ctx.fillStyle = accent;
        for (const p of points) { ctx.beginPath(); ctx.arc(x(p[0]), y(p[1]), 1.6, 0, Math.PI * 2); ctx.fill(); }
        canvas.onpointermove = event => {
            const fraction = (event.clientX - canvas.getBoundingClientRect().left - 57) / (w - 67);
            const at = data.from + fraction * (data.to - data.from);
            const point = points.reduce((a, b) => Math.abs(a[0] - at) < Math.abs(b[0] - at) ? a : b);
            const tip = document.getElementById('nx-chart-tip');
            if (Math.abs(point[0] - at) > data.bucket_s) { tip.textContent = 'Нет данных в этом интервале'; return; }
            tip.textContent = `${histDate(point[0])} · среднее ${number(point[1])} · мин. ${number(point[2])} · макс. ${number(point[3])} · последнее ${key === 'flags_raw' ? '0x' + point[4].toString(16) : number(point[4])}`;
        };
    }
    function drawModes(data) {
        const bar = el('nx-modes-bar');
        bar.replaceChildren();
        const count = data.mode_seconds.length;
        data.mode_seconds.forEach((durations, index) => {
            let top = 0;
            const seg = document.createElement('i');
            const parts = durations.map((seconds, mode) => ({ seconds, mode })).filter(p => p.seconds > 0);
            if (!parts.length) { seg.style.flex = 1; seg.style.background = 'transparent'; bar.append(seg); return; }
            segments: for (const p of parts) {
                const piece = document.createElement('i');
                piece.style.flex = p.seconds;
                piece.style.background = modeColors[p.mode];
                bar.append(piece);
            }
            void index; void count; void top;
        });
        bar.onpointermove = event => {
            const box = bar.getBoundingClientRect();
            const fraction = (event.clientX - box.left) / box.width;
            const index = Math.max(0, Math.min(count - 1, Math.floor(fraction * count)));
            el('nx-modes-tip').textContent = histDate(data.from + index * data.bucket_s) + ' · ' +
                data.mode_seconds[index].map((s, m) => `${modeStateNames[m]}: ${Math.round(s / data.bucket_s * 100)}%`).join(' · ');
        };
    }
    async function refreshHistory() {
        if (histBusy) return;
        histBusy = true; el('nx-hist-refresh').disabled = true;
        try {
            const response = await fetch(`/api/battery/history?period_s=${el('nx-period').value}&max_points=240`, { signal: AbortSignal.timeout(25000) });
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const result = await response.json();
            if (!result.ok) throw Error(result.error);
            histData = result.result;
            const soc = histData.series.soc_pct;
            el('nx-soc-summary').textContent = soc && soc.length
                ? `Последний сохранённый заряд: ${number(soc[soc.length - 1][4])} %`
                : 'Последний сохранённый заряд: нет данных в выбранном периоде';
            drawModes(histData);
            drawHistChart(el('nx-chart'), 'soc_pct', soc || [], histData);
            el('nx-hist-dot').setAttribute('data-s', 'live');
            el('nx-hist-conn').textContent = `Обновлено ${new Date().toLocaleTimeString()}`;
            el('nx-hist-cov').textContent = histData.stored_samples
                ? `Доступная история: ${histDate(histData.available_from)} — ${histDate(histData.available_to)}. В выбранном периоде ${histData.samples.toLocaleString()} снимков. Приоритет графиков: SOC, напряжение, ток, мощность, затем остальные метрики и ячейки по номерам.`
                : 'История ещё не накоплена. Первые данные появятся после получения BMS; прошлые показания не восстанавливаются.';
        } catch (error) {
            el('nx-hist-dot').setAttribute('data-s', 'err');
            el('nx-hist-conn').textContent = 'Не удалось обновить: ' + errorText(error) + (histData ? ' · показаны ранее загруженные данные' : '');
        } finally { histBusy = false; el('nx-hist-refresh').disabled = false; }
    }
    function exportLinks() {
        for (const [id, fmt] of [['nx-exp-csv', 'csv'], ['nx-exp-txt', 'txt']])
            el(id).href = `/api/battery/export?format=${fmt}&period_s=${el('nx-period').value}`;
    }
    el('nx-hist-refresh').addEventListener('click', refreshHistory);
    el('nx-period').addEventListener('change', () => { exportLinks(); refreshHistory(); });
    exportLinks();
    setInterval(() => { if (el('nx-hist-auto').checked && prefs.auto && !document.hidden) refreshHistory(); }, 30000);
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (histData) { drawHistChart(el('nx-chart'), 'soc_pct', histData.series.soc_pct || [], histData); drawModes(histData); } }, 150); });

    /* ---------- инженер ---------- */
    function renderEngineerLive() {
        if (!values) return;
        const rows = [];
        for (const [name, item] of Object.entries(state && state.telemetry && state.telemetry.sources || {})) {
            rows.push(`${name} · ${number(item.age_s, 1)} с · ${item.stale ? 'УСТАРЕЛО · ' : ''}${JSON.stringify(item.value)}`);
        }
        if (state && state.telemetry && state.telemetry.error) rows.push('telemetry.error: ' + state.telemetry.error);
        el('nx-eng-metrics').textContent = rows.join('\n') || 'Нет данных датчиков';
        el('nx-eng-state').textContent = state ? JSON.stringify(state, null, 2) : 'Состояние недоступно';
        const subj = [];
        for (const [key, item] of Object.entries(values || {})) {
            if (key.endsWith('.snapshot') || key === 'service.schema' || !item || !('value' in item)) continue;
            subj.push(`${state && state.robot_id || 'robot'}.${key.split('.')[0]}.update.${key.slice(key.indexOf('.') + 1)} → ${JSON.stringify(item.value)}${item.unit ? ' ' + item.unit : ''} · ${item.quality}`);
        }
        el('nx-eng-subjects').textContent = subj.join('\n') || '—';
    }
    async function nxPing(resultEl) {
        try {
            const sent = performance.now();
            await command('ping');
            const ms = Math.round(performance.now() - sent);
            resultEl.textContent = `Backend отвечает · ${ms} мс`;
            log('ok', 'ping · ' + ms + ' мс');
        } catch (error) {
            resultEl.textContent = errorText(error);
            resultEl.dataset.error = 'true';
            log('err', 'ping: ' + errorText(error));
        }
    }
    el('nx-eng-ping').addEventListener('click', () => nxPing(el('nx-eng-api-result')));
    el('nx-eng-schema').addEventListener('click', async () => {
        try {
            schema = await command('schema.get');
            await loadMaps(false);
            result('nx-eng-api-result', 'Словарь получен; список карт обновлён. Ответ раскрыт ниже.');
            log('cmd', 'schema.get');
        } catch (error) { result('nx-eng-api-result', errorText(error), true); }
    });

    /* ---------- кабинет ---------- */
    const CREDS_KEY = 'verter.ui.creds';
    const URL_KEY = 'verter.ui.natsWsUrl';
    const config = Object.assign({ natsWsUrl: 'wss://verter-proxy.duckdns.org', robotId: 'verter_01' }, window.VTER_UI_CONFIG || {});
    function credsText() {
        try { return localStorage.getItem(CREDS_KEY) || sessionStorage.getItem(CREDS_KEY) || ''; } catch (e) { return ''; }
    }
    function parseJwt(creds) {
        const match = creds && creds.match(/-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----END NATS USER JWT-----/);
        if (!match) return null;
        const token = match[1].trim().split(/\s+/)[0] || '';
        const parts = token.split('.');
        if (parts.length < 2) return null;
        try {
            let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (payload.length % 4) payload += '=';
            return JSON.parse(atob(payload));
        } catch (e) { return null; }
    }
    function renderCredsInfo() {
        const creds = credsText();
        const payload = parseJwt(creds);
        el('nx-op-name').textContent = payload && (payload.name || payload.sub) ? String(payload.name || payload.sub) : 'Оператор';
        el('nx-op-sub').textContent = payload && payload.sub ? 'sub: ' + payload.sub : '—';
        el('nx-robot-id').textContent = config.robotId;
        el('nx-hub').textContent = (() => {
            try { return localStorage.getItem(URL_KEY) || sessionStorage.getItem(URL_KEY) || config.natsWsUrl; } catch (e) { return config.natsWsUrl; }
        })();
        if (payload && Number.isFinite(payload.exp)) {
            const now = Date.now() / 1000;
            const days = Math.floor((payload.exp - now) / 86400);
            el('nx-exp-date').textContent = new Date(payload.exp * 1000).toLocaleDateString('ru-RU');
            el('nx-exp-left').textContent = days >= 0 ? `осталось ${days} дн.` : 'истекли';
            const elapsed = Math.max(4, Math.min(97, 100 - Math.round(days / 30 * 100)));
            el('nx-exp-fill').style.width = elapsed + '%';
            const bar = el('nx-exp-bar');
            if (days <= 3) bar.setAttribute('data-warn', ''); else bar.removeAttribute('data-warn');
            el('nx-exp-banner').hidden = !(days >= 0 && days <= 3);
        } else {
            el('nx-exp-date').textContent = '—';
            el('nx-exp-left').textContent = creds ? 'срок не определён' : 'креды не сохранены';
            el('nx-exp-fill').style.width = '0';
            el('nx-exp-banner').hidden = true;
        }
        el('nx-storage-note').textContent = 'хранение: ' + (prefs.sessionOnly ? 'sessionStorage' : 'localStorage');
        el('nx-session-only').checked = prefs.sessionOnly;
    }
    el('nx-creds-save').addEventListener('click', () => {
        const creds = el('nx-creds-input').value.trim();
        const url = el('nx-creds-url').value.trim();
        if (creds) {
            if (!/BEGIN NATS USER JWT/.test(creds) || !/USER NKEY SEED/.test(creds)) {
                el('nx-creds-err').hidden = false; return;
            }
            try {
                if (prefs.sessionOnly) { sessionStorage.setItem(CREDS_KEY, creds); localStorage.removeItem(CREDS_KEY); }
                else { localStorage.setItem(CREDS_KEY, creds); sessionStorage.removeItem(CREDS_KEY); }
            } catch (e) { /* приватный режим */ }
        }
        try {
            if (url) { localStorage.setItem(URL_KEY, url); sessionStorage.removeItem(URL_KEY); }
            else if (!creds) { localStorage.removeItem(URL_KEY); sessionStorage.removeItem(URL_KEY); }
        } catch (e) { /* приватный режим */ }
        log('ok', creds ? 'креды сохранены · перезапуск' : 'адрес хаба обновлён · перезапуск');
        location.reload();
    });
    el('nx-creds-forget').addEventListener('click', () => {
        if (!window.confirm('Забыть креды и адрес хаба? Робот потеряет управление с этого устройства до повторного входа.')) return;
        try {
            localStorage.removeItem(CREDS_KEY); sessionStorage.removeItem(CREDS_KEY);
            localStorage.removeItem(URL_KEY); sessionStorage.removeItem(URL_KEY);
        } catch (e) { /* приватный режим */ }
        log('err', 'креды удалены на устройстве');
        location.reload();
    });
    el('nx-session-only').addEventListener('change', () => {
        prefs.sessionOnly = el('nx-session-only').checked;
        savePrefs(); renderCredsInfo();
    });
    el('nx-cab-ping').addEventListener('click', () => nxPing(el('nx-cab-ping-res')));
    function applyPrefs() {
        el('nx-pref-auto').checked = prefs.auto;
        el('nx-pref-sound').checked = prefs.sound;
        el('nx-pref-eng').checked = prefs.eng;
        document.querySelectorAll('[data-nx-eng]').forEach(n => { n.style.display = prefs.eng ? '' : 'none'; });
        if (!prefs.eng && section === 'eng') show('map');
    }
    [['nx-pref-auto', 'auto'], ['nx-pref-sound', 'sound'], ['nx-pref-eng', 'eng']].forEach(([id, key]) => {
        el(id).addEventListener('change', () => {
            prefs[key] = el(id).checked;
            savePrefs(); applyPrefs();
        });
    });
    el('nx-prefs-reset').addEventListener('click', () => {
        prefs = { auto: true, sound: true, eng: true, sessionOnly: prefs.sessionOnly };
        savePrefs(); applyPrefs(); renderCredsInfo();
    });
    el('nx-journal-clear').addEventListener('click', () => { try { localStorage.removeItem(JOURNAL_KEY); } catch (e) { /* */ } renderJournal(); });

    /* ---------- часы, видимость, запуск ---------- */
    setInterval(() => { el('nx-clock').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }, 1000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { refresh(); loadMaps(false); refreshLoc(); refreshHistory(); pollMetadata(); pollPose(); pollScan(); }
        else { lastPose = null; lastScan = null; drawRobot(); drawScan(); }
    });
    setInterval(refresh, 2000);
    setInterval(() => { if (!document.hidden) renderState(); }, 1000);
    setInterval(() => { if (!document.hidden && prefs.auto) loadMaps(false); }, 30000);
    setInterval(pollMetadata, 1000);
    setInterval(pollPose, 200);
    setInterval(pollScan, 200);
    setInterval(() => {
        if (mapState().stale || !poseValid()) drawRobot();
        if (mapState().stale || !scanValid()) drawScan();
        renderSave(latest && latest.save);
    }, 500);
    setInterval(refreshLoc, 1500);
    setInterval(() => { updateToolControls(); renderOverlay(); }, 500);

    applyPrefs();
    renderJournal();
    renderCredsInfo();
    el('nx-save-name').value = 'survey_' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
    el('nx-save-name').addEventListener('input', () => renderSave(latest && latest.save));
    el('nx-save-btn').addEventListener('click', async () => {
        const name = el('nx-save-name').value;
        if (!name || !el('nx-save-name').checkValidity()) { el('nx-save-name').reportValidity(); return; }
        saving = true; saveError = null; saveRequestId = uuid(); renderSave(latest && latest.save);
        try {
            if (!serverClock || performance.now() - serverClock.midpoint > 10000) throw Error('Нет свежей синхронизации времени; дождитесь обновления карты');
            const updated = await command('map.save', { name });
            if (latest) latest.save = updated;
            renderSave(updated);
        } catch (error) {
            saveError = 'Сохранение не подтверждено: ' + error.message + '. Проверьте состояние; автоматического повтора нет.';
        } finally { saving = false; renderSave(latest && latest.save); }
    });
    show('map');
    refresh().then(() => loadMaps(false));
    refreshLoc().then(() => { try { el('nx-loc-refresh').click(); } catch (e) { /* */ } });
    refreshHistory();

    /* хук для проверок (аналог window.VerterDashboard) */
    window.VerterNext = Object.freeze({
        snapshot() {
            return {
                connected: freshState(), mode: state && state.mode ? state.mode.actual : 'unknown',
                section, selectedMap: el('nx-mode-map').value, mapsReady: maps.length > 0,
                modeSubmitting, noteDirty, placing: !!placement,
                locSelectedMap: selectedMap, catalogsReady, points: points.length, routes: routes.length
            };
        }
    });
})();
