// M9 (re-report after clear), M15 (frames), M18 notice, M4 package names — Media Vault content.js + worker
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { makeChrome, makeEvent, ROOT, loadScript } from './helpers/fake-chrome.mjs';
import { sendMsg, wait, until } from './helpers/ext.mjs';

function frame({ top = true, html = '<p>x</p>' } = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body>' + (top ? html : '<iframe></iframe>') + '</body></html>',
        { url: 'https://player.example/embed', runScripts: 'outside-only', pretendToBeVisual: true });
    let w = dom.window;
    if (!top) {                       // run inside a real child frame (window.top !== window)
        w = dom.window.document.querySelector('iframe').contentWindow;
        w.document.body.innerHTML = html;
    }
    const sent = [];
    const onMessage = makeEvent();
    w.chrome = {
        runtime: {
            sendMessage: (msg, cb) => { sent.push(msg); const r = msg.type === 'getSettings' ? { ok: true, settings: {} } : { ok: true }; if (cb) setTimeout(() => cb(r), 0); },
            onMessage, getURL: p => 'chrome-extension://x/' + p, lastError: null
        },
        storage: { onChanged: makeEvent() }
    };
    const intervals = [];
    const origSI = w.setInterval.bind(w);
    w.setInterval = (f, ms) => { intervals.push(ms); return origSI(f, ms); };
    w.eval(fs.readFileSync(path.join(ROOT, 'media-sniffer-ext/content.js'), 'utf8'));
    return { w, doc: w.document, sent, onMessage, intervals, close: () => dom.window.close() };
}
const domReports = f => f.sent.filter(m => m.type === 'domMedia').flatMap(m => m.items);

test('M15: an embedded frame reports its <video> and gets no gesture handlers', async () => {
    const f = frame({ top: false, html: '<video src="https://cdn.example/clip.mp4"></video>' });
    await wait(60);
    assert.ok(domReports(f).some(i => i.url === 'https://cdn.example/clip.mp4'));
    f.close();
});

test('M15: a frame without media starts no 1.5 s scan loop', async () => {
    const f = frame({ top: false, html: '<div>ad</div>' });
    await wait(60);
    assert.ok(!f.intervals.includes(1500), 'intervals: ' + f.intervals.join());
    f.close();
});

test('M9: after the list is cleared the same page video is reported again', async () => {
    const f = frame({ html: '<video src="https://cdn.example/clip.mp4"></video>' });
    await wait(60);
    const n1 = domReports(f).length;
    f.onMessage.fire({ type: 'mediaCleared' }, {}, () => {});
    await wait(120);
    assert.equal(domReports(f).length, n1 + 1);
    f.close();
});

test('M18: the refused-download notice shows on the top page', async () => {
    const f = frame();
    await wait(30);
    f.onMessage.fire({ type: 'mvNotice', text: 'The site refused the download (403)' }, {}, () => {});
    await wait(20);
    const t = f.doc.querySelector('.mv-toast');
    assert.ok(t && /refused/.test(t.textContent));
    f.close();
});

test('M4: a package name with intent syntax in it is not saved', async () => {
    const chrome = makeChrome();
    loadScript('media-sniffer-ext/background.js', chrome);
    await sendMsg(chrome, { type: 'setSettings', settings: { playerPackage: 'org.videolan.vlc;S.evil=1', downloadPackage: 'idm.internet.download.manager' } });
    const s = chrome._stores.local.settings;
    assert.equal(s.playerPackage, '');
    assert.equal(s.downloadPackage, 'idm.internet.download.manager');
});
