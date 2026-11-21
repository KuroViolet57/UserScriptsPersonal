import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChrome, loadScript } from './helpers/fake-chrome.mjs';

test('harness loads both service workers', () => {
    const a = loadScript('tab-manager/background.js', makeChrome());
    const b = loadScript('media-sniffer-ext/background.js', makeChrome());
    assert.equal(typeof a.pushClosedTab, 'function');
    assert.equal(typeof b.addItem, 'function');
});
