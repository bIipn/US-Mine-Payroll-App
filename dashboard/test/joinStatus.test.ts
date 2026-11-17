import { describe, expect, it } from 'vitest';

import { joinMessage, REQUEST_STATUS, withStop } from '../src/lib/joinStatus';

describe('joinMessage', () => {
  it('opens the company only when the person is in it', () => {
    const open = (status: Parameters<typeof joinMessage>[0]['status']) => joinMessage({ status, company_name: 'Test Pit A' }).open;
    expect(open('joined')).toBe(true);
    expect(open('already_member')).toBe(true);
    expect(open('pending')).toBe(false);
    expect(open('denied')).toBe(false);
    expect(open('ambiguous')).toBe(false);
    expect(open('no_company')).toBe(false);
  });

  it('says what happened and what to do next', () => {
    expect(joinMessage({ status: 'no_company' }).text).toBe('No company has that code. Check the code with a supervisor and type it again.');
    expect(joinMessage({ status: 'denied', company_name: 'Test Pit A' }).text).toMatch(/turned your request down\. Speak to one of them\.$/);
    expect(joinMessage({ status: 'pending', company_name: 'Test Pit A' }).text).toBe('Your request to join Test Pit A is waiting for a supervisor. Once one has let you in, check again here.');
    expect(joinMessage({ status: 'joined', role: 'supervisor', company_name: 'Test Pit A' }).text).toBe('You have joined Test Pit A as a supervisor.');
  });

  it('ends a sentence on a name that already ends with a full stop just once', () => {
    expect(joinMessage({ status: 'joined', company_name: 'Sample Mining Co.' }).text).toBe('You have joined Sample Mining Co.');
    expect(joinMessage({ status: 'already_member', company_name: 'Test Pit A' }).text).toBe('You are already on the roster of Test Pit A.');
    expect(withStop('Done ')).toBe('Done.');
  });

  it('has words for every request status', () => {
    expect(Object.keys(REQUEST_STATUS).sort()).toEqual(['approved', 'denied', 'pending', 'withdrawn']);
  });
});
