/* Runs synchronously before first layout. Popup windows take their size from
 * the page's initial preferred size, and some browsers (Vivaldi Android) size
 * the floating popup exactly once — late JS resizing is ignored. So the last
 * saved popup size is mirrored to localStorage and applied here, before the
 * first paint. Full-page mode removes this style right after load; the iframe
 * bottom sheet never passes the top-window check. */
(function () {
    try {
        if (window.self !== window.top) return;
        var w = parseInt(localStorage.getItem('popupW'), 10) || 0;
        var h = parseInt(localStorage.getItem('popupH'), 10) || 0;
        if (!w && !h) return;
        var st = document.createElement('style');
        st.id = 'popup-size-style';
        st.textContent = 'html,body{' + (w ? 'width:' + w + 'px !important;' : '') +
            (h ? 'height:' + h + 'px !important;min-height:0 !important;' : '') + '}';
        document.head.appendChild(st);
    } catch (e) {}
})();

/* Boot watchdog. Unpacked extensions on some Android builds re-read every
 * file from the folder on each popup open — slowly, and sometimes failing.
 * If the main script never arrives the popup would be a dead skeleton, so:
 * record timings for the diagnostics report, and catch a failed <script>
 * load (capture phase — resource errors don't bubble) to show a Reload
 * banner. This runs before the main <script> element is parsed, so the
 * listener is always armed in time. Shared verbatim by both extensions. */
(function () {
    try {
        var B = window.__boot = { t0: performance.now(), failed: [], jsErrors: [], rendered: 0, dcl: 0, load: 0 };
        var shown = false;
        function showFail() {
            if (shown) return;
            shown = true;
            var go = function () {
                var d = document.createElement('div');
                d.className = 'bootfail';
                d.appendChild(document.createTextNode(
                    'Couldn’t load ' + B.failed.join(', ') +
                    ' — the browser failed to read the extension’s files. '));
                var b = document.createElement('button');
                b.textContent = 'Reload';
                b.onclick = function () { location.reload(); };
                d.appendChild(b);
                document.body.insertBefore(d, document.body.firstChild);
            };
            if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
        }
        window.addEventListener('error', function (e) {
            var t = e && e.target;
            if (!t || t === window || !t.tagName) {          // runtime exception
                if (e && e.message) B.jsErrors.push(String(e.message).slice(0, 140));
                return;
            }
            if (t.tagName !== 'SCRIPT' || !t.src) return;     // favicons etc. are not boot failures
            B.failed.push(String(t.src).split('/').pop());
            showFail();
        }, true);
        // Most page failures are rejected promises (async renders), not throws.
        window.addEventListener('unhandledrejection', function (e) {
            var r = e && e.reason;
            B.jsErrors.push(('(async) ' + String((r && r.message) || r)).slice(0, 140));
        });
        document.addEventListener('DOMContentLoaded', function () { B.dcl = performance.now(); });
        window.addEventListener('load', function () { B.load = performance.now(); });

        /* Plain-text report of how this page loaded, for the diagnostics
         * screens: which files, how long each took, what failed. */
        window.__bootReport = function (pad) {
            var L = [];
            var add = function (k, v) { L.push((k + '                                ').slice(0, pad || 32) + ': ' + v); };
            var ms = function (n) { return (Math.round(n * 10) / 10) + ' ms'; };
            L.push('');
            L.push('--- popup load (this page) ---');
            add('context', window.self !== window.top ? 'sheet iframe' : (window.__isPopup ? 'toolbar popup' : 'full-page tab'));
            add('stylesheets applied', String(document.styleSheets.length));
            add('script load failures', B.failed.length ? B.failed.join(', ') : 'none');
            if (B.jsErrors.length) add('script errors', B.jsErrors.join(' | '));
            try {
                var nav = performance.getEntriesByType('navigation')[0];
                if (nav) {
                    add('html received', ms(nav.responseEnd));
                    add('DOM parsed', ms(nav.domContentLoadedEventEnd || B.dcl));
                    if (nav.loadEventEnd || B.load) add('load event', ms(nav.loadEventEnd || B.load));
                }
                var base = '';
                try { base = chrome.runtime.getURL(''); } catch (e2) {}
                var res = performance.getEntriesByType('resource').filter(function (r) {
                    var n = r.name || '';
                    return (base && n.indexOf(base) === 0) || !/^https?:/.test(n);   // ours, not favicons
                });
                if (!res.length) add('resource entries', 'none reported by this browser');
                for (var i = 0; i < res.length; i++) {
                    var r = res[i];
                    var name = (r.name || '').split('/').pop().split('?')[0];
                    var size = r.encodedBodySize || r.transferSize || 0;
                    add('  ' + name, ms(r.duration) + (size ? ' · ' + size + ' B' : '') +
                        (r.responseStatus ? ' · HTTP ' + r.responseStatus : ''));
                }
            } catch (e3) { add('timing error', String((e3 && e3.message) || e3)); }
            add('first render done', B.rendered ? ms(B.rendered) + ' after open' : 'not yet');
            return L;
        };
    } catch (e) {}
})();
