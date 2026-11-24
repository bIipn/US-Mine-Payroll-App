import { crewWords, madeSupervisorWords, readCrewAnswer, type CrewAnswer } from '../serverAnswers';
import { passcodeWords } from '../passcode';
import { fmtTime } from '../../util/format';

const session = { access_token: 'a', refresh_token: 'r', expires_at: 1_800_000_000, user_id: 'u1' };
const NOW = new Date(2026, 10, 23, 9, 0).getTime();

describe('readCrewAnswer', () => {
  it('reads a company lookup', () => {
    expect(readCrewAnswer(200, { status: 'company', name: 'Test Pit A', state: 'NV' })).toEqual({ kind: 'company', name: 'Test Pit A', state: 'NV' });
  });

  it('reads a sign-in with its company, waiting and join', () => {
    const a = readCrewAnswer(200, {
      status: 'signed_in', session, company: { id: 'company-1', name: 'Test Pit A' }, waiting: true, join: { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' },
    });
    expect(a).toEqual({
      kind: 'signed_in',
      session: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_800_000_000, userId: 'u1' },
      company: { id: 'company-1', name: 'Test Pit A' },
      waiting: true,
      join: { status: 'pending', companyName: 'Test Pit A', reason: 'not_on_roster' },
      othersSignedOut: true,
    });
  });

  it('reads a confirm: a session with no company, no waiting and no join', () => {
    expect(readCrewAnswer(200, { status: 'signed_in', session })).toMatchObject({ kind: 'signed_in', company: null, waiting: false, join: null, othersSignedOut: true });
  });

  it('reads others_signed_out false from a reset', () => {
    const a = readCrewAnswer(200, { status: 'signed_in', session, company: { id: 'company-1', name: 'X' }, waiting: false, others_signed_out: false });
    expect(a).toMatchObject({ kind: 'signed_in', othersSignedOut: false });
  });

  it('reads passcode_changed', () => {
    expect(readCrewAnswer(200, { status: 'passcode_changed' })).toEqual({ kind: 'passcode_changed' });
  });

  it.each(['no_company', 'already_signed_up', 'use_email', 'no_account', 'ambiguous', 'expired', 'busy', 'denied'] as const)('reads the plain refusal %s', (status) => {
    expect(readCrewAnswer(200, { status })).toEqual({ kind: status });
  });

  it('reads wrong and bad_reset_code with the tries left', () => {
    expect(readCrewAnswer(200, { status: 'wrong', tries_left: 3 })).toEqual({ kind: 'wrong', triesLeft: 3 });
    expect(readCrewAnswer(200, { status: 'bad_reset_code', tries_left: 2 })).toEqual({ kind: 'bad_reset_code', triesLeft: 2 });
  });

  it('reads locked until a time, or until a reset', () => {
    expect(readCrewAnswer(200, { status: 'locked', until: '2026-11-23T18:30:00.000Z' })).toEqual({ kind: 'locked', until: Date.parse('2026-11-23T18:30:00.000Z') });
    expect(readCrewAnswer(200, { status: 'locked', until: null })).toEqual({ kind: 'locked', until: null });
  });

  it('treats an unreadable lock time as a server answer', () => {
    expect(readCrewAnswer(200, { status: 'locked', until: 'soon' }).kind).toBe('server');
    expect(readCrewAnswer(200, { status: 'locked' }).kind).toBe('server');
  });

  it('reads easy_passcode with its problem and bad_name with its message', () => {
    expect(readCrewAnswer(200, { status: 'easy_passcode', problem: 'easy' })).toEqual({ kind: 'easy_passcode', problem: 'easy' });
    expect(readCrewAnswer(200, { status: 'bad_name', message: 'Type it as on the roster.' })).toEqual({ kind: 'bad_name', message: 'Type it as on the roster.' });
  });

  it('reads 401 as signed_out and 410 as already_deleted', () => {
    expect(readCrewAnswer(401, { error: 'signed_out' })).toEqual({ kind: 'signed_out' });
    expect(readCrewAnswer(410, { error: 'already_deleted' })).toEqual({ kind: 'already_deleted' });
  });

  it.each([
    [200, null], [200, 'text'], [200, []], [200, { status: 'mystery' }], [200, { status: 'company', name: 'X' }],
    [200, { status: 'signed_in', session: { access_token: 'a' } }], [200, { status: 'wrong' }], [200, { status: 'easy_passcode', problem: 'odd' }],
    [200, { status: 'bad_name' }], [400, { error: 'bad_request' }], [403, { error: 'origin_not_allowed' }], [405, {}], [413, {}], [500, { error: 'try_again' }],
  ])('gives server for status %s with body %j, naming the status and not the body', (status, body) => {
    const a = readCrewAnswer(status, body);
    expect(a.kind).toBe('server');
    if (a.kind === 'server') {
      expect(a.message).toContain(`HTTP ${status}`);
      expect(a.message).not.toContain('mystery');
    }
  });
});

describe('crewWords', () => {
  const all: CrewAnswer[] = [
    { kind: 'company', name: 'Test Pit A', state: 'NV' },
    { kind: 'signed_in', session: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, userId: 'u' }, company: null, waiting: false, join: null, othersSignedOut: true },
    { kind: 'signed_in', session: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, userId: 'u' }, company: null, waiting: true, join: null, othersSignedOut: true },
    { kind: 'passcode_changed' },
    ...(['no_company', 'already_signed_up', 'use_email', 'no_account', 'ambiguous', 'expired', 'busy', 'denied', 'signed_out', 'already_deleted', 'unreachable'] as const).map((kind) => ({ kind })),
    { kind: 'wrong', triesLeft: 2 }, { kind: 'bad_reset_code', triesLeft: 1 },
    { kind: 'locked', until: NOW + 600_000 }, { kind: 'locked', until: null },
    { kind: 'easy_passcode', problem: 'easy' }, { kind: 'bad_name', message: 'Type it as on the roster.' }, { kind: 'server', message: 'x' },
  ] as CrewAnswer[];

  it('gives every answer a sentence-case title, and never asks crew for an email', () => {
    for (const a of all) {
      const w = crewWords(a, NOW);
      expect(w.title).toMatch(/^[A-Z]/);
      // Sentence case: no word after the first starts a capital, bar the company's own name.
      if (a.kind !== 'company') expect(w.title.split(' ').slice(1).join(' ')).not.toMatch(/\b[A-Z][a-z]/);
      expect(`${w.title} ${w.body ?? ''}`).not.toMatch(/e-?mail address|your email|type your email|enter your email/i);
    }
  });

  it('names the tries left on wrong', () => {
    expect(crewWords({ kind: 'wrong', triesLeft: 2 }, NOW).body).toContain('2 tries left');
    expect(crewWords({ kind: 'wrong', triesLeft: 1 }, NOW).body).toContain('1 try left');
  });

  it('gives the time a lock ends', () => {
    const until = NOW + 15 * 60_000;
    expect(crewWords({ kind: 'locked', until }, NOW).body).toContain(fmtTime(until));
  });

  it('says to ask a supervisor for a reset code when the lock has no end', () => {
    expect(crewWords({ kind: 'locked', until: null }, NOW).body).toMatch(/supervisor for a reset code/);
  });

  it('tells already_signed_up to sign in or ask a supervisor', () => {
    const w = crewWords({ kind: 'already_signed_up' }, NOW);
    expect(w.body).toMatch(/Sign in/);
    expect(w.body).toMatch(/supervisor/);
  });

  it('points no_account to the Sign up button', () => {
    const w = crewWords({ kind: 'no_account' }, NOW);
    expect(w.body).toContain('tap Sign up');
    expect(w.body).not.toMatch(/create/i);
  });

  it('points use_email to Supervisor? Sign in with email, and someone with no email sign-in yet to a supervisor’s invitation', () => {
    const body = crewWords({ kind: 'use_email' }, NOW).body;
    expect(body).toContain('Supervisor? Sign in with email');
    expect(body).toContain('If you have no email sign-in yet, ask a supervisor to invite you from the dashboard.');
  });

  it('says a reset code whose last try was wrong is used up, and to ask for a new one, not to try again', () => {
    const w = crewWords({ kind: 'bad_reset_code', triesLeft: 0 }, NOW);
    expect(w.body).toBe('That was its last try, so the code is used up. Ask a supervisor for a new one.');
    expect(`${w.title} ${w.body}`).not.toMatch(/0 tries|try again/i);
    // With tries left, it names them.
    expect(crewWords({ kind: 'bad_reset_code', triesLeft: 2 }, NOW).body).toBe('2 tries left. Check it with your supervisor and try again.');
    expect(crewWords({ kind: 'bad_reset_code', triesLeft: 1 }, NOW).body).toContain('1 try left');
  });

  it('says the new passcode is set and to sign in with it', () => {
    const w = crewWords({ kind: 'passcode_changed' }, NOW);
    expect(`${w.title} ${w.body}`).toMatch(/new passcode is set/);
    expect(w.body).toMatch(/Sign in with your new passcode/);
  });

  it('says an expired reset code ran out or was used, and to ask a supervisor for a new one', () => {
    const w = crewWords({ kind: 'expired' }, NOW);
    expect(w.title).toMatch(/run out/);
    expect(w.title).toMatch(/already used/);
    expect(w.body).toMatch(/supervisor for a new one/);
  });

  it('uses passcodeWords for easy_passcode', () => {
    expect(crewWords({ kind: 'easy_passcode', problem: 'too_short' }, NOW).body).toBe(passcodeWords('too_short'));
  });

  it('shows the server message for bad_name', () => {
    expect(crewWords({ kind: 'bad_name', message: 'Type it as on the roster.' }, NOW).body).toBe('Type it as on the roster.');
  });

  it('tells busy to wait a few minutes, and lays it on no network: Supabase Auth’s own limit is everyone’s at once', () => {
    const w = crewWords({ kind: 'busy' }, NOW);
    expect(w).toEqual({ title: 'Too many tries right now', body: 'Wait a few minutes and try again.', tone: 'warn' });
    expect(`${w.title} ${w.body}`).not.toMatch(/network/i);
  });

  it('tells unreachable there is no signal and to try again with signal', () => {
    const w = crewWords({ kind: 'unreachable' }, NOW);
    expect(w.title).toMatch(/No signal/);
    expect(w.body).toMatch(/Try again when you have signal/);
  });

  it('tells a waiting sign-in that a supervisor will let them in', () => {
    const w = crewWords(all[2], NOW);
    expect(w.tone).toBe('info');
    expect(w.body).toMatch(/supervisor will let you in/);
  });
});

describe('madeSupervisorWords', () => {
  it('tells someone made a supervisor to sign out of this phone and sign in with email at the address they were invited at', () => {
    expect(madeSupervisorWords('Test Pit A', 0)).toEqual({
      title: 'Made a supervisor?',
      body: 'Sign out of this phone, then tap Supervisor? Sign in with email and use the address you were invited at.',
    });
  });

  it('promises no sign-out while records this sign-in can no longer send are on the phone, and says what to do', () => {
    expect(madeSupervisorWords('Test Pit A', 1)).toEqual({
      title: 'Made a supervisor?',
      body:
        '1 record on this phone has not been taken by Test Pit A: it was not sent before you accepted, or the company turned it down. This passcode sign-in cannot send it now, so this phone cannot sign out without losing it. Keep it here and tell the supervisor who invited you.',
    });
    const two = madeSupervisorWords(null, 2);
    expect(two.body).toBe(
      '2 records on this phone have not been taken by your company: they were not sent before you accepted, or the company turned them down. This passcode sign-in cannot send them now, so this phone cannot sign out without losing them. Keep them here and tell the supervisor who invited you.',
    );
    expect(two.body).not.toMatch(/Sign out of this phone, then/);
  });

  it('is true of every record it counts: those never sent, and those the company turned down (heldOffRoster counts both)', () => {
    for (const held of [1, 3]) {
      const { body } = madeSupervisorWords('Test Pit A', held);
      expect(body).not.toMatch(/did not reach/);
      expect(body).toMatch(/not been taken by Test Pit A: (it was|they were) not sent before you accepted, or the company turned (it|them) down\./);
    }
  });

  it('never asks for an email address, and its title is in sentence case', () => {
    for (const held of [0, 1, 3]) {
      const w = madeSupervisorWords('Test Pit A', held);
      expect(w.title).toMatch(/^[A-Z][^A-Z]*\?$/);
      expect(`${w.title} ${w.body}`).not.toMatch(/e-?mail address|your email|type your email|enter your email/i);
    }
  });
});
