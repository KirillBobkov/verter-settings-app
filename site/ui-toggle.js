/* Переключатель «Новый интерфейс» для классических страниц.
   Флаг verter.ui.next: '1' (по умолчанию) — новый интерфейс index.html,
   '0' — классические страницы. Сами страницы не изменяются. */
(function () {
    'use strict';
    var FLAG = 'verter.ui.next';
    var next = null;
    try { next = localStorage.getItem(FLAG); } catch (e) { /* приватный режим */ }
    if (next === null) next = '1';

    function banner() {
        var bar = document.createElement('div');
        bar.style.cssText = 'position:sticky;top:0;z-index:9998;display:flex;gap:10px;align-items:center;flex-wrap:wrap;' +
            'padding:8px 14px;background:#0d0d0d;border-bottom:1px solid #2d2d2d;color:#9e9e9e;font:13px system-ui,sans-serif';
        var note = document.createElement('span');
        note.textContent = next === '1'
            ? 'Доступен новый интерфейс (включён по умолчанию).'
            : 'Включён классический интерфейс.';
        var btn = document.createElement('a');
        btn.href = '/';
        btn.textContent = 'Новый интерфейс';
        btn.style.cssText = 'color:#000;background:#c8ed00;border-radius:8px;padding:5px 12px;text-decoration:none;font-weight:500';
        btn.addEventListener('click', () => {
            // возврат в новый интерфейс: флаг снова «включён по умолчанию»
            try { localStorage.setItem(FLAG, '1'); } catch (e) { /* приватный режим */ }
        });
        bar.appendChild(note);
        bar.appendChild(btn);
        document.body.insertBefore(bar, document.body.firstChild);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
    else banner();
})();
