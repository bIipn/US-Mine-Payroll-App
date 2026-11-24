// Notifications: one for each join and each new request, seen only by that
// company's supervisors, who can mark them read and nothing else.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  join,
  newMember,
  NO_PRIVILEGE,
  refused,
  secondSupervisor,
  startCompany,
  startDatabase,
} from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const CREW = [
  { first: 'Riley J', last: 'Quinn' },
  { first: 'Maria', last: 'De La Cruz' },
  { first: 'Lee Roy', last: 'Park' },
  { first: 'Roy "Lee"', last: 'Park' },
];

const notificationsOf = (company) =>
  db.adminRows('select * from public.notifications where company_id = $1 order by created_at, id', [company.id]);

describe('notifications', () => {
  it('are written once for each join and each new request, and for nothing else', async () => {
    const company = await startCompany(db, { roster: CREW });
    // Starting the company tells nobody anything.
    assert.deepEqual(await notificationsOf(company), []);

    const riley = await newMember(db, company, 'Riley', 'Quinn');
    const maria = await newMember(db, company, 'Maria', 'De La Cruz');
    const asking = await db.newAccount();
    await join(db, asking, company.code, 'Pat', 'Cole');
    const claimedByAnother = await db.newAccount();
    await join(db, claimedByAnother, company.code, 'Riley J', 'Quinn');

    // None of these writes one: a second try, a name that fits two people, a code nobody has, a member trying again.
    await join(db, asking, company.code, 'Pat', 'Cole');
    await join(db, await db.newAccount(), company.code, 'Roy', 'Park');
    await join(db, await db.newAccount(), 'ZZZZZZZZ', 'Pat', 'Cole');
    await join(db, riley, company.code, 'Riley', 'Quinn');

    const requests = await db.adminRows('select id, user_id from public.join_requests where company_id = $1', [company.id]);
    const requestOf = (account) => requests.find((r) => r.user_id === account).id;
    const notes = await notificationsOf(company);
    assert.deepEqual(
      notes.map((n) => [n.kind, n.roster_id, n.request_id]),
      [
        ['joined', company.rows['Riley J Quinn'], null],
        ['joined', company.rows['Maria De La Cruz'], null],
        ['join_request', null, requestOf(asking)],
        ['join_request', null, requestOf(claimedByAnother)],
      ],
    );
    assert.ok(notes.every((n) => n.read_at === null));
    assert.ok(maria);
  });

  it("are seen by that company's supervisors and nobody else", async () => {
    const a = await startCompany(db, { roster: CREW });
    const b = await startCompany(db, { name: 'Test Pit B', roster: CREW });
    const secondOfA = await secondSupervisor(db, a, 'Ana', 'Diaz');
    const employee = await newMember(db, a, 'Riley', 'Quinn');
    const asking = await db.newAccount();
    await join(db, asking, a.code, 'Pat', 'Cole');
    await newMember(db, b, 'Maria', 'De La Cruz');

    const ofA = (await notificationsOf(a)).map((n) => n.id).sort();
    const ofB = (await notificationsOf(b)).map((n) => n.id).sort();
    assert.equal(ofA.length, 3);
    assert.equal(ofB.length, 1);

    const seenBy = async (account) => (await db.as(account).rows('select id from public.notifications')).map((n) => n.id).sort();
    assert.deepEqual(await seenBy(a.owner), ofA);
    assert.deepEqual(await seenBy(secondOfA), ofA);
    assert.deepEqual(await seenBy(b.owner), ofB);
    assert.deepEqual(await seenBy(employee), []);
    assert.deepEqual(await seenBy(asking), []);
    assert.deepEqual(await db.noAccount().rows('select id from public.notifications'), []);
    await refused(db.anon().query('select id from public.notifications'), NO_PRIVILEGE, /permission denied/);
  });

  it('are marked read by any supervisor of the company, for all of them, and can be marked unread', async () => {
    const company = await startCompany(db, { roster: CREW });
    const second = await secondSupervisor(db, company, 'Ana', 'Diaz');
    await newMember(db, company, 'Maria', 'De La Cruz');
    const [note] = (await notificationsOf(company)).filter((n) => n.roster_id === company.rows['Maria De La Cruz']);

    assert.equal(await db.as(company.owner).affected('update public.notifications set read_at = now() where id = $1', [note.id]), 1);
    const [seen] = await db.as(second).rows('select read_at from public.notifications where id = $1', [note.id]);
    assert.ok(seen.read_at instanceof Date);

    assert.equal(await db.as(second).affected('update public.notifications set read_at = null where id = $1', [note.id]), 1);
    assert.equal((await db.as(company.owner).rows('select read_at from public.notifications where id = $1', [note.id]))[0].read_at, null);
  });

  it('cannot be changed in any other way, made or removed through the API, even by a supervisor', async () => {
    const company = await startCompany(db, { roster: CREW });
    await newMember(db, company, 'Maria', 'De La Cruz');
    const before = await notificationsOf(company);
    const [note] = before;
    const as = db.as(company.owner);
    const writes = [
      ["update public.notifications set kind = 'join_request' where id = $1", [note.id]],
      ['update public.notifications set roster_id = null where id = $1', [note.id]],
      ['update public.notifications set request_id = null where id = $1', [note.id]],
      ['update public.notifications set company_id = company_id where id = $1', [note.id]],
      ["update public.notifications set created_at = now() - interval '1 day' where id = $1", [note.id]],
      ["insert into public.notifications (company_id, kind, roster_id) values ($1, 'joined', $2)", [company.id, company.ownRow]],
      ['delete from public.notifications where id = $1', [note.id]],
      ['truncate public.notifications', []],
    ];
    for (const [sql, params] of writes) await refused(as.query(sql, params), NO_PRIVILEGE, /permission denied/);
    assert.deepEqual(await notificationsOf(company), before);
  });

  it('go when the roster row or the request they point at goes', async () => {
    const company = await startCompany(db, { roster: CREW });
    const member = await newMember(db, company, 'Maria', 'De La Cruz');
    assert.ok(member);
    assert.equal((await notificationsOf(company)).length, 1);
    await db.as(company.owner).affected('delete from public.roster where id = $1', [company.rows['Maria De La Cruz']]);
    assert.deepEqual(await notificationsOf(company), []);

    const asking = await db.newAccount();
    await join(db, asking, company.code, 'Pat', 'Cole');
    assert.equal((await notificationsOf(company)).length, 1);
    // Deleting the account takes its requests, and their notifications, with it.
    await db.admin('delete from auth.users where id = $1', [asking]);
    assert.deepEqual(await notificationsOf(company), []);
  });
});
