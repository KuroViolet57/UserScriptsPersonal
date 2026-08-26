/* ==========================================================================
 * Tab Vault — manager UI (used both as the toolbar popup and a full page)
 * ========================================================================== */
'use strict';

const K = {
    CLOSED_WINDOWS: 'closedWindows', CLOSED_TABS: 'closedTabs',
    SESSIONS: 'sessions', SAVED_GROUPS: 'savedGroups',
    SETTINGS: 'settings', OPEN_JOB: 'openJob'
};
const DEFAULT_SETTINGS = {
    batchSize: 10, batchDelaySec: 3, captureClosed: true,
    maxClosedWindows: 50, maxClosedTabs: 300, gesture: 'swipe3up', gestureTarget: 'sheet'
};
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HAS_GROUPS = !!(chrome.tabGroups && chrome.tabs.group);
// null = not probed yet, true/false once a real call has been attempted.
let groupsApiWorks = null;

const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

/* ------------------------------- icons -------------------------------
 * Stroke icons drawn at 24×24 and scaled; they inherit `currentColor`, so a
 * button's colour carries into its glyph. */
const ICON = {
    vault:      '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3.2"/><path d="M12 5.2v1.6M12 17.2v1.6M18.8 12h-1.6M6.8 12H5.2"/>',
    layers:     '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    folder:     '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
    history:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bookmark:   '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    sliders:    '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    search:     '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    checkAll:   '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    square:     '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    check:      '<path d="M20 6 9 17l-5-5"/>',
    x:          '<path d="M18 6 6 18M6 6l12 12"/>',
    save:       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    star:       '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    copy:       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    window:     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
    maximize:   '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    refresh:    '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    restore:    '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',
    trash:      '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit:       '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    code:       '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    loader:     '<path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9"/>',
    pin:        '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
    alert:      '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info:       '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
    grid:       '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    zap:        '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'
};
function svg(name, size) {
    const s = size || 16;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
}
/* Fill every [data-ico] placeholder in a subtree. */
function paintIcons(root) {
    (root || document).querySelectorAll('[data-ico]').forEach(n => {
        const name = n.dataset.ico;
        n.removeAttribute('data-ico');
        const slot = n.querySelector('.ni');
        if (slot) slot.innerHTML = svg(name, 18);                              // nav
        else if (n.classList.contains('btn')) n.insertAdjacentHTML('afterbegin', svg(name, 14));
        else n.innerHTML = svg(name, n.classList.contains('logo') ? 18 : 16);
    });
}

/* Stable colour per domain, so each site keeps its own hue. */
function domainHue(u) {
    const h = host(u) || '';
    let n = 0;
    for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
    return n % 360;
}
/* Favicon when there is one, otherwise a coloured letter tile. */
function avatarFor(t) {
    const a = el('div', 'av');
    const hue = domainHue(t.url);
    a.style.background = `linear-gradient(135deg,hsl(${hue} 62% 46%),hsl(${(hue + 28) % 360} 62% 36%))`;
    const letter = (host(t.url) || '?').replace(/^[^a-z0-9]*/i, '').charAt(0) || '?';
    a.textContent = letter;
    if (t.favIconUrl && /^https?:/.test(t.favIconUrl)) {
        const img = el('img');
        img.src = t.favIconUrl;
        img.onload = () => { a.textContent = ''; a.style.background = 'var(--bg3)'; a.appendChild(img); };
        img.onerror = () => {};
    }
    return a;
}

function get(key, def) { return new Promise(r => chrome.storage.local.get({ [key]: def }, o => r(o[key]))); }
function set(key, val) { return new Promise(r => chrome.storage.local.set({ [key]: val }, () => r())); }
async function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, await get(K.SETTINGS, {})); }
function send(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, resp => { void chrome.runtime.lastError; r(resp || {}); })); }

let state = { section: 'open', query: '', windows: [], groups: [], selected: new Set() };

/* ------------------------------ helpers ------------------------------ */
let toastT;
function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24); return d + 'd ago';
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
function matches(t) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q);
}
function isRestorable(u) { return /^https?:\/\//i.test(u || ''); }

function confirmBox(msg) { return Promise.resolve(window.confirm(msg)); }

/* Simple prompt modal (window.prompt is unavailable in extension popups). */
function askText(title, initial, extra) {
    return new Promise(resolve => {
        const m = el('div', 'modal');
        m.innerHTML = `<div class="mp"><h3></h3><div class="mb">
            <input type="text" id="_ai" >
            <div id="_ax"></div>
            <div style="display:flex;gap:8px;margin-top:6px">
              <button class="btn" id="_ac" style="flex:1">Cancel</button>
              <button class="btn p" id="_ao" style="flex:1">OK</button>
            </div></div></div>`;
        m.querySelector('h3').textContent = title;
        const input = m.querySelector('#_ai');
        input.value = initial || '';
        let picked = extra && extra.colors ? (extra.color || 'blue') : null;
        if (extra && extra.colors) {
            const sw = el('div', 'swatches');
            GROUP_COLORS.forEach(c => {
                const b = el('button', 'swatch g-' + c + (c === picked ? ' on' : ''));
                b.onclick = () => { picked = c; sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
                sw.appendChild(b);
            });
            m.querySelector('#_ax').appendChild(sw);
        }
        const done = v => { m.remove(); resolve(v); };
        m.querySelector('#_ac').onclick = () => done(null);
        m.querySelector('#_ao').onclick = () => done({ text: input.value.trim(), color: picked });
        m.addEventListener('click', e => { if (e.target === m) done(null); });
        document.body.appendChild(m);
        setTimeout(() => input.focus(), 50);
    });
}

/* --------------------------- data loading --------------------------- */
const SELF_URL = (() => { try { return chrome.runtime.getURL(''); } catch (e) { return ''; } })();

async function loadLive() {
    // Build windows from tabs.query, NOT windows.getAll({populate:true}): some
    // Android builds hand every window the same global tab list, which shows up
    // as N identical windows. A tab reports exactly one windowId, so grouping by
    // that can't duplicate.
    const allTabs = await chrome.tabs.query({});
    const cur = await chrome.windows.getCurrent().catch(() => null);
    let winMeta = [];
    try { winMeta = await chrome.windows.getAll({}); } catch (e) {}

    const byWin = new Map();
    const seenTabs = new Set();
    for (const t of allTabs) {
        if (t.id == null || seenTabs.has(t.id)) continue;
        seenTabs.add(t.id);
        if (SELF_URL && (t.url || '').startsWith(SELF_URL)) continue;   // hide our own page
        const wid = (t.windowId == null ? -1 : t.windowId);
        if (!byWin.has(wid)) byWin.set(wid, []);
        byWin.get(wid).push({
            id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '',
            favIconUrl: t.favIconUrl || '', pinned: !!t.pinned,
            groupId: (t.groupId == null ? -1 : t.groupId), windowId: wid, active: !!t.active
        });
    }

    state.windows = Array.from(byWin.entries()).map(([id, tabs]) => {
        const meta = winMeta.find(w => w.id === id) || {};
        return { id, tabs, focused: !!meta.focused, type: meta.type || '', current: !!(cur && id === cur.id) };
    });

    state.groups = [];
    state.groupSource = 'none';
    state.groupError = '';

    // The tabGroups object can exist while every call throws ("Not implemented
    // on Android"), so availability means "a call actually succeeded", not
    // "the function is defined". Probed once and cached.
    if (HAS_GROUPS && groupsApiWorks !== false) {
        try {
            const g = await chrome.tabGroups.query({});
            groupsApiWorks = true;
            if (g && g.length) { state.groups = g; state.groupSource = 'api'; }
        } catch (e) {
            groupsApiWorks = false;
            state.groupError = String((e && e.message) || e);
        }
    }
    state.groupsUsable = (groupsApiWorks === true);

    // Fallback: some builds group tabs in their own UI without reporting them,
    // yet the tabs still carry a usable groupId. Reconstruct groups from that.
    //
    // Two guards against sentinel values masquerading as a group: real group ids
    // are positive (Chrome uses -1 for "none", some Android builds use 0), and a
    // "group" that contains every single tab is a sentinel, not a group.
    if (!state.groups.length) {
        const counts = new Map();
        let total = 0;
        for (const w of state.windows) {
            for (const t of w.tabs) {
                total++;
                if (typeof t.groupId === 'number' && t.groupId > 0) {
                    counts.set(t.groupId, (counts.get(t.groupId) || 0) + 1);
                }
            }
        }
        const real = Array.from(counts.entries())
            .filter(([, n]) => !(counts.size === 1 && n === total));
        if (real.length) {
            state.groups = real.map(([id]) => {
                const owner = state.windows.find(w => w.tabs.some(t => t.groupId === id));
                return { id, windowId: owner ? owner.id : -1, title: '', color: 'grey', synthesized: true };
            });
            state.groupSource = 'tabs';
        }
    }
}

function groupOf(id) { return state.groups.find(g => g.id === id); }

/* ------------------------------ render ------------------------------ */
async function render() {
    const s = state.section;
    document.body.dataset.sec = s;
    document.querySelectorAll('.sec').forEach(x => x.classList.add('hidden'));
    $('#sec-' + s).classList.remove('hidden');
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.sec === s));
    $('#searchbar').classList.toggle('hidden', s === 'settings');

    if (s === 'open') { await loadLive(); renderOpen(); }
    else if (s === 'groups') { await loadLive(); await renderGroups(); }
    else if (s === 'closed') await renderClosed();
    else if (s === 'saved') await renderSaved();
    else await renderSettings();

    await renderCounts();
    renderActions();
}

async function renderCounts() {
    const tabCount = state.windows.reduce((n, w) => n + w.tabs.length, 0);
    $('#c-open').textContent = tabCount || '';
    $('#c-groups').textContent = (state.groups.length + (await get(K.SAVED_GROUPS, [])).length) || '';
    const cw = await get(K.CLOSED_WINDOWS, []), ct = await get(K.CLOSED_TABS, []);
    $('#c-closed').textContent = (cw.length + ct.length) || '';
    $('#c-saved').textContent = (await get(K.SESSIONS, [])).length || '';
}

function tabRow(t) {
    const row = el('div', 'row' + (state.selected.has(t.id) ? ' sel' : ''));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.selected.has(t.id);
    cb.onchange = () => {
        if (cb.checked) state.selected.add(t.id); else state.selected.delete(t.id);
        row.classList.toggle('sel', cb.checked); renderActions();
    };
    const body = el('div', 'body');
    const title = el('div', 't'); title.textContent = t.title || host(t.url);
    const url = el('div', 'u'); url.textContent = host(t.url);
    body.appendChild(title); body.appendChild(url);

    const meta = el('div', 'meta');
    const g = groupOf(t.groupId);
    if (g) {
        const b = el('span', 'gbadge g-' + (g.color || 'grey'));
        b.textContent = g.title || (g.synthesized ? 'group ' + g.id : 'group');
        meta.appendChild(b);
    }
    if (t.pinned) {
        const p = el('span', 'pill'); p.innerHTML = svg('pin', 10) + ' pinned';
        p.style.cssText = 'display:inline-flex;align-items:center;gap:3px'; meta.appendChild(p);
    }
    if (t.active) { const a = el('span', 'live'); a.textContent = '● active'; meta.appendChild(a); }
    if (meta.children.length) body.appendChild(meta);

    body.onclick = () => chrome.tabs.update(t.id, { active: true }).then(() => chrome.windows.update(t.windowId, { focused: true }).catch(() => {}));

    const x = el('button', 'rb'); x.innerHTML = svg('x', 16); x.title = 'Close tab';
    x.onclick = async e => { e.stopPropagation(); await chrome.tabs.remove(t.id); state.selected.delete(t.id); render(); };

    row.appendChild(cb); row.appendChild(avatarFor(t)); row.appendChild(body); row.appendChild(x);
    return row;
}

function renderOpen() {
    const box = $('#sec-open'); box.innerHTML = '';
    let shown = 0;
    let wn = 0;
    for (const w of state.windows) {
        wn++;
        const tabs = w.tabs.filter(matches);
        if (!tabs.length) continue;
        shown += tabs.length;
        const g = el('div', 'wingroup');
        const head = el('div', 'winhead');
        head.innerHTML = `<span class="wi">${svg('window', 15)}</span><span class="wt"></span>` +
            (w.current ? '<span class="cur">current</span>' : '');
        const label = state.windows.length > 1 ? `Window ${wn}` : 'Window';
        head.querySelector('.wt').textContent = `${label} · ${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}`;

        const selBtn = el('button', 'link'); selBtn.textContent = 'select all';
        selBtn.onclick = () => { tabs.forEach(t => state.selected.add(t.id)); renderOpen(); renderActions(); };
        head.appendChild(selBtn);

        const saveBtn = el('button', 'link'); saveBtn.textContent = 'save';
        saveBtn.title = 'Save this window as a session';
        saveBtn.onclick = () => saveSession(w.tabs.filter(t => isRestorable(t.url)), 'Window');
        head.appendChild(saveBtn);

        g.appendChild(head);
        tabs.forEach(t => g.appendChild(tabRow(t)));
        box.appendChild(g);
    }
    if (!shown) box.appendChild(emptyState(state.query ? 'search' : 'layers',
        state.query ? 'No tabs match <b>' + esc(state.query) + '</b>.' : 'No open tabs found.'));
}

async function renderGroups() {
    const box = $('#sec-groups'); box.innerHTML = '';

    const live = state.groups || [];
    box.appendChild(sechead('grid', 'Browser groups'));

    if (state.groupSource === 'tabs') {
        const n = el('div', 'card note');
        n.innerHTML = '<div class="cm">ℹ️ Your browser groups tabs in its own UI without reporting the groups to extensions, so these were <b>reconstructed from the tabs themselves</b>. Names and colours aren\'t available — everything else works.</div>';
        box.appendChild(n);
    } else if (!live.length) {
        const n = el('div', 'card note');
        const why = state.groupError ? ' (<code>' + esc(state.groupError) + '</code>)' : '';
        n.innerHTML = !state.groupsUsable
            ? '<div class="cm">⚠️ <b>Your browser can\'t share tab groups with extensions</b>' + why +
              '. The groups you make in the browser stay invisible here, and nothing an extension does can change that.' +
              '<br><br>Use <b>saved groups</b> below instead — Tab Vault\'s own groups. They work on every browser, survive a restart, and can be reopened as a set.</div>'
            : '<div class="cm">No tab groups yet. Select tabs in “Open” and tap 🗂 Group.</div>';
        box.appendChild(n);
    }

    for (const g of live) {
        const tabs = state.windows.flatMap(w => w.tabs).filter(t => t.groupId === g.id);
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        const badge = el('span', 'gbadge g-' + (g.color || 'grey'));
        badge.textContent = g.title || (g.synthesized ? 'Group #' + g.id : 'untitled');
        const ct = el('span', 'cnt'); ct.textContent = `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
        ch.appendChild(badge); ch.appendChild(el('span', 'ct')); ch.appendChild(ct); c.appendChild(ch);

        const cu = el('div', 'cu');
        cu.textContent = tabs.slice(0, 4).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);

        const cb = el('div', 'cb');
        if (!g.synthesized) {
            cb.appendChild(mk('Rename', async () => {
                const r = await askText('Rename group', g.title || '', { colors: true, color: g.color });
                if (!r) return;
                try { await chrome.tabGroups.update(g.id, { title: r.text, color: r.color }); }
                catch (e) { toast('Rename failed: ' + (e.message || e)); }
                render();
            }, '', 'edit'));
        }
        cb.appendChild(mk('Save', () => saveGroup(g, tabs), 'p', 'save'));
        cb.appendChild(mk('Select', () => { tabs.forEach(t => state.selected.add(t.id)); state.section = 'open'; render(); }, '', 'edit'));
        cb.appendChild(mk('Ungroup', async () => {
            try { await chrome.tabs.ungroup(tabs.map(t => t.id)); }
            catch (e) { toast('Ungroup failed: ' + (e.message || e)); }
            render();
        }, '', 'folder'));
        cb.appendChild(mk('Close', async () => {
            if (!await confirmBox(`Close ${tabs.length} tab(s) in this group?`)) return;
            await chrome.tabs.remove(tabs.map(t => t.id)); render();
        }, 'd', 'x'));
        c.appendChild(cb);
        box.appendChild(c);
    }

    const saved = await get(K.SAVED_GROUPS, []);
    box.appendChild(sechead('bookmark', 'Saved groups', true));
    if (!saved.length) {
        box.appendChild(emptyState('folderPlus',
            'No saved groups yet.<br>Select tabs in <b>Open</b> and tap <b>Group</b>.'));
    }
    saved.forEach(sg => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        const badge = el('span', 'gbadge g-' + (sg.color || 'grey'));
        badge.textContent = sg.name || 'group';
        const ct = el('span', 'cnt'); ct.textContent = `${sg.tabs.length} tab${sg.tabs.length === 1 ? '' : 's'}`;
        ch.appendChild(badge); ch.appendChild(el('span', 'ct')); ch.appendChild(ct); c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = 'saved ' + relTime(sg.savedAt); c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = sg.tabs.slice(0, 4).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('Restore', () => restoreGroup(sg), 'v', 'restore'));
        cb.appendChild(mk('New window', () => openUrls(sg.tabs.map(t => t.url), 'window'), '', 'window'));
        cb.appendChild(mk('Delete', async () => {
            const list = (await get(K.SAVED_GROUPS, [])).filter(x => x.id !== sg.id);
            await set(K.SAVED_GROUPS, list); render();
        }, 'd', 'trash'));
        c.appendChild(cb);
        box.appendChild(c);
    });
}

function mk(label, fn, cls, icon) {
    const b = el('button', 'btn sm' + (cls ? ' ' + cls : ''));
    b.innerHTML = (icon ? svg(icon, 13) : '') + '<span></span>';
    b.querySelector('span').textContent = label;
    b.onclick = fn; return b;
}
function sechead(icon, text, alt) {
    const d = el('div', 'sechead' + (alt ? ' alt' : ''));
    d.innerHTML = svg(icon, 14) + '<span class="st"></span><span class="rule"></span>';
    d.querySelector('.st').textContent = text;
    return d;
}
function emptyState(icon, html) {
    const d = el('div', 'empty');
    d.innerHTML = `<div class="eico">${svg(icon, 26)}</div>` + html;
    return d;
}

async function renderClosed() {
    const box = $('#sec-closed'); box.innerHTML = '';
    const wins = (await get(K.CLOSED_WINDOWS, [])).filter(w => !state.query || w.tabs.some(matches));
    const tabs = (await get(K.CLOSED_TABS, [])).filter(matches);

    box.appendChild(sechead('window', 'Closed windows'));
    if (!wins.length) {
        box.appendChild(emptyState('inbox',
            'No closed windows captured yet.<br>Close a window and it lands here, ready to reopen.'));
    }
    wins.forEach(w => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        ch.innerHTML = `<span class="ci">${svg('window', 15)}</span>`;
        const ct = el('span', 'ct'); ct.textContent = `${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}`;
        ch.appendChild(ct); c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = 'closed ' + relTime(w.closedAt); c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = w.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('Reopen window', () => reopenWindow(w), 'a', 'restore'));
        cb.appendChild(mk('Here', () => openUrls(w.tabs.map(t => t.url), 'batch'), '', 'download'));
        cb.appendChild(mk('Save', () => saveSession(w.tabs, 'Closed window'), '', 'save'));
        cb.appendChild(mk('Forget', async () => {
            await set(K.CLOSED_WINDOWS, (await get(K.CLOSED_WINDOWS, [])).filter(x => x.id !== w.id)); render();
        }, 'd', 'trash'));
        c.appendChild(cb);
        box.appendChild(c);
    });

    box.appendChild(sechead('history', 'Closed tabs', true));
    if (!tabs.length) box.appendChild(emptyState('history', 'No closed tabs captured yet.'));
    if (tabs.length) {
        const bar = el('div', 'cb'); bar.style.marginBottom = '8px';
        bar.appendChild(mk('Reopen all shown', () => openUrls(tabs.map(t => t.url), 'batch'), 'a', 'restore'));
        bar.appendChild(mk('Clear list', async () => {
            if (!await confirmBox('Clear the closed-tabs list?')) return;
            await set(K.CLOSED_TABS, []); render();
        }, 'd', 'trash'));
        box.appendChild(bar);
    }
    tabs.slice(0, 200).forEach(t => {
        const row = el('div', 'row');
        const body = el('div', 'body');
        const ti = el('div', 't'); ti.textContent = t.title || host(t.url);
        const u = el('div', 'u'); u.textContent = host(t.url) + ' · ' + relTime(t.closedAt);
        body.appendChild(ti); body.appendChild(u);
        body.onclick = () => chrome.tabs.create({ url: t.url });
        const x = el('button', 'rb go'); x.innerHTML = svg('restore', 16); x.title = 'Reopen';
        x.onclick = () => chrome.tabs.create({ url: t.url });
        row.appendChild(avatarFor(t)); row.appendChild(body); row.appendChild(x);
        box.appendChild(row);
    });
}

async function renderSaved() {
    const box = $('#sec-saved'); box.innerHTML = '';
    const sessions = (await get(K.SESSIONS, [])).filter(s => !state.query || (s.name || '').toLowerCase().includes(state.query.toLowerCase()) || s.tabs.some(matches));
    if (!sessions.length) {
        box.appendChild(emptyState('bookmark',
            'No saved sessions yet.<br>Select tabs in <b>Open</b> and tap <b>Save session</b>.'));
        return;
    }
    sessions.forEach(s => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        ch.innerHTML = `<span class="ci">${svg('bookmark', 15)}</span>`;
        const ct = el('span', 'ct'); ct.textContent = s.name;
        const cn = el('span', 'cnt'); cn.textContent = s.tabs.length;
        ch.appendChild(ct); ch.appendChild(cn); c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = `${s.tabs.length} tabs · saved ${relTime(s.savedAt)}`; c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = s.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('Restore', () => openUrls(s.tabs.map(t => t.url), 'batch'), 'g', 'restore'));
        cb.appendChild(mk('New window', () => openUrls(s.tabs.map(t => t.url), 'window'), '', 'window'));
        cb.appendChild(mk('Bookmark', () => bookmarkUrls(s.tabs, s.name), '', 'star'));
        cb.appendChild(mk('HTML', () => exportBookmarksHtml(s.tabs, s.name), '', 'code'));
        cb.appendChild(mk('Copy', () => copyUrls(s.tabs), '', 'copy'));
        cb.appendChild(mk('Rename', async () => {
            const r = await askText('Rename session', s.name);
            if (!r || !r.text) return;
            const list = await get(K.SESSIONS, []);
            const item = list.find(x => x.id === s.id); if (item) item.name = r.text;
            await set(K.SESSIONS, list); render();
        }, '', 'edit'));
        cb.appendChild(mk('Delete', async () => {
            if (!await confirmBox(`Delete session “${s.name}”?`)) return;
            await set(K.SESSIONS, (await get(K.SESSIONS, [])).filter(x => x.id !== s.id)); render();
        }, 'd'));
        c.appendChild(cb);
        box.appendChild(c);
    });
}

async function renderSettings() {
    const s = await getSettings();
    const cw = await get(K.CLOSED_WINDOWS, []), ct = await get(K.CLOSED_TABS, []);
    const box = $('#sec-settings');
    box.innerHTML = `
      <div class="field inline"><label>Capture closed windows &amp; tabs<span class="h">Turn off to stop recording anything</span></label>
        <input type="checkbox" id="s-capture" ${s.captureClosed ? 'checked' : ''}></div>
      <div class="field inline"><label>Open gesture<span class="h">Multi-finger gesture on any page opens the manager. If your phone grabs a gesture (e.g. 3-finger-down screenshot), pick another.</span></label>
        <select id="s-gesture">
          <option value="off">Off</option>
          <option value="tap3">3-finger tap</option>
          <option value="tap4">4-finger tap</option>
          <option value="swipe3up">3-finger swipe up</option>
          <option value="swipe3down">3-finger swipe down</option>
        </select></div>
      <div class="field inline"><label>Gesture opens<span class="h">Sheet slides over the current page (swipe its handle down to dismiss); Tab opens the full-page manager.</span></label>
        <select id="s-gtarget">
          <option value="sheet">Bottom sheet (on page)</option>
          <option value="tab">Full-page tab</option>
        </select></div>
      <div class="field inline"><label>Restore batch size<span class="h">Tabs opened per batch</span></label>
        <input type="number" id="s-batch" min="1" max="50" value="${s.batchSize}"></div>
      <div class="field inline"><label>Batch delay (seconds)<span class="h">Pause between batches (max 20)</span></label>
        <input type="number" id="s-delay" min="0" max="20" value="${s.batchDelaySec}"></div>
      <div class="field inline"><label>Keep closed windows<span class="h">Currently stored: ${cw.length}</span></label>
        <input type="number" id="s-mw" min="5" max="300" value="${s.maxClosedWindows}"></div>
      <div class="field inline"><label>Keep closed tabs<span class="h">Currently stored: ${ct.length}</span></label>
        <input type="number" id="s-mt" min="10" max="2000" value="${s.maxClosedTabs}"></div>
      <div class="field"><button class="btn p" id="s-save" data-ico="save" style="width:100%">Save settings</button></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <div class="field"><button class="btn" id="s-export" data-ico="download" style="width:100%">Export all data (JSON)</button>
        <div class="h">Sessions, saved groups and closed history.</div></div>
      <div class="field"><button class="btn" id="s-import" data-ico="restore" style="width:100%">Import data (JSON)</button>
        <input type="file" id="s-importfile" accept=".json,application/json" style="display:none">
        <div class="h">Merges a previous export into this install — nothing is overwritten, duplicates are skipped. Use this to carry data across reinstalls.</div></div>
      <div class="field"><button class="btn d" id="s-clearclosed" data-ico="trash" style="width:100%">Clear closed history</button></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <div class="field">
        <label>Diagnostics</label>
        <div class="h">Tab groups: <b>${groupsApiWorks === true ? 'working'
            : groupsApiWorks === false ? 'NOT usable on this browser' + (state.groupError ? ' — ' + esc(state.groupError) : '')
            : HAS_GROUPS ? 'present, not yet probed (open the Groups tab)' : 'NOT available on this build'}</b></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn" id="s-diag" data-ico="search" style="flex:1">Run diagnostics</button>
          <button class="btn" id="s-diagcopy" data-ico="copy" style="flex:0 0 auto"></button>
        </div>
        <pre id="s-diagout" class="diag" style="display:none"></pre>
      </div>`;

    paintIcons(box);
    $('#s-gesture').value = s.gesture || 'swipe3up';
    $('#s-gtarget').value = s.gestureTarget || 'sheet';

    $('#s-save').onclick = async () => {
        await set(K.SETTINGS, {
            captureClosed: $('#s-capture').checked,
            gesture: $('#s-gesture').value,
            gestureTarget: $('#s-gtarget').value,
            batchSize: Math.max(1, Math.min(50, +$('#s-batch').value || 10)),
            batchDelaySec: Math.max(0, Math.min(20, +$('#s-delay').value || 3)),
            maxClosedWindows: Math.max(5, Math.min(300, +$('#s-mw').value || 50)),
            maxClosedTabs: Math.max(10, Math.min(2000, +$('#s-mt').value || 300))
        });
        toast('Settings saved');
    };
    $('#s-import').onclick = () => $('#s-importfile').click();
    $('#s-importfile').addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
            const data = JSON.parse(await f.text());
            const merged = await importData(data);
            toast(`Imported: ${merged.sessions} sessions, ${merged.savedGroups} groups, ` +
                  `${merged.closedWindows} windows, ${merged.closedTabs} tabs`);
            render();
        } catch (err) {
            toast('Import failed: ' + ((err && err.message) || 'not a valid export file'));
        }
        e.target.value = '';
    });
    $('#s-export').onclick = async () => {
        const data = {
            exportedAt: new Date().toISOString(),
            sessions: await get(K.SESSIONS, []),
            savedGroups: await get(K.SAVED_GROUPS, []),
            closedWindows: await get(K.CLOSED_WINDOWS, []),
            closedTabs: await get(K.CLOSED_TABS, [])
        };
        downloadFile('tab-vault-' + Date.now() + '.json', JSON.stringify(data, null, 2), 'application/json');
    };
    $('#s-clearclosed').onclick = async () => {
        if (!await confirmBox('Clear all closed windows and tabs?')) return;
        await set(K.CLOSED_WINDOWS, []); await set(K.CLOSED_TABS, []); render();
    };
    $('#s-diag').onclick = async () => {
        const out = $('#s-diagout');
        out.style.display = 'block';
        out.textContent = 'Running…';
        out.textContent = await runDiagnostics();
    };
    $('#s-diagcopy').onclick = async () => {
        const out = $('#s-diagout');
        const text = (out.textContent && out.textContent !== 'Running…') ? out.textContent : await runDiagnostics();
        out.style.display = 'block'; out.textContent = text;
        navigator.clipboard.writeText(text).then(() => toast('Diagnostics copied'), () => toast('Copy failed'));
    };
}

/* Merge a previous "Export all data" JSON into the current install.
 * Additive only: existing entries win, incoming duplicates (by id, falling
 * back to content identity) are skipped. Returns per-list added counts. */
async function importData(data) {
    if (!data || typeof data !== 'object') throw new Error('not an export file');
    const lists = [
        ['sessions', K.SESSIONS, s => s.id || ('s|' + s.name + '|' + (s.tabs || []).length)],
        ['savedGroups', K.SAVED_GROUPS, g => g.id || ('g|' + g.name + '|' + (g.tabs || []).length)],
        ['closedWindows', K.CLOSED_WINDOWS, w => w.id || ('w|' + w.closedAt)],
        ['closedTabs', K.CLOSED_TABS, t => t.id || ('t|' + t.url + '|' + t.closedAt)]
    ];
    if (!lists.some(([name]) => Array.isArray(data[name]))) throw new Error('no Tab Vault data found');
    const added = {};
    for (const [name, key, idOf] of lists) {
        const incoming = Array.isArray(data[name]) ? data[name] : [];
        const current = await get(key, []);
        const seen = new Set(current.map(idOf));
        let n = 0;
        for (const item of incoming) {
            if (!item || typeof item !== 'object' || seen.has(idOf(item))) continue;
            seen.add(idOf(item));
            current.push(item);
            n++;
        }
        if (n) await set(key, current);
        added[name] = n;
    }
    return added;
}

/* Report exactly what this browser exposes, so group problems can be pinned
 * down instead of guessed at. */
async function runDiagnostics() {
    try { await loadLive(); } catch (e) {}   // make the reported source current
    const L = [];
    const add = (k, v) => L.push(k.padEnd(26) + ': ' + v);

    add('userAgent', (navigator.userAgent || '').slice(0, 120));
    add('chrome.tabGroups', typeof chrome.tabGroups);
    add('tabGroups.query', typeof (chrome.tabGroups && chrome.tabGroups.query));
    add('tabGroups.update', typeof (chrome.tabGroups && chrome.tabGroups.update));
    add('chrome.tabs.group', typeof (chrome.tabs && chrome.tabs.group));
    add('chrome.tabs.ungroup', typeof (chrome.tabs && chrome.tabs.ungroup));
    add('chrome.windows.create', typeof (chrome.windows && chrome.windows.create));
    add('chrome.bookmarks', typeof chrome.bookmarks);
    add('HAS_GROUPS (objects)', String(HAS_GROUPS));
    add('groups actually usable', String(groupsApiWorks));

    let q = 'not called';
    if (chrome.tabGroups && chrome.tabGroups.query) {
        try {
            const g = await chrome.tabGroups.query({});
            q = (g ? g.length : 0) + ' group(s)';
            if (g && g.length) q += ' → ' + JSON.stringify(g);
        } catch (e) { q = 'ERROR: ' + ((e && e.message) || e); }
    }
    add('tabGroups.query({})', q);

    try {
        const tabs = await chrome.tabs.query({});
        const wins = await chrome.windows.getAll({});
        add('total tabs / windows', tabs.length + ' / ' + wins.length);
        const counts = {};
        let hasProp = 0;
        tabs.forEach(t => {
            if ('groupId' in t) hasProp++;
            const g = (t.groupId == null) ? 'missing' : String(t.groupId);
            counts[g] = (counts[g] || 0) + 1;
        });
        add('tabs with groupId prop', hasProp + ' / ' + tabs.length);
        add('groupId distribution', JSON.stringify(counts));
        const grouped = tabs.filter(t => t.groupId != null && t.groupId !== -1);
        add('tabs in a group (id!=-1)', String(grouped.length));
        if (grouped.length) {
            add('sample grouped tab', JSON.stringify({
                groupId: grouped[0].groupId, windowId: grouped[0].windowId,
                title: (grouped[0].title || '').slice(0, 40)
            }));
        }
        add('windows reported', JSON.stringify(wins.map(w => ({ id: w.id, type: w.type }))));
        add('distinct windowIds', JSON.stringify(Array.from(new Set(tabs.map(t => t.windowId)))));

        // Does windows.getAll({populate:true}) hand every window the same list?
        try {
            const pop = await chrome.windows.getAll({ populate: true });
            const sig = pop.map(w => (w.tabs || []).map(t => t.id).sort().join(','));
            add('populate tab counts', JSON.stringify(pop.map(w => (w.tabs || []).length)));
            add('populate duplicates', (sig.length > 1 && new Set(sig).size === 1)
                ? 'YES — every window returned identical tabs (browser bug, worked around)'
                : 'no');
        } catch (e) { add('populate check ERROR', String((e && e.message) || e)); }
    } catch (e) {
        add('tabs.query ERROR', String((e && e.message) || e));
    }

    add('group source used', state.groupSource || 'none');
    if (state.groupError) add('group load error', state.groupError);
    return L.join('\n');
}

/* ------------------------------ actions ------------------------------ */
function selectedTabs() {
    const all = state.windows.flatMap(w => w.tabs);
    return all.filter(t => state.selected.has(t.id));
}
function renderActions() {
    const n = state.selected.size;
    $('#actions').classList.toggle('hidden', n === 0 || state.section !== 'open');
    $('#selcount').textContent = n;
}

async function saveSession(tabs, prefix) {
    const usable = tabs.filter(t => isRestorable(t.url));
    if (!usable.length) { toast('Nothing restorable to save'); return; }
    const def = (prefix || 'Session') + ' · ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const r = await askText('Save session', def);
    if (!r) return;
    const list = await get(K.SESSIONS, []);
    list.unshift({
        id: 's' + Date.now().toString(36), name: r.text || def, savedAt: Date.now(),
        tabs: usable.map(t => ({ url: t.url, title: t.title }))
    });
    await set(K.SESSIONS, list);
    toast(`Saved ${usable.length} tabs`);
    state.selected.clear(); render();
}

async function createSavedGroup(tabs, name, color) {
    const usable = tabs.filter(t => isRestorable(t.url));
    if (!usable.length) { toast('Nothing restorable to save'); return; }
    const list = await get(K.SAVED_GROUPS, []);
    list.unshift({
        id: 'g' + Date.now().toString(36), name: name || 'Group', color: color || 'blue',
        savedAt: Date.now(), tabs: usable.map(t => ({ url: t.url, title: t.title }))
    });
    await set(K.SAVED_GROUPS, list);
    toast(`Saved group “${name || 'Group'}” · ${usable.length} tabs`);
}

async function saveGroup(g, tabs) {
    const usable = tabs.filter(t => isRestorable(t.url));
    if (!usable.length) { toast('Nothing restorable in this group'); return; }
    const list = await get(K.SAVED_GROUPS, []);
    list.unshift({
        id: 'g' + Date.now().toString(36), name: g.title || 'group', color: g.color || 'blue',
        savedAt: Date.now(), tabs: usable.map(t => ({ url: t.url, title: t.title }))
    });
    await set(K.SAVED_GROUPS, list);
    toast('Group saved'); render();
}

/* Restore a saved group: open its tabs, then re-group them under the name. */
async function restoreGroup(sg) {
    const created = [];
    for (const t of sg.tabs) {
        try { created.push(await chrome.tabs.create({ url: t.url, active: false })); } catch (e) {}
    }
    if (state.groupsUsable && created.length) {
        try {
            const gid = await chrome.tabs.group({ tabIds: created.map(t => t.id) });
            await chrome.tabGroups.update(gid, { title: sg.name, color: sg.color || 'blue' });
        } catch (e) { /* grouping unsupported — tabs are still open */ }
    }
    toast(`Restored ${created.length} tabs`);
    render();
}

/* Reopen a captured window, restoring its groups where possible. */
async function reopenWindow(w) {
    const urls = w.tabs.map(t => t.url).filter(isRestorable);
    if (!urls.length) { toast('Nothing restorable in that window'); return; }
    try {
        const first = urls.slice(0, 30);
        const win = await chrome.windows.create({ url: first });
        const made = (win.tabs || []).slice();
        for (let i = 30; i < urls.length; i++) {
            try { made.push(await chrome.tabs.create({ url: urls[i], windowId: win.id, active: false })); } catch (e) {}
        }
        if (state.groupsUsable) {
            const byGroup = {};
            w.tabs.forEach((t, i) => {
                if (!t.group || !t.group.title) return;
                const key = t.group.title + '|' + (t.group.color || 'grey');
                (byGroup[key] || (byGroup[key] = [])).push(i);
            });
            for (const key in byGroup) {
                const ids = byGroup[key].map(i => made[i] && made[i].id).filter(x => x != null);
                if (!ids.length) continue;
                try {
                    const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } });
                    const [title, color] = key.split('|');
                    await chrome.tabGroups.update(gid, { title, color });
                } catch (e) {}
            }
        }
        toast(`Reopened ${urls.length} tabs in a new window`);
    } catch (e) {
        toast('Could not open a window — restoring here instead');
        openUrls(urls, 'batch');
    }
    render();
}

async function openUrls(urls, mode) {
    urls = (urls || []).filter(isRestorable);
    if (!urls.length) { toast('Nothing to open'); return; }
    const s = await getSettings();
    if (mode === 'batch' && urls.length > 10) {
        const ok = await confirmBox(`Open ${urls.length} tabs in batches of ${s.batchSize} every ${s.batchDelaySec}s?\n\nOK = batches, Cancel = all at once.`);
        mode = ok ? 'batch' : 'all';
    }
    const resp = await send({ type: 'openUrls', urls, mode });
    if (!resp.ok) { toast(resp.error || 'Failed to open'); return; }
    if (resp.started) { watchJob(); toast('Restoring ' + urls.length + ' tabs…'); }
    else toast('Opened ' + urls.length + ' tabs');
}

let jobTimer = null;
function watchJob() {
    clearInterval(jobTimer);
    $('#jobbar').classList.remove('hidden');
    jobTimer = setInterval(async () => {
        const j = await get(K.OPEN_JOB, null);
        if (!j) {
            clearInterval(jobTimer); $('#jobbar').classList.add('hidden');
            toast('Restore finished'); return;
        }
        $('#jobtext').textContent = `Opening ${j.done} / ${j.total}…`;
    }, 700);
}

async function bookmarkUrls(tabs, name) {
    if (!chrome.bookmarks) { toast('Bookmarks API unavailable — use HTML export'); return; }
    const usable = tabs.filter(t => isRestorable(t.url));
    if (!usable.length) { toast('Nothing to bookmark'); return; }
    const r = await askText('Bookmark folder name', name || ('Tab Vault ' + new Date().toLocaleDateString()));
    if (!r) return;
    try {
        const roots = await chrome.bookmarks.getTree();
        const bar = (roots[0].children || [])[0];
        const folder = await chrome.bookmarks.create({ parentId: bar ? bar.id : undefined, title: r.text || 'Tab Vault' });
        for (const t of usable) {
            try { await chrome.bookmarks.create({ parentId: folder.id, title: t.title || t.url, url: t.url }); } catch (e) {}
        }
        toast(`Bookmarked ${usable.length} tabs`);
    } catch (e) { toast('Bookmarking failed: ' + (e.message || e)); }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function exportBookmarksHtml(tabs, name) {
    const usable = tabs.filter(t => isRestorable(t.url));
    if (!usable.length) { toast('Nothing to export'); return; }
    const now = Math.floor(Date.now() / 1000);
    let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
        '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
        `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${esc(name || 'Tab Vault')}</H3>\n    <DL><p>\n`;
    for (const t of usable) out += `        <DT><A HREF="${esc(t.url)}" ADD_DATE="${now}">${esc(t.title || t.url)}</A>\n`;
    out += '    </DL><p>\n</DL><p>\n';
    downloadFile('tabs-' + Date.now() + '.html', out, 'text/html');
}

function downloadFile(filename, text, mime) {
    try {
        const blob = new Blob([text], { type: mime || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        toast('Saved ' + filename);
    } catch (e) { toast('Download failed'); }
}

function copyUrls(tabs) {
    const text = tabs.filter(t => isRestorable(t.url)).map(t => t.url).join('\n');
    if (!text) { toast('Nothing to copy'); return; }
    navigator.clipboard.writeText(text).then(
        () => toast('Copied ' + text.split('\n').length + ' URLs'),
        () => toast('Copy failed'));
}

/* --------------------------- footer actions --------------------------- */
document.querySelectorAll('#actions [data-act]').forEach(b => {
    b.onclick = async () => {
        const tabs = selectedTabs();
        if (!tabs.length) return;
        const act = b.dataset.act;

        if (act === 'session') return saveSession(tabs, 'Selection');
        if (act === 'copy') return copyUrls(tabs);
        if (act === 'bookmark') return bookmarkUrls(tabs);

        if (act === 'close') {
            if (!await confirmBox(`Close ${tabs.length} tab(s)?`)) return;
            await chrome.tabs.remove(tabs.map(t => t.id));
            state.selected.clear(); return render();
        }
        if (act === 'window') {
            try {
                const win = await chrome.windows.create({ tabId: tabs[0].id });
                if (tabs.length > 1) await chrome.tabs.move(tabs.slice(1).map(t => t.id), { windowId: win.id, index: -1 });
                state.selected.clear(); toast('Moved to a new window');
            } catch (e) { toast('Could not create a window: ' + (e.message || e)); }
            return render();
        }
        if (act === 'group') {
            const usable = state.groupsUsable;
            const r = await askText(usable ? 'New group name' : 'Saved group name', '', { colors: true });
            if (!r) return;
            if (usable) {
                try {
                    const gid = await chrome.tabs.group({ tabIds: tabs.map(t => t.id) });
                    await chrome.tabGroups.update(gid, { title: r.text || '', color: r.color || 'blue' });
                    state.selected.clear(); toast('Grouped ' + tabs.length + ' tabs');
                    return render();
                } catch (e) {
                    groupsApiWorks = false;   // it lied about being available
                    toast('Browser refused to group — saving as a saved group');
                }
            }
            await createSavedGroup(tabs, r.text || 'Group', r.color || 'blue');
            state.selected.clear();
            return render();
        }
    };
});

/* ------------------------------- chrome ------------------------------- */
document.querySelectorAll('#nav button').forEach(b => {
    b.onclick = () => { state.section = b.dataset.sec; render(); };
});
$('#search').addEventListener('input', e => {
    state.query = e.target.value.trim();
    if (state.section === 'open') renderOpen();
    else render();
});
$('#selall').onclick = () => {
    state.windows.forEach(w => w.tabs.filter(matches).forEach(t => state.selected.add(t.id)));
    renderOpen(); renderActions();
};
$('#selnone').onclick = () => { state.selected.clear(); renderOpen(); renderActions(); };
$('#refresh').onclick = () => { send({ type: 'rebuild' }); render(); };
$('#expand').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
    window.close();
};
$('#jobcancel').onclick = async () => {
    await send({ type: 'cancelOpen' });
    clearInterval(jobTimer); $('#jobbar').classList.add('hidden'); toast('Restore cancelled');
};

paintIcons();
get(K.OPEN_JOB, null).then(j => { if (j) watchJob(); });
render();
