import { useState } from 'react';

import { keepsTime } from '@app/domain/company';
import type { PayrollCsvLayout } from '@app/domain/payrollCsv';
import { type Span } from '@app/domain/spans';
import { inspectorReport } from '@app/services/inspectorReport';
import { payrollHoursFile, payrollReport, safetyReport } from '@app/services/reports';
import { addDays, DAY, fmtDayShort, ymd } from '@app/util/format';

import { useCompany } from '../lib/company';
import { CSV_TYPE, PDF_TYPE, saveFile, XLSX_TYPE } from '../lib/download';
import { messageOf } from '../lib/errors';
import { currentSpan, hoursFileData, payrollViews, reportRange, safetyFileData } from '../lib/payroll';
import { presetRange, PRESETS, typedRange, type DayRange, type Preset } from '../lib/ranges';
import { A, Button, count, Notice, Seg, TextField } from '../ui/kit';
import { SpanBar } from './PayrollPage';
import { SettingsNotices } from './settingsNotices';
import { PageHead } from './Shell';

type Pick = Preset | 'days';

const rangeWords = (r: DayRange) => {
  const last = r.to - DAY;
  return r.from === addDays(r.to, -1) ? `${fmtDayShort(r.from)}, ${new Date(r.from).getFullYear()}` : `${fmtDayShort(r.from)} to ${fmtDayShort(last)}, ${new Date(last).getFullYear()}`;
};

type Panel = 'safety' | 'pay';

/** The files the office hands on: the records for an MSHA inspector, the safety log, and payroll. */
export function ExportsPage() {
  const ctx = useCompany();
  const { data, company } = ctx.shaped;
  const [pick, setPickRaw] = useState<Pick>('30');
  const [from, setFromRaw] = useState(ymd(addDays(ctx.now, -29)));
  const [to, setToRaw] = useState(ymd(ctx.now));
  // What came of the last download, said under the buttons that made it, and cleared once the choice changes.
  const [said, setSaid] = useState<{ panel: Panel; tone: 'ok' | 'bo'; text: string } | null>(null);
  const changed = (panel: Panel) => setSaid((had) => (had?.panel === panel ? null : had));
  const setPick = (v: Pick) => { changed('safety'); setPickRaw(v); };
  const setFrom = (v: string) => { changed('safety'); setFromRaw(v); };
  const setTo = (v: string) => { changed('safety'); setToRaw(v); };

  const range = pick === 'days' ? typedRange(from, to) : presetRange(pick, ctx.now);
  const ok = !('error' in range);
  const within = (t: number) => ok && t >= range.from && t < range.to;
  const checks = data.inspections.filter((i) => within(i.submittedAt)).length;
  const exams = data.exams.filter((x) => within(x.submittedAt)).length;

  const timeKept = keepsTime(company);
  const views = payrollViews(ctx.shaped);
  const [span, setSpanRaw] = useState<Span>(() => currentSpan(views[0], ctx.now, ctx.shaped));
  const [layout, setLayoutRaw] = useState<PayrollCsvLayout>('period');
  const setSpan = (v: Span) => { changed('pay'); setSpanRaw(v); };
  const setLayout = (v: PayrollCsvLayout) => { changed('pay'); setLayoutRaw(v); };

  const make = (panel: Panel, what: string, build: () => { name: string; bytes: Uint8Array }, type: string) => {
    setSaid(null);
    try {
      const file = build();
      saveFile(file.name, file.bytes, type);
      setSaid({ panel, tone: 'ok', text: `${what} is downloading: ${file.name}` });
    } catch (e) {
      setSaid({ panel, tone: 'bo', text: `${what} could not be made: ${messageOf(e)} Reload the page and try again. If it keeps happening, tell whoever runs MineMuster for your company.` });
    }
  };
  const result = (panel: Panel) => (said?.panel === panel ? <Notice tone={said.tone} live>{said.text}</Notice> : null);

  return (
    <>
      <PageHead title="Exports" lede="Files made from the company’s records on the server, the same as the app makes them on a phone." />

      <section className="panel" aria-labelledby="safety-title">
        <div className="stack" style={{ gap: '0.3rem' }}>
          <h2 className="h2" id="safety-title">Safety records</h2>
          <p className="section-note">
            The PDF holds what an MSHA inspector asks to see: the equipment defects that affect safety and when each was corrected (<span className="cite">30 CFR § 56.14100(d)</span>), every equipment checklist (<span className="cite">30 CFR § 56.14100(a)</span>), and every pre shift exam with the conditions found and the date each was corrected (<span className="cite">30 CFR § 56.18002</span>). A defect or condition from before the days chosen that is still not corrected is carried in. Every record shows when it was signed.
          </p>
        </div>
        <div className="row" style={{ alignItems: 'end' }}>
          <Seg<Pick> label="Days" value={pick} onChange={setPick} options={[...PRESETS, { value: 'days', label: 'Pick the days' }]} />
        </div>
        {pick === 'days' ? (
          <div className="form-grid" style={{ maxWidth: '30rem' }}>
            <TextField label="First day" type="date" value={from} onChange={setFrom} error={!ok && range.field === 'from' ? range.error : null} />
            <TextField label="Last day" type="date" value={to} onChange={setTo} error={!ok && range.field === 'to' ? range.error : null} />
          </div>
        ) : null}
        {ok ? (
          <p>
            <strong>{rangeWords(range)}.</strong> <span className="muted">{count(checks, 'equipment checklist')} and {count(exams, 'pre shift exam')} signed in these days.</span>
          </p>
        ) : null}
        <div className="row">
          <Button kind="main" disabled={!ok} onClick={() => ok && make('safety', 'The PDF for an MSHA inspector', () => inspectorReport(safetyFileData(ctx.shaped), range.from, range.to, Date.now()), PDF_TYPE)}>
            Download the PDF for an MSHA inspector
          </Button>
          <Button kind="ink" disabled={!ok} onClick={() => ok && make('safety', 'The safety log', () => safetyReport(safetyFileData(ctx.shaped), range.from, range.to, Date.now()), XLSX_TYPE)}>
            Download the safety log for Excel
          </Button>
        </div>
        {result('safety')}
        <p className="small muted">
          The safety log has a sheet for each paper form: equipment checklists with the 21 lines as columns, Bad Order items, equipment use, pre shift exams, the conditions found, every line of every exam, maintenance requests, and time on site from the time clock{timeKept ? '' : ', for any time the crew kept with it'}.
          {company.mineId ? ` The PDF prints MSHA mine ID ${company.mineId}.` : <> A supervisor can add the MSHA mine ID on the <A href="/company">Company page</A> to print it at the top of the PDF.</>}
        </p>
      </section>

      {timeKept ? (
        <section className="panel" aria-labelledby="pay-title">
          <div className="stack" style={{ gap: '0.3rem' }}>
            <h2 className="h2" id="pay-title">Payroll</h2>
            <p className="section-note">
              The payroll workbook has the summary by employee (straight time, overtime, double time, holiday, PTO and sick), the daily detail, paid leave, the punch log and the flags for review. The hours file is a plain CSV for the payroll system’s import: payroll ID, earning code and hours. Both are hours only, before taxes, and never carry an hourly rate.
            </p>
          </div>
          <SettingsNotices />
          <SpanBar span={span} views={views} onMove={setSpan} />
          <Seg<PayrollCsvLayout>
            label="The hours file has"
            showLabel
            value={layout}
            onChange={setLayout}
            options={[{ value: 'period', label: 'Totals for each person' }, { value: 'day', label: 'One line a day' }]}
          />
          <div className="row">
            <Button kind="ink" onClick={() => make('pay', 'The payroll workbook', () => payrollReport(data, reportRange(span), Date.now()), XLSX_TYPE)}>Download payroll for Excel</Button>
            <Button kind="line" onClick={() => make('pay', 'The payroll hours file', () => payrollHoursFile(hoursFileData(ctx.shaped), reportRange(span), layout, Date.now()), CSV_TYPE)}>Download the hours file</Button>
          </div>
          {result('pay')}
          <p className="small muted">The earning codes are the company’s own, set on the Company page. Each person’s payroll ID is set on the Roster page. Someone with no employee record yet is left out of the hours file; Time and payroll lists them.</p>
        </section>
      ) : (
        <Notice tone="info" title="No payroll files">This company uses MineMuster for the safety forms only, so there are no hours to export.</Notice>
      )}
    </>
  );
}
