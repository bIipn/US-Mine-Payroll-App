import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { SERVER } from '../config';
import {
  ALREADY_AN_ACCOUNT,
  authWords,
  pushTrouble,
  readCompanies,
  readJoinAnswer,
  readPushAnswer,
  readWaitingRequests,
  serverWords,
  type JoinAnswer,
  type ServerCompany,
  type ServerProblem,
  type WaitingRequest,
} from '../domain/serverAnswers';
import { sendError, type SyncTransport } from '../domain/sync';
import { safeStorage } from './storage';

/**
 * The company's server, a Supabase project: signing in, joining the company,
 * and sending this phone's records.
 *
 * Only a build that names a server has this file at all: `connection.ts`
 * loads it when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are both
 * set and the build is not a preview (EXPO_PUBLIC_DEMO=0), so a build without
 * them carries none of it and none of supabase-js.
 *
 * The session (the tokens Supabase hands back at sign-in) is kept on the
 * phone in the app's own storage, so the phone stays signed in. A password is
 * sent to Supabase and nowhere else; it is never written down on the phone.
 *
 * React Native needs no URL polyfill here: Expo's runtime puts a standard URL
 * and fetch on iOS and Android (expo/src/winter), and the browser has its own.
 */

export type Done<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Whether this build names a server the phone can talk to. */
export const configured = SERVER != null;

/** The session is kept where the app keeps everything else, which falls back to memory where a browser frame blocks storage. */
const sessionStore = {
  getItem: async (key: string): Promise<string | null> => (await safeStorage.getItem(key)) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    await safeStorage.setItem(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    await safeStorage.removeItem(key);
  },
};

/** Where supabase-js keeps the session on the phone. */
const SESSION_KEY = 'minemuster-server-session';

let client: SupabaseClient | null = null;
let watching: { unsubscribe(): void } | null = null;
let listeningToApp = false;

function api(): SupabaseClient {
  if (!SERVER) throw new Error('This build names no company server.');
  if (!client) {
    client = createClient(SERVER.url, SERVER.key, {
      auth: {
        storage: sessionStore,
        storageKey: SESSION_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // Nothing comes back to the app through a link: an email is confirmed in the browser, then the person signs in here.
        detectSessionInUrl: false,
      },
    });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // The first reading is made by `onAccountChange` itself: with no signal, supabase-js reports
      // a session it cannot refresh as none, though it is still on the phone and still theirs.
      if (event === 'INITIAL_SESSION') return;
      tell(session?.user ? { id: session.user.id, email: session.user.email ?? '' } : null);
    });
    watching = data.subscription;
    // A phone keeps the session fresh only while the app is open. A browser does this by itself.
    if (Platform.OS !== 'web' && !listeningToApp) {
      listeningToApp = true;
      AppState.addEventListener('change', (state) => {
        if (state === 'active') void client?.auth.startAutoRefresh();
        else void client?.auth.stopAutoRefresh();
      });
    }
  }
  return client;
}

const problemOf = (error: unknown): ServerProblem => {
  if (!error || typeof error !== 'object') return { message: String(error ?? '') };
  const e = error as { code?: unknown; message?: unknown; status?: unknown; name?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    status: typeof e.status === 'number' ? e.status : undefined,
    name: typeof e.name === 'string' ? e.name : undefined,
  };
};

// ---- The account ------------------------------------------------------------------------

/** The account signed in to the server on this phone. */
export interface ServerAccount {
  id: string;
  email: string;
}

const listeners = new Set<(account: ServerAccount | null) => void>();
const tell = (account: ServerAccount | null) => listeners.forEach((heard) => heard(account));

/**
 * The account on this phone now. With no signal an expired session cannot be
 * refreshed, and supabase-js answers that there is none; it is still on the
 * phone and still that person's, and it is refreshed once there is signal, so
 * it counts as signed in.
 */
async function accountNow(): Promise<ServerAccount | null> {
  const { data, error } = await api().auth.getSession();
  const user = data.session?.user;
  if (user) return { id: user.id, email: user.email ?? '' };
  if (error && problemOf(error).name === 'AuthRetryableFetchError') {
    try {
      const kept = JSON.parse((await safeStorage.getItem(SESSION_KEY)) ?? 'null') as { user?: { id?: unknown; email?: unknown } } | null;
      if (kept?.user && typeof kept.user.id === 'string') return { id: kept.user.id, email: typeof kept.user.email === 'string' ? kept.user.email : '' };
    } catch {
      // Not a session this phone can read: nobody is signed in.
    }
  }
  return null;
}

/** Hear which account is signed in: straight away, and whenever it changes. Returns a function that stops listening. */
export function onAccountChange(heard: (account: ServerAccount | null) => void): () => void {
  let live = true;
  let changed = false;
  const listener = (account: ServerAccount | null) => {
    changed = true;
    if (live) heard(account);
  };
  listeners.add(listener);
  accountNow().then(
    (account) => live && !changed && heard(account),
    () => live && !changed && heard(null),
  );
  return () => {
    live = false;
    listeners.delete(listener);
  };
}

export async function signIn(email: string, password: string): Promise<Done<{ account: ServerAccount }>> {
  const address = email.trim().toLowerCase();
  try {
    const { data, error } = await api().auth.signInWithPassword({ email: address, password });
    if (error || !data.session) return { ok: false, error: authWords(problemOf(error)) };
    return { ok: true, account: { id: data.session.user.id, email: data.session.user.email ?? address } };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/**
 * Make an account. The server may ask for the email to be confirmed first: then
 * there is no session yet (`confirm`), and the person signs in once they have
 * opened the link.
 */
export async function signUp(email: string, password: string): Promise<Done<{ confirm: boolean }>> {
  try {
    const { data, error } = await api().auth.signUp({ email: email.trim().toLowerCase(), password });
    if (error) return { ok: false, error: authWords(problemOf(error)) };
    // With email confirmation on, the server answers an address that already has an account as if it
    // were new, with a user that has no identities, and sends no email.
    if (!data.session && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return { ok: false, error: ALREADY_AN_ACCOUNT };
    }
    return { ok: true, confirm: !data.session };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/** Send the link that confirms a new account's email again. */
export async function resendConfirmation(email: string): Promise<Done> {
  try {
    const { error } = await api().auth.resend({ type: 'signup', email: email.trim().toLowerCase() });
    return error ? { ok: false, error: authWords(problemOf(error)) } : { ok: true };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/** Send a link to set a new password. It opens in the browser, where the new password is set. */
export async function resetPassword(email: string): Promise<Done> {
  try {
    const { error } = await api().auth.resetPasswordForEmail(email.trim().toLowerCase());
    return error ? { ok: false, error: authWords(problemOf(error)) } : { ok: true };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/**
 * Sign this phone out of the server. Only this phone: the person stays signed
 * in anywhere else. With no signal and an expired session, supabase-js keeps
 * the session (it cannot refresh it to sign out with) and would sign the phone
 * back in once there is signal, so the session is taken off the phone here
 * whatever the server answered, and the client that held it is let go.
 */
export async function signOut(): Promise<void> {
  const held = client;
  try {
    await api().auth.signOut({ scope: 'local' });
  } catch {
    // No signal: the session is taken off the phone below all the same.
  }
  await forgetSession();
  if (held && client === held) {
    try {
      void held.auth.stopAutoRefresh();
    } catch {
      // Already stopped.
    }
    watching?.unsubscribe();
    watching = null;
    client = null;
  }
  tell(null);
}

/** Take every trace of the server session off the phone. */
async function forgetSession(): Promise<void> {
  const keys = new Set([SESSION_KEY, `${SESSION_KEY}-code-verifier`, `${SESSION_KEY}-user`]);
  try {
    for (const key of await AsyncStorage.getAllKeys()) if (key.startsWith(SESSION_KEY)) keys.add(key);
  } catch {
    // Storage that cannot list its keys: the ones supabase-js writes are named above.
  }
  for (const key of keys) await safeStorage.removeItem(key);
}

// ---- The company ------------------------------------------------------------------------

/** The companies the signed-in account belongs to. */
export async function myCompanies(): Promise<Done<{ companies: ServerCompany[] }>> {
  try {
    const { data, error } = await api().rpc('my_companies');
    if (error) return { ok: false, error: serverWords(problemOf(error)) };
    return { ok: true, companies: readCompanies(data) };
  } catch (error) {
    return { ok: false, error: serverWords(problemOf(error)) };
  }
}

/** The account's requests to join a company that are still waiting for a supervisor. */
export async function myJoinRequests(): Promise<Done<{ requests: WaitingRequest[] }>> {
  try {
    const { data, error } = await api().rpc('my_join_requests');
    if (error) return { ok: false, error: serverWords(problemOf(error)) };
    return { ok: true, requests: readWaitingRequests(data) };
  } catch (error) {
    return { ok: false, error: serverWords(problemOf(error)) };
  }
}

/** Ask to join the company with this join code, under the name as it is on its roster. */
export async function joinCompany(code: string, firstName: string, lastName: string): Promise<Done<{ answer: JoinAnswer }>> {
  try {
    const { data, error } = await api().rpc('join_company', { code, first_name: firstName, last_name: lastName });
    if (error) return { ok: false, error: serverWords(problemOf(error)) };
    const answer = readJoinAnswer(data);
    if (!answer) return { ok: false, error: serverWords({ code: 'unknown' }) };
    return { ok: true, answer };
  } catch (error) {
    return { ok: false, error: serverWords(problemOf(error)) };
  }
}

// ---- Sending records ----------------------------------------------------------------------

/**
 * Sends a batch of records to the company with push_records and answers with
 * what the server now has: what it took and what it will not take from this
 * account, both, so the phone stops sending either. Anything that goes wrong
 * throws, saying why (`SendTrouble`), and the round is tried again later.
 *
 * Nothing is sent without a session: with none, supabase-js would send the
 * call under the publishable key alone, and the server would turn it down.
 */
export function pushTransport(companyId: string): SyncTransport {
  return {
    company: companyId,
    async push(changes, signal) {
      // A session that can be used now. With no signal to refresh an expired one the call waits for
      // signal; a session the server no longer takes means signing in again.
      let found: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
      try {
        found = await api().auth.getSession();
      } catch (error) {
        throw pushTrouble(problemOf(error));
      }
      if (!found.data.session) {
        if (found.error && problemOf(found.error).name === 'AuthRetryableFetchError') throw pushTrouble(problemOf(found.error));
        throw sendError('signed_out', 'You are signed out of the company server.');
      }
      let answer: { data: unknown; error: unknown; status?: number };
      try {
        const call = api().rpc('push_records', { company_id: companyId, changes });
        answer = await (signal ? call.abortSignal(signal) : call);
      } catch (error) {
        throw pushTrouble(problemOf(error));
      }
      // The status is on the answer, not on its error: a server that is down says so with it.
      if (answer.error) throw pushTrouble({ ...problemOf(answer.error), ...(answer.status ? { status: answer.status } : null) });
      return readPushAnswer(answer.data, changes);
    },
  };
}
