// What MineMuster's edge functions share: the project's address and its keys, from the environment
// Supabase gives every edge function, and the headers each key goes in. Supabase leaves a folder named
// _shared out of the functions it deploys, and bundles what a function imports from it.
//
// The server key is the "default" entry of SUPABASE_SECRET_KEYS (an sb_secret_... key, sent as apikey
// only, as Supabase asks), or else the legacy SUPABASE_SERVICE_ROLE_KEY (a JWT, sent as apikey and as
// the bearer token). The publishable key, for calls made with a person's own token, is the "default"
// entry of SUPABASE_PUBLISHABLE_KEYS, or else the legacy SUPABASE_ANON_KEY. No key is ever written to a
// log.

/** An environment variable, or undefined. */
export type Env = (name: string) => string | undefined;

export interface Server {
  url: string;
  key: string;
}

/** The "default" key of a JSON object of keys, as SUPABASE_SECRET_KEYS and SUPABASE_PUBLISHABLE_KEYS hold them. */
function defaultKey(named: string | undefined): string {
  if (!named || !named.trim()) return '';
  try {
    const keys: unknown = JSON.parse(named);
    const first = keys && typeof keys === 'object' ? (keys as Record<string, unknown>).default : undefined;
    return typeof first === 'string' ? first.trim() : '';
  } catch {
    // Not JSON: the legacy key is read instead.
    return '';
  }
}

/** The project's address, or null when it is not one. */
function projectUrl(env: Env): string | null {
  const url = (env('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** The project's URL and server key from the environment, or null when either is missing. */
export function serverFrom(env: Env): Server | null {
  const url = projectUrl(env);
  if (!url) return null;
  const key = defaultKey(env('SUPABASE_SECRET_KEYS')) || (env('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  return key ? { url, key } : null;
}

/** The project's publishable key, or null when there is none. */
export function publishableKeyFrom(env: Env): string | null {
  const key = defaultKey(env('SUPABASE_PUBLISHABLE_KEYS')) || (env('SUPABASE_ANON_KEY') ?? '').trim();
  return key || null;
}

/** The headers PostgREST and Supabase Auth take the server key in: a secret key as apikey only, a legacy JWT as both. */
export function keyHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}
