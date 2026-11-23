import { createClient } from '@supabase/supabase-js';

import { SUPABASE_KEY, SUPABASE_URL } from './config';

/** What the address said when the page opened. */
export interface Arrival {
  /** A link from a sign-in email brought a code, which the client below turns into a session. */
  code: boolean;
  /** Why the link signed nobody in: it has expired or was used already (otp_expired), or something else. */
  error: string | null;
  errorText: string | null;
  /** The link was the invite email's (`?invited=1`, INVITE_LINK in supervisor-tools), whether or not it still worked. */
  invited: boolean;
  /** The address held a session that is not an invitation's: it was taken off the address, and not taken. */
  refused: boolean;
}

/** The two halves of the session an invite email's link brings. */
export interface InviteTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * Read the address a link opened the page at. The links from the sign-in emails bring a code, for the client
 * below. The invite email's link is the one that brings a session itself, in the hash: Supabase Auth makes an
 * invitation on the server, where no browser kept the other half of a code. That session is taken only when the
 * address is an invitation's both ways (ruling R31): `invited=1` in the query, as the invite link has it
 * (INVITE_LINK), and Auth's `type=invite` in the hash, with both halves of the session, no code and no error. Any
 * other session in an address is not taken (`refused`): the client takes codes only, and the page says the link
 * signed nobody in. Anyone can write such an address, with a session of their own: that is why the first screen
 * after it names the address it signed in as, with a way out.
 *
 * `tidied` is the address to put in place of this one, before the client is made, when it holds a session, taken
 * or not: the same address without it, so that no session is left in the address bar for anyone to copy. Null
 * when there is nothing to take off.
 */
export function readArrival(href: string): { arrival: Arrival; invite: InviteTokens | null; tidied: string | null } {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const params = new URLSearchParams(url.search);
  for (const [k, v] of hash) params.set(k, v);
  const code = params.has('code');
  const error = params.get('error_code') || params.get('error') || null;
  const invited = url.searchParams.get('invited') === '1';
  const access = hash.get('access_token');
  const refresh = hash.get('refresh_token');
  const holdsSession = hash.has('access_token') || hash.has('refresh_token');
  const invite = invited && hash.get('type') === 'invite' && access && refresh && !code && !error ? { access_token: access, refresh_token: refresh } : null;
  const arrival: Arrival = { code, error, errorText: params.get('error_description'), invited, refused: holdsSession && !invite };
  if (!holdsSession) return { arrival, invite: null, tidied: null };
  url.searchParams.delete('invited');
  url.hash = '';
  return { arrival, invite, tidied: url.toString() };
}

/** The invitation's session, held here in memory only, until App hands it to the client (takeInviteTokens). */
let inviteTokens: InviteTokens | null = null;

/**
 * What the address said when the page opened, read before the client below looks at it: a link from an email
 * comes back with a code to sign in with, with an invitation's session, or with an error when the link has
 * expired or was used already. A session in the address is taken off it here, before the client is made: the
 * client reads the address as it is made, and would turn the session down and leave it there.
 */
export const arrivedWith: Arrival = (() => {
  try {
    const { arrival, invite, tidied } = readArrival(window.location.href);
    if (tidied) window.history.replaceState(window.history.state, '', tidied);
    inviteTokens = invite;
    return arrival;
  } catch {
    return { code: false, error: null, errorText: null, invited: false, refused: false };
  }
})();

/**
 * The session an invite email's link brought, handed over once, for App to set: a second call has none. It is
 * never written anywhere, and never logged.
 */
export function takeInviteTokens(): InviteTokens | null {
  const tokens = inviteTokens;
  inviteTokens = null;
  return tokens;
}

/**
 * One client for the whole dashboard. The session is kept by Supabase in this
 * browser's storage; the dashboard never stores or logs a password itself.
 *
 * Links from the sign-in emails use the PKCE flow: the link carries a code that
 * only the browser that asked for it can turn into a session, because the other
 * half of it was kept here when the email was asked for. A link someone else
 * made for their own account signs nobody in on this browser. The invite link is
 * the one exception (readArrival), and the first screen it opens on names the
 * address it signed in as.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Take what a link left in the address off it, once the page has read it. */
export function tidyAddress(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of ['code', 'error', 'error_code', 'error_description', 'sb_flow_id', 'deleted', 'invited']) url.searchParams.delete(key);
    if (/(^|&)(error|error_code|error_description|access_token)=/.test(url.hash.replace(/^#/, ''))) url.hash = '';
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Nothing to tidy.
  }
}
