// The invited person's side of an invitation to supervise (ruling R31): the invite email's link, read and taken off
// the address before the Supabase client is made; the password it asks for first, on a screen that names the
// address it signed in as; the invitations, shown before the companies after any sign-in; and accepting one, which
// opens its company. Then the crew's page and the Overview, which send the crew to the app's own sign-up. A stand-in
// for supabase-js plays the server, so no request leaves the test. Every person, address, company and token is made up.
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
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    server.madeAt.push((globalThis as { location?: { href?: string } }).location?.href ?? '');
    return {
      rpc: async (name: string, args?: unknown, options?: unknown) => {
        server.calls.push({ name, args, options });
        return server.answers.get(name) ?? { data: null, error: { code: 'PGRST202', message: `The stand-in has no ${name}.` } };
      },
      auth: { signOut: async () => ({ error: null }) },
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
const { afterAuthEvent, invitedSessionProblem, linkProblem, loadCompanies } = await import('../src/App');
const { NewPasswordScreen } = await import('../src/screens/AuthScreen');
const { acceptAndOpen, invitationsFirst, InvitationsScreen, readInvitations } = await import('../src/screens/InvitationsScreen');
const { EmployeeScreen } = await import('../src/screens/EmployeeScreen');
const { OverviewPage } = await import('../src/screens/OverviewPage');
const { remembered } = await import('../src/lib/picked');
const { shapeRecords } = await import('../src/lib/records');
const { board } = await import('../src/lib/overview');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const signedInAs = (email: string) => ({ access_token: 'made-up', refresh_token: 'made-up', user: { id: `u-${email.split('@')[0]}`, email } }) as unknown as Session;

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

const showing = (email: string, waiting: Awaited<ReturnType<typeof readInvitations>>) =>
  renderToStaticMarkup(createElement(InvitationsScreen, { email, waiting, onCompany: async () => true, onRetry: async () => {}, onGoOn: () => {} }));

describe('the invite email’s link', () => {
  it('an invite link is read and tidied from the address', () => {
    // The client was made once, on the address with the invitation taken off it: it never saw the session.
    expect(server.madeAt).toEqual(['https://app.minemuster.com/']);
    expect(address.href).toBe('https://app.minemuster.com/');
    expect(link.arrivedWith).toEqual({ code: false, error: null, errorText: null, invited: true });
    // The session is held in memory until App sets it, and handed over once.
    expect(link.takeInviteTokens()).toEqual({ access_token: 'made-up-access-token', refresh_token: 'made-up-refresh-token' });
    expect(link.takeInviteTokens()).toBeNull();
    // Never written down, never logged.
    expect([...kept.values()].join(' ')).not.toContain('made-up');
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain('made-up');
  });

  it('takes a session from an address only when it is an invitation, with invited=1 and type=invite', () => {
    const session = 'access_token=made-up-access-token&expires_in=3600&refresh_token=made-up-refresh-token&token_type=bearer';
    // The rest of the address stays as it was.
    expect(link.readArrival(`https://app.minemuster.com/?invited=1&start=trial#${session}&type=invite`)).toEqual({
      arrival: { code: false, error: null, errorText: null, invited: true },
      invite: { access_token: 'made-up-access-token', refresh_token: 'made-up-refresh-token' },
      tidied: 'https://app.minemuster.com/?start=trial',
    });
    for (const other of [
      // Not the invite link's address: Auth's type alone is not enough.
      `https://app.minemuster.com/#${session}&type=invite`,
      `https://app.minemuster.com/?invited=0#${session}&type=invite`,
      // The invite link's query, with another kind of session.
      `https://app.minemuster.com/?invited=1#${session}&type=recovery`,
      `https://app.minemuster.com/?invited=1#${session}&type=magiclink`,
      `https://app.minemuster.com/?invited=1#${session}`,
      // A code beside it, half a session, or an error.
      `https://app.minemuster.com/?invited=1&code=made-up-code#${session}&type=invite`,
      'https://app.minemuster.com/?invited=1#access_token=made-up-access-token&type=invite',
      `https://app.minemuster.com/?invited=1#${session}&type=invite&error=server_error`,
    ]) {
      const read = link.readArrival(other);
      expect(read.invite, other).toBeNull();
      // Left for the client, which takes only a code, as before.
      expect(read.tidied, other).toBeNull();
    }
    // A link from the other sign-in emails is read as before.
    expect(link.readArrival('https://app.minemuster.com/?code=made-up-code')).toEqual({
      arrival: { code: true, error: null, errorText: null, invited: false },
      invite: null,
      tidied: null,
    });
  });

  it('an expired or used invite link says so and to ask for it again, shows the sign-in, and is tidied from the address', () => {
    const { arrival, invite } = link.readArrival(EXPIRED_LINK);
    expect(invite).toBeNull();
    expect(arrival).toEqual({ code: false, error: 'otp_expired', errorText: 'Email link is invalid or has expired', invited: true });
    expect(linkProblem(false, arrival)).toBe(
      'That invitation link has expired or was already used. Ask the supervisor who invited you to send it again. If you used it already, sign in below, or choose a password with Forgot your password.',
    );
    expect(linkProblem(false, { ...arrival, error: 'server_error', errorText: 'Unable to process request' })).toBe(
      'That invitation link did not sign you in. Ask the supervisor who invited you to send it again, or sign in below if you already chose a password.',
    );
    // The other links are worded as before.
    expect(linkProblem(false, { ...arrival, invited: false })).toBe('That link has expired or was already used. Sign in, or ask for a new link with Forgot your password.');

    address.href = EXPIRED_LINK;
    link.tidyAddress();
    expect(address.href).toBe('https://app.minemuster.com/');
  });

  it('says what to do when the session it brought could not be set: the link is used up by then', () => {
    expect(invitedSessionProblem({ name: 'AuthApiError', code: 'bad_jwt', status: 403, message: 'invalid JWT' })).toBe(
      'The invitation link did not sign you in on this browser. Choose a password with Forgot your password, then sign in to see the invitation. If no email comes, ask the supervisor who invited you to send it again.',
    );
    expect(invitedSessionProblem({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 })).toMatch(
      /^Could not reach the MineMuster server, so the invitation link did not sign you in\. Check this computer’s connection, then choose a password with Forgot your password/,
    );
  });
});

describe('signed in by the invite link', () => {
  it('after setting a password the invitation shows to accept', async () => {
    const riley = signedInAs('riley@example.org');
    // While the invitation's session is being set, what Auth says is of the session it replaces, or of none: the
    // page waits for the invitation's own answer, and neither the sign-in nor another account's companies flash up.
    const setting = { state: 'checking', invitation: true } as const;
    expect(afterAuthEvent(setting, 'INITIAL_SESSION', null)).toBe(setting);
    expect(afterAuthEvent(setting, 'SIGNED_IN', signedInAs('sam@example.com'))).toBe(setting);
    expect(afterAuthEvent(setting, 'SIGNED_IN', riley)).toBe(setting);

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

    // Nothing Auth says skips the password, until it is saved.
    const invited = { state: 'invited', session: riley } as const;
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION'] as const) expect(afterAuthEvent(invited, event, riley)).toBe(invited);
    // Auth's first word, should it come late, is of the session this one replaced, or of none.
    expect(afterAuthEvent(invited, 'INITIAL_SESSION', null)).toBe(invited);
    expect(afterAuthEvent(invited, 'USER_UPDATED', riley)).toEqual({ state: 'in', session: riley });
    expect(afterAuthEvent(invited, 'SIGNED_OUT', null)).toEqual({ state: 'out' });

    // Signed in, the account's invitations are asked for, and shown before its companies, to accept.
    server.answers.set('my_supervisor_invitations', { data: [INVITATION], error: null });
    const waiting = await readInvitations();
    expect(waiting).toEqual({ list: [INVITATION], problem: null });
    expect(invitationsFirst(waiting)).toBe(true);
    const shown = showing('riley@example.org', waiting);
    expect(shown).toMatch(/<h1[^>]*>An invitation to supervise<\/h1>/);
    expect(text(shown)).toContain('Signed in as riley@example.org.');
    expect(shown).toMatch(/<h2[^>]*>Test Pit B<\/h2>/);
    expect(text(shown)).toContain('On its roster as Riley J Quinn. Good until Nov 30, 10:00 AM.');
    expect(shown).toMatch(/<button[^>]*>Accept and open Test Pit B<\/button>/);
    expect(text(shown)).toContain('To turn an invitation down, leave it.');
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
    expect(invitationsFirst(waiting)).toBe(true);
    const shown = showing('lee@example.com', waiting);
    expect(text(shown)).toContain('Signed in as lee@example.com.');
    expect(text(shown)).toContain('On its roster as Lee Park.');
    expect(shown).toMatch(/<button[^>]*>Go on without accepting<\/button>/);

    // With none waiting, the companies open as before; a server without invitations yet has none.
    server.answers.set('my_supervisor_invitations', { data: [], error: null });
    expect(invitationsFirst(await readInvitations())).toBe(false);
    server.answers.delete('my_supervisor_invitations');
    expect(await readInvitations()).toEqual({ list: [], problem: null });

    // Invitations that could not be read are said, with Try again, and the person can go on.
    server.answers.set('my_supervisor_invitations', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const failed = await readInvitations();
    expect(failed.problem).toMatch(/^Finding your invitations did not work/);
    expect(invitationsFirst(failed)).toBe(true);
    const said = showing('lee@example.com', failed);
    expect(text(said)).toContain('Your invitations could not be loaded');
    expect(said).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(said).toMatch(/<button[^>]*>Go on<\/button>/);
    server.answers.set('my_supervisor_invitations', { data: null, error: { code: '42501', message: 'Sign in first.' } });
    expect((await readInvitations()).problem).toBe('Your sign-in has run out. Sign in again.');
  });

  it('accepting re-reads the companies and opens the new one', async () => {
    server.answers.set('accept_supervisor_invitation', { data: { company_id: 'c-b', company_name: 'Test Pit B' }, error: null });
    server.answers.set('my_companies', { data: [PIT_A, PIT_B], error: null });
    // This browser last opened another company.
    localStorage.setItem('minemuster.office.company', 'c-a');
    server.calls = [];
    await acceptAndOpen(INVITATION, 'riley@example.org', loadCompanies);
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

describe('the crew get into the app with the company code, not email', () => {
  it('the crew page no longer tells crew to use email', () => {
    const html = renderToStaticMarkup(createElement(EmployeeScreen, { email: 'sam@example.com', choice: PIT_A, companies: [PIT_A], onPick: () => {} }));
    const said = text(html);
    expect(said).toContain(
      'In the app you sign in with the company code, your name as it is on the roster, and a passcode you choose. The first time, tap Sign up on the app’s first screen. A supervisor of Test Pit A can give you the company code.',
    );
    expect(said).not.toContain('More → Company account');
    expect(said).not.toMatch(/(sign in|join) with (this|the same|your) email/i);
  });

  it('the Overview tells a supervisor how the crew sign up in the app', () => {
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
