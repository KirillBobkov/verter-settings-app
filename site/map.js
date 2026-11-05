/* This viewer reads map data and saves named maps on explicit clicks. Motion controls are exclusively the shared, focus-scoped drive widget. */
(() => {
    const el = id => document.getElementById(id);
    const projection = new ol.proj.Projection({code: 'VERTER_MAP', units: 'm'});
    let image = null, displayed = null, latest = null, lastPose = null, model = null;
    let metaBusy = false, poseBusy = false, lastPoseReply = 0, scanBusy = false, lastScan = null, scanReply = 0, serverClock = null, saving = false, saveError = null, saveRequestId = null;
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
    const robots = new ol.source.Vector({wrapX: false});
    const laser = new ol.source.Vector({wrapX: false});
    const view = new ol.View({projection, center: [0, 0], resolution: .02, minResolution: .001, maxResolution: 10});
    const map = new ol.Map({target: 'ol-map', view, layers: [
        new ol.layer.Image({source: raster}),
        new ol.layer.Vector({source: laser, style: new ol.style.Style({image: new ol.style.Circle({radius: 2, fill: new ol.style.Fill({color: '#00b889'})})})}),
        new ol.layer.Vector({source: robots, style: feature => {
            if (feature.get('kind') === 'center') return new ol.style.Style({image: new ol.style.Circle({
                radius: 4, fill: new ol.style.Fill({color: '#59d7ff'}), stroke: new ol.style.Stroke({color: '#0b1824', width: 1})
            })});
            return new ol.style.Style({
                fill: new ol.style.Fill({color: feature.get('kind') === 'body' ? '#4798e466' : '#174e8d99'}),
                stroke: new ol.style.Stroke({color: feature.get('kind') === 'arrow' ? '#45caff' : '#176ec1', width: 2})
            });
        }})
    ]});
    function copy(value) {
        return value == null ? null : JSON.parse(JSON.stringify(value));
    }
    function mapState() {
        const available = !!displayed && !!latest?.available && displayed.map_id === latest.map_id &&
            displayed.revision === latest.revision;
        const stale = !available || !!latest.stale || document.hidden || metadataReply === null ||
            performance.now() - metadataReply > 3500;
        return {available, stale};
    }
    function poseValid() {
        const state = mapState();
        const age = Math.max(0, lastPose?.age_s || 0) + (performance.now() - lastPoseReply) / 1000;
        return state.available && !state.stale && lastPose?.valid === true &&
            lastPose.map_id === displayed.map_id && lastPose.revision === displayed.revision &&
            Number.isFinite(age) && age <= 1.5 &&
            ['x', 'y', 'yaw'].every(key => Number.isFinite(lastPose[key]));
    }
    function scanValid() {
        const state = mapState();
        const age = Math.max(0, lastScan?.age_s || 0) + (performance.now() - scanReply) / 1000;
        return state.available && !state.stale && lastScan?.valid === true &&
            lastScan.map_id === displayed.map_id && lastScan.revision === displayed.revision &&
            Number.isFinite(age) && age <= 1.5 && Array.isArray(lastScan.points) && lastScan.points.length <= 1800 &&
            lastScan.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
    }
    function getState() {
        const state = mapState();
        return {
            ...state, mode: latest?.mode || 'unknown', reason: latest?.reason || latest?.error || null,
            loading: metaBusy, metadata: copy(latest), displayed: copy(displayed),
            pose: {...copy(lastPose), valid: poseValid()},
            scan: {valid: scanValid(), reason: lastScan?.reason || null,
                age_s: lastScan?.age_s, stamp: lastScan?.stamp,
                points_count: lastScan?.points?.length || 0, raw_count: lastScan?.raw_count}
        };
    }
    function notifyState() {
        if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function')
            window.dispatchEvent(new CustomEvent('verter:map-state', {detail: getState()}));
    }
    window.VerterMap = {map, view, getMetadata: () => displayed, getState};
    map.addControl(new ol.control.ScaleLine({units: 'metric'}));
    map.on('pointermove', event => {
        el('cursor-info').textContent = `Курсор: x ${event.coordinate[0].toFixed(2)} м · y ${event.coordinate[1].toFixed(2)} м`;
    });
    map.on('pointerdrag', () => { el('follow').checked = false; });

    async function api(args, signal) {
        const sent = performance.now();
        const response = await fetch('/api/map?' + new URLSearchParams(args), {signal: signal || AbortSignal.timeout(6000)});
        if (!response.ok) throw Error('HTTP ' + response.status);
        const body = await response.json();
        if (Number.isFinite(body.at) && performance.now() - sent < 1000) serverClock = {at: body.at, midpoint: (sent + performance.now()) / 2};
        if (!body.ok) throw Error(body.error || 'Нет ответа map API');
        return body.result;
    }
    function validate(metadata) {
        if (metadata.frame_id !== 'map' || metadata.encoding !== 'zlib-int8-row-major' ||
            !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0 ||
            metadata.width * metadata.height > 4194304 || metadata.decoded_bytes !== metadata.width * metadata.height ||
            !Number.isFinite(metadata.resolution) || metadata.resolution <= 0 ||
            !metadata.origin || !['x', 'y', 'yaw'].every(key => Number.isFinite(metadata.origin[key])) ||
            !Number.isInteger(metadata.compressed_bytes) || metadata.compressed_bytes < 1 || metadata.compressed_bytes > 4260000 ||
            !Number.isInteger(metadata.chunk_bytes) || metadata.chunk_bytes < 1 || metadata.chunk_bytes > 65536 ||
            metadata.chunks !== Math.ceil(metadata.compressed_bytes / metadata.chunk_bytes) ||
            !Number.isInteger(metadata.revision) || metadata.revision < 1 || typeof metadata.map_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(metadata.sha256) || !/^[0-9a-f]{64}$/.test(metadata.decoded_sha256))
            throw Error('Некорректные параметры карты');
    }
    function unpack(packed, expected) {
        const parts = []; let length = 0;
        const inflater = new pako.Inflate({chunkSize: 65536});
        inflater.onData = chunk => {
            length += chunk.length;
            if (length > expected) throw Error('Превышен размер карты');
            parts.push(chunk);
        };
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
                el('connection').textContent = `Получение карты: ${index + 1}/${metadata.chunks}`;
                const chunk = await api({part: 'chunk', map_id: metadata.map_id, revision: metadata.revision, index}, controller.signal);
                if (chunk.map_id !== metadata.map_id || chunk.revision !== metadata.revision || chunk.index !== index || chunk.chunks !== metadata.chunks)
                    throw Error('Части карты относятся к разным версиям');
                const bytes = Uint8Array.from(atob(chunk.data_b64), value => value.charCodeAt(0));
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
                const value = raw[y * metadata.width + x];
                if (value > 100 && value !== 255) throw Error('Некорректная клетка карты');
                const at = ((metadata.height - 1 - y) * metadata.width + x) * 4;
                const gray = value === 255 ? 125 : Math.round(245 - value * 2.2);
                pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = gray; pixels.data[at + 3] = 255;
            }
            ctx.putImageData(pixels, 0, 0);
            const newSession = !displayed || displayed.map_id !== metadata.map_id;
            image = canvas; displayed = metadata; raster.changed();
            el('fit-map').disabled = false; el('map-empty').hidden = true;
            if (newSession) fit();
            drawRobot(); drawScan();
        } finally { clearTimeout(timeout); }
    }
    function world(x, y, origin) {
        return [origin.x + x * Math.cos(origin.yaw) - y * Math.sin(origin.yaw),
            origin.y + x * Math.sin(origin.yaw) + y * Math.cos(origin.yaw)];
    }
    function fit() {
        if (!displayed) return;
        const w = displayed.width * displayed.resolution, h = displayed.height * displayed.resolution;
        const corners = [[0,0], [w,0], [w,h], [0,h]].map(([x,y]) => world(x,y,displayed.origin));
        view.fit(ol.extent.boundingExtent(corners), {padding: [30,30,30,30], duration: 0});
        el('follow').checked = false;
    }
    function drawRobot() {
        robots.clear(); el('fit-robot').disabled = true;
        el('follow').disabled = !poseValid();
        el('follow').title = poseValid() ? 'Следовать за свежим положением робота' : 'Нужно свежее положение робота на отображаемой карте';
        el('fit-robot').title = el('follow').title;
        if (!poseValid()) {
            el('pose-info').textContent = 'Положение робота неизвестно · ' + (lastPose?.reason || 'ожидание свежих map → base_footprint');
            return;
        }
        const pose = lastPose, transform = point => world(point[0], point[1], pose);
        for (const polygon of model?.polygons || []) {
            const points = polygon.points.map(transform); points.push(points[0]);
            robots.addFeature(new ol.Feature({geometry: new ol.geom.Polygon([points]), kind: polygon.kind}));
        }
        robots.addFeature(new ol.Feature({geometry: new ol.geom.Point([pose.x,pose.y]), kind: 'center'}));
        robots.addFeature(new ol.Feature({geometry: new ol.geom.LineString([[0,0],[.36,0],[.28,.05],[.36,0],[.28,-.05]].map(transform)), kind: 'arrow'}));
        el('pose-info').textContent = `Робот: x ${pose.x.toFixed(2)} м · y ${pose.y.toFixed(2)} м · угол ${(pose.yaw*180/Math.PI).toFixed(1)}° · map`;
        el('fit-robot').disabled = false;
        if (el('follow').checked) view.setCenter([pose.x,pose.y]);
    }
    async function pollMetadata() {
        if (metaBusy || document.hidden) return;
        metaBusy = true;
        try {
            latest = await api({part: 'metadata'});
            metadataReply = performance.now();
            renderSave(latest.save);
            if (!latest.available) {
                image = displayed = null; raster.changed(); robots.clear(); laser.clear();
                el('fit-map').disabled = el('fit-robot').disabled = true;
                el('map-empty').hidden = false;
                el('map-empty').textContent = latest.mode === 'idle'
                    ? 'Нет активной карты. Выберите сохранённую карту и запустите локализацию либо включите картографирование в основном окне.'
                    : 'Ожидание карты текущего режима…';
                el('connection').textContent = `Режим: ${latest.mode} · ${latest.reason}`;
                el('map-info').textContent = 'Карта пока не получена';
            } else {
                if (!displayed || displayed.map_id !== latest.map_id || displayed.revision !== latest.revision) await load(latest);
                el('connection').textContent = latest.stale ? `Карта устарела · ${latest.error || latest.age_s + ' с'}` : `Карта получена · версия ${latest.revision} · ${latest.age_s} с`;
                el('map-info').textContent = `${latest.width} × ${latest.height} клеток · ${latest.resolution} м/клетку · origin (${latest.origin.x.toFixed(2)}, ${latest.origin.y.toFixed(2)}), ${(latest.origin.yaw*180/Math.PI).toFixed(1)}°`;
            }
            el('connection').classList.toggle('stale', !latest.available || latest.stale);
            drawRobot(); drawScan();
            const diagnostics = await api({part: 'diagnostics'});
            el('scan-quality').textContent = diagnostics.variable_scan_geometry ? `Геометрия /scan меняется: ${diagnostics.beam_count_min}–${diagnostics.beam_count_max} лучей за 10 с. Это требует проверки входных данных SLAM.` : '';
        } catch (error) {
            latest = {...latest, stale: true}; drawRobot(); drawScan(); renderSave(latest.save);
            el('connection').textContent = 'Нет обновления карты: ' + error.message;
            el('connection').className = 'stale';
        } finally { metaBusy = false; notifyState(); }
    }
    async function pollPose() {
        if (poseBusy || document.hidden) return;
        poseBusy = true;
        try { lastPose = await api({part: 'pose'}); lastPoseReply = performance.now(); }
        catch (error) { lastPose = {valid: false, reason: error.message}; }
        finally { poseBusy = false; drawRobot(); notifyState(); }
    }
    function drawScan() {
        laser.clear();
        if (!el('show-scan').checked) { el('scan-info').textContent = 'Точки лидара скрыты'; return; }
        if (!scanValid()) {
            el('scan-info').textContent = 'Облако лидара недоступно · ' + (lastScan?.reason || 'ожидание TF');
            return;
        }
        laser.addFeature(new ol.Feature({geometry: new ol.geom.MultiPoint(lastScan.points)}));
        el('scan-info').textContent = `Лидар: ${lastScan.points.length} точек · исходных лучей ${lastScan.raw_count} · возраст ${lastScan.age_s.toFixed(2)} с`;
    }
    async function pollScan() {
        if (scanBusy || document.hidden) return;
        scanBusy = true;
        try { lastScan = await api({part: 'scan'}); scanReply = performance.now(); }
        catch (error) { lastScan = {valid: false, reason: error.message}; }
        finally { scanBusy = false; drawScan(); notifyState(); }
    }
    function renderSave(state) {
        const name = el('map-name');
        const reason = saving || state?.busy ? 'Дождитесь завершения сохранения' :
            !state?.enabled ? 'Сохранение отключено или состояние ещё не получено' :
            latest?.mode !== 'mapping' ? 'Сохранение доступно при картографировании' :
            !mapState().available || mapState().stale ? 'Нужна свежая карта текущей сессии' :
            !name.value || !name.checkValidity() ? 'Введите имя: латиница, цифры, _ или -' : '';
        el('save-map').disabled = !!reason;
        el('save-map').title = reason || 'Сохранить карту и граф SLAM с указанным именем';
        if (saveError && state?.id !== saveRequestId) { el('save-info').textContent = saveError; return; }
        if (!state) return;
        const firstObservation = !observedSave;
        observedSave = true;
        if (state.status === 'running') el('save-info').textContent = `Сохраняется ${state.name}: ${state.stage}`;
        else if (state.status === 'succeeded') {
            el('save-info').textContent = `Сохранено: ${state.name || state.base_path} · карта и граф SLAM`;
            if (state.id && state.id !== notifiedSave) {
                notifiedSave = state.id;
                if ((!firstObservation || state.id === saveRequestId) &&
                    typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function')
                    window.dispatchEvent(new CustomEvent('verter:map-saved', {
                        detail: {id: state.id, name: state.name, base_path: state.base_path}
                    }));
            }
        }
        else if (['failed','interrupted'].includes(state.status)) el('save-info').textContent = `Сохранение не завершено: ${state.error}${state.grid_saved ? ' · YAML/PGM уже созданы; выберите новое имя для повторной попытки' : ''}`;
        else el('save-info').textContent = reason || 'Карта готова к сохранению. Сначала остановите робота вручную.';
    }
    function uuid() {
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
        const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    el('save-map').onclick = async () => {
        const name = el('map-name').value;
        if (!name || !el('map-name').checkValidity()) { el('map-name').reportValidity(); return; }
        saving = true; saveError = null; saveRequestId = uuid(); renderSave(latest?.save);
        try {
            if (!serverClock || performance.now()-serverClock.midpoint>10000) throw Error('Нет свежей синхронизации времени; дождитесь обновления карты');
            const response = await fetch('/api/command', {method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({v:1,id:saveRequestId,issued_at:serverClock.at+(performance.now()-serverClock.midpoint)/1000,
                    ttl_s:30,action:'map.save',args:{name}}),signal:AbortSignal.timeout(10000)});
            const body=await response.json();
            if (!response.ok || !body.ok) throw Error(body.error || `HTTP ${response.status}`);
            latest.save=body.result; renderSave(body.result);
        } catch (error) { saveError = 'Сохранение не подтверждено: '+error.message+'. Проверьте состояние; автоматического повтора нет.'; }
        finally { saving=false; renderSave(latest?.save); }
    };
    el('map-name').value = 'survey_' + new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','_');
    el('map-name').addEventListener('input', () => renderSave(latest?.save));
    el('show-scan').onchange = drawScan;
    el('fit-map').onclick = fit;
    el('fit-robot').onclick = () => { if (poseValid()) { view.setCenter([lastPose.x,lastPose.y]); view.setResolution(.01); } };
    el('follow').onchange = drawRobot;
    document.addEventListener('visibilitychange', () => {
        lastPose = null; drawRobot();
        lastScan = null; drawScan();
        notifyState();
        if (!document.hidden) { pollMetadata(); pollPose(); pollScan(); }
    });
    api({part: 'model'}).then(value => { model = value.available ? value : null; drawRobot(); }).catch(() => {});
    pollMetadata(); pollPose(); pollScan();
    setInterval(pollMetadata, 1000); setInterval(pollPose, 200); setInterval(pollScan, 200);
    setInterval(() => {
        if (mapState().stale || !poseValid()) drawRobot();
        if (mapState().stale || !scanValid()) drawScan();
        renderSave(latest?.save);
        notifyState();
    }, 500);
})();
