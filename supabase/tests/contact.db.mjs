// The contact form on minemuster.com (migration 20261117000500):
// submit_contact_request keeps what a visitor sent, cleaned and checked, for
// the owner to read in the table editor. Anyone may call it with the
// publishable key; nobody reads what it kept through the API. A bot that fills
// in the hidden website field is answered as if it had worked, and nothing is
// kept. There are limits per email address, per sender (the network address
// the request came from, kept only as a keyed hash, for an hour) and in all.
//
// The names, addresses and messages here are made up.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { after, beforeEach, before, describe, it } from 'node:test';
import { BAD_INPUT, NO_PRIVILEGE, refused, startDatabase } from './harness.mjs';

const TOO_MANY = 'PT429';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});
// Each test starts with no messages kept, so the limits are its own.
beforeEach(async () => {
  await db.admin('delete from public.contact_requests');
  await db.admin('delete from public.contact_senders');
});

let made = 0;
/** A message from the form, with a fresh address unless one is given. */
function form(fields = {}) {
  made += 1;
  return {
    p_name: 'Pat Cole',
    p_company: 'Test Pit A',
    p_email: `pat${made}@example.test`,
    p_phone: '555-0100',
    p_message: 'We run two crews. Can we see the equipment checklist?',
    p_website: '',
    ...fields,
  };
}

const send = (fields, session = db.anon()) => session.call('submit_contact_request', form(fields));

/** The request as it reaches PostgREST from this network address (documentation addresses only). */
const from = (address) => db.anon({ headers: { 'x-forwarded-for': address, 'user-agent': 'test' } });

const kept = () => db.adminRows('select name, company, email, phone, message, handled from public.contact_requests order by created_at, id');

/** Messages already kept, as if sent `ago` before now. */
async function keptBefore(count, ago, email = null) {
  await db.admin(
    `insert into public.contact_requests (name, email, message, created_at)
     select 'Bo Lark', coalesce($3, 'bo' || g || '@example.test'), 'Earlier', now() - $2::interval
     from generate_series(1, $1) g`,
    [count, ago, email],
  );
}

describe('submit_contact_request', () => {
  it('keeps a message sent by anyone, signed in or not, and answers ok', async () => {
    assert.deepEqual(await send({ p_email: 'pat@example.test' }), { ok: true });
    const account = await db.newAccount('visitor');
    assert.deepEqual(await send({ p_name: 'Lee Park', p_email: 'lee@example.test', p_company: null, p_phone: null }, db.as(account)), { ok: true });
    assert.deepEqual(await kept(), [
      { name: 'Pat Cole', company: 'Test Pit A', email: 'pat@example.test', phone: '555-0100', message: 'We run two crews. Can we see the equipment checklist?', handled: false },
      { name: 'Lee Park', company: null, email: 'lee@example.test', phone: null, message: 'We run two crews. Can we see the equipment checklist?', handled: false },
    ]);
  });

  it('keeps nothing for a bot that filled in the hidden field, and answers it ok all the same', async () => {
    assert.deepEqual(await send({ p_website: 'https://spam.example.test' }), { ok: true });
    // Even with nothing else that would pass.
    assert.deepEqual(await send({ p_website: 'x', p_name: '', p_email: 'not an address', p_message: '' }), { ok: true });
    assert.deepEqual(await kept(), []);
    // A field of spaces is not filled in.
    assert.deepEqual(await send({ p_website: '   ' }), { ok: true });
    assert.equal((await kept()).length, 1);
  });

  it('trims, closes up spaces, and takes out control and invisible characters', async () => {
    await send({
      p_name: '  Pat \t\n Cole\u200b\u0007 ',
      p_company: ' Test\u202e Pit\u00a0 A ',
      p_email: ' pat.cole@example.test\ufeff ',
      p_phone: ' (555) 0100\u0085 ',
      p_message: '\n\n  First line.\r\nSecond line,\ttabbed.\rThird\u2028line.\u0001\u200d  \n\n',
    });
    const [row] = await kept();
    assert.deepEqual(row, {
      name: 'Pat Cole',
      company: 'Test Pit A',
      email: 'pat.cole@example.test',
      phone: '(555) 0100',
      message: 'First line.\nSecond line,\ttabbed.\nThird\nline.',
      handled: false,
    });
  });

  it('turns back what is missing or too long, with a message to show and a hint to go by', async () => {
    const cases = [
      [{ p_name: '' }, 'name_missing', /Type your name/],
      [{ p_name: ' \u200b\t ' }, 'name_missing', /Type your name/],
      [{ p_name: null }, 'name_missing', /Type your name/],
      [{ p_name: 'P'.repeat(121) }, 'name_too_long', /120 characters/],
      [{ p_email: '' }, 'email_invalid', /email address/],
      [{ p_email: null }, 'email_invalid', /email address/],
      [{ p_email: 'pat' }, 'email_invalid', /email address/],
      [{ p_email: 'pat@example' }, 'email_invalid', /email address/],
      [{ p_email: 'pat@@example.test' }, 'email_invalid', /email address/],
      [{ p_email: 'pat cole@example.test' }, 'email_invalid', /email address/],
      [{ p_email: 'pat@example..test' }, 'email_invalid', /email address/],
      [{ p_email: `${'p'.repeat(65)}@example.test` }, 'email_invalid', /email address/],
      [{ p_email: `pat@${'e'.repeat(250)}.test` }, 'email_invalid', /email address/],
      [{ p_message: '' }, 'message_missing', /Type a message/],
      [{ p_message: '\n\n \t ' }, 'message_missing', /Type a message/],
      [{ p_message: 'm'.repeat(4001) }, 'message_too_long', /4,000 characters/],
      [{ p_company: 'C'.repeat(161) }, 'company_too_long', /160 characters/],
      [{ p_phone: '5'.repeat(41) }, 'phone_too_long', /40 characters/],
    ];
    for (const [fields, hint, message] of cases) {
      const error = await refused(send(fields), BAD_INPUT, message);
      assert.equal(error.hint, hint, JSON.stringify(fields).slice(0, 80));
    }
    assert.deepEqual(await kept(), []);
    // Right at each limit is fine.
    assert.deepEqual(await send({ p_name: 'P'.repeat(120), p_message: 'm'.repeat(4000), p_company: 'C'.repeat(160), p_phone: '5'.repeat(40) }), { ok: true });
    assert.equal((await kept()).length, 1);
  });

  it('takes at most 3 messages from one address in 24 hours, whatever its capitals', async () => {
    for (const email of ['pat@example.test', 'Pat@Example.test', ' PAT@EXAMPLE.TEST ']) assert.deepEqual(await send({ p_email: email }), { ok: true });
    const error = await refused(send({ p_email: 'pat@example.test' }), TOO_MANY, /^Too many messages\. Try again later\.$/);
    assert.equal(error.hint, 'too_many');
    assert.equal((await kept()).length, 3);
    // Another address is still taken.
    assert.deepEqual(await send({ p_email: 'lee@example.test' }), { ok: true });
  });

  it('counts only the last 24 hours for one address', async () => {
    await keptBefore(3, '25 hours', 'pat@example.test');
    await keptBefore(2, '23 hours', 'pat@example.test');
    assert.deepEqual(await send({ p_email: 'pat@example.test' }), { ok: true });
    await refused(send({ p_email: 'pat@example.test' }), TOO_MANY, /Too many messages/);
  });

  it('takes at most 5 messages an hour from one sender, by the address the request came from', async () => {
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await send({}, from('203.0.113.7')), { ok: true });
    const error = await refused(send({}, from('203.0.113.7')), TOO_MANY, /^Too many messages\. Try again later\.$/);
    assert.equal(error.hint, 'too_many');
    // The first entry of X-Forwarded-For is the sender, whatever proxies follow it.
    await refused(send({}, from('203.0.113.7, 10.0.0.1')), TOO_MANY, /Too many messages/);
    // Another sender is still taken.
    assert.deepEqual(await send({}, from('198.51.100.4')), { ok: true });
    assert.equal((await kept()).length, 6);
    // An IPv6 address, whatever its capitals.
    for (let i = 0; i < 5; i += 1) await send({}, from(i % 2 ? '2001:DB8::1' : '2001:db8::1'));
    await refused(send({}, from('2001:db8::1')), TOO_MANY, /Too many messages/);
  });

  it('one sender cannot shut the form for everyone', async () => {
    // A script sends from one address with a new email each time.
    for (let i = 0; i < 30; i += 1) await send({ p_email: `bot${i}@example.test` }, from('203.0.113.9')).catch(() => null);
    assert.equal((await kept()).length, 5);
    // A visitor from anywhere else, a minute later, is taken.
    assert.deepEqual(await send({ p_email: 'real.person@example.test' }, from('198.51.100.20')), { ok: true });
    // So are 30 made-up addresses where no sender is known (as the probe sent them).
    await db.admin('delete from public.contact_requests');
    for (let i = 0; i < 30; i += 1) await send({ p_email: `bot${i}@example.test` });
    assert.deepEqual(await send({ p_email: 'real.person@example.test' }), { ok: true });
  });

  it('keeps only a keyed hash of the address, and only for the hour it counts', async () => {
    await send({}, from('203.0.113.7'));
    const [row] = await db.adminRows('select sender from public.contact_senders');
    assert.equal(row.sender.length, 32);
    assert.ok(!Buffer.from(row.sender).includes(Buffer.from('203.0.113.7')));
    // Not a plain hash anyone could match by trying every address.
    assert.notDeepEqual(Buffer.from(row.sender), createHash('sha256').update('203.0.113.7').digest());
    assert.doesNotMatch(JSON.stringify(await kept()), /203\.0\.113/);
    // An hour on, the next message takes it away.
    await db.admin("update public.contact_senders set sent_at = now() - interval '61 minutes'");
    await send({}, from('198.51.100.4'));
    assert.equal((await db.adminRows('select * from public.contact_senders')).length, 1);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await send({}, from('203.0.113.7')), { ok: true });
  });

  it('with no sender known, or a header that is not an address, the other limits still hold', async () => {
    for (const session of [db.anon(), db.anon({ headers: { 'x-forwarded-for': 'not an address' } }), db.anon({ headers: { 'user-agent': 'test' } })]) {
      for (let i = 0; i < 6; i += 1) assert.deepEqual(await send({}, session), { ok: true });
    }
    assert.deepEqual(await db.adminRows('select * from public.contact_senders'), []);
  });

  it('takes at most 100 messages an hour from everyone together, a backstop for storage', async () => {
    await keptBefore(99, '10 minutes');
    assert.deepEqual(await send(), { ok: true });
    const error = await refused(send({}, from('198.51.100.30')), TOO_MANY, /Too many messages/);
    assert.equal(error.hint, 'too_many');
    assert.equal((await kept()).length, 100);
  });

  it('counts only the last hour for everyone together', async () => {
    await keptBefore(140, '61 minutes');
    await keptBefore(99, '59 minutes');
    assert.deepEqual(await send(), { ok: true });
    await refused(send(), TOO_MANY, /Too many messages/);
  });

  it('has a bot that fills in the hidden field answered ok even past the limits', async () => {
    await keptBefore(100, '1 minute');
    assert.deepEqual(await send({ p_website: 'x' }), { ok: true });
  });

  it('turns back input far over the limits before cleaning it, at once', async () => {
    // The size of each field is checked before the first pattern is run over any of them.
    const [{ src }] = await db.adminRows("select prosrc as src from pg_proc where oid = 'public.submit_contact_request'::regproc");
    const lastSize = src.lastIndexOf('octet_length(p_');
    assert.ok(lastSize > 0 && lastSize < src.indexOf('regexp_replace'), 'every size is checked before any cleaning');
    // Made in the database, so the time is the database's own work and not the sending of megabytes:
    // 4 million letters and a million zero-width spaces in the name and the message.
    const call = (name, message) => db.anon().rows(
      `select public.submit_contact_request(p_name => ${name}, p_company => null, p_email => 'pat@example.test',
         p_phone => null, p_message => ${message}, p_website => '') as r`,
    );
    const huge = "repeat('x', 4000000) || repeat(U&'\\200B', 1000000)";
    const timed = async (work) => {
      const started = performance.now();
      const result = await work();
      return [performance.now() - started, result];
    };
    // What making the two strings costs, measured alike, so the bound holds however busy the machine is.
    // The cleaning the function used to run first cost about twenty times that.
    const [making] = await timed(() => db.anon().rows(`select octet_length(${huge}) + octet_length(${huge}) as n`));
    const [took, error] = await timed(() => refused(call(huge, huge), BAD_INPUT, /120 characters/));
    assert.equal(error.hint, 'name_too_long');
    assert.ok(took < making * 3 + 50, `a refused request took ${Math.round(took)} ms; making its strings took ${Math.round(making)} ms`);
    // Five million zero-width spaces are a message too long, not one to clean down to nothing first.
    const [makingOne] = await timed(() => db.anon().rows("select octet_length(repeat(U&'\\200B', 5000000)) as n"));
    const [tookOne, tooLong] = await timed(() => refused(call("'Pat Cole'", "repeat(U&'\\200B', 5000000)"), BAD_INPUT));
    assert.equal(tooLong.hint, 'message_too_long');
    assert.ok(tookOne < makingOne * 3 + 50, `turned back in ${Math.round(tookOne)} ms; making it took ${Math.round(makingOne)} ms`);
    // Each other field, far over: the hint of its own limit.
    const cases = [
      [{ p_email: `${'e'.repeat(2000)}@example.test` }, 'email_invalid'],
      [{ p_company: 'C'.repeat(5000) }, 'company_too_long'],
      [{ p_phone: '5'.repeat(5000) }, 'phone_too_long'],
    ];
    for (const [fields, hint] of cases) assert.equal((await refused(send(fields), BAD_INPUT)).hint, hint);
    assert.deepEqual(await kept(), []);
    // A full message in four-byte characters still fits.
    assert.deepEqual(await send({ p_message: '\u{1F6A7}'.repeat(4000) }), { ok: true });
  });

  it('takes out every invisible character, not only the common ones', async () => {
    const invisible = [
      '\u00ad', '\u034f', '\u061c', '\u115f', '\u1160', '\u17b4', '\u17b5', '\u180b', '\u180e', '\u180f',
      '\u200b', '\u200d', '\u200e', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\u206f',
      '\u2800', '\u3164', '\ufe00', '\ufe0f', '\ufeff', '\uffa0', '\ufff9', '\ufffb',
      '\u{1D173}', '\u{E0001}', '\u{E0049}', '\u{E007F}', '\u{E0100}',
    ];
    for (const char of invisible) {
      await db.admin('delete from public.contact_requests');
      await send({ p_name: `Pat${char} Cole`, p_company: `Test${char} Pit A`, p_message: `Hi${char} there` });
      const [row] = await kept();
      const code = char.codePointAt(0).toString(16);
      assert.deepEqual([row.name, row.company, row.message], ['Pat Cole', 'Test Pit A', 'Hi there'], `U+${code}`);
    }
    // A whole hidden message in tag characters, as the review found it.
    await db.admin('delete from public.contact_requests');
    const tags = '\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}';
    await send({ p_name: `Pat${tags}\u180e\u034f\u3164 Cole`, p_message: `Hi${tags}\ufe0f` });
    const [row] = await kept();
    assert.deepEqual([row.name, row.message], ['Pat Cole', 'Hi']);
    // What shows stays: accents, other scripts, emoji.
    await db.admin('delete from public.contact_requests');
    await send({ p_name: 'Zoë Ōkubo', p_message: 'Grüße, \u4f60\u597d \u{1F6A7}' });
    assert.deepEqual([(await kept())[0].name, (await kept())[0].message], ['Zoë Ōkubo', 'Grüße, \u4f60\u597d \u{1F6A7}']);
  });

  it('takes its calls one at a time, so two at once cannot both slip under a limit', async () => {
    const [{ src }] = await db.adminRows("select prosrc as src from pg_proc where oid = 'public.submit_contact_request'::regproc");
    const lock = src.indexOf('pg_advisory_xact_lock');
    assert.ok(lock > 0 && lock < src.indexOf('pg_catalog.count(*)'), 'the lock is taken before the counts');
  });
});

describe('contact_senders and contact_sender_key', () => {
  it('are read and written by no API role, the server key included', async () => {
    for (const session of [db.anon(), db.as(await db.newAccount('visitor')), db.noAccount(), db.serviceRole()]) {
      for (const table of ['contact_senders', 'contact_sender_key']) {
        await refused(session.query(`select * from public.${table}`), NO_PRIVILEGE, new RegExp(`permission denied for table ${table}`));
        await refused(session.query(`delete from public.${table}`), NO_PRIVILEGE, /permission denied/);
      }
    }
  });

  it('has one key, made at random', async () => {
    const keys = await db.adminRows('select key from public.contact_sender_key');
    assert.equal(keys.length, 1);
    assert.ok(keys[0].key.length >= 64);
    await refused(db.admin("insert into public.contact_sender_key (one, key) values (false, '\\x00')"), '23514');
  });
});

describe('contact_requests', () => {
  it('is read by no API role but the server key, and written by none', async () => {
    await send();
    for (const session of [db.anon(), db.as(await db.newAccount('visitor')), db.noAccount()]) {
      await refused(session.query('select * from public.contact_requests'), NO_PRIVILEGE, /permission denied for table contact_requests/);
      await refused(session.query("insert into public.contact_requests (name, email, message) values ('Pat Cole', 'pat@example.test', 'Hi')"), NO_PRIVILEGE, /permission denied/);
      await refused(session.query('update public.contact_requests set handled = true'), NO_PRIVILEGE, /permission denied/);
      await refused(session.query('delete from public.contact_requests'), NO_PRIVILEGE, /permission denied/);
    }
    assert.equal((await db.serviceRole().rows('select count(*)::int as n from public.contact_requests'))[0].n, 1);
    await refused(db.serviceRole().query('update public.contact_requests set handled = true'), NO_PRIVILEGE, /permission denied/);
    // The owner marks a message answered in the table editor.
    await db.admin('update public.contact_requests set handled = true');
    assert.equal((await kept())[0].handled, true);
  });
});
