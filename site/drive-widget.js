/* One shared controller: the same drive.js as the primary monitor. */
(() => {
    const host = document.getElementById('drive-widget');
    if (!host) return;
    host.className = 'drive-widget';
    host.innerHTML = `
        <section id="drive-panel" tabindex="0" role="group" aria-label="Ручное управление" aria-describedby="drive-keyboard-help">
            <div class="widget-pad">
                <button type="button" data-drive="forward" class="widget-forward" disabled aria-label="Вперёд" aria-keyshortcuts="ArrowUp">↑<span class="drive-speed">—</span></button>
                <button type="button" data-drive="left" class="widget-left" disabled aria-label="Влево" aria-keyshortcuts="ArrowLeft">←<span class="drive-speed">—</span></button>
                <button type="button" id="drive-stop" class="widget-stop" aria-label="Стоп" aria-keyshortcuts="Space">■<span>СТОП</span></button>
                <button type="button" data-drive="right" class="widget-right" disabled aria-label="Вправо" aria-keyshortcuts="ArrowRight">→<span class="drive-speed">—</span></button>
                <button type="button" data-drive="backward" class="widget-backward" disabled aria-label="Назад" aria-keyshortcuts="ArrowDown">↓<span class="drive-speed">—</span></button>
            </div>
            <div class="widget-info">
                <strong>Ручное управление</strong>
                <p id="drive-keyboard-help">Выделите панель · стрелки / пробел</p>
                <p id="drive-status" role="status">Проверка связи…</p>
                <p id="drive-target"></p>
                <p id="drive-command-result" role="status" aria-live="polite"></p>
                <p id="drive-odometry" class="widget-sr-only"></p>
            </div>
        </section>`;
    const script = document.createElement('script');
    script.src = '/static/drive.js';
    document.body.appendChild(script);
})();
