/* Definitions and localization requests go through the NATS HTTP bridge. No motion/goal endpoints. */
(() => {
    'use strict';
    const el = id => document.getElementById(id);
    const viewer = window.VerterMap;
    if (!viewer || !el('loc-map')) return;

    let mode = null;
    let snapshot = null;
    let snapshotReply = 0;
    let serverClock = null;
    let selectedMap = '';
    let maps = [];
    let points = [];
    let routes = [];
    let routeOrder = [];
    let catalogsReady = false;
    let catalogRevision = null;
    let catalogToken = 0;
    let changing = false;
    let polling = false;
    let placement = null;
    let pointerOrigin = null;
    let initialPose = null;
    let pointPose = null;
    let lastScope = '';
    let lastInitialization = '';
    let readError = null;
    let mapsLoading = false;
    let mapsAgain = false;
    let suspendedPans = [];
    const overlays = new ol.source.Vector({wrapX: false});
    const overlayLayer = new ol.layer.Vector({
        source: overlays,
        style(feature) {
            const kind = feature.get('kind');
            const color = kind === 'initial' ? '#ffb75e' : kind === 'draft' ? '#ffe28a' : '#70e8c3';
            if (kind === 'route') return new ol.style.Style({
                stroke: new ol.style.Stroke({color: '#be9aff', width: 2, lineDash: [8, 6]})
            });
            return new ol.style.Style({
                image: new ol.style.Circle({radius: kind === 'point' ? 5 : 7,
                    fill: new ol.style.Fill({color}), stroke: new ol.style.Stroke({color: '#101722', width: 2})}),
                stroke: new ol.style.Stroke({color, width: 2}),
                text: new ol.style.Text({text: feature.get('label') || '', offsetY: -15,
                    font: '13px sans-serif', fill: new ol.style.Fill({color}),
                    stroke: new ol.style.Stroke({color: '#101722', width: 3})})
            });
        }
    });
    viewer.map.addLayer(overlayLayer);

    function requestId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function api(path, body) {
        const sent = performance.now();
        const response = await fetch(path, {
            method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json'},
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
        });
        const value = await response.json();
        if (Number.isFinite(value.at) && performance.now() - sent < 1000)
            serverClock = {at: value.at, midpoint: (sent + performance.now()) / 2};
        if (!response.ok || !value.ok) throw Error(value.error || `HTTP ${response.status}`);
        return value.result;
    }

    function command(action, args = {}) {
        return api('/api/command', {
            v: 1, id: requestId(),
            issued_at: serverClock ? serverClock.at + (performance.now() - serverClock.midpoint) / 1000 : Date.now() / 1000,
            ttl_s: 10, action, args
        });
    }

    function message(text, error = false) {
        el('loc-message').textContent = text;
        el('loc-message').dataset.error = String(error);
    }

    function normalized(angle) {
        return Math.atan2(Math.sin(angle), Math.cos(angle));
    }

    function poseFromFields(prefix) {
        const fields = ['x', 'y', 'yaw'].map(name => el(`${prefix}-${name}`));
        if (fields.some(field => field.value.trim() === '' || !field.checkValidity())) return null;
        const [x, y, degrees] = fields.map(field => Number(field.value));
        if (![x, y, degrees].every(Number.isFinite)) return null;
        return {x, y, yaw: normalized(degrees * Math.PI / 180)};
    }

    function fillPose(prefix, pose) {
        el(prefix + '-x').value = pose.x.toFixed(3);
        el(prefix + '-y').value = pose.y.toFixed(3);
        el(prefix + '-yaw').value = (normalized(pose.yaw) * 180 / Math.PI).toFixed(1);
    }

    function freshState() {
        return !document.hidden && !!mode && !!snapshot && performance.now() - snapshotReply < 4500 && !mode.stale;
    }

    function activeScope() {
        const metadata = viewer.getMetadata();
        const viewState = viewer.getState?.();
        return freshState() && ['localization', 'navigation'].includes(mode.actual) &&
            (!viewState || (viewState.available && !viewState.stale)) &&
            mode.map === selectedMap && snapshot.map === selectedMap &&
            metadata?.saved_map === selectedMap && metadata.frame_id === 'map' &&
            (!snapshot.pose?.map_id || snapshot.pose.map_id === metadata.map_id);
    }

    function canPlace() {
        return !!selectedMap && activeScope() && !changing;
    }

    function canInitialize() {
        return canPlace() && mode.actual === 'localization' && !!snapshot.session_id &&
            snapshot.enabled !== false && !snapshot.initializing;
    }

    function freshPose() {
        const pose = snapshot?.pose;
        if (!freshState() || !pose) return false;
        const now = performance.now();
        let age = Number.isFinite(pose.age_s) ? pose.age_s + (now - snapshotReply) / 1000 :
            (now - snapshotReply) / 1000;
        if (Number.isFinite(pose.sample_at) && serverClock)
            age = serverClock.at + (now - serverClock.midpoint) / 1000 - pose.sample_at;
        return pose.valid !== false && pose.stale !== true &&
            snapshot.stale !== true && ['x', 'y', 'yaw'].every(key => Number.isFinite(pose[key])) &&
            Number.isFinite(age) && age >= -1 && age <= 2;
    }

    function identityReady(prefix) {
        const id = el(prefix + '-id');
        const label = el(prefix + '-label');
        return !!id.value && id.checkValidity() && !!label.value.trim() &&
            label.value.trim().length <= 100 && label.checkValidity();
    }

    function setAvailability(id, reason) {
        const button = el(id);
        button.disabled = !!reason;
        button.title = reason || '';
    }

    function confirmationReason() {
        if (!freshState()) return 'Нужно свежее состояние локализации';
        if (!activeScope()) return 'На экране должна быть выбранная активная карта';
        if (snapshot.enabled === false) return 'Изменение начального положения отключено';
        if (mode.actual !== 'localization') return 'Подтверждение доступно в режиме локализации';
        if (snapshot.verified) return 'Положение уже подтверждено';
        if (!snapshot.session_id || !snapshot.initialization_id || !snapshot.ready_for_confirmation || !freshPose())
            return 'Сначала задайте начальную позу и дождитесь свежего положения и лидара';
        if (!el('loc-alignment').checked) return 'Отметьте визуальную проверку совпадения с картой';
        return '';
    }

    function contextHint() {
        if (readError) return 'Нет свежего состояния: ' + readError;
        if (!freshState()) return document.hidden ? 'Просмотр приостановлен.' : 'Ожидание связи и состояния робота.';
        if (!selectedMap) return 'Сохранённых карт нет. Постройте и сохраните карту в режиме картографирования.';
        const shown = viewer.getMetadata()?.saved_map;
        if (mode.actual === 'idle')
            return `Выбран каталог «${selectedMap}». Для показа карты запустите её локализацию. Численные точки можно редактировать и в ожидании.`;
        if (mode.actual === 'mapping')
            return 'Идёт картографирование. Сохранение доступно в разделе «Карта»; точки сохранённой карты редактируются численно.';
        if (mode.map !== selectedMap || shown !== selectedMap)
            return `Выбран каталог «${selectedMap}», активная карта — «${mode.map || '—'}». Выбор каталога не переключает режим робота.`;
        if (!activeScope()) return 'Ожидание свежей карты текущей сессии. Выбор координат на карте временно недоступен.';
        if (snapshot.enabled === false) return 'Задание начальной позы отключено в настройках. Просмотр и каталог точек доступны.';
        if (snapshot.verified) return 'Положение подтверждено. Для новой точки заполните ID и название, затем сохраните текущее положение или выберите координаты.';
        if (snapshot.ready_for_confirmation) return 'Проверьте совпадение модели и лидара с картой, отметьте проверку и подтвердите положение.';
        return 'Выберите начальную позу на карте или введите координаты, отправьте её и дождитесь оценки положения.';
    }

    function updateControls() {
        const current = freshState() && snapshot.map === selectedMap && mode.map === selectedMap;
        el('loc-map').disabled = changing || mapsLoading;
        el('loc-refresh').disabled = changing || mapsLoading;
        el('loc-start').disabled = changing || !selectedMap || !freshState() || mode.actual !== 'idle' ||
            mode.execution_enabled === false || mode.operation?.status === 'running';
        el('loc-start').title = changing ? 'Дождитесь завершения действия' :
            !selectedMap ? 'Выберите сохранённую карту' : !freshState() ? 'Нет свежего состояния робота' :
            mode.execution_enabled === false ? 'Переключение режимов отключено' :
            mode.actual !== 'idle' ? 'Сначала завершите текущий режим в основном окне' :
            mode.operation?.status === 'running' ? 'Дождитесь завершения переключения режима' :
            'Запустить локализацию выбранной карты после подтверждения';
        const busy = changing ? 'Дождитесь завершения действия' : '';
        const mapRequired = !selectedMap || !catalogsReady ? 'Выберите карту и дождитесь загрузки каталога' : '';
        const placementReason = !canPlace() ? 'Нужна свежая выбранная карта в режиме локализации или навигации' : '';
        setAvailability('loc-place-initial', busy || (!canInitialize() ? 'Нужна активная локализация выбранной карты и разрешение начальной позы' : ''));
        setAvailability('loc-place-point', busy || placementReason);
        setAvailability('loc-initialize', busy || (!canInitialize() ? 'Нужна активная локализация выбранной карты' : '') ||
            (!poseFromFields('loc-init') ? 'Укажите X, Y и угол начального положения' : '') ||
            (!el('loc-std-xy').value || !el('loc-std-yaw').value || !el('loc-std-xy').checkValidity() ||
                !el('loc-std-yaw').checkValidity() ? 'Проверьте значения начальной неопределённости' : ''));
        setAvailability('loc-confirm', busy || confirmationReason());
        setAvailability('loc-point-save', busy || mapRequired ||
            (!identityReady('loc-point') ? 'Заполните корректные ID и название точки (до 100 символов)' : '') ||
            (!poseFromFields('loc-point') ? 'Введите координаты точки или выберите её на карте' : ''));
        setAvailability('loc-point-current', busy || mapRequired ||
            (!identityReady('loc-point') ? 'Сначала заполните ID и название точки' : '') ||
            (!current || snapshot.verified !== true || !freshPose() || !activeScope()
                ? 'Нужно подтверждённое свежее положение на выбранной карте' : ''));
        setAvailability('loc-route-add', busy || mapRequired || (!points.length ? 'Сначала сохраните хотя бы одну точку' : '') ||
            (routeOrder.length >= 100 ? 'В описании допускается не более 100 точек' : ''));
        setAvailability('loc-route-save', busy || mapRequired ||
            (!identityReady('loc-route') ? 'Заполните корректные ID и название маршрута (до 100 символов)' : '') ||
            (!routeOrder.length || routeOrder.length > 100 || routeOrder.some(id => !points.some(point => point.id === id))
                ? 'Добавьте от 1 до 100 существующих точек' : ''));
        el('loc-point-new').disabled = changing;
        el('loc-route-new').disabled = changing;
        for (const button of document.querySelectorAll('[data-loc-catalog-action]'))
            button.disabled = changing || !catalogsReady || button.dataset.locBoundaryDisabled === 'true';
        if (placement && !canPlace()) cancelPlacement();
        if (el('loc-action-hint')) el('loc-action-hint').textContent = contextHint();
        if (selectedMap && catalogsReady) {
            const missing = !identityReady('loc-point') ? ' Для новой точки заполните ID и название.' :
                !poseFromFields('loc-point') ? ' Укажите координаты или сохраните подтверждённое текущее положение.' : '';
            el('loc-point-note').textContent = `Точек: ${points.length}.${missing} Выбран каталог «${selectedMap}».`;
        }
    }

    function drawPose(pose, kind, label) {
        if (!pose || !['x', 'y', 'yaw'].every(key => Number.isFinite(pose[key]))) return;
        const start = [pose.x, pose.y];
        const length = Math.max(0.25, viewer.view.getResolution() * 22);
        const tip = [pose.x + length * Math.cos(pose.yaw), pose.y + length * Math.sin(pose.yaw)];
        overlays.addFeature(new ol.Feature({geometry: new ol.geom.Point(start), kind, label}));
        overlays.addFeature(new ol.Feature({geometry: new ol.geom.LineString([start, tip]), kind}));
        const side = length * 0.25;
        overlays.addFeature(new ol.Feature({geometry: new ol.geom.LineString([
            [tip[0] - side * Math.cos(pose.yaw - 0.5), tip[1] - side * Math.sin(pose.yaw - 0.5)],
            tip,
            [tip[0] - side * Math.cos(pose.yaw + 0.5), tip[1] - side * Math.sin(pose.yaw + 0.5)]
        ]), kind}));
    }

    function renderOverlay() {
        overlays.clear();
        if (!activeScope()) return;
        for (const point of points) {
            const positions = routeOrder.flatMap((id, index) => id === point.id ? [index + 1] : []);
            const prefix = positions.length ? positions.join(', ') + ': ' : '';
            drawPose(point, 'point', prefix + (point.label || point.id));
        }
        const coordinates = [];
        for (const id of routeOrder) {
            const point = points.find(value => value.id === id);
            if (!point) continue;
            coordinates.push([point.x, point.y]);
        }
        if (coordinates.length > 1) overlays.addFeature(new ol.Feature({
            geometry: new ol.geom.LineString(coordinates), kind: 'route'
        }));
        drawPose(initialPose, 'initial', 'Начальная поза · ещё не отправлена');
        drawPose(pointPose, 'draft', 'Редактируемая точка');
    }

    function cancelPlacement() {
        for (const interaction of suspendedPans) interaction.setActive(true);
        suspendedPans = [];
        placement = null;
        pointerOrigin = null;
        document.body.classList.remove('loc-placement-active');
        el('loc-placement-cancel').hidden = true;
        el('loc-placement-info').textContent = canPlace()
            ? 'Для нового выбора нажмите нужную кнопку. Оранжевое — начальная поза; жёлтое — редактируемая точка.'
            : 'Для выбора щелчком запустите локализацию выбранной карты. Численное редактирование точек доступно и в idle.';
    }

    function beginPlacement(kind) {
        if (!canPlace() || (kind === 'initial' && !canInitialize())) return;
        cancelPlacement();
        const mapElement = el('ol-map');
        const bounds = mapElement.getBoundingClientRect?.();
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        if (!bounds || bounds.top < 0 || bounds.bottom > viewportHeight)
            mapElement.scrollIntoView({behavior: 'instant', block: 'center'});
        const interactions = viewer.map.getInteractions?.().getArray?.() || [];
        for (const interaction of interactions) {
            if (typeof ol.interaction.DragPan === 'function' && interaction instanceof ol.interaction.DragPan &&
                interaction.getActive()) {
                suspendedPans.push(interaction);
                interaction.setActive(false);
            }
        }
        placement = kind;
        document.body.classList.add('loc-placement-active');
        el('loc-placement-cancel').hidden = false;
        el('loc-placement-info').textContent = 'Нажмите точку на карте; удерживайте и протяните указатель для направления. Это только выбор координат.';
    }

    function place(coordinate, dragging = false) {
        const prefix = placement === 'initial' ? 'loc-init' : 'loc-point';
        let pose = poseFromFields(prefix) || {x: coordinate[0], y: coordinate[1], yaw: 0};
        if (!dragging) {
            pose = {...pose, x: coordinate[0], y: coordinate[1]};
            pointerOrigin = coordinate.slice();
        } else {
            const dx = coordinate[0] - pointerOrigin[0];
            const dy = coordinate[1] - pointerOrigin[1];
            if (Math.hypot(dx, dy) > 0.03) pose.yaw = Math.atan2(dy, dx);
        }
        fillPose(prefix, pose);
        if (placement === 'initial') initialPose = pose;
        else pointPose = pose;
        updateControls();
        renderOverlay();
    }

    const pointer = new ol.interaction.Pointer({
        handleDownEvent(event) {
            if (!placement || !canPlace() || event.originalEvent.button !== 0) return false;
            place(event.coordinate);
            return true;
        },
        handleDragEvent(event) {
            if (placement && pointerOrigin && canPlace()) place(event.coordinate, true);
        },
        handleUpEvent() {
            if (placement) {
                cancelPlacement();
                updateControls();
            }
            return false;
        }
    });
    viewer.map.addInteraction(pointer);
    viewer.view.on('change:resolution', renderOverlay);

    function renderState() {
        const state = freshState();
        el('loc-mode-info').textContent = !state ? 'Нет свежего состояния режима; действия локализации заблокированы.' :
            mode.actual === 'idle' ? 'Режим idle. Запуск локализации выполняется только кнопкой после подтверждения.' :
            mode.actual === 'mapping' ? 'Идёт картографирование. Сохраните карту и завершите режим в основном окне; переход к idle может отправить нулевую скорость.' :
            `Текущий режим: ${mode.actual} · карта: ${mode.map || '—'}. Для другой карты сначала завершите режим в основном окне.`;
        el('loc-status').dataset.verified = String(state && snapshot.verified === true);
        const descriptions = {
            waiting_for_current_session_amcl_pose: 'задайте начальную позу и дождитесь оценки положения',
            fresh_current_session_map_pose_required: 'ожидается свежее положение робота на карте',
            fresh_current_session_map_scan_required: 'ожидается свежий лидар в координатах карты',
            operator_confirmation_required: 'требуется визуальная проверка совпадения',
            initial_pose_publication_in_progress: 'отправляется начальное положение'
        };
        const explanation = descriptions[snapshot?.reason] ||
            (snapshot?.status === 'publishing' ? 'отправляется начальное положение' : 'ожидание готовности положения');
        el('loc-status').textContent = !state ?
            (readError ? 'Не удалось получить локализацию: ' + readError : 'Локализация недоступна') :
            snapshot.verified === true ? 'Положение подтверждено оператором' :
            snapshot.session_id ? `Положение не подтверждено · ${explanation}` : 'Нет активной сессии локализации';
        const pose = snapshot?.pose;
        el('loc-current-pose').textContent = freshPose()
            ? `Текущее положение: x ${pose.x.toFixed(2)} м · y ${pose.y.toFixed(2)} м · угол ${(pose.yaw * 180 / Math.PI).toFixed(1)}° · карта ${snapshot.map}`
            : 'Текущее положение: нет свежей достоверной позы';
        if (!placement) cancelPlacement();
        updateControls();
        renderOverlay();
    }

    async function refreshState() {
        if (polling || document.hidden) return;
        polling = true;
        try {
            const metrics = await api('/api/metrics');
            const service = metrics?.['service.snapshot']?.value;
            if (!service?.mode) throw Error('Нет состояния режима');
            const next = await command('localization.get');
            mode = service.mode;
            snapshot = next;
            readError = null;
            snapshotReply = performance.now();
            const scope = `${next.session_id || ''}|${next.map || ''}|${next.map_revision || ''}`;
            const initialization = `${scope}|${next.initialization_id || ''}`;
            if (lastScope && scope !== lastScope) {
                initialPose = null;
                el('loc-init-x').value = '';
                el('loc-init-y').value = '';
                cancelPlacement();
            }
            if (initialization !== lastInitialization) el('loc-alignment').checked = false;
            if (catalogRevision && next.map === selectedMap && next.map_revision && next.map_revision !== catalogRevision) {
                catalogsReady = false;
                catalogRevision = null;
                points = [];
                routes = [];
                clearMapDrafts();
                renderCatalogs();
                message('Содержимое выбранной карты изменилось. Обновите каталог и задайте точки заново.', true);
            }
            lastScope = scope;
            lastInitialization = initialization;
        } catch (error) {
            readError = error.message;
            mode = null;
            snapshot = null;
        } finally {
            polling = false;
            renderState();
        }
    }

    function node(tag, text, className) {
        const value = document.createElement(tag);
        if (text !== undefined) value.textContent = text;
        if (className) value.className = className;
        return value;
    }

    function button(label, callback) {
        const value = node('button', label);
        value.type = 'button';
        value.dataset.locCatalogAction = 'true';
        value.addEventListener('click', callback);
        return value;
    }

    function renderCatalogs() {
        el('loc-point-list').replaceChildren();
        el('loc-route-list').replaceChildren();
        const selectedPoint = el('loc-route-point').value;
        el('loc-route-point').replaceChildren();
        for (const point of points) {
            const option = node('option', `${point.label} · ${point.id}`);
            option.value = point.id;
            el('loc-route-point').append(option);
            const row = node('div', undefined, 'loc-record');
            const text = node('div', undefined, 'loc-record-description');
            text.append(node('strong', point.label), node('span',
                `${point.id} · x ${point.x.toFixed(2)} · y ${point.y.toFixed(2)} м · ${(point.yaw * 180 / Math.PI).toFixed(1)}°`));
            row.append(text, button('Изменить', () => editPoint(point)),
                button('Удалить', () => deletePoint(point)));
            el('loc-point-list').append(row);
        }
        if (points.some(point => point.id === selectedPoint)) el('loc-route-point').value = selectedPoint;
        for (const route of routes) {
            const row = node('div', undefined, 'loc-record');
            const text = node('div', undefined, 'loc-record-description');
            text.append(node('strong', route.label), node('span',
                `${route.id} · ${route.kind === 'through' ? 'Прохождение' : 'Посещение'} · ${route.points.join(' → ')}`));
            row.append(text, button('Изменить / показать схему', () => editRoute(route)),
                button('Удалить', () => deleteRoute(route)));
            el('loc-route-list').append(row);
        }
        el('loc-point-note').textContent = !selectedMap ? 'Выберите сохранённую карту.' :
            !catalogsReady ? 'Каталог недоступен; обновите список перед сохранением.' :
            `Точек: ${points.length}. ID при редактировании сохраняется; для нового ID нажмите «Новая точка».`;
        el('loc-route-note').textContent = catalogsReady ? `Описаний маршрутов: ${routes.length}. Исполнение не доступно.` : 'Каталог маршрутов пока не получен.';
        renderRouteOrder();
        updateControls();
        renderOverlay();
    }

    async function loadCatalogs() {
        const map = selectedMap;
        const token = ++catalogToken;
        catalogsReady = false;
        updateControls();
        if (!map) {
            points = [];
            routes = [];
            renderCatalogs();
            return;
        }
        try {
            const [pointReply, routeReply] = await Promise.all([
                command('waypoint.list', {map}), command('route.list', {map})
            ]);
            if (token !== catalogToken || map !== selectedMap) return;
            if (pointReply.map !== map || routeReply.map !== map ||
                (pointReply.map_revision && routeReply.map_revision && pointReply.map_revision !== routeReply.map_revision))
                throw Error('Каталоги относятся к разным версиям карты');
            const revision = pointReply.map_revision || routeReply.map_revision || null;
            if (catalogRevision && revision && catalogRevision !== revision) clearMapDrafts();
            catalogRevision = revision;
            points = pointReply.waypoints || [];
            routes = routeReply.routes || [];
            catalogsReady = true;
        } catch (error) {
            if (token !== catalogToken) return;
            points = [];
            routes = [];
            message('Не удалось получить точки и маршруты: ' + error.message, true);
        }
        if (token === catalogToken) renderCatalogs();
    }

    async function loadMaps() {
        if (mapsLoading) {
            mapsAgain = true;
            return;
        }
        mapsLoading = true;
        updateControls();
        try {
            const reply = await api('/api/map?part=saved');
            maps = Array.isArray(reply.maps) ? reply.maps : [];
            const available = maps.filter(item => item && typeof item.name === 'string' && item.grid !== false);
            const keep = available.some(item => item.name === selectedMap) ? selectedMap :
                available.find(item => item.name === mode?.map)?.name || available[0]?.name || '';
            el('loc-map').replaceChildren();
            if (!available.length) {
                const empty = node('option', 'Нет сохранённых YAML/PGM карт');
                empty.value = '';
                el('loc-map').append(empty);
            }
            for (const item of available) {
                const option = node('option', item.name);
                option.value = item.name;
                el('loc-map').append(option);
            }
            if (selectedMap !== keep) {
                selectedMap = keep;
                catalogRevision = null;
                points = [];
                routes = [];
                catalogsReady = false;
                clearMapDrafts();
            }
            el('loc-map').value = selectedMap;
            await loadCatalogs();
            renderState();
        } finally {
            mapsLoading = false;
            updateControls();
            if (mapsAgain) {
                mapsAgain = false;
                await loadMaps();
            }
        }
    }

    async function mutate(operation) {
        if (changing) return;
        changing = true;
        cancelPlacement();
        updateControls();
        try {
            const text = await operation();
            if (text) message(text);
        } catch (error) {
            message('Действие не подтверждено: ' + error.message + '. Автоматического повтора нет; обновите состояние перед повтором.', true);
        } finally {
            changing = false;
            renderState();
        }
    }

    function assertClock() {
        if (!serverClock || performance.now() - serverClock.midpoint > 10000)
            throw Error('Нет свежей синхронизации времени с сервером');
    }

    function requireMap() {
        if (!selectedMap || !catalogsReady) throw Error('Сначала выберите карту и обновите каталог');
    }

    function recordIdentity(prefix) {
        const id = el(prefix + '-id');
        const label = el(prefix + '-label');
        if (!id.reportValidity() || !label.reportValidity()) throw Error('Заполните ID и название');
        if (!label.value.trim()) throw Error('Название не может состоять из пробелов');
        if (label.value.trim().length > 100) throw Error('Название должно быть не длиннее 100 символов');
        return {id: id.value, label: label.value.trim()};
    }

    function editPoint(point) {
        el('loc-point-id').value = point.id;
        el('loc-point-id').readOnly = true;
        el('loc-point-label').value = point.label;
        fillPose('loc-point', point);
        pointPose = {...point};
        updateControls();
        renderOverlay();
    }

    function newPoint() {
        el('loc-point-form').reset();
        el('loc-point-id').readOnly = false;
        pointPose = null;
        updateControls();
        renderOverlay();
    }

    function clearMapDrafts() {
        initialPose = null;
        pointPose = null;
        newPoint();
        newRoute();
        el('loc-init-x').value = '';
        el('loc-init-y').value = '';
        el('loc-alignment').checked = false;
        cancelPlacement();
    }

    function deletePoint(point) {
        mutate(async () => {
            requireMap();
            const used = routes.filter(route => route.points.includes(point.id));
            if (used.length) throw Error('Сначала удалите точку из описаний маршрутов: ' + used.map(route => route.label).join(', '));
            if (!window.confirm(`Удалить точку «${point.label}» (${point.id}) с карты ${selectedMap}?`)) return;
            assertClock();
            await command('waypoint.delete', {map: selectedMap, id: point.id});
            if (el('loc-point-id').value === point.id) newPoint();
            await loadCatalogs();
            return 'Точка удалена.';
        });
    }

    function renderRouteOrder() {
        el('loc-route-order').replaceChildren();
        routeOrder.forEach((id, index) => {
            const row = node('li');
            const point = points.find(point => point.id === id);
            row.append(node('span', point ? `${point.label} · ${id}` : `Недоступная точка: ${id}`));
            const up = button('↑', () => {
                if (index === 0 || changing) return;
                [routeOrder[index - 1], routeOrder[index]] = [routeOrder[index], routeOrder[index - 1]];
                renderRouteOrder(); renderOverlay();
            });
            up.disabled = index === 0 || changing;
            up.dataset.locBoundaryDisabled = String(index === 0);
            up.setAttribute('aria-label', 'Переместить точку выше');
            const down = button('↓', () => {
                if (index === routeOrder.length - 1 || changing) return;
                [routeOrder[index + 1], routeOrder[index]] = [routeOrder[index], routeOrder[index + 1]];
                renderRouteOrder(); renderOverlay();
            });
            down.disabled = index === routeOrder.length - 1 || changing;
            down.dataset.locBoundaryDisabled = String(index === routeOrder.length - 1);
            down.setAttribute('aria-label', 'Переместить точку ниже');
            row.append(up, down, button('Убрать', () => {
                routeOrder.splice(index, 1);
                renderRouteOrder(); updateControls(); renderOverlay();
            }));
            el('loc-route-order').append(row);
        });
    }

    function editRoute(route) {
        el('loc-route-id').value = route.id;
        el('loc-route-id').readOnly = true;
        el('loc-route-label').value = route.label;
        el('loc-route-kind').value = route.kind;
        routeOrder = route.points.slice();
        renderRouteOrder(); updateControls(); renderOverlay();
    }

    function newRoute() {
        el('loc-route-form').reset();
        el('loc-route-id').readOnly = false;
        routeOrder = [];
        renderRouteOrder(); updateControls(); renderOverlay();
    }

    function deleteRoute(route) {
        mutate(async () => {
            requireMap();
            if (!window.confirm(`Удалить описание маршрута «${route.label}» (${route.id})?`)) return;
            assertClock();
            await command('route.delete', {map: selectedMap, id: route.id});
            if (el('loc-route-id').value === route.id) newRoute();
            await loadCatalogs();
            return 'Описание маршрута удалено.';
        });
    }

    el('loc-start').addEventListener('click', () => mutate(async () => {
        await refreshState();
        if (!freshState() || mode.actual !== 'idle' || mode.execution_enabled === false || mode.operation?.status === 'running')
            throw Error('Нужен доступный режим idle. Завершите текущий режим в основном окне.');
        if (!selectedMap) throw Error('Выберите сохранённую карту');
        if (!window.confirm(`Запустить режим локализации на карте «${selectedMap}»? Начальную позу затем нужно задать и подтвердить отдельно.`)) return;
        assertClock();
        await command('mode.set', {mode: 'localization', map: selectedMap});
        await refreshState();
        return 'Запрос запуска локализации отправлен. Дождитесь активной сессии и загрузки выбранной карты.';
    }));
    el('loc-initialize').addEventListener('click', () => mutate(async () => {
        await refreshState();
        const pose = poseFromFields('loc-init');
        // mutate locks buttons; validate the same scope without using its UI lock.
        if (!activeScope() || mode.actual !== 'localization' || !snapshot.session_id || !pose ||
            snapshot.enabled === false || snapshot.initializing)
            throw Error('Нужны активная локализация выбранной карты и корректная начальная поза');
        const xy = el('loc-std-xy');
        const angle = el('loc-std-yaw');
        if (!xy.reportValidity() || !angle.reportValidity() || !xy.value || !angle.value)
            throw Error('Проверьте начальную неопределённость');
        if (!window.confirm(`Отправить начальное положение на карту «${selectedMap}»: x=${pose.x.toFixed(2)} м, y=${pose.y.toFixed(2)} м, угол=${(pose.yaw * 180 / Math.PI).toFixed(1)}°? Прежнее подтверждение положения будет снято.`)) return;
        assertClock();
        await command('localization.initialize', {
            map: selectedMap, session_id: snapshot.session_id, ...pose,
            std_xy: Number(xy.value), std_yaw: Number(angle.value) * Math.PI / 180
        });
        initialPose = null;
        el('loc-alignment').checked = false;
        await refreshState();
        return 'Начальная поза отправлена. Проверьте совпадение модели и облака с картой, затем подтвердите положение.';
    }));
    el('loc-confirm').addEventListener('click', () => mutate(async () => {
        const initialization = snapshot?.initialization_id;
        await refreshState();
        if (confirmationReason() || !el('loc-alignment').checked || !freshPose() || snapshot.map !== selectedMap ||
            mode.actual !== 'localization' || !initialization || snapshot.initialization_id !== initialization)
            throw Error('Повторно проверьте положение и активную инициализацию');
        if (!window.confirm('Подтвердить, что реальное положение робота и облако лидара совпадают с выбранной картой?')) return;
        assertClock();
        await command('localization.confirm', {map: selectedMap, session_id: snapshot.session_id,
            initialization_id: initialization});
        await refreshState();
        return 'Подтверждение положения сохранено.';
    }));
    el('loc-point-form').addEventListener('submit', event => {
        event.preventDefault();
        mutate(async () => {
            requireMap();
            const identity = recordIdentity('loc-point');
            const pose = poseFromFields('loc-point');
            if (!pose) throw Error('Укажите X, Y и угол точки');
            assertClock();
            await command('waypoint.save', {map: selectedMap, ...identity, ...pose});
            await loadCatalogs();
            return 'Точка сохранена. Положение робота не изменяется.';
        });
    });
    el('loc-point-current').addEventListener('click', () => mutate(async () => {
        const identity = recordIdentity('loc-point');
        await refreshState();
        requireMap();
        if (!activeScope() || snapshot.verified !== true || !freshPose()) throw Error('Сначала подтвердите свежую локализацию на выбранной карте');
        assertClock();
        await command('waypoint.save', {map: selectedMap, ...identity, source: 'current'});
        await loadCatalogs();
        return 'Текущее положение сохранено как точка.';
    }));
    el('loc-route-form').addEventListener('submit', event => {
        event.preventDefault();
        mutate(async () => {
            requireMap();
            const identity = recordIdentity('loc-route');
            if (!routeOrder.length || routeOrder.some(id => !points.some(point => point.id === id)))
                throw Error('Добавьте существующие точки в нужном порядке');
            assertClock();
            await command('route.save', {map: selectedMap, ...identity,
                kind: el('loc-route-kind').value, points: routeOrder.slice()});
            await loadCatalogs();
            return 'Описание маршрута сохранено. Исполнение не запрашивалось.';
        });
    });
    el('loc-map').addEventListener('change', () => {
        selectedMap = el('loc-map').value;
        catalogRevision = null;
        catalogsReady = false;
        points = []; routes = [];
        clearMapDrafts();
        renderCatalogs();
        loadCatalogs();
        renderState();
    });
    el('loc-refresh').addEventListener('click', async () => {
        try { await refreshState(); await loadMaps(); }
        catch (error) { message('Обновление не завершено: ' + error.message, true); }
    });
    el('loc-place-initial').addEventListener('click', () => beginPlacement('initial'));
    el('loc-place-point').addEventListener('click', () => beginPlacement('point'));
    el('loc-placement-cancel').addEventListener('click', cancelPlacement);
    el('loc-alignment').addEventListener('change', updateControls);
    el('loc-point-new').addEventListener('click', newPoint);
    el('loc-route-new').addEventListener('click', newRoute);
    el('loc-route-add').addEventListener('click', () => {
        const id = el('loc-route-point').value;
        if (changing || routeOrder.length >= 100) return;
        if (catalogsReady && points.some(point => point.id === id)) routeOrder.push(id);
        renderRouteOrder(); updateControls(); renderOverlay();
    });
    for (const name of ['x', 'y', 'yaw']) {
        el('loc-init-' + name).addEventListener('input', () => {
            initialPose = poseFromFields('loc-init');
            updateControls(); renderOverlay();
        });
        el('loc-point-' + name).addEventListener('input', () => {
            pointPose = poseFromFields('loc-point');
            updateControls(); renderOverlay();
        });
    }
    for (const prefix of ['loc-point', 'loc-route']) {
        for (const name of ['id', 'label']) el(prefix + '-' + name).addEventListener('input', updateControls);
    }
    for (const id of ['loc-std-xy', 'loc-std-yaw']) el(id).addEventListener('input', updateControls);
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !placement) return;
        event.preventDefault();
        cancelPlacement();
        updateControls();
    });
    window.addEventListener('verter:map-tool-change', event => {
        const tab = placement === 'initial' ? 'localization' : 'points';
        if (placement && event.detail?.tab !== tab) cancelPlacement();
    });
    window.addEventListener('verter:map-saved', async event => {
        try {
            await loadMaps();
            message(`Карта «${event.detail?.name || 'новая карта'}» сохранена; список карт обновлён.`);
        } catch (error) {
            message('Карта сохранена, но список не обновился: ' + error.message, true);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            cancelPlacement();
            snapshotReply = 0;
            renderState();
        } else refreshState();
    });
    (async () => {
        await refreshState();
        try { await loadMaps(); }
        catch (error) { message('Не удалось получить сохранённые карты: ' + error.message, true); }
    })();
    setInterval(refreshState, 1500);
    setInterval(() => { updateControls(); renderOverlay(); }, 500);
})();
