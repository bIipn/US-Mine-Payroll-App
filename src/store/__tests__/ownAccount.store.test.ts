// One person per phone, in a build that connects. Once a phone joined to its company has read the
// company's settings and roster to the end, it opens the account of the person its company sign-in is
// for, by itself and with no password, and nobody else's. The person whose own sign-in it is empties the
// phone by signing out of it, once nothing on it would be lost. Preview builds keep their local accounts
// as they are (store.test.ts). A made-up company and made-up people.
import { keepsTime } from '../../domain/company';
import { changesToSend, revOf, type ReceivedRow, type Standing, type SyncStatus } from '../../domain/sync';
import { startedLunch } from '../../domain/time';
import type { Account, OperatingLog, Shift } from '../../domain/types';
import { fmtTime } from '../../util/format';
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
/** A record the company deleted. */
function removed(kind: ReceivedRow['kind'], id: string): ReceivedRow {
  seq += 1;
  return { kind, id, rev: 'deleted', seq, deleted: true, data: {} };
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
  /** What forgetPhone refuses with: the first thing that holds signing out up, and what to do (signOutBlockers). */
  const refused = (title: string, body: string) => ({ ok: false, error: `${title}. ${body}` });
  const NOT_SENT = (n: number) =>
    refused(`${n === 1 ? '1 record has' : `${n} records have`} not reached Test Pit A yet`, 'They are sent before this phone is signed out, so the company has them.');

  it('forgetting the phone waits until everything has reached the company, then empties it', () => {
    const { useStore, g } = leesPhone();
    expect(g().setMyRate(2650)).toEqual({ ok: true });
    useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });

    const before = kept(useStore);
    expect(g().forgetPhone()).toEqual(NOT_SENT(2));
    expect(kept(useStore)).toEqual(before);

    allSent(useStore);
    expect(g().forgetPhone()).toEqual({ ok: true });
    // Empty, the way the build starts on a new phone: nobody signed in, no account, no records, no rate, no company.
    const fresh = storeBuild();
    fresh.getState().ensureSeeded();
    expect(kept(useStore)).toEqual(kept(fresh));
    expect(g()).toMatchObject({ session: null, accounts: [], shifts: [], payRates: {}, connectedCompany: null, syncedWith: null, synced: {}, receiving: null });
  });

  it('waits for what the company turned down, and for what can never reach it from a sign-in off its roster', () => {
    // Turned down (it was signed on another phone first): it never reaches the company, so signing out waits.
    const held = leesPhone();
    held.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10))] });
    const change = waiting(held.useStore)[0];
    held.g().holdRefused([{ key: change.key, rev: change.rev, reason: 'signed' }], PIT.id);
    expect(waiting(held.useStore)).toEqual([]);
    expect(held.g().forgetPhone()).toEqual(refused('Test Pit A turned down 1 record', 'Signing out would take it off this phone. A supervisor can look at it with you.'));
    expect(held.g().shifts).toHaveLength(1);

    // What the server will not take as it is, as the round found it (stuck).
    const stuck = leesPhone();
    stuck.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });
    expect(stuck.g().forgetPhone({ online: true, stuck: 1, trouble: null })).toEqual(NOT_SENT(1));
    expect(stuck.g().forgetPhone({ online: true, stuck: 2, trouble: null })).toEqual(
      refused('Test Pit A turned down 2 records', 'Signing out would take them off this phone. A supervisor can look at them with you.'),
    );
    expect(stuck.g().shifts).toHaveLength(2);

    // The company took the sign-in off its roster: the round says so, and so does the sign-in's own row.
    const off = leesPhone();
    off.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10))] });
    off.round(null);
    const offRoster = refused(
      'This phone’s company sign-in is off Test Pit A’s roster',
      '1 record on this phone cannot reach the company now, and signing out would lose it. Delete your account instead: it stays on this phone.',
    );
    expect(off.g().forgetPhone({ online: true, stuck: 0, trouble: 'not_member' })).toEqual(offRoster);
    expect(off.g().forgetPhone()).toEqual(offRoster);
    expect(off.g().shifts).toHaveLength(1);

    // What waits is counted from the phone's own records, never from the round's last count: two made since it.
    const late = leesPhone();
    const lastRound: SyncStatus = { online: true, server: true, waiting: 0, sending: false, lastSentAt: at(14), failed: false, trouble: null, problem: null, stuck: 0, notTaken: 0 };
    late.useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10)), shiftOf('sh-b', at(11), at(14))] });
    expect(late.g().forgetPhone(lastRound)).toEqual(NOT_SENT(2));
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

    // Lee signed in, with someone else's account on the phone from before: signing out would take it too.
    const shared = leesPhone();
    shared.useStore.setState({ accounts: [...shared.g().accounts, sams] });
    expect(shared.g().forgetPhone()).toEqual(
      refused('Someone else has an account on this phone', 'Signing out empties the phone, and their account would go with it. A supervisor clears the phone once they are done with it.'),
    );
    expect(shared.g().accounts).toContainEqual(sams);

    // Before the phone has read the company's records to the end, what it would send is not all counted.
    const lees: Account = { id: 'acct-lee', employeeId: 'emp-lee', email: 'lee@example.test', provider: 'password', createdAt: at(6) };
    const early = joinedPhone();
    early.useStore.setState({ accounts: [lees], session: { accountId: lees.id, employeeId: 'emp-lee' } });
    early.g().applyStanding(early.ctx(), LEE);
    early.g().applyReceived(early.ctx(), [person('emp-lee', 'Lee', 'Park')]);
    expect(early.g().forgetPhone()).toEqual(
      refused('This phone has not read Test Pit A’s records yet', 'Until it has, it cannot tell that everything on it has reached the company. Try again once it has had signal.'),
    );

    // A phone not joined to a company: nothing to sign out of here, and nothing is emptied.
    const left = leesPhone();
    left.g().disconnectCompany();
    expect(left.g().forgetPhone()).toEqual({ ok: false, error: 'This phone is not joined to a company.' });
    expect(left.g().session?.employeeId).toBe('emp-lee');
  });

  it('is one person’s: on a phone joined with Sam Ortiz’s sign-in, Sam Ortiz Jr neither makes an account nor signs it out', () => {
    const sams = joinedPhone({ id: 'u-sam', email: 'sam@example.test' });
    const jrSignsUp = () => sams.g().signUp({ firstName: 'Sam', lastName: 'Ortiz Jr', email: 'samjr@example.test', password: 'haulroad88' });
    // During the first read only Sam Ortiz Jr's row has come: no account is made on that looser fit.
    sams.g().applyStanding(sams.ctx(), { role: 'employee', name: { firstName: 'Sam', lastName: 'Ortiz' } });
    sams.g().applyReceived(sams.ctx(), [settings(), person('emp-sam-jr', 'Sam', 'Ortiz Jr')]);
    expect(jrSignsUp()).toEqual({ ok: false, error: 'This phone has not heard from the company yet. Try again once it has had signal.' });
    expect(sams.g().session).toBeNull();
    // The read goes on to its end, with Sam Ortiz's row: the phone opens Sam's own account, never the looser fit's.
    sams.g().applyReceived(sams.ctx(), [person('emp-sam', 'Sam', 'Ortiz')]);
    sams.g().applyReceived(sams.ctx(), []);
    expect(sams.g().session?.employeeId).toBe('emp-sam');
    sams.g().signOut();
    expect(jrSignsUp()).toEqual({
      ok: false,
      error: 'This phone is joined with Sam Ortiz’s company sign-in, so the account made here is theirs. Make yours on your own phone.',
    });
    // Signed in with an account made here before, Sam Ortiz Jr does not sign the phone out either.
    const jrs: Account = { id: 'acct-sam-jr', employeeId: 'emp-sam-jr', email: 'samjr@example.test', provider: 'password', createdAt: at(6) };
    sams.useStore.setState({ accounts: [...sams.g().accounts, jrs], session: { accountId: jrs.id, employeeId: 'emp-sam-jr' } });
    expect(sams.g().forgetPhone()).toEqual({ ok: false, error: 'This phone is joined with Sam Ortiz’s company sign-in. Only they can sign this phone out.' });
    expect(sams.g().accounts).toContainEqual(jrs);
  });

  it('asks for the company sign-in again first when it is signed out, so what waits can reach the company', () => {
    const { useStore, g } = leesPhone();
    useStore.setState({ shifts: [shiftOf('sh-a', at(6), at(10))] });
    expect(g().forgetPhone({ online: true, stuck: 0, trouble: 'signed_out' })).toEqual(
      refused('Your company sign-in is signed out on this phone', 'Sign in to it on Company account first to send the record waiting here, then sign out.'),
    );
    expect(g().shifts).toHaveLength(1);
  });

  // Phones do not receive time records: a shift or a use left open here would stay open on the company's
  // server, with nothing in the app to close it.
  describe('waits until the shift and any unit are closed', () => {
    const T99 = { id: 'eq-t99', unit: 'T-99', category: 'haul_truck', make: 'Made-up', model: 'HX 40', status: 'ready', meter: 100, meterUnit: 'hrs' };
    /** Lee's shift today from 1 PM: open, unless it has a clock-out. */
    const leesShift = (more: Partial<Shift> = {}): Shift => ({ id: 'sh-today', employeeId: 'emp-lee', clockIn: { at: at(13) }, lunches: [], breaks: [], ...more });
    /** Lee's use of T-99 from 1 PM: still checked out, unless it has an end. */
    const leesUse = (more: Partial<OperatingLog> = {}): OperatingLog => ({
      id: 'op-today',
      equipmentId: T99.id,
      employeeId: 'emp-lee',
      inspectionId: 'insp-today',
      startAt: at(13),
      startMeter: 100,
      ...more,
    });
    /** Lee's own phone with these records, every one of them already with the company: nothing waits. */
    function phoneWith(records: { shifts?: Shift[]; opLogs?: OperatingLog[] }, company = { timeClock: true }) {
      const phone = joinedPhone();
      phone.round(LEE, [settings(company), person('emp-lee', 'Lee', 'Park'), row('equipment', T99.id, T99)]);
      phone.useStore.setState(records);
      allSent(phone.useStore);
      expect(waiting(phone.useStore)).toEqual([]);
      return phone;
    }

    it('is refused while the person is on the clock', () => {
      const { g } = phoneWith({ shifts: [leesShift()] });
      expect(g().forgetPhone()).toEqual(refused('Clock out first', 'You are on the clock. Clock out, then sign out.'));
      expect(g().session?.employeeId).toBe('emp-lee');
      expect(g().shifts).toHaveLength(1);
      // The office turned the time clock off meanwhile: someone on the clock keeps the Clock to clock out on.
      const clockOff = phoneWith({ shifts: [leesShift()] }, { timeClock: false });
      expect(keepsTime(clockOff.g().settings.company)).toBe(false);
      expect(clockOff.g().forgetPhone()).toEqual(refused('Clock out first', 'You are on the clock. Clock out, then sign out.'));
    });

    it('is refused while the person is at lunch', () => {
      const { g } = phoneWith({ shifts: [leesShift({ lunches: [startedLunch({ at: at(14, 45) })] })] });
      expect(g().forgetPhone()).toEqual(refused('Clock out first', `You are at lunch until ${fmtTime(at(15, 15))}. Clock out after that, then sign out.`));
      expect(g().shifts).toHaveLength(1);
    });

    it('is refused while the person has a unit checked out', () => {
      const { g, round } = phoneWith({ opLogs: [leesUse()] });
      const words = refused('End use first', 'You still have T-99 checked out. End use on the Checklists screen, then sign out.');
      expect(g().forgetPhone()).toEqual(words);
      // The company takes T-99 out of the fleet meanwhile: the phone keeps it until its use is ended, and still waits.
      round(LEE, [removed('equipment', T99.id)]);
      expect(g().equipment).toEqual([]);
      expect(g().forgetPhone()).toEqual(words);
      expect(g().opLogs).toHaveLength(1);
    });

    it('is allowed once they have clocked out, with nothing checked out and nothing waiting', () => {
      const { g } = phoneWith({
        shifts: [leesShift({ clockOut: { at: at(14, 30) } })],
        opLogs: [leesUse({ endAt: at(14, 20), endMeter: 104, parkedSafely: true })],
      });
      expect(g().forgetPhone()).toEqual({ ok: true });
      expect(g()).toMatchObject({ session: null, accounts: [], shifts: [], opLogs: [], connectedCompany: null });
      // An old shift never clocked out no longer holds it up: only a supervisor can set its end now (a warning).
      const old = phoneWith({ shifts: [leesShift({ clockIn: { at: at(15) - 20 * 3_600_000 } })] });
      expect(old.g().forgetPhone()).toEqual({ ok: true });
    });
  });
});
