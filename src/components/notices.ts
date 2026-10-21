// Messages for the reader — errors, mostly — shown for a few seconds at the
// bottom of the window (NoticeHost). window.alert never shows in the desktop
// app's webview (it returns at once, showing nothing), so whatever would
// have used it comes here instead.

export interface Notice {
  id: number;
  text: string;
}

const SHOWN_MS = 8000;
const MAX_SHOWN = 3;

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<(notices: Notice[]) => void>();

function emit() {
  for (const listener of listeners) listener(notices);
}

export function showNotice(text: string): void {
  const notice = { id: nextId++, text };
  notices = [...notices, notice].slice(-MAX_SHOWN);
  emit();
  window.setTimeout(() => dismissNotice(notice.id), SHOWN_MS);
}

export function dismissNotice(id: number): void {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  emit();
}

export function currentNotices(): Notice[] {
  return notices;
}

export function subscribeNotices(listener: (notices: Notice[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
