// Fake chrome.* API for loading the real extension service workers in Node.
// Storage is async (callback and promise forms, like Chrome) so races show up.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeStorageArea(store, delay = () => 1) {
    const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const listeners = [];
    const area = {
        _store: store,
        get(keys, cb) {
            const p = new Promise(res => setTimeout(() => {
                const out = {};
                if (keys == null) Object.assign(out, clone(store));
                else if (typeof keys === 'string') { if (keys in store) out[keys] = clone(store[keys]); }
                else if (Array.isArray(keys)) keys.forEach(k => { if (k in store) out[k] = clone(store[k]); });
                else for (const k in keys) out[k] = k in store ? clone(store[k]) : clone(keys[k]);
                res(out);
            }, delay()));
            return cb ? void p.then(cb) : p;
        },
        set(obj, cb) {
            const p = new Promise(res => setTimeout(() => {
                const changes = {};
                for (const k in obj) { changes[k] = { oldValue: clone(store[k]), newValue: clone(obj[k]) }; store[k] = clone(obj[k]); }
                listeners.forEach(f => f(changes));
                res();
            }, delay()));
            return cb ? void p.then(() => cb()) : p;
        },
        remove(keys, cb) {
            const p = new Promise(res => setTimeout(() => {
                [].concat(keys).forEach(k => delete store[k]); res();
            }, delay()));
            return cb ? void p.then(() => cb()) : p;
        },
        _onChange: listeners
    };
    return area;
}

export function makeEvent() {
    const fns = [];
    return {
        addListener: f => fns.push(f),
        removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); },
        hasListener: f => fns.includes(f),
        fire: (...a) => fns.map(f => f(...a)),
        _fns: fns
    };
}

/** Proxy that answers any chrome.x.onY with an event and any method with a resolved promise. */
function autoNamespace(name, overrides = {}) {
    const events = {};
    return new Proxy(overrides, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'string' && /^on[A-Z]/.test(k)) return (events[k] = events[k] || makeEvent());
            if (k === '_events') return events;
            return (...a) => { const cb = a.find(x => typeof x === 'function'); if (cb) cb(undefined); return Promise.resolve(undefined); };
        }
    });
}

export function makeChrome(opts = {}) {
    const local = {}, session = {}, sync = {};
    const delay = opts.delay || (() => 1);
    const ns = {};
    const chrome = {
        runtime: autoNamespace('runtime', { lastError: null, id: 'test-ext', getURL: p => 'chrome-extension://test-ext/' + p, getManifest: () => ({ version: '0.0.0' }) }),
        storage: {
            local: makeStorageArea(local, delay),
            session: makeStorageArea(session, delay),
            sync: makeStorageArea(sync, delay),
            onChanged: makeEvent()
        },
        tabs: autoNamespace('tabs', opts.tabs || {}),
        windows: autoNamespace('windows', opts.windows || {}),
        tabGroups: autoNamespace('tabGroups', opts.tabGroups || {}),
        action: autoNamespace('action'),
        webRequest: autoNamespace('webRequest'),
        webNavigation: autoNamespace('webNavigation'),
        downloads: autoNamespace('downloads', opts.downloads || {}),
        alarms: autoNamespace('alarms', opts.alarms || {}),
        declarativeNetRequest: autoNamespace('declarativeNetRequest', opts.declarativeNetRequest || {}),
        sessions: autoNamespace('sessions'),
        commands: autoNamespace('commands'),
        _stores: { local, session, sync }
    };
    // storage.onChanged mirrors local + session writes
    for (const [areaName, area] of [['local', chrome.storage.local], ['session', chrome.storage.session]]) {
        area._onChange.push(ch => chrome.storage.onChanged.fire(ch, areaName));
    }
    return chrome;
}

/** Load an extension script (e.g. 'tab-manager/background.js') into a fresh context. */
export function loadScript(rel, chrome, extra = {}) {
    const ctx = vm.createContext({
        chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        Date, Math, JSON, Promise, URL, URLSearchParams, Object, Array, Set, Map, Number, String, RegExp, Error,
        TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob: globalThis.Blob, fetch: extra.fetch || (async () => { throw new Error('no fetch in tests'); }),
        self: undefined, ...extra
    });
    ctx.self = ctx; ctx.globalThis = ctx;
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
    return ctx;
}

export const wait = ms => new Promise(r => setTimeout(r, ms));
