import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * pushRecords against a stand-in for PostgREST's answer to `push_records`. A
 * company the account is not in is answered "No such company.": PT404 (HTTP
 * 404) from migration 20261117000600 on, P0002 (HTTP 500) on a server before it.
 */
const answer = vi.hoisted(() => ({ value: { data: null as unknown, error: null as unknown } }));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: () => Promise.resolve(answer.value) } }));

const { pushRecords } = await import('../src/lib/api');
const { mayHaveLostRole, Problem } = await import('../src/lib/errors');

const OFF_THE_ROSTER = 'Nothing was saved: this account is not on the company’s roster any more. Sign out and back in, or ask another supervisor.';

async function refusal(error: unknown) {
  answer.value = { data: null, error };
  try {
    await pushRecords('company-a', []);
  } catch (e) {
    return e;
  }
  throw new Error('pushRecords did not refuse');
}

beforeEach(() => {
  answer.value = { data: null, error: null };
});

describe('pushRecords', () => {
  it('says the account is off the roster for "No such company.", as the server sends it now and as it did before', async () => {
    for (const code of ['PT404', 'P0002']) {
      const e = await refusal({ code, message: 'No such company.', details: null, hint: null });
      expect(e).toBeInstanceOf(Problem);
      expect((e as InstanceType<typeof Problem>).message).toBe(OFF_THE_ROSTER);
      // The page then asks again whether this account is still a supervisor here.
      expect(mayHaveLostRole((e as InstanceType<typeof Problem>).code)).toBe(true);
    }
  });

  it('puts any other refusal into words of its own', async () => {
    const e = await refusal({ code: '22023', message: 'Changes are sent as a list.' });
    expect((e as Error).message).toBe('Something typed is not allowed: Changes are sent as a list.');
    expect(mayHaveLostRole((e as InstanceType<typeof Problem>).code)).toBe(false);
  });

  it('hands back what the server said when it took the changes', async () => {
    answer.value = { data: { accepted: [], ignored: [] }, error: null };
    await expect(pushRecords('company-a', [])).resolves.toEqual({ accepted: [], ignored: [] });
  });
});
