// media-vault.user.js: M4 M5 M11 M14 M16
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gmWorld, openMediaVaultTab, wait } from './helpers/userscript.mjs';

const ERUDA = process.env.ERUDA_FILE;   // optional: path to eruda@3.4.3/eruda.js for the real-hash test

test('userscript boots without errors', async () => {
    const t = await openMediaVaultTab(gmWorld());
    assert.ok(t.hook, 'hook reached (boot ran to installNet)');
    assert.deepEqual(t.errors, []);
    t.close();
});

test('M4: no window.__MV unless debugApi is on', async () => {
    const off = await openMediaVaultTab(gmWorld());
    assert.equal(off.w.__MV, undefined);
    off.close();
    const on = await openMediaVaultTab(gmWorld(), { gm: { debugApi: true } });
    assert.ok(on.w.__MV && typeof on.w.__MV.addItem === 'function');
    on.close();
});

test('M4: a package name carrying intent syntax is dropped from the intent', async () => {
    const t = await openMediaVaultTab(gmWorld());
    const bad = t.hook.buildIntent('https://cdn/x.mp4', 'org.videolan.vlc;S.evil=1', 'video', 'x');
    assert.doesNotMatch(bad, /package=/);
    const good = t.hook.buildIntent('https://cdn/x.mp4', 'org.videolan.vlc', 'video', 'x');
    assert.match(good, /package=org\.videolan\.vlc;/);
    t.close();
});

test('M5: a playlist re-polled with new query strings stays one row with the newest URL', async () => {
    const t = await openMediaVaultTab(gmWorld());
    for (let i = 0; i < 4; i++) t.hook.addItem({ url: 'https://cdn.example/live/index.m3u8?_HLS_msn=' + i, kind: 'stream', ext: 'm3u8', src: 'net' });
    t.hook.addItem({ url: 'https://cdn.example/a.mp4', kind: 'video', ext: 'mp4', src: 'net' });
    t.hook.addItem({ url: 'https://cdn.example/b.mp4', kind: 'video', ext: 'mp4', src: 'net' });
    const streams = t.hook.items.filter(i => i.kind === 'stream');
    assert.equal(streams.length, 1);
    assert.match(streams[0].url, /_HLS_msn=3$/);
    assert.equal(streams[0].hits, 4);
    assert.equal(t.hook.items.filter(i => i.kind === 'video').length, 2);
    t.close();
});

test('M11: an XHR that is not media only has its Content-Type read', async () => {
    const t = await openMediaVaultTab(gmWorld());
    function run(ct, url) {
        const read = [];
        class X {
            constructor() { this.l = []; this.readyState = 0; this.status = 200; this.responseURL = url; }
            addEventListener(n, f) { this.l.push(f); }
            getResponseHeader(n) { read.push(n.toLowerCase()); return n.toLowerCase() === 'content-type' ? ct : null; }
        }
        X.prototype.open = function () {}; X.prototype.send = function () {};
        const fake = { XMLHttpRequest: X, fetch: null };
        const out = [];
        t.hook.makeHooks(fake, r => out.push(r));
        const x = new fake.XMLHttpRequest();
        x.open('GET', url); x.send();
        x.readyState = 2; x.l.forEach(f => f.call(x));
        return { read, out };
    }
    const html = run('text/html', 'https://api.example/data');
    assert.deepEqual(html.read, ['content-type']);
    const vid = run('video/mp4', 'https://cdn.example/v');
    assert.ok(vid.read.includes('content-length') && vid.read.includes('content-range'));
    t.close();
});

test('M14: frames are greeted 10 times, then only when the frame count changes', async () => {
    const t = await openMediaVaultTab(gmWorld());
    const d = t.hook.helloDelay;
    for (let n = 0; n < 10; n++) assert.equal(d(n, 0, -1).hello, true);
    assert.equal(d(10, 2, 2).hello, false);
    assert.equal(d(11, 3, 2).hello, true);
    assert.equal(d(12, 0, 3).hello, false);
    t.close();
});

test('M16: the console loader rejects a file that does not match the pinned hash', async () => {
    const t = await openMediaVaultTab(gmWorld());
    assert.equal(await t.hook.sriOk('/* tampered */'), false);
    if (ERUDA && fs.existsSync(ERUDA)) assert.equal(await t.hook.sriOk(fs.readFileSync(ERUDA, 'utf8')), true);
    t.close();
});
