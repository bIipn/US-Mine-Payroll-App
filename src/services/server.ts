import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { SERVER } from '../config';
import type { DeletionAnswer, DeletionCheckCompany } from '../domain/accountDeletion';
import { PASSCODE_MAX, PASSCODE_MIN, passcodeProblem } from '../domain/passcode';
import {
  authWords,
  crewWords,
  deletionAnswerWords,
  pushTrouble,
  readCompanies,
  readCrewAnswer,
  readDeletionAnswer,
  readDeletionCheck,
  readCompanyRow,
  readPushAnswer,
  readRows,
  readStanding,
  readWaitingRequests,
  serverWords,
  settleDeletion,
  type CrewAction,
  type CrewAnswer,
  type CrewFields,
  type CrewSession,
  type ServerCompany,
  type ServerProblem,
  type WaitingRequest,
} from '../domain/serverAnswers';
import { callWithin, SEND_TIMEOUT_MS, sendError, type SyncTransport } from '../domain/sync';
import { safeStorage } from './storage';

/**
 * The company's server, a Supabase project: signing in (with email, or as
 * crew with the company's code, a name and a passcode, which crew-auth joins
 * to the company), finding the account's company, and sending this phone's
 * records.
 *
 * Only a build that names a server has this file at all: `connection.ts`
 * loads it when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are both
 * set and the build is not a preview (EXPO_PUBLIC_DEMO=0), so a build without
 * them carries none of it and none of supabase-js.
 *
 * The session (the tokens Supabase hands back at sign-in) is kept on the
 * phone in the app's own storage, so the phone stays signed in: through a
 * restart, days with no signal and an access token that has expired, which
 * supabase-js refreshes once there is signal. Nothing here signs this phone
 * out but `signOut`; `signOutOtherSessions` signs out only the account's other
 * sessions, after a new passcode. A password is sent to Supabase and a passcode
 * to crew-auth, and nowhere else; neither is ever written down on the phone.
 *
 * React Native needs no URL polyfill here: Expo's runtime puts a standard URL
 * and fetch on iOS and Android (expo/src/winter), and the browser has its own.
 */

export type Done<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Whether this build names a server the phone can talk to. */
export const configured = SERVER != null;

/**
 * Where a client keeps the session: where the app keeps everything else, which falls back to memory where a
 * browser frame blocks storage. Each client has its own way in, shut when the client is let go (`signOut`),
 * so what that client still has under way, a sign-out or a refresh answered late, can neither put the
 * session back on the phone nor take off one kept since.
 */
function sessionStore() {
  let open = true;
  return {
    shut: () => {
      open = false;
    },
    storage: {
      getItem: async (key: string): Promise<string | null> => (open ? ((await safeStorage.getItem(key)) ?? null) : null),
      setItem: async (key: string, value: string): Promise<void> => {
        if (open) await safeStorage.setItem(key, value);
      },
      removeItem: async (key: string): Promise<void> => {
        if (open) await safeStorage.removeItem(key);
      },
    },
  };
}

/** Where supabase-js keeps the session on the phone. */
const SESSION_KEY = 'minemuster-server-session';

/**
 * The longest one request supabase-js makes may take, from asking to the last of its answer: 30 seconds, as
 * for a send; and for an edge function a little more than delete-account's own minute (DELETE_TIMEOUT_MS,
 * which functions-js applies with its own signal), so that one is what ends it.
 */
export function requestLimitMs(url: string): number {
  return url.includes('/functions/v1/') ? DELETE_TIMEOUT_MS + 5_000 : SEND_TIMEOUT_MS;
}

/**
 * The fetch supabase-js is given, for every request it makes: signing in, refreshing the session, the
 * server's functions and tables, delete-account. It gives up after `requestLimitMs`. Android's own fetch
 * never does (OkHttp waits with no limit), so with one bar of signal a request whose answer stopped coming
 * would wait for ever, and supabase-js makes every call after it wait on it: one refresh that never ends
 * holds every round of sending. Given up, a request fails as one with no signal does, and is put in the same
 * words. The time runs to the last of the answer, so one that stops halfway through is given up too; a
 * caller's own signal (a round's, delete-account's) still stops it sooner. AbortSignal.any is not used:
 * Hermes may not have it.
 */
export const timedFetch: typeof fetch = (input, init) => {
  if (typeof AbortController !== 'function') return fetch(input, init);
  const request = typeof input === 'object' && 'url' in input ? input : null;
  const url = typeof input === 'string' ? input : request ? request.url : String(input);
  const outer = init?.signal ?? request?.signal ?? null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const over = () => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  };
  // Not cleared when the answer starts: stopping a request that is over does nothing.
  const timer = setTimeout(() => {
    stop();
    over();
  }, requestLimitMs(url));
  if (outer?.aborted) stop();
  else outer?.addEventListener('abort', stop);
  return fetch(input, { ...init, signal: controller.signal }).catch((error: unknown) => {
    over();
    throw error;
  });
};

/** How long the phone waits for the server to answer its sign-out before it takes the session off the phone without that answer. */
export const SIGN_OUT_WAIT_MS = 10_000;

let client: SupabaseClient | null = null;
let watching: { unsubscribe(): void } | null = null;
let listeningToApp = false;
/** How to shut each client's way into the phone's storage, once it is let go. */
const shutters = new WeakMap<SupabaseClient, () => void>();

function api(): SupabaseClient {
  if (!SERVER) throw new Error('This build names no company server.');
  if (!client) {
    const kept = sessionStore();
    client = createClient(SERVER.url, SERVER.key, {
      auth: {
        storage: kept.storage,
        storageKey: SESSION_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // Nothing comes back to the app through a link: an email is confirmed in the browser, then the person signs in here.
        detectSessionInUrl: false,
      },
      global: { fetch: timedFetch },
    });
    shutters.set(client, kept.shut);
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // The first reading is made by `onAccountChange` itself: with no signal, supabase-js reports
      // a session it cannot refresh as none, though it is still on the phone and still theirs.
      if (event === 'INITIAL_SESSION') return;
      tell(session?.user ? accountOf(session.user) : null);
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

/** A call that got no answer: no signal, or the server could not be reached. */
const noAnswer = (problem: ServerProblem) => problem.name === 'AuthRetryableFetchError' || problem.status === 0;

// ---- The account ------------------------------------------------------------------------

/** The account signed in to the server on this phone. */
export interface ServerAccount {
  id: string;
  /**
   * Its email, for an account that signs in with one. Empty for a passcode account: its address on the
   * server is a hidden one that nobody reads or types, and the app is never handed it (accountOf), so no
   * screen, message or record on the phone can show it.
   */
  email: string;
  /** How it signs in: a crew member's company code, name and passcode, or an email and a password. */
  kind: 'passcode' | 'email';
}

/**
 * The account a Supabase Auth user is. crew-auth makes each crew member's account with
 * app_metadata.sign_in 'passcode'; only the server writes app_metadata, so nobody can change it
 * from a phone. A passcode account's hidden address is left behind here: nothing on the phone needs it.
 */
function accountOf(user: { id: string; email?: string | null; app_metadata?: unknown }, email = ''): ServerAccount {
  const meta = user.app_metadata && typeof user.app_metadata === 'object' ? (user.app_metadata as { sign_in?: unknown }) : {};
  if (meta.sign_in === 'passcode') return { id: user.id, email: '', kind: 'passcode' };
  return { id: user.id, email: user.email ?? email, kind: 'email' };
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
  if (user) return accountOf(user);
  if (error && problemOf(error).name === 'AuthRetryableFetchError') {
    try {
      const kept = JSON.parse((await safeStorage.getItem(SESSION_KEY)) ?? 'null') as { user?: { id?: unknown; email?: unknown; app_metadata?: unknown } } | null;
      const { id, email, app_metadata } = kept?.user ?? {};
      if (typeof id === 'string') return accountOf({ id, email: typeof email === 'string' ? email : '', app_metadata });
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
    return { ok: true, account: accountOf(data.session.user, address) };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/**
 * Sign this phone out of the server. Only this phone: the person stays signed
 * in anywhere else. With no signal and an expired session, supabase-js keeps
 * the session (it cannot refresh it to sign out with) and would sign the phone
 * back in once there is signal, so the session is taken off the phone here
 * whatever the server answered, and the client that held it is let go. The
 * server's answer is waited for only SIGN_OUT_WAIT_MS: with signal that stops
 * halfway it may not come for a long time, and signing out of the server is
 * only the server's side of it.
 */
export async function signOut(): Promise<void> {
  let held: SupabaseClient | null = null;
  let gaveUp: ReturnType<typeof setTimeout> | undefined;
  try {
    held = api();
    await Promise.race([
      held.auth.signOut({ scope: 'local' }),
      new Promise<void>((waited) => {
        gaveUp = setTimeout(waited, SIGN_OUT_WAIT_MS);
      }),
    ]);
  } catch {
    // No signal: the session is taken off the phone below all the same.
  } finally {
    clearTimeout(gaveUp);
  }
  // Shut first, so a sign-out or a refresh still under way cannot put the session back once it is gone.
  if (held) shutters.get(held)?.();
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

// ---- Crew sign-in by passcode -----------------------------------------------------------

/**
 * Ask the crew-auth edge function (supabase/functions/crew-auth): look up a company code; sign up or
 * sign in with the code, a name and a passcode; set a new passcode with a supervisor's reset code; or
 * confirm the passcode of the account signed in here, whose access token is then the `bearer`. The
 * body is the action and exactly the fields given: each action's own, under the server's names
 * (`CrewFields`), as crew-auth takes no other. Nothing here sets an Origin, and on iOS and Android
 * the request goes with none. A browser adds one, which crew-auth turns down as a web page's, so
 * passcode sign-in is offered on iOS and Android only. With no answer in 30 seconds the request is
 * aborted and, as with no signal, the server could not be reached.
 */
export async function crewAuth<A extends CrewAction>(action: A, body: CrewFields[A], bearer?: string): Promise<CrewAnswer> {
  if (!SERVER) throw new Error('This build names no company server.');
  const { url, key } = SERVER;
  let answered: { status: number; text: string };
  try {
    answered = await callWithin(async (signal) => {
      const response = await fetch(`${url}/functions/v1/crew-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: key, ...(bearer ? { Authorization: `Bearer ${bearer}` } : null) },
        body: JSON.stringify({ ...body, action }),
        signal,
      });
      return { status: response.status, text: await response.text() };
    }, SEND_TIMEOUT_MS);
  } catch {
    return { kind: 'unreachable' };
  }
  let read: unknown = null;
  try {
    read = JSON.parse(answered.text);
  } catch {
    // Not JSON (a gateway's page, say): the status alone is read.
  }
  return readCrewAnswer(answered.status, read);
}

/**
 * Keep a session crew-auth answered as this phone's own. supabase-js keeps it in the app's storage
 * and refreshes it from then on, as it does one from signing in with email, so the person stays
 * signed in. The account comes back as the server has it, with its kind.
 */
export async function startCrewSession(session: CrewSession): Promise<Done<{ account: ServerAccount }>> {
  const kept = await keepSession(session);
  return 'account' in kept ? { ok: true, account: kept.account } : { ok: false, error: authWords(kept.problem) };
}

/**
 * Sign out every other session of the account signed in here, and keep this phone's, so a lost or old
 * phone stops working once a passcode is new. crew-auth's reset does this itself; the phone does it when
 * crew-auth could not: a reset answered with others_signed_out false, or one answered passcode_changed,
 * and then the sign-in made with the new passcode. supabase-js keeps the session on the phone for this
 * scope, so nobody is signed out here.
 */
export async function signOutOtherSessions(): Promise<Done> {
  try {
    const { error } = await api().auth.signOut({ scope: 'others' });
    return error ? { ok: false, error: authWords(problemOf(error)) } : { ok: true };
  } catch (error) {
    return { ok: false, error: authWords(problemOf(error)) };
  }
}

/** Hand supabase-js a session crew-auth answered: the account it is, or what went wrong. */
async function keepSession(session: CrewSession): Promise<{ account: ServerAccount } | { problem: ServerProblem }> {
  try {
    const { data, error } = await api().auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken });
    const user = data.user ?? data.session?.user;
    return !error && user ? { account: accountOf(user) } : { problem: problemOf(error) };
  } catch (error) {
    return { problem: problemOf(error) };
  }
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

// ---- Sending and receiving records ----------------------------------------------------------

type Answer = { data: unknown; error: unknown; status?: number };
type Call = PromiseLike<Answer> & { abortSignal?(signal: AbortSignal): PromiseLike<Answer> };

/**
 * A session that can be used now, or a SendError saying why there is none. With
 * no signal to refresh an expired one the call waits for signal; a session the
 * server no longer takes means signing in again. Nothing is sent or read
 * without one: supabase-js would make the call under the publishable key alone.
 */
async function usableSession() {
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
  return found.data.session;
}

/** The answer's data, or the SendError saying why there is none. The status is on the answer, not on its error: a server that is down says so with it. */
async function answered(call: Call, signal?: AbortSignal): Promise<unknown> {
  let answer: Answer;
  try {
    answer = await (signal && call.abortSignal ? call.abortSignal(signal) : call);
  } catch (error) {
    throw pushTrouble(problemOf(error));
  }
  if (answer.error) throw pushTrouble({ ...problemOf(answer.error), ...(answer.status ? { status: answer.status } : null) });
  return answer.data;
}

/**
 * The company's server, for the round in `sync.ts`: it sends a batch of records
 * with push_records and answers what became of each; it reads the company's
 * settings, roster, fleet and area sheets after a cursor with
 * read_shared_records; it reads this phone's sign-in's own row of the roster
 * (none: not on the roster); and it reads the company's own row, for a company
 * that never sent its settings. Anything that goes wrong throws, saying why
 * (`SendTrouble`), and the round is tried again later.
 */
export function companyTransport(companyId: string): SyncTransport {
  return {
    company: companyId,
    async push(changes, signal) {
      await usableSession();
      return readPushAnswer(await answered(api().rpc('push_records', { company_id: companyId, changes }), signal), changes);
    },
    async pull(after, max, signal) {
      await usableSession();
      return readRows(await answered(api().rpc('read_shared_records', { company_id: companyId, after, max }), signal));
    },
    async standing(signal) {
      const session = await usableSession();
      const read = api().from('roster').select('first_name,last_name,role').eq('company_id', companyId).eq('user_id', session.user.id).maybeSingle();
      return readStanding(await answered(read as unknown as Call, signal));
    },
    async companyRow(signal) {
      await usableSession();
      const read = api().from('companies').select('name,state,pay_period').eq('id', companyId).maybeSingle();
      return readCompanyRow(await answered(read as unknown as Call, signal));
    },
  };
}

/** The transport's name before the phones received. */
export const pushTransport = companyTransport;

// ---- Deleting the company sign-in ----------------------------------------------------------

/** How long the phone waits for the server to delete the account before it says it could not be reached. */
export const DELETE_TIMEOUT_MS = 60_000;

/**
 * What deleting the signed-in account means in each of its companies (account_deletion_check): the
 * role there, whether it is the company's last supervisor, who could take over, and whether a
 * subscription still runs. Asked only with a session, never under the publishable key alone.
 */
export async function deletionCheck(): Promise<Done<{ companies: DeletionCheckCompany[] }>> {
  try {
    const { data: found } = await api().auth.getSession();
    if (!found.session) return { ok: false, error: 'You are signed out of the company server.' };
    const { data, error } = await api().rpc('account_deletion_check');
    if (error) return { ok: false, error: serverWords(problemOf(error)) };
    const companies = readDeletionCheck(data);
    return companies ? { ok: true, companies } : { ok: false, error: 'The server answered in a way this phone does not understand.' };
  } catch (error) {
    return { ok: false, error: serverWords(problemOf(error)) };
  }
}

/**
 * Whether Supabase Auth still has the account of the session this phone holds: 'gone' once it was
 * deleted, 'there' while it has it, and 'unknown' when it could not say.
 */
async function accountState(): Promise<'gone' | 'there' | 'unknown'> {
  try {
    const { data, error } = await api().auth.getUser();
    if (!error && data.user) return 'there';
    return problemOf(error).code === 'user_not_found' ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What became of a deletion: deleted, and the companies closed with it; or why not, in words for the person. */
type Deletion = { ok: true; closed: string[] } | { ok: false; answer: DeletionAnswer; error: string };

/**
 * Delete this phone's company sign-in from MineMuster's server, for good. The password is checked
 * first by signing in with it again, which also gives the server a sign-in made just now: the
 * delete-account function deletes an account only within ten minutes of its password. The request
 * names nothing; the server deletes the account the session is. The phone is still signed in
 * afterwards, to an account that is gone: `connection.ts` stops sending and signs it out.
 */
export async function deleteAccount(email: string, password: string): Promise<Deletion> {
  const address = email.trim().toLowerCase();
  const fail = (answer: DeletionAnswer) => ({ ok: false as const, answer, error: deletionAnswerWords(answer, { email: address }) });
  try {
    const { data, error } = await api().auth.signInWithPassword({ email: address, password });
    if (error || !data.session) {
      const problem = problemOf(error);
      if (noAnswer(problem)) return fail({ kind: 'unreachable' });
      if (problem.status === 429 || problem.code === 'over_request_rate_limit') return fail({ kind: 'too_many' });
      // Supabase Auth answers a deleted account's password as it answers a wrong one.
      return fail((await accountState()) === 'gone' ? { kind: 'already_deleted' } : { kind: 'wrong_password' });
    }
  } catch {
    return fail({ kind: 'unreachable' });
  }
  return deleteSignedIn(fail);
}

/**
 * Delete this phone's passcode sign-in (a crew member's, which crew-auth made) from MineMuster's
 * server, for good. crew-auth's confirm checks the passcode of the account signed in here and
 * answers a session made just now with the account's own password, as delete-account asks; the
 * phone keeps that session, and asks delete-account as `deleteAccount` does, with the same answers.
 * Nothing is deleted until the passcode is right, and a wrong or locked one is told in the crew
 * sign-in's own words. As after a password, `connection.ts` stops sending and signs out.
 */
export async function deleteAccountWithPasscode(passcode: string): Promise<Deletion> {
  // No address and no password is named: a passcode account's address is hidden, and a wrong or locked
  // passcode has the crew sign-in's own words.
  const fail = (answer: DeletionAnswer, error = deletionAnswerWords(answer, { passcode: true })) => ({ ok: false as const, answer, error });
  // A passcode that cannot be one is not sent, so it never counts as a wrong try. One the server would
  // turn down as easy to guess may still be someone's, so it goes.
  const shape = passcodeProblem(passcode);
  if (shape && shape !== 'easy') return fail({ kind: 'wrong_password' }, `Your passcode is ${PASSCODE_MIN} to ${PASSCODE_MAX} digits. Type the one you sign in with.`);
  let mine: { token: string; id: string };
  try {
    const { data, error } = await api().auth.getSession();
    if (!data.session) return fail(error && noAnswer(problemOf(error)) ? { kind: 'unreachable' } : { kind: 'signed_out' });
    mine = { token: data.session.access_token, id: data.session.user.id };
  } catch {
    return fail({ kind: 'unreachable' });
  }
  const confirmed = await crewAuth('confirm', { passcode }, mine.token);
  if (confirmed.kind !== 'signed_in') {
    const { answer, words } = unconfirmed(confirmed);
    return fail(answer, words);
  }
  // What is deleted is the account signed in here: a session for any other is never taken, nor
  // deleted with if supabase-js finds it is another's.
  if (confirmed.session.userId !== mine.id) return fail({ kind: 'try_again', closed: [] });
  const kept = await keepSession(confirmed.session);
  if ('problem' in kept) return fail(noAnswer(kept.problem) ? { kind: 'unreachable' } : { kind: 'try_again', closed: [] });
  if (kept.account.id !== mine.id) return fail({ kind: 'try_again', closed: [] });
  return deleteSignedIn(fail);
}

/**
 * What a confirm that did not sign in means for the deletion: nothing was deleted. crew-auth's 401
 * and 410 say what delete-account's do, and get deletion's own reasons and words; a wrong or locked
 * passcode gets the crew sign-in's words.
 */
function unconfirmed(answer: Exclude<CrewAnswer, { kind: 'signed_in' }>): { answer: DeletionAnswer; words?: string } {
  const told = ({ title, body }: { title: string; body?: string }) => (body ? `${title}. ${body}` : `${title}.`);
  switch (answer.kind) {
    case 'wrong':
      return { answer: { kind: 'wrong_password' }, words: told(crewWords(answer, Date.now())) };
    case 'locked':
      return { answer: { kind: 'too_many' }, words: told(crewWords(answer, Date.now())) };
    case 'busy':
      return { answer: { kind: 'too_many' } };
    case 'unreachable':
      return { answer: { kind: 'unreachable' } };
    case 'signed_out':
      return { answer: { kind: 'signed_out' } };
    case 'already_deleted':
      return { answer: { kind: 'already_deleted' } };
    default:
      return { answer: { kind: 'try_again', closed: [] } };
  }
}

/**
 * Ask delete-account to delete the account of the session on the phone, which was made just now with
 * the person's own password or passcode.
 */
async function deleteSignedIn(fail: (answer: DeletionAnswer) => Deletion): Promise<Deletion> {
  // What the person is told has to be true. An answer that does not say whether the account is still
  // there is checked with Supabase Auth first (settleDeletion): gone is deleted, and "Nothing was
  // deleted" only when nothing can have been.
  const settle = async (answer: DeletionAnswer) => {
    const settled = await settleDeletion(answer, accountState);
    return settled.kind === 'deleted' ? { ok: true as const, closed: settled.closed } : fail(settled);
  };
  try {
    const { data, error } = await api().functions.invoke('delete-account', { body: {}, timeout: DELETE_TIMEOUT_MS });
    if (!error) return settle(readDeletionAnswer(200, data));
    const reply = (error as { name?: unknown; context?: unknown }).context as { status?: unknown; json?: () => Promise<unknown> } | undefined;
    if ((error as { name?: unknown }).name === 'FunctionsHttpError' && reply && typeof reply.status === 'number') {
      const body = typeof reply.json === 'function' ? await reply.json().catch(() => null) : null;
      return settle(readDeletionAnswer(reply.status, body));
    }
    // FunctionsFetchError (no answer, or the phone gave up waiting) or FunctionsRelayError: the request
    // may have reached the function, so whether the sign-in was deleted is not known yet.
    return settle({ kind: 'not_known', closed: [] });
  } catch {
    return settle({ kind: 'not_known', closed: [] });
  }
}
