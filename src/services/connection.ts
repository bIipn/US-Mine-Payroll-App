import { create } from 'zustand';

import { CAN_SEND } from '../config';
import { NO_SIGNAL_BLOCKER, sendable, waitingBlocker, type DeletionAnswer } from '../domain/accountDeletion';
import type { ConnectedCompany } from '../domain/server';
import { useStore } from '../store/useStore';
import type * as Server from './server';
import { setSyncTransport, syncNow, syncSettled, useSyncStatus } from './sync';

/**
 * Whether this build connects to a company server, and the connection itself.
 *
 * The server code, and supabase-js with it, is in a build only when the build
 * names a server and is not a preview. The condition below is written with the
 * settings themselves, so the bundler reads it as a constant: in a build
 * without them it is false, the `require` is dropped before the bundle is made,
 * and nothing of the server is in the app. (The public preview is one of those.)
 *
 * A preview build, and a build that holds the made-up sample crew, connects to
 * nothing even with a server named (`CAN_SEND` in `config.ts`): what a preview
 * makes up is never sent, and nor is anything else from it.
 */
const loaded: typeof Server | null =
  process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_KEY && process.env.EXPO_PUBLIC_DEMO === '0'
    ? require('./server')
    : null;

/** The server's calls, or null in a build that has no server, is a preview or holds the sample crew. */
export const server: typeof Server | null = loaded?.configured && CAN_SEND ? loaded : null;

/** Whether the Company account screen is there at all. */
export const CAN_CONNECT = server != null;

/** Who is signed in to the company server on this phone, as far as the phone knows. */
export interface AccountState {
  /** Whether the phone has looked for a saved session yet. */
  known: boolean;
  account: Server.ServerAccount | null;
  /**
   * The account signed in is not on the roster of the company this phone is
   * connected to: another person signed in, or they were taken off it. Nothing
   * is sent until the account that is on it signs in again.
   */
  notOnLinked: boolean;
  /** Checking the signed-in account against the company's roster: the phone sends once it is confirmed. */
  checking: boolean;
  /** The last check could not reach the server. */
  unchecked: boolean;
  /** The company's join code, for a supervisor to hand out. Held in memory only, never saved. */
  joinCode: string | null;
}

export const useServerAccount = create<AccountState>(() => ({
  known: false,
  account: null,
  notOnLinked: false,
  checking: false,
  unchecked: false,
  joinCode: null,
}));

/** Whether this account is the one the phone joined its company with. */
const sameAccount = (linked: ConnectedCompany, account: Server.ServerAccount) => !!linked.userId && linked.userId === account.id;

let recheck: (() => void) | null = null;

/**
 * Ask the server again whether the signed-in account is on the company's
 * roster, and with what role and name: from the account screen, and once there
 * is signal again. The answer comes back into the store and `useServerAccount`.
 */
export function checkAccount(): void {
  recheck?.();
}

/**
 * Send to the company the phone is connected to, from start-up on, while the
 * account that joined it is signed in, and stop the moment it is disconnected,
 * signed out or the device is cleared. Another account signed in is checked
 * against the company's roster first, and sends once it is on it. Returns a
 * function that stops watching.
 */
export function watchConnection(): () => void {
  if (!server) return () => undefined;
  const link = server;
  let current: string | null = null;
  let asked: string | null = null;
  let live = true;

  const apply = () => {
    if (!live) return;
    const linked = useStore.getState().connectedCompany;
    const { known, account } = useServerAccount.getState();
    const ready = !!linked && !!account && sameAccount(linked, account);
    // Connected, but not sending: its account is signed out, another account is signed in that is not on
    // the company's roster, or the phone is still finding out which. The records row says what to do.
    const why = !linked || ready ? null : known && !account ? 'signed_out' : useServerAccount.getState().notOnLinked ? 'not_member' : 'checking';
    const key = !linked ? null : ready ? `send:${linked.id}:${account!.id}` : `${why}:${linked.id}`;
    if (key !== current) {
      current = key;
      if (!linked) setSyncTransport(null);
      else if (ready) setSyncTransport(link.companyTransport(linked.id));
      else setSyncTransport(null, why);
    }
    if (linked && account && !sameAccount(linked, account)) verify(linked, account, false);
  };

  /** Whether the signed-in account is on the roster of the company the phone sends to. */
  const verify = (linked: ConnectedCompany, account: Server.ServerAccount, again: boolean) => {
    const question = `${linked.id}:${account.id}`;
    if (asked === question && !again) return;
    asked = question;
    useServerAccount.setState({ checking: true, unchecked: false });
    void link.myCompanies().then((result) => {
      const now = useStore.getState().connectedCompany;
      const who = useServerAccount.getState().account;
      if (!live || now?.id !== linked.id || who?.id !== account.id) return;
      if (!result.ok) {
        // No answer: asked again once there is signal, or from the account screen.
        asked = null;
        useServerAccount.setState({ checking: false, unchecked: true });
        return;
      }
      const found = result.companies.find((c) => c.id === linked.id);
      useServerAccount.setState({ checking: false, unchecked: false, notOnLinked: !found, joinCode: found?.joinCode ?? null });
      if (found) useStore.getState().confirmConnection({ userId: account.id, email: account.email, role: found.role, name: found.name });
      apply();
    });
  };

  recheck = () => {
    const linked = useStore.getState().connectedCompany;
    const { account } = useServerAccount.getState();
    if (linked && account) verify(linked, account, true);
  };

  /** What was learnt about one account and company counts for nothing about another. */
  const forget = () => {
    asked = null;
    useServerAccount.setState({ notOnLinked: false, checking: false, unchecked: false, joinCode: null });
  };
  const stopAccount = link.onAccountChange((account) => {
    if (useServerAccount.getState().account?.id !== account?.id) forget();
    useServerAccount.setState({ known: true, account });
    apply();
  });
  const stopStore = useStore.subscribe((now, before) => {
    if (now.connectedCompany === before.connectedCompany) return;
    if (now.connectedCompany?.id !== before.connectedCompany?.id) forget();
    apply();
  });
  // Back in range: ask again about an account the phone could not check with no signal.
  const stopSignal = useSyncStatus.subscribe((now, before) => {
    if (now.online && !before.online && asked == null) apply();
  });
  apply();
  return () => {
    live = false;
    recheck = null;
    stopAccount();
    stopStore();
    stopSignal();
    current = null;
    setSyncTransport(null);
  };
}

/**
 * Stop sending, forget the company and sign this phone out of the server. The
 * records stay on the phone. A round that was sending stops at once, and is
 * over before the phone signs out.
 */
export async function disconnect(): Promise<void> {
  useStore.getState().disconnectCompany();
  await syncSettled();
  await server?.signOut();
}

/** Why the company sign-in was not deleted: what stops it on the phone, or what the server answered. */
export type ServerDeletion = { ok: true } | { ok: false; reason: 'no_server' | 'signed_out' | 'waiting' | 'no_signal' | DeletionAnswer['kind']; error: string };

/**
 * Delete the company sign-in signed in on this phone from MineMuster's server, for good. A phone that
 * sends with it sends what waits first, while the sign-in still can, and nothing is asked of the
 * server while anything still waits. The server checks the secret, the password of a sign-in by
 * email (`server.deleteAccount`) or a crew member's passcode (`server.deleteAccountWithPasscode`), and
 * deletes the account the session is; only once it has does the phone stop sending with it and sign
 * out. Nothing of the app's own account is touched here: the screen deletes that next, from the store.
 */
export async function deleteMyServerAccount(secret: { password: string } | { passcode: string }): Promise<ServerDeletion> {
  if (!server) return { ok: false, reason: 'no_server', error: 'This build has no company server.' };
  const link = server;
  const account = useServerAccount.getState().account;
  if (!account) return { ok: false, reason: 'signed_out', error: 'Sign in to your company sign-in on Company account first.' };
  const linked = useStore.getState().connectedCompany;
  if (linked && linked.userId === account.id) {
    await syncNow();
    // Only what a round could still send holds it up: what the server will not take, or cannot be sent
    // from a sign-in off the roster or for a company MineMuster has stopped for, stays on the phone.
    const status = useSyncStatus.getState();
    const left = sendable(status);
    if (left > 0) {
      const words = waitingBlocker(left, linked.name, status.online);
      return { ok: false, reason: 'waiting', error: `${words.title}. ${words.body}` };
    }
  }
  if (!useSyncStatus.getState().online) return { ok: false, reason: 'no_signal', error: `${NO_SIGNAL_BLOCKER.title}. ${NO_SIGNAL_BLOCKER.body}` };
  const deleted = 'passcode' in secret ? await link.deleteAccountWithPasscode(secret.passcode) : await link.deleteAccount(account.email, secret.password);
  if (!deleted.ok) return { ok: false, reason: deleted.answer.kind, error: deleted.error };
  await forgetDeletedSignIn(account.id);
  return { ok: true };
}

/**
 * Once the server has deleted the company sign-in, or had deleted it already: the phone stops sending
 * with it, forgets the request to join a company it made, and signs out of it. A round on its way
 * stops at once, and is over before the phone signs out.
 */
export async function forgetDeletedSignIn(accountId: string | undefined = useServerAccount.getState().account?.id): Promise<void> {
  const store = useStore.getState();
  if (accountId && store.connectedCompany?.userId === accountId) {
    // Who the sign-in was to the company goes with it: the next account here is not made under its name.
    store.signInDeleted();
    store.disconnectCompany();
  }
  if (accountId && store.joinAsked?.accountId === accountId) store.setJoinAsked(null);
  await syncSettled();
  await server?.signOut();
}
