// T14: the in-page sheet lives in a closed shadow root (tab-manager/content.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { makeChrome, ROOT, wait } from './helpers/fake-chrome.mjs';

function page(settings) {
    const dom = new JSDOM('<!doctype html><html><head><style>iframe{display:none!important} div{opacity:0!important}</style></head><body><p>site</p></body></html>',
        { url: 'https://site.example/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const roots = [];
    const orig = w.Element.prototype.attachShadow;
    w.Element.prototype.attachShadow = function (o) { const r = orig.call(this, o); roots.push({ host: this, root: r, mode: o.mode }); return r; };
    const chrome = makeChrome();
    chrome._stores.local.settings = settings;
    w.chrome = chrome;
    w.eval(fs.readFileSync(path.join(ROOT, 'tab-manager/content.js'), 'utf8'));
    return { w, doc: w.document, roots, chrome };
}
function touch(w, type, n) {
    const ev = new w.Event(type, { bubbles: true });
    const pts = [...Array(n)].map((_, i) => ({ clientX: 100 + i * 10, clientY: 300 }));
    Object.defineProperty(ev, 'touches', { value: pts });
    w.dispatchEvent(ev);
}

test('T14: a 3-finger tap opens the manager sheet inside a closed shadow root', async () => {
    const p = page({ gesture: 'tap3', gestureTarget: 'sheet' });
    await wait(30);
    touch(p.w, 'touchstart', 3);
    touch(p.w, 'touchend', 0);
    await wait(30);
    assert.equal(p.roots.length, 1);
    assert.equal(p.roots[0].mode, 'closed');
    const root = p.roots[0].root;
    const frame = root.querySelector('iframe');
    assert.ok(frame, 'iframe inside the shadow root');
    assert.equal(frame.getAttribute('src'), 'chrome-extension://test-ext/manager.html');
    assert.equal(p.doc.getElementById('tv-sheet'), null, 'nothing with our ids in the page DOM');
    assert.equal(p.doc.getElementById('tv-sheet-style'), null, 'no style injected into the page');
    assert.ok(root.querySelector('style'), 'styles live in the shadow root');
});

test('T14: the close button removes the sheet and its host', async () => {
    const p = page({ gesture: 'tap3', gestureTarget: 'sheet' });
    await wait(30);
    touch(p.w, 'touchstart', 3); touch(p.w, 'touchend', 0);
    await wait(30);
    const { root, host } = p.roots[0];
    root.querySelector('.tv-close').click();
    await wait(400);
    assert.equal(root.querySelector('.tv-sheetbox'), null);
    assert.equal(host.isConnected, false);
});

test('T14: works on a page without <body>', async () => {
    const p = page({ gesture: 'tap3', gestureTarget: 'sheet' });
    p.doc.body.remove();
    await wait(30);
    touch(p.w, 'touchstart', 3); touch(p.w, 'touchend', 0);
    await wait(30);
    assert.ok(p.roots[0] && p.roots[0].root.querySelector('iframe'));
});
