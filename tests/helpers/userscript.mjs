// Run a userscript in jsdom "tabs" that share one fake GM store.
// Like Tampermonkey: GM_getValue reads the tab's own cache; a write lands in
// the writer's cache at once and reaches other tabs (and fires their
// listeners with remote=true) only after `lag` ms, in write order.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, wait } from './fake-chrome.mjs';

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function gmWorld({ lag = 40 } = {}) {
    const server = new Map();          // the "truth" after all writes applied in order
    const tabs = [];
    let lid = 0;
    function makeTab(name) {
        const cache = new Map([...server].map(([k, v]) => [k, clone(v)]));
        const listeners = new Map();   // id -> {key, fn}
        const tab = { name, cache, listeners, alive: true };
        const fire = (key, oldV, newV, remote) => {
            for (const l of listeners.values()) if (l.key === key) { try { l.fn(key, clone(oldV), clone(newV), remote); } catch (e) { console.error(e); } }
        };
        const write = (key, value) => {
            if (world.onWrite) world.onWrite(name, key, value);
            const old = cache.get(key);
            if (value === undefined) cache.delete(key); else cache.set(key, clone(value));
            setTimeout(() => fire(key, old, value, false), 0);
            setTimeout(() => {
                if (value === undefined) server.delete(key); else server.set(key, clone(value));
                for (const other of tabs) {
                    if (other === tab || !other.alive) continue;
                    const o = other.cache.get(key);
                    if (value === undefined) other.cache.delete(key); else other.cache.set(key, clone(value));
                    other.fire(key, o, value, true);
                }
            }, lag);
        };
        tab.fire = fire;
        tab.api = {
            GM_getValue: (k, d) => (cache.has(k) ? clone(cache.get(k)) : d),
            GM_setValue: (k, v) => write(k, v),
            GM_deleteValue: k => write(k, undefined),
            GM_listValues: () => [...cache.keys()],
            GM_addValueChangeListener: (k, fn) => { const id = ++lid; listeners.set(id, { key: k, fn }); return id; },
            GM_removeValueChangeListener: id => { listeners.delete(id); },
            GM_registerMenuCommand: () => 0,
            GM_openInTab: () => {},
            GM_setClipboard: () => {}
        };
        tabs.push(tab);
        return tab;
    }
    const world = { server, tabs, makeTab, onWrite: null, settle: () => wait(lag * 3 + 30) };
    return world;
}

/** Source with a test-only hook appended before the boot call (never shipped). */
function hooked(file, hookCode) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const marker = file.includes('tab-vault') ? '    boot().catch(' : null;
    if (!marker || src.split(marker).length !== 2) throw new Error('hook marker not found once in ' + file);
    return src.replace(marker, '    if (typeof __TEST_HOOK__ === "function") __TEST_HOOK__(' + hookCode + ');\n' + marker);
}

const TV_HOOK = `{
    get TAB_ID() { return TAB_ID; }, get INST() { return INST; }, get cmdMode() { return cmdMode; },
    readLive, writeLive, sweep, onPageHide, registerSelf, logPage, handleCmds, sendCmd, liveCount,
    settings: () => settings, K, gv, gset, glist, onLiveChange: typeof onLiveChange === 'function' ? onLiveChange : null,
    splitTwin: typeof splitTwin === 'function' ? splitTwin : null
}`;

export async function openTabVaultTab(world, { url = 'https://site.example/page', name = 'tab', settings, now } = {}) {
    const tab = world.makeTab(name);
    if (settings) tab.cache.set('settings', clone(settings));
    const dom = new JSDOM('<!doctype html><html><head><title>' + name + '</title></head><body><p>x</p></body></html>',
        { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(w, tab.api);
    if (now) w.Date.now = now;
    let hook = null;
    w.__TEST_HOOK__ = h => { hook = h; };
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    w.eval(hooked('tab-vault.user.js', TV_HOOK));
    await wait(30);
    const close = () => { tab.alive = false; w.close(); };
    return { tab, w, dom, hook, errors, close };
}

export { wait };
