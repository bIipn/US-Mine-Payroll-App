import { stateName } from '@app/domain/company';

import type { CompanyChoice } from '../lib/server';
import { Notice, SelectField } from '../ui/kit';
import { TopBand } from './NoCompanyScreen';

/**
 * Someone on the crew who signs in here sees their company, and that the dashboard is for supervisors. The crew
 * use the app, where they sign in with the company code, their name and a passcode.
 */
export function EmployeeScreen({ email, choice, companies, onPick }: {
  email: string;
  choice: CompanyChoice;
  companies: CompanyChoice[];
  onPick: (id: string) => void;
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
              Your hours, equipment checklists, pre shift exams and maintenance requests are in the MineMuster app on your phone, which sends them to {choice.name}. In the app you sign in with the company code, your name as it is on the roster, and a passcode you choose. The first time, tap Sign up on the app’s first screen. A supervisor of {choice.name} can give you the company code.
            </p>
            <p style={{ marginTop: '0.5rem' }}>If you should be a supervisor of {choice.name}, ask one of its supervisors to make you one on the Roster page.</p>
          </Notice>
        </div>
      </main>
    </>
  );
}
