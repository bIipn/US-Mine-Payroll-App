// The Your account page's plan for deleting the signed-in account, from account_deletion_check. The
// companies and people are made up.
import { describe, expect, it } from 'vitest';

import type { DeletionCheckCompany } from '@app/domain/accountDeletion';

import { accountPlan, deleteBody, namedAs, stepFor, stepWords } from '../src/lib/accountPlan';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const company = (over: Partial<DeletionCheckCompany> & Pick<DeletionCheckCompany, 'id' | 'name'>): DeletionCheckCompany => ({
  role: 'supervisor',
  lastSupervisor: false,
  successors: [],
  canClose: false,
  closeFrom: null,
  running: 0,
  ...over,
});
const LEE = { rosterId: 'r-lee', firstName: 'Lee', lastName: 'Park' };
const BO = { rosterId: 'r-bo', firstName: 'Bo', lastName: 'Lark' };

describe('each company’s step', () => {
  it('leaves a company where the person is crew, or a supervisor beside another, as it is', () => {
    expect(stepFor(company({ id: 'a', name: 'Test Pit A', role: 'employee', running: null })).kind).toBe('stays');
    expect(stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: false })).kind).toBe('stays');
  });

  it('sends a last supervisor with someone to take over to that company’s Roster page first', () => {
    const step = stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, successors: [LEE, BO] }));
    expect(step.kind).toBe('hand_over');
    expect(stepWords(step, day)).toEqual({
      title: 'You are Test Pit A’s only supervisor',
      body: 'Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make Lee Park or Bo Lark a supervisor on Test Pit A’s Roster page, then come back.',
    });
  });

  it('says from when a company can be closed while only people who left lately stand in the way', () => {
    const step = stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, closeFrom: '2026-12-20T18:00:00+00:00' }));
    expect(step).toMatchObject({ kind: 'wait', from: Date.parse('2026-12-20T18:00:00Z') });
    expect(stepWords(step, day)?.body).toBe(
      'Someone taken off Test Pit A’s roster in the last 30 days could still be put back, so Test Pit A can be closed from 2026-12-20. Until then, put someone back on the roster and make them a supervisor, on its Roster page.',
    );
    // No date and nobody to hand over to: nothing here can say more than to hand over.
    expect(stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, closeFrom: 'not a time' })).kind).toBe('hand_over');
  });

  it('closes a company nobody else could take over, once its subscription is cancelled', () => {
    const running = stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, canClose: true, running: 1 }));
    expect(running.kind).toBe('cancel_first');
    expect(stepWords(running, day)?.body).toBe('Test Pit A is closed with your account, and its subscription is still running. Cancel it in Test Pit A’s Billing first, then come back.');
    const close = stepFor(company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, canClose: true }));
    expect(close.kind).toBe('close');
    expect(stepWords(close, day)).toEqual({
      title: 'Nobody else can take over Test Pit A',
      body: 'To delete your account, close the company. Closing deletes Test Pit A and all its records from MineMuster’s server, for good. Download what the company has to keep first, on its Exports page.',
    });
  });
});

describe('the plan', () => {
  it('says what goes, what stays with the company and why, and that an app account on a phone stays there', () => {
    const plan = accountPlan('riley@example.com', [company({ id: 'a', name: 'Test Pit A', role: 'employee', running: null })]);
    expect(plan.intro).toBe('Deleting your account deletes your MineMuster sign-in, riley@example.com, and your requests to join a company. It cannot be undone.');
    expect(plan.deletes).toEqual([
      'Your MineMuster sign-in, riley@example.com, and its password. It stops working on every phone and on this dashboard.',
      'Your requests to join a company.',
    ]);
    expect(plan.keeps).toEqual([
      'Your name on Test Pit A’s roster, and the records you made, with your name on them. A supervisor takes your name off when you leave.',
      'MineMuster keeps them for Test Pit A while it uses MineMuster, and deletes them when the company asks.',
      'An account you made in the MineMuster app on a phone stays on that phone. Delete it there, under More, or delete the app.',
    ]);
    expect(plan.legal).toBe('They are Test Pit A’s records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it. A plain-language summary, not legal advice.');
    expect([plan.blocked, plan.closes]).toEqual([false, []]);
  });

  it('names what stays with each company kept, and nothing for one being closed', () => {
    const plan = accountPlan('sam@example.com', [
      company({ id: 'a', name: 'Test Pit A', role: 'employee', running: null }),
      company({ id: 'b', name: 'Test Pit B' }),
      company({ id: 'c', name: 'Test Pit C', lastSupervisor: true, canClose: true }),
    ]);
    expect(plan.keeps[0]).toBe('Your name on Test Pit A’s and Test Pit B’s rosters, and the records you made, with your name on them. A supervisor takes your name off when you leave.');
    expect(plan.keeps[1]).toBe('MineMuster keeps them for each company while it uses MineMuster, and deletes them when the company asks.');
    expect(plan.legal.startsWith('They are each company’s records.')).toBe(true);
    expect(plan.closes.map((c) => c.id)).toEqual(['c']);
    expect(plan.blocked).toBe(false);
    // Only the company closed: nothing of it stays, and no reason is given for keeping it.
    const alone = accountPlan('sam@example.com', [company({ id: 'c', name: 'Test Pit C', lastSupervisor: true, canClose: true })]);
    expect([alone.keeps.length, alone.legal]).toEqual([1, '']);
  });

  it('holds the delete back while any company needs something done elsewhere first', () => {
    for (const blocker of [
      company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, successors: [LEE] }),
      company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, closeFrom: '2026-12-20T18:00:00Z' }),
      company({ id: 'a', name: 'Test Pit A', lastSupervisor: true, canClose: true, running: 2 }),
    ]) {
      expect(accountPlan('sam@example.com', [blocker, company({ id: 'c', name: 'Test Pit C', lastSupervisor: true, canClose: true })]).blocked).toBe(true);
    }
  });

  it('warns a supervisor beside another that a subscription stays with the company', () => {
    expect(accountPlan('sam@example.com', [company({ id: 'b', name: 'Test Pit B', running: 1 })]).warnings).toEqual([
      'Test Pit B’s subscription stays with the company. If its invoices come to your email, have another supervisor change the billing email first.',
    ]);
  });

  it('deletes only the sign-in of an account in no company', () => {
    const plan = accountPlan('pat@example.com', []);
    expect([plan.blocked, plan.closes, plan.legal]).toEqual([false, [], '']);
    expect(plan.keeps).toEqual(['An account you made in the MineMuster app on a phone stays on that phone. Delete it there, under More, or delete the app.']);
  });
});

describe('closing a company with the account', () => {
  it('takes its name as it is, capitals and spacing aside, and nothing else', () => {
    expect(namedAs('  test   PIT c ', 'Test Pit C')).toBe(true);
    for (const typed of ['', '   ', 'Test Pit', 'Test Pit CC', 'Test Pit A']) expect(namedAs(typed, 'Test Pit C')).toBe(false);
  });

  it('sends the companies to close by id with the name as typed, and an empty body when there are none', () => {
    const c = company({ id: 'c', name: 'Test Pit C', lastSupervisor: true, canClose: true });
    expect(deleteBody([c], { c: 'test pit c' })).toEqual({ close: [{ company_id: 'c', name: 'test pit c' }] });
    expect(deleteBody([], {})).toEqual({});
  });
});
