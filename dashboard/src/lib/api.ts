import type { Change } from '@app/domain/sync';
import type { Role } from '@app/domain/types';

import { billingAnswer, type BillingView } from './billing';
import { authProblem, companyLimitWords, dataProblem, isNotFound, isTooMany, Problem } from './errors';
import type { Deletion, VersionRow } from './history';
import type {
  CompanyChoice,
  CompanyRow,
  JoinRequestRow,
  JoinResult,
  MyJoinRequest,
  NotificationRow,
  RecordRow,
  RosterRow,
} from './server';
import { supabase } from './supabase';

/**
 * Every call the dashboard makes to the server, in one place. Each one either
 * hands back what was asked for or throws a Problem that says what went wrong
 * and what to do.
 */

// ---- Accounts ---------------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw authProblem(error);
}

/** Make an account. With email confirmation on, there is no session yet: the person confirms by email first. */
export async function signUp(email: string, password: string): Promise<{ confirmFirst: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw authProblem(error);
  // Supabase answers a sign-up for an email that already has an account the same way as a new one, so
  // that the answer does not tell anyone which emails have accounts. The page answers both the same way too.
  return { confirmFirst: !data.session };
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
  if (error) throw authProblem(error);
}

/**
 * Sign out of this browser only. The same account may be signed in on a phone,
 * sending its records; signing out here never signs that phone out.
 */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  // The session is gone from this browser whatever the server answered.
  if (error && !/session/i.test(error.message)) console.warn('Sign out:', error.message);
}

// ---- Companies and joining --------------------------------------------------------------------

export async function myCompanies(): Promise<CompanyChoice[]> {
  const { data, error } = await supabase.rpc('my_companies');
  if (error) throw dataProblem(error, 'Finding your companies');
  return (Array.isArray(data) ? data : data ? [data] : []) as CompanyChoice[];
}

export async function companyByCode(code: string): Promise<{ name: string; state: string } | null> {
  const { data, error } = await supabase.rpc('company_by_code', { code });
  if (error) throw dataProblem(error, 'Looking up the code');
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as { name: string; state: string }[];
  return rows[0] ?? null;
}

export interface NewCompany {
  name: string;
  state: string;
  timezone: string;
  firstName: string;
  lastName: string;
  title?: string;
}

export async function createCompany(input: NewCompany): Promise<{ companyId: string; joinCode: string }> {
  const { data, error } = await supabase.rpc('create_company', {
    name: input.name,
    state: input.state,
    timezone: input.timezone,
    first_name: input.firstName,
    last_name: input.lastName,
    title: input.title || null,
  });
  if (error) {
    // One of the limits on how many companies an account starts: the hint says which.
    const { code, hint, message } = error as { code?: string; hint?: unknown; message?: unknown };
    if (isTooMany(code)) throw new Problem(companyLimitWords(hint, message), code);
    throw dataProblem(error, 'Starting the company');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { company_id: string; join_code: string } | undefined;
  if (!row) throw new Problem('The server did not say the company was made. Reload the page to see whether it was.');
  return { companyId: row.company_id, joinCode: row.join_code };
}

export async function joinCompany(code: string, firstName: string, lastName: string): Promise<JoinResult> {
  const { data, error } = await supabase.rpc('join_company', { code, first_name: firstName, last_name: lastName });
  if (error) throw dataProblem(error, 'Joining');
  return data as JoinResult;
}

export async function myJoinRequests(): Promise<MyJoinRequest[]> {
  const { data, error } = await supabase.rpc('my_join_requests');
  if (error) throw dataProblem(error, 'Finding your requests');
  return (data ?? []) as MyJoinRequest[];
}

export async function loadCompany(companyId: string): Promise<CompanyRow | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('id,name,state,timezone,logo_path,pay_period,updated_at')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw dataProblem(error, 'Loading the company');
  return data as CompanyRow | null;
}

// ---- Billing -----------------------------------------------------------------------------------

/** How long the billing check may take before the page lets the supervisor in without it. */
const BILLING_WAIT_MS = 15_000;

/**
 * Where the company's subscription stands. Unlike the other calls this one never
 * throws: what it cannot find out it says so, and the gate lets the supervisor
 * in (`gate` in billing.ts). A server without `company_billing` yet is
 * `missing`, not an error.
 */
export async function companyBilling(companyId: string): Promise<BillingView> {
  const stop = new AbortController();
  const timer = window.setTimeout(() => stop.abort(), BILLING_WAIT_MS);
  try {
    const { data, error, status } = await supabase.rpc('company_billing', { p_company_id: companyId }).abortSignal(stop.signal);
    return billingAnswer({ data, error, status });
  } catch (e) {
    return billingAnswer({ data: null, error: { message: e instanceof Error ? e.message : '' } });
  } finally {
    window.clearTimeout(timer);
  }
}

// ---- The sign-in roster -------------------------------------------------------------------

export async function loadRoster(companyId: string): Promise<RosterRow[]> {
  const { data, error } = await supabase
    .from('roster')
    .select('id,company_id,first_name,last_name,title,role,active,user_id,claimed_at,created_at')
    .eq('company_id', companyId)
    .order('last_name')
    .order('first_name');
  if (error) throw dataProblem(error, 'Loading the roster');
  return (data ?? []) as RosterRow[];
}

export interface NewRosterRow {
  firstName: string;
  lastName: string;
  title?: string;
  role: Role;
}

export async function addToRoster(companyId: string, people: NewRosterRow[]): Promise<RosterRow[]> {
  if (people.length === 0) return [];
  const { data, error } = await supabase
    .from('roster')
    .insert(people.map((p) => ({ company_id: companyId, first_name: p.firstName, last_name: p.lastName, title: p.title || null, role: p.role })))
    .select('id,company_id,first_name,last_name,title,role,active,user_id,claimed_at,created_at');
  if (error) throw dataProblem(error, people.length === 1 ? 'Adding the person' : 'Adding the list');
  return (data ?? []) as RosterRow[];
}

export async function updateRosterRow(id: string, patch: Partial<Pick<RosterRow, 'title' | 'role' | 'active'>>): Promise<void> {
  const { error } = await supabase.from('roster').update(patch).eq('id', id);
  if (error) throw dataProblem(error, 'Changing the roster');
}

export async function deleteRosterRow(id: string): Promise<void> {
  const { error } = await supabase.from('roster').delete().eq('id', id);
  if (error) throw dataProblem(error, 'Removing the person');
}

export async function releaseClaim(rosterId: string): Promise<void> {
  const { error } = await supabase.rpc('release_roster_claim', { roster_id: rosterId });
  if (error) throw dataProblem(error, 'Letting go of the account');
}

export async function rotateJoinCode(companyId: string): Promise<string> {
  const { data, error } = await supabase.rpc('rotate_join_code', { company_id: companyId });
  if (error) throw dataProblem(error, 'Making a new code');
  return data as string;
}

// ---- Join requests ------------------------------------------------------------------------

export async function loadJoinRequests(companyId: string): Promise<JoinRequestRow[]> {
  const { data, error } = await supabase
    .from('join_requests')
    .select('id,company_id,user_id,first_name,last_name,reason,status,roster_id,decided_by,decided_at,created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw dataProblem(error, 'Loading the join requests');
  return (data ?? []) as JoinRequestRow[];
}

export interface Approval {
  /** Put the person on this row. Left out, a new row is made from the name on the request. */
  rosterId?: string;
  role?: Role;
  title?: string;
  /** Take the row from the account that holds it now. */
  replaceClaim?: boolean;
}

export async function approveRequest(requestId: string, how: Approval): Promise<void> {
  const { error } = await supabase.rpc('approve_join_request', {
    request_id: requestId,
    roster_id: how.rosterId ?? null,
    role: how.role ?? 'employee',
    title: how.title || null,
    replace_claim: !!how.replaceClaim,
  });
  if (error) throw dataProblem(error, 'Letting them in');
}

export async function denyRequest(requestId: string, bar: boolean): Promise<void> {
  const { error } = await supabase.rpc('deny_join_request', { request_id: requestId, bar });
  if (error) throw dataProblem(error, 'Turning the request down');
}

export async function liftBar(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('lift_join_bar', { request_id: requestId });
  if (error) throw dataProblem(error, 'Letting them ask again');
}

export async function loadNotifications(companyId: string): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id,company_id,kind,roster_id,request_id,created_at,read_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw dataProblem(error, 'Loading what is new');
  return (data ?? []) as NotificationRow[];
}

export async function markRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
  if (error) throw dataProblem(error, 'Marking them read');
}

// ---- Records --------------------------------------------------------------------------------

/** The rows asked for in one read. The server may hand back fewer: it caps a read at its own max-rows. */
export const RECORD_PAGE = 1000;

const RECORD_COLUMNS = 'kind,id,rev,data,deleted,created_by,updated_by,created_at,updated_at';

/**
 * Every record of the company, a page at a time. A supervisor reads every row;
 * `onPage` is told how many have come so far.
 *
 * The pages are cut on the primary key (kind, then id), which never changes:
 * a record a phone sends again while the pages are being read keeps its place,
 * where in updated_at order it would jump to the end and push the next page's
 * first row back into a page already read. The server never takes a row out
 * (a record taken off a phone only marks it deleted), so a row can only be
 * pushed forward by a new one and read twice; the later read of it is the one
 * kept. Each page starts where the rows read so far end, and the reading stops
 * at the first empty page, so a server that hands back fewer rows than asked for
 * still gives every row.
 *
 * The rows come back oldest change first, as the server used to send them.
 */
export async function loadRecords(companyId: string, onPage?: (sofar: number) => void): Promise<RecordRow[]> {
  const byKey = new Map<string, RecordRow>();
  let read = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('records')
      .select(RECORD_COLUMNS)
      .eq('company_id', companyId)
      .order('kind')
      .order('id')
      .range(read, read + RECORD_PAGE - 1);
    if (error) throw dataProblem(error, 'Loading the records');
    const page = (data ?? []) as RecordRow[];
    if (page.length === 0) break;
    for (const row of page) {
      const key = `${row.kind}:${row.id}`;
      byKey.delete(key);
      byKey.set(key, row);
    }
    read += page.length;
    onPage?.(byKey.size);
  }
  const at = (iso: string) => Date.parse(iso) || 0;
  return [...byKey.values()].sort((a, b) => at(a.updated_at) - at(b.updated_at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/**
 * One record as the server has it now, taken off or not, or null when it shows
 * none to this account: there is none, or the account may not read it (the
 * company's subscription has stopped, or the account is no longer a supervisor).
 */
export async function readRecord(companyId: string, kind: string, id: string): Promise<RecordRow | null> {
  const { data, error } = await supabase
    .from('records')
    .select(RECORD_COLUMNS)
    .eq('company_id', companyId)
    .eq('kind', kind)
    .eq('id', id)
    .maybeSingle();
  if (error) throw dataProblem(error, 'Checking what the server has');
  return (data as RecordRow | null) ?? null;
}

/**
 * The maintenance requests that name a unit, and its equipment checklists that
 * did not pass, as the server has them now: what can be open on the unit. Read
 * again before a unit is taken out of the fleet, as a request or a Bad Order a
 * phone sent after the page loaded is a record of its own, not a change to the
 * unit's.
 */
export async function readOpenOnUnit(companyId: string, unitId: string): Promise<RecordRow[]> {
  const naming = () => supabase.from('records').select(RECORD_COLUMNS).eq('company_id', companyId).eq('data->>equipmentId', unitId);
  const [requests, checklists] = await Promise.all([naming().eq('kind', 'mrf'), naming().eq('kind', 'inspection').neq('data->>result', 'pass')]);
  const error = requests.error ?? checklists.error;
  if (error) throw dataProblem(error, 'Checking what is open on the unit');
  return [...((requests.data ?? []) as unknown as RecordRow[]), ...((checklists.data ?? []) as unknown as RecordRow[])];
}

/** The newest versions of one record the server has taken, each with the version it was made from. */
export async function readVersions(companyId: string, kind: string, id: string, newest = 12): Promise<VersionRow[]> {
  const { data, error } = await supabase
    .from('record_history')
    .select('version,rev,base,data,deleted,by,at')
    .eq('company_id', companyId)
    .eq('kind', kind)
    .eq('id', id)
    .order('version', { ascending: false })
    .limit(newest);
  if (error) throw dataProblem(error, 'Reading the versions');
  return (data ?? []) as VersionRow[];
}

/** Every time a record of a kind was taken off: the unit, and when. The newest 500. */
export async function readDeletions(companyId: string, kind: string): Promise<Deletion[]> {
  const { data, error } = await supabase
    .from('record_history')
    .select('id,at')
    .eq('company_id', companyId)
    .eq('kind', kind)
    .eq('deleted', true)
    .order('at', { ascending: false })
    .limit(500);
  if (error) throw dataProblem(error, 'Reading what was taken off');
  return (data ?? []) as Deletion[];
}

/**
 * Send records the way a supervisor's phone does, with `push_records`, and hand
 * back what the server said about each: taken, set aside (with its reason) or
 * left for later. `readAnswer` in changes.ts puts that into words.
 */
export async function pushRecords(companyId: string, changes: Change[]): Promise<unknown> {
  const { data, error } = await supabase.rpc('push_records', { company_id: companyId, changes });
  if (error) {
    // The server gives a company the account is not in the same answer as one that does not exist.
    const code = (error as { code?: string }).code;
    if (isNotFound(code)) {
      throw new Problem('Nothing was saved: this account is not on the company’s roster any more. Sign out and back in, or ask another supervisor.', code);
    }
    throw dataProblem(error, 'Saving');
  }
  return data;
}

/** The company's own row on the server: its name, state, time zone and pay period, which a supervisor may change. */
export async function updateCompany(companyId: string, patch: Partial<Pick<CompanyRow, 'name' | 'state' | 'timezone' | 'pay_period'>>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const { data, error } = await supabase.from('companies').update(patch).eq('id', companyId).select('id');
  if (error) throw dataProblem(error, 'Changing the company on the server');
  // A change the server's rules do not let through changes no row, and says nothing.
  if (!data || data.length === 0) throw dataProblem({ code: '42501' }, 'Changing the company on the server');
}
