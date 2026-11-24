import type { ReactNode } from 'react';

import { stateName } from '@app/domain/company';

import type { CompanyChoice } from '../lib/server';
import { Notice, SelectField } from '../ui/kit';
import { TopBand } from './NoCompanyScreen';

/**
 * Someone on the crew who signs in here sees their company, and that the dashboard is for supervisors. They sign
 * in here with email, and that account holds their row, so the app takes the same email and password, through its
 * Supervisor? Sign in with email (ruling R32): a passcode sign-up for that row is turned down. `notice` is said
 * above the rest.
 */
export function EmployeeScreen({ email, choice, companies, onPick, notice }: {
  email: string;
  choice: CompanyChoice;
  companies: CompanyChoice[];
  onPick: (id: string) => void;
  notice?: ReactNode;
}) {
  return (
    <>
      <TopBand email={email} />
      <main className="main" id="main">
        <div className="page" style={{ maxWidth: '44rem' }}>
          <div className="page-head">
            <div className="page-head-text">
              <h1 className="h1">{choice.name}</h1>
              <p className="lede">{stateName(choice.state) || choice.state}. You are on the crew’s roster.</p>
            </div>
          </div>
          {notice}
          {companies.length > 1 ? (
            <SelectField
              label="Company"
              value={choice.id}
              onChange={onPick}
              options={companies.map((c) => ({ value: c.id, label: `${c.name}${c.role === 'supervisor' ? ', supervisor' : ''}` }))}
            />
          ) : null}
          <Notice tone="info" title="This dashboard is for supervisors">
            <p>
              Your hours, equipment checklists, pre shift exams and maintenance requests are in the MineMuster app on your phone, which sends them to {choice.name}. On the app’s first screen, tap Supervisor? Sign in with email, and sign in with this same email and password.
            </p>
            <p style={{ marginTop: '0.5rem' }}>If you should be a supervisor of {choice.name}, ask one of its supervisors to make you one on the Roster page.</p>
          </Notice>
        </div>
      </main>
    </>
  );
}
