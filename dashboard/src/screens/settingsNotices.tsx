import { STATES } from '@app/domain/company';
import { DEFAULT_PAY_CODES } from '@app/domain/payrollCsv';
import { rulesFor } from '@app/domain/stateRules';
import { overtimeSummary } from '@app/domain/time';

import { useCompany } from '../lib/company';
import { Notice } from '../ui/kit';

const CODES = Object.values(DEFAULT_PAY_CODES);
const listed = `${CODES.slice(0, -1).join(', ')} and ${CODES[CODES.length - 1]}`;

/**
 * Where the company settings behind the hours come from, when that would make
 * the figures here differ from what the people looking at them expect: no
 * settings from a supervisor's phone yet, or settings that name no state.
 */
export function SettingsNotices() {
  const { shaped } = useCompany();
  const hours = shaped.counts.shift + shaped.counts.leave > 0;
  if (shaped.settingsFrom === 'server') {
    if (!hours) return null;
    return (
      <Notice tone="warn" title="No settings have arrived from a supervisor’s phone yet">
        Until they do, the hours here are figured with the company’s state as the server has it, workweeks that start on Sunday, and the earning codes {listed}. If the phones use another workweek or other codes, the figures and the files here differ from theirs until a supervisor’s phone sends the company settings.
      </Notice>
    );
  }
  if (STATES[shaped.company.state]) return null;
  return (
    <Notice tone="warn" title="The phones have no state set">
      So the hours are figured under the federal rules, the same as on the phones. {overtimeSummary(rulesFor(''))} Set the state in the app, on More → Company, and the phones and these pages follow that state’s rules.
    </Notice>
  );
}
