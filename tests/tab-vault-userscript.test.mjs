// T5 / T11 (per-tab live keys), T6 (twin split), T10 (History log writes) — tab-vault.user.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmWorld, openTabVaultTab, wait } from './helpers/userscript.mjs';

const writesTo = (world, key) => {
    let n = 0;
    world.onWrite = (tab, k) => { if (k === key) n++; };
    return () => n;
};

test('userscript boots in two tabs without errors and each sees the other', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    const b = await openTabVaultTab(world, { name: 'B', url: 'https://b.example/' });
    await world.settle();
    assert.deepEqual(a.errors.concat(b.errors), []);
    const ids = Object.keys(b.hook.readLive());
    assert.ok(ids.includes(a.hook.TAB_ID) && ids.includes(b.hook.TAB_ID), ids.join());
    a.close(); b.close();
});

test('T5: a closing tab stays marked gone even if another tab writes right after', async () => {
    const world = gmWorld({ lag: 60 });
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    const b = await openTabVaultTab(world, { name: 'B', url: 'https://b.example/' });
    await world.settle();
    const aId = a.hook.TAB_ID;
    a.hook.onPageHide({ persisted: false });      // A closes
    b.hook.writeLive();                           // B's heartbeat, before A's write reached B
    a.close();
    await world.settle();
    const c = await openTabVaultTab(world, { name: 'C', url: 'https://c.example/' });
    const e = c.hook.readLive()[aId];
    assert.ok(e && e.gone > 0, 'A should be marked gone, got ' + JSON.stringify(e));
    b.close(); c.close();
});

test('T11: a heartbeat writes only the tab\'s own entry, not the whole list', async () => {
    const world = gmWorld();
    const tabs = [];
    for (let i = 0; i < 4; i++) tabs.push(await openTabVaultTab(world, { name: 'T' + i, url: 'https://s' + i + '.example/' }));
    await world.settle();
    const sizes = [];
    world.onWrite = (tab, k, v) => { if (tab === 'T0') sizes.push([k, JSON.stringify(v === undefined ? null : v).length]); };
    tabs[0].hook.writeLive();
    await wait(10);
    const liveWrites = sizes.filter(([k]) => k === 'live' || k.startsWith('live.'));
    assert.ok(liveWrites.length >= 1);
    assert.ok(liveWrites.every(([k]) => k === 'live.' + tabs[0].hook.TAB_ID), JSON.stringify(liveWrites.map(x => x[0])));
    tabs.forEach(t => t.close());
});

test('T5: tabs from the old version (shared "live" map) still show, and are swept', async () => {
    const world = gmWorld();
    world.server.set('live', { vold: { id: 'vold', inst: 'iX', url: 'https://old.example/', title: 'Old', at: 1, seen: Date.now(), vis: true, foc: 0, gone: 0 } });
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    await world.settle();
    assert.ok(a.hook.readLive().vold, 'legacy entry visible');
    a.close();
});

test('T6: after a twin split the tab still answers commands on its new id', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    const b = await openTabVaultTab(world, { name: 'B', url: 'https://b.example/' });
    await world.settle();
    const before = a.hook.TAB_ID;
    assert.ok(a.hook.splitTwin, 'splitTwin is exposed');
    a.hook.splitTwin();
    const after = a.hook.TAB_ID;
    assert.notEqual(after, before);
    await world.settle();
    const ans = await b.hook.sendCmd(after, 'focus');
    assert.ok(['ok', 'nochange'].includes(ans), 'answer: ' + JSON.stringify(ans));
    a.close(); b.close();
});

test('T10: title changes do not rewrite the History log every time', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    await world.settle();
    const count = writesTo(world, 'pages');
    for (let i = 0; i < 5; i++) { a.w.document.title = 'unread ' + i; a.hook.logPage(false); }
    await wait(50);
    assert.ok(count() <= 1, 'History log written ' + count() + ' times for 5 title changes');
    a.close();
});

test('T5: a closed old-version tab in the shared map is filed as closed and the map is removed', async () => {
    const world = gmWorld();
    const t = Date.now();
    world.server.set('live', { vold: { id: 'vold', inst: 'iX', url: 'https://old.example/x', title: 'Old', at: 1, seen: t - 60000, vis: false, foc: 0, gone: t - 60000 } });
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    await a.hook.sweep();
    await world.settle();
    const closed = a.hook.gv('closedTabs', []);
    assert.ok(closed.some(c => c.url === 'https://old.example/x'), JSON.stringify(closed));
    assert.equal(a.tab.cache.has('live'), false);
    a.close();
});

test('T11: a hidden tab does not sweep while another tab holds the sweep lease', async () => {
    const world = gmWorld();
    const a = await openTabVaultTab(world, { name: 'A', url: 'https://a.example/' });
    Object.defineProperty(a.w.document, 'visibilityState', { value: 'hidden', configurable: true });
    a.tab.cache.set('sweepLease', { id: 'someone-else', until: Date.now() + 60000 });
    let leaseWrites = 0;
    world.onWrite = (tab, k) => { if (tab === 'A' && k === 'sweepLease') leaseWrites++; };
    await a.hook.sweep();
    assert.equal(leaseWrites, 0);
    a.close();
});
