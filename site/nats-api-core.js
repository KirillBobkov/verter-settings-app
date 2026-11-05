/**
 * Ядро обращения к роботу через NATS — зеркало HTTP-адаптера робота
 * (robot_nats/web.py, request_nats): те же action→subject, те же таймауты,
 * те же конверты. Оригинальные страницы UI не меняются: api-shim.js
 * подменяет fetch('/api/...') вызовами этого модуля.
 *
 * Использует глобальный бандл NatsBrowser (lib/nats-core.iife.js).
 * Работает и в браузере, и в Node (для e2e-тестов).
 */
(function (global) {
    'use strict';

    // Таймауты чуть меньше клиентских AbortSignal, чтобы ответ приходил
    // раньше их срабатывания (значения web.py: 20/10/5/1 c).
    const TIMEOUTS = {
        service: 9500,
        spatial: 9500,
        mapGet: 5000,
        mapSave: 9500,
        batteryHistory: 20000,
        cmdVel: 1100,
        batteryExportPage: 15000,
    };

    const SERVICE_COMMANDS = {
        'ping': 'ping',
        'schema.get': 'schema_get',
        'state.get': 'state_get',
        'metrics.get': 'metrics_get',
        'settings.set': 'note_set',
        'mode.set': 'mode_set',
    };

    // places.py SPATIAL_COMMANDS
    const SPATIAL_COMMANDS = {
        'localization.get': ['localization', 'get'],
        'localization.initialize': ['localization', 'initialize'],
        'localization.confirm': ['localization', 'confirm'],
        'waypoint.list': ['waypoint', 'list'],
        'waypoint.save': ['waypoint', 'save'],
        'waypoint.delete': ['waypoint', 'delete'],
        'route.list': ['route', 'list'],
        'route.save': ['route', 'save'],
        'route.delete': ['route', 'delete'],
    };

    function uuid() {
        if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
        // как requestId() в app.js
        const bytes = new Uint8Array(16);
        global.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    /** action POST /api/command → {subject, timeout}. Возвращает null для неизвестного. */
    function routeAction(robotId, action) {
        if (action in SPATIAL_COMMANDS) {
            const [domain, operation] = SPATIAL_COMMANDS[action];
            return { subject: `${robotId}.${domain}.command.${operation}`, timeout: TIMEOUTS.spatial };
        }
        if (action === 'map.get') return { subject: `${robotId}.map.command.get`, timeout: TIMEOUTS.mapGet };
        if (action === 'map.save') return { subject: `${robotId}.map.command.save`, timeout: TIMEOUTS.mapSave };
        if (action === 'battery.history') return { subject: `${robotId}.battery.command.history`, timeout: TIMEOUTS.batteryHistory };
        if (action.startsWith('cmd_vel.')) {
            return { subject: `${robotId}.cmd_vel.command.${action.slice(8)}`, timeout: TIMEOUTS.cmdVel };
        }
        if (action in SERVICE_COMMANDS) {
            return { subject: `${robotId}.service.command.${SERVICE_COMMANDS[action]}`, timeout: TIMEOUTS.service };
        }
        return null;
    }

    /** GET-эндпоинты web.py → {subject, timeout, ttl_s, args}. */
    function routeGet(robotId, path, searchParams) {
        if (path === '/api/state') {
            return { subject: `${robotId}.service.command.state_get`, timeout: TIMEOUTS.service, ttl_s: 30, args: {} };
        }
        if (path === '/api/metrics') {
            return { subject: `${robotId}.service.command.metrics_get`, timeout: TIMEOUTS.service, ttl_s: 30, args: {} };
        }
        if (path === '/api/drive') {
            // fractionalIssued: см. комментарий в makeEnvelope
            return { subject: `${robotId}.cmd_vel.command.status`, timeout: TIMEOUTS.cmdVel, ttl_s: 1, args: {}, fractionalIssued: true };
        }
        if (path === '/api/map') {
            const args = {};
            for (const [key, value] of searchParams.entries()) args[key] = value;
            for (const name of ['revision', 'index']) {
                if (name in args) args[name] = parseInt(args[name], 10);
            }
            return { subject: `${robotId}.map.command.get`, timeout: TIMEOUTS.mapGet, ttl_s: 30, args };
        }
        if (path === '/api/battery/history') {
            const args = {};
            for (const [key, value] of searchParams.entries()) {
                args[key] = key === 'max_points' ? parseInt(value, 10) : parseFloat(value);
            }
            return { subject: `${robotId}.battery.command.history`, timeout: TIMEOUTS.batteryHistory, ttl_s: 30, args };
        }
        return null;
    }

    /**
     * issuedAt: необязательное время отправки. Для cmd_vel (TTL 1 с) нужно
     * ДРОБНОЕ Date.now()/1000 без floor — округление вниз съедает до секунды
     * и запрос «протухает» на пути до робота (проверено на живом хабе).
     */
    function makeEnvelope(ttl_s, args, issuedAt) {
        return {
            v: 1,
            id: uuid(),
            issued_at: issuedAt !== undefined ? issuedAt : Math.floor(Date.now() / 1000),
            ttl_s,
            args,
        };
    }

    class ApiError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status || 503;
        }
    }

    /** Подключение к хабу; callback статуса вызывается при изменениях. */
    async function connect(url, credsText, onStatus) {
        const Nats = global.NatsBrowser;
        if (!Nats) throw new Error('NatsBrowser не загружен (lib/nats-core.iife.js)');
        const nc = await Nats.wsconnect({
            servers: url,
            name: 'verter-ui-' + Math.random().toString(36).slice(2, 8),
            maxReconnectAttempts: -1,
            reconnectTimeWait: 2000,
            waitOnFirstConnect: true,
            authenticator: Nats.credsAuthenticator(new TextEncoder().encode(credsText)),
        });
        if (onStatus) {
            (async () => {
                for await (const s of nc.status()) onStatus(s.type);
            })().catch(() => { /* цикл завершается при закрытии */ });
        }
        return nc;
    }

    /** request/reply: возвращает разобранный JSON-ответ робота. */
    async function request(nc, subject, envelope, timeoutMs) {
        const m = await nc.request(subject, JSON.stringify(envelope), { timeout: timeoutMs });
        return JSON.parse(new TextDecoder().decode(m.data));
    }

    /** Вызов GET-маршрута (routeGet) с учётом fractionalIssued. */
    async function requestGet(nc, route) {
        const issuedAt = route.fractionalIssued ? Date.now() / 1000 : undefined;
        return request(nc, route.subject, makeEnvelope(route.ttl_s, route.args, issuedAt), route.timeout);
    }

    /**
     * Обработка POST /api/command: body уже содержит конверт с action
     * (страницы строят его сами, включая issued_at из своей синхронизации
     * часов). Прослойка только заменяет action на subject — как web.py.
     */
    async function commandPost(nc, robotId, body) {
        const action = body.action;
        const route = routeAction(robotId, action);
        if (!route) {
            const err = new ApiError('Unknown action', 400);
            throw err;
        }
        const env = { v: 1, id: body.id, issued_at: body.issued_at, ttl_s: body.ttl_s, args: body.args };
        return request(nc, route.subject, env, route.timeout);
    }

    const core = {
        TIMEOUTS: TIMEOUTS,
        routeAction: routeAction,
        routeGet: routeGet,
        makeEnvelope: makeEnvelope,
        connect: connect,
        request: request,
        requestGet: requestGet,
        commandPost: commandPost,
        ApiError: ApiError,
    };

    global.VterNatsCore = core;
    if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof window !== 'undefined' ? window : globalThis);
