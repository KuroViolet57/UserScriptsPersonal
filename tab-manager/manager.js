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
    maxClosedWindows: 50, maxClosedTabs: 300
};
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HAS_GROUPS = !!(chrome.tabGroups && chrome.tabs.group);

const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

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
async function loadLive() {
    const wins = await chrome.windows.getAll({ populate: true });
    const cur = await chrome.windows.getCurrent().catch(() => null);
    state.groups = [];
    if (HAS_GROUPS) {
        try { state.groups = await chrome.tabGroups.query({}); } catch (e) { state.groups = []; }
    }
    state.windows = wins.map(w => ({
        id: w.id,
        focused: !!w.focused,
        current: cur && w.id === cur.id,
        tabs: (w.tabs || []).map(t => ({
            id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '',
            favIconUrl: t.favIconUrl || '', pinned: !!t.pinned,
            groupId: (t.groupId == null ? -1 : t.groupId), windowId: t.windowId, active: !!t.active
        }))
    }));
}

function groupOf(id) { return state.groups.find(g => g.id === id); }

/* ------------------------------ render ------------------------------ */
async function render() {
    const s = state.section;
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
    const fav = el('img', 'fav');
    if (t.favIconUrl && /^https?:/.test(t.favIconUrl)) fav.src = t.favIconUrl;
    fav.onerror = () => { fav.style.visibility = 'hidden'; };

    const body = el('div', 'body');
    const title = el('div', 't'); title.textContent = t.title || host(t.url);
    const url = el('div', 'u'); url.textContent = host(t.url);
    body.appendChild(title); body.appendChild(url);

    const meta = el('div', 'meta');
    const g = groupOf(t.groupId);
    if (g) {
        const b = el('span', 'gbadge g-' + (g.color || 'grey'));
        b.textContent = g.title || 'group'; meta.appendChild(b);
    }
    if (t.pinned) { const p = el('span'); p.textContent = '📌 pinned'; meta.appendChild(p); }
    if (t.active) { const a = el('span'); a.textContent = '● active'; meta.appendChild(a); }
    if (meta.children.length) body.appendChild(meta);

    body.onclick = () => chrome.tabs.update(t.id, { active: true }).then(() => chrome.windows.update(t.windowId, { focused: true }).catch(() => {}));

    const x = el('button', 'rb'); x.textContent = '✕'; x.title = 'Close tab';
    x.onclick = async e => { e.stopPropagation(); await chrome.tabs.remove(t.id); state.selected.delete(t.id); render(); };

    row.appendChild(cb); row.appendChild(fav); row.appendChild(body); row.appendChild(x);
    return row;
}

function renderOpen() {
    const box = $('#sec-open'); box.innerHTML = '';
    let shown = 0;
    for (const w of state.windows) {
        const tabs = w.tabs.filter(matches);
        if (!tabs.length) continue;
        shown += tabs.length;
        const g = el('div', 'wingroup');
        const head = el('div', 'winhead');
        head.innerHTML = `<span class="wt"></span>${w.current ? '<span class="cur">current</span>' : ''}`;
        head.querySelector('.wt').textContent = `🪟 Window · ${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}`;

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
    if (!shown) box.innerHTML = `<div class="empty">${state.query ? 'No tabs match “' + state.query + '”.' : 'No open tabs found.'}</div>`;
}

async function renderGroups() {
    const box = $('#sec-groups'); box.innerHTML = '';

    if (!HAS_GROUPS) {
        const n = el('div', 'card');
        n.innerHTML = '<div class="cm">⚠️ This browser build doesn\'t expose the tab-groups API, so live groups are unavailable. Saved groups below still work everywhere — they restore as a set of tabs.</div>';
        box.appendChild(n);
    } else {
        const live = state.groups;
        const h = el('div', 'cm'); h.textContent = 'LIVE GROUPS'; h.style.cssText = 'font-weight:700;letter-spacing:.5px;margin:2px 0 8px';
        box.appendChild(h);
        if (!live.length) {
            const e = el('div', 'empty'); e.textContent = 'No tab groups yet. Select tabs in “Open” and tap 🗂 Group.';
            box.appendChild(e);
        }
        for (const g of live) {
            const tabs = state.windows.flatMap(w => w.tabs).filter(t => t.groupId === g.id);
            const c = el('div', 'card');
            const ch = el('div', 'ch');
            const badge = el('span', 'gbadge g-' + (g.color || 'grey'));
            badge.textContent = g.title || 'untitled';
            const ct = el('span', 'ct'); ct.textContent = `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
            ch.appendChild(badge); ch.appendChild(ct); c.appendChild(ch);

            const cu = el('div', 'cu');
            cu.textContent = tabs.slice(0, 4).map(t => t.title || host(t.url)).join(' · ');
            c.appendChild(cu);

            const cb = el('div', 'cb');
            cb.appendChild(mk('Rename', async () => {
                const r = await askText('Rename group', g.title || '', { colors: true, color: g.color });
                if (!r) return;
                await chrome.tabGroups.update(g.id, { title: r.text, color: r.color });
                render();
            }));
            cb.appendChild(mk('Save', () => saveGroup(g, tabs)));
            cb.appendChild(mk('Select', () => { tabs.forEach(t => state.selected.add(t.id)); state.section = 'open'; render(); }));
            cb.appendChild(mk('Ungroup', async () => {
                await chrome.tabs.ungroup(tabs.map(t => t.id)); render();
            }));
            cb.appendChild(mk('Close', async () => {
                if (!await confirmBox(`Close ${tabs.length} tab(s) in this group?`)) return;
                await chrome.tabs.remove(tabs.map(t => t.id)); render();
            }, 'd'));
            c.appendChild(cb);
            box.appendChild(c);
        }
    }

    const saved = await get(K.SAVED_GROUPS, []);
    const h2 = el('div', 'cm'); h2.textContent = 'SAVED GROUPS';
    h2.style.cssText = 'font-weight:700;letter-spacing:.5px;margin:16px 0 8px';
    box.appendChild(h2);
    if (!saved.length) {
        const e = el('div', 'empty'); e.textContent = 'No saved groups yet.';
        box.appendChild(e);
    }
    saved.forEach(sg => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        const badge = el('span', 'gbadge g-' + (sg.color || 'grey'));
        badge.textContent = sg.name || 'group';
        const ct = el('span', 'ct'); ct.textContent = `${sg.tabs.length} tab${sg.tabs.length === 1 ? '' : 's'}`;
        ch.appendChild(badge); ch.appendChild(ct); c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = 'saved ' + relTime(sg.savedAt); c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = sg.tabs.slice(0, 4).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('Restore', () => restoreGroup(sg), 'p'));
        cb.appendChild(mk('New window', () => openUrls(sg.tabs.map(t => t.url), 'window')));
        cb.appendChild(mk('Delete', async () => {
            const list = (await get(K.SAVED_GROUPS, [])).filter(x => x.id !== sg.id);
            await set(K.SAVED_GROUPS, list); render();
        }, 'd'));
        c.appendChild(cb);
        box.appendChild(c);
    });
}

function mk(label, fn, cls) {
    const b = el('button', 'btn sm' + (cls ? ' ' + cls : ''));
    b.textContent = label; b.onclick = fn; return b;
}

async function renderClosed() {
    const box = $('#sec-closed'); box.innerHTML = '';
    const wins = (await get(K.CLOSED_WINDOWS, [])).filter(w => !state.query || w.tabs.some(matches));
    const tabs = (await get(K.CLOSED_TABS, [])).filter(matches);

    const h = el('div', 'cm'); h.textContent = 'CLOSED WINDOWS';
    h.style.cssText = 'font-weight:700;letter-spacing:.5px;margin:2px 0 8px';
    box.appendChild(h);
    if (!wins.length) {
        const e = el('div', 'empty');
        e.innerHTML = 'No closed windows captured yet.<br>Close a window and it appears here, ready to reopen.';
        box.appendChild(e);
    }
    wins.forEach(w => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        const ct = el('span', 'ct'); ct.textContent = `🪟 ${w.tabs.length} tab${w.tabs.length === 1 ? '' : 's'}`;
        ch.appendChild(ct); c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = 'closed ' + relTime(w.closedAt); c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = w.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('↩ Reopen window', () => reopenWindow(w), 'p'));
        cb.appendChild(mk('Here', () => openUrls(w.tabs.map(t => t.url), 'batch')));
        cb.appendChild(mk('Save', () => saveSession(w.tabs, 'Closed window')));
        cb.appendChild(mk('Forget', async () => {
            await set(K.CLOSED_WINDOWS, (await get(K.CLOSED_WINDOWS, [])).filter(x => x.id !== w.id)); render();
        }, 'd'));
        c.appendChild(cb);
        box.appendChild(c);
    });

    const h2 = el('div', 'cm'); h2.textContent = 'CLOSED TABS';
    h2.style.cssText = 'font-weight:700;letter-spacing:.5px;margin:16px 0 8px';
    box.appendChild(h2);
    if (!tabs.length) { const e = el('div', 'empty'); e.textContent = 'No closed tabs captured yet.'; box.appendChild(e); }
    if (tabs.length) {
        const bar = el('div', 'cb'); bar.style.marginBottom = '8px';
        bar.appendChild(mk('Reopen all shown', () => openUrls(tabs.map(t => t.url), 'batch'), 'p'));
        bar.appendChild(mk('Clear list', async () => {
            if (!await confirmBox('Clear the closed-tabs list?')) return;
            await set(K.CLOSED_TABS, []); render();
        }, 'd'));
        box.appendChild(bar);
    }
    tabs.slice(0, 200).forEach(t => {
        const row = el('div', 'row');
        const fav = el('img', 'fav');
        if (t.favIconUrl && /^https?:/.test(t.favIconUrl)) fav.src = t.favIconUrl;
        fav.onerror = () => { fav.style.visibility = 'hidden'; };
        const body = el('div', 'body');
        const ti = el('div', 't'); ti.textContent = t.title || host(t.url);
        const u = el('div', 'u'); u.textContent = host(t.url) + ' · ' + relTime(t.closedAt);
        body.appendChild(ti); body.appendChild(u);
        body.onclick = () => chrome.tabs.create({ url: t.url });
        const x = el('button', 'rb'); x.textContent = '↩'; x.title = 'Reopen';
        x.onclick = () => chrome.tabs.create({ url: t.url });
        row.appendChild(fav); row.appendChild(body); row.appendChild(x);
        box.appendChild(row);
    });
}

async function renderSaved() {
    const box = $('#sec-saved'); box.innerHTML = '';
    const sessions = (await get(K.SESSIONS, [])).filter(s => !state.query || (s.name || '').toLowerCase().includes(state.query.toLowerCase()) || s.tabs.some(matches));
    if (!sessions.length) {
        box.innerHTML = '<div class="empty">No saved sessions yet.<br>Select tabs in “Open” and tap 💾 Save session.</div>';
        return;
    }
    sessions.forEach(s => {
        const c = el('div', 'card');
        const ch = el('div', 'ch');
        const ct = el('span', 'ct'); ct.textContent = s.name; ch.appendChild(ct);
        c.appendChild(ch);
        const cm = el('div', 'cm'); cm.textContent = `${s.tabs.length} tabs · saved ${relTime(s.savedAt)}`; c.appendChild(cm);
        const cu = el('div', 'cu'); cu.textContent = s.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ');
        c.appendChild(cu);
        const cb = el('div', 'cb');
        cb.appendChild(mk('↩ Restore', () => openUrls(s.tabs.map(t => t.url), 'batch'), 'p'));
        cb.appendChild(mk('New window', () => openUrls(s.tabs.map(t => t.url), 'window')));
        cb.appendChild(mk('⭐ Bookmark', () => bookmarkUrls(s.tabs, s.name)));
        cb.appendChild(mk('HTML', () => exportBookmarksHtml(s.tabs, s.name)));
        cb.appendChild(mk('Copy', () => copyUrls(s.tabs)));
        cb.appendChild(mk('Rename', async () => {
            const r = await askText('Rename session', s.name);
            if (!r || !r.text) return;
            const list = await get(K.SESSIONS, []);
            const item = list.find(x => x.id === s.id); if (item) item.name = r.text;
            await set(K.SESSIONS, list); render();
        }));
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
      <div class="field inline"><label>Restore batch size<span class="h">Tabs opened per batch</span></label>
        <input type="number" id="s-batch" min="1" max="50" value="${s.batchSize}"></div>
      <div class="field inline"><label>Batch delay (seconds)<span class="h">Pause between batches (max 20)</span></label>
        <input type="number" id="s-delay" min="0" max="20" value="${s.batchDelaySec}"></div>
      <div class="field inline"><label>Keep closed windows<span class="h">Currently stored: ${cw.length}</span></label>
        <input type="number" id="s-mw" min="5" max="300" value="${s.maxClosedWindows}"></div>
      <div class="field inline"><label>Keep closed tabs<span class="h">Currently stored: ${ct.length}</span></label>
        <input type="number" id="s-mt" min="10" max="2000" value="${s.maxClosedTabs}"></div>
      <div class="field"><button class="btn p" id="s-save" style="width:100%">Save settings</button></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <div class="field"><button class="btn" id="s-export" style="width:100%">⬇ Export all data (JSON)</button>
        <div class="h">Sessions, saved groups and closed history.</div></div>
      <div class="field"><button class="btn d" id="s-clearclosed" style="width:100%">🗑 Clear closed history</button></div>
      <div class="field"><div class="h">Tab groups API: <b>${HAS_GROUPS ? 'available' : 'NOT available on this build'}</b></div></div>`;

    $('#s-save').onclick = async () => {
        await set(K.SETTINGS, {
            captureClosed: $('#s-capture').checked,
            batchSize: Math.max(1, Math.min(50, +$('#s-batch').value || 10)),
            batchDelaySec: Math.max(0, Math.min(20, +$('#s-delay').value || 3)),
            maxClosedWindows: Math.max(5, Math.min(300, +$('#s-mw').value || 50)),
            maxClosedTabs: Math.max(10, Math.min(2000, +$('#s-mt').value || 300))
        });
        toast('Settings saved');
    };
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
    if (HAS_GROUPS && created.length) {
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
        if (HAS_GROUPS) {
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
            if (!HAS_GROUPS) { toast('Tab groups unavailable — saving as a saved group');
                const list = await get(K.SAVED_GROUPS, []);
                const r0 = await askText('Saved group name', 'Group', { colors: true });
                if (!r0) return;
                list.unshift({ id: 'g' + Date.now().toString(36), name: r0.text || 'Group', color: r0.color || 'blue',
                    savedAt: Date.now(), tabs: tabs.filter(t => isRestorable(t.url)).map(t => ({ url: t.url, title: t.title })) });
                await set(K.SAVED_GROUPS, list); state.selected.clear(); return render();
            }
            const r = await askText('New group name', '', { colors: true });
            if (!r) return;
            try {
                const gid = await chrome.tabs.group({ tabIds: tabs.map(t => t.id) });
                await chrome.tabGroups.update(gid, { title: r.text || '', color: r.color || 'blue' });
                state.selected.clear(); toast('Grouped ' + tabs.length + ' tabs');
            } catch (e) { toast('Grouping failed: ' + (e.message || e)); }
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

get(K.OPEN_JOB, null).then(j => { if (j) watchJob(); });
render();
