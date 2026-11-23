import type { Role } from '@app/domain/types';

/**
 * What the server hands back, as supabase/README.md and the records design
 * describe it. Times are ISO strings, the way PostgREST sends a timestamptz.
 */

export interface CompanyChoice {
  id: string;
  name: string;
  state: string;
  role: Role;
  /** Only a supervisor is given the code. */
  join_code?: string | null;
}

export interface CompanyRow {
  id: string;
  name: string;
  state: string;
  timezone: string;
  logo_path: string | null;
  pay_period: unknown;
  join_code?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RosterRow {
  id: string;
  company_id: string;
  first_name: string;
  last_name: string;
  title: string | null;
  role: Role;
  active: boolean;
  user_id: string | null;
  claimed_at: string | null;
  created_at: string;
}

/** How a roster row is held, as `roster_sign_ins` says it. */
export type SignInKind = 'none' | 'passcode' | 'email';

/**
 * One roster row's sign-in, as `roster_sign_ins(company)` gives it to a supervisor: how the row is held, the
 * lock on a passcode account, and the row's open invitation. A row taken off the roster has one too.
 */
export interface RosterSignIn {
  roster_id: string;
  sign_in: SignInKind;
  /** While 5 wrong tries in a row keep the account locked: when the lock ends. */
  locked_until: string | null;
  /** 10 wrong tries in a row: only a reset code opens the account. */
  needs_reset: boolean;
  invitation_id: string | null;
  invited_email: string | null;
  invited_at: string | null;
  /** The supervisor who sent the open invitation is no longer one, so it cannot be accepted until it is sent again. */
  invitation_lapsed: boolean;
}

export type JoinReason = 'not_on_roster' | 'already_claimed' | 'supervisor_row' | 'removed' | 'released' | 'ambiguous';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';

export interface JoinRequestRow {
  id: string;
  company_id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  reason: JoinReason;
  status: RequestStatus;
  roster_id?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  created_at: string;
}

/** A person's own request, as `my_join_requests()` gives it: without who decided it or the row. */
export interface MyJoinRequest {
  id: string;
  company_id: string;
  first_name: string;
  last_name: string;
  reason: JoinReason;
  status: RequestStatus;
  created_at: string;
  decided_at?: string | null;
  company_name?: string | null;
}

export interface NotificationRow {
  id: string;
  company_id: string;
  kind: 'joined' | 'join_request';
  roster_id: string | null;
  request_id: string | null;
  created_at: string;
  read_at: string | null;
}

export type JoinStatus = 'no_company' | 'already_member' | 'denied' | 'joined' | 'ambiguous' | 'pending';

export interface JoinResult {
  status: JoinStatus;
  role?: Role;
  reason?: JoinReason;
  company_name?: string;
  company_id?: string;
}

/** The kinds of record the phones send, in the order they send them. */
export const RECORD_KINDS = [
  'settings', 'employee', 'equipment', 'areaSheet', 'shift', 'denied', 'leave', 'inspection', 'opLog', 'exam', 'mrf',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** One row of `records`: the latest version of a record a company's phones have sent. */
export interface RecordRow {
  kind: string;
  id: string;
  rev: string;
  data: unknown;
  deleted: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
