// M8 (Remove), M13 (search without reloading) — media-sniffer-ext/media.js against the real worker
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChrome, loadScript } from './helpers/fake-chrome.mjs';
import { sendMsg, until, wait } from './helpers/ext.mjs';
import { loadPage } from './helpers/page.mjs';

async function setup() {
    const chrome = makeChrome({
        tabs: {
            get: async id => ({ id, incognito: false, url: 'https://page.example/' }),
            query: async () => [{ id: 7, url: 'https://page.example/' }],
            getCurrent: cb => cb(undefined),
            sendMessage: async () => ({ ok: true })
        }
    });
    loadScript('media-sniffer-ext/background.js', chrome);
    const calls = [];
    chrome.runtime.sendMessage = (msg, cb) => { calls.push(msg.type); const p = sendMsg(chrome, msg, {}); if (cb) p.then(cb); return p; };
    for (const n of ['a', 'b', 'c']) {
        chrome.webRequest.onHeadersReceived.fire({ tabId: 7, requestId: n, url: 'https://cdn.example/' + n + '.mp4', statusCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }], type: 'media' });
    }
    await wait(80);
    const p = loadPage('media-sniffer-ext', 'media.html', ['popup-size.js', 'media.js'], chrome);
    await until(() => p.$$('#sec-tab .row').length === 3, 3000);
    return { chrome, p, calls };
}

test('popup lists the tab media without script errors', async () => {
    const { p } = await setup();
    assert.deepEqual(p.errors, []);
    assert.equal(p.$$('#sec-tab .row').length, 3);
});

test('M13: typing in search filters locally, with no new worker requests', async () => {
    const { p, calls } = await setup();
    const before = calls.filter(c => c === 'getMedia').length;
    const s = p.$('#search');
    for (const q of ['b', 'b.', 'b.m']) { s.value = q; s.dispatchEvent(new p.w.Event('input', { bubbles: true })); }
    await wait(400);
    assert.equal(p.$$('#sec-tab .row').length, 1);
    assert.equal(calls.filter(c => c === 'getMedia').length, before);
});

test('M8: Remove takes the selected rows out and they stay out', async () => {
    const { p } = await setup();
    const cb = p.$('#sec-tab .row input[type=checkbox]');
    cb.checked = true; cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await wait(30);
    const btn = p.$('#actions [data-act="remove"]');
    assert.ok(btn, 'remove button');
    btn.click();
    await until(() => p.$$('#sec-tab .row').length === 2, 2000);
    await wait(300);
    p.$('#refresh').click();
    await wait(300);
    assert.equal(p.$$('#sec-tab .row').length, 2);
});
