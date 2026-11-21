// T2 / T12 (open sets in the worker), T7 (resumable restore), T9 (mirror in storage.session)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChrome, loadScript } from './helpers/fake-chrome.mjs';
import { sendMsg, wait, until, plain } from './helpers/ext.mjs';
import { browserModel } from './helpers/browser-model.mjs';

async function boot(model, seed = {}) {
    const chrome = makeChrome(model.opts);
    Object.assign(chrome._stores.local, seed);
    const ctx = loadScript('tab-manager/background.js', chrome);
    await wait(40);
    return { chrome, ctx };
}
const urls = n => [...Array(n)].map((_, i) => 'https://site.example/' + i);

test('T2: reopening a closed window runs in the worker and regroups by name', async () => {
    const m = browserModel();
    const { chrome } = await boot(m);
    const tabs = [
        { url: 'https://a.example/1', group: { title: 'Work', color: 'blue' } },
        { url: 'https://a.example/2', group: { title: 'Work', color: 'blue' } },
        { url: 'https://a.example/3', group: null },
        { url: 'chrome://settings', group: null }
    ];
    const r = await sendMsg(chrome, { type: 'openSet', tabs, newWindow: true });
    assert.equal(r.ok, true);
    assert.equal(r.opened, 3);                                   // chrome:// skipped
    const wc = m.log.filter(e => e[0] === 'windowCreate');
    assert.equal(wc.length, 1);
    const grouped = [...m.tabsById.values()].filter(t => t.groupId !== -1);
    assert.equal(grouped.length, 2);
    assert.equal(new Set(grouped.map(t => t.groupId)).size, 1);
    assert.ok(m.log.some(e => e[0] === 'groupUpdate' && e[2] === 'Work' && e[3] === 'blue'));
});

test('T12: each restored tab is grouped, then discarded, before the next one is created', async () => {
    const m = browserModel();
    const { chrome } = await boot(m);
    const tabs = urls(6).map(url => ({ url }));
    const r = await sendMsg(chrome, { type: 'openSet', tabs, newWindow: false, groupAll: { title: 'G', color: 'red' } });
    assert.equal(r.ok, true);
    assert.equal(r.grouped, true);
    const seq = m.log.filter(e => ['create', 'discard', 'group'].includes(e[0]));
    // after every create (except the last) a discard of that tab comes before the next create
    const creates = seq.map((e, i) => [e, i]).filter(([e]) => e[0] === 'create');
    for (let k = 0; k < creates.length - 1; k++) {
        const [c, i] = creates[k]; const [, iNext] = creates[k + 1];
        const between = seq.slice(i + 1, iNext);
        assert.ok(between.some(e => e[0] === 'discard' && e[1] === c[1]), 'tab ' + c[1] + ' not discarded before the next create');
        assert.ok(between.some(e => e[0] === 'group'), 'tab ' + c[1] + ' not grouped before the next create');
    }
    assert.equal(m.log.filter(e => e[0] === 'groupUpdate').length, 1);
});

test('T12: restoreUnloaded off → nothing is discarded', async () => {
    const m = browserModel();
    const { chrome } = await boot(m, { settings: { restoreUnloaded: false } });
    await sendMsg(chrome, { type: 'openSet', tabs: urls(3).map(url => ({ url })), newWindow: false });
    assert.equal(m.log.filter(e => e[0] === 'discard').length, 0);
});

test('T2: a browser that refuses to group still opens every tab', async () => {
    const m = browserModel({ groupsWork: false });
    const { chrome } = await boot(m);
    const r = await sendMsg(chrome, { type: 'openSet', tabs: urls(4).map(url => ({ url })), newWindow: false, groupAll: { title: 'G' } });
    assert.equal(r.ok, true);
    assert.equal(r.opened, 4);
    assert.equal(r.grouped, false);
});

test('T2: moving selected tabs to a new window happens in the worker', async () => {
    const m = browserModel();
    const { chrome } = await boot(m);
    const r = await sendMsg(chrome, { type: 'moveToNewWindow', tabIds: [5, 6, 7] });
    assert.equal(r.ok, true);
    const wc = m.log.find(e => e[0] === 'windowCreate');
    assert.ok(wc);
    assert.ok(m.log.some(e => e[0] === 'move' && e[1].join() === '6,7'));
});

test('T7: a restore interrupted by a worker restart resumes where it stopped', async () => {
    const m = browserModel({ existingWindows: [1] });
    const u = urls(5);
    const { chrome } = await boot(m, {
        settings: { batchDelaySec: 0, batchSize: 10 },
        openJob: { urls: u, done: 2, total: 5, windowId: 99 }      // window 99 is gone; 1.13.0 kept the job in local
    });
    await until(() => m.log.filter(e => e[0] === 'create').length === 3 && chrome._stores.session.openJob === null, 4000);
    const created = m.log.filter(e => e[0] === 'create').map(e => e[2]);
    assert.deepEqual(created, u.slice(2));
    assert.ok(m.log.filter(e => e[0] === 'create').every(e => e[3] == null), 'stale window id must not be used');
});

test('T7: an old-format job record (no URLs) is cleared, not shown forever', async () => {
    const m = browserModel();
    const { chrome } = await boot(m, { openJob: { done: 30, total: 400 } });
    await until(() => chrome._stores.local.openJob === null, 2000);
    await wait(50);
    assert.equal(chrome._stores.local.openJob, null);
    assert.ok(!chrome._stores.session.openJob, 'old record must not be resumed');
    assert.equal(m.log.filter(e => e[0] === 'create').length, 0);
});

test('T9: the tab mirror is kept in storage.session, without data: favicons', async () => {
    const m = browserModel();
    m.opts.tabs.query = async () => [
        { id: 1, windowId: 1, url: 'https://a/', title: 'A', favIconUrl: 'data:image/png;base64,' + 'x'.repeat(5000) },
        { id: 2, windowId: 1, url: 'https://b/', title: 'B', favIconUrl: 'https://b/favicon.ico' }
    ];
    const { chrome } = await boot(m);
    await until(() => chrome._stores.session.mirror);
    const mir = plain(chrome._stores.session.mirror);
    assert.equal(chrome._stores.local.mirror, undefined);
    const t = mir[1].tabs;
    assert.equal(t[0].favIconUrl, '');
    assert.equal(t[1].favIconUrl, 'https://b/favicon.ico');
});

test('T9: a title-only change waits longer before rebuilding than a URL change', async () => {
    const m = browserModel();
    let rebuilds = 0;
    m.opts.tabs.query = async () => { rebuilds++; return []; };
    const { chrome } = await boot(m);
    await wait(50);
    const base = rebuilds;
    chrome.tabs.onUpdated.fire(1, { title: 'x' });
    await wait(700);
    assert.equal(rebuilds, base, 'title-only change rebuilt within 700 ms');
    chrome.tabs.onUpdated.fire(1, { url: 'https://c/' });
    await until(() => rebuilds > base, 1500);
    assert.ok(rebuilds > base);
});
