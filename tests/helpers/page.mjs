// Load an extension page (manager.html / media.html) in jsdom with a fake chrome.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, wait } from './fake-chrome.mjs';

export function loadPage(dir, html, scripts, chrome, { hash = '', framed = false, confirm = () => true } = {}) {
    const src = fs.readFileSync(path.join(ROOT, dir, html), 'utf8').replace(/<script\b[^>]*src=[^>]*><\/script>/g, '');
    const dom = new JSDOM(src, {
        url: 'chrome-extension://test-ext/' + html + (hash ? '#' + hash : ''),
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w = dom.window;
    w.chrome = chrome;
    w.confirm = confirm;
    w.alert = () => {};
    w.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = function () {};
    if (!w.performance.getEntriesByType) w.performance.getEntriesByType = () => [];
    if (framed) Object.defineProperty(w, 'top', { value: {} });
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message || String(e.error)));
    for (const s of scripts) {
        try { w.eval(fs.readFileSync(path.join(ROOT, dir, s), 'utf8') + '\n//# sourceURL=' + s); }
        catch (e) { errors.push(s + ': ' + e.message); }
    }
    return { dom, w, doc: w.document, errors, $: q => w.document.querySelector(q), $$: q => [...w.document.querySelectorAll(q)] };
}

export function type(w, input, text) {
    for (let i = 1; i <= text.length; i++) {
        input.value = text.slice(0, i);
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
}

export { wait };
