import { makeChrome, loadScript, wait } from './fake-chrome.mjs';

/** Send a runtime message to the loaded worker the way chrome does. */
export function sendMsg(chrome, msg, sender = {}) {
    return new Promise(res => {
        const ret = chrome.runtime.onMessage.fire(msg, sender, res);
        if (!ret.some(Boolean)) res(undefined);
    });
}

/** The tab mirror lives in storage.session from 1.14.0 (local before); seed both. */
export function seedMirror(chrome, mirror) {
    chrome._stores.session.mirror = JSON.parse(JSON.stringify(mirror));
    chrome._stores.local.mirror = JSON.parse(JSON.stringify(mirror));
}

export async function bootTabWorker(opts = {}) {
    const chrome = makeChrome(opts);
    const ctx = loadScript('tab-manager/background.js', chrome);
    await wait(30);          // let the top-level rebuildMirror() settle
    return { chrome, ctx };
}

export function tabs(n, from = 1) {
    return [...Array(n)].map((_, i) => ({ id: from + i, url: 'https://example.com/p' + (from + i), title: 'T' + (from + i), windowId: 1 }));
}


/** Poll until fn() is truthy (or give up after ms); returns the last value. */
export async function until(fn, ms = 4000) {
    const t0 = Date.now(); let v;
    while (Date.now() - t0 < ms) { v = fn(); if (v) return v; await wait(20); }
    return fn();
}
/** Plain copy of a value from the worker's vm context (other realm). */
export const plain = v => JSON.parse(JSON.stringify(v));

export { wait };
