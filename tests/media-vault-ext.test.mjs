// Media Vault service worker: M1 M2 M3 M5 M6 M7 M8 M9 M10 M12 M18-notice
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChrome, loadScript } from './helpers/fake-chrome.mjs';
import { sendMsg, wait, until, plain } from './helpers/ext.mjs';

async function boot({ delay, seed = {}, sessionSeed = {}, tabs } = {}) {
    const sent = [];
    const chrome = makeChrome({
        delay,
        tabs: Object.assign({
            get: async id => ({ id, incognito: false, url: 'https://page.example/watch' }),
            query: async () => [{ id: 7 }, { id: 8 }],
            sendMessage: async (tabId, msg, opts) => { sent.push({ tabId, msg, opts }); return { ok: true }; }
        }, tabs || {}),
        downloads: { download: async () => 41, search: async () => [] }
    });
    Object.assign(chrome._stores.local, seed);
    Object.assign(chrome._stores.session, sessionSeed);
    const ctx = loadScript('media-sniffer-ext/background.js', chrome);
    return { chrome, ctx, sent };
}
function hit(chrome, url, ct, extra = {}) {
    const h = [{ name: 'Content-Type', value: ct }];
    if (extra.cl) h.push({ name: 'Content-Length', value: String(extra.cl) });
    if (extra.cr) h.push({ name: 'Content-Range', value: extra.cr });
    chrome.webRequest.onHeadersReceived.fire({ tabId: extra.tabId || 7, requestId: String(Math.random()), url,
        statusCode: extra.status || 200, responseHeaders: h, initiator: 'https://page.example', type: extra.type || 'media' });
}
async function items(chrome, tabId = 7) {
    const r = await sendMsg(chrome, { type: 'getMedia', tabId });
    return plain(r.items || []);
}

test('M1: detections arriving together on a cold worker are all kept (10 runs)', async () => {
    for (let run = 0; run < 10; run++) {
        const { chrome } = await boot({ delay: () => 1 + Math.random() * 6 });
        for (let i = 0; i < 5; i++) hit(chrome, 'https://cdn.example/v' + i + '.mp4', 'video/mp4', { cl: 5e6 });
        await wait(120);
        const n = (await items(chrome)).length;
        assert.equal(n, 5, 'run ' + run + ' kept ' + n);
    }
});

test('M2: a reload clears the tab list; a hash change does not', async () => {
    const { chrome } = await boot();
    hit(chrome, 'https://cdn.example/a.mp4', 'video/mp4');
    await until(async () => (await items(chrome)).length === 1);
    chrome.tabs.onUpdated.fire(7, { status: 'loading', url: 'https://page.example/watch#t=10' }, { id: 7, url: 'https://page.example/watch#t=10' });
    await wait(60);
    assert.equal((await items(chrome)).length, 1, 'hash change cleared the list');
    chrome.tabs.onUpdated.fire(7, { status: 'loading' }, { id: 7, url: 'https://page.example/watch#t=10' });
    await wait(60);
    assert.equal((await items(chrome)).length, 0, 'reload did not clear the list');
});

test('M3: lists from the previous browser session are dropped at startup', async () => {
    const { chrome } = await boot({ seed: { 'mv:tab:7': { items: [{ url: 'https://old/x.mp4', kind: 'video', ext: 'mp4' }], updatedAt: 1 } } });
    chrome.runtime.onStartup.fire();
    await wait(80);
    assert.equal((await items(chrome)).length, 0);
    assert.equal(chrome._stores.local['mv:tab:7'], undefined);
});

test('M3: the old one-key store (mediaByTab) is read once and split per tab', async () => {
    const { chrome } = await boot({ seed: { mediaByTab: { 8: { items: [{ url: 'https://o/x.mp4', kind: 'video', ext: 'mp4', ts: 1 }], updatedAt: 1 } } } });
    assert.equal((await items(chrome, 8)).length, 1);
    await wait(1700);
    assert.equal(chrome._stores.local.mediaByTab, undefined);
    assert.ok(chrome._stores.local['mv:tab:8']);
});

test('M3: saving writes only the tab that changed', async () => {
    const { chrome } = await boot({ seed: { 'mv:tab:8': { items: [{ url: 'https://o/x.mp4', kind: 'video', ext: 'mp4', ts: 1 }], updatedAt: 1 } } });
    await items(chrome, 8);
    const keys = [];
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = (o, cb) => { keys.push(...Object.keys(o)); return origSet(o, cb); };
    hit(chrome, 'https://cdn.example/new.mp4', 'video/mp4');
    await wait(1700);
    assert.ok(keys.includes('mv:tab:7'));
    assert.ok(!keys.includes('mv:tab:8'), 'unchanged tab rewritten: ' + keys.join());
});

test('M5: a playlist re-polled with changing query strings stays one row', async () => {
    const { chrome } = await boot();
    for (let i = 0; i < 4; i++) hit(chrome, 'https://cdn.example/live/index.m3u8?_HLS_msn=' + i + '&_HLS_part=0', 'application/vnd.apple.mpegurl');
    hit(chrome, 'https://cdn.example/a.mp4', 'video/mp4');
    hit(chrome, 'https://cdn.example/b.mp4', 'video/mp4');
    await wait(150);
    const list = await items(chrome);
    const streams = list.filter(i => i.kind === 'stream');
    assert.equal(streams.length, 1);
    assert.equal(streams[0].hits, 4);
    assert.match(streams[0].url, /_HLS_msn=3/);            // newest URL kept
    assert.equal(list.filter(i => i.kind === 'video').length, 2);
});

test('M6: extensionless MPEG-TS segments and named fMP4 segments fold into one row each', async () => {
    const { chrome } = await boot();
    for (let i = 0; i < 4; i++) hit(chrome, 'https://cdn.example/seg/' + (1000 + i), 'video/mp2t', { cl: 1e5 });
    for (let i = 0; i < 4; i++) hit(chrome, 'https://cdn.example/v/seg-' + i + '.mp4', 'video/mp4', { cl: 1e5 });
    hit(chrome, 'https://cdn.example/movie.mp4', 'video/mp4');
    hit(chrome, 'https://cdn.example/trailer.mp4', 'video/mp4');
    await wait(150);
    const list = await items(chrome);
    assert.equal(list.length, 4, list.map(i => i.url).join('\n'));
    assert.ok(list.some(i => i.segments === 4 && /seg\/1000/.test(i.url)));
    assert.ok(list.some(i => i.segments === 4 && /seg-0\.mp4/.test(i.url)));
});

test('M7: page-found media gets a safe file name with an extension', async () => {
    const { chrome } = await boot();
    await sendMsg(chrome, { type: 'domMedia', items: [{ url: 'https://cdn.example/x/vfile', kind: 'video', title: 'Episode 1: Pilot | Site/Show', pageUrl: 'https://p/' }] }, { tab: { id: 7 } });
    const [it] = await items(chrome);
    assert.ok(it, 'item stored');
    assert.doesNotMatch(it.name, /[\\/:*?"<>|]/);
    assert.match(it.name, /\.mp4$/);
    assert.match(it.name, /^Episode 1_ Pilot _ Site_Show/);
});

test('M8: Remove takes the rows out of the worker list', async () => {
    const { chrome } = await boot();
    hit(chrome, 'https://cdn.example/a.mp4', 'video/mp4');
    hit(chrome, 'https://cdn.example/b.mp4', 'video/mp4');
    await until(async () => (await items(chrome)).length === 2);
    const r = await sendMsg(chrome, { type: 'remove', items: [{ tabId: 7, url: 'https://cdn.example/a.mp4' }] });
    assert.equal(r.ok, true);
    assert.deepEqual((await items(chrome)).map(i => i.url), ['https://cdn.example/b.mp4']);
});

test('M9: clearing a list tells that tab to report page media again', async () => {
    const { chrome, sent } = await boot();
    hit(chrome, 'https://cdn.example/a.mp4', 'video/mp4');
    await until(async () => (await items(chrome)).length === 1);
    await sendMsg(chrome, { type: 'clear', tabId: 7 });
    assert.ok(sent.some(s => s.tabId === 7 && s.msg.type === 'mediaCleared'));
});

test('M10: a 206 without a known total has no size (not the chunk length)', async () => {
    const { chrome } = await boot();
    hit(chrome, 'https://cdn.example/big.mp4', 'video/mp4', { status: 206, cl: 1048576, cr: 'bytes 0-1048575/*' });
    hit(chrome, 'https://cdn.example/known.mp4', 'video/mp4', { status: 206, cl: 1048576, cr: 'bytes 0-1048575/99999999' });
    await wait(120);
    const list = await items(chrome);
    assert.equal(list.find(i => /big/.test(i.url)).size, null);
    assert.equal(list.find(i => /known/.test(i.url)).size, 99999999);
});

test('M12: the sniffer only asks for request types that can carry media', async () => {
    const { chrome } = await boot();
    const [filter] = chrome.webRequest.onHeadersReceived._args[0];
    assert.ok(Array.isArray(filter.types), 'no types filter');
    for (const t of ['image', 'script', 'stylesheet', 'font']) assert.ok(!filter.types.includes(t), t);
    for (const t of ['media', 'xmlhttprequest', 'other']) assert.ok(filter.types.includes(t), t);
});

test('M12: settings are read once, not on every detection', async () => {
    const { chrome } = await boot();
    await items(chrome);
    let reads = 0;
    const origGet = chrome.storage.local.get;
    chrome.storage.local.get = (k, cb) => { if (k && typeof k === 'object' && 'settings' in k) reads++; return origGet(k, cb); };
    for (let i = 0; i < 20; i++) hit(chrome, 'https://cdn.example/f' + i + '.mp4', 'video/mp4');
    await wait(200);
    assert.ok(reads <= 1, 'settings read ' + reads + ' times');
});

test('M18: a download the server refuses shows a notice on the page', async () => {
    const { chrome, sent } = await boot();
    await sendMsg(chrome, { type: 'download', url: 'https://cdn.example/a.mp4', filename: 'a.mp4', tabId: 7 });
    chrome.downloads.onChanged.fire({ id: 41, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } });
    await until(() => sent.some(s => s.msg.type === 'mvNotice'), 1500);
    const n = sent.find(s => s.msg.type === 'mvNotice');
    assert.equal(n.tabId, 7);
    assert.equal(n.opts && n.opts.frameId, 0);
    assert.match(n.msg.text, /refused/i);
});
