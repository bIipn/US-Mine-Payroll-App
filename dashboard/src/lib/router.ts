import { useEffect, useState } from 'react';

/**
 * A small router over the browser's own history. Every address is served the
 * same index.html (vercel.json), and the page reads which screen from the path.
 */

export interface Location {
  path: string;
  query: URLSearchParams;
}

const read = (): Location => ({ path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search) });

const listeners = new Set<() => void>();

export function go(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  listeners.forEach((l) => l());
  if (!options.replace) window.scrollTo(0, 0);
}

export function useLocation(): Location {
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return location;
}

/** `/exams/:id` against `/exams/abc` gives `{ id: 'abc' }`; no match gives null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      // A malformed escape in a typed or pasted address is no page, not a crash.
      try {
        params[want[i].slice(1)] = decodeURIComponent(have[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== have[i]) return null;
  }
  return params;
}

/** A link that moves within the dashboard without reloading it, and opens a new tab as any link does. */
export function onLink(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/')) return;
  event.preventDefault();
  go(href);
}
