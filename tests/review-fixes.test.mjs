// Regression tests for the fresh review of the fixes (docs/reviews/2026-11-21-fresh-review-of-fixes.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { makeChrome, makeEvent, loadScript, ROOT } from './helpers/fake-chrome.mjs';
import { sendMsg, wait, until, plain } from './helpers/ext.mjs';
import { browserModel } from './helpers/browser-model.mjs';
import { loadPage } from './helpers/page.mjs';
import { gmWorld, openTabVaultTab } from './helpers/userscript.mjs';

/* ---------------------------- Media Vault ---------------------------- */
async function mvBoot(opts = {}) {
    const sent = [];
    const chrome = makeChrome({
        tabs: {
            get: async id => ({ id, incognito: false, url: 'https://page.example/watch' }),
            query: async () => [{ id: 7 }],
            sendMessage: async (tabId, msg, o) => { sent.push({ tabId, msg, opts: o }); return { ok: true }; }
        },
        downloads: { download: async () => 41 }
    });
    Object.assign(chrome._stores.local, opts.seed || {});
    loadScript('media-sniffer-ext/background.js', chrome);
    return { chrome, sent };
}
const mvHit = (chrome, url, ct = 'video/mp4', extra = {}) => chrome.webRequest.onHeadersReceived.fire({
    tabId: 7, requestId: String(Math.random()), url, statusCode: extra.status || 200, type: 'media',
    responseHeaders: [{ name: 'Content-Type', value: ct }].concat(extra.cl ? [{ name: 'Content-Length', value: String(extra.cl) }] : [])
});
const mvItems = async (chrome, tabId = 7) => plain((await sendMsg(chrome, { type: 'getMedia', tabId })).items || []);
const mvStore = chrome => Object.assign({}, chrome._stores.local, chrome._stores.session);

test('R1: a list cleared and refilled within one save window is still stored', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/a.mp4');
    await until(async () => (await mvItems(chrome)).length === 1);
    await sendMsg(chrome, { type: 'clear', tabId: 7 });
    mvHit(chrome, 'https://cdn.example/b.mp4');
    await until(async () => (await mvItems(chrome)).length === 1);
    await wait(1800);
    const stored = mvStore(chrome)['mv:tab:7'];
    assert.ok(stored && stored.items.length === 1, 'stored: ' + JSON.stringify(stored));
});

test('R5: a top-frame new document clears older media, an iframe load does not', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/a.mp4');
    await until(async () => (await mvItems(chrome)).length === 1);
    chrome.tabs.onUpdated.fire(7, { status: 'loading' }, { id: 7, url: 'https://page.example/watch' });   // e.g. an iframe navigating
    await wait(80);
    assert.equal((await mvItems(chrome)).length, 1, 'cleared by a loading event without a new top document');
    await sendMsg(chrome, { type: 'pageStart', url: 'https://page.example/watch', timeOrigin: Date.now() }, { tab: { id: 7 }, frameId: 0 });
    await wait(30);
    assert.equal((await mvItems(chrome)).length, 0, 'reload (new top document) did not clear');
    mvHit(chrome, 'https://cdn.example/c.mp4');
    await sendMsg(chrome, { type: 'pageStart', url: 'https://page.example/watch', timeOrigin: Date.now() - 5000 }, { tab: { id: 7 }, frameId: 3 });
    await wait(60);
    assert.equal((await mvItems(chrome)).length, 1, 'a child frame must not clear the tab');
});

test('R5: media that arrived after the new document started survives its pageStart', async () => {
    const { chrome } = await mvBoot();
    const t0 = Date.now();
    await wait(20);
    mvHit(chrome, 'https://cdn.example/early.mp4');
    await until(async () => (await mvItems(chrome)).length === 1);
    await sendMsg(chrome, { type: 'pageStart', url: 'https://page.example/watch', timeOrigin: t0 }, { tab: { id: 7 }, frameId: 0 });
    assert.equal((await mvItems(chrome)).length, 1);
});

test('R6: media lists are kept in storage.session, not storage.local', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/a.mp4');
    await until(async () => (await mvItems(chrome)).length === 1);
    await wait(1800);
    assert.ok(chrome._stores.session['mv:tab:7']);
    assert.equal(chrome._stores.local['mv:tab:7'], undefined);
});

test('R9: two different full files with part1/part2 names stay two rows', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/movie_part1.mp4', 'video/mp4', { cl: 700e6 });
    mvHit(chrome, 'https://cdn.example/movie_part2.mp4', 'video/mp4', { cl: 650e6 });
    await wait(150);
    assert.equal((await mvItems(chrome)).length, 2);
});

test('R9: different playlists (?id=A / ?id=B) stay two rows; volatile params still fold', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/playlist.m3u8?id=A', 'application/vnd.apple.mpegurl');
    mvHit(chrome, 'https://cdn.example/playlist.m3u8?id=B', 'application/vnd.apple.mpegurl');
    mvHit(chrome, 'https://cdn.example/playlist.m3u8?id=A&token=x1&expires=9', 'application/vnd.apple.mpegurl');
    mvHit(chrome, 'https://cdn.example/live.m3u8?_HLS_msn=1', 'application/vnd.apple.mpegurl');
    mvHit(chrome, 'https://cdn.example/live.m3u8?_HLS_msn=2&_HLS_part=1', 'application/vnd.apple.mpegurl');
    await wait(150);
    assert.equal((await mvItems(chrome)).length, 3);
});

test('R10: a video button in an embedded frame asks the worker to open the overlay in the top frame', async () => {
    const { chrome, sent } = await mvBoot();
    await sendMsg(chrome, { type: 'showOnTop' }, { tab: { id: 7 }, frameId: 4 });
    const s = sent.find(x => x.msg.type === 'openOverlay');
    assert.ok(s && s.opts && s.opts.frameId === 0);
});

function mvContent({ child = false } = {}) {
    const vc = new VirtualConsole();
    const navs = [];
    vc.on('jsdomError', e => { if (/navigation/i.test(e.message)) navs.push(e.message); });
    const dom = new JSDOM('<!doctype html><html><body>' + (child ? '<iframe></iframe>' : '<p>x</p>') + '</body></html>',
        { url: 'https://site.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
    let w = dom.window;
    if (child) { w = dom.window.document.querySelector('iframe').contentWindow; w.document.body.innerHTML = '<video src="https://cdn.example/v.mp4"></video>'; }
    const sent = [];
    w.chrome = {
        runtime: {
            id: 'staticid', sendMessage: (m, cb) => { sent.push(m); if (cb) setTimeout(() => cb(m.type === 'getSettings' ? { ok: true, settings: {} } : { ok: true }), 0); },
            onMessage: makeEvent(), getURL: p => 'chrome-extension://dynamic-guid/' + p, lastError: null
        },
        storage: { onChanged: makeEvent() }
    };
    w.eval(fs.readFileSync(path.join(ROOT, 'media-sniffer-ext/content.js'), 'utf8'));
    return { w, sent, dom, navs };
}

test('R6: content scripts no longer listen to storage changes (settings arrive by message)', async () => {
    for (const f of ['media-sniffer-ext/content.js', 'tab-manager/content.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.doesNotMatch(src, /storage\.onChanged\.addListener/, f);
    }
});

test('R5: the top frame announces a new document as soon as it starts', async () => {
    const c = mvContent();
    await wait(30);
    const m = c.sent.find(x => x.type === 'pageStart');
    assert.ok(m && typeof m.timeOrigin === 'number');
    c.dom.window.close();
});

test('R7: the sheet relays an intent posted from the static extension origin', async () => {
    const c = mvContent();
    await wait(30);
    // jsdom cannot navigate: each attempted navigation shows up as one "Not implemented: navigation" error
    c.w.dispatchEvent(new c.w.MessageEvent('message', { data: { type: 'mv-intent', intent: 'intent:https://evil#Intent;end' }, origin: 'https://evil.example' }));
    await wait(10);
    assert.equal(c.navs.length, 0, 'a web page origin must not launch an intent');
    c.w.dispatchEvent(new c.w.MessageEvent('message', { data: { type: 'mv-intent', intent: 'intent:https://x#Intent;end' }, origin: 'chrome-extension://staticid' }));
    await wait(10);
    assert.equal(c.navs.length, 1, 'the static extension origin must be accepted');
    c.dom.window.close();
});

/* ---------------------------- Tab Vault ---------------------------- */
async function tvBoot(model, seed = {}) {
    const chrome = makeChrome(model.opts);
    Object.assign(chrome._stores.local, seed);
    loadScript('tab-manager/background.js', chrome);
    await wait(40);
    return chrome;
}
const urls = (n, p = 'u') => [...Array(n)].map((_, i) => 'https://s.example/' + p + '/' + i);

test('R2: when a new window cannot be made, openSet opens nothing and says so', async () => {
    const m = browserModel();
    m.opts.windows.create = async () => { throw new Error('windows unsupported'); };
    const chrome = await tvBoot(m);
    const r = await sendMsg(chrome, { type: 'openSet', newWindow: true, tabs: urls(3).map(url => ({ url })) });
    assert.equal(r.ok, false);
    assert.equal(m.log.filter(e => e[0] === 'create').length, 0);
});

test('R3: two restores started together run one after the other without mixing', async () => {
    const m = browserModel();
    const chrome = await tvBoot(m, { settings: { batchDelaySec: 0, batchSize: 2 } });
    const a = urls(4, 'a'), b = urls(4, 'b');
    const [ra, rb] = await Promise.all([
        sendMsg(chrome, { type: 'openUrls', urls: a, mode: 'batch' }),
        sendMsg(chrome, { type: 'openUrls', urls: b, mode: 'batch' })
    ]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false, 'second restore must be refused while the first runs');
    await until(() => chrome._stores.session.openJob === null || chrome._stores.local.openJob === null, 4000);
    await wait(100);
    assert.deepEqual(m.log.filter(e => e[0] === 'create').map(e => e[2]), a);
});

test('R3: a resumed restore and a new one in the same wake do not mix', async () => {
    const m = browserModel();
    const chrome = makeChrome(m.opts);
    chrome._stores.local.settings = { batchDelaySec: 0, batchSize: 10 };
    chrome._stores.session.openJob = { urls: urls(4, 'old'), done: 1, total: 4 };
    loadScript('tab-manager/background.js', chrome);
    const r = await sendMsg(chrome, { type: 'openUrls', urls: urls(3, 'new'), mode: 'batch' });
    await wait(400);
    const made = m.log.filter(e => e[0] === 'create').map(e => e[2]);
    const olds = made.filter(u => u.includes('/old/')), news = made.filter(u => u.includes('/new/'));
    assert.deepEqual(olds, urls(4, 'old').slice(1));
    if (r.ok) assert.deepEqual(news, urls(3, 'new')); else assert.deepEqual(news, []);
});

test('R4: Cancel stops a restore at once and a new one can start right away', async () => {
    const m = browserModel();
    const chrome = await tvBoot(m, { settings: { batchDelaySec: 5, batchSize: 1 } });
    await sendMsg(chrome, { type: 'openUrls', urls: urls(5, 'a'), mode: 'batch' });
    await sendMsg(chrome, { type: 'cancelOpen' });
    const r = await sendMsg(chrome, { type: 'openUrls', urls: urls(1, 'b'), mode: 'batch' });
    assert.equal(r.ok, true, r.error);
    await wait(300);
    const made = m.log.filter(e => e[0] === 'create').map(e => e[2]);
    assert.ok(made.filter(u => u.includes('/a/')).length <= 1, made.join());
    assert.ok(made.includes(urls(1, 'b')[0]));
});

test('R6: the restore job lives in storage.session', async () => {
    const m = browserModel();
    const chrome = await tvBoot(m, { settings: { batchDelaySec: 5, batchSize: 1 } });
    await sendMsg(chrome, { type: 'openUrls', urls: urls(3), mode: 'batch' });
    await wait(60);
    assert.ok(chrome._stores.session.openJob && chrome._stores.session.openJob.total === 3);
    assert.equal(chrome._stores.local.openJob, undefined);
});

test('R11: Forget shows a message when the worker does not answer', async () => {
    const chrome = makeChrome({ tabs: { query: async () => [], getCurrent: cb => cb({ id: 9 }) }, windows: { getCurrent: async () => ({ id: 1 }), getAll: async () => [] } });
    chrome._stores.local.closedTabs = [{ id: 't1', url: 'https://a.example/', title: 'A', closedAt: Date.now() }];
    chrome.runtime.sendMessage = (msg, cb) => { if (cb) setTimeout(() => cb(undefined), 0); };
    const p = loadPage('tab-manager', 'manager.html', ['popup-size.js', 'manager.js'], chrome, { hash: 'closed' });
    await until(() => p.$$('#sec-closed .row').length === 1, 3000);
    const btn = p.$$('#sec-closed .btn').find(b => /Clear list/.test(b.textContent));
    btn.click();
    await wait(200);
    assert.match(p.$('#toast').textContent, /not|fail|could/i);
});

test('R8: a 1.1.0 tab removes its own entry from the old shared map when it registers', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    await world.settle();
    const id = a.hook.TAB_ID;
    a.tab.cache.set('live', { [id]: { id, inst: 'old', url: 'https://a.example/', gone: Date.now() - 1000, seen: 1, at: 1 }, other: { id: 'other', inst: 'x', url: 'https://b/', seen: Date.now(), at: 1, gone: 0 } });
    a.hook.registerSelf();
    await world.settle();
    const legacy = a.tab.cache.get('live') || {};
    assert.equal(legacy[id], undefined);
    assert.ok(legacy.other, 'other old-version tabs stay');
    a.close();
});

test('R12: a pending History title is written for its own page when the URL changes', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/one' });
    await world.settle();
    a.w.document.title = 'Final title of one';
    a.hook.logPage(false);                            // pending, batched
    a.w.history.pushState({}, '', '/two');
    a.w.document.title = 'Two';
    a.hook.logPage(true);                             // new visit
    await wait(50);
    const pages = a.hook.gv('pages', []);
    const one = pages.find(p => p.url === 'https://a.example/one');
    assert.equal(one && one.title, 'Final title of one');
    a.close();
});

/* ---------------------------- recheck findings ---------------------------- */
test('N1: the first Restore that wakes the worker is not refused', async () => {
    const m = browserModel();
    const chrome = makeChrome(m.opts);
    chrome._stores.local.settings = { batchDelaySec: 0, batchSize: 5 };
    loadScript('tab-manager/background.js', chrome);           // the message arrives while resumeJob still reads storage
    const r = await sendMsg(chrome, { type: 'openUrls', urls: urls(2, 'n'), mode: 'batch' });
    assert.equal(r.ok, true, r.error);
    await until(() => m.log.filter(e => e[0] === 'create').length === 2, 2000);
});

test('N2: a playlist fetched again after a reload keeps its row', async () => {
    const { chrome } = await mvBoot();
    mvHit(chrome, 'https://cdn.example/master.m3u8', 'application/vnd.apple.mpegurl');
    await until(async () => (await mvItems(chrome)).length === 1);
    await wait(30);
    const t0 = Date.now();                                    // reload: new document starts
    await wait(20);
    mvHit(chrome, 'https://cdn.example/master.m3u8', 'application/vnd.apple.mpegurl');   // fetched again by the new page
    await wait(60);
    await sendMsg(chrome, { type: 'pageStart', url: 'https://page.example/watch', timeOrigin: t0 }, { tab: { id: 7 }, frameId: 0 });
    assert.equal((await mvItems(chrome)).length, 1);
});

test('N3: migrating a 1.6.0 store keeps only open tabs and keeps the old copy if saving fails', async () => {
    const sent = [];
    const chrome = makeChrome({ tabs: { get: async id => ({ id, incognito: false }), query: async () => [{ id: 7 }], sendMessage: async () => ({}) } });
    chrome._stores.local.mediaByTab = {
        7: { items: [{ url: 'https://o/a.mp4', kind: 'video', ext: 'mp4', ts: 1 }], updatedAt: 1 },
        99: { items: [{ url: 'https://o/dead.mp4', kind: 'video', ext: 'mp4', ts: 1 }], updatedAt: 1 }
    };
    let fail = true;
    const origSet = chrome.storage.session.set;
    chrome.storage.session.set = (o, cb) => fail ? Promise.reject(new Error('QUOTA_BYTES quota exceeded')) : origSet(o, cb);
    loadScript('media-sniffer-ext/background.js', chrome);
    const list = plain((await sendMsg(chrome, { type: 'getMedia', tabId: null })).items);
    assert.deepEqual(list.map(i => i.tabId), [7], 'closed tab 99 should be pruned');
    await wait(1800);
    assert.ok(chrome._stores.local.mediaByTab, 'old copy deleted although the save failed');
    fail = false;
    mvHit(chrome, 'https://cdn.example/b.mp4');
    await wait(1800);
    assert.ok(chrome._stores.session['mv:tab:7']);
    assert.equal(chrome._stores.local.mediaByTab, undefined);
});

test('N4: Open as group falls back to the current window when no window can be made', async () => {
    const m = browserModel();
    m.opts.windows.create = async () => { throw new Error('no windows'); };
    const chrome = await tvBoot(m);
    const r1 = await sendMsg(chrome, { type: 'openSet', newWindow: true, tabs: urls(2).map(url => ({ url })), groupAll: { title: 'G' } });
    assert.equal(r1.noWindow, true);
    const src = fs.readFileSync(path.join(ROOT, 'tab-manager/manager.js'), 'utf8');
    assert.match(src, /res\.noWindow\) res = await ask\(false\)/, 'manager retries in the current window');
});

test('R9: more CDN token parameters are ignored when folding playlists', async () => {
    const { chrome } = await mvBoot();
    for (const q of ['md5=a&expires=1', 'md5=b&expires=2', 'hdnea=x', 'hdnea=y', '__token__=p', 'lsig=1', 'wmsAuthSign=z'])
        mvHit(chrome, 'https://cdn.example/v.m3u8?' + q, 'application/vnd.apple.mpegurl');
    await wait(150);
    assert.equal((await mvItems(chrome)).length, 1);
});
