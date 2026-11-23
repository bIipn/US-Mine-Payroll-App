// The invited person's side of an invitation to supervise (ruling R31): the invite email's link, read and taken off
// the address before the Supabase client is made; how the page opens on it, or on the session this browser keeps;
// the password it asks for first, on a screen that names the address it signed in as; a link that signed nobody in,
// said first even to a browser signed in to another account; the invitations, shown before the companies; and
// accepting one, which opens its company. Then the crew's page and the Overview. A stand-in for supabase-js plays the
// server, so no request leaves the test. Every person, address, company and token is made up.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@supabase/supabase-js';

import type { CompanyChoice, SupervisorInvitation } from '../src/lib/server';

const server = vi.hoisted(() => ({
  /** Where the page's address was each time a Supabase client was made. */
  madeAt: [] as string[],
  calls: [] as { name: string; args: unknown; options: unknown }[],
  answers: new Map<string, { data: unknown; error: unknown }>(),
  /** The session this browser keeps. */
  kept: null as unknown,
  /** What setSession answers. */
  setAnswer: { session: null, error: null } as { session: unknown; error: unknown },
  setCalls: 0,
  signOuts: 0,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    server.madeAt.push((globalThis as { location?: { href?: string } }).location?.href ?? '');
    return {
      rpc: async (name: string, args?: unknown, options?: unknown) => {
        server.calls.push({ name, args, options });
        return server.answers.get(name) ?? { data: null, error: { code: 'PGRST202', message: `The stand-in has no ${name}.` } };
      },
      auth: {
        getSession: async () => ({ data: { session: server.kept }, error: null }),
        setSession: async () => {
          server.setCalls += 1;
          if (server.setAnswer.session) server.kept = server.setAnswer.session;
          return { data: { session: server.setAnswer.session, user: null }, error: server.setAnswer.error };
        },
        signOut: async () => {
          server.signOuts += 1;
          server.kept = null;
          return { error: null };
        },
      },
    };
  },
}));

// The Overview page reads its company from the page around it.
const page = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../src/lib/company', async (actual) => ({
  ...(await actual<typeof import('../src/lib/company')>()),
  useCompany: () => page.ctx,
}));

/** The page opens where Supabase Auth sends the invite email's link back: the session in the hash, as Auth adds it. */
const INVITE_LINK =
  'https://app.minemuster.com/?invited=1#access_token=made-up-access-token&expires_at=1795000000&expires_in=3600&refresh_token=made-up-refresh-token&token_type=bearer&type=invite';
/** The same link once it has run out, or was used already. */
const EXPIRED_LINK = 'https://app.minemuster.com/?invited=1#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
/** An invitation's session sent to the dashboard's plain address, as Auth does when the invite link is not on its list. */
const PLAIN_ADDRESS_LINK = 'https://app.minemuster.com/#access_token=made-up-access-token&expires_in=3600&refresh_token=made-up-refresh-token&token_type=bearer&type=invite';

// The browser: its address, its history and what it keeps.
const address = { href: INVITE_LINK };
const kept = new Map<string, string>();
vi.stubGlobal('window', globalThis);
vi.stubGlobal('location', address);
vi.stubGlobal('history', {
  state: null,
  replaceState: (_state: unknown, _title: string, url: string) => {
    address.href = String(url);
  },
});
vi.stubGlobal('localStorage', {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  removeItem: (key: string) => void kept.delete(key),
});
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));

// The client module is the first to read the address, as in the browser.
const link = await import('../src/lib/supabase');
const { acceptAndOpen, afterAuthEvent, companiesView, loadCompanies, openingAuth, readInvitations, setInvitedSession, troubleKept } = await import('../src/lib/arrival');
const { LinkTroubleScreen, NewPasswordScreen } = await import('../src/screens/AuthScreen');
const { InvitationsNotice, InvitationsScreen } = await import('../src/screens/InvitationsScreen');
const { EmployeeScreen } = await import('../src/screens/EmployeeScreen');
const { OverviewPage } = await import('../src/screens/OverviewPage');
const { remembered } = await import('../src/lib/picked');
const { shapeRecords } = await import('../src/lib/records');
const { board } = await import('../src/lib/overview');

type Waiting = Awaited<ReturnType<typeof readInvitations>>;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const signedInAs = (email: string | undefined, id = `u-${(email ?? 'phone').split('@')[0]}`) =>
  ({ access_token: 'made-up', refresh_token: 'made-up', user: { id, email } }) as unknown as Session;
const RILEY = signedInAs('riley@example.org');
const SAM = signedInAs('sam@example.com');
const TOKENS = { access_token: 'made-up-access-token', refresh_token: 'made-up-refresh-token' };
/** An address that said nothing. */
const PLAIN = { code: false, error: null, errorText: null, invited: false, refused: false };

const INVITATION: SupervisorInvitation = {
  id: 'inv-b',
  company_id: 'c-b',
  company_name: 'Test Pit B',
  first_name: 'Riley J',
  last_name: 'Quinn',
  expires_at: '2026-11-30T18:00:00Z',
};
const PIT_A: CompanyChoice = { id: 'c-a', name: 'Test Pit A', state: 'NV', role: 'employee' };
const PIT_B: CompanyChoice = { id: 'c-b', name: 'Test Pit B', state: 'NV', role: 'supervisor', join_code: 'ABCD2345' };
const PIT_C: CompanyChoice = { id: 'c-c', name: 'Test Pit C', state: 'NV', role: 'supervisor', join_code: 'EFGH6789' };

/** What Companies is given once both reads are in. */
const at = (over: Partial<Parameters<typeof companiesView>[0]>): Parameters<typeof companiesView>[0] => ({
  error: null,
  list: [],
  invitations: { list: [], problem: null },
  goneOn: false,
  invited: false,
  path: '/',
  picked: null,
  ...over,
});

const showing = (email: string, waiting: Waiting, companies: CompanyChoice[] = [], invited = false) =>
  renderToStaticMarkup(createElement(InvitationsScreen, { email, waiting, invited, companies, onCompany: async () => true, onRetry: async () => {}, onGoOn: () => {} }));

/** The sign-in page's words for each link that signed nobody in. */
const OUT = {
  inviteExpired:
    'That invitation link has expired or was already used. Ask the supervisor who invited you to send it again. If you used it already, sign in below, or choose a password with Forgot your password.',
  inviteFailed: 'That invitation link did not sign you in. Ask the supervisor who invited you to send it again. If you already chose a password, sign in below.',
  notSet:
    'The invitation link did not sign you in on this browser. Choose a password with Forgot your password, then sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.',
  notSetOffline:
    'Could not reach the MineMuster server, so the invitation link did not sign you in. Check this computer’s connection, then choose a password with Forgot your password and sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.',
  refused:
    'That link did not sign you in. Sign in below, choosing a password first with Forgot your password if you have none. If the link was an invitation, it shows once you are signed in, or ask the supervisor who invited you to send it again.',
};

describe('the invite email’s link', () => {
  it('an invite link is read and tidied from the address', () => {
    // The client was made once, on the address with the invitation taken off it: it never saw the session.
    expect(server.madeAt).toEqual(['https://app.minemuster.com/']);
    expect(address.href).toBe('https://app.minemuster.com/');
    expect(link.arrivedWith).toEqual({ code: false, error: null, errorText: null, invited: true, refused: false });
    // The session is held in memory until App sets it, and handed over once.
    expect(link.takeInviteTokens()).toEqual(TOKENS);
    expect(link.takeInviteTokens()).toBeNull();
    // Never written down, never logged.
    expect([...kept.values()].join(' ')).not.toContain('made-up');
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain('made-up');
  });

  it('takes a session from an address only when it is an invitation, and takes any other off the address all the same', () => {
    const session = 'access_token=made-up-access-token&expires_in=3600&refresh_token=made-up-refresh-token&token_type=bearer';
    // The rest of the address stays as it was.
    expect(link.readArrival(`https://app.minemuster.com/?invited=1&start=trial#${session}&type=invite`)).toEqual({
      arrival: { code: false, error: null, errorText: null, invited: true, refused: false },
      invite: TOKENS,
      tidied: 'https://app.minemuster.com/?start=trial',
    });
    for (const [other, tidied] of [
      // Not the invite link's address: Auth's type alone is not enough.
      [`https://app.minemuster.com/#${session}&type=invite`, 'https://app.minemuster.com/'],
      [`https://app.minemuster.com/?invited=0#${session}&type=invite`, 'https://app.minemuster.com/'],
      // The invite link's query, with another kind of session.
      [`https://app.minemuster.com/?invited=1#${session}&type=recovery`, 'https://app.minemuster.com/'],
      [`https://app.minemuster.com/?invited=1#${session}&type=magiclink`, 'https://app.minemuster.com/'],
      [`https://app.minemuster.com/?invited=1#${session}`, 'https://app.minemuster.com/'],
      // A code beside it, half a session, or an error.
      [`https://app.minemuster.com/?invited=1&code=made-up-code#${session}&type=invite`, 'https://app.minemuster.com/?code=made-up-code'],
      ['https://app.minemuster.com/?invited=1#access_token=made-up-access-token&type=invite', 'https://app.minemuster.com/'],
      ['https://app.minemuster.com/?invited=1#refresh_token=made-up-refresh-token&type=invite', 'https://app.minemuster.com/'],
      [`https://app.minemuster.com/?invited=1#${session}&type=invite&error=server_error`, 'https://app.minemuster.com/'],
    ]) {
      const read = link.readArrival(other);
      expect(read.invite, other).toBeNull();
      expect(read.arrival.refused, other).toBe(true);
      // Off the address before the client is made, so no session is left in the address bar.
      expect(read.tidied, other).toBe(tidied);
    }
    // An address with no session in it is left for the client, as before.
    expect(link.readArrival('https://app.minemuster.com/?code=made-up-code')).toEqual({
      arrival: { code: true, error: null, errorText: null, invited: false, refused: false },
      invite: null,
      tidied: null,
    });
    expect(link.readArrival(EXPIRED_LINK).tidied).toBeNull();
  });

  it('a session it turns down is off the address before the client is made, and the page says the link signed nobody in', async () => {
    address.href = PLAIN_ADDRESS_LINK;
    vi.resetModules();
    const again = await import('../src/lib/supabase');
    expect(server.madeAt.at(-1)).toBe('https://app.minemuster.com/');
    expect(address.href).toBe('https://app.minemuster.com/');
    expect(again.arrivedWith).toEqual({ code: false, error: null, errorText: null, invited: false, refused: true });
    expect(again.takeInviteTokens()).toBeNull();
    // Signed out, the sign-in page says so, with what to do.
    server.kept = null;
    expect(await openingAuth(null, again.arrivedWith)).toEqual({ auth: { state: 'out' }, said: OUT.refused });
    // Signed in to an account, that account stays, and the words show first.
    server.kept = SAM;
    expect(await openingAuth(null, again.arrivedWith)).toEqual({ auth: { state: 'kept', session: SAM, trouble: { kind: 'refused' } }, said: null });
  });

  it('an expired or used invite link says so and to ask for it again, shows the sign-in, and is tidied from the address', async () => {
    const { arrival, invite } = link.readArrival(EXPIRED_LINK);
    expect(invite).toBeNull();
    expect(arrival).toEqual({ code: false, error: 'otp_expired', errorText: 'Email link is invalid or has expired', invited: true, refused: false });
    server.kept = null;
    expect(await openingAuth(null, arrival)).toEqual({ auth: { state: 'out' }, said: OUT.inviteExpired });
    expect((await openingAuth(null, { ...arrival, error: 'server_error', errorText: 'Unable to process request' })).said).toBe(OUT.inviteFailed);
    // The other links are worded as before.
    expect((await openingAuth(null, { ...arrival, invited: false })).said).toBe('That link has expired or was already used. Sign in, or ask for a new link with Forgot your password.');

    address.href = EXPIRED_LINK;
    link.tidyAddress();
    expect(address.href).toBe('https://app.minemuster.com/');
  });

  it('an invite link that fails in a browser signed in to another account says so first, names that account, and signs nobody out', async () => {
    const { arrival } = link.readArrival(EXPIRED_LINK);
    server.kept = SAM;
    server.signOuts = 0;
    expect(await openingAuth(null, arrival)).toEqual({ auth: { state: 'kept', session: SAM, trouble: { kind: 'invite_expired' } }, said: null });
    // Its session could not be set: the same.
    server.setAnswer = { session: null, error: { name: 'AuthApiError', code: 'bad_jwt', status: 403, message: 'invalid JWT' } };
    expect(await openingAuth(setInvitedSession(TOKENS))).toEqual({ auth: { state: 'kept', session: SAM, trouble: { kind: 'invite_not_set', offline: false } }, said: null });
    expect(server.signOuts).toBe(0);

    const html = renderToStaticMarkup(createElement(LinkTroubleScreen, { trouble: { kind: 'invite_expired' }, email: 'sam@example.com', onGoOn: () => {} }));
    expect(html).toMatch(/<h1[^>]*>That invitation link did not sign you in<\/h1>/);
    expect(text(html)).toContain('It has expired or was already used. If you accepted the invitation already, go on. If not, ask the supervisor who invited you to send it again.');
    expect(html).toMatch(/<h2[^>]*>Signed in as sam@example.com<\/h2>/);
    expect(text(html)).toContain(
      'This browser is still signed in to that account. If the link was sent to sam@example.com, go on: an invitation sent there shows next, or, if you accepted it already, your companies open. If not, sign out, then sign in with your own email, choosing a password first with Forgot your password if you have none.',
    );
    expect(html).toMatch(/<button[^>]*>Go on as sam@example.com<\/button>/);
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(text(renderToStaticMarkup(createElement(LinkTroubleScreen, { trouble: { kind: 'invite_not_set', offline: true }, email: 'sam@example.com', onGoOn: () => {} })))).toContain(
      'The MineMuster server could not be reached. Check this computer’s connection.',
    );
    expect(renderToStaticMarkup(createElement(LinkTroubleScreen, { trouble: { kind: 'refused' }, email: 'sam@example.com', onGoOn: () => {} }))).toMatch(/<h1[^>]*>That link did not sign you in<\/h1>/);

    // The screen stays up through what Auth says of the same account, until the person goes on or signs out.
    const keptHere = { state: 'kept', session: SAM, trouble: { kind: 'invite_expired' } } as const;
    for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN', 'USER_UPDATED'] as const) expect(afterAuthEvent(keptHere, event, SAM)).toBe(keptHere);
    expect(afterAuthEvent(keptHere, 'INITIAL_SESSION', null)).toBe(keptHere);
    expect(afterAuthEvent(keptHere, 'SIGNED_OUT', null)).toEqual({ state: 'out' });
    // Another tab signs another account in: this one follows it.
    expect(afterAuthEvent(keptHere, 'SIGNED_IN', RILEY)).toEqual({ state: 'in', session: RILEY });
  });

  it('an accepted invitation’s link opened again in a browser signed in to its account says to go on, and asks for no new invitation first', () => {
    // The link is used up once the invitation is accepted: opened again, it is expired or was used already.
    for (const trouble of [{ kind: 'invite_expired' }, { kind: 'invite_failed' }, { kind: 'refused' }] as const) {
      const words = troubleKept(trouble, 'riley@example.org');
      expect(words.why).toMatch(/accepted (the invitation|already)/);
      expect(words.why.indexOf('go on')).toBeGreaterThanOrEqual(0);
      expect(words.why.indexOf('go on')).toBeLessThan(words.why.indexOf('send it again'));
      expect(words.next).toContain('if you accepted it already, your companies open');
    }
    expect(troubleKept({ kind: 'invite_failed' }, 'riley@example.org').why).toBe(
      'If you accepted the invitation already, go on. If not, ask the supervisor who invited you to send it again.',
    );
    expect(troubleKept({ kind: 'refused' }, 'riley@example.org').why).toBe(
      'If it was an invitation you accepted already, go on. If it was one you have not accepted, ask the supervisor who invited you to send it again.',
    );
  });

  it('opens on the session the invite link brought, and on what the browser keeps otherwise', async () => {
    // Set, it opens on the password, as the address it names.
    server.kept = SAM;
    server.setAnswer = { session: RILEY, error: null };
    server.setCalls = 0;
    expect(await openingAuth(setInvitedSession(TOKENS))).toEqual({ auth: { state: 'invited', session: RILEY }, said: null });
    expect(server.setCalls).toBe(1);
    // Not set, in a browser signed in to nobody: the sign-in, with what to do. The link is used up by then.
    server.kept = null;
    server.setAnswer = { session: null, error: { name: 'AuthApiError', code: 'bad_jwt', status: 403, message: 'invalid JWT' } };
    expect(await openingAuth(setInvitedSession(TOKENS))).toEqual({ auth: { state: 'out' }, said: OUT.notSet });
    server.setAnswer = { session: null, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
    expect(await openingAuth(setInvitedSession(TOKENS))).toEqual({ auth: { state: 'out' }, said: OUT.notSetOffline });
    // A session with no address to name is not an invitation's: it is signed out.
    server.setAnswer = { session: signedInAs(undefined), error: null };
    server.signOuts = 0;
    expect(await openingAuth(setInvitedSession(TOKENS))).toEqual({ auth: { state: 'out' }, said: OUT.inviteFailed });
    expect(server.signOuts).toBe(1);
    // No link: the session this browser keeps, or the sign-in, as before.
    server.kept = SAM;
    expect(await openingAuth(null, PLAIN)).toEqual({ auth: { state: 'in', session: SAM }, said: null });
    server.kept = null;
    expect(await openingAuth(null, PLAIN)).toEqual({ auth: { state: 'out' }, said: null });
    expect((await openingAuth(null, { ...PLAIN, code: true })).said).toMatch(/^That link could not sign you in on this browser\./);
  });
});

describe('signed in by the invite link', () => {
  it('after setting a password the invitation shows to accept', async () => {
    // While the invitation's session is being set, what Auth says is of the session it replaces, or of none: the
    // page waits for the invitation's own answer, and neither the sign-in nor another account's companies flash up.
    const setting = { state: 'checking', invitation: true } as const;
    expect(afterAuthEvent(setting, 'INITIAL_SESSION', null)).toBe(setting);
    expect(afterAuthEvent(setting, 'SIGNED_IN', SAM)).toBe(setting);
    expect(afterAuthEvent(setting, 'SIGNED_IN', RILEY)).toBe(setting);

    // The first screen says whose session this is, with a way out.
    const first = renderToStaticMarkup(createElement(NewPasswordScreen, { invitedAs: 'riley@example.org', onDone: () => {} }));
    expect(first).toMatch(/<h1[^>]*>Set a password for riley@example.org<\/h1>/);
    expect(text(first)).toContain('You are signed in as riley@example.org, from the invitation in your email.');
    expect(text(first)).toContain('Not riley@example.org? The link was made for someone else’s account.');
    expect(first).toMatch(/<button[^>]*>This is not my email: sign out<\/button>/);
    // A password reset's screen is as it was.
    const reset = renderToStaticMarkup(createElement(NewPasswordScreen, { onDone: () => {} }));
    expect(reset).toMatch(/<h1[^>]*>Choose a new password<\/h1>/);
    expect(reset).not.toContain('sign out');

    // Nothing Auth says of the same account skips the password, until it is saved.
    const invited = { state: 'invited', session: RILEY } as const;
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION'] as const) expect(afterAuthEvent(invited, event, RILEY)).toBe(invited);
    // Auth's first word, should it come late, is of the session this one replaced, or of none.
    expect(afterAuthEvent(invited, 'INITIAL_SESSION', null)).toBe(invited);
    // Another account signed in from another tab: the screen does not name one account while acting on another.
    expect(afterAuthEvent(invited, 'SIGNED_IN', SAM)).toEqual({ state: 'in', session: SAM });
    const recovery = { state: 'recovery', session: RILEY } as const;
    expect(afterAuthEvent(recovery, 'TOKEN_REFRESHED', RILEY)).toBe(recovery);
    expect(afterAuthEvent(recovery, 'SIGNED_IN', SAM)).toEqual({ state: 'in', session: SAM });
    expect(afterAuthEvent(invited, 'SIGNED_OUT', null)).toEqual({ state: 'out' });
    // Saved, the account is in, and still known to have come by the invite link, until it signs out or another signs in.
    const saved = afterAuthEvent(invited, 'USER_UPDATED', RILEY);
    expect(saved).toEqual({ state: 'in', session: RILEY, invited: true });
    expect(afterAuthEvent(saved, 'TOKEN_REFRESHED', RILEY)).toEqual({ state: 'in', session: RILEY, invited: true });
    expect(afterAuthEvent(saved, 'SIGNED_IN', SAM)).toEqual({ state: 'in', session: SAM });
    expect(afterAuthEvent(saved, 'SIGNED_OUT', null)).toEqual({ state: 'out' });
    expect(afterAuthEvent({ state: 'out' }, 'SIGNED_IN', RILEY)).toEqual({ state: 'in', session: RILEY });

    // Signed in, the account's invitations are asked for, and shown before its companies, to accept.
    server.answers.set('my_supervisor_invitations', { data: [INVITATION], error: null });
    const waiting = await readInvitations();
    expect(waiting).toEqual({ list: [INVITATION], problem: null });
    expect(companiesView(at({ invitations: null }))).toEqual({ show: 'loading' });
    expect(companiesView(at({ invitations: waiting, invited: true }))).toEqual({ show: 'invitations', waiting, companies: [] });
    const shown = showing('riley@example.org', waiting, [], true);
    expect(shown).toMatch(/<h1[^>]*>An invitation to supervise<\/h1>/);
    expect(text(shown)).toContain('Signed in as riley@example.org.');
    expect(shown).toMatch(/<h2[^>]*>Test Pit B<\/h2>/);
    expect(text(shown)).toContain('On its roster as Riley J Quinn. Good until Nov 30, 10:00 AM.');
    expect(shown).toMatch(/<button[^>]*>Accept and open Test Pit B<\/button>/);
    expect(text(shown)).toContain('To turn an invitation down, leave it.');
    expect(shown).toMatch(/<button[^>]*>Go on to start or join a company<\/button>/);
    // Accepted, the company it was for opens.
    expect(companiesView(at({ list: [PIT_B], invitations: waiting, invited: true, goneOn: true, picked: 'c-b' }))).toEqual({ show: 'company', choice: PIT_B, companies: [PIT_B], problem: null });
  });

  it('an account that already existed sees its invitation after signing in', async () => {
    // No email went to an address that had an account already: the invitation waited for its next sign-in.
    const lee = signedInAs('lee@example.com');
    expect(afterAuthEvent({ state: 'out' }, 'SIGNED_IN', lee)).toEqual({ state: 'in', session: lee });
    server.answers.set('my_supervisor_invitations', { data: [{ ...INVITATION, first_name: 'Lee', last_name: 'Park' }], error: null });
    server.calls = [];
    const waiting = await readInvitations();
    // Asked by POST, as the dashboard's other calls are.
    expect(server.calls).toEqual([{ name: 'my_supervisor_invitations', args: undefined, options: undefined }]);
    // Shown first, whatever companies the account is in already, with a way on to them.
    expect(companiesView(at({ list: [PIT_A], invitations: waiting }))).toEqual({ show: 'invitations', waiting, companies: [PIT_A] });
    const shown = showing('lee@example.com', waiting, [PIT_A]);
    expect(text(shown)).toContain('Signed in as lee@example.com.');
    expect(text(shown)).toContain('On its roster as Lee Park.');
    expect(shown).toMatch(/<button[^>]*>Go on to Test Pit A<\/button>/);
    expect(showing('lee@example.com', waiting, [PIT_A, PIT_C])).toMatch(/<button[^>]*>Go on to your companies<\/button>/);
    // Gone on, the companies open; Your account opens while the invitations wait.
    expect(companiesView(at({ list: [PIT_A], invitations: waiting, goneOn: true }))).toEqual({ show: 'crew', choice: PIT_A, companies: [PIT_A], problem: null });
    expect(companiesView(at({ list: [PIT_A], invitations: waiting, path: '/account' }))).toEqual({ show: 'account', open: 'c-a' });
    expect(companiesView(at({ list: [], invitations: waiting, path: '/account' }))).toEqual({ show: 'account', open: null });

    // With none waiting, the companies open as before; a server without invitations yet has none.
    server.answers.set('my_supervisor_invitations', { data: [], error: null });
    expect(companiesView(at({ list: [PIT_A], invitations: await readInvitations() }))).toEqual({ show: 'crew', choice: PIT_A, companies: [PIT_A], problem: null });
    server.answers.delete('my_supervisor_invitations');
    expect(await readInvitations()).toEqual({ list: [], problem: null });
    server.answers.set('my_supervisor_invitations', { data: null, error: { code: '42501', message: 'Sign in first.' } });
    expect((await readInvitations()).problem).toBe('Your sign-in has run out. Sign in again.');
  });

  it('invitations that could not be read hold up nobody: a notice on the companies, or the invitations page after an invite link', async () => {
    server.answers.set('my_supervisor_invitations', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const failed = await readInvitations();
    expect(failed.problem).toMatch(/^Finding your invitations did not work/);
    // An account that came in the usual way opens its companies, with the trouble said above them.
    expect(companiesView(at({ list: [PIT_B], invitations: failed, picked: 'c-b' }))).toEqual({ show: 'company', choice: PIT_B, companies: [PIT_B], problem: failed.problem });
    expect(companiesView(at({ list: [PIT_A], invitations: failed }))).toEqual({ show: 'crew', choice: PIT_A, companies: [PIT_A], problem: failed.problem });
    expect(companiesView(at({ invitations: failed }))).toEqual({ show: 'no_company', problem: failed.problem });
    const notice = createElement(InvitationsNotice, { problem: failed.problem ?? '', onRetry: async () => {} });
    const said = renderToStaticMarkup(createElement(EmployeeScreen, { email: 'lee@example.com', choice: PIT_A, companies: [PIT_A], onPick: () => {}, notice }));
    expect(text(said)).toContain('Your invitations to supervise could not be checked');
    expect(text(said)).toContain(failed.problem ?? '');
    expect(said).toMatch(/<button[^>]*>Try again<\/button>/);
    // After an invite link the invitations page comes first, with the trouble and Try again.
    expect(companiesView(at({ invitations: failed, invited: true }))).toEqual({ show: 'invitations', waiting: failed, companies: [] });
    const page = showing('riley@example.org', failed, [], true);
    expect(text(page)).toContain('Your invitations to supervise could not be checked');
    expect(page).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(text(page)).not.toContain('no longer open');
  });

  it('after an invite link, an invitation no longer open says so, ahead of the start-a-company offer', () => {
    const none: Waiting = { list: [], problem: null };
    expect(companiesView(at({ invitations: none, invited: true }))).toEqual({ show: 'invitations', waiting: none, companies: [] });
    const said = showing('riley@example.org', none, [], true);
    expect(text(said)).toContain(
      'The invitation you came from is no longer open It was cancelled, the row it was for has changed, or the supervisor who sent it is no longer a supervisor there. Ask the supervisor who invited you to invite you again.',
    );
    expect(said).toMatch(/<button[^>]*>Go on to start or join a company<\/button>/);
    // Without an invite link nothing is said, and the start-a-company page opens.
    expect(companiesView(at({ invitations: none }))).toEqual({ show: 'no_company', problem: null });
    expect(text(showing('riley@example.org', none))).not.toContain('no longer open');
  });

  it('accepting re-reads the companies and opens the new one', async () => {
    server.answers.set('accept_supervisor_invitation', { data: { company_id: 'c-b', company_name: 'Test Pit B' }, error: null });
    server.answers.set('my_companies', { data: [PIT_A, PIT_B], error: null });
    // This browser last opened another company.
    localStorage.setItem('minemuster.office.company', 'c-a');
    server.calls = [];
    // It answers the company it opened, for the page to write the person in the app as a supervisor once it is open.
    expect(await acceptAndOpen(INVITATION, 'riley@example.org', loadCompanies)).toBe('c-b');
    expect(server.calls.map((c) => [c.name, c.args])).toEqual([
      ['accept_supervisor_invitation', { p_invitation_id: 'inv-b' }],
      ['my_companies', undefined],
    ]);
    expect(remembered()).toBe('c-b');
    expect(await loadCompanies({ id: 'c-b' })).toEqual({ companies: [PIT_A, PIT_B], picked: 'c-b' });
  });

  it('a refusal to accept is worded for the person invited, with what to do next, and opens nothing', async () => {
    server.answers.set('my_companies', { data: [PIT_A, PIT_B], error: null });
    const refusals: [unknown, string][] = [
      [{ code: '42501', message: 'Sign in first.' }, 'Your sign-in has run out. Sign in again, then accept the invitation.'],
      [{ code: 'PT404', message: 'No such invitation.' }, 'That invitation to Test Pit B is no longer there. Ask the supervisor who invited you to invite you again.'],
      [
        { code: 'PT409', hint: 'wrong_email', message: 'Sign in with the confirmed email address the invitation was sent to.' },
        'That invitation to Test Pit B was sent to another email address, not riley@example.org. Sign out, then sign in with the address it was sent to.',
      ],
      [
        { code: 'PT409', hint: 'invitation_closed', message: 'That invitation has expired, or was cancelled or accepted.' },
        'That invitation to Test Pit B has closed: it expired, was cancelled or was already accepted, or the supervisor who sent it is no longer a supervisor there. Ask a supervisor of Test Pit B to send it again.',
      ],
      [
        { code: 'PT409', hint: 'already_on_roster', message: 'This account is already on that company’s roster.' },
        'This account is already on Test Pit B’s roster, or was taken off it, so it cannot take another row there. Ask the supervisor who invited you to make your own row a supervisor’s on the Roster page instead.',
      ],
      [
        { code: 'PT409', hint: 'row_taken', message: 'That roster row is taken off the roster or held by an email sign-in.' },
        'The row on Test Pit B’s roster that this invitation is for has changed: it was taken off the roster, or another email account holds it now. Ask the supervisor who invited you to check the row on the Roster page and send the invitation again.',
      ],
      [
        { code: 'PT409', hint: 'supervisor_needs_email', message: 'A supervisor signs in with email, not a passcode.' },
        'This account signs in with a passcode, and a supervisor signs in with email. Sign out, then sign in with the email address the invitation was sent to.',
      ],
      [{ message: 'TypeError: Failed to fetch' }, 'Could not reach the MineMuster server. Check this computer’s connection, then try again.'],
    ];
    for (const [error, words] of refusals) {
      server.answers.set('accept_supervisor_invitation', { data: null, error });
      server.calls = [];
      await expect(acceptAndOpen(INVITATION, 'riley@example.org', loadCompanies)).rejects.toThrow(words);
      // Nothing was opened.
      expect(server.calls.map((c) => c.name)).toEqual(['accept_supervisor_invitation']);
    }
    // An answer that does not say the invitation was accepted is not taken for one.
    server.answers.set('accept_supervisor_invitation', { data: null, error: null });
    await expect(acceptAndOpen(INVITATION, 'riley@example.org', loadCompanies)).rejects.toThrow(
      'The server did not say the invitation was accepted. Reload the page to see whether it was.',
    );
  });
});

describe('how the crew get into the app', () => {
  it('the crew page sends its reader to the app’s Supervisor? Sign in with email, with this same email (R32)', () => {
    // Its reader signs in here with email, and that account holds their row: in the app it signs in the same way.
    const html = renderToStaticMarkup(createElement(EmployeeScreen, { email: 'sam@example.com', choice: PIT_A, companies: [PIT_A], onPick: () => {} }));
    const said = text(html);
    expect(said).toContain(
      'Your hours, equipment checklists, pre shift exams and maintenance requests are in the MineMuster app on your phone, which sends them to Test Pit A. On the app’s first screen, tap Supervisor? Sign in with email, and sign in with this same email and password.',
    );
    expect(said).not.toContain('More → Company account');
    // Not the passcode Sign up, which the app turns down for a row an email account holds.
    expect(said).not.toMatch(/passcode|Sign up/);
  });

  it('the Overview tells a supervisor how new crew sign up in the app', () => {
    const NOW = Date.UTC(2026, 10, 23, 18);
    const shaped = shapeRecords([], { roster: [] });
    page.ctx = {
      choice: { id: 'c-a', name: 'Test Pit A', state: 'NV', role: 'supervisor', join_code: 'ABCD2345' },
      me: 'u-office',
      company: null,
      roster: [],
      requests: [],
      notifications: [],
      records: [],
      shaped,
      board: board(shaped, NOW),
      loadedAt: NOW,
      recordsError: null,
      recordsHeld: false,
      now: NOW,
    };
    const said = text(renderToStaticMarkup(createElement(OverviewPage)));
    expect(said).toContain('No records have arrived from the phones yet');
    expect(said).toContain(
      'Each person then opens the MineMuster app, taps Sign up on its first screen, and types the company code, their name as it is on the roster, and a passcode they choose.',
    );
    expect(said).not.toContain('More → Company account');
  });
});
