/* Read-only Nav2 costmaps. This module never sends robot commands. */
(() => {
    'use strict';

    const viewer = window.VerterMap;
    if (!viewer) return;
    const el = id => document.getElementById(id);
    const MAX_CELLS = 4194304;
    const MAX_PACKED = 4260000;
    const panel = el('costmap-summary');
    const kinds = ['global', 'local'];
    let state = null;
    let stateBusy = false;
    let stateController = null;
    let pageEpoch = 0;
    let scope = null;
    let baseMapId = viewer.getMetadata()?.map_id || null;
    const layers = {};
    const requests = {state: 0, local: 0, global: 0};

    function selectedMapId() {
        return viewer.getMetadata()?.map_id || null;
    }

    function modeName(value) {
        return typeof value === 'string' ? value : value?.actual || 'unknown';
    }

    function version(metadata) {
        return metadata ? `${metadata.costmap_id}:${metadata.revision}` : null;
    }

    function fresh(metadata) {
        if (modeName(state?.mode) !== 'navigation' || !metadata?.available || metadata.stale ||
            metadata.map_id !== state.map_id || metadata.map_id !== selectedMapId()) return false;
        const age = Math.max(0, metadata.age_s) + metadata._roundtrip +
            (performance.now() - metadata._received) / 1000;
        return Number.isFinite(age) && age <= metadata.max_age_s;
    }

    function validMetadata(metadata, kind) {
        const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
        if (metadata.kind !== kind || metadata.frame_id !== 'map' ||
            metadata.encoding !== 'zlib-uint8-row-major' ||
            !safeId(metadata.costmap_id) || !safeId(metadata.map_id) ||
            !Number.isInteger(metadata.revision) || metadata.revision < 1 ||
            !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) ||
            metadata.width < 1 || metadata.height < 1 || metadata.width > 16384 || metadata.height > 16384 ||
            metadata.width * metadata.height > MAX_CELLS ||
            metadata.decoded_bytes !== metadata.width * metadata.height ||
            !Number.isFinite(metadata.resolution) || metadata.resolution <= 0 ||
            !metadata.origin || !['x', 'y', 'yaw'].every(name => Number.isFinite(metadata.origin[name])) ||
            !Number.isFinite(metadata.stamp) || metadata.stamp <= 0 ||
            !Number.isFinite(metadata.age_s) || metadata.age_s < -0.25 ||
            !Number.isFinite(metadata.max_age_s) || metadata.max_age_s <= 0 || metadata.max_age_s > 30 ||
            !Number.isInteger(metadata.compressed_bytes) || metadata.compressed_bytes < 1 ||
            metadata.compressed_bytes > MAX_PACKED ||
            !Number.isInteger(metadata.chunk_bytes) || metadata.chunk_bytes < 1 || metadata.chunk_bytes > 65536 ||
            metadata.chunks !== Math.ceil(metadata.compressed_bytes / metadata.chunk_bytes) ||
            !/^[0-9a-f]{64}$/.test(metadata.sha256) || !/^[0-9a-f]{64}$/.test(metadata.decoded_sha256)) {
            throw Error('Некорректные параметры costmap');
        }
    }

    function cancel(entry) {
        entry.token += 1;
        entry.controller?.abort();
        entry.controller = null;
        entry.busy = false;
    }

    function clear(entry, abort = false) {
        if (abort) cancel(entry);
        const changed = entry.image !== null;
        entry.image = null;
        entry.raw = null;
        entry.drawing = null;
        if (changed) entry.source.changed();
    }

    function drawCanvas(entry, extent, size) {
        const canvas = document.createElement('canvas');
        canvas.width = size[0];
        canvas.height = size[1];
        if (!entry.image || !fresh(entry.drawing) || !entry.checkbox.checked || document.hidden) return canvas;
        const metadata = entry.drawing;
        const context = canvas.getContext('2d');
        const sx = size[0] / (extent[2] - extent[0]);
        const sy = size[1] / (extent[3] - extent[1]);
        context.imageSmoothingEnabled = false;
        context.setTransform(sx, 0, 0, -sy, -extent[0] * sx, extent[3] * sy);
        context.translate(metadata.origin.x, metadata.origin.y);
        context.rotate(metadata.origin.yaw);
        context.translate(0, metadata.height * metadata.resolution);
        context.scale(metadata.resolution, -metadata.resolution);
        context.drawImage(entry.image, 0, 0);
        return canvas;
    }

    function paint(entry) {
        if (!entry.raw || !entry.drawing) return;
        const metadata = entry.drawing;
        const image = document.createElement('canvas');
        image.width = metadata.width;
        image.height = metadata.height;
        const context = image.getContext('2d');
        const pixels = context.createImageData(metadata.width, metadata.height);
        const inflation = el('costmap-inflation').checked;
        for (let row = 0; row < metadata.height; row += 1) {
            for (let column = 0; column < metadata.width; column += 1) {
                const value = entry.raw[row * metadata.width + column];
                if (value === 0 || value === 255 || (!inflation && value < 253)) continue;
                const offset = ((metadata.height - row - 1) * metadata.width + column) * 4;
                pixels.data[offset] = 255;
                pixels.data[offset + 1] = value === 254 ? 70 : value === 253 ? 138 : 209;
                pixels.data[offset + 2] = value === 254 ? 87 : value === 253 ? 72 : 102;
                pixels.data[offset + 3] = value >= 253 ? 255 : Math.round(30 + value / 252 * 165);
            }
        }
        context.putImageData(pixels, 0, 0);
        entry.image = image;
        entry.source.changed();
    }

    for (const kind of kinds) {
        const entry = {
            kind,
            metadata: null,
            drawing: null,
            image: null,
            raw: null,
            busy: false,
            token: 0,
            controller: null,
            error: null,
            checkbox: el('costmap-' + kind),
            status: el('costmap-' + kind + '-status')
        };
        entry.source = new ol.source.ImageCanvas({
            projection: viewer.view.getProjection(),
            ratio: 1,
            interpolate: false,
            canvasFunction(extent, resolution, pixelRatio, size) {
                return drawCanvas(entry, extent, size);
            }
        });
        entry.layer = new ol.layer.Image({source: entry.source, opacity: 0.65, visible: entry.checkbox.checked});
        // Base map stays below; lidar, robot and named-point layers stay above.
        viewer.map.getLayers().insertAt(kind === 'global' ? 1 : 2, entry.layer);
        layers[kind] = entry;
    }

    async function api(arguments_, signal) {
        requests[arguments_.part === 'state' ? 'state' : arguments_.kind] += 1;
        const response = await fetch('/api/costmap?' + new URLSearchParams(arguments_), {signal});
        if (!response.ok) throw Error('HTTP ' + response.status);
        const body = await response.json();
        if (!body.ok || !body.result || typeof body.result !== 'object') {
            throw Error(body.error || 'Нет ответа costmap API');
        }
        return body.result;
    }

    function unpack(packed, expected) {
        const parts = [];
        let length = 0;
        const inflater = new pako.Inflate({chunkSize: 65536});
        inflater.onData = chunk => {
            length += chunk.length;
            if (length > expected) throw Error('Превышен размер costmap');
            parts.push(chunk);
        };
        inflater.push(packed, true);
        if (inflater.err || length !== expected) throw Error('Не удалось распаковать costmap');
        const raw = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            raw.set(part, offset);
            offset += part.length;
        }
        return raw;
    }

    async function load(entry) {
        if (entry.busy || !entry.checkbox.checked || !fresh(entry.metadata) || document.hidden) return;
        if (version(entry.drawing) === version(entry.metadata) && entry.image) return;
        const metadata = entry.metadata;
        const token = entry.token;
        const controller = new AbortController();
        entry.controller = controller;
        entry.busy = true;
        entry.error = null;
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
            const packed = new Uint8Array(metadata.compressed_bytes);
            for (let index = 0; index < metadata.chunks; index += 1) {
                const part = await api({
                    part: 'chunk', kind: entry.kind, costmap_id: metadata.costmap_id,
                    revision: metadata.revision, index
                }, controller.signal);
                if (part.kind !== entry.kind || part.costmap_id !== metadata.costmap_id ||
                    part.map_id !== metadata.map_id || part.revision !== metadata.revision ||
                    part.index !== index || part.chunks !== metadata.chunks || typeof part.data_b64 !== 'string') {
                    throw Error('Части costmap относятся к разным версиям');
                }
                const offset = index * metadata.chunk_bytes;
                const expectedBytes = Math.min(metadata.chunk_bytes, metadata.compressed_bytes - offset);
                if (part.data_b64.length !== 4 * Math.ceil(expectedBytes / 3) ||
                    !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data_b64)) {
                    throw Error('Неверный размер части costmap');
                }
                const bytes = Uint8Array.from(atob(part.data_b64), character => character.charCodeAt(0));
                if (bytes.length !== expectedBytes) {
                    throw Error('Неверный размер части costmap');
                }
                packed.set(bytes, offset);
            }
            if (sha256(packed) !== metadata.sha256) throw Error('Не совпала контрольная сумма costmap');
            const raw = unpack(packed, metadata.decoded_bytes);
            if (sha256(raw) !== metadata.decoded_sha256) throw Error('Не совпала контрольная сумма клеток costmap');
            const drawing = version(entry.metadata) === version(metadata) ? entry.metadata : metadata;
            if (entry.token !== token || controller.signal.aborted || document.hidden ||
                !entry.checkbox.checked || !fresh(drawing) ||
                entry.metadata?.costmap_id !== metadata.costmap_id) return;
            entry.raw = raw;
            entry.drawing = drawing;
            paint(entry);
        } catch (error) {
            if (entry.token === token && !document.hidden) {
                clear(entry);
                entry.error = error.name === 'AbortError' ? 'Получение costmap прервано' : error.message;
            }
        } finally {
            clearTimeout(timeout);
            if (entry.controller === controller) {
                entry.controller = null;
                entry.busy = false;
                renderStatus(entry);
                if (version(metadata) !== version(entry.metadata)) load(entry);
            }
        }
    }

    function unavailableReason(metadata) {
        const reason = metadata?.reason || '';
        if (reason.includes('not_active') || modeName(state?.mode) !== 'navigation') return 'Nav2 не запущена';
        if (reason.includes('tf') || reason.includes('transform')) return 'Ожидание преобразования координат';
        if (reason.includes('stale') || metadata?.stale) return 'Данные устарели · слой скрыт';
        if (reason.includes('map')) return 'Ожидание карты';
        return 'Ожидание costmap от Nav2';
    }

    function renderStatus(entry) {
        entry.layer.setVisible(entry.checkbox.checked && !document.hidden && !!entry.image && fresh(entry.drawing));
        const title = entry.kind === 'local' ? 'Локальная' : 'Глобальная';
        entry.status.classList.remove('costmap-error');
        if (!entry.checkbox.checked) {
            entry.status.textContent = `${title}: скрыта`;
        } else if (entry.error) {
            entry.status.textContent = `${title}: ${entry.error}`;
            entry.status.classList.add('costmap-error');
        } else if (!entry.metadata?.available) {
            entry.status.textContent = `${title}: ${unavailableReason(entry.metadata)}`;
        } else if (entry.metadata.map_id !== selectedMapId()) {
            entry.status.textContent = `${title}: ожидание соответствующей карты`;
        } else if (!fresh(entry.metadata)) {
            entry.status.textContent = `${title}: данные устарели · слой скрыт`;
            entry.status.classList.add('costmap-error');
        } else if (entry.busy || !entry.image) {
            entry.status.textContent = `${title}: получение данных…`;
        } else {
            const age = Math.max(0, entry.drawing.age_s) + entry.drawing._roundtrip +
                (performance.now() - entry.drawing._received) / 1000;
            entry.status.textContent = `${title}: ${entry.drawing.width}×${entry.drawing.height} · ` +
                `${entry.drawing.resolution.toFixed(3)} м/клетку · возраст ${age.toFixed(1)} с`;
        }
    }

    function accept(result, received, roundtrip) {
        if (!('local' in result) || !('global' in result)) throw Error('Неполное состояние costmap');
        const nextScope = modeName(result.mode) + ':' + (result.map_id || '');
        if (scope !== nextScope) {
            for (const entry of Object.values(layers)) clear(entry, true);
            scope = nextScope;
        }
        state = result;
        const active = modeName(result.mode) === 'navigation';
        panel.textContent = active
            ? 'Общая сетка препятствий и стоимости Nav2. Цвет не определяет, каким датчиком обнаружен объект.'
            : 'Nav2 не запущена. Costmap появится в режиме навигации; эта панель только читает данные.';
        for (const kind of kinds) {
            const entry = layers[kind];
            const value = result[kind];
            if (!value || typeof value !== 'object') throw Error('Некорректное состояние costmap');
            try {
                if (value.available) validMetadata(value, kind);
                const metadata = {...value, _received: received, _roundtrip: roundtrip};
                if (!active || metadata.costmap_id !== entry.metadata?.costmap_id ||
                    !fresh(metadata)) clear(entry, true);
                entry.metadata = metadata;
                entry.error = null;
                if (version(entry.drawing) === version(metadata)) entry.drawing = metadata;
                if (active && fresh(metadata)) load(entry);
            } catch (error) {
                clear(entry, true);
                entry.metadata = null;
                entry.error = error.message;
            }
            renderStatus(entry);
        }
    }

    async function poll() {
        if (stateBusy || document.hidden) return;
        stateBusy = true;
        const epoch = pageEpoch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        stateController = controller;
        const sent = performance.now();
        try {
            const result = await api({part: 'state'}, controller.signal);
            if (pageEpoch === epoch && !document.hidden) {
                const received = performance.now();
                accept(result, received, (received - sent) / 1000);
            }
        } catch (error) {
            if (pageEpoch === epoch && !document.hidden) {
                state = null;
                panel.textContent = 'Нет связи с costmap · слои скрыты';
                for (const entry of Object.values(layers)) {
                    clear(entry, true);
                    entry.metadata = null;
                    entry.error = error.name === 'AbortError' ? 'Нет своевременного ответа' : error.message;
                    renderStatus(entry);
                }
            }
        } finally {
            clearTimeout(timeout);
            if (stateController === controller) stateController = null;
            stateBusy = false;
            if (pageEpoch !== epoch && !document.hidden) poll();
        }
    }

    for (const entry of Object.values(layers)) {
        entry.checkbox.addEventListener('change', () => {
            if (!entry.checkbox.checked) clear(entry, true);
            else load(entry);
            renderStatus(entry);
            poll();
        });
    }
    el('costmap-inflation').addEventListener('change', () => {
        for (const entry of Object.values(layers)) paint(entry);
    });
    el('costmap-opacity').addEventListener('input', event => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value) || value < 10 || value > 100) return;
        el('costmap-opacity-value').textContent = value + '%';
        for (const entry of Object.values(layers)) entry.layer.setOpacity(value / 100);
    });
    document.addEventListener('visibilitychange', () => {
        pageEpoch += 1;
        stateController?.abort();
        for (const entry of Object.values(layers)) {
            clear(entry, true);
            entry.metadata = null;
            entry.error = null;
            renderStatus(entry);
        }
        if (document.hidden) panel.textContent = 'Просмотр costmap приостановлен';
        else poll();
    });
    // Inspection for the debug page/tests; snapshots have no mutable references.
    window.VerterCostmaps = Object.freeze({
        snapshot() {
            const result = {mode: modeName(state?.mode), map_id: state?.map_id || null, requests: {...requests}};
            for (const entry of Object.values(layers)) {
                result[entry.kind] = {
                    selected: entry.checkbox.checked,
                    visible: !!entry.image && !document.hidden && entry.checkbox.checked && fresh(entry.drawing),
                    costmap_id: entry.drawing?.costmap_id || null,
                    map_id: entry.drawing?.map_id || null,
                    revision: entry.drawing?.revision || null,
                    origin: entry.drawing ? {...entry.drawing.origin} : null,
                    error: entry.error
                };
            }
            return result;
        }
    });
    setInterval(() => {
        if (document.hidden) return;
        const current = selectedMapId();
        if (current !== baseMapId) {
            baseMapId = current;
            for (const entry of Object.values(layers)) clear(entry, true);
        }
        for (const entry of Object.values(layers)) {
            if (entry.image && !fresh(entry.drawing)) clear(entry);
            renderStatus(entry);
        }
    }, 100);
    poll();
    setInterval(poll, 500);
})();
