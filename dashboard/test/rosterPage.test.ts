import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Company } from '@app/domain/company';
import type { Employee } from '@app/domain/types';

import type { JoinRequestRow, RecordRow, RosterRow, RosterSignIn } from '../src/lib/server';
import { rosterRow } from './fixtures';

/**
 * The Roster page, drawn once on the server side of React for a made-up
 * company, against a stand-in for the company it opens on; nothing reaches a
 * network. It shows what the page says before anything is pressed: which row
 * is whose, the lists of who is on one roster and not the other, and the
 * fields and questions as a screen reader meets them. Every name here is made up.
 */

const page = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('../src/lib/supabase', () => {
  const answer = (value: unknown) => Object.assign(Promise.resolve(value), { abortSignal: () => Promise.resolve(value) });
  const none: Record<string, unknown> = {};
  for (const step of ['select', 'eq', 'order', 'range', 'gt', 'in']) none[step] = () => none;
  none.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return { supabase: { rpc: () => answer({ data: null, error: null }), from: () => none } };
});

vi.mock('../src/lib/company', async (actual) => ({
  ...(await actual<typeof import('../src/lib/company')>()),
  useCompany: () => page.ctx,
}));

vi.stubGlobal('window', globalThis);

const { shapeRecords } = await import('../src/lib/records');
const { BillingProvider } = await import('../src/lib/billingState');
const { AccountCell, InviteForm, ResetCode, RosterPage, SignInTools, TakenOffAsk } = await import('../src/screens/RosterPage');

const NOW = Date.UTC(2026, 10, 20, 18);
const PIT: Company = { name: 'Test Pit A', state: 'NV', pay: null };

const person = (id: string, firstName: string, lastName: string, over: Partial<Employee> = {}): Employee => ({ id, firstName, lastName, role: 'employee', active: true, ...over });

function record(kind: string, id: string, data: unknown): RecordRow {
  const at = new Date(NOW - 3_600_000).toISOString();
  return { kind, id, rev: `r-${id}`, data, deleted: false, created_by: 'user-office', updated_by: 'user-office', created_at: at, updated_at: at };
}

/** The page as it opens on these rosters: the markup, with its tags taken out for reading. */
function draw(people: Employee[], roster: RosterRow[], company: Company = PIT, requests: JoinRequestRow[] = []) {
  const records = [record('settings', 'company', { company, site: null, workweekStartsOn: 0, allowSectionAllOk: true }), ...people.map((e) => record('employee', e.id, e))];
  page.ctx = {
    choice: { id: 'company-a', name: 'Test Pit A', role: 'supervisor', join_code: 'ABCD2345' },
    me: 'user-office',
    roster,
    requests,
    notifications: [],
    company: null,
    records,
    recordsError: null,
    recordsHeld: false,
    loadedAt: NOW,
    now: NOW,
    shaped: shapeRecords(records, { roster }),
    reload: async () => {},
    reloadRoster: async () => {},
    recheckRole: async () => {},
    applyRecords: () => {},
    setJoinCode: () => {},
  };
  const html = renderToStaticMarkup(createElement(BillingProvider, { companyId: 'company-a', recheckRole: async () => {}, children: createElement(RosterPage) }));
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

/** The part of the page under a heading, up to the next one. */
const under = (text: string, heading: string) => {
  const at = text.indexOf(heading);
  if (at < 0) return null;
  const rest = text.slice(at + heading.length);
  const next = rest.search(/ (On the sign-in roster|On the phones, not on the sign-in roster|Off the sign-in roster, still in the app|Payroll IDs|Decided requests) /);
  return next < 0 ? rest : rest.slice(0, next);
};

describe('the Roster page', () => {
  it('gives a row only the person who is theirs: the father’s row is not the son’s', () => {
    const son = person('emp_son', 'Sam', 'Ortiz Jr');
    const { text } = draw([son], [rosterRow({ first_name: 'Sam', last_name: 'Ortiz Jr' }), rosterRow({ first_name: 'Sam', last_name: 'Ortiz' })]);
    expect(under(text, 'On the sign-in roster, not in the app')).toContain('Ortiz, Sam Crew Add to the app’s roster');
    expect(under(text, 'On the sign-in roster, not in the app')).not.toContain('Ortiz Jr');
  });

  it('lists nobody as on the phones and not on the sign-in roster whom a row in the table is for', () => {
    const { text } = draw([person('emp_quinn', 'Riley J', 'Quinn')], [rosterRow({ first_name: 'Riley', last_name: 'Quinn' })]);
    expect(text).not.toContain('Not in the app');
    expect(under(text, 'On the phones, not on the sign-in roster')).toBeNull();
  });

  it('marks a row two people in the app are called by, and offers no Make both for it', () => {
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park', role: 'supervisor' });
    const { text } = draw([person('emp_a', 'Lee', 'Park'), person('emp_b', 'Lee', 'Park')], [row]);
    expect(text).toContain('Two in the app');
    expect(text).not.toContain('Make both');
    // Both are listed with a way to take the one who should not be there off the app's roster.
    const shown = under(text, 'On the sign-in roster') ?? '';
    expect(shown.match(/Take off the app’s roster/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('lists the people taken off the sign-in roster who are still on every phone, to take them off the app’s roster too', () => {
    const { text } = draw([person('emp_ortiz', 'Sam', 'Ortiz')], [rosterRow({ first_name: 'Sam', last_name: 'Ortiz', active: false, user_id: 'user-ortiz' })]);
    expect(under(text, 'Off the sign-in roster, still in the app')).toContain('Ortiz, Sam');
    expect(under(text, 'Off the sign-in roster, still in the app')).toContain('Take off the app’s roster');
  });

  it('names each payroll ID field as one, and lets the Payroll page’s link land on the section', () => {
    const { html } = draw([person('emp_ortiz', 'Sam', 'Ortiz', { title: 'Crusher' })], [rosterRow({ first_name: 'Sam', last_name: 'Ortiz' })]);
    expect(html).toMatch(/<label[^>]*>Payroll ID for Ortiz, Sam<\/label>/);
    expect(html).toMatch(/<section[^>]*id="payroll-ids"[^>]*tabindex="-1"|<section[^>]*tabindex="-1"[^>]*id="payroll-ids"/);
  });
});

describe('the question about someone taken off the roster', () => {
  it('is the name of its group, and gives neither answer the focus: both write', () => {
    const html = renderToStaticMarkup(createElement(TakenOffAsk, { person: person('emp_old', 'Sam', 'Ortiz', { active: false }), onAnswer: () => {} }));
    const [, labelledBy] = html.match(/role="group"[^>]*aria-labelledby="([^"]+)"/) ?? [];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}">Sam Ortiz, who was taken off the roster, has this name. Bring them back, or add a new person?</span>`);
    expect(html).toMatch(/tabindex="-1"[^>]*role="group"|role="group"[^>]*tabindex="-1"/);
    expect(html).not.toMatch(/autofocus/i);
  });
});

describe('the company code', () => {
  it('is called the company code on the page, as the app calls it, and never the join code', () => {
    const { html, text } = draw([], []);
    expect(text).toContain('Company code');
    expect(html).toContain('aria-label="Company code A B C D 2 3 4 5"');
    expect(text).not.toMatch(/join code/i);
  });
});

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

/** The sign-in tools of one row, as they open under it. */
function tools(row: Pick<RosterRow, 'first_name' | 'last_name' | 'role'>, how: Partial<RosterSignIn>, inviting = false) {
  draw([], []);
  const full = rosterRow({ ...row, id: 'row-sam-ortiz' });
  const html = renderToStaticMarkup(createElement(SignInTools, { row: full, signIn: signIn(how), inviting, setInviting: () => {}, onChanged: async () => {} }));
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

describe('the Roster page’s sign-in tools', () => {
  const crew = { first_name: 'Sam', last_name: 'Ortiz', role: 'employee' as const };
  const boss = { first_name: 'Lee', last_name: 'Park', role: 'supervisor' as const };

  it('shows Reset passcode and Delete sign-in on a row held by a passcode account, and nothing about an invitation', () => {
    const { text } = tools(crew, { sign_in: 'passcode' });
    expect(text).toContain('Reset passcode');
    expect(text).toContain('Delete sign-in');
    expect(text).not.toMatch(/Invite|Send again|Cancel invitation/);
  });

  it('shows neither on a row nobody holds, or one an email account holds', () => {
    // Where something is shown, neither is among it: the invite form open on a row nobody holds.
    const form = tools(crew, { sign_in: 'none' }, true).text;
    expect(form).toContain('Send invitation');
    expect(form).not.toMatch(/Reset passcode|Delete sign-in/);
    // And where a passcode account holds the row they are shown, so the empty render below is a real absence.
    expect(tools(crew, { sign_in: 'passcode' }).text).toMatch(/Reset passcode.*Delete sign-in/);
    for (const sign_in of ['none', 'email'] as const) expect(tools(crew, { sign_in }).html).toBe('');
  });

  it('shows Invite only on a supervisor’s row with no email account and no open invitation', () => {
    expect(tools(boss, { sign_in: 'none' }).text).toContain('Invite by email');
    // An email account holds the row, a crew row is not a supervisor's: nothing is shown at all, where the row above shows Invite.
    expect(tools(boss, { sign_in: 'email' }).html).toBe('');
    expect(tools(crew, { sign_in: 'none' }).html).toBe('');
    // An open invitation takes Invite's place with Send again and Cancel.
    const open = tools(boss, { sign_in: 'none', invitation_id: 'inv-1' }).text;
    expect(open).toContain('Send again');
    expect(open).not.toContain('Invite by email');
  });

  it('shows Send again and Cancel invitation on a row with an open invitation, with the reset and delete only for a passcode account', () => {
    const open = tools(boss, { invitation_id: 'inv-1', invited_email: 'lee.park@example.org' });
    expect(open.text).toContain('Send again');
    expect(open.text).toContain('Cancel invitation');
    expect(open.text).not.toMatch(/Reset passcode|Delete sign-in/);
    const both = tools(crew, { sign_in: 'passcode', invitation_id: 'inv-1' });
    expect(both.text).toMatch(/Reset passcode.*Delete sign-in.*Send again.*Cancel invitation/);
  });

  it('puts no question until Delete sign-in is pressed', () => {
    expect(tools(crew, { sign_in: 'passcode' }).text).not.toContain('stay with the company');
  });

  it('explains, when the invite is opened on a passcode row, that supervisors sign in with email', () => {
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', id: 'row-sam-ortiz' });
    draw([], []);
    const html = renderToStaticMarkup(createElement(InviteForm, { row, signIn: signIn({ sign_in: 'passcode' }), onClose: () => {}, onChanged: async () => {} }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Supervisors sign in with email, not a passcode.');
    expect(text).toContain('Nothing changes until they accept');
    // The person signs in already, with a passcode: what decides the email is their address.
    expect(text).toContain('An address that already signs in to MineMuster gets no email');
    expect(text).not.toContain('Someone who already signs in to MineMuster');
    expect(html).toMatch(/<label[^>]*>Email address for Ortiz, Sam<\/label>/);
    expect(text).toContain('Send invitation');
  });

  it('explains, when the invite is opened on a row nobody holds, who gets an email and who does not, the same for every address', () => {
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park', role: 'supervisor', id: 'row-lee-park' });
    draw([], []);
    const html = renderToStaticMarkup(createElement(InviteForm, { row, signIn: signIn({ sign_in: 'none' }), onClose: () => {}, onChanged: async () => {} }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain(
      'Type Lee Park’s email address. An address new to MineMuster gets an email with a link to the dashboard. An address that already signs in to MineMuster gets no email: the invitation waits for them when they sign in with it at app.minemuster.com, so tell them to look. They take this row when they accept. Nothing changes until they do.',
    );
    expect(text).not.toContain('They get an email with a link');
  });

  it('tells the inviter of a crew member with a passcode to have everything sent from the phone first', () => {
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', id: 'row-sam-ortiz' });
    draw([], []);
    const html = renderToStaticMarkup(createElement(InviteForm, { row, signIn: signIn({ sign_in: 'passcode' }), onClose: () => {}, onChanged: async () => {} }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Before they accept, have them send everything on their phone with Send and receive now');
    expect(text).toContain('Once they accept, they sign out of their phone and sign in again with Supervisor? Sign in with email, best when they are not on the clock.');
  });

  it('opens the invite for a passcode row where it would make a supervisor, with the form open', () => {
    draw([], []);
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', id: 'row-sam-ortiz' });
    const html = renderToStaticMarkup(createElement(SignInTools, { row, signIn: signIn({ sign_in: 'passcode' }), inviting: true, setInviting: () => {}, onChanged: async () => {} }));
    expect(html.replace(/<[^>]+>/g, ' ')).toContain('Supervisors sign in with email, not a passcode.');
  });

  it('shows a reset code once, large, in groups of three, with what to tell the person', () => {
    draw([], []);
    const html = renderToStaticMarkup(createElement(ResetCode, { name: 'Sam Ortiz', code: '004217', onClose: () => {} }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('004 217');
    expect(html).toContain('aria-label="Reset code for Sam Ortiz: 0 0 4 2 1 7"');
    expect(text).toContain('In the app, tap Forgot your passcode? and type this code with a new passcode.');
    expect(text).toContain('only time the code is shown');
  });

  it('words the Account column from the row’s sign-in, and shows where an invitation went', () => {
    draw([], []);
    const cell = (how: RosterSignIn | undefined, claimed: string | null = null) =>
      renderToStaticMarkup(createElement(AccountCell, { signIn: how, claimedAt: claimed, now: NOW })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(cell(signIn())).toContain('Not joined yet');
    expect(cell(signIn({ invitation_id: 'inv-1', invited_email: 'lee.park@example.org' }))).toContain('Invited, waiting to accept');
    expect(cell(signIn({ invitation_id: 'inv-1', invited_email: 'lee.park@example.org' }))).toContain('lee.park@example.org');
    expect(cell(signIn({ sign_in: 'passcode', needs_reset: true }), '2026-11-03T15:00:00.000Z')).toContain('Locked, needs a reset');
  });
});

describe('requests turned down and kept out', () => {
  it('says under Decided requests that keeping someone out keeps out only that sign-in, and points to Make a new code', () => {
    const denied: JoinRequestRow = {
      id: 'req-1', company_id: 'company-a', user_id: 'user-kept-out', first_name: 'Lee', last_name: 'Park', reason: 'not_on_roster',
      status: 'denied', decided_at: '2026-11-19T15:00:00.000Z', created_at: '2026-11-19T14:00:00.000Z',
    };
    const { text } = draw([], [], PIT, [denied]);
    expect(text).toContain('Decided requests');
    expect(text).toContain(
      'One turned down with “keep them out” cannot be made again from that sign-in until a supervisor lets it, but anyone with the company code can make a new sign-in and ask again: Make a new code stops that.',
    );
  });
});
