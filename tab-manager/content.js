/* ==========================================================================
 * Tab Vault — content script: multi-finger gesture to open the manager.
 *
 * Extensions cannot add buttons to the browser's own UI, but a content script
 * hears every touch on every page — so a 3-finger gesture becomes the shortcut.
 * Default: three-finger swipe UP (3-finger swipe DOWN is a system screenshot
 * on many Android skins; the gesture is configurable in Setup).
 * ========================================================================== */
(() => {
    'use strict';
    if (window.top !== window) return;
    if (window.__tabVaultGesture) return;
    window.__tabVaultGesture = true;

    let gesture = 'swipe3up';   // off | tap3 | tap4 | swipe3up | swipe3down

    try {
        chrome.storage.local.get({ settings: {} }, o => {
            gesture = (o.settings && o.settings.gesture) || 'swipe3up';
        });
        chrome.storage.onChanged.addListener(ch => {
            if (ch.settings && ch.settings.newValue)
                gesture = ch.settings.newValue.gesture || 'off';
        });
    } catch (e) {}

    function fire() {
        try { chrome.runtime.sendMessage({ type: 'openManager' }, () => { void chrome.runtime.lastError; }); }
        catch (e) {}
    }

    /* ------------------------- gesture detector ------------------------- */
    const need = g => g === 'tap4' ? 4 : (g === 'off' ? 0 : 3);
    let tracking = false, fired = false, sx = 0, sy = 0, st = 0, moved = 0, seen = 0;

    function centroid(touches) {
        let x = 0, y = 0;
        for (const t of touches) { x += t.clientX; y += t.clientY; }
        return { x: x / touches.length, y: y / touches.length };
    }

    addEventListener('touchstart', e => {
        const n = need(gesture);
        if (!n) return;
        seen = Math.max(seen, e.touches.length);
        if (e.touches.length === n && !tracking) {
            tracking = true; fired = false; moved = 0;
            const c = centroid(e.touches); sx = c.x; sy = c.y; st = Date.now();
        }
    }, { passive: true });

    addEventListener('touchmove', e => {
        if (!tracking || fired) return;
        const n = need(gesture);
        if (e.touches.length !== n) return;
        const c = centroid(e.touches);
        const dx = c.x - sx, dy = c.y - sy;
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
        if (gesture === 'swipe3up' && dy < -90 && Math.abs(dx) < 130) { fired = true; tracking = false; fire(); }
        else if (gesture === 'swipe3down' && dy > 90 && Math.abs(dx) < 130) { fired = true; tracking = false; fire(); }
    }, { passive: true });

    addEventListener('touchend', e => {
        if (e.touches.length > 0) return;      // wait for full release
        if (tracking && !fired && (gesture === 'tap3' || gesture === 'tap4') &&
            seen === need(gesture) && Date.now() - st < 450 && moved < 40) {
            fire();
        }
        tracking = false; fired = false; seen = 0;
    }, { passive: true });

    addEventListener('touchcancel', () => { tracking = false; fired = false; seen = 0; }, { passive: true });
})();
