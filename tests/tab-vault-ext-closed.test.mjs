// T1 (closed-list race) and T4 (import) in tab-manager/background.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTabWorker, seedMirror, sendMsg, tabs, wait, until, plain } from './helpers/ext.mjs';

test('T1: 10 tabs closed at the same moment are all captured', async () => {
    const { chrome } = await bootTabWorker();
    const list = tabs(10);
    seedMirror(chrome, { 1: { id: 1, tabs: list, groups: [] } });
    list.forEach(t => chrome.tabs.onRemoved.fire(t.id, { windowId: 1, isWindowClosing: false }));
    await until(() => (chrome._stores.local.closedTabs || []).length >= 10);
    await wait(100);
    const closed = chrome._stores.local.closedTabs || [];
    assert.equal(closed.length, 10);
    assert.deepEqual(new Set(closed.map(c => c.url)).size, 10);
});

test('T1: 3 windows closed at the same moment are all captured', async () => {
    const { chrome } = await bootTabWorker();
    seedMirror(chrome, {
        1: { id: 1, tabs: tabs(2, 1), groups: [] },
        2: { id: 2, tabs: tabs(2, 10), groups: [] },
        3: { id: 3, tabs: tabs(2, 20), groups: [] }
    });
    [1, 2, 3].forEach(w => chrome.windows.onRemoved.fire(w));
    await until(() => (chrome._stores.local.closedWindows || []).length >= 3);
    await wait(100);
    assert.equal((chrome._stores.local.closedWindows || []).length, 3);
});

test('T1: Forget during captures removes only the forgotten entry', async () => {
    const { chrome } = await bootTabWorker();
    chrome._stores.local.closedTabs = [{ id: 'told', url: 'https://old.example/', title: 'old', closedAt: 1 }];
    const list = tabs(5);
    seedMirror(chrome, { 1: { id: 1, tabs: list, groups: [] } });
    list.forEach(t => chrome.tabs.onRemoved.fire(t.id, { windowId: 1, isWindowClosing: false }));
    const r = await sendMsg(chrome, { type: 'closedOp', op: 'remove', ids: ['told'] });
    await until(() => (chrome._stores.local.closedTabs || []).length >= 5);
    await wait(100);
    assert.equal(r && r.ok, true);
    const closed = chrome._stores.local.closedTabs;
    assert.equal(closed.length, 5);
    assert.ok(!closed.some(c => c.id === 'told'));
});

test('T1: clear tabs / windows / all', async () => {
    const { chrome } = await bootTabWorker();
    chrome._stores.local.closedTabs = [{ id: 't1', url: 'https://a/', closedAt: 1 }];
    chrome._stores.local.closedWindows = [{ id: 'w1', closedAt: 1, tabs: [{ url: 'https://a/' }] }];
    await sendMsg(chrome, { type: 'closedOp', op: 'clear', what: 'tabs' });
    assert.deepEqual(chrome._stores.local.closedTabs, []);
    assert.equal(chrome._stores.local.closedWindows.length, 1);
    await sendMsg(chrome, { type: 'closedOp', op: 'clear', what: 'all' });
    assert.deepEqual(chrome._stores.local.closedWindows, []);
});

test('T4: import skips entries with the wrong shape', async () => {
    const { chrome } = await bootTabWorker();
    const r = await sendMsg(chrome, { type: 'closedOp', op: 'import', data: {
        sessions: [{ id: 's1', name: 'ok', savedAt: 5, tabs: [{ url: 'https://a/' }] }, { id: 's2', name: 'no tabs' }, 'junk', null],
        savedGroups: [{ id: 'g1', name: 'x', tabs: 'nope' }],
        closedWindows: [{ id: 'w1', closedAt: 3, tabs: [{ url: 'https://a/' }] }, { id: 'w2' }],
        closedTabs: [{ id: 't1', url: 'https://b/', closedAt: 4 }, { id: 't2', title: 'no url' }]
    } });
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.added), { sessions: 1, savedGroups: 0, closedWindows: 1, closedTabs: 1 });
    assert.equal(chrome._stores.local.sessions.length, 1);
    assert.equal(chrome._stores.local.savedGroups, undefined);
});

test('T4: import into a full closed-tabs list keeps the newest and reports what was dropped', async () => {
    const { chrome } = await bootTabWorker();
    chrome._stores.local.settings = { maxClosedTabs: 10 };
    chrome._stores.local.closedTabs = [...Array(10)].map((_, i) => ({ id: 'e' + i, url: 'https://e/' + i, closedAt: 1000 - i }));
    const newer = [...Array(3)].map((_, i) => ({ id: 'n' + i, url: 'https://n/' + i, closedAt: 5000 + i }));
    const older = [...Array(2)].map((_, i) => ({ id: 'o' + i, url: 'https://o/' + i, closedAt: 10 + i }));
    const r = await sendMsg(chrome, { type: 'closedOp', op: 'import', data: { closedTabs: newer.concat(older) } });
    const list = chrome._stores.local.closedTabs;
    assert.equal(list.length, 10);
    assert.deepEqual(list.slice(0, 3).map(t => t.id), ['n2', 'n1', 'n0']);   // newest first
    assert.equal(r.added.closedTabs, 3);
    assert.equal(r.dropped.closedTabs, 2);
});

test('T4: import with no Tab Vault data is refused', async () => {
    const { chrome } = await bootTabWorker();
    const r = await sendMsg(chrome, { type: 'closedOp', op: 'import', data: { foo: 1 } });
    assert.equal(r.ok, false);
    assert.match(r.error, /no Tab Vault data/);
});
