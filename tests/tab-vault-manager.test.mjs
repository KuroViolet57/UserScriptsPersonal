// T3 (overlapping renders), T13 (delay 0), live Open list — tab-manager/manager.js in jsdom
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChrome } from './helpers/fake-chrome.mjs';
import { loadPage, type, wait } from './helpers/page.mjs';
import { until } from './helpers/ext.mjs';

function manager(chrome, opts) {
    return loadPage('tab-manager', 'manager.html', ['popup-size.js', 'manager.js'], chrome, opts);
}
function chromeWith(tabsList = []) {
    const list = tabsList.slice();
    const chrome = makeChrome({
        tabs: { query: async () => list.map(t => ({ ...t })), getCurrent: cb => cb({ id: 999 }), remove: async () => {} },
        windows: { getCurrent: async () => ({ id: 1 }), getAll: async () => [{ id: 1, focused: true }] }
    });
    chrome._list = list;
    return chrome;
}

test('manager loads without script errors', async () => {
    const chrome = chromeWith([{ id: 1, windowId: 1, url: 'https://a.example/', title: 'A' }]);
    const p = manager(chrome);
    await until(() => p.$$('#sec-open .row').length === 1, 3000);
    assert.deepEqual(p.errors, []);
    assert.equal(p.$$('#sec-open .row').length, 1);
});

test('T3: typing fast in Closed search shows each card once', async () => {
    const chrome = chromeWith();
    chrome._stores.local.closedTabs = [...Array(5)].map((_, i) => ({ id: 't' + i, url: 'https://ab.example/' + i, title: 'abc ' + i, closedAt: Date.now() - i * 1000 }));
    const p = manager(chrome, { hash: 'closed' });
    await until(() => p.$$('#sec-closed .row').length === 5, 3000);
    type(p.w, p.$('#search'), 'abc');
    await wait(900);
    assert.equal(p.$$('#sec-closed .row').length, 5);
    assert.equal(p.$$('#sec-closed .sechead').length, 2);
});

test('T13: a batch delay of 0 is saved as 0', async () => {
    const chrome = chromeWith();
    const p = manager(chrome, { hash: 'settings' });
    await until(() => p.$('#s-delay'), 3000);
    p.$('#s-delay').value = '0';
    p.$('#s-save').click();
    await until(() => chrome._stores.local.settings, 2000);
    await wait(50);
    assert.equal(chrome._stores.local.settings.batchDelaySec, 0);
});

test('live Open list: a tab opened elsewhere appears without a manual refresh', async () => {
    const chrome = chromeWith([{ id: 1, windowId: 1, url: 'https://a.example/', title: 'A' }]);
    const p = manager(chrome);
    await until(() => p.$$('#sec-open .row').length === 1, 3000);
    chrome._list.push({ id: 2, windowId: 1, url: 'https://b.example/', title: 'B' });
    chrome.tabs.onCreated.fire({ id: 2 });
    const n = await until(() => p.$$('#sec-open .row').length === 2 && 2, 3000);
    assert.equal(n, 2);
});

test('live Open list: closing a tab that is already gone does not throw', async () => {
    const chrome = chromeWith([{ id: 1, windowId: 1, url: 'https://a.example/', title: 'A' }]);
    chrome.tabs.remove = async () => { throw new Error('No tab with id: 1.'); };
    const p = manager(chrome);
    await until(() => p.$$('#sec-open .row').length === 1, 3000);
    const rejections = [];
    p.w.addEventListener('unhandledrejection', e => rejections.push(String(e.reason)));
    process.on('unhandledRejection', r => rejections.push(String(r)));
    chrome._list.length = 0;
    p.$('#sec-open .row .rb').click();
    await wait(400);
    assert.deepEqual(rejections, []);
    assert.equal(p.$$('#sec-open .row').length, 0);
});
