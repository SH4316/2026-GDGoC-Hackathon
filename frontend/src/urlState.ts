import { useMemo, useSyncExternalStore } from 'react';

export type QueryChanges = Record<string, string | number | null>;
export type HistoryMode = 'push' | 'replace';
const changed = 'station-url-change';

export function withQuery(url: URL, changes: QueryChanges) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.searchParams.delete(key);
    else next.searchParams.set(key, String(value));
  }
  return next;
}

export function updateUrl(changes: QueryChanges, mode: HistoryMode = 'replace') {
  const next = withQuery(new URL(location.href), changes);
  if (next.href === location.href) return;
  if (mode === 'push') history.pushState({ stationParent: location.href }, '', next);
  else history.replaceState(history.state, '', next);
  window.dispatchEvent(new Event(changed));
}

// A directly opened dialog has no in-app parent. Close it on the same page in that case.
export function closeOverlay(changes: QueryChanges) {
  if (history.state?.stationParent === withQuery(new URL(location.href), changes).href) history.back();
  else updateUrl(changes);
}

export function subscribeUrl(notify: () => void) {
  window.addEventListener('popstate', notify);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener(changed, notify);
  };
}

export function useQuery() {
  const search = useSyncExternalStore(subscribeUrl, () => location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}
