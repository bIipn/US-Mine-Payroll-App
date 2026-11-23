// The Roster page's sign-in tools: the Account column's words, which tools a row gets, the words around a
// reset code and a deletion, the check of an invitation's address, and the calls to the server. A stand-in for
// the Supabase client plays the server; no request leaves the test. Every person and address is made up.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fmtDateTime, fmtDayShort } from '@app/util/format';

const server = vi.hoisted(() => ({
  rpc: [] as { name: string; args: unknown }[],
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  invoked: [] as { name: string; options: { body: unknown; timeout: number } }[],
  invoke: { data: { status: 'sent' }, error: null } as unknown,
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: async (name: string, args: unknown) => {
      server.rpc.push({ name, args });
      return server.answers[name] ?? { data: null, error: null };
    },
    functions: {
      invoke: async (name: string, options: { body: unknown; timeout: number }) => {
        server.invoked.push({ name, options });
        if (server.invoke instanceof Error) throw server.invoke;
        return server.invoke;
      },
    },
  },
}));

const { cancelInvitation, deleteCrewSignIn, inviteSupervisor, makeResetCode, resendInvitation, rosterSignIns } = await import('../src/lib/api');
const {
  accountWords,
  deleteSignInQuestion,
  groupCode,
  inviteAddress,
  makeSupervisorBy,
  makeSupervisorByEmail,
  RESET_CODE_HELP,
  signInTools,
} = await import('../src/lib/signIns');
import type { RosterSignIn } from '../src/lib/server';

const NOW = Date.UTC(2026, 10, 20, 18);
const CLAIMED = '2026-11-03T15:00:00.000Z';
const dayOf = (iso: string) => `${fmtDayShort(Date.parse(iso))}, ${new Date(Date.parse(iso)).getFullYear()}`;

const signIn = (over: Partial<RosterSignIn> = {}): RosterSignIn => ({
  roster_id: 'row-sam-ortiz',
  sign_in: 'none',
  locked_until: null,
  needs_reset: false,
  invitation_id: null,
  invited_email: null,
  invited_at: null,
  invitation_lapsed: false,
  ...over,
});

describe('accountWords', () => {
  it('says not joined yet for a row nobody holds', () => {
    expect(accountWords(signIn(), null, NOW)).toBe('Not joined yet');
  });

  it('says joined with a passcode, and when', () => {
    expect(accountWords(signIn({ sign_in: 'passcode' }), CLAIMED, NOW)).toBe(`Joined with a passcode, ${dayOf(CLAIMED)}`);
  });

  it('says joined with email', () => {
    expect(accountWords(signIn({ sign_in: 'email' }), CLAIMED, NOW)).toBe(`Joined with email, ${dayOf(CLAIMED)}`);
  });

  it('says until when a passcode account is locked', () => {
    const until = new Date(NOW + 9 * 60_000).toISOString();
    expect(accountWords(signIn({ sign_in: 'passcode', locked_until: until }), CLAIMED, NOW)).toBe(`Locked until ${fmtDateTime(NOW + 9 * 60_000)}`);
  });

  it('does not say locked once the lock has passed, as a page left open sees it', () => {
    const until = new Date(NOW - 60_000).toISOString();
    expect(accountWords(signIn({ sign_in: 'passcode', locked_until: until }), CLAIMED, NOW)).toBe(`Joined with a passcode, ${dayOf(CLAIMED)}`);
  });

  it('says a locked account needs a reset, whether or not a time is also given', () => {
    expect(accountWords(signIn({ sign_in: 'passcode', needs_reset: true }), CLAIMED, NOW)).toBe('Locked, needs a reset');
    const until = new Date(NOW + 60_000).toISOString();
    expect(accountWords(signIn({ sign_in: 'passcode', needs_reset: true, locked_until: until }), CLAIMED, NOW)).toBe('Locked, needs a reset');
  });

  it('says invited, waiting to accept, for a row with an open invitation and nobody on it', () => {
    expect(accountWords(signIn({ invitation_id: 'inv-1', invited_email: 'riley@example.com', invited_at: CLAIMED }), null, NOW)).toBe('Invited, waiting to accept');
  });

  it('says an invitation whose inviter is no longer a supervisor needs to be sent again', () => {
    expect(accountWords(signIn({ invitation_id: 'inv-1', invitation_lapsed: true }), null, NOW)).toBe(
      'Invitation needs to be sent again: the supervisor who sent it is no longer one',
    );
  });

  it('says the account first and the invitation after it, for a passcode row being made a supervisor', () => {
    expect(accountWords(signIn({ sign_in: 'passcode', invitation_id: 'inv-1' }), CLAIMED, NOW)).toBe(`Joined with a passcode, ${dayOf(CLAIMED)}. Invited, waiting to accept`);
  });

  it('says what the row itself knows while the sign-ins have not loaded', () => {
    expect(accountWords(undefined, null, NOW)).toBe('Not joined yet');
    expect(accountWords(undefined, CLAIMED, NOW)).toBe(`Joined ${dayOf(CLAIMED)}`);
  });
});

describe('the tools a row gets', () => {
  const crew = { role: 'employee' as const, active: true };
  const boss = { role: 'supervisor' as const, active: true };
  const off = (t: ReturnType<typeof signInTools>) => Object.entries(t).filter(([, on]) => on).map(([k]) => k);

  it('gives Reset passcode and Delete sign-in only to a row held by a passcode account', () => {
    expect(off(signInTools(crew, signIn({ sign_in: 'passcode' })))).toEqual(['resetPasscode', 'deleteSignIn']);
    for (const kind of ['none', 'email'] as const) expect(off(signInTools(crew, signIn({ sign_in: kind })))).toEqual([]);
  });

  it('gives Invite only to a supervisor’s row with no email account and no open invitation', () => {
    expect(off(signInTools(boss, signIn()))).toEqual(['invite']);
    expect(off(signInTools(boss, signIn({ sign_in: 'email' })))).toEqual([]);
    expect(off(signInTools(crew, signIn()))).toEqual([]);
    expect(off(signInTools(boss, signIn({ invitation_id: 'inv-1' })))).toEqual(['sendAgain', 'cancelInvitation']);
  });

  it('gives Send again and Cancel to a row with an open invitation, a lapsed one included', () => {
    expect(off(signInTools(crew, signIn({ invitation_id: 'inv-1' })))).toEqual(['sendAgain', 'cancelInvitation']);
    expect(off(signInTools(crew, signIn({ invitation_id: 'inv-1', invitation_lapsed: true })))).toEqual(['sendAgain', 'cancelInvitation']);
    expect(off(signInTools(crew, signIn({ sign_in: 'passcode', invitation_id: 'inv-1' })))).toEqual(['resetPasscode', 'deleteSignIn', 'sendAgain', 'cancelInvitation']);
  });

  it('gives nothing while the sign-ins are not known, or to a row taken off the roster', () => {
    expect(off(signInTools(boss, undefined))).toEqual([]);
    expect(off(signInTools({ role: 'supervisor', active: false }, signIn()))).toEqual([]);
  });

  it('makes a supervisor of a passcode row by an invitation, and of any other by a change of role', () => {
    expect(makeSupervisorBy(signIn({ sign_in: 'passcode' }))).toBe('invite');
    expect(makeSupervisorBy(signIn({ sign_in: 'none' }))).toBe('role');
    expect(makeSupervisorBy(signIn({ sign_in: 'email' }))).toBe('role');
    expect(makeSupervisorBy(undefined)).toBe('role');
  });
});

describe('the words around a reset code and a deletion', () => {
  it('tells the person where to use the code', () => {
    expect(RESET_CODE_HELP).toBe('In the app, tap Forgot your passcode? and type this code with a new passcode.');
  });

  it('shows a code in two groups of three, leading zeros kept', () => {
    expect(groupCode('482019')).toBe('482 019');
    expect(groupCode('004217')).toBe('004 217');
  });

  it('says what deleting a sign-in does: the row and records stay, every session ends, the person can sign up again', () => {
    const q = deleteSignInQuestion('Sam Ortiz');
    expect(q).toContain('The row and every record stay with the company');
    expect(q).toContain('signed out at once');
    expect(q).toContain('sign up for the row again');
    expect(q).toContain('Sam Ortiz’s passcode sign-in');
  });

  it('says supervisors sign in with email, and that nothing changes until they accept', () => {
    const w = makeSupervisorByEmail('Sam Ortiz');
    expect(w).toContain('Supervisors sign in with email, not a passcode');
    expect(w).toContain('Nothing changes until they accept');
  });
});

describe('the address an invitation goes to', () => {
  it('cleans an address as the database does: trimmed, spaces closed up, in lower case', () => {
    expect(inviteAddress('  Riley.Quinn@Example.COM \n')).toEqual({ ok: true, address: 'riley.quinn@example.com' });
    expect(inviteAddress('lee+pit@mail.example.org')).toEqual({ ok: true, address: 'lee+pit@mail.example.org' });
    expect(inviteAddress("o'neil_sam@example.com")).toEqual({ ok: true, address: "o'neil_sam@example.com" });
  });

  const refused = (typed: string) => {
    const answer = inviteAddress(typed);
    expect(answer.ok, typed).toBe(false);
    return answer.ok ? '' : answer.why;
  };

  it('turns down nothing, and one with no @ or two', () => {
    expect(refused('   ')).toBe('Type the email address to send the invitation to.');
    expect(refused('riley.example.com')).toMatch(/one @/);
    expect(refused('a@b@example.com')).toMatch(/one @/);
    expect(refused('@example.com')).toMatch(/one @/);
    expect(refused('riley@')).toMatch(/one @/);
  });

  it('turns down a space inside, and a domain with no dot', () => {
    expect(refused('riley quinn@example.com')).toMatch(/no spaces/);
    expect(refused('riley@localhost')).toMatch(/needs a dot/);
    expect(refused('riley@example.')).toMatch(/needs a dot/);
  });

  it('turns down an address over what the database allows', () => {
    expect(refused(`${'a'.repeat(65)}@example.com`)).toMatch(/before the @ is too long/);
    expect(refused(`riley@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}.com`)).toMatch(/too long/);
    expect(refused('x'.repeat(2000))).toMatch(/too long/);
    // 64 characters before the @ is the most.
    expect(inviteAddress(`${'a'.repeat(64)}@example.com`).ok).toBe(true);
  });

  it('turns down a control or invisible character, a pasted zero-width space included', () => {
    expect(refused('riley​@example.com')).toMatch(/invisible/);
    expect(refused('riley\u0007@example.com')).toMatch(/invisible/);
    expect(refused('rile­y@example.com')).toMatch(/invisible/);
  });

  it('turns down what the database takes and Supabase Auth refuses, so an invitation never goes with no email', () => {
    // Accents, doubled dots, a dot at either end of the name, a hyphen at the edge of a label, a space-free quoted name, a display name.
    for (const typed of [
      'rílèy@example.com',
      'riley@exámple.com',
      'riley..quinn@example.com',
      '.riley@example.com',
      'riley.@example.com',
      'riley@-example.com',
      'riley@example-.com',
      'riley@example..com',
      '"riley quinn"@example.com',
      'Riley <riley@example.com>',
      'riley@[192.0.2.1]',
      'riley(comment)@example.com',
      'riley@ex_ample.com',
    ]) {
      expect(refused(typed)).toBeTruthy();
    }
    // A label of more than 63 characters.
    expect(refused(`riley@${'a'.repeat(64)}.com`)).toMatch(/cannot use/);
  });

  it('accepts only addresses that Supabase Auth’s own pattern (checkmail) also accepts', () => {
    // Supabase Auth's validateEmail uses badoux/checkmail's ValidateFormat, a long RFC 5322 pattern. Its branch for a
    // bare address is dot-atom@dot-atom; every other branch (comments, quoted names, <angle> forms, [literals]) only
    // adds to it. This checks that nothing accepted here falls outside that branch. The whole pattern was also run
    // over the same corpus, in Go, when this was written.
    const atext = "[A-Za-z0-9!#-'*+\\/=?^_`{|}~-]";
    const dotAtom = `${atext}+(\\.${atext}+)*`;
    // The core of the published pattern for a bare address: dot-atom@dot-atom, which every other branch of it (comments,
    // quoted names, <angle> forms, [literals]) only adds to.
    const checkmailCore = new RegExp(`^${dotAtom}@${dotAtom}$`);
    const parts = ['riley', 'a.b', 'a+b', "o'n", 'x_y', '-a', 'a-', '.a', 'a.', 'a..b', 'ex.com', 'e-x.co', '-x.com', 'x-.com', 'a'.repeat(64), '1.2', 'é', 'a b', '', 'a@b'];
    let accepted = 0;
    for (const local of parts) {
      for (const domain of parts) {
        const typed = `${local}@${domain}`;
        const answer = inviteAddress(typed);
        if (answer.ok) {
          accepted += 1;
          expect(checkmailCore.test(answer.address), typed).toBe(true);
          expect(answer.address.length).toBeLessThanOrEqual(254);
        }
      }
    }
    expect(accepted).toBeGreaterThan(5);
  });
});

describe('the calls to the server', () => {
  beforeEach(() => {
    server.rpc = [];
    server.answers = {};
    server.invoked = [];
    server.invoke = { data: { status: 'sent' }, error: null };
  });

  const refusedWith = (status: number, body: unknown) => ({
    data: null,
    error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } },
  });

  it('reads the sign-ins of the company with the database function', async () => {
    server.answers.roster_sign_ins = { data: [signIn()], error: null };
    expect(await rosterSignIns('company-a')).toEqual([signIn()]);
    expect(server.rpc).toEqual([{ name: 'roster_sign_ins', args: { p_company_id: 'company-a' } }]);
  });

  it('makes a reset code with the database function, a leading zero kept', async () => {
    server.answers.make_passcode_reset_code = { data: '004217', error: null };
    expect(await makeResetCode('row-sam-ortiz')).toBe('004217');
    expect(server.rpc).toEqual([{ name: 'make_passcode_reset_code', args: { p_roster_id: 'row-sam-ortiz' } }]);
  });

  it('says so, and shows no code, when the server gave none', async () => {
    server.answers.make_passcode_reset_code = { data: null, error: null };
    await expect(makeResetCode('row-sam-ortiz')).rejects.toThrow(/did not give a reset code/);
  });

  it('says a row that is not a passcode account has no code to reset', async () => {
    server.answers.make_passcode_reset_code = { data: null, error: { code: 'PT409', hint: 'not_a_passcode_account', message: 'x' } };
    await expect(makeResetCode('row-sam-ortiz')).rejects.toThrow(/not held by a passcode account any more/);
  });

  it('cancels an invitation with the database function', async () => {
    await cancelInvitation('inv-1');
    expect(server.rpc).toEqual([{ name: 'cancel_supervisor_invitation', args: { p_invitation_id: 'inv-1' } }]);
  });

  it('invites by supervisor-tools with the address as it will be kept, and sends nothing for one that is not one', async () => {
    await inviteSupervisor('row-lee-park', '  Lee.Park@Example.org ');
    expect(server.invoked).toEqual([{ name: 'supervisor-tools', options: { body: { action: 'invite', roster_id: 'row-lee-park', email: 'lee.park@example.org' }, timeout: 30_000 } }]);
    server.invoked = [];
    await expect(inviteSupervisor('row-lee-park', 'lee@localhost')).rejects.toThrow(/needs a dot/);
    expect(server.invoked).toEqual([]);
  });

  it('sends an invitation again, and deletes a crew sign-in, by supervisor-tools', async () => {
    await resendInvitation('inv-1');
    server.invoke = { data: { status: 'deleted' }, error: null };
    await deleteCrewSignIn('row-sam-ortiz');
    expect(server.invoked.map((c) => c.options.body)).toEqual([
      { action: 'resend', invitation_id: 'inv-1' },
      { action: 'delete_crew_sign_in', roster_id: 'row-sam-ortiz' },
    ]);
  });

  it('does not take an answer that is not the one asked for as done', async () => {
    server.invoke = { data: { status: 'sent' }, error: null };
    await expect(deleteCrewSignIn('row-sam-ortiz')).rejects.toThrow(/does not understand/);
  });

  it('words each refusal of the function, and keeps its code', async () => {
    const cases: [number, string, RegExp][] = [
      [401, 'signed_out', /sign-in has run out/],
      [403, 'origin_not_allowed', /only takes this from the MineMuster dashboard/],
      // A row or invitation that is not there, and one of a company the caller does not supervise, read alike.
      [404, 'not_found', /not found, or it is not one of your company/],
      [409, 'row_taken', /taken off the roster, or an email account holds it/],
      [409, 'invitation_closed', /already accepted or cancelled/],
      [409, 'not_a_passcode_account', /not held by a passcode account any more/],
      [413, 'too_large', /too much to send/],
      [500, 'not_set_up', /not set up for this yet/],
      [500, 'try_again', /did not work on the server/],
    ];
    for (const [status, error, words] of cases) {
      server.invoke = refusedWith(status, { error, message: 'x' });
      await expect(resendInvitation('inv-1'), error).rejects.toMatchObject({ code: error, message: expect.stringMatching(words) });
    }
  });

  it('gives the server’s own words for an address its database turned down', async () => {
    server.invoke = refusedWith(400, { error: 'bad_request', message: 'Type the email address to send the invitation to.' });
    await expect(inviteSupervisor('row-lee-park', 'lee.park@example.org')).rejects.toThrow('Type the email address to send the invitation to.');
  });

  it('says it is not known whether an invitation went when no answer came back, and never says it was not sent', async () => {
    server.invoke = new Error('Failed to fetch');
    await expect(inviteSupervisor('row-lee-park', 'lee.park@example.org')).rejects.toThrow(/not known whether the invitation was made/);
    await expect(deleteCrewSignIn('row-sam-ortiz')).rejects.toThrow(/not known whether the sign-in was deleted/);
  });
});
