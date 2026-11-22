// Supervisor invitations and the roster's sign-in states (migration 20261122000200). A supervisor invites
// another supervisor to the dashboard by email, from the Roster page, onto a row of the company's roster, and
// nobody is put on the row until the invited person accepts, signed in with that address, confirmed:
//   invite_supervisor             a supervisor of the row's company invites an address onto an active row that no
//                                 email account holds: one nobody holds yet, or one a passcode account holds (a
//                                 crew member made a supervisor). A new invitation cancels the row's open one;
//   resend_supervisor_invitation  a supervisor gives an open invitation another 7 days, and vouches for it from then
//                                 on, and supervisor-tools sends the email again;
//   cancel_supervisor_invitation  a supervisor cancels one;
//   account_for_email             for the server key: the account an address belongs to and whether the address is
//                                 confirmed, so supervisor-tools asks Supabase Auth to send an invite email only to
//                                 an address with no account or one not confirmed;
//   my_supervisor_invitations     the open, unexpired invitations to the caller's confirmed email that accepting could
//                                 still take;
//   accept_supervisor_invitation  the invited person takes the row, while the supervisor who sent the invitation still
//                                 is one: a passcode account on the row, and only a passcode account, is let go, with
//                                 a released hold, the row is made a supervisor's and their account is put on it;
//   roster_sign_ins               each row's sign-in for the Roster page (none, passcode or email), its lock and
//                                 its open invitation, for the company's supervisors.
//
// The functions a supervisor calls answer a row or an invitation of a company the caller does not supervise
// exactly as they answer an id nobody has, as release_roster_claim does: a refusal never tells a real id from a
// made-up one. The names are made up, every email address is on example.test, and the network addresses are
// from the ranges kept for documentation.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  BAD_INPUT,
  errorOf,
  join,
  LAST_SUPERVISOR,
  newMember,
  NO_PRIVILEGE,
  nobody,
  NOT_FOUND,
  NOT_SIGNED_IN,
  refused,
  rosterRow,
  secondSupervisor,
  startCompany,
  startDatabase,
  WRONG_STATE,
} from './harness.mjs';

// A passcode that passes the passcode rule, and one that is wrong for it.
const PASSCODE = '583920';
const WRONG = '583921';

const MINUTE = 60 * 1000;
const WEEK = 7 * 24 * 60 * MINUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAST = /at least one active supervisor/;

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const server = () => db.serviceRole();
const invite = (supervisor, rowId, email) => db.as(supervisor).call('invite_supervisor', { p_roster_id: rowId, p_email: email });
const resend = (supervisor, invitationId) => db.as(supervisor).call('resend_supervisor_invitation', { p_invitation_id: invitationId });
const cancel = (supervisor, invitationId) => db.as(supervisor).call('cancel_supervisor_invitation', { p_invitation_id: invitationId });
const accept = (account, invitationId) => db.as(account).call('accept_supervisor_invitation', { p_invitation_id: invitationId });
const myInvitations = (account) => db.as(account).callRows('my_supervisor_invitations');
const signIns = (supervisor, companyId) => db.as(supervisor).callRows('roster_sign_ins', { p_company_id: companyId });

let mailed = 0;
/** An email address no test has used yet, so one test's invitations never show in another's. */
const newAddress = (who) => `${who}-${(mailed += 1)}@example.test`;
/** The same address with a capital at the start of each part, as someone might type it. */
const inCapitals = (address) => address.replace(/(^|[.@])([a-z])/g, (_, mark, letter) => mark + letter.toUpperCase());

let sent = 0;
/** A network address no crew-auth request has come from yet, so the limit on tries never stands in the way. */
const anyAddress = () => `2001:db8:5::${(sent += 1).toString(16)}`;
/** A crew sign-in as crew-auth asks it, with the server key: the company's code, the name and a passcode. */
const crewSignIn = (company, first, last, passcode = PASSCODE) =>
  server().call('crew_sign_in_check', { p_code: company.code, p_first: first, p_last: last, p_passcode: passcode, p_address: anyAddress() });

/** A crew account, made as crew-auth makes one: an account, its passcode kept, and the name typed to join. */
async function crewMember(company, first, last) {
  const account = await db.newAccount('crew');
  await server().call('crew_keep_passcode', { p_user: account, p_passcode: PASSCODE });
  assert.equal((await join(db, account, company.code, first, last)).status, 'joined', `${first} ${last} joins`);
  return account;
}

/**
 * An account with this address, as Supabase Auth keeps one. Supabase Auth's invite makes the account of an address
 * with none, not confirmed until the person opens the link.
 */
async function accountWith(email, { confirmed = true } = {}) {
  const id = randomUUID();
  await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3::boolean then now() end)', [id, email, confirmed]);
  return id;
}

const emailOf = async (account) => (await db.adminRows('select email from auth.users where id = $1', [account]))[0].email;
const invitationOf = async (id) => (await db.adminRows('select * from public.supervisor_invitations where id = $1', [id]))[0];
/** The invitations onto a row, by id. */
const invitationsOn = async (rowId) =>
  Object.fromEntries((await db.adminRows('select * from public.supervisor_invitations where roster_id = $1', [rowId])).map((i) => [i.id, i]));
/** The ids of those still open: neither accepted nor cancelled. */
const openOf = (invitations) => Object.values(invitations).filter((i) => i.accepted_at === null && i.cancelled_at === null).map((i) => i.id);
const holdsOf = async (companyId, account) =>
  (await db.adminRows('select kind from public.join_holds where company_id = $1 and user_id = $2 order by kind', [companyId, account])).map((h) => h.kind);
const takeOff = (company, name) => db.as(company.owner).query('update public.roster set active = false where id = $1', [company.rows[name]]);
const expire = (invitationId) => db.admin("update public.supervisor_invitations set expires_at = now() - interval '1 second' where id = $1", [invitationId]);
/** How far ahead of now a time is, in milliseconds. */
const aheadOf = (time) => new Date(time).getTime() - Date.now();

/** Everything these functions could make or change, as the owner sees it. */
const everything = async () =>
  (
    await db.adminRows(`
      select (select count(*) from auth.users)::int as accounts,
             (select count(*) from public.notifications)::int as notifications,
             (select pg_catalog.jsonb_agg(i order by i.id) from public.supervisor_invitations i) as invitations,
             (select pg_catalog.jsonb_agg(h order by h.company_id, h.user_id, h.kind) from public.join_holds h) as holds,
             (select pg_catalog.jsonb_agg(r order by r.id) from public.roster r) as roster`)
  )[0];

/** Refused as not in a state to do that, with this hint. */
async function wrongState(promise, hint) {
  const error = await refused(promise, WRONG_STATE);
  assert.equal(error.hint, hint, error.message);
  return error;
}

/** Refused as a row, an invitation or a company that is not there: word for word what an id nobody has gets. */
async function notThere(promise, madeUp) {
  const error = await refused(promise, NOT_FOUND);
  assert.deepEqual(error, madeUp, 'the same answer as for an id nobody has');
}

/** A function's definition, its comments taken out. */
const definitionOf = async (fn) =>
  (await db.adminRows(`select pg_get_functiondef('public.${fn}'::regproc) as def`))[0].def.replace(/--[^\n]*/g, ' ');

/**
 * What a function does with the roster and the invitations, in the order its code does it: each statement of its
 * definition, comments taken out, that takes join_company's lock, locks a roster row, refuses for a state (PT409),
 * reads, locks or writes an invitation, or writes a roster row. PGlite is one session, so the order two calls take
 * turns in is read from the code, as the crew tests read their locks.
 */
async function stepsOf(fn) {
  const steps = [];
  for (const statement of (await definitionOf(fn)).split(';')) {
    const locks = /\bfor\s+update\b/i.test(statement);
    if (/\bpg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'join_company '/i.test(statement)) steps.push('join lock');
    else if (/\berrcode\s*=\s*'PT409'/i.test(statement)) steps.push('check');
    else if (/\bfrom\s+public\.roster\b/i.test(statement) && locks) steps.push('row lock');
    else if (/\bfrom\s+public\.supervisor_invitations\b/i.test(statement)) steps.push(locks ? 'invitation lock' : 'invitation read');
    else if (/\b(update|insert\s+into)\s+public\.supervisor_invitations\b/i.test(statement)) steps.push('invitation write');
    else if (/\bupdate\s+public\.roster\b/i.test(statement)) steps.push('row write');
  }
  return steps;
}

describe('invite_supervisor', () => {
  it('only a supervisor of the company invites, onto an active row with no email account', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
        { first: 'Kit', last: 'Marlow' },
        { first: 'Lee', last: 'Park' },
        { first: 'Jo', last: 'Vale' },
      ],
    });
    const bo = await secondSupervisor(db, company, 'Bo', 'Ellison');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    const lee = await newMember(db, company, 'Lee', 'Park');
    await takeOff(company, 'Jo Vale');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    const outsider = await db.newAccount('outsider');
    const rileyRow = company.rows['Riley J Quinn'];
    const address = newAddress('riley.quinn');
    const before = await everything();

    // Nobody signed in is told to sign in. To anyone who is not a supervisor of the company (crew, an email account
    // on the roster, a supervisor of another company, an account on no roster) the row is not there: the answer an
    // id nobody has gets, word for word. So is another company's row to a supervisor here.
    await refused(db.noAccount().call('invite_supervisor', { p_roster_id: rileyRow, p_email: address }), NOT_SIGNED_IN, /Sign in first/);
    const madeUp = await refused(invite(company.owner, nobody(), address), NOT_FOUND, /^No such roster row\.$/);
    for (const caller of [kit, lee, other.owner, outsider]) {
      await notThere(invite(caller, rileyRow, address), madeUp);
      await notThere(invite(caller, nobody(), address), madeUp);
    }
    await notThere(invite(company.owner, other.ownRow, address), madeUp);
    // The public key and the server key cannot call it at all.
    for (const session of [db.anon(), server()]) {
      await refused(session.call('invite_supervisor', { p_roster_id: rileyRow, p_email: address }), NO_PRIVILEGE, /permission denied for function invite_supervisor/);
    }
    // A row taken off the roster, and a row an email account holds (a crew member's, another supervisor's, the
    // caller's own): row_taken. Someone who already signs in with email on their row is made a supervisor with a
    // role change, not an invitation.
    for (const name of ['Jo Vale', 'Lee Park', 'Bo Ellison', 'Sam Ortiz']) await wrongState(invite(company.owner, company.rows[name], address), 'row_taken');
    // Something that is not an email address is refused for what was typed.
    for (const typed of [
      null,
      '',
      '   ',
      'riley',
      'riley@',
      '@example.test',
      'riley@example',
      'riley quinn@example.test',
      'riley@@example.test',
      'riley@example..test',
      'riley@.example.test',
      'riley@example.test.',
      'riley@exa\nmple.test',
      'riley@example.test\u200b',
      `${'r'.repeat(65)}@example.test`,
      `riley@${'e'.repeat(250)}.test`,
    ]) {
      const error = await refused(invite(company.owner, rileyRow, typed), BAD_INPUT);
      assert.equal(error.hint, 'email_invalid', JSON.stringify(typed));
    }
    // None of them wrote anything.
    assert.deepEqual(await everything(), before);

    // Any supervisor of the company invites: onto a crew row nobody holds yet, a supervisor's row nobody holds yet,
    // or a row a passcode account holds. The address is kept as typed, trimmed and in lower case, and the invitation
    // is good for 7 days.
    const ana = newAddress('ana.diaz');
    const kitAddress = newAddress('kit.marlow');
    for (const [supervisor, name, typed, kept] of [
      [company.owner, 'Riley J Quinn', `  ${inCapitals(address)} `, address],
      [bo, 'Ana Diaz', ana, ana],
      [company.owner, 'Kit Marlow', kitAddress.toUpperCase(), kitAddress],
    ]) {
      const answer = await invite(supervisor, company.rows[name], typed);
      assert.match(answer.invitation_id, UUID);
      assert.deepEqual(answer, { invitation_id: answer.invitation_id, email: kept, company_name: 'Test Pit A' });
      const made = await invitationOf(answer.invitation_id);
      assert.deepEqual(
        [made.company_id, made.roster_id, made.email, made.invited_by, made.accepted_at, made.accepted_by, made.cancelled_at],
        [company.id, company.rows[name], kept, supervisor, null, null, null],
      );
      const ahead = aheadOf(made.expires_at);
      assert.ok(ahead > WEEK - MINUTE && ahead <= WEEK + 1000, `good for ${Math.round(ahead / 1000)} s more`);
    }
    // Nobody is put on a row by an invitation: the rows, the holds and the accounts are as they were.
    const now = await everything();
    for (const part of ['roster', 'holds', 'accounts', 'notifications']) assert.deepEqual(now[part], before[part], part);
  });

  it('one open invitation per row: a new one cancels the old', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    const anaRow = company.rows['Ana Diaz'];
    const right = newAddress('ana.diaz');
    const typo = newAddress('ana.d');
    const first = (await invite(company.owner, anaRow, right)).invitation_id;
    // A typo put right: the new invitation cancels the one before.
    const second = (await invite(company.owner, anaRow, typo)).invitation_id;
    let on = await invitationsOn(anaRow);
    assert.deepEqual(Object.keys(on).sort(), [first, second].sort());
    assert.deepEqual(openOf(on), [second]);
    const firstCancelled = on[first].cancelled_at;
    assert.ok(firstCancelled instanceof Date, 'the first is cancelled');
    assert.equal(on[first].accepted_at, null);
    // Inviting the same address again cancels that one too, and so does inviting onto the row once its invitation
    // has expired. A cancelled one keeps the time it was first cancelled.
    const third = (await invite(company.owner, anaRow, typo)).invitation_id;
    await expire(third);
    const fourth = (await invite(company.owner, anaRow, right)).invitation_id;
    on = await invitationsOn(anaRow);
    assert.deepEqual(openOf(on), [fourth]);
    for (const id of [second, third]) assert.ok(on[id].cancelled_at instanceof Date, 'cancelled');
    assert.deepEqual(on[first].cancelled_at, firstCancelled);
    // An invitation onto another row leaves this row's alone.
    const riley = (await invite(company.owner, company.rows['Riley J Quinn'], newAddress('riley.quinn'))).invitation_id;
    assert.deepEqual(openOf(await invitationsOn(anaRow)), [fourth]);
    assert.deepEqual(openOf(await invitationsOn(company.rows['Riley J Quinn'])), [riley]);
    // The table itself keeps one open invitation per row, whoever writes it: a second, written in the SQL editor,
    // is refused.
    const error = await errorOf(
      db.admin('insert into public.supervisor_invitations (company_id, roster_id, email) values ($1, $2, $3)', [company.id, anaRow, right]),
    );
    assert.equal(error.code, '23505', error.message);
    assert.match(error.message, /supervisor_invitations_one_open/);
    // A cancelled invitation is closed: the address it went to cannot accept it, only the open one.
    const ana = await accountWith(right);
    await wrongState(accept(ana, first), 'invitation_closed');
    assert.deepEqual(await accept(ana, fourth), { company_id: company.id, company_name: 'Test Pit A' });
  });
});

describe('resend_supervisor_invitation and cancel_supervisor_invitation', () => {
  it('only a supervisor of the company sends an invitation again, while it is open, or cancels it', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }],
    });
    const bo = await secondSupervisor(db, company, 'Bo', 'Ellison');
    const kit = await crewMember(company, 'Kit', 'Marlow');
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Lee', last: 'Park', role: 'supervisor' }] });
    const outsider = await db.newAccount('outsider');
    const anaRow = company.rows['Ana Diaz'];
    const ana = newAddress('ana.diaz');
    const id = (await invite(company.owner, anaRow, ana)).invitation_id;
    const theirs = (await invite(other.owner, other.rows['Lee Park'], newAddress('lee.park'))).invitation_id;
    // Made a day ago.
    await db.admin("update public.supervisor_invitations set created_at = created_at - interval '1 day', expires_at = expires_at - interval '1 day' where id = $1", [id]);
    const madeAt = (await invitationOf(id)).created_at;
    const before = await everything();

    // Nobody signed in is told to sign in; to anyone who is not a supervisor of the invitation's company, the
    // invitation is not there, word for word as an id nobody has; the public key and the server key cannot call
    // either at all.
    for (const fn of ['resend_supervisor_invitation', 'cancel_supervisor_invitation']) {
      const call = (session, invitationId) => session.call(fn, { p_invitation_id: invitationId });
      await refused(call(db.noAccount(), id), NOT_SIGNED_IN, /Sign in first/);
      const madeUp = await refused(call(db.as(company.owner), nobody()), NOT_FOUND, /^No such invitation\.$/);
      for (const [caller, which] of [
        [kit, id],
        [outsider, id],
        [other.owner, id],
        [company.owner, theirs],
        [bo, theirs],
        [other.owner, nobody()],
      ]) {
        await notThere(call(db.as(caller), which), madeUp);
      }
      for (const session of [db.anon(), server()]) await refused(call(session, id), NO_PRIVILEGE, new RegExp(`permission denied for function ${fn}`));
    }
    assert.deepEqual(await everything(), before);

    // Sent again by any supervisor of the company: good for 7 days from now, with the address and the company for
    // the email the supervisor-tools function sends. When it was made stays as it was, and the supervisor who sent it
    // again vouches for it from then on.
    assert.equal((await invitationOf(id)).invited_by, company.owner);
    assert.deepEqual(await resend(bo, id), { email: ana, company_name: 'Test Pit A' });
    const renewed = (await invitationOf(id)).expires_at;
    const ahead = aheadOf(renewed);
    assert.ok(ahead > WEEK - MINUTE && ahead <= WEEK + 1000, `good for ${Math.round(ahead / 1000)} s more`);
    assert.deepEqual((await invitationOf(id)).created_at, madeAt);
    assert.equal((await invitationOf(id)).invited_by, bo);
    // Not while the row is taken off the roster: row_taken, and nothing is renewed. Put back, it is sent again.
    await takeOff(company, 'Ana Diaz');
    await wrongState(resend(company.owner, id), 'row_taken');
    assert.deepEqual((await invitationOf(id)).expires_at, renewed);
    await db.as(company.owner).query('update public.roster set active = true where id = $1', [anaRow]);
    assert.equal((await resend(company.owner, id)).email, ana);
    // Past its 7 days it is closed, and not renewed: a supervisor invites again instead. A supervisor may still
    // cancel it.
    await expire(id);
    const expiredAt = (await invitationOf(id)).expires_at;
    await wrongState(resend(company.owner, id), 'invitation_closed');
    assert.deepEqual((await invitationOf(id)).expires_at, expiredAt);
    assert.equal(await cancel(company.owner, id), '');
    assert.ok((await invitationOf(id)).cancelled_at instanceof Date);

    // Not once an email account holds the row: Riley Quinn typed his name with an account of his own.
    const rileyRow = company.rows['Riley J Quinn'];
    const rileyAddress = newAddress('riley.quinn');
    const rileyInvite = (await invite(company.owner, rileyRow, rileyAddress)).invitation_id;
    const riley = await accountWith(rileyAddress);
    assert.equal((await join(db, riley, company.code, 'Riley', 'Quinn')).status, 'joined');
    await wrongState(resend(company.owner, rileyInvite), 'row_taken');
    // Cancelled, it is closed to sending again and to accepting. Cancelling it again changes nothing.
    assert.equal(await cancel(bo, rileyInvite), '');
    const cancelledAt = (await invitationOf(rileyInvite)).cancelled_at;
    assert.ok(cancelledAt instanceof Date);
    assert.equal(await cancel(company.owner, rileyInvite), '');
    assert.deepEqual((await invitationOf(rileyInvite)).cancelled_at, cancelledAt);
    await wrongState(resend(company.owner, rileyInvite), 'invitation_closed');
    await wrongState(accept(riley, rileyInvite), 'invitation_closed');

    // Once accepted, an invitation is neither sent again nor cancelled: the person is on the row.
    const kitEmail = await db.newAccount('kit');
    const kitInvite = (await invite(company.owner, company.rows['Kit Marlow'], await emailOf(kitEmail))).invitation_id;
    await accept(kitEmail, kitInvite);
    await wrongState(resend(company.owner, kitInvite), 'invitation_closed');
    await wrongState(cancel(company.owner, kitInvite), 'invitation_closed');
    assert.equal((await invitationOf(kitInvite)).cancelled_at, null);
    assert.equal((await rosterRow(db, company.rows['Kit Marlow'])).user_id, kitEmail);
  });
});

describe('accept_supervisor_invitation', () => {
  it('an invitation is accepted only with the invited, confirmed email, before it expires', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const anaRow = company.rows['Ana Diaz'];
    const address = newAddress('ana.diaz');
    const id = (await invite(company.owner, anaRow, address)).invitation_id;
    // Supabase Auth makes the account of an address with none when it sends the invite email, and confirms the
    // address once the link is opened. It may keep an address in its own capitals.
    const ana = await accountWith(inCapitals(address), { confirmed: false });
    const someone = await db.newAccount('someone');
    const anonymous = await accountWith(null, { confirmed: false });
    const before = await everything();

    await refused(db.noAccount().call('accept_supervisor_invitation', { p_invitation_id: id }), NOT_SIGNED_IN, /Sign in first/);
    await refused(accept(ana, nobody()), NOT_FOUND, /^No such invitation\.$/);
    for (const session of [db.anon(), server()]) {
      await refused(session.call('accept_supervisor_invitation', { p_invitation_id: id }), NO_PRIVILEGE, /permission denied for function accept_supervisor_invitation/);
    }
    // Another confirmed address, the invited address before it is confirmed, an anonymous sign-in with no address:
    // wrong_email.
    await wrongState(accept(someone, id), 'wrong_email');
    await wrongState(accept(ana, id), 'wrong_email');
    await wrongState(db.as(anonymous, { is_anonymous: true }).call('accept_supervisor_invitation', { p_invitation_id: id }), 'wrong_email');
    // An account Supabase Auth has banned or soft-deleted has no powers left, though its token still works: it has
    // no confirmed address to accept with.
    await db.admin('update auth.users set email_confirmed_at = now() where id = $1', [ana]);
    for (const [gone, back] of [
      ["update auth.users set banned_until = now() + interval '100 years' where id = $1", 'update auth.users set banned_until = null where id = $1'],
      ['update auth.users set deleted_at = now() where id = $1', 'update auth.users set deleted_at = null where id = $1'],
    ]) {
      await db.admin(gone, [ana]);
      await wrongState(accept(ana, id), 'wrong_email');
      await db.admin(back, [ana]);
    }
    assert.deepEqual(await everything(), before);

    // Past its 7 days the invited address is turned away too, and it alone learns why: anyone else is told the
    // invitation is not theirs.
    await expire(id);
    await wrongState(accept(ana, id), 'invitation_closed');
    await wrongState(accept(someone, id), 'wrong_email');
    assert.equal((await rosterRow(db, anaRow)).user_id, null);

    // Invited again, the confirmed address takes the row, whatever capitals and spaces it was typed with.
    const again = (await invite(company.owner, anaRow, ` ${address.toUpperCase()} `)).invitation_id;
    assert.deepEqual(await accept(ana, again), { company_id: company.id, company_name: 'Test Pit A' });
    const row = await rosterRow(db, anaRow);
    assert.deepEqual([row.role, row.user_id, row.active], ['supervisor', ana, true]);
    // Once: an accepted invitation is closed, to the account that accepted it too.
    await wrongState(accept(ana, again), 'invitation_closed');
    await wrongState(accept(ana, id), 'invitation_closed');
  });

  it("accepting makes the row a supervisor's and puts the account on it; the keep-a-supervisor guard counts nobody before", async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    const rileyRow = company.rows['Riley J Quinn'];
    const riley = await db.newAccount('riley');
    const id = (await invite(company.owner, rileyRow, await emailOf(riley))).invitation_id;

    // While the invitation is open, Sam Ortiz is still the company's only supervisor: the hard delete of his account
    // is refused, and so is every other way of stepping down, and the server is told he is the last one.
    await refused(db.admin('delete from auth.users where id = $1', [company.owner]), LAST_SUPERVISOR, LAST);
    await refused(db.as(company.owner).query("update public.roster set role = 'employee' where id = $1", [company.ownRow]), LAST_SUPERVISOR, LAST);
    await refused(db.as(company.owner).query('update public.roster set active = false where id = $1', [company.ownRow]), LAST_SUPERVISOR, LAST);
    await refused(server().call('step_down_everywhere', { user_id: company.owner }), LAST_SUPERVISOR, LAST);
    assert.equal(await server().call('is_last_supervisor', { user_id: company.owner }), true);
    // Nobody is on the invited row, which is still a crew row.
    const waiting = await rosterRow(db, rileyRow);
    assert.deepEqual([waiting.role, waiting.user_id, waiting.claimed_at, waiting.active], ['employee', null, null, true]);
    assert.equal(await db.as(riley).call('is_member', { company_id: company.id }), false);

    // Accepting makes the row a supervisor's and puts the account on it.
    assert.deepEqual(await accept(riley, id), { company_id: company.id, company_name: 'Test Pit A' });
    const row = await rosterRow(db, rileyRow);
    assert.deepEqual([row.role, row.user_id, row.active], ['supervisor', riley, true]);
    assert.ok(row.claimed_at instanceof Date);
    assert.equal(await db.as(riley).call('is_supervisor', { company_id: company.id }), true);
    assert.deepEqual(await db.as(riley).callRows('my_companies'), [{ id: company.id, name: 'Test Pit A', state: 'CA', role: 'supervisor', join_code: company.code }]);
    const kept = await invitationOf(id);
    assert.deepEqual([kept.accepted_by, kept.cancelled_at], [riley, null]);
    assert.ok(kept.accepted_at instanceof Date);
    assert.deepEqual(await myInvitations(riley), []);
    // From now on the guard counts the new supervisor: Sam Ortiz is not the last, and may step down. Riley Quinn is
    // then the last, and his account's hard delete is refused.
    assert.equal(await server().call('is_last_supervisor', { user_id: company.owner }), false);
    assert.equal(await db.as(company.owner).affected("update public.roster set role = 'employee' where id = $1", [company.ownRow]), 1);
    await refused(db.admin('delete from auth.users where id = $1', [riley]), LAST_SUPERVISOR, LAST);
  });

  it('accepting onto a row held by a passcode account lets that account go, with a released hold', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const kitRow = company.rows['Kit Marlow'];
    const crew = await crewMember(company, 'Kit', 'Marlow');
    // Kit Marlow is made a supervisor. Supervisors sign in with email, so he is invited at an address of his own.
    const kit = await db.newAccount('kit');
    const id = (await invite(company.owner, kitRow, await emailOf(kit))).invitation_id;
    // Until he accepts, the passcode account keeps the row and signs in with it.
    assert.equal((await rosterRow(db, kitRow)).user_id, crew);
    assert.equal((await crewSignIn(company, 'Kit', 'Marlow')).status, 'ok');

    assert.deepEqual(await accept(kit, id), { company_id: company.id, company_name: 'Test Pit A' });
    // The row is a supervisor's, with his email account on it.
    const row = await rosterRow(db, kitRow);
    assert.deepEqual([row.role, row.user_id, row.active], ['supervisor', kit, true]);
    assert.equal(await db.as(kit).call('is_supervisor', { company_id: company.id }), true);
    assert.deepEqual(await holdsOf(company.id, kit), []);
    // The passcode account is let go of, and held, as release_roster_claim holds an account...
    assert.deepEqual(await db.adminRows('select id from public.roster where user_id = $1', [crew]), []);
    assert.deepEqual(await holdsOf(company.id, crew), ['released']);
    assert.equal(await db.as(crew).call('is_member', { company_id: company.id }), false);
    // ...so it cannot take the row back by typing the name: that leaves a request for a supervisor. The name signs in
    // with email now.
    assert.deepEqual(await join(db, crew, company.code, 'Kit', 'Marlow'), { status: 'pending', company_name: 'Test Pit A', reason: 'released' });
    assert.deepEqual(await crewSignIn(company, 'Kit', 'Marlow'), { status: 'use_email' });
  });

  it("an account already on the company's roster cannot accept an invitation to another row there", async () => {
    const company = await startCompany(db, { roster: [{ first: 'Lee', last: 'Park' }, { first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    const lee = await newMember(db, company, 'Lee', 'Park');
    const anaRow = company.rows['Ana Diaz'];
    const id = (await invite(company.owner, anaRow, await emailOf(lee))).invitation_id;
    const own = (await invite(company.owner, company.rows['Riley J Quinn'], await emailOf(company.owner))).invitation_id;
    // On the roster as crew, or as its supervisor: already_on_roster, and nothing is changed.
    let before = await everything();
    await wrongState(accept(lee, id), 'already_on_roster');
    await wrongState(accept(company.owner, own), 'already_on_roster');
    assert.deepEqual(await everything(), before);
    // Taken off the roster, the account still holds its row there, which a supervisor can put back: the same.
    await takeOff(company, 'Lee Park');
    before = await everything();
    await wrongState(accept(lee, id), 'already_on_roster');
    assert.deepEqual(await everything(), before);

    // Another company's roster is no bar: a supervisor of Test Pit B is invited, accepts, and supervises both.
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    const theirs = (await invite(company.owner, anaRow, await emailOf(other.owner))).invitation_id;
    assert.deepEqual(await accept(other.owner, theirs), { company_id: company.id, company_name: 'Test Pit A' });
    assert.deepEqual(
      (await db.as(other.owner).callRows('my_companies')).map((c) => [c.name, c.role]),
      [
        ['Test Pit A', 'supervisor'],
        ['Test Pit B', 'supervisor'],
      ],
    );
  });

  it('a passcode account accepts no invitation, even one sent to its own hidden address, and nothing is changed', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    const other = await startCompany(db, {
      name: 'Test Pit B',
      supervisor: ['Pat', 'Cole'],
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Kit', last: 'Marlow' }],
    });
    const crew = await crewMember(company, 'Kit', 'Marlow');
    const otherKit = await crewMember(other, 'Kit', 'Marlow');
    // crew-auth makes a crew account with its hidden address confirmed, so that no mail is ever sent to it.
    const hidden = await emailOf(crew);
    // Onto its own row, to make it a supervisor: it holds the row already.
    const own = (await invite(company.owner, company.rows['Kit Marlow'], hidden)).invitation_id;
    await wrongState(accept(crew, own), 'already_on_roster');
    // In another company, onto a supervisor's row nobody holds, or onto a row another passcode account holds: the
    // roster refuses a supervisor's row to a passcode account, and the whole of accepting is undone, letting go of
    // the other passcode account included.
    for (const row of [other.rows['Ana Diaz'], other.rows['Kit Marlow']]) {
      const id = (await invite(other.owner, row, hidden)).invitation_id;
      const before = await everything();
      await wrongState(accept(crew, id), 'supervisor_needs_email');
      assert.deepEqual(await everything(), before);
    }
    assert.equal((await rosterRow(db, other.rows['Kit Marlow'])).user_id, otherKit);
  });

  it('accepting answers row_taken once the row is taken off the roster or an email account holds it, and lets go of nobody', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }] });
    // Ana Diaz is invited to her supervisor's row, which is then taken off the roster.
    const ana = await db.newAccount('ana');
    const anaInvite = (await invite(company.owner, company.rows['Ana Diaz'], await emailOf(ana))).invitation_id;
    await takeOff(company, 'Ana Diaz');
    let before = await everything();
    await wrongState(accept(ana, anaInvite), 'row_taken');
    assert.deepEqual(await everything(), before);
    // Riley J Quinn's crew row is offered to Lee Park, and then Riley Quinn types his name with an email account of
    // his own, which claims the row. Accepting lets go of no email account: only a passcode account is ever let go.
    const lee = await db.newAccount('lee');
    const rileyInvite = (await invite(company.owner, company.rows['Riley J Quinn'], await emailOf(lee))).invitation_id;
    const riley = await db.newAccount('riley');
    assert.equal((await join(db, riley, company.code, 'Riley', 'Quinn')).status, 'joined');
    before = await everything();
    await wrongState(accept(lee, rileyInvite), 'row_taken');
    assert.deepEqual(await everything(), before);
    // Riley Quinn keeps his row, a crew row still, with no hold on his account; neither of the invited is on a row.
    const row = await rosterRow(db, company.rows['Riley J Quinn']);
    assert.deepEqual([row.user_id, row.role, row.active], [riley, 'employee', true]);
    for (const account of [riley, ana, lee]) assert.deepEqual(await holdsOf(company.id, account), []);
    assert.deepEqual(await db.adminRows('select id from public.roster where user_id = any ($1)', [[ana, lee]]), []);
  });

  it("an invitation lapses with its inviter's powers, and a supervisor who sends it again vouches for it", async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Kit', last: 'Marlow' }],
    });
    const bo = await secondSupervisor(db, company, 'Bo', 'Ellison');
    const jo = await secondSupervisor(db, company, 'Jo', 'Vale');
    const maria = await secondSupervisor(db, company, 'Maria', 'De La Cruz');
    const ana = await db.newAccount('ana');
    const riley = await db.newAccount('riley');
    const kit = await db.newAccount('kit');
    const byBo = (await invite(bo, company.rows['Ana Diaz'], await emailOf(ana))).invitation_id;
    const byJo = (await invite(jo, company.rows['Riley J Quinn'], await emailOf(riley))).invitation_id;
    const byMaria = (await invite(maria, company.rows['Kit Marlow'], await emailOf(kit))).invitation_id;
    const listed = async (account) => (await myInvitations(account)).map((i) => i.id);
    for (const [account, id] of [[ana, byBo], [riley, byJo], [kit, byMaria]]) assert.deepEqual(await listed(account), [id]);

    // An invitation speaks with its inviter's authority. Bo Ellison is taken off the roster, and his invitation is
    // closed to accepting and no longer listed.
    await takeOff(company, 'Bo Ellison');
    await wrongState(accept(ana, byBo), 'invitation_closed');
    assert.deepEqual(await listed(ana), []);
    // Jo Vale steps down to crew: the same.
    await db.as(jo).query("update public.roster set role = 'employee' where id = $1", [company.rows['Jo Vale']]);
    await wrongState(accept(riley, byJo), 'invitation_closed');
    assert.deepEqual(await listed(riley), []);
    // An inviter Supabase Auth has banned has no powers while the ban lasts, as is_supervisor counts one.
    await db.admin("update auth.users set banned_until = now() + interval '100 years' where id = $1", [maria]);
    await wrongState(accept(kit, byMaria), 'invitation_closed');
    assert.deepEqual(await listed(kit), []);
    await db.admin('update auth.users set banned_until = null where id = $1', [maria]);
    assert.deepEqual(await listed(kit), [byMaria]);
    // An inviter whose account is deleted is no longer named, and vouches for nothing.
    await db.admin('delete from auth.users where id = $1', [maria]);
    assert.equal((await invitationOf(byMaria)).invited_by, null);
    await wrongState(accept(kit, byMaria), 'invitation_closed');
    assert.deepEqual(await listed(kit), []);
    // None of them put anyone on a row.
    for (const name of ['Ana Diaz', 'Riley J Quinn', 'Kit Marlow']) assert.equal((await rosterRow(db, company.rows[name])).user_id, null, name);

    // A supervisor who sends an invitation again vouches for it from then on: it is listed, and accepted.
    for (const [account, id] of [[ana, byBo], [riley, byJo], [kit, byMaria]]) {
      await resend(company.owner, id);
      assert.equal((await invitationOf(id)).invited_by, company.owner);
      assert.deepEqual(await listed(account), [id]);
      assert.deepEqual(await accept(account, id), { company_id: company.id, company_name: 'Test Pit A' });
    }
    assert.equal(await db.as(ana).call('is_supervisor', { company_id: company.id }), true);
  });
});

describe('my_supervisor_invitations', () => {
  it('my invitations lists only open, unexpired ones for my confirmed email', async () => {
    const a = await startCompany(db, {
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Jo', last: 'Vale' }, { first: 'Kit', last: 'Marlow' }],
    });
    const b = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Lee', last: 'Park', role: 'supervisor' }] });
    // Supabase Auth may keep an address in its own capitals: addresses are compared trimmed and in lower case.
    const mine = newAddress('ana.diaz');
    const someoneElses = newAddress('kit.marlow');
    const me = await accountWith(inCapitals(mine));
    const open = (await invite(a.owner, a.rows['Ana Diaz'], mine)).invitation_id;
    const elsewhere = (await invite(b.owner, b.rows['Lee Park'], ` ${mine.toUpperCase()}`)).invitation_id;
    await cancel(a.owner, (await invite(a.owner, a.rows['Riley J Quinn'], mine)).invitation_id);
    await expire((await invite(a.owner, a.rows['Jo Vale'], mine)).invitation_id);
    await invite(a.owner, a.rows['Kit Marlow'], someoneElses);

    // The open, unexpired ones to my address, oldest first: the company, the row's name and until when.
    const until = async (id) => (await invitationOf(id)).expires_at;
    assert.deepEqual(await myInvitations(me), [
      { id: open, company_id: a.id, company_name: 'Test Pit A', first_name: 'Ana', last_name: 'Diaz', expires_at: await until(open) },
      { id: elsewhere, company_id: b.id, company_name: 'Test Pit B', first_name: 'Lee', last_name: 'Park', expires_at: await until(elsewhere) },
    ]);
    // One accepted is no longer listed.
    await accept(me, open);
    assert.deepEqual((await myInvitations(me)).map((i) => i.id), [elsewhere]);

    // An address not yet confirmed, another address, and an account Supabase Auth has banned see none.
    assert.deepEqual(await myInvitations(await accountWith(someoneElses, { confirmed: false })), []);
    assert.deepEqual(await myInvitations(await db.newAccount('someone')), []);
    await db.admin("update auth.users set banned_until = now() + interval '100 years' where id = $1", [me]);
    assert.deepEqual(await myInvitations(me), []);
    // Nobody signed in is told to sign in, and the public key and the server key cannot call it.
    await refused(db.noAccount().callRows('my_supervisor_invitations'), NOT_SIGNED_IN, /Sign in first/);
    for (const session of [db.anon(), server()]) {
      await refused(session.callRows('my_supervisor_invitations'), NO_PRIVILEGE, /permission denied for function my_supervisor_invitations/);
    }
  });

  it('my invitations leave out those accepting would turn down for their row: taken off the roster, or held with email', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }, { first: 'Kit', last: 'Marlow' }, { first: 'Riley J', last: 'Quinn' }, { first: 'Jo', last: 'Vale' }],
    });
    await crewMember(company, 'Kit', 'Marlow');
    // Lou Penrose is invited onto four rows: a supervisor's row nobody holds, a row a passcode account holds, and two
    // nobody holds yet. Then Riley Quinn types his name with an email account of his own, which claims his row, and
    // Jo Vale's row is taken off the roster.
    const lou = await db.newAccount('lou');
    const address = await emailOf(lou);
    const on = {};
    for (const name of ['Ana Diaz', 'Kit Marlow', 'Riley J Quinn', 'Jo Vale']) on[name] = (await invite(company.owner, company.rows[name], address)).invitation_id;
    assert.equal((await join(db, await db.newAccount('riley'), company.code, 'Riley', 'Quinn')).status, 'joined');
    await takeOff(company, 'Jo Vale');

    // Only the two whose rows are still open to an invitation are listed. Each one left out, accepting turns down.
    assert.deepEqual((await myInvitations(lou)).map((i) => i.id).sort(), [on['Ana Diaz'], on['Kit Marlow']].sort());
    const before = await everything();
    for (const name of ['Riley J Quinn', 'Jo Vale']) await wrongState(accept(lou, on[name]), 'row_taken');
    assert.deepEqual(await everything(), before);
    // The Roster page still sees each row's invitation as it stands: its words go by the account on the row.
    const shown = Object.fromEntries((await signIns(company.owner, company.id)).map((r) => [r.roster_id, [r.sign_in, r.invitation_id]]));
    assert.deepEqual(shown[company.rows['Riley J Quinn']], ['email', on['Riley J Quinn']]);
    assert.deepEqual(shown[company.rows['Jo Vale']], ['none', on['Jo Vale']]);
  });
});

describe('roster_sign_ins', () => {
  it("the roster's sign-ins say none, passcode, email, locked, needs a reset or invited, for supervisors only", async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Riley J', last: 'Quinn' },
        { first: 'Ana', last: 'Diaz', role: 'supervisor' },
        { first: 'Kit', last: 'Marlow' },
        { first: 'Lee', last: 'Park' },
        { first: 'Jo', last: 'Vale' },
        { first: 'Bo', last: 'Ellison' },
        { first: 'Maria', last: 'De La Cruz' },
        { first: 'Lou', last: 'Penrose' },
      ],
    });
    const kit = await crewMember(company, 'Kit', 'Marlow');
    const lee = await newMember(db, company, 'Lee', 'Park');
    for (const [first, last] of [['Jo', 'Vale'], ['Bo', 'Ellison'], ['Maria', 'De La Cruz'], ['Lou', 'Penrose']]) await crewMember(company, first, last);
    await takeOff(company, 'Lou Penrose');
    const lockPassed = (name) =>
      db.admin("update public.crew_logins set locked_until = now() - interval '1 second' where user_id = (select user_id from public.roster where id = $1)", [
        company.rows[name],
      ]);
    // Jo Vale: five wrong in a row lock the account for 15 minutes.
    for (let i = 0; i < 5; i += 1) await crewSignIn(company, 'Jo', 'Vale', WRONG);
    // Bo Ellison: ten wrong in a row, across the 15 minutes, lock it until a reset.
    for (let i = 0; i < 5; i += 1) await crewSignIn(company, 'Bo', 'Ellison', WRONG);
    await lockPassed('Bo Ellison');
    for (let i = 0; i < 5; i += 1) await crewSignIn(company, 'Bo', 'Ellison', WRONG);
    // Maria De La Cruz: her 15 minutes have passed.
    for (let i = 0; i < 5; i += 1) await crewSignIn(company, 'Maria', 'De La Cruz', WRONG);
    await lockPassed('Maria De La Cruz');
    // Ana Diaz is invited to her supervisor's row, and Kit Marlow to be made a supervisor. Riley Quinn's invitation
    // has expired, and Maria's was cancelled.
    const anaAddress = newAddress('ana.diaz');
    const kitAddress = newAddress('kit.marlow');
    const ana = (await invite(company.owner, company.rows['Ana Diaz'], anaAddress)).invitation_id;
    const kitInvite = (await invite(company.owner, company.rows['Kit Marlow'], kitAddress)).invitation_id;
    await expire((await invite(company.owner, company.rows['Riley J Quinn'], newAddress('riley.quinn'))).invitation_id);
    await cancel(company.owner, (await invite(company.owner, company.rows['Maria De La Cruz'], newAddress('maria.cruz'))).invitation_id);
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'] });
    const outsider = await db.newAccount('outsider');

    const [{ locked_until: joLock }] = await db.adminRows(
      'select l.locked_until from public.crew_logins l join public.roster r on r.user_id = l.user_id where r.id = $1',
      [company.rows['Jo Vale']],
    );
    const ahead = aheadOf(joLock);
    assert.ok(ahead > 14 * MINUTE && ahead <= 15 * MINUTE + 1000, `locked for ${Math.round(ahead / 1000)} s more`);
    const invitedAt = async (id) => (await invitationOf(id)).created_at;
    const none = { sign_in: 'none', locked_until: null, needs_reset: false, invitation_id: null, invited_email: null, invited_at: null };
    const passcode = { ...none, sign_in: 'passcode' };
    const email = { ...none, sign_in: 'email' };
    const expected = {
      'Sam Ortiz': email,
      'Riley J Quinn': none,
      'Ana Diaz': { ...none, invitation_id: ana, invited_email: anaAddress, invited_at: await invitedAt(ana) },
      'Kit Marlow': { ...passcode, invitation_id: kitInvite, invited_email: kitAddress, invited_at: await invitedAt(kitInvite) },
      'Lee Park': email,
      'Jo Vale': { ...passcode, locked_until: joLock },
      'Bo Ellison': { ...passcode, needs_reset: true },
      'Maria De La Cruz': passcode,
      'Lou Penrose': passcode,
    };
    // Every row of the company, on the roster or taken off it, once each.
    const nameOf = Object.fromEntries(Object.entries(company.rows).map(([name, id]) => [id, name]));
    const rows = await signIns(company.owner, company.id);
    assert.equal(rows.length, Object.keys(company.rows).length);
    assert.deepEqual(Object.fromEntries(rows.map(({ roster_id: id, ...rest }) => [nameOf[id], rest])), expected);

    // For the company's supervisors only, as company_billing answers: nobody signed in is told to sign in, and to
    // anyone else (crew, an email account on the roster, a supervisor of another company, an account on no roster)
    // the company is not there, word for word as one nobody has. The public key and the server key cannot call it.
    await refused(db.noAccount().callRows('roster_sign_ins', { p_company_id: company.id }), NOT_SIGNED_IN, /Sign in first/);
    const madeUp = await refused(signIns(company.owner, nobody()), NOT_FOUND, /^No such company\.$/);
    for (const caller of [kit, lee, other.owner, outsider]) await notThere(signIns(caller, company.id), madeUp);
    await notThere(signIns(company.owner, other.id), madeUp);
    await notThere(signIns(company.owner, null), madeUp);
    for (const session of [db.anon(), server()]) {
      await refused(session.callRows('roster_sign_ins', { p_company_id: company.id }), NO_PRIVILEGE, /permission denied for function roster_sign_ins/);
    }
  });
});

describe('account_for_email', () => {
  it('gives the account an address belongs to, and whether its address is confirmed, to the server key alone', async () => {
    const confirmed = await db.newAccount('found');
    const waiting = await db.newAccount('waiting', { confirmed: false });
    assert.deepEqual(
      await db.adminRows('select id, email_confirmed_at is not null as confirmed from auth.users where id = any ($1) order by email', [[confirmed, waiting]]),
      [
        { id: confirmed, confirmed: true },
        { id: waiting, confirmed: false },
      ],
      'newAccount confirms the address unless it is told not to',
    );
    const find = (email) => server().callRows('account_for_email', { p_email: email });
    assert.deepEqual(await find(await emailOf(confirmed)), [{ user_id: confirmed, confirmed: true }]);
    assert.deepEqual(await find(await emailOf(waiting)), [{ user_id: waiting, confirmed: false }]);
    // Trimmed and in any capitals, as an invitation keeps its address, and an address Supabase Auth keeps in capitals.
    assert.deepEqual(await find(`  ${(await emailOf(confirmed)).toUpperCase()} `), [{ user_id: confirmed, confirmed: true }]);
    const lou = newAddress('lou.penrose');
    const capitals = await accountWith(inCapitals(lou));
    assert.deepEqual(await find(lou), [{ user_id: capitals, confirmed: true }]);
    // An address no account has, and none at all: no row.
    for (const typed of [newAddress('nobody'), '', '   ', null]) assert.deepEqual(await find(typed), [], JSON.stringify(typed));

    // Supabase Auth's first invite makes the account of a new address, not confirmed until its link is opened. Its
    // invite endpoint sends again to an address that is not confirmed and refuses one that is, so the
    // supervisor-tools function asks it to invite when there is no row or the address is not confirmed, and never
    // once it is: that account's invitation waits on the dashboard.
    const jo = newAddress('jo.vale');
    const invited = await accountWith(jo, { confirmed: false });
    assert.deepEqual(await find(jo), [{ user_id: invited, confirmed: false }]);
    await db.admin('update auth.users set email_confirmed_at = now() where id = $1', [invited]);
    assert.deepEqual(await find(jo), [{ user_id: invited, confirmed: true }]);
    // One row at most. Supabase Auth keeps one account for an address, but should there be two, a confirmed one is
    // the one given, so no invite is asked for an address Supabase Auth would refuse. This one, not confirmed, has the
    // lowest id there can be, so the confirmed one is not given for its id.
    const twin = '00000000-0000-4000-8000-000000000000';
    await db.admin('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, null)', [twin, inCapitals(jo)]);
    assert.deepEqual(await find(jo), [{ user_id: invited, confirmed: true }]);

    // The supervisor-tools function asks it with the server key, to decide whether Supabase Auth sends an invite
    // email. Nobody else can call it.
    for (const session of [db.anon(), db.as(confirmed), db.noAccount()]) {
      await refused(session.callRows('account_for_email', { p_email: await emailOf(confirmed) }), NO_PRIVILEGE, /permission denied for function account_for_email/);
    }
  });
});

describe('the order rows and invitations are locked in', () => {
  it('a row first, then its invitation, in every function that takes both, as deleting the row or the company does', async () => {
    // Deleting a roster row locks it, and then its invitations through the cascade, and deleting a company reaches its
    // invitations through its rows alone. Each function here takes a row before its invitation, then checks under
    // both locks, then writes, so none holds an invitation while it waits for that invitation's row. Those given an
    // invitation find its row first with no lock. Accepting takes join_company's lock before the row, and the
    // roster's write trigger takes the account's lock in the row writes, after both.
    assert.deepEqual(await stepsOf('invite_supervisor'), ['row lock', 'check', 'invitation write', 'invitation write']);
    assert.deepEqual(await stepsOf('resend_supervisor_invitation'), ['invitation read', 'row lock', 'invitation lock', 'check', 'check', 'invitation write']);
    // Accepting checks the address, that the invitation is open, that its inviter is still a supervisor, that the
    // caller is not on the roster and that the row is open to it, and, before it lets go of the account on the row,
    // that this is a passcode account.
    assert.deepEqual(await stepsOf('accept_supervisor_invitation'), [
      'invitation read',
      'join lock',
      'row lock',
      'invitation lock',
      'check',
      'check',
      'check',
      'check',
      'check',
      'check',
      'row write',
      'row write',
      'row write',
      'invitation write',
    ]);
    // Cancelling takes the invitation alone, and no row.
    assert.deepEqual(await stepsOf('cancel_supervisor_invitation'), ['invitation lock', 'check', 'invitation write']);

    // No key of an invitation's own points at its company: it reaches the company through its row.
    const keys = await db.adminRows(`
      select c.conname as name, rn.nspname || '.' || rc.relname as refers_to, c.confdeltype::text as on_delete
      from pg_constraint c
      join pg_class rc on rc.oid = c.confrelid
      join pg_namespace rn on rn.oid = rc.relnamespace
      where c.conrelid = 'public.supervisor_invitations'::regclass and c.contype = 'f'
      order by c.conname`);
    assert.deepEqual(keys, [
      { name: 'supervisor_invitations_accepted_by_fkey', refers_to: 'auth.users', on_delete: 'n' },
      { name: 'supervisor_invitations_invited_by_fkey', refers_to: 'auth.users', on_delete: 'n' },
      { name: 'supervisor_invitations_row_same_company', refers_to: 'public.roster', on_delete: 'c' },
    ]);
    // So deleting a company deletes its rows, and they their invitations; deleting a row deletes its own. Another
    // company's are left alone.
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const other = await startCompany(db, { name: 'Test Pit B', supervisor: ['Pat', 'Cole'], roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    const ours = (await invite(company.owner, company.rows['Ana Diaz'], newAddress('ana.diaz'))).invitation_id;
    const theirs = (await invite(other.owner, other.rows['Ana Diaz'], newAddress('ana.diaz'))).invitation_id;
    await server().query('delete from public.companies where id = $1', [company.id]);
    assert.equal(await invitationOf(ours), undefined);
    assert.ok(await invitationOf(theirs), "another company's invitation stays");
    await db.as(other.owner).query('delete from public.roster where id = $1', [other.rows['Ana Diaz']]);
    assert.equal(await invitationOf(theirs), undefined);
  });
});

describe('who may call them', () => {
  it('no API role reads or writes the invitations themselves, and the functions that write run where they can', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Ana', last: 'Diaz', role: 'supervisor' }] });
    await invite(company.owner, company.rows['Ana Diaz'], newAddress('ana.diaz'));
    for (const session of [db.anon(), db.as(company.owner), server()]) {
      for (const sql of [
        'select * from public.supervisor_invitations',
        "update public.supervisor_invitations set expires_at = now() + interval '1 year'",
        'delete from public.supervisor_invitations',
      ]) {
        await refused(session.query(sql), NO_PRIVILEGE, /permission denied for table supervisor_invitations/);
      }
    }
    // Those that write are volatile, so PostgREST runs them by POST in a transaction that can write; those that only
    // read are stable.
    const kinds = await db.adminRows('select proname, provolatile from pg_proc where proname = any ($1) order by proname', [
      [
        'accept_supervisor_invitation',
        'account_for_email',
        'cancel_supervisor_invitation',
        'invite_supervisor',
        'my_supervisor_invitations',
        'resend_supervisor_invitation',
        'roster_sign_ins',
      ],
    ]);
    assert.deepEqual(kinds, [
      { proname: 'accept_supervisor_invitation', provolatile: 'v' },
      { proname: 'account_for_email', provolatile: 's' },
      { proname: 'cancel_supervisor_invitation', provolatile: 'v' },
      { proname: 'invite_supervisor', provolatile: 'v' },
      { proname: 'my_supervisor_invitations', provolatile: 's' },
      { proname: 'resend_supervisor_invitation', provolatile: 'v' },
      { proname: 'roster_sign_ins', provolatile: 's' },
    ]);
  });
});
