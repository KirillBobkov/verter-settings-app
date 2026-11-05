/* No motion requests on load, polling, or redraw. An explicit click or panel keypress starts a lease. */
(() => {
    // getRandomValues also works on the trusted LAN HTTP debug interface.
    function uuid() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    const el = (id) => document.getElementById(id);
    let linear = 0,
        angular = 0,
        session = null,
        seq = 0,
        generation = 0,
        active = false;
    let available = false,
        known = false,
        statusBusy = false,
        commandBusy = false,
        queue = Promise.resolve();
    let serverClock = null;
    function serverNow() {
        if (!serverClock || performance.now() - serverClock.received > 5000)
            throw Error('Нет свежей синхронизации времени с Jetson');
        return serverClock.at + (performance.now() - serverClock.midpoint) / 1000;
    }
    function showResult(text, error = false) {
        el('drive-command-result').textContent = text;
        el('drive-command-result').classList.toggle('stale', error);
    }
    const arrows = [...document.querySelectorAll('[data-drive]')];
    const round = (x) => Math.round(x * 100) / 100;
    const signed = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2).replace('.', ',');
    function target() {
        el('drive-target').textContent =
            `Задано: ${signed(linear)} м/с · ${signed(angular)} рад/с (ROS: + влево, − вправо)`;
    }
    function reset() {
        active = false;
        session = null;
        linear = angular = 0;
        generation++;
        target();
    }
    function buttons() {
        for (const button of arrows) button.disabled = !available || !known;
    }
    async function send(operation, args, issued = serverNow()) {
        const response = await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                v: 1,
                id: uuid(),
                issued_at: issued,
                ttl_s: 1,
                action: 'cmd_vel.' + operation,
                args
            }),
            signal: AbortSignal.timeout(1200)
        });
        if (!response.ok) throw Error(await response.text());
        const result = await response.json();
        if (!result.ok) throw Error(result.error);
        return result.result;
    }
    function fail(error) {
        reset();
        available = false;
        buttons();
        showResult('Команда не подтверждена: ' + error.message + '. Повторного запуска нет.', true);
    }
    function enqueue(operation, args, epoch) {
        let issued;
        try {
            issued = serverNow();
        } catch (error) {
            fail(error);
            return;
        }
        queue = queue.then(async () => {
            if (epoch !== generation || !active) return;
            commandBusy = true;
            try {
                const result = await send(operation, args, issued);
                if (epoch === generation) {
                    if (!result.active) reset();
                    if (operation === 'set') showResult('Заданная скорость принята backend');
                }
            } catch (error) {
                if (epoch === generation) fail(error);
            } finally {
                commandBusy = false;
            }
        });
    }
    function step(direction) {
        if (!available || !known) return;
        if (!session) {
            session = uuid();
            seq = 0;
            generation++;
        }
        if (direction === 'forward') linear = round(Math.min(0.5, linear + 0.01));
        if (direction === 'backward') linear = round(Math.max(-0.5, linear - 0.01));
        if (direction === 'left') angular = round(Math.min(0.5, angular + 0.05));
        if (direction === 'right') angular = round(Math.max(-0.5, angular - 0.05));
        active = true;
        target();
        showResult('Отправка заданной скорости…');
        enqueue('set', { session_id: session, seq: ++seq, linear_x: linear, angular_z: angular }, generation);
    }
    async function stop() {
        reset();
        try {
            await send('stop', {});
            showResult('Команда остановки принята backend');
        } catch (error) {
            fail(error);
        }
    }
    function renderOdometry(record) {
        const fresh =
            record &&
            !record.stale &&
            record.age_s <= 1 &&
            Number.isFinite(record.value?.vx) &&
            Number.isFinite(record.value?.wz);
        const values = { forward: 0, backward: 0, left: 0, right: 0 };
        if (fresh) {
            const { vx, wz } = record.value;
            if (Math.abs(vx) >= 0.005) values[vx > 0 ? 'forward' : 'backward'] = vx;
            if (Math.abs(wz) >= 0.025) values[wz > 0 ? 'left' : 'right'] = Math.abs(wz);
        }
        for (const button of arrows) {
            const direction = button.dataset.drive,
                value = values[direction];
            button.classList.toggle('moving', fresh && value !== 0);
            button.querySelector('.drive-speed').textContent = fresh
                ? (value ? signed(value) : '0,00') + (direction === 'left' || direction === 'right' ? ' рад/с' : ' м/с')
                : '—';
        }
        el('drive-odometry').textContent = fresh
            ? 'В кнопках — фактическая скорость по одометрии'
            : 'Фактическая скорость неизвестна: нет свежей одометрии';
    }
    async function poll() {
        if (statusBusy) return;
        statusBusy = true;
        try {
            const sentAt = performance.now();
            const response = await fetch('/api/drive', { signal: AbortSignal.timeout(1200) });
            if (!response.ok) throw Error('нет ответа');
            const result = await response.json();
            if (!result.ok) throw Error(result.error);
            const received = performance.now(),
                rtt = received - sentAt;
            if (
                Number.isFinite(result.at) &&
                rtt < 800 &&
                (!serverClock || rtt <= serverClock.rtt || received - serverClock.received > 3000)
            ) {
                serverClock = { at: result.at, midpoint: (sentAt + received) / 2, received, rtt };
            }
            const state = result.result;
            known = !!serverClock && received - serverClock.received <= 5000;
            const other = state.active && state.session_id !== session;
            available = state.enabled && state.ready && !other;
            // A stopped or expired session is never restarted by a polling response.
            // Expiry is confirmed by the next keepalive reply; an older poll must not cancel a new click.
            el('drive-status').textContent = !state.enabled
                ? 'Управление отключено'
                : !state.ready
                  ? 'ROS не готов'
                  : other
                    ? 'Управление занято другой страницей'
                    : state.active
                      ? 'Ручное управление активно'
                      : 'Готово · движение начнётся только после нажатия';
            if (!known) el('drive-status').textContent = 'Ожидание синхронизации времени с Jetson';
            renderOdometry(state.odometry);
            buttons();
        } catch (error) {
            known = false;
            available = false;
            reset();
            renderOdometry(null);
            buttons();
            el('drive-status').textContent = 'Связь потеряна · автоматического возобновления нет';
        } finally {
            statusBusy = false;
        }
    }
    for (const button of arrows) {
        button.onclick = () => step(button.dataset.drive);
        button.onkeydown = (event) => {
            if (event.repeat) event.preventDefault();
        };
    }
    el('drive-stop').onclick = stop;
    const panel = el('drive-panel');
    const keyDirections = { ArrowUp: 'forward', ArrowDown: 'backward', ArrowLeft: 'left', ArrowRight: 'right' };
    panel.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('button,input,textarea,select,a,[contenteditable]'))
            panel.focus({ preventScroll: true });
    });
    panel.addEventListener('keydown', (event) => {
        if (event.target.isContentEditable || event.target.closest('input,textarea,select')) return;
        const direction = keyDirections[event.key],
            isStop = event.key === ' ';
        if (!direction && !isStop) return;
        // Prevent scrolling and Space's native button activation (which could restart motion).
        event.preventDefault();
        if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
            return;
        if (isStop) stop();
        else step(direction);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && active) stop();
    });
    window.addEventListener('blur', () => {
        if (active) stop();
    });
    window.addEventListener('pagehide', () => {
        active = false;
    }); // Server lease handles abrupt closure.
    setInterval(() => {
        if (active && session && !commandBusy && !document.hidden)
            enqueue('keepalive', { session_id: session, seq: ++seq }, generation);
    }, 200);
    target();
    buttons();
    poll();
    setInterval(poll, 250);
})();
