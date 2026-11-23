// One person per phone, in a build that connects. Once a phone joined to its company has read the
// company's settings and roster to the end, it opens the account of the person its company sign-in is
// for, by itself and with no password, and nobody else's. The person whose own sign-in it is empties the
// phone by signing out of it, once nothing on it would be lost. Preview builds keep their local accounts
// as they are (store.test.ts). A made-up company and made-up people.
import { keepsTime } from '../../domain/company';
import { changesToSend, revOf, type ReceivedRow, type Standing, type SyncStatus } from '../../domain/sync';
import type { Account, Shift } from '../../domain/types';
import { SAMPLE_CREW_IDS } from '../seed';

type Loaded = typeof import('../useStore');
type UseStore = Loaded['useStore'];

/** The store as a store build starts it (eas.json): it connects, holds nobody made up and names nobody, so its roster is the company's. */
function storeBuild(): UseStore {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });
  let useStore: UseStore | undefined;
  jest.isolateModules(() => {
    useStore = (require('../useStore') as Loaded).useStore;
  });
  process.env = saved;
  return useStore!;
}

const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m, 0).getTime();
const DAY = 86_400_000;
const PIT = { id: 'c-test-a', name: 'Test Pit A', role: 'employee' as const };
const LEES_SIGN_IN = { id: 'u-lee', email: 'lee@example.test' };
const LEE: Standing = { role: 'employee', name: { firstName: 'Lee', lastName: 'Park' } };

let seq = 0;
/** A row of the company's records as read_shared_records hands it over: in the order the company wrote them. */
function row(kind: ReceivedRow['kind'], id: string, data: object): ReceivedRow {
  seq += 1;
  return { kind, id, rev: revOf(data), seq, deleted: false, data };
}
const person = (id: string, firstName: string, lastName: string, more: { role?: 'employee' | 'supervisor'; active?: boolean } = {}) =>
  row('employee', id, { id, firstName, lastName, role: more.role ?? 'employee', active: more.active ?? true });
/** The company's settings, as the dashboard's Company page saves them. */
const settings = ({ timeClock = true } = {}) =>
  row('settings', 'company', {
    company: { name: 'Test Pit A', state: 'NV', pay: null, ...(timeClock ? null : { timeClock: false }) },
    site: null,
    workweekStartsOn: 0,
    allowSectionAllOk: true,
  });

/** A phone that has just signed in to Test Pit A with this sign-in: joined, and nobody signed in to the app yet. */
function joinedPhone(signIn = LEES_SIGN_IN) {
  const useStore = storeBuild();
  const g = () => useStore.getState();
  g().ensureSeeded();
  expect(g().connectCompany(PIT, signIn)).toEqual({ ok: true });
  g().ensureReceiving();
  const ctx = () => ({ company: PIT.id, account: signIn.id, epoch: g().receiving!.epoch });
  /** A round's reads, as src/services/sync.ts hands them to the store: the sign-in's own row, then the company's records a page at a time, to an empty page. */
  const round = (standing: Standing | null, ...pages: ReceivedRow[][]) => {
    expect(g().applyStanding(ctx(), standing)).toBe(true);
    // Off the company's roster: the round ends there.
    if (!standing) return;
    for (const page of [...pages, []]) expect(g().applyReceived(ctx(), page)).toBe(true);
  };
  return { useStore, g, ctx, round };
}

const shiftOf = (id: string, clockIn: number, clockOut: number): Shift => ({ id, employeeId: 'emp-lee', clockIn: { at: clockIn }, clockOut: { at: clockOut }, lunches: [], breaks: [] });

/** What a round would send from this phone now. */
function waiting(useStore: UseStore) {
  const s = useStore.getState();
  const r = s.receiving!;
  return changesToSend(s, s.synced, SAMPLE_CREW_IDS, { connected: true, role: r.role, caughtUp: r.caughtUpAt != null, unreadable: r.unreadable, held: r.held });
}
/** The company took everything a round would send. */
function allSent(useStore: UseStore) {
  useStore.getState().markSynced(waiting(useStore).map(({ key, rev }) => ({ key, rev })), PIT.id);
}
/** What the store keeps on the device. */
const kept = (useStore: UseStore) => useStore.persist.getOptions().partialize!(useStore.getState());
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  seq = 0;
  jest.useFakeTimers();
  jest.setSystemTime(at(15));
});
afterEach(() => jest.useRealTimers());

describe('the account a phone joined to its company opens', () => {
  it('opens the signed-in person’s own account once the settings and roster arrive, with no password', () => {
    const { g, ctx } = joinedPhone();
    g().applyStanding(ctx(), LEE);
    expect(g().session).toBeNull();
    g().applyReceived(ctx(), [settings(), person('emp-lee', 'Lee', 'Park'), person('emp-sam', 'Sam', 'Ortiz')]);
    // The company's rows come in the order it wrote them, so only the end of the read says they are all in.
    expect(g().session).toBeNull();
    g().applyReceived(ctx(), []);

    expect(g().session).toEqual({ accountId: g().accounts[0]?.id, employeeId: 'emp-lee' });
    expect(g().accounts).toEqual([{ id: expect.stringMatching(/^acct_/), employeeId: 'emp-lee', email: '', provider: 'company', createdAt: at(15) }]);
    // No email and nothing of a password: the company sign-in is the proof.
    expect(Object.keys(g().accounts[0]).sort()).toEqual(['createdAt', 'email', 'employeeId', 'id', 'provider']);

    // Asked again, or signed out and opened by the next round, it is the same account: never a second one.
    const first = g().session;
    expect(g().openOwnAccount()).toEqual({ ok: true });
    g().signOut();
    g().applyStanding(ctx(), LEE);
    expect(g().session).toEqual(first);
    expect(g().accounts).toHaveLength(1);

    // A phone that already holds Lee's own account opens that one.
    const other = joinedPhone();
    const lees: Account = { id: 'acct-lee', employeeId: 'emp-lee', email: 'lee@example.test', provider: 'password', createdAt: at(6) };
    other.useStore.setState({ accounts: [lees] });
    other.round(LEE, [settings(), person('emp-lee', 'Lee', 'Park')]);
    expect(other.g().session).toEqual({ accountId: 'acct-lee', employeeId: 'emp-lee' });
    expect(other.g().accounts).toEqual([lees]);
  });

  it('never opens anyone else’s account', () => {
    // The sign-in's name is nobody on the company's roster.
    const nobody = joinedPhone();
    nobody.round(LEE, [settings(), person('emp-sam', 'Sam', 'Ortiz')]);
    expect(nobody.g().session).toBeNull();
    expect(nobody.g().accounts).toEqual([]);
    expect(nobody.g().openOwnAccount()).toEqual({ ok: false, error: 'Lee Park is not on the company’s roster on this phone. See your supervisor.' });

    // It fits two people, and neither exactly.
    const two = joinedPhone({ id: 'u-riley', email: 'riley@example.test' });
    two.round({ role: 'employee', name: { firstName: 'Riley', lastName: 'Quinn' } }, [person('emp-rj', 'Riley J', 'Quinn'), person('emp-rk', 'Riley K', 'Quinn')]);
    expect(two.g().session).toBeNull();
    expect(two.g().accounts).toEqual([]);

    // The sign-in's own person is off the active roster: never someone else its name only loosely fits.
    const off = joinedPhone({ id: 'u-sam', email: 'sam@example.test' });
    off.round({ role: 'employee', name: { firstName: 'Sam', lastName: 'Ortiz' } }, [person('emp-sam', 'Sam', 'Ortiz', { active: false }), person('emp-sam-jr', 'Sam', 'Ortiz Jr')]);
    expect(off.g().session).toBeNull();
    expect(off.g().accounts).toEqual([]);

    // The company took the sign-in off its roster.
    const gone = joinedPhone();
    gone.round(LEE, [person('emp-lee', 'Lee', 'Park')]);
    gone.g().signOut();
    gone.round(null);
    expect(gone.g().session).toBeNull();

    // Someone else is signed in: they stay signed in, and their account is never Lee's.
    const sams: Account = { id: 'acct-sam', employeeId: 'emp-sam', email: 'sam@example.test', provider: 'password', createdAt: at(6) };
    const busy = joinedPhone();
    busy.useStore.setState({ accounts: [sams], session: { accountId: sams.id, employeeId: 'emp-sam' } });
    busy.round(LEE, [person('emp-lee', 'Lee', 'Park'), person('emp-sam', 'Sam', 'Ortiz')]);
    expect(busy.g().session).toEqual({ accountId: 'acct-sam', employeeId: 'emp-sam' });
    expect(busy.g().accounts).toEqual([sams]);
    expect(busy.g().openOwnAccount()).toEqual({ ok: false, error: 'Someone else is signed in on this phone.' });
    // Once they sign out, the phone opens its own person's account, a new one: Sam's stays Sam's.
    busy.g().signOut();
    busy.round(LEE);
    expect(busy.g().session?.employeeId).toBe('emp-lee');
    expect(busy.g().session?.accountId).not.toBe(sams.id);
    expect(busy.g().accounts).toContainEqual(sams);

    // A page read for another account is not applied.
    const stray = joinedPhone();
    stray.g().applyStanding(stray.ctx(), LEE);
    expect(stray.g().applyReceived({ ...stray.ctx(), account: 'u-someone-else' }, [person('emp-lee', 'Lee', 'Park')])).toBe(false);
    stray.round(LEE);
    expect(stray.g().session).toBeNull();
    expect(stray.g().accounts).toEqual([]);

    // A phone no longer joined to its company opens nobody's, though it still holds the roster Lee is on.
    const left = joinedPhone();
    left.round(LEE, [person('emp-lee', 'Lee', 'Park')]);
    left.g().signOut();
    left.g().disconnectCompany();
    expect(left.g().openOwnAccount()).toEqual({ ok: false, error: 'This phone is not joined to a company.' });
    expect(left.g().session).toBeNull();
  });

  it('a company with the time clock off opens on the checklists', () => {
    const { useStore, g, ctx } = joinedPhone();
    let opened: { keepsTime: boolean; shifts: number } | null = null;
    const stop = useStore.subscribe((now, before) => {
      if (now.session && !before.session) opened = { keepsTime: keepsTime(now.settings.company), shifts: now.shifts.length };
    });
    g().applyStanding(ctx(), LEE);
    // The company added Lee, then turned the time clock off: Lee's row comes first, a page ahead of the settings.
    g().applyReceived(ctx(), [person('emp-lee', 'Lee', 'Park')]);
    expect(keepsTime(g().settings.company)).toBe(true);
    expect(g().session).toBeNull();
    g().applyReceived(ctx(), [settings({ timeClock: false })]);
    g().applyReceived(ctx(), []);
    stop();
    // The app opens on its first tab, which is the Clock only while the company keeps time or the person is on the
    // clock (MainTabs): Lee's account opened once the company's settings were in, so Lee lands on the checklists.
    expect(opened).toEqual({ keepsTime: false, shifts: 0 });
    expect(g().session?.employeeId).toBe('emp-lee');
  });

  it('a restart keeps the person signed in', async () => {
    const { useStore, g, round } = joinedPhone();
    round(LEE, [settings(), person('emp-lee', 'Lee', 'Park')]);
    const signedIn = { session: g().session, connectedCompany: g().connectedCompany, accounts: g().accounts, receiving: g().receiving };
    expect(signedIn.session?.employeeId).toBe('emp-lee');

    // The app is closed, then opened again: a new store, which reads what the last one saved on the device.
    const { storage, name } = useStore.persist.getOptions();
    const saved = await storage!.getItem(name!);
    const again = storeBuild();
    await flush();
    const there = again.persist.getOptions();
    await there.storage!.setItem(there.name!, saved!);
    await again.persist.rehydrate();
    again.getState().ensureSeeded();
    const now = () => again.getState();
    expect(now().hydrated).toBe(true);
    expect({ session: now().session, connectedCompany: now().connectedCompany, accounts: now().accounts, receiving: now().receiving }).toEqual(signedIn);

    // Days later, the next round changes nothing about who is signed in.
    jest.setSystemTime(at(15) + 3 * DAY);
    const ctx = { company: PIT.id, account: LEES_SIGN_IN.id, epoch: now().receiving!.epoch };
    expect(now().applyStanding(ctx, LEE)).toBe(true);
    expect(now().applyReceived(ctx, [])).toBe(true);
    expect(now().session).toEqual(signedIn.session);
    expect(now().accounts).toEqual(signedIn.accounts);
  });
});

describe('forgetting the phone', () => {
  /** Lee's own phone, Lee signed in by the sign-in. */
  function leesPhone() {
    const phone = joinedPhone();
    phone.round(LEE, [settings(), person('emp-lee', 'Lee', 'Park')]);
    expect(phone.g().session?.employeeId).toBe('emp-lee');
    return phone;
  }

  it('forgetting the phone waits until everything has reached the company, then empties it', () => {
    const { useStore, g } = leesPhone();
    expect(g().setMyRate(2650)).toEqual({ ok: true });
    useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });
    // The company turned one down (it was signed on another phone first): it never reaches the company, and does not hold this up.
    const refused = waiting(useStore).find((c) => c.key === 'shift:sh-b')!;
    g().holdRefused([{ key: refused.key, rev: refused.rev, reason: 'signed' }], PIT.id);
    expect(waiting(useStore).map((c) => c.key)).toEqual(['shift:sh-a']);

    const before = kept(useStore);
    expect(g().forgetPhone()).toEqual({ ok: false, error: '1 record has not reached Test Pit A yet, so this phone stays signed in. Try again once it has gone.' });
    expect(kept(useStore)).toEqual(before);

    allSent(useStore);
    expect(g().forgetPhone()).toEqual({ ok: true });
    // Empty, the way the build starts on a new phone: nobody signed in, no account, no records, no rate, no company.
    const fresh = storeBuild();
    fresh.getState().ensureSeeded();
    expect(kept(useStore)).toEqual(kept(fresh));
    expect(g()).toMatchObject({ session: null, accounts: [], shifts: [], payRates: {}, connectedCompany: null, syncedWith: null, synced: {}, receiving: null });
  });

  it('waits only for what a round could still send', () => {
    // A record the server will not take as it is (the round found it stuck) can never reach the company, so it
    // does not hold it up; every other record waiting does.
    const stuck = leesPhone();
    stuck.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });
    expect(stuck.g().forgetPhone({ stuck: 1, trouble: null })).toEqual({
      ok: false,
      error: '1 record has not reached Test Pit A yet, so this phone stays signed in. Try again once it has gone.',
    });
    expect(stuck.g().forgetPhone({ stuck: 2, trouble: null })).toEqual({ ok: true });
    expect(stuck.g().shifts).toEqual([]);

    // Nothing can go once the sign-in is off the company's roster.
    const off = leesPhone();
    off.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10))] });
    off.round(null);
    expect(off.g().forgetPhone({ stuck: 0, trouble: 'not_member' })).toEqual({ ok: true });
    expect(off.g().shifts).toEqual([]);

    // What waits is counted from the phone's own records, never from the round's last count: two made since it.
    const late = leesPhone();
    const lastRound: SyncStatus = { online: true, server: true, waiting: 0, sending: false, lastSentAt: at(14), failed: false, trouble: null, problem: null, stuck: 0, notTaken: 0 };
    late.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });
    expect(late.g().forgetPhone(lastRound)).toEqual({
      ok: false,
      error: '2 records have not reached Test Pit A yet, so this phone stays signed in. Try again once they have gone.',
    });
    expect(late.g().shifts).toHaveLength(2);
  });

  it('is only for the person whose own sign-in the phone has, once it has read the company’s records', () => {
    // Nobody signed in.
    const out = leesPhone();
    out.g().signOut();
    expect(out.g().forgetPhone()).toEqual({ ok: false, error: 'You are signed out.' });

    // Someone else signed in on Lee's phone.
    const sams: Account = { id: 'acct-sam', employeeId: 'emp-sam', email: 'sam@example.test', provider: 'password', createdAt: at(6) };
    const other = joinedPhone();
    other.useStore.setState({ accounts: [sams], session: { accountId: sams.id, employeeId: 'emp-sam' } });
    other.round(LEE, [settings(), person('emp-lee', 'Lee', 'Park'), person('emp-sam', 'Sam', 'Ortiz')]);
    expect(other.g().forgetPhone()).toEqual({ ok: false, error: 'This phone is joined with Lee Park’s company sign-in. Only they can sign this phone out.' });
    expect(other.g().accounts).toEqual([sams]);

    // Before the phone has read the company's records to the end, what it would send is not all counted.
    const lees: Account = { id: 'acct-lee', employeeId: 'emp-lee', email: 'lee@example.test', provider: 'password', createdAt: at(6) };
    const early = joinedPhone();
    early.useStore.setState({ accounts: [lees], session: { accountId: lees.id, employeeId: 'emp-lee' } });
    early.g().applyStanding(early.ctx(), LEE);
    early.g().applyReceived(early.ctx(), [person('emp-lee', 'Lee', 'Park')]);
    expect(early.g().forgetPhone()).toEqual({
      ok: false,
      error: 'This phone has not got the company’s records yet, so it cannot tell that everything on it has reached the company. Try again once it has had signal.',
    });

    // A phone not joined to a company: nothing to sign out of here, and nothing is emptied.
    const left = leesPhone();
    left.g().disconnectCompany();
    expect(left.g().forgetPhone()).toEqual({ ok: false, error: 'This phone is not joined to a company.' });
    expect(left.g().session?.employeeId).toBe('emp-lee');
  });
});
