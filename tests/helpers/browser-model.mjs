// A tiny model of tabs/windows/groups that records every call in order.
export function browserModel({ groupsWork = true, existingWindows = [1] } = {}) {
    let nextTab = 100, nextWin = 50, nextGroup = 7;
    const log = [];
    const windows = new Set(existingWindows);
    const tabsById = new Map();
    const mkTab = (url, windowId, active = false) => {
        const t = { id: nextTab++, url, windowId, active, groupId: -1, index: tabsById.size };
        tabsById.set(t.id, t); return t;
    };
    const tabsApi = {
        create: async (p) => { const t = mkTab(p.url, p.windowId || 1, !!p.active); log.push(['create', t.id, p.url, p.windowId]); return { ...t }; },
        discard: async (id) => { log.push(['discard', id]); return { ...tabsById.get(id), discarded: true }; },
        group: async (o) => {
            if (!groupsWork) { log.push(['group-refused']); throw new Error('Grouping is not supported'); }
            const gid = o.groupId != null ? o.groupId : nextGroup++;
            [].concat(o.tabIds).forEach(id => { const t = tabsById.get(id); if (t) t.groupId = gid; });
            log.push(['group', gid, [].concat(o.tabIds)]); return gid;
        },
        move: async (ids, p) => { log.push(['move', [].concat(ids), p.windowId]); return []; },
        query: async () => [...tabsById.values()].map(t => ({ ...t })),
        get: async (id) => ({ ...tabsById.get(id) }),
        update: async () => ({})
    };
    const windowsApi = {
        create: async (p) => {
            const id = nextWin++; windows.add(id);
            const urls = p.url ? [].concat(p.url) : [];
            const made = urls.map((u, i) => mkTab(u, id, i === 0));
            if (p.tabId != null) { const t = tabsById.get(p.tabId); if (t) { t.windowId = id; made.push(t); } }
            log.push(['windowCreate', id, urls, p.focused]);
            return { id, tabs: made.map(t => ({ ...t })) };
        },
        get: async (id) => { if (!windows.has(id)) throw new Error('No window with id: ' + id); return { id }; },
        getAll: async () => [...windows].map(id => ({ id }))
    };
    const tabGroupsApi = {
        update: async (gid, p) => { log.push(['groupUpdate', gid, p.title, p.color]); return {}; },
        query: async () => []
    };
    return { log, tabsById, opts: { tabs: tabsApi, windows: windowsApi, tabGroups: tabGroupsApi } };
}
