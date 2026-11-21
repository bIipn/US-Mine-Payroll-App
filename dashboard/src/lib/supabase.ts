import { createClient } from '@supabase/supabase-js';

import { SUPABASE_KEY, SUPABASE_URL } from './config';

/**
 * What the address said when the page opened, read before the client below
 * looks at it: a link from an email comes back with a code to sign in with, or
 * with an error when the link has expired or was used already.
 */
export const arrivedWith = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of new URLSearchParams(window.location.hash.replace(/^#/, ''))) params.set(k, v);
    return {
      code: params.has('code'),
      error: params.get('error_code') || params.get('error') || null,
      errorText: params.get('error_description'),
    };
  } catch {
    return { code: false, error: null, errorText: null };
  }
})();

/**
 * One client for the whole dashboard. The session is kept by Supabase in this
 * browser's storage; the dashboard never stores or logs a password itself.
 *
 * Links from the sign-in emails use the PKCE flow: the link carries a code that
 * only the browser that asked for it can turn into a session, because the other
 * half of it was kept here when the email was asked for. A link someone else
 * made for their own account signs nobody in on this browser.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Take what a link left in the address off it, once the page has read it. */
export function tidyAddress(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of ['code', 'error', 'error_code', 'error_description', 'sb_flow_id', 'deleted']) url.searchParams.delete(key);
    if (/(^|&)(error|error_code|error_description|access_token)=/.test(url.hash.replace(/^#/, ''))) url.hash = '';
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Nothing to tidy.
  }
}
