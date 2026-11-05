/* Layout and local view preferences only. No API requests or robot commands. */
(() => {
    'use strict';
    const names = ['localization', 'points', 'routes', 'layers', 'save'];
    const buttons = [...document.querySelectorAll('[data-map-tab]')];
    const el = id => document.getElementById(id);
    const viewer = window.VerterMap;
    if (!viewer || !buttons.length) return;

    let remembered = null;
    try { remembered = sessionStorage.getItem('verter.map.tool'); } catch (_) {}
    const hash = window.location.hash.slice(1);
    let automaticChoice = !names.includes(hash) && !names.includes(remembered);
    let activeTab = names.includes(hash) ? hash : names.includes(remembered) ? remembered : 'localization';
    let resizeQueued = false;
    let previousMode = null;
    let previousStatus = null;

    function resize() {
        resizeQueued = false;
        const main = document.querySelector('.map-console-main');
        const header = document.querySelector('.sensor-header');
        const toolbar = document.querySelector('.toolbar');
        const readout = document.querySelector('.map-readout');
        const headerHeight = Math.ceil(header.getBoundingClientRect().height);
        const height = Math.max(360, window.innerHeight - headerHeight -
            toolbar.getBoundingClientRect().height - Math.min(readout.getBoundingClientRect().height, 140) - 64);
        const headerValue = headerHeight + 'px';
        const heightValue = Math.floor(height) + 'px';
        if (main.style.getPropertyValue('--map-header-height') !== headerValue)
            main.style.setProperty('--map-header-height', headerValue);
        if (main.style.getPropertyValue('--map-viewport-height') !== heightValue)
            main.style.setProperty('--map-viewport-height', heightValue);
        viewer.map.updateSize();
    }

    function scheduleResize() {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(resize);
    }

    function show(name, {remember = true, focus = false} = {}) {
        if (!names.includes(name)) return;
        activeTab = name;
        for (const button of buttons) {
            const selected = button.dataset.mapTab === name;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
            el('map-panel-' + button.dataset.mapTab).hidden = !selected;
        }
        if (remember) {
            automaticChoice = false;
            try { sessionStorage.setItem('verter.map.tool', name); } catch (_) {}
        }
        window.dispatchEvent(new CustomEvent('verter:map-tool-change', {detail: {tab: name}}));
        if (focus) {
            const button = el('map-tab-' + name);
            button.focus({preventScroll: true});
            if (window.matchMedia('(max-width: 900px)').matches)
                button.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        }
        scheduleResize();
    }

    for (const button of buttons)
        button.addEventListener('click', () => show(button.dataset.mapTab));
    document.querySelector('.map-tabs').addEventListener('keydown', event => {
        if (!event.target.matches('[data-map-tab]')) return;
        const current = names.indexOf(activeTab);
        let next = current;
        if (event.key === 'ArrowRight') next = (current + 1) % names.length;
        else if (event.key === 'ArrowLeft') next = (current + names.length - 1) % names.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = names.length - 1;
        else return;
        event.preventDefault();
        show(names[next], {focus: true});
    });
    for (const button of document.querySelectorAll('[data-open-map-tab]'))
        button.addEventListener('click', () => show(button.dataset.openMapTab, {focus: true}));

    function render() {
        const state = viewer.getState ? viewer.getState() : null;
        if (!state) return;
        const mode = state.mode || 'unknown';
        const signature = [mode, state.available, !!state.displayed].join(':');
        if (signature === previousStatus) return;
        previousStatus = signature;
        const labels = {
            idle: 'Ожидание', mapping: 'Картографирование', localization: 'Локализация',
            navigation: 'Навигация', fault: 'Ошибка', unknown: 'Режим неизвестен'
        };
        el('map-mode-badge').textContent = labels[mode] || mode;
        el('map-mode-badge').dataset.mode = mode;
        const workflows = {
            idle: ['Выберите сохранённую карту для локализации. Каталог точек доступен и без запуска режима.', 'localization', 'Выбрать карту'],
            mapping: ['Идёт картографирование. Сохраните карту после остановки робота оператором.', 'save', 'К сохранению карты'],
            localization: ['Задайте начальную позу и проверьте совпадение лидара с картой.', 'localization', 'Положение робота'],
            navigation: ['Слои costmap показывают общие препятствия лидара, камеры и УЗ.', 'layers', 'Показать слои'],
            fault: ['Режим завершился с ошибкой. Подробности доступны в главном окне.', 'localization', 'Состояние карты'],
            unknown: ['Нет свежих данных о карте. Проверьте связь с роботом.', 'localization', 'Состояние карты']
        };
        const [hint, tab, label] = workflows[mode] || workflows.unknown;
        el('map-workflow-hint').textContent = hint;
        el('map-workflow-action').dataset.openMapTab = tab;
        el('map-workflow-action').textContent = label;
        el('map-setup-link').hidden = state.available || !!state.displayed;
        for (const button of buttons)
            button.dataset.relevant = String(button.dataset.mapTab === tab);
        if (automaticChoice && mode !== 'unknown') {
            show(mode === 'mapping' ? 'save' : 'localization', {remember: false});
            automaticChoice = false;
        }
        if (previousMode !== mode) {
            previousMode = mode;
            scheduleResize();
        }
    }

    show(activeTab, {remember: false});
    window.addEventListener('verter:map-state', render);
    window.addEventListener('resize', scheduleResize);
    document.querySelector('.map-diagnostics').addEventListener('toggle', scheduleResize);
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(scheduleResize);
        observer.observe(document.querySelector('.sensor-header'));
        observer.observe(document.querySelector('.toolbar'));
    }
    window.VerterMapTools = Object.freeze({snapshot: () => ({activeTab})});
    render();
    setInterval(render, 500);
    scheduleResize();
})();
