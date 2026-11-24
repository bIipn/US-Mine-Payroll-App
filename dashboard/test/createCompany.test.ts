import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createCompany against a stand-in for PostgREST's answer to `create_company`. One account starts at
 * most 3 companies in any 24 hours and 20 in all (migration 20261117000800); past either the server
 * answers PT429 (HTTP 429), with a hint that says which.
 */
const answer = vi.hoisted(() => ({ value: { data: null as unknown, error: null as unknown } }));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: () => Promise.resolve(answer.value) } }));

const { createCompany } = await import('../src/lib/api');
const { Problem } = await import('../src/lib/errors');

const NEW = { name: 'Test Pit A', state: 'CA', timezone: 'America/Los_Angeles', firstName: 'Sam', lastName: 'Ortiz' };

async function refusal(error: unknown) {
  answer.value = { data: null, error };
  try {
    await createCompany(NEW);
  } catch (e) {
    return e as InstanceType<typeof Problem>;
  }
  throw new Error('createCompany did not refuse');
}

beforeEach(() => {
  answer.value = { data: null, error: null };
});

describe('starting a company', () => {
  it('says so when the account has started 3 in the last 24 hours, and to try again in a day', async () => {
    const e = await refusal({ code: 'PT429', message: 'This account has started 3 companies in the last 24 hours. Try again in a day.', hint: 'too_many_today' });
    expect(e).toBeInstanceOf(Problem);
    expect(e.message).toBe('No company was started: this account has already started 3 companies in the last 24 hours, the most it can in a day. Try again tomorrow at this time.');
    expect(e.code).toBe('PT429');
  });

  it('says so when the account has started 20 in all, and where to write to start another', async () => {
    const e = await refusal({ code: 'PT429', message: 'This account has started 20 companies, the most one account may. Write to MineMuster to start more.', hint: 'too_many_in_all' });
    expect(e.message).toBe('No company was started: this account has already started 20 companies, the most one account can. To start another, write to us at minemuster.com/contact.');
    expect(e.code).toBe('PT429');
  });

  it('passes on what the server said for a limit it does not know yet, or says what it can', async () => {
    expect((await refusal({ code: 'PT429', message: 'Too many for now. Try again later.', hint: 'something_new' })).message).toBe(
      'No company was started: Too many for now. Try again later.',
    );
    expect((await refusal({ code: 'PT429', message: '', hint: null })).message).toBe(
      'No company was started: this account has started too many companies for now. Try again tomorrow.',
    );
  });

  it('puts every other refusal into words as before', async () => {
    expect((await refusal({ code: '22023', message: 'Give the company a name of 1 to 120 characters.' })).message).toBe(
      'Something typed is not allowed: Give the company a name of 1 to 120 characters.',
    );
    expect((await refusal({ code: '42501', message: 'Sign in first.' })).message).toMatch(/^Starting the company is not allowed for this account\./);
  });

  it('hands back the new company and its code', async () => {
    answer.value = { data: [{ company_id: 'company-a', join_code: 'ABCD2345' }], error: null };
    await expect(createCompany(NEW)).resolves.toEqual({ companyId: 'company-a', joinCode: 'ABCD2345' });
  });
});

describe('the words for a limit say the numbers the server enforces', () => {
  it('names the latest migration\'s limits', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
    const latest = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
      .filter((name) => /function public\.create_company\b/i.test(readFileSync(path.join(migrations, name), 'utf8'))).at(-1);
    expect(latest).toBeTruthy();
    const sql = readFileSync(path.join(migrations, latest as string), 'utf8');
    const inAll = /started_in_all >= (\d+)/.exec(sql)?.[1];
    const today = /started_today >= (\d+)/.exec(sql)?.[1];
    expect(inAll && today).toBeTruthy();
    const { companyLimitWords } = await import('../src/lib/errors');
    expect(companyLimitWords('too_many_today', '')).toContain(` ${today} companies`);
    expect(companyLimitWords('too_many_in_all', '')).toContain(` ${inAll} companies`);
  });
});
