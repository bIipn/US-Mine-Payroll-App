import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two places the dashboard asks again whether the account is still a supervisor of the company: a
 * billing check that is turned down, and a save that is. A supervisor can be made crew, or taken off the
 * roster, while the page is open, and a supervisor function then answers "No such company.": PT404
 * (HTTP 404) from migration 20261117000600 on, P0002 (HTTP 500) on a server before it. Each place is
 * the real component, drawn once on the server side of React, against a stand-in for PostgREST's
 * answers; nothing reaches a network.
 */

const server = vi.hoisted(() => ({
  billing: { data: null, error: null, status: 200 } as { data: unknown; error: unknown; status: number },
  push: { data: null, error: null } as { data: unknown; error: unknown },
  rechecks: 0,
}));

vi.mock('../src/lib/supabase', () => {
  const answer = (value: unknown) => Object.assign(Promise.resolve(value), { abortSignal: () => Promise.resolve(value) });
  const none: Record<string, unknown> = {};
  for (const step of ['select', 'eq', 'order', 'range', 'gt', 'in']) none[step] = () => none;
  none.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return { supabase: { rpc: (name: string) => answer(name === 'company_billing' ? server.billing : server.push), from: () => none } };
});

const recheckRole = () => {
  server.rechecks += 1;
  return Promise.resolve();
};

vi.mock('../src/lib/company', async (actual) => ({
  ...(await actual<typeof import('../src/lib/company')>()),
  useCompany: () => ({ choice: { id: 'company-a', name: 'Test Pit A', role: 'supervisor' }, me: 'account-a', records: [], recheckRole, applyRecords: () => {} }),
}));

// The billing check gives up after a while with window.setTimeout.
vi.stubGlobal('window', globalThis);

const { BillingProvider, useBilling } = await import('../src/lib/billingState');
const { useSaver } = await import('../src/lib/save');

const ACTIVE = { data: { access: 'active', status: 'active', current_period_end: '2027-01-01T17:00:00Z' }, error: null, status: 200 };
const refusal = (code: string, status: number) => ({ data: null, error: { code, message: code === '22023' ? 'Changes are sent as a list.' : 'No such company.', details: null, hint: null }, status });

/** The billing check and the saver as the page has them, from one drawing of the real components. */
function draw() {
  const got: { check?: ReturnType<typeof useBilling>['check']; save?: ReturnType<typeof useSaver> } = {};
  function Page() {
    got.check = useBilling().check;
    got.save = useSaver();
    return null;
  }
  renderToString(createElement(BillingProvider, { companyId: 'company-a', recheckRole }, createElement(Page)));
  return got as Required<typeof got>;
}

const UNIT = { kind: 'equipment', id: 'eq-1', record: { id: 'eq-1', unit: 'L-22', category: 'loader' }, what: 'unit L-22' } as const;

beforeEach(() => {
  server.billing = ACTIVE;
  server.push = { data: { accepted: [], ignored: [] }, error: null };
  server.rechecks = 0;
});

describe('asking again whether the account is still a supervisor', () => {
  it('happens when the billing check is told "No such company.", as the server says it now (PT404) and before (P0002)', async () => {
    for (const [code, status] of [['PT404', 404], ['P0002', 500], ['42501', 403]] as const) {
      server.rechecks = 0;
      server.billing = refusal(code, status);
      const answer = await draw().check();
      expect(answer).toMatchObject({ kind: 'failed', code });
      expect(server.rechecks, code).toBe(1);
    }
  });

  it('does not happen when the billing check fails for another reason', async () => {
    for (const [code, status] of [['PT409', 409], ['55000', 500], ['22023', 400]] as const) {
      server.billing = refusal(code, status);
      await draw().check();
    }
    expect(server.rechecks).toBe(0);
  });

  it('happens when a save is told "No such company.", as the server says it now (PT404) and before (P0002)', async () => {
    for (const [code, status] of [['PT404', 404], ['P0002', 500], ['42501', 403]] as const) {
      server.rechecks = 0;
      server.push = refusal(code, status);
      const result = await draw().save({ ...UNIT });
      expect(result.ok).toBe(false);
      expect(server.rechecks, code).toBe(1);
    }
  });

  it('does not happen when a save is turned down for what is in it', async () => {
    server.push = refusal('22023', 400);
    const result = await draw().save({ ...UNIT });
    expect(result).toMatchObject({ ok: false, words: 'Something typed is not allowed: Changes are sent as a list.' });
    expect(server.rechecks).toBe(0);
  });
});
