import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Company } from '@app/domain/company';
import type { Employee } from '@app/domain/types';

import type { RecordRow, RosterRow } from '../src/lib/server';
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
const { RosterPage, TakenOffAsk } = await import('../src/screens/RosterPage');

const NOW = Date.UTC(2026, 10, 20, 18);
const PIT: Company = { name: 'Test Pit A', state: 'NV', pay: null };

const person = (id: string, firstName: string, lastName: string, over: Partial<Employee> = {}): Employee => ({ id, firstName, lastName, role: 'employee', active: true, ...over });

function record(kind: string, id: string, data: unknown): RecordRow {
  const at = new Date(NOW - 3_600_000).toISOString();
  return { kind, id, rev: `r-${id}`, data, deleted: false, created_by: 'user-office', updated_by: 'user-office', created_at: at, updated_at: at };
}

/** The page as it opens on these rosters: the markup, with its tags taken out for reading. */
function draw(people: Employee[], roster: RosterRow[], company: Company = PIT) {
  const records = [record('settings', 'company', { company, site: null, workweekStartsOn: 0, allowSectionAllOk: true }), ...people.map((e) => record('employee', e.id, e))];
  page.ctx = {
    choice: { id: 'company-a', name: 'Test Pit A', role: 'supervisor', join_code: 'ABCD2345' },
    me: 'user-office',
    roster,
    requests: [],
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
    const shown = under(text, 'On the sign-in roster');
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
