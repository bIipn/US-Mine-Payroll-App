/**
 * A key that must never be built into the dashboard: a secret key, or one of
 * the older JWT keys made for the service role. Either one gets past the row
 * level security that keeps one company's records from another's, and anyone
 * who opens the page could read it out. The app has the same check for its own
 * build (src/domain/server.ts); vite.config.ts stops a build that names one.
 */
export function isSecretKey(key: string): boolean {
  if (/^sb_secret_/i.test(key.trim())) return true;
  const parts = key.trim().split('.');
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}
