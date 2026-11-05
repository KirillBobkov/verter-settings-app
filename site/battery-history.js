(() => {
    const el = id => document.getElementById(id);
    const labels = {
        soc_pct: ['Уровень заряда (SOC)', '%'], voltage_V: ['Напряжение батареи', 'В'], current_A: ['Ток', 'А'],
        power_W: ['Мощность', 'Вт'], remaining_Ah: ['Остаточная ёмкость', 'А·ч'],
        full_charge_capacity_Ah: ['Ёмкость полного заряда', 'А·ч'], cycles: ['Циклы', ''],
        mos_temperature_C: ['Температура MOS', '°C'], temperature_1_C: ['Температура 1', '°C'],
        temperature_2_C: ['Температура 2', '°C'], cell_sum_V: ['Сумма напряжений ячеек', 'В'],
        cell_delta_V: ['Разброс ячеек', 'В'], balance_current_A: ['Ток балансировки', 'А'],
        balance_state: ['Состояние балансировки', 'код'], charging_enabled: ['Заряд разрешён', '0 / 1'],
        discharging_enabled: ['Разряд разрешён', '0 / 1'], flags_raw: ['Исходные флаги BMS', 'битовая маска']
    };
    const colors = ['#63e6be', '#ffb866', '#7eaaff', '#526071'];
    const stateNames = ['Зарядка', 'Разрядка', 'Ток около нуля', 'Нет данных / неизвестно'];
    let data = null, busy = false;
    const date = at => new Date(at * 1000).toLocaleString();
    const number = value => Number(value.toPrecision(6)).toLocaleString(undefined, {maximumFractionDigits: 5});
    function surface(canvas) {
        const box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(box.width * ratio);
        canvas.height = Math.round(box.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        return {ctx, w: box.width, h: box.height};
    }
    function axes(ctx, w, h) {
        ctx.strokeStyle = '#354455'; ctx.lineWidth = 1;
        for (let n = 0; n < 4; n++) {
            const y = 12 + n * (h - 38) / 3;
            ctx.beginPath(); ctx.moveTo(57, y); ctx.lineTo(w - 10, y); ctx.stroke();
        }
        ctx.fillStyle = '#a9bdcf'; ctx.font = '10px system-ui';
        ctx.textAlign = 'left'; ctx.fillText(date(data.from), 57, h - 3);
        ctx.textAlign = 'right'; ctx.fillText(date(data.to), w - 10, h - 3);
    }
    function chart(canvas, key, points) {
        const {ctx, w, h} = surface(canvas);
        const low = Math.min(...points.map(p => p[2])), high = Math.max(...points.map(p => p[3]));
        const padding = Math.max((high - low) * .1, Math.abs(high) * .0001, .001);
        const min = low - padding, max = high + padding;
        const x = at => 57 + (at - data.from) / (data.to - data.from) * (w - 67);
        const y = value => 12 + (max - value) / (max - min) * (h - 38);
        axes(ctx, w, h);
        for (let n = 0; n < 4; n++) {
            ctx.textAlign = 'right';
            ctx.fillText(number(max - n * (max - min) / 3), 52, 15 + n * (h - 38) / 3);
        }
        const half = Math.max(1, data.bucket_s / (data.to - data.from) * (w - 67) / 2);
        ctx.fillStyle = '#63e6be33';
        for (const point of points) ctx.fillRect(x(point[0]) - half, y(point[3]), half * 2, Math.max(1, y(point[2]) - y(point[3])));
        ctx.strokeStyle = '#63e6be'; ctx.lineWidth = 1.5; ctx.beginPath();
        let previous = null;
        for (const point of points) {
            if (!previous || point[0] - previous[0] > data.bucket_s * 1.5) ctx.moveTo(x(point[0]), y(point[1]));
            else ctx.lineTo(x(point[0]), y(point[1]));
            previous = point;
        }
        ctx.stroke();
        ctx.fillStyle = '#63e6be';
        for (const point of points) { ctx.beginPath(); ctx.arc(x(point[0]), y(point[1]), 1.6, 0, Math.PI * 2); ctx.fill(); }
        canvas.onpointermove = event => {
            const fraction = (event.clientX - canvas.getBoundingClientRect().left - 57) / (w - 67);
            const at = data.from + fraction * (data.to - data.from);
            const point = points.reduce((a, b) => Math.abs(a[0] - at) < Math.abs(b[0] - at) ? a : b);
            const detail = canvas.parentElement.querySelector('.detail');
            if (Math.abs(point[0] - at) > data.bucket_s) { detail.textContent = 'Нет данных в этом интервале'; return; }
            detail.textContent = `${date(point[0])} · среднее ${number(point[1])} · мин. ${number(point[2])} · макс. ${number(point[3])} · последнее ${key === 'flags_raw' ? '0x' + point[4].toString(16) : number(point[4])}`;
        };
    }
    function modes() {
        const canvas = el('modes'), {ctx, w, h} = surface(canvas), count = data.mode_seconds.length;
        axes(ctx, w, h);
        data.mode_seconds.forEach((durations, index) => {
            let top = 12;
            durations.forEach((seconds, mode) => {
                const height = seconds / data.bucket_s * (h - 38);
                ctx.fillStyle = colors[mode];
                ctx.fillRect(57 + index / count * (w - 67), top, (w - 67) / count + .2, height);
                top += height;
            });
        });
        canvas.onpointermove = event => {
            const fraction = (event.clientX - canvas.getBoundingClientRect().left - 57) / (w - 67);
            const index = Math.max(0, Math.min(count - 1, Math.floor(fraction * count)));
            el('mode-detail').textContent = date(data.from + index * data.bucket_s) + ' · ' +
                data.mode_seconds[index].map((seconds, mode) => `${stateNames[mode]}: ${Math.round(seconds / data.bucket_s * 100)}%`).join(' · ');
        };
    }
    function render() {
        if (!data) return;
        const soc = data.series.soc_pct;
        el('soc-summary').textContent = soc?.length ?
            `Последний сохранённый заряд: ${number(soc[soc.length - 1][4])} %` :
            'Последний сохранённый заряд: нет данных в выбранном периоде';
        modes();
        el('charts').replaceChildren();
        const priority = Object.keys(labels);
        const entries = Object.entries(data.series).sort(([a], [b]) => {
            const rank = key => priority.includes(key) ? priority.indexOf(key) : priority.length;
            return rank(a) - rank(b) || a.localeCompare(b, undefined, {numeric: true});
        });
        for (const [key, points] of entries) {
            const cell = key.match(/^cell_(.+)_V$/);
            const [name, unit] = labels[key] || (cell ? ['Ячейка ' + cell[1], 'В'] : [key, '']);
            const card = document.createElement('section'); card.className = 'chart';
            const title = document.createElement('h2'); title.textContent = name + (unit ? ' · ' + unit : '');
            const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', title.textContent);
            const detail = document.createElement('p'); detail.className = 'detail';
            detail.textContent = 'Наведите указатель: среднее, минимум, максимум и последнее значение';
            card.append(title, canvas, detail); el('charts').append(card);
            chart(canvas, key, points);
        }
    }
    async function refresh() {
        if (busy) return;
        busy = true; el('refresh').disabled = true;
        try {
            const response = await fetch(`/api/battery/history?period_s=${el('period').value}&max_points=240`, {signal: AbortSignal.timeout(25000)});
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const result = await response.json(); if (!result.ok) throw Error(result.error);
            data = result.result; render();
            el('connection').className = '';
            el('connection').textContent = `Обновлено ${new Date().toLocaleTimeString()}`;
            el('coverage').textContent = data.stored_samples ?
                `Доступная история: ${date(data.available_from)} — ${date(data.available_to)}. В выбранном периоде ${data.samples.toLocaleString()} снимков.` :
                'История ещё не накоплена. Первые данные появятся после получения BMS; прошлые показания не восстанавливаются.';
        } catch (error) {
            el('connection').className = 'stale';
            el('connection').textContent = 'Не удалось обновить: ' + error.message + (data ? ' · показаны ранее загруженные данные' : '');
        } finally { busy = false; el('refresh').disabled = false; }
    }
    function exportLinks() {
        for (const format of ['csv', 'txt'])
            el('export-' + format).href = `/api/battery/export?format=${format}&period_s=${el('period').value}`;
    }
    el('refresh').onclick = refresh;
    el('period').onchange = () => { exportLinks(); refresh(); };
    exportLinks();
    setInterval(() => { if (el('auto').checked && !document.hidden) refresh(); }, 30000);
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
    refresh();
})();
