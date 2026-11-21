/**
 * Live updates: the page reloads its data by itself, without "Обновить".
 *
 * The API sends the socket event 'changed' a moment after rows change
 * (parisahon-api/src/gateway/live-updates.subscriber.ts):
 *   { deals?: number[] | '*', events?: deal ids | '*', tasks?: deal ids | '*',
 *     companies?, emails?, calls?, triggers?, files?, stages? }
 * Only topics and ids come in; the page fetches through the normal API.
 *
 * useLive(handler) calls handler(changes) at most once per `delayMs`,
 * merges what came in meanwhile, waits while the tab is hidden, and after a
 * lost connection calls it with every topic set to '*'.
 */
export type LiveChanges = Record<string, number[] | '*'>;

const TOPICS = ['deals', 'events', 'tasks', 'companies', 'emails', 'calls', 'triggers', 'files', 'stages'];

/** true when `topic` changed for `id` (or for anything, when id is omitted) */
export function liveTouches(changes: LiveChanges, topic: string, id?: number | string | null) {
    const scope = changes[topic];
    if (!scope) return false;
    if (scope === '*' || id == null || id === '') return true;
    return scope.includes(Number(id));
}

export function useLive(handler: (changes: LiveChanges) => void, delayMs = 400) {
    if (!import.meta.client) return;
    const { $socket } = useNuxtApp() as any;
    let acc: LiveChanges = {};
    let timer: ReturnType<typeof setTimeout> | null = null;

    function merge(changes: LiveChanges) {
        for (const [topic, scope] of Object.entries(changes || {})) {
            const prev = acc[topic];
            if (prev === '*' || scope === '*') acc[topic] = '*';
            else acc[topic] = [...new Set([...(prev || []), ...scope])];
        }
    }

    function run() {
        timer = null;
        if (document.hidden) return; // picked up by onVisible
        const changes = acc;
        acc = {};
        if (Object.keys(changes).length) silently(() => handler(changes));
    }

    function onChanged(changes: LiveChanges) {
        merge(changes);
        timer ??= setTimeout(run, delayMs);
    }

    function onReconnect() {
        onChanged(Object.fromEntries(TOPICS.map((t) => [t, '*'])));
    }

    function onVisible() {
        if (!document.hidden && !timer && Object.keys(acc).length) run();
    }

    onMounted(() => {
        $socket?.on('changed', onChanged);
        $socket?.io?.on('reconnect', onReconnect);
        document.addEventListener('visibilitychange', onVisible);
    });

    onUnmounted(() => {
        $socket?.off('changed', onChanged);
        $socket?.io?.off('reconnect', onReconnect);
        document.removeEventListener('visibilitychange', onVisible);
        if (timer) clearTimeout(timer);
    });
}

/**
 * Puts the newest events of a feed (fresh = first page, newest first) into the
 * pages of a useInfiniteQuery feed: known ids are replaced in place, new ones
 * go on top of the newest page. The scroll position and older pages stay.
 */
export function mergeNewestEvents(pages: { data?: any[] }[], fresh: any[] = [], myId?: number) {
    const newest = pages[pages.length - 1];
    if (!newest) return;
    newest.data ??= [];
    const known = new Map<number, [any[], number]>();
    for (const page of pages) page?.data?.forEach((e, i) => known.set(e.id, [page.data!, i]));
    const added: any[] = [];
    for (const event of fresh) {
        const hit = known.get(event.id);
        if (hit) hit[0][hit[1]] = event;
        else added.push(event);
    }
    if (!added.length) return;
    // an event the user just sent is shown at once with a temporary negative id;
    // the real one from the server takes its place instead of appearing twice
    for (const event of added) {
        const i = newest.data.findIndex((e) => e.id < 0 && e.type === event.type
            && (myId == null || event.originated_by?.id == null || event.originated_by.id === myId));
        if (i !== -1) newest.data.splice(i, 1);
    }
    newest.data.unshift(...added.sort((a, b) => b.id - a.id));
}
