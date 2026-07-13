// ==UserScript==
// @name         Via Tab Saver / Session Exporter
// @name:es      Guardar Pestañas / Exportar Sesión
// @namespace    https://github.com/KuroViolet57/UserScriptsPersonal
// @version      1.0.0
// @description  Works around Via's lack of tab management. Auto-logs every page you open into one shared list (GM storage is shared across all tabs), so from any tab you can review every open/recent tab and export them all to a Netscape bookmarks.html file, JSON, or the clipboard.
// @description:es Solución para la falta de gestión de pestañas en Via. Registra automaticamente cada pagina que abres en una lista compartida y te permite exportarlas todas a un archivo de marcadores (bookmarks.html), JSON o al portapapeles.
// @author       KuroViolet57
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Why this exists
 * ---------------
 * A userscript cannot read the browser's open-tab list or write to bookmarks —
 * it's sandboxed to its own page. BUT GM_setValue storage is shared across every
 * tab and site, so each page this script runs on records itself into one shared
 * list. Open the manager from any tab and you see them all, then export.
 *
 * "Recently active" approximates your currently-open tabs via a heartbeat.
 * Note: tabs opened BEFORE installing won't appear until you reload/focus them
 * once so the script can run inside them.
 */

(function () {
    'use strict';

    /* ------------------------- GM compatibility ------------------------- */
    const GM = {
        getValue(k, d) {
            try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) {}
            try { const r = localStorage.getItem('__vts_' + k); return r == null ? d : JSON.parse(r); } catch (e) { return d; }
        },
        setValue(k, v) {
            try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) {}
            try { localStorage.setItem('__vts_' + k, JSON.stringify(v)); } catch (e) {}
        },
        menu(l, f) { try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(l, f); } catch (e) {} },
        clip(t) { try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(t, 'text'); return true; } } catch (e) {} return false; },
        style(c) {
            try { if (typeof GM_addStyle === 'function') { GM_addStyle(c); return; } } catch (e) {}
            const s = document.createElement('style'); s.textContent = c; (document.head || document.documentElement).appendChild(s);
        }
    };

    const STORE_KEY = 'tabs_v1';

    /* ------------------------- Settings ------------------------- */
    const DEFAULTS = {
        showFab: true,
        autoLog: true,
        heartbeat: true,
        activeMinutes: 30,   // "recently active" window
        maxEntries: 800,
        exclude: ''          // comma/newline separated URL substrings to skip
    };
    let settings = Object.assign({}, DEFAULTS, GM.getValue('settings', {}));
    function saveSettings() { GM.setValue('settings', settings); }

    /* ------------------------- Tab store (shared) ------------------------- */
    // Read fresh + merge to reduce clobbering between concurrent tabs.
    function readTabs() {
        const arr = GM.getValue(STORE_KEY, []);
        return Array.isArray(arr) ? arr : [];
    }
    function writeTabs(arr) { GM.setValue(STORE_KEY, arr); }

    function excludedUrl(url) {
        if (!/^https?:\/\//i.test(url)) return true;
        const list = settings.exclude.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        return list.some(sub => url.indexOf(sub) !== -1);
    }

    // Upsert the current page (keyed by URL), preserving other tabs' entries.
    function logCurrent(isHeartbeat) {
        const url = location.href;
        if (excludedUrl(url)) return;
        const now = Date.now();
        const arr = readTabs();
        let e = arr.find(x => x.url === url);
        if (e) {
            e.lastSeen = now;
            if (!isHeartbeat) { e.title = document.title || e.title || url; e.visits = (e.visits || 1) + 1; }
        } else {
            if (isHeartbeat) return; // don't create on heartbeat only
            e = { url, title: document.title || url, firstSeen: now, lastSeen: now, visits: 1, pinned: false };
            arr.push(e);
        }
        // cap: drop oldest non-pinned
        if (arr.length > settings.maxEntries) {
            arr.sort((a, b) => (a.pinned === b.pinned ? a.lastSeen - b.lastSeen : (a.pinned ? 1 : -1)));
            while (arr.length > settings.maxEntries) {
                const idx = arr.findIndex(x => !x.pinned);
                if (idx === -1) break;
                arr.splice(idx, 1);
            }
        }
        writeTabs(arr);
    }

    function mutateTab(url, fn) {
        const arr = readTabs();
        const e = arr.find(x => x.url === url);
        if (e) { fn(e); writeTabs(arr); }
    }
    function removeTabs(urls) {
        const set = new Set(urls);
        writeTabs(readTabs().filter(x => !set.has(x.url)));
    }

    /* ------------------------- Styles ------------------------- */
    GM.style(`
    .vts-fab{position:fixed;z-index:2147482900;left:12px;bottom:96px;width:46px;height:46px;border-radius:50%;
        background:#1e88e5;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;border:none;
        box-shadow:0 4px 14px rgba(0,0,0,.4);touch-action:none;user-select:none}
    .vts-fab .vts-count{position:absolute;top:-4px;right:-4px;background:#ff4d6d;color:#fff;font-size:11px;min-width:18px;
        height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;font-weight:700}
    .vts-ov{position:fixed;inset:0;z-index:2147482950;background:rgba(0,0,0,.55);display:flex;align-items:center;
        justify-content:center;font-family:system-ui,-apple-system,Roboto,sans-serif}
    .vts-panel{background:#1b1b22;color:#eee;border-radius:14px;width:min(96vw,600px);max-height:92vh;display:flex;
        flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6)}
    .vts-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#24242c;font-weight:600;font-size:15px}
    .vts-head .sp{flex:1}
    .vts-x{background:none;border:none;color:#bbb;font-size:20px;line-height:1;padding:4px 8px}
    .vts-tools{display:flex;gap:8px;flex-wrap:wrap;padding:10px 14px;background:#20202799;position:sticky;top:0;align-items:center}
    .vts-tools select,.vts-tools input[type=text]{background:#33333d;color:#eee;border:1px solid #444;border-radius:8px;padding:8px 9px;font-size:13px}
    .vts-tools input[type=text]{flex:1;min-width:110px}
    .vts-selbar{display:flex;gap:8px;align-items:center;padding:0 14px 8px;font-size:12px;color:#9a9aa8}
    .vts-link{color:#63b3ff;background:none;border:none;font-size:12px;padding:2px 4px}
    .vts-body{overflow:auto;padding:6px 10px 10px}
    .vts-item{display:flex;gap:10px;align-items:flex-start;padding:9px 8px;border-bottom:1px solid #2a2a32}
    .vts-item input[type=checkbox]{width:18px;height:18px;margin-top:2px;flex:0 0 auto}
    .vts-it-body{min-width:0;flex:1}
    .vts-it-title{font-size:14px;font-weight:600;word-break:break-word}
    .vts-it-url{font-size:11px;color:#8a8a95;word-break:break-all;margin-top:1px}
    .vts-it-meta{font-size:11px;color:#6f8fb0;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .vts-dot{width:7px;height:7px;border-radius:50%;background:#2ea043;display:inline-block}
    .vts-it-actions{display:flex;gap:2px;flex:0 0 auto}
    .vts-ib{background:none;border:none;font-size:16px;padding:4px 6px;color:#aaa}
    .vts-ib.pin.on{color:#ffcf4d}
    .vts-foot{display:flex;gap:8px;padding:10px 14px;background:#24242c;flex-wrap:wrap;border-top:1px solid #2a2a32}
    .vts-btn{border:none;border-radius:9px;padding:11px 12px;font-size:13px;font-weight:700;flex:1;min-width:120px}
    .vts-btn.b{background:#1e88e5;color:#fff}.vts-btn.g{background:#2ea043;color:#fff}
    .vts-btn.s{background:#3a3a46;color:#eee}.vts-btn.d{background:#5a2330;color:#ffc2ce}
    .vts-empty{color:#888;text-align:center;padding:30px 12px;line-height:1.5}
    .vts-toast{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);background:#2a2a36;color:#fff;padding:10px 16px;
        border-radius:22px;z-index:2147483000;font-size:14px;max-width:88vw;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.5)}
    .vts-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #2a2a32}
    .vts-row label{font-size:14px;flex:1}
    .vts-row .h{display:block;font-size:11px;color:#888;margin-top:2px}
    .vts-row input[type=number]{width:80px;background:#33333d;color:#eee;border:1px solid #444;border-radius:8px;padding:8px}
    .vts-row textarea{width:100%;background:#33333d;color:#eee;border:1px solid #444;border-radius:8px;padding:8px;min-height:70px;font-family:inherit}
    `);

    /* ------------------------- Toast ------------------------- */
    let toastT;
    function toast(m) {
        let t = document.querySelector('.vts-toast');
        if (!t) { t = document.createElement('div'); t.className = 'vts-toast'; document.body.appendChild(t); }
        t.textContent = m; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2600);
    }

    /* ------------------------- Helpers ------------------------- */
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function relTime(ts) {
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    }
    function isActive(e) { return (Date.now() - e.lastSeen) < settings.activeMinutes * 60000; }

    function downloadFile(filename, text, mime) {
        try {
            const blob = new Blob([text], { type: mime || 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.rel = 'noopener';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            toast('Saved: ' + filename);
        } catch (e) { toast('Download failed'); }
    }

    function toBookmarksHtml(entries) {
        const now = Math.floor(Date.now() / 1000);
        const folder = 'Via tabs ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
        let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' +
            '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
            '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
            '    <DT><H3 ADD_DATE="' + now + '" LAST_MODIFIED="' + now + '">' + esc(folder) + '</H3>\n    <DL><p>\n';
        for (const e of entries) {
            out += '        <DT><A HREF="' + esc(e.url) + '" ADD_DATE="' + Math.floor((e.firstSeen || Date.now()) / 1000) +
                '">' + esc(e.title || e.url) + '</A>\n';
        }
        out += '    </DL><p>\n</DL><p>\n';
        return out;
    }

    /* ------------------------- Manager UI ------------------------- */
    let overlay = null;
    const view = { filter: 'all', query: '' };
    const selected = new Set();

    function openManager() {
        if (overlay) { renderList(); return; }
        overlay = document.createElement('div');
        overlay.className = 'vts-ov';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeManager(); });
        overlay.innerHTML = `
            <div class="vts-panel">
                <div class="vts-head">
                    <span>📑 Saved tabs</span><span class="sp"></span>
                    <button class="vts-x" data-a="settings" title="Settings">⚙️</button>
                    <button class="vts-x" data-a="close">✕</button>
                </div>
                <div class="vts-tools">
                    <select data-f="filter">
                        <option value="all">All</option>
                        <option value="active">Recently active (~open)</option>
                        <option value="pinned">Pinned</option>
                    </select>
                    <input data-f="query" type="text" placeholder="search title / url…">
                </div>
                <div class="vts-selbar">
                    <button class="vts-link" data-a="all">Select all</button>
                    <button class="vts-link" data-a="none">Select none</button>
                    <span class="sp" style="flex:1"></span>
                    <span data-a="count"></span>
                </div>
                <div class="vts-body" id="vts-body"></div>
                <div class="vts-foot">
                    <button class="vts-btn g" data-a="bookmarks">⭐ Bookmarks.html</button>
                    <button class="vts-btn b" data-a="json">⬇ JSON</button>
                    <button class="vts-btn s" data-a="copy">📋 Copy URLs</button>
                    <button class="vts-btn d" data-a="del">🗑 Delete selected</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('[data-a="close"]').onclick = closeManager;
        overlay.querySelector('[data-a="settings"]').onclick = () => { closeManager(); openSettings(); };
        overlay.querySelector('[data-f="filter"]').addEventListener('change', e => { view.filter = e.target.value; renderList(); });
        overlay.querySelector('[data-f="query"]').addEventListener('input', e => { view.query = e.target.value; renderList(); });
        overlay.querySelector('[data-a="all"]').onclick = () => { currentEntries().forEach(e => selected.add(e.url)); renderList(); };
        overlay.querySelector('[data-a="none"]').onclick = () => { selected.clear(); renderList(); };
        overlay.querySelector('[data-a="bookmarks"]').onclick = exportBookmarks;
        overlay.querySelector('[data-a="json"]').onclick = exportJson;
        overlay.querySelector('[data-a="copy"]').onclick = copyUrls;
        overlay.querySelector('[data-a="del"]').onclick = deleteSelected;
        renderList();
    }
    function closeManager() { if (overlay) { overlay.remove(); overlay = null; } }

    function currentEntries() {
        let arr = readTabs().slice().sort((a, b) => b.lastSeen - a.lastSeen);
        if (view.filter === 'active') arr = arr.filter(isActive);
        else if (view.filter === 'pinned') arr = arr.filter(e => e.pinned);
        if (view.query) {
            const q = view.query.toLowerCase();
            arr = arr.filter(e => (e.title || '').toLowerCase().indexOf(q) !== -1 || e.url.toLowerCase().indexOf(q) !== -1);
        }
        return arr;
    }

    function renderList() {
        if (!overlay) return;
        overlay.querySelector('[data-f="filter"]').value = view.filter;
        const body = overlay.querySelector('#vts-body');
        const entries = currentEntries();
        const total = readTabs().length;
        overlay.querySelector('[data-a="count"]').textContent = selected.size + ' selected · ' + entries.length + ' shown · ' + total + ' total';

        if (!entries.length) {
            body.innerHTML = '<div class="vts-empty">' + (total
                ? 'No tabs match this filter.'
                : 'No tabs logged yet.<br>Browse a few pages (this script logs each one), then reopen.') + '</div>';
            return;
        }
        body.innerHTML = '';
        entries.forEach(e => {
            const row = document.createElement('div');
            row.className = 'vts-item';
            const active = isActive(e);
            row.innerHTML = `
                <input type="checkbox" ${selected.has(e.url) ? 'checked' : ''}>
                <div class="vts-it-body">
                    <div class="vts-it-title">${esc(e.title || e.url)}</div>
                    <div class="vts-it-url">${esc(e.url)}</div>
                    <div class="vts-it-meta">${active ? '<span class="vts-dot"></span>active' : relTime(e.lastSeen)}
                        ${e.visits > 1 ? '<span>· ' + e.visits + ' visits</span>' : ''}</div>
                </div>
                <div class="vts-it-actions">
                    <button class="vts-ib pin ${e.pinned ? 'on' : ''}" title="Pin">${e.pinned ? '★' : '☆'}</button>
                    <button class="vts-ib open" title="Open">↗</button>
                    <button class="vts-ib del" title="Remove">🗑</button>
                </div>`;
            row.querySelector('input').addEventListener('change', ev => {
                if (ev.target.checked) selected.add(e.url); else selected.delete(e.url);
                overlay.querySelector('[data-a="count"]').textContent = selected.size + ' selected · ' + entries.length + ' shown · ' + total + ' total';
            });
            row.querySelector('.pin').onclick = () => { mutateTab(e.url, x => x.pinned = !x.pinned); renderList(); };
            row.querySelector('.open').onclick = () => { window.open(e.url, '_blank'); };
            row.querySelector('.del').onclick = () => { removeTabs([e.url]); selected.delete(e.url); renderList(); updateFab(); };
            body.appendChild(row);
        });
    }

    function selectedOrShown() {
        const entries = currentEntries();
        if (selected.size) return entries.filter(e => selected.has(e.url));
        return entries; // nothing selected -> act on everything shown
    }

    function exportBookmarks() {
        const e = selectedOrShown();
        if (!e.length) { toast('Nothing to export'); return; }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
        downloadFile('via-tabs-' + stamp + '.html', toBookmarksHtml(e), 'text/html');
    }
    function exportJson() {
        const e = selectedOrShown();
        if (!e.length) { toast('Nothing to export'); return; }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
        downloadFile('via-tabs-' + stamp + '.json', JSON.stringify(e, null, 2), 'application/json');
    }
    function copyUrls() {
        const e = selectedOrShown();
        if (!e.length) { toast('Nothing to copy'); return; }
        const text = e.map(x => x.url).join('\n');
        if (GM.clip(text)) { toast(e.length + ' URLs copied'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => toast(e.length + ' URLs copied'), () => toast('Copy failed'));
        } else toast('Copy not supported');
    }
    function deleteSelected() {
        if (!selected.size) { toast('Select tabs first (checkboxes)'); return; }
        if (!confirm('Remove ' + selected.size + ' saved tab(s) from the list?')) return;
        removeTabs(Array.from(selected)); selected.clear(); renderList(); updateFab();
    }

    /* ------------------------- Settings UI ------------------------- */
    let sOverlay = null;
    function openSettings() {
        if (sOverlay) return;
        sOverlay = document.createElement('div');
        sOverlay.className = 'vts-ov';
        sOverlay.addEventListener('click', e => { if (e.target === sOverlay) closeSettings(); });
        sOverlay.innerHTML = `
            <div class="vts-panel">
                <div class="vts-head"><span>⚙️ Tab Saver settings</span><span class="sp"></span>
                    <button class="vts-x" data-a="close">✕</button></div>
                <div class="vts-body" style="padding:6px 14px 14px">
                    <div class="vts-row"><label>Auto-log pages<span class="h">Record every page you open</span></label>
                        <input type="checkbox" data-s="autoLog" ${settings.autoLog ? 'checked' : ''}></div>
                    <div class="vts-row"><label>Heartbeat<span class="h">Keep "recently active" fresh while a tab is open</span></label>
                        <input type="checkbox" data-s="heartbeat" ${settings.heartbeat ? 'checked' : ''}></div>
                    <div class="vts-row"><label>"Active" window (minutes)<span class="h">Tabs seen within this count as ~open</span></label>
                        <input type="number" min="1" max="1440" data-s="activeMinutes" value="${settings.activeMinutes}"></div>
                    <div class="vts-row"><label>Max saved entries<span class="h">Oldest non-pinned dropped past this</span></label>
                        <input type="number" min="50" max="5000" data-s="maxEntries" value="${settings.maxEntries}"></div>
                    <div class="vts-row"><label>Show corner button (FAB)</label>
                        <input type="checkbox" data-s="showFab" ${settings.showFab ? 'checked' : ''}></div>
                    <div class="vts-row" style="flex-direction:column;align-items:stretch;border:none">
                        <label>Exclude URLs containing<span class="h">One per line or comma-separated (e.g. localhost, accounts.google)</span></label>
                        <textarea data-s="exclude">${esc(settings.exclude)}</textarea></div>
                    <div class="vts-row" style="border:none">
                        <button class="vts-btn d" data-a="clear" style="flex:1">🗑 Clear ALL saved tabs</button></div>
                </div>
                <div class="vts-foot">
                    <button class="vts-btn s" data-a="cancel">Cancel</button>
                    <button class="vts-btn b" data-a="save">Save</button>
                </div>
            </div>`;
        document.body.appendChild(sOverlay);
        sOverlay.querySelector('[data-a="close"]').onclick = closeSettings;
        sOverlay.querySelector('[data-a="cancel"]').onclick = closeSettings;
        sOverlay.querySelector('[data-a="clear"]').onclick = () => {
            if (confirm('Delete the entire saved-tab list on this device?')) { writeTabs([]); selected.clear(); updateFab(); toast('Cleared'); }
        };
        sOverlay.querySelector('[data-a="save"]').onclick = () => {
            sOverlay.querySelectorAll('[data-s]').forEach(el => {
                const k = el.getAttribute('data-s');
                if (el.type === 'checkbox') settings[k] = el.checked;
                else if (el.type === 'number') settings[k] = parseInt(el.value, 10) || DEFAULTS[k];
                else settings[k] = el.value;
            });
            saveSettings(); updateFab(); closeSettings(); toast('Settings saved');
        };
    }
    function closeSettings() { if (sOverlay) { sOverlay.remove(); sOverlay = null; } }

    /* ------------------------- FAB ------------------------- */
    let fab = null;
    function updateFab() {
        if (!settings.showFab) { if (fab) { fab.remove(); fab = null; } return; }
        if (!document.body) return;
        if (!fab) {
            fab = document.createElement('button');
            fab.className = 'vts-fab';
            fab.innerHTML = '📑<span class="vts-count">0</span>';
            fab.title = 'Tap: saved tabs · Long-press: settings';
            let moved = false, longP = false, tmr = null, sx, sy, ox, oy;
            const down = (x, y) => {
                moved = false; longP = false; sx = x; sy = y;
                const r = fab.getBoundingClientRect(); ox = r.left; oy = r.top;
                clearTimeout(tmr); tmr = setTimeout(() => { if (!moved) { longP = true; openSettings(); } }, 550);
            };
            const mv = (x, y) => {
                if (Math.abs(x - sx) + Math.abs(y - sy) > 6) { moved = true; clearTimeout(tmr); }
                let nl = Math.min(Math.max(0, ox + (x - sx)), innerWidth - 46);
                let nt = Math.min(Math.max(0, oy + (y - sy)), innerHeight - 46);
                fab.style.left = nl + 'px'; fab.style.top = nt + 'px'; fab.style.bottom = 'auto';
            };
            const up = () => clearTimeout(tmr);
            fab.addEventListener('touchstart', e => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
            fab.addEventListener('touchmove', e => { const t = e.touches[0]; mv(t.clientX, t.clientY); }, { passive: true });
            fab.addEventListener('touchend', up);
            fab.addEventListener('touchcancel', up);
            fab.addEventListener('click', () => { if (!moved && !longP) openManager(); });
            document.body.appendChild(fab);
        }
        const c = fab.querySelector('.vts-count');
        const n = readTabs().length;
        c.textContent = n;
        c.style.display = n ? 'flex' : 'none';
    }

    /* ------------------------- Boot ------------------------- */
    function boot() {
        if (settings.autoLog) logCurrent(false);
        updateFab();

        // heartbeat while visible
        let hbTimer = null;
        function startHb() {
            if (!settings.heartbeat) return;
            stopHb();
            hbTimer = setInterval(() => { if (document.visibilityState === 'visible') logCurrent(true); }, 30000);
        }
        function stopHb() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
        startHb();

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') { if (settings.autoLog) logCurrent(false); updateFab(); }
            else logCurrent(true); // record final lastSeen when leaving
        });
        window.addEventListener('pageshow', () => { if (settings.autoLog) logCurrent(false); updateFab(); });
        window.addEventListener('pagehide', () => logCurrent(true));

        // SPA URL changes
        let lastUrl = location.href;
        const onUrl = () => { if (location.href !== lastUrl) { lastUrl = location.href; if (settings.autoLog) logCurrent(false); } };
        ['pushState', 'replaceState'].forEach(m => {
            const o = history[m];
            history[m] = function () { const r = o.apply(this, arguments); setTimeout(onUrl, 50); return r; };
        });
        window.addEventListener('popstate', () => setTimeout(onUrl, 50));
        // title can arrive late
        setTimeout(() => { if (settings.autoLog) logCurrent(false); }, 2500);
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);

    GM.menu('📑 Saved tabs', openManager);
    GM.menu('⚙️ Tab Saver settings', openSettings);

    try { window.VTS = { readTabs, settings, openManager, openSettings }; } catch (e) {}
})();
