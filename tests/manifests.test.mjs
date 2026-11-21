import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, makeChrome } from './helpers/fake-chrome.mjs';
import { loadPage, wait } from './helpers/page.mjs';

const man = d => JSON.parse(fs.readFileSync(path.join(ROOT, d, 'manifest.json'), 'utf8'));

test('T8/M17: both web-accessible pages need the per-session dynamic URL', () => {
    for (const d of ['tab-manager', 'media-sniffer-ext']) {
        const war = man(d).web_accessible_resources;
        assert.ok(war.length >= 1);
        for (const w of war) assert.equal(w.use_dynamic_url, true, d);
    }
});

test('popup-size.js is byte-identical in both extensions', () => {
    const a = fs.readFileSync(path.join(ROOT, 'tab-manager/popup-size.js'));
    const b = fs.readFileSync(path.join(ROOT, 'media-sniffer-ext/popup-size.js'));
    assert.ok(a.equals(b));
});

test('T15: the boot watchdog records rejected promises', async () => {
    const p = loadPage('tab-manager', 'manager.html', ['popup-size.js'], makeChrome());
    const ev = new p.w.Event('unhandledrejection');
    ev.reason = new Error('render blew up');
    p.w.dispatchEvent(ev);
    await wait(5);
    assert.ok(p.w.__boot.jsErrors.some(s => s.includes('(async) render blew up')));
});
