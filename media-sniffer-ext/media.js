/* ==========================================================================
 * Media Vault — popup / full-page UI
 * ========================================================================== */
'use strict';

const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

const ICON = {
    clap:     '<path d="M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="m4 11-1.5-4.5 15.2-5 1.5 4.5z"/><path d="m7.6 9 2.2-4.6M12.4 7.4l2.2-4.6"/>',
    film:     '<rect x="2" y="2" width="20" height="20" rx="2.2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
    layers:   '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    sliders:  '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    search:   '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    check:    '<path d="M20 6 9 17l-5-5"/>',
    x:        '<path d="M18 6 6 18M6 6l12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    copy:     '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash:    '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    play:     '<path d="M8 5v14l11-7z"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    refresh:  '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    save:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    monitor:  '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'
};
function svg(name, size) {
    const s = size || 16;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
}
function paintIcons(root) {
    (root || document).querySelectorAll('[data-ico]').forEach(n => {
        const name = n.dataset.ico;
        n.removeAttribute('data-ico');
        const slot = n.querySelector('.ni');
        if (slot) slot.innerHTML = svg(name, 18);
        else if (n.classList.contains('btn') || n.classList.contains('ab')) n.insertAdjacentHTML('afterbegin', svg(name, 14));
        else n.innerHTML = svg(name, n.classList.contains('logo') ? 18 : 16);
    });
}

function send(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, x => { void chrome.runtime.lastError; r(x || {}); })); }
function get(key, def) { return new Promise(r => chrome.storage.local.get({ [key]: def }, o => r(o[key]))); }
function set(key, val) { return new Promise(r => chrome.storage.local.set({ [key]: val }, () => r())); }

let state = {
    section: 'tab',
    curTabId: null,
    items: [],
    selected: new Set(),
    filter: { query: '', type: 'all', ext: 'all', minSize: 0 }
};

let toastT;
function toast(m) {
    const t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
function human(n) {
    if (n == null || isNaN(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < 3) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}
function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
}
function hue(str) {
    let n = 0; for (let i = 0; i < (str || '').length; i++) n = (n * 31 + str.charCodeAt(i)) >>> 0;
    return n % 360;
}

function matches(it) {
    const f = state.filter;
    if (f.type !== 'all' && it.kind !== f.type) return false;
    if (f.ext !== 'all' && it.ext !== f.ext) return false;
    if (f.minSize && !((it.size || it.segBytes || 0) >= f.minSize)) return false;
    if (f.query) {
        const q = f.query.toLowerCase();
        if (!(it.name || '').toLowerCase().includes(q) && !(it.url || '').toLowerCase().includes(q)) return false;
    }
    return true;
}

/* ------------------------------ data ------------------------------ */
async function loadItems() {
    if (state.section === 'tab') {
        const r = await send({ type: 'getMedia', tabId: state.curTabId });
        state.items = (r.ok ? r.items : []).map(x => Object.assign({ tabId: state.curTabId }, x));
    } else {
        const r = await send({ type: 'getMedia', tabId: null });
        state.items = r.ok ? r.items : [];
    }
    state.items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* ------------------------------ render ------------------------------ */
async function render() {
    const s = state.section;
    document.body.dataset.sec = s;
    document.querySelectorAll('.sec').forEach(x => x.classList.add('hidden'));
    $('#sec-' + s).classList.remove('hidden');
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.sec === s));
    $('#filters').classList.toggle('hidden', s === 'settings');

    if (s === 'settings') { await renderSettings(); renderActions(); return; }

    await loadItems();
    refreshExtOptions();

    const box = $('#sec-' + s);
    box.innerHTML = '';
    const shown = state.items.filter(matches);

    // counts
    const rTab = await send({ type: 'getMedia', tabId: state.curTabId });
    $('#c-tab').textContent = (rTab.ok && rTab.items.length) ? rTab.items.length : '';
    const rAll = await send({ type: 'getMedia', tabId: null });
    $('#c-all').textContent = (rAll.ok && rAll.items.length) ? rAll.items.length : '';

    if (!shown.length) {
        const filtered = state.items.length > 0;
        box.appendChild(emptyState(filtered ? 'search' : 'film', filtered
            ? 'Nothing matches the filter (' + state.items.length + ' hidden).'
            : 'No media detected ' + (s === 'tab' ? 'on this tab' : 'anywhere') + ' yet.<br>Open a page and <b>play the video</b> for a moment.'));
        renderActions();
        return;
    }

    let lastTab = null;
    shown.forEach(it => {
        if (s === 'all' && it.tabId !== lastTab) {
            lastTab = it.tabId;
            const th = el('div', 'tabhead');
            th.innerHTML = svg('monitor', 13) + '<span class="tt"></span><span class="rule"></span>';
            th.querySelector('.tt').textContent = 'Tab ' + it.tabId;
            box.appendChild(th);
        }
        box.appendChild(mediaRow(it));
    });
    renderActions();
}

function emptyState(icon, html) {
    const d = el('div', 'empty');
    d.innerHTML = `<div class="eico">${svg(icon, 26)}</div>` + html;
    return d;
}

function refreshExtOptions() {
    const sel = $('#f-ext');
    const cur = state.filter.ext;
    const exts = Array.from(new Set(state.items.map(i => i.ext).filter(Boolean)));
    if (cur !== 'all' && !exts.includes(cur)) exts.push(cur);
    exts.sort();
    sel.innerHTML = '<option value="all">All formats</option>' +
        exts.map(e => `<option value="${e}">${e.toUpperCase()}</option>`).join('');
    sel.value = cur;
}

function keyOf(it) { return it.tabId + '|' + it.url; }

function mediaRow(it) {
    const row = el('div', 'row' + (state.selected.has(keyOf(it)) ? ' sel' : ''));

    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.selected.has(keyOf(it));
    cb.onchange = () => {
        if (cb.checked) state.selected.add(keyOf(it)); else state.selected.delete(keyOf(it));
        row.classList.toggle('sel', cb.checked);
        renderActions();
    };

    const av = el('div', 'av');
    const h = hue(it.host || it.url);
    av.style.background = `linear-gradient(135deg,hsl(${h} 62% 46%),hsl(${(h + 28) % 360} 62% 36%))`;
    av.innerHTML = svg(it.kind === 'audio' ? 'play' : 'film', 14);

    const body = el('div', 'body');
    const t = el('div', 't'); t.textContent = it.name || it.url;
    const meta = el('div', 'meta');
    const bits = [`<span class="badge ${it.blob ? 'blob' : it.kind}">${it.ext || it.kind}</span>`];
    if (it.kind === 'stream') bits.push('<span class="badge stream">stream</span>');
    if (it.segments > 2) bits.push(`<span class="badge seg">${it.segments} seg</span>`);
    const sz = it.size || it.segBytes;
    if (sz) bits.push(`<span class="size">${human(sz)}${it.segBytes && !it.size ? '+' : ''}</span>`);
    if (it.host) bits.push(`<span>${it.host}</span>`);
    if (it.ts) bits.push(`<span>${relTime(it.ts)}</span>`);
    meta.innerHTML = bits.join('');
    body.appendChild(t); body.appendChild(meta);

    const acts = el('div', 'acts');
    if (!it.blob) {
        acts.appendChild(ab('Download', 'download', 'g', () => downloadOne(it)));
        acts.appendChild(ab('Copy', 'copy', '', () => copyText(it.url, 'Link copied')));
        acts.appendChild(ab('Open', 'external', '', () => chrome.tabs.create({ url: it.url })));
    } else {
        acts.appendChild(ab('Copy', 'copy', '', () => copyText(it.url, 'blob: URL copied (only works on its page)')));
    }
    if (state.section === 'tab') {
        acts.appendChild(ab('On page', 'play', 'p', async () => {
            try {
                await chrome.tabs.sendMessage(state.curTabId, { type: 'openOverlay' });
                window.close();
            } catch (e) { toast('Open the page first'); }
        }));
    }
    body.appendChild(acts);

    row.appendChild(cb); row.appendChild(av); row.appendChild(body);
    return row;
}

function ab(label, icon, cls, fn) {
    const b = el('button', 'ab' + (cls ? ' ' + cls : ''));
    b.innerHTML = svg(icon, 12) + '<span></span>';
    b.querySelector('span').textContent = label;
    b.onclick = fn;
    return b;
}

/* ------------------------------ actions ------------------------------ */
async function downloadOne(it) {
    const r = await send({ type: 'download', url: it.url, filename: it.name });
    if (r.ok) toast('Download started');
    else {
        // Fallback: open the URL in a tab; the browser's downloader may catch it.
        toast(r.error ? 'Downloads API: ' + r.error : 'Falling back to a tab');
        chrome.tabs.create({ url: it.url, active: false });
    }
}
function copyText(text, msg) {
    navigator.clipboard.writeText(text).then(() => toast(msg || 'Copied'), () => toast('Copy failed'));
}
function selectedItems() {
    return state.items.filter(it => state.selected.has(keyOf(it)));
}
function renderActions() {
    const n = state.selected.size;
    $('#actions').classList.toggle('hidden', n === 0 || state.section === 'settings');
    $('#selcount').textContent = n;
}

document.querySelectorAll('#actions [data-act]').forEach(b => {
    b.onclick = async () => {
        const items = selectedItems().filter(i => !i.blob);
        if (!items.length) return;
        const act = b.dataset.act;
        if (act === 'download') {
            for (const it of items) { await downloadOne(it); await new Promise(r => setTimeout(r, 250)); }
        } else if (act === 'copy') {
            copyText(items.map(i => i.url).join('\n'), items.length + ' URLs copied');
        } else if (act === 'remove') {
            // remove from view only (per-tab store keeps history until reload)
            toast('Cleared from list');
            const keys = new Set(items.map(keyOf));
            state.items = state.items.filter(i => !keys.has(keyOf(i)));
        }
        state.selected.clear();
        render();
    };
});

/* ------------------------------ settings ------------------------------ */
async function renderSettings() {
    const r = await send({ type: 'getSettings' });
    const s = r.settings || {};
    const box = $('#sec-settings');
    box.innerHTML = `
      <div class="tabhead">${svg('film', 13)}<span class="tt">ON-VIDEO BUTTON</span><span class="rule"></span></div>
      <div class="field inline"><label>Show over videos</label>
        <input type="checkbox" id="s-btn" ${s.buttonOn ? 'checked' : ''}></div>
      <div class="field inline"><label>Size (px)</label>
        <input type="number" id="s-size" min="28" max="80" value="${s.buttonSize}"></div>
      <div class="field inline"><label>Corner</label>
        <select id="s-corner">
          <option value="tl">Top-left</option><option value="tr">Top-right</option>
          <option value="bl">Bottom-left</option><option value="br">Bottom-right</option>
        </select></div>
      <div class="field inline"><label>Min video size (px)<span class="h">Skip tiny thumbnail videos</span></label>
        <input type="number" id="s-minpx" min="0" max="1000" value="${s.minVideoPx}"></div>

      <div class="tabhead" style="margin-top:18px">${svg('search', 13)}<span class="tt">DETECTION</span><span class="rule"></span></div>
      <div class="field inline"><label>Ignore media smaller than (MB)<span class="h">Hides smaller files everywhere (streams/blob exempt); 0 keeps all</span></label>
        <input type="number" id="s-minb" min="0" step="0.5" value="${((s.minSniffBytes || 0) / 1048576).toFixed(1).replace(/\.0$/, '')}"></div>
      <div class="field inline"><label>Fold stream segments<span class="h">Collapse repeated .ts/.m4s URLs into one entry</span></label>
        <input type="checkbox" id="s-collapse" ${s.collapseSegments ? 'checked' : ''}></div>
      <div class="field inline"><label>Max entries per tab</label>
        <input type="number" id="s-max" min="50" max="2000" value="${s.maxPerTab}"></div>

      <div class="tabhead" style="margin-top:18px">${svg('external', 13)}<span class="tt">EXTERNAL PLAYER</span><span class="rule"></span></div>
      <div class="field"><label>Player package<span class="h">Blank = system chooser. e.g. org.videolan.vlc, com.mxtech.videoplayer.ad</span></label>
        <input type="text" id="s-player" value="${s.playerPackage || ''}" placeholder="system chooser"></div>

      <div class="tabhead" style="margin-top:18px">${svg('play', 13)}<span class="tt">QUICK ACCESS</span><span class="rule"></span></div>
      <div class="field inline"><label>Open gesture<span class="h">Avoid gestures your phone grabs (3-finger-down is often screenshot)</span></label>
        <select id="s-gesture">
          <option value="off">Off</option>
          <option value="tap3">3-finger tap</option>
          <option value="tap4">4-finger tap</option>
          <option value="swipe3up">3-finger swipe up</option>
          <option value="swipe3down">3-finger swipe down</option>
        </select></div>
      <div class="field inline"><label>Gesture opens</label>
        <select id="s-gtarget">
          <option value="sheet">Bottom sheet (on page)</option>
          <option value="panel">Media panel (on page)</option>
          <option value="popup">Native browser sheet (if supported)</option>
          <option value="tab">Full-page manager (tab)</option>
        </select></div>
      <div class="field inline"><label>Toolbar popup size (px)<span class="h">Width × height of the icon popup. 0 = automatic; applies from the next open.</span></label>
        <input type="number" id="s-pw" min="0" max="800" step="10" value="${s.popupW || 0}" style="width:70px">
        <input type="number" id="s-ph" min="0" max="900" step="10" value="${s.popupH || 0}" style="width:70px"></div>

      <div class="field" style="margin-top:18px"><button class="btn p" id="s-save" data-ico="save" style="width:100%">Save settings</button></div>
      <div class="field"><button class="btn d" id="s-clear" data-ico="trash" style="width:100%">Clear all detected media</button></div>`;
    paintIcons(box);
    $('#s-corner').value = s.buttonCorner || 'tr';
    $('#s-gesture').value = s.gesture || 'tap3';
    $('#s-gtarget').value = s.gestureTarget || 'sheet';
    $('#s-save').onclick = async () => {
        await send({ type: 'setSettings', settings: {
            buttonOn: $('#s-btn').checked,
            gesture: $('#s-gesture').value,
            gestureTarget: $('#s-gtarget').value,
            popupW: Math.max(0, Math.min(800, +$('#s-pw').value || 0)),
            popupH: Math.max(0, Math.min(900, +$('#s-ph').value || 0)),
            buttonSize: Math.max(28, Math.min(80, +$('#s-size').value || 44)),
            buttonCorner: $('#s-corner').value,
            minVideoPx: Math.max(0, Math.min(1000, +$('#s-minpx').value || 120)),
            playerPackage: $('#s-player').value.trim(),
            collapseSegments: $('#s-collapse').checked,
            minSniffBytes: Math.round(Math.max(0, +$('#s-minb').value || 0) * 1048576),
            maxPerTab: Math.max(50, Math.min(2000, +$('#s-max').value || 300))
        } });
        try {
            const pw = Math.max(0, Math.min(800, +$('#s-pw').value || 0));
            const ph = Math.max(0, Math.min(900, +$('#s-ph').value || 0));
            localStorage.setItem('popupW', pw); localStorage.setItem('popupH', ph);
            if (window.__isPopup) applyPopupSizeStyle(pw, ph);
        } catch (e) {}
        toast('Settings saved');
    };
    $('#s-clear').onclick = async () => {
        if (!confirm('Clear all detected media?')) return;
        await send({ type: 'clear', tabId: null });
        toast('Cleared'); render();
    };
}

/* ------------------------------ wiring ------------------------------ */
document.querySelectorAll('#nav button').forEach(b => {
    b.onclick = () => { state.section = b.dataset.sec; state.selected.clear(); render(); };
});
$('#search').addEventListener('input', e => { state.filter.query = e.target.value.trim(); saveFilter(); render(); });
$('#f-type').addEventListener('change', e => { state.filter.type = e.target.value; saveFilter(); render(); });
$('#f-ext').addEventListener('change', e => { state.filter.ext = e.target.value; saveFilter(); render(); });
$('#f-size').addEventListener('change', e => { state.filter.minSize = +e.target.value; saveFilter(); render(); });
function saveFilter() { set('filter', state.filter); }

$('#refresh').onclick = () => render();
$('#expand').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('media.html') }); window.close(); };

function applyPopupSizeStyle(w, h) {
    let st = document.getElementById('popup-size-style');
    if (!w && !h) { if (st) st.remove(); return; }
    if (!st) { st = document.createElement('style'); st.id = 'popup-size-style'; document.head.appendChild(st); }
    st.textContent = 'html,body{' + (w ? 'width:' + w + 'px !important;' : '') +
        (h ? 'height:' + h + 'px !important;min-height:0 !important;' : '') + '}';
}

(async () => {
    // popup-size.js applied the saved size synchronously (popups are measured
    // once, at first layout). Clean up per context: full-page goes fluid, the
    // popup refreshes the localStorage mirror for the next open.
    if (window.self === window.top) {
        try {
            const cur = await new Promise(r => chrome.tabs.getCurrent(t => { void chrome.runtime.lastError; r(t); }));
            if (cur) applyPopupSizeStyle(0, 0);
            else {
                window.__isPopup = true;
                const r = await send({ type: 'getSettings' });
                const sp = (r.ok && r.settings) || {};
                try { localStorage.setItem('popupW', sp.popupW || 0); localStorage.setItem('popupH', sp.popupH || 0); } catch (e) {}
                applyPopupSizeStyle(sp.popupW || 0, sp.popupH || 0);
            }
        } catch (e) {}
    }
    state.filter = Object.assign(state.filter, await get('filter', {}));
    $('#search').value = state.filter.query || '';
    $('#f-type').value = state.filter.type || 'all';
    $('#f-size').value = String(state.filter.minSize || 0);
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const self = chrome.runtime.getURL('');
        if (tabs[0] && !(tabs[0].url || '').startsWith(self)) state.curTabId = tabs[0].id;
    } catch (e) {}
    if (state.curTabId == null) state.section = 'all';   // full-page mode
    paintIcons();
    render();
})();
