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
