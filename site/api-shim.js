/**
 * Прослойка для GitHub Pages: оригинальные страницы робота (static/) ходят
 * по HTTP на локальный web.py. Здесь те же URL /api/* выполняются напрямую
 * через NATS по wss. UI-код страниц не изменён.
 *
 * Загружается ПОСЛЕ lib/nats-core.iife.js и nats-api-core.js, ДО скриптов страниц.
 */
(function () {
    'use strict';
    const CREDS_KEY = 'verter.ui.creds';
    const URL_KEY = 'verter.ui.natsWsUrl';

    const CONFIG = Object.assign(
        { natsWsUrl: 'wss://verter-proxy.duckdns.org', robotId: 'verter_01' },
        window.VTER_UI_CONFIG || {}
    );

    let nc = null;
    let connecting = null;
    let status = 'idle'; // idle | connecting | connected | reconnecting | error
    let statusError = '';

    // Креды/адрес ищутся в localStorage, при отсутствии — в sessionStorage
    // (опция кабинета нового интерфейса «хранить только в этой сессии»).
    function loadCreds() {
        try { return localStorage.getItem(CREDS_KEY) || sessionStorage.getItem(CREDS_KEY); } catch (e) { return null; }
    }
    function effectiveUrl() {
        try { return localStorage.getItem(URL_KEY) || sessionStorage.getItem(URL_KEY) || CONFIG.natsWsUrl; }
        catch (e) { return CONFIG.natsWsUrl; }
    }

    function setStatus(next, error) {
        status = next;
        if (error !== undefined) statusError = error;
        renderStatus();
    }

    function connection() {
        if (nc && !nc.isClosed()) return Promise.resolve(nc);
        if (connecting) return connecting;
        const creds = loadCreds();
        if (!creds) {
            return Promise.reject(new VterResponse(401, 'Нет кредов NATS — откройте настройки (шестерёнка справа внизу)'));
        }
        setStatus('connecting', '');
        connecting = VterNatsCore.connect(effectiveUrl(), creds, (type) => {
            if (type === 'disconnect') setStatus('reconnecting');
            else if (type === 'reconnect') setStatus('connected', '');
        })
            .then((conn) => {
                nc = conn;
                setStatus('connected', '');
                return conn;
            })
            .catch((err) => {
                setStatus('error', err.message || String(err));
                throw err;
            })
            .finally(() => { connecting = null; });
        return connecting;
    }

    /** Ответ, имитирующий fetch Response (страницы зовут .ok/.status/.text()/.json()). */
    class VterResponse {
        constructor(status, text) {
            this.status = status;
            this.ok = status >= 200 && status < 300;
            this._text = text;
        }
        async text() { return this._text; }
        async json() { return JSON.parse(this._text); }
    }

    const SERVICE_UNAVAILABLE =
        'No response; execution outcome may be unknown. Inspect state before retrying.';

    async function handleApi(pathWithQuery) {
        const url = new URL(pathWithQuery, 'https://x.invalid');
        const path = url.pathname;
        const params = url.searchParams;
        const core = VterNatsCore;
        try {
            const conn = await connection();
            let reply;
            if (path === '/api/command') {
                // тело передаётся отдельно (см. перехват fetch ниже)
                reply = null;
            } else {
                const route = core.routeGet(CONFIG.robotId, path, params);
                if (!route) return new VterResponse(404, 'Not found');
                reply = await core.requestGet(conn, route);
            }
            return new VterResponse(200, JSON.stringify(reply));
        } catch (err) {
            if (err instanceof VterResponse) return err;
            const message = /timeout/i.test(err.message || '') ? SERVICE_UNAVAILABLE
                : /no responders/i.test(err.message || '') ? SERVICE_UNAVAILABLE
                : (err.message || String(err));
            return new VterResponse(503, message);
        }
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const path = typeof input === 'string' ? input : (input && input.url) || '';
        if (!path.startsWith('/api/')) return originalFetch(input, init);
        try {
            if (path.startsWith('/api/command')) {
                const body = JSON.parse((init && init.body) || '{}');
                const action = body.action;
                const route = VterNatsCore.routeAction(CONFIG.robotId, action);
                if (!route) return new VterResponse(400, 'Unknown action');
                const conn = await connection();
                const reply = await VterNatsCore.commandPost(conn, CONFIG.robotId, body);
                return new VterResponse(200, JSON.stringify(reply));
            }
            return await handleApi(path);
        } catch (err) {
            if (err instanceof VterResponse) return err;
            return new VterResponse(503, err.message || String(err));
        }
    };

    /* ---------- экспорт батареи: /api/battery/export как клиентская загрузка ---------- */

    const SAMPLE_FIELDS = [
        'soc_pct', 'voltage_V', 'current_A', 'power_W', 'remaining_Ah', 'full_charge_capacity_Ah',
        'cycles', 'mos_temperature_C', 'temperature_1_C', 'temperature_2_C', 'cell_sum_V',
        'cell_delta_V', 'balance_current_A', 'balance_state', 'charging_enabled',
        'discharging_enabled', 'flags_raw', 'protocol', 'flags_interpretation',
    ];
    const CELL_FIELDS = Array.from({ length: 32 }, (_, i) => 'cell_' + (i + 1) + '_V');
    const COLUMNS = ['received_at_utc', 'received_at_unix_s', 'sample_at_utc', 'sample_at_unix_s',
        'sample_id', 'charging_state'].concat(SAMPLE_FIELDS, CELL_FIELDS, ['sample_json']);

    function utcStamp(at) {
        if (at === null || at === undefined) return '';
        return new Date(at * 1000).toISOString().replace('Z', 'Z');
    }
    function csvField(value, delimiter) {
        const text = value === null || value === undefined ? '' : String(value);
        if (/[",\r\n]/.test(text) || (delimiter === '\t' && /\t/.test(text))) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }
    function exportRow(row) {
        const [receivedAt, sampleAt, sampleId, state, sample] = row;
        const s = sample || {};
        const values = [utcStamp(receivedAt), receivedAt, utcStamp(sampleAt), sampleAt, sampleId, state];
        for (const field of SAMPLE_FIELDS) {
            const value = s[field];
            values.push(typeof value === 'boolean' ? Number(value) : value);
        }
        const cells = s.cells_V || {};
        for (let index = 1; index <= 32; index++) values.push(cells[String(index)]);
        values.push(sample ? JSON.stringify(sample) : '');
        return values;
    }

    async function batteryExport(format, periodS) {
        const conn = await connection();
        const end = Date.now() / 1000;
        const start = end - periodS;
        const pageArgs = { from: start, to: end, raw: true, limit: 250 };
        const parts = [];
        const delimiter = format === 'csv' ? ',' : '\t';
        const quote = (v) => csvField(v, delimiter);
        parts.push(COLUMNS.map(quote).join(delimiter));
        for (;;) {
            const reply = await VterNatsCore.request(
                conn, `${CONFIG.robotId}.battery.command.history`,
                VterNatsCore.makeEnvelope(30, pageArgs), VterNatsCore.TIMEOUTS.batteryExportPage);
            if (!reply.ok) throw new Error(reply.error || 'History export failed');
            const page = reply.result;
            for (const row of page.rows) parts.push(exportRow(row).map(quote).join(delimiter));
            const cursor = page.next_after;
            if (cursor === null || cursor === undefined) break;
            if (cursor <= (pageArgs.after !== undefined ? pageArgs.after : -Infinity)) {
                throw new Error('History pagination did not advance');
            }
            pageArgs.after = cursor;
        }
        const stamp = new Date(end * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const blob = new Blob(
            [(format === 'csv' ? '﻿' : ''), parts.join('\r\n'), '\r\n'],
            { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bms-${stamp}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }

    document.addEventListener('click', (event) => {
        const a = event.target && event.target.closest && event.target.closest('a[href^="/api/battery/export"]');
        if (!a) return;
        event.preventDefault();
        const params = new URLSearchParams(a.href.split('?')[1] || '');
        const format = params.get('format') === 'txt' ? 'txt' : 'csv';
        const period = parseFloat(params.get('period_s') || '604800') || 604800;
        batteryExport(format, period).catch((err) => {
            alert('Экспорт не выполнен: ' + err.message);
        });
    }, true);

    /* ---------- панель настроек NATS ---------- */

    function panelCss() {
        const style = document.createElement('style');
        style.textContent = `
        #vter-nats-dot{position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;gap:8px;align-items:center;
            font:13px/1.2 system-ui,sans-serif;background:#123;width:auto;padding:8px 10px;border-radius:10px;color:#cde;cursor:pointer;
            box-shadow:0 2px 10px rgba(0,0,0,.4)}
        #vter-nats-dot .dot{width:10px;height:10px;border-radius:50%;background:#888}
        #vter-nats-dot.connected .dot{background:#2ecc71}
        #vter-nats-dot.connecting .dot,#vter-nats-dot.reconnecting .dot{background:#f1c40f}
        #vter-nats-dot.error .dot{background:#e74c3c}
        #vter-nats-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
        #vter-nats-modal[hidden]{display:none}
        #vter-nats-modal .box{background:#fff;color:#1c2733;border-radius:12px;max-width:560px;width:92%;padding:18px;
            font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}
        #vter-nats-modal textarea,#vter-nats-modal input{width:100%;box-sizing:border-box;font:12px/1.3 ui-monospace,monospace;
            padding:8px;border:1px solid #c5cdd6;border-radius:8px;margin:4px 0 10px}
        #vter-nats-modal textarea{height:130px}
        #vter-nats-modal .row{display:flex;gap:8px;justify-content:flex-end}
        #vter-nats-modal button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #c5cdd6;background:#fff;cursor:pointer}
        #vter-nats-modal button.primary{background:#0d7a5f;color:#fff;border-color:#0d7a5f}
        #vter-nats-modal button.danger{color:#b3261e}
        #vter-nats-modal .hint{color:#5f6f7f;font-size:12.5px}
        #vter-nats-camera-links{display:none}
        `;
        document.head.appendChild(style);
    }

    function statusText() {
        if (status === 'connected') return 'NATS подключён';
        if (status === 'connecting') return 'Подключение…';
        if (status === 'reconnecting') return 'Переподключение…';
        if (status === 'error') return 'Нет связи: ' + statusError;
        return 'Не подключён';
    }

    function renderStatus() {
        const dot = document.getElementById('vter-nats-dot');
        if (!dot) return;
        dot.className = status;
        dot.querySelector('.text').textContent = statusText();
    }

    function buildPanel() {
        panelCss();
        const dot = document.createElement('div');
        dot.id = 'vter-nats-dot';
        dot.innerHTML = '<span class="dot"></span><span class="text">Не подключён</span><span>⚙</span>';
        dot.onclick = openModal;
        document.body.appendChild(dot);

        const modal = document.createElement('div');
        modal.id = 'vter-nats-modal';
        modal.hidden = true;
        modal.innerHTML = `
        <div class="box">
            <h3 style="margin:0 0 6px">Подключение к роботу (NATS)</h3>
            <div class="hint">Креды выдаёт администратор; хранятся только в этом браузере.
            Адрес по умолчанию: <b>${CONFIG.natsWsUrl}</b>.</div>
            <label>Сервер (wss://…) — можно оставить пустым
                <input id="vter-nats-url" placeholder="${CONFIG.natsWsUrl}"></label>
            <label>Креды (содержимое файла ui-имя.creds)
                <textarea id="vter-nats-creds" spellcheck="false"
placeholder="-----BEGIN NATS USER JWT-----&#10;eyJ…&#10;------END NATS USER JWT------&#10;&#10;-----BEGIN USER NKEY SEED-----&#10;SU…&#10;------END USER NKEY SEED------"></textarea></label>
            <div class="row">
                <button class="danger" id="vter-nats-forget">Забыть</button>
                <button id="vter-nats-cancel">Закрыть</button>
                <button class="primary" id="vter-nats-save">Сохранить и подключиться</button>
            </div>
        </div>`;
        document.body.appendChild(modal);

        function openModal() {
            modal.hidden = false;
            document.getElementById('vter-nats-url').value =
                localStorage.getItem(URL_KEY) || '';
            document.getElementById('vter-nats-creds').value =
                localStorage.getItem(CREDS_KEY) || '';
        }
        function closeModal() { modal.hidden = true; }

        modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
        document.getElementById('vter-nats-cancel').onclick = closeModal;
        document.getElementById('vter-nats-save').onclick = async () => {
            const creds = document.getElementById('vter-nats-creds').value.trim();
            const url = document.getElementById('vter-nats-url').value.trim();
            if (creds) {
                if (!/BEGIN NATS USER JWT/.test(creds) || !/USER NKEY SEED/.test(creds)) {
                    alert('Креды неполные: нужны блоки NATS USER JWT и USER NKEY SEED');
                    return;
                }
                localStorage.setItem(CREDS_KEY, creds);
            }
            if (url) localStorage.setItem(URL_KEY, url);
            else localStorage.removeItem(URL_KEY);
            closeModal();
            // пересоздать соединение
            if (nc) { try { await nc.close(); } catch (e) { /* уже закрыт */ } nc = null; }
            try { await connection(); } catch (e) { /* статус покажет ошибку */ }
        };
        document.getElementById('vter-nats-forget').onclick = async () => {
            localStorage.removeItem(CREDS_KEY);
            localStorage.removeItem(URL_KEY);
            if (nc) { try { await nc.close(); } catch (e) { /* уже закрыт */ } nc = null; }
            setStatus('idle', '');
            closeModal();
        };
    }

    // Камера и лидар — окна на самом роботе; с GitHub Pages недоступны.
    // Прячем карточки-ссылки и гасим camera-link.js.
    function hideRobotLocalWindows() {
        const style = document.createElement('style');
        style.textContent = '#lidar-window,#camera-window{display:none}';
        document.head.appendChild(style);
        window.addEventListener('DOMContentLoaded', () => {
            for (const id of ['camera-window', 'lidar-window']) {
                const node = document.getElementById(id);
                if (node) node.style.display = 'none';
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { buildPanel(); hideRobotLocalWindows(); });
    } else {
        buildPanel();
        hideRobotLocalWindows();
    }
})();
