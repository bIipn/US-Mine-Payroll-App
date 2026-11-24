import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { savedCompany, STATES } from '@app/domain/company';
import { BANK, CODE_ROWS, companyFromDraft, draftOf, OFTEN, PAID_BY, paidByOf, scheduleOf, type CompanyDraft, type Often, type PaidBy } from '@app/domain/companyForm';
import { describePaySchedule, nextPayday, type IfBankClosed } from '@app/domain/payPeriod';
import { rulesFor } from '@app/domain/stateRules';
import { mealSummary, overtimeSummary } from '@app/domain/time';
import { fmtDate } from '@app/util/format';

import { updateCompany } from '../lib/api';
import { useCompany } from '../lib/company';
import { messageOf } from '../lib/errors';
import { writtenOver } from '../lib/history';
import { SaidNotice, saidOf, useFormFields, useFormSaver, useSaid } from '../lib/save';
import { companyProblems, companyRowPatch, ON_PHONES, readSite, SAVED_FOR_PHONES, sharedSettings, SIGN_IN_DETAILS, WEEKDAYS, type CompanyProblems, type PayField } from '../lib/setup';
import { browserZone } from '../lib/timezone';
import { useVersions } from '../lib/versions';
import { zoneChoices, zoneLabel } from '../lib/zones';
import { CompanyLogoPlate } from '../ui/brand';
import { Button, Check, Notice, Seg, SelectField, TextField } from '../ui/kit';
import { PhonesNotice, WrittenOverNotice } from './setupNotices';
import { PageHead } from './Shell';

const STATE_OPTIONS = [{ value: '', label: 'Choose the state' }, ...Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
const WEEK_OPTIONS = WEEKDAYS.map((label, day) => ({ value: String(day), label }));
const PHONES_TAKE = 'Phones take this the next time they are open with signal.';
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Everything the form holds: the company as typed, the day the workweek starts, the "Rest are OK" switch and the time zone. */
interface Fields extends CompanyDraft {
  week: string;
  allOk: boolean;
  zone: string;
}

/**
 * The shared settings this dashboard and every phone go by, which each phone
 * takes the next time it is open with signal: the company's name, state, place and mine ID,
 * whether the crew keeps time, the pay schedule, the earning codes, the day
 * the workweek starts and the "Rest are OK" switch. The form is the app's own
 * (`companyForm`), checked by the app's own rules. The clock-in site is shown
 * and never changed here: its pin is set standing at the mine, on a phone.
 */
export function CompanyPage() {
  const ctx = useCompany();
  const { shaped } = ctx;
  // From the settings this form opened on: settings a phone sent since are said, not written over.
  const saver = useFormSaver('settings', 'company');
  const versions = useVersions('settings', 'company');
  const company = shaped.company;
  // The form as the settings stand now. A field nobody touched follows newer settings; one that was typed in stays as typed.
  const standing: Fields = { ...draftOf(company, ctx.now), week: String(shaped.workweekStartsOn), allOk: shaped.allowSectionAllOk, zone: ctx.company?.timezone || browserZone() };
  const { fields: draft, set, dirty, restart } = useFormFields<Fields>(standing);
  const { week, allOk, zone } = draft;
  saver.shows(!dirty);
  const [problems, setProblems] = useState<CompanyProblems>({});
  const { said, say, clear } = useSaid();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLSelectElement>(null);
  const mineRef = useRef<HTMLInputElement>(null);
  const payRef = useRef<HTMLDivElement>(null);
  const payFields = useRef<Partial<Record<PayField, HTMLInputElement | null>>>({});
  const codeFields = useRef<Record<string, HTMLInputElement | null>>({});
  const codesErrorId = useId();
  // Counts the saves that were turned back: each one moves the focus to the field at fault, and says the reason afresh.
  const [turnedBack, setTurnedBack] = useState(0);
  useEffect(() => {
    if (!turnedBack) return;
    if (problems.name) nameRef.current?.focus();
    else if (problems.state) stateRef.current?.focus();
    else if (problems.mineId) mineRef.current?.focus();
    else if (problems.pay) (problems.payField ? payFields.current[problems.payField] : payRef.current?.querySelector<HTMLElement>('input, select'))?.focus();
    else if (problems.codes) codeFields.current[problems.codeKeys?.[0] ?? CODE_ROWS[0][0].key]?.focus();
    // Only when a save was turned back, not on every keystroke after it.
  }, [turnedBack]);

  const change = (part: Partial<Fields>) => {
    set(part);
    if (said) clear();
  };

  const schedule = draft.timeClock ? scheduleOf(draft) : null;
  const live = companyProblems(draft);
  const preview = schedule && !live.pay ? { said: describePaySchedule(schedule), next: nextPayday(ctx.now, schedule).payDate } : null;
  const byWeek = draft.often === 'weekly' || draft.often === 'biweekly';
  const paidBy = paidByOf(draft);
  const rules = draft.state ? rulesFor(draft.state) : null;
  const site = readSite(shaped.site);
  const zones = zoneChoices();
  const zoneOptions = zones.some((z) => z.value === zone) ? zones : [{ value: zone, label: zoneLabel(zone) }, ...zones];
  /** What the app's check says about a field of the pay period, said at that field. */
  const payError = (field: PayField) => (live.payField === field ? live.pay : undefined);
  const payInput = (field: PayField) => (el: HTMLInputElement | null) => {
    payFields.current[field] = el;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    clear();
    const wrong = companyProblems(draft);
    setProblems(wrong);
    if (Object.keys(wrong).length) {
      setTurnedBack((n) => n + 1);
      say({ tone: 'bo', text: 'Put right the field marked in red, then save again.' });
      return;
    }
    // The app's own tidy-up and check of the whole company, as its store runs before saving.
    const saved = savedCompany(companyFromDraft(company, draft));
    if (!saved.ok) {
      say({ tone: 'bo', text: saved.error });
      return;
    }
    const record = sharedSettings({ company: saved.company, site: shaped.site, workweekStartsOn: Number(week), allowSectionAllOk: allOk });
    setBusy(true);
    try {
      const result = await saver.save(record, 'the company settings', { plural: true });
      if (!result.ok) {
        say(saidOf(result, ''));
        return;
      }
      // The company's sign-in details on the server say the same where the two overlap: name, state and pay period.
      let rowTrouble: string | null = null;
      try {
        await updateCompany(ctx.choice.id, companyRowPatch(saved.company, zone, ctx.company));
        await ctx.reloadRoster();
        // The name in the list of companies comes from the server's row.
        void ctx.recheckRole();
      } catch (e) {
        rowTrouble = messageOf(e);
      }
      // The form as it was saved: the name closed up, the mine ID as its seven digits.
      restart({ ...draftOf(saved.company, ctx.now), week: String(record.workweekStartsOn), allOk, zone });
      say(
        rowTrouble
          ? { tone: 'warn', text: `The company details are saved to the company’s records. ${cap(SIGN_IN_DETAILS)} could not be changed: ${rowTrouble} Save again to try that part once more.` }
          : saidOf(result, 'The company details are saved. Phones take them the next time they are open with signal.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const putBack = () => {
    restart(standing);
    setProblems({});
    clear();
  };

  return (
    <>
      <PageHead title="Company" lede="The company’s details as this dashboard and every phone go by them: the name on the files, the state whose hours rules apply, the pay periods and the earning codes. Every figure they lead to is before taxes." />
      {/* One column, the width of the form: the notices and the panels end at one edge. */}
      <div className="setup-page">
        <PhonesNotice lines={ON_PHONES.company} />
        <WrittenOverNotice
          found={versions ? writtenOver('settings', versions) : null}
          id="settings:company"
          what="the settings saved here"
          then="Payroll, the hours file and the exports here go by the settings below, which are what the server has now. Set them again here if the office’s were right: phones take what is saved here the next time they are open with signal, and the server no longer takes an older copy over it."
        />
        {shaped.settingsFrom === 'server' ? (
          shaped.skipped.some((s) => s.kind === 'settings') ? (
            <Notice tone="warn" title="The settings on the server are set aside">
              They are not the shape the app writes, so no page goes by them. The form starts from the company as it was made here. Saving it puts whole settings in their place, with the clock-in site kept as it was sent.
            </Notice>
          ) : (
            <Notice tone="info" title="No settings have arrived from a phone yet">
              The form starts from the company as it was made here. Saving it makes the company’s shared settings on the server, and phones take them the next time they are open with signal.
            </Notice>
          )
        ) : null}
        <form className="setup-form" onSubmit={submit} noValidate aria-label="Company details">
          <section className="panel" aria-labelledby="co-title">
            <h2 className="h2" id="co-title">The company</h2>
            <TextField
              label="Company name"
              value={draft.name}
              onChange={(name) => change({ name })}
              maxLength={120}
              autoComplete="organization"
              hint="The way the pay stub prints it. It heads the payroll export."
              error={problems.name && live.name}
              inputRef={nameRef}
            />
            <div className="form-grid">
              <SelectField
                label="State"
                value={draft.state}
                onChange={(state) => change({ state })}
                options={STATE_OPTIONS}
                hint="Overtime and meal rules follow the state the crew works in."
                error={problems.state && live.state}
                selectRef={stateRef}
              />
              <SelectField label="Time zone" value={zone} onChange={(next) => change({ zone: next })} options={zoneOptions} hint="The company’s own. The dashboard says so when this computer keeps another clock." />
            </div>
            {rules ? (
              <div className="rules-said">
                <p>{overtimeSummary(rules)}</p>
                <p>{mealSummary(rules)}</p>
                {rules.note ? <p>{rules.note}</p> : null}
                <p className="muted">A summary in plain language, not legal advice.</p>
              </div>
            ) : null}
            <div className="form-grid">
              <TextField label="Where the crew works" value={draft.place} onChange={(place) => change({ place })} maxLength={80} hint="Optional. Shown on the app’s sign-in screen, like Fallon, Nevada." />
              <TextField
                label="MSHA mine ID"
                value={draft.mineId}
                onChange={(mineId) => change({ mineId })}
                inputMode="numeric"
                maxLength={9}
                hint="Optional. Seven digits. Printed on the records for an inspector."
                error={problems.mineId && live.mineId}
                inputRef={mineRef}
              />
            </div>
            <div className="stack" style={{ gap: '0.35rem' }}>
              <span className="field-label">Logo</span>
              {company.logo ? <CompanyLogoPlate logo={company.logo} name={company.name} /> : <p className="field-hint">No logo. The top of the app’s clock screen shows its plain colour.</p>}
              {company.logo ? <p className="field-hint">The logo is not changed here.</p> : null}
            </div>
          </section>

          <section className="panel" aria-labelledby="uses-title">
            <h2 className="h2" id="uses-title">What the crew uses</h2>
            <Check
              label="Time clock and hours"
              hint={
                draft.timeClock
                  ? `This dashboard and the app show hours and payroll. Turned off, they show the safety forms only. ${PHONES_TAKE}`
                  : `Safety forms only, here and in the app: equipment checklists, pre shift exams and maintenance requests, with no hours or payroll. ${PHONES_TAKE}`
              }
              checked={draft.timeClock}
              onChange={(timeClock) => change({ timeClock })}
            />
            <Check
              label="Allow “Rest are OK”"
              hint={`Lets a person mark the unanswered lines of a checklist or an exam OK with one tap. Turn off to make them answer every line. ${PHONES_TAKE}`}
              checked={allOk}
              onChange={(on) => change({ allOk: on })}
            />
          </section>

          {draft.timeClock ? (
            <section className="panel" aria-labelledby="pay-title">
              <h2 className="h2" id="pay-title">Pay periods</h2>
              <p className="small muted">With pay periods, everyone sees the hours for each one and the next payday. Without, hours are shown by the workweek and the month.</p>
              <div className="stack" ref={payRef}>
                <SelectField<Often> label="How often the company pays" value={draft.often} onChange={(often) => change({ often })} options={OFTEN} />
                {byWeek ? (
                  <TextField label="First day of any one pay period" type="date" value={draft.firstDay} onChange={(firstDay) => change({ firstDay })} hint="Every period runs from that weekday." error={payError('firstDay')} inputRef={payInput('firstDay')} />
                ) : null}
                {draft.often === 'semimonthly' || draft.often === 'monthly' ? (
                  <Seg<PaidBy> label="When a period is paid" showLabel value={draft.paidBy} onChange={(next) => change({ paidBy: next })} options={PAID_BY} />
                ) : null}
                {draft.often !== 'none' && paidBy === 'daysAfter' ? (
                  <TextField label="Paid how many days after the last day" value={draft.daysAfter} onChange={(daysAfter) => change({ daysAfter })} inputMode="numeric" maxLength={2} hint="0 pays on the last day of the period." className="input-short" error={payError('daysAfter')} inputRef={payInput('daysAfter')} />
                ) : null}
                {draft.often === 'semimonthly' && paidBy === 'dayOfMonth' ? (
                  <div className="form-grid">
                    <TextField label="The 1st to the 15th is paid on the" value={draft.firstHalf} onChange={(firstHalf) => change({ firstHalf })} inputMode="numeric" maxLength={2} hint="A day of the month, 1 to 31." error={payError('firstHalf')} inputRef={payInput('firstHalf')} />
                    <TextField label="The 16th to the end is paid on the" value={draft.secondHalf} onChange={(secondHalf) => change({ secondHalf })} inputMode="numeric" maxLength={2} hint="A day of the month, 1 to 31." error={payError('secondHalf')} inputRef={payInput('secondHalf')} />
                  </div>
                ) : null}
                {draft.often === 'monthly' && paidBy === 'dayOfMonth' ? (
                  <TextField label="Paid on this day of the month" value={draft.firstHalf} onChange={(firstHalf) => change({ firstHalf })} inputMode="numeric" maxLength={2} hint="A day past the end of a short month means its last day." className="input-short" error={payError('firstHalf')} inputRef={payInput('firstHalf')} />
                ) : null}
                {draft.often !== 'none' ? (
                  <Seg<IfBankClosed> label="A pay date the bank is closed" showLabel value={draft.ifBankClosed} onChange={(ifBankClosed) => change({ ifBankClosed })} options={BANK} />
                ) : null}
              </div>
              {preview ? (
                <div className="rules-said">
                  <p>{preview.said}</p>
                  <p className="muted">Next payday {fmtDate(preview.next)}.</p>
                </div>
              ) : live.pay && !live.payField ? (
                // A fault that is in no one field a person types in is said under them all.
                <p className="field-error" key={turnedBack} role={problems.pay ? 'alert' : undefined}>{live.pay}</p>
              ) : null}
              <SelectField
                label="The workweek starts on"
                value={week}
                onChange={(day) => change({ week: day })}
                options={WEEK_OPTIONS}
                hint="Overtime is figured over whole workweeks. The app has no screen for this day: it is set here, and phones take it the next time they are open with signal."
                className="field-short"
              />
            </section>
          ) : null}

          {draft.timeClock ? (
            <section className="panel" aria-labelledby="codes-title">
              <h2 className="h2" id="codes-title">Earning codes</h2>
              <p className="small muted">The code your payroll system uses for each kind of hours. They go on the payroll hours file, one line for each.</p>
              <div className="codes-grid">
                {CODE_ROWS.flat().map(({ key, label }) => (
                  <TextField
                    key={key}
                    label={label}
                    value={draft.codes[key]}
                    onChange={(text) => change({ codes: { ...draft.codes, [key]: text.toUpperCase() } })}
                    maxLength={12}
                    invalid={!!live.codeKeys?.includes(key)}
                    describedBy={live.codes ? codesErrorId : undefined}
                    inputRef={(el) => {
                      codeFields.current[key] = el;
                    }}
                  />
                ))}
              </div>
              {/* Said once for the codes it is about, each of which is marked. A save turned back says it afresh. */}
              {live.codes ? <p className="field-error" id={codesErrorId} key={turnedBack} role={problems.codes ? 'alert' : undefined}>{live.codes}</p> : null}
            </section>
          ) : null}

          <p className="small muted">{SAVED_FOR_PHONES}</p>
          {/* Always in reach: the form is long, and Enter in any field saves it. */}
          <div className="save-bar">
            <SaidNotice said={said} />
            <div className="row">
              <Button kind="main" type="submit" busy={busy}>{busy ? 'Saving' : 'Save company details'}</Button>
              {dirty ? <Button kind="quiet" onClick={putBack}>Put back what is saved</Button> : null}
              <span className="small muted">{dirty ? 'Changes here are not saved yet.' : 'This is what is saved.'}</span>
            </div>
          </div>
        </form>

        <section className="section" aria-labelledby="site-title">
          <h2 className="h2" id="site-title">Clock-in site</h2>
          {site ? (
            <dl className="facts">
              <div><dt>Name</dt><dd>{site.name || 'No name'}</dd></div>
              <div><dt>Pin</dt><dd className="num">{site.lat.toFixed(4)}, {site.lng.toFixed(4)}</dd></div>
              <div><dt>Boundary</dt><dd>{Math.round(site.radiusM).toLocaleString('en-US')} m around the pin</dd></div>
              {site.town ? <div><dt>Nearest town</dt><dd>{site.town}</dd></div> : null}
            </dl>
          ) : (
            <Notice tone="neutral">No clock-in site has arrived from a phone. With none, the app turns a clock-in down; clocking out and lunch are never blocked.</Notice>
          )}
          <p className="small muted">The pin is set standing at the mine, in the app, on More → Mine boundary. It is shown here and not changed here, and saving the form above keeps it as it is.</p>
        </section>
      </div>
    </>
  );
}
