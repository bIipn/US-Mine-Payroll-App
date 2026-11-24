import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CompanyLogoPlate } from '../../components/Brand';
import { Check } from '../../components/icons';
import { Button, Chips, Divider, Field, Panel, Page, Row, Sheet, Toggle, Txt } from '../../components/ui';
import { checkCompany, keepsTime, stateName, STATES } from '../../domain/company';
import { BANK, CODE_ROWS, companyFromDraft, draftOf, OFTEN, PAID_BY, paidByOf, scheduleOf, type CompanyDraft, type Often, type PaidBy } from '../../domain/companyForm';
import { checkPaySchedule, describePaySchedule, nextPayday, type IfBankClosed } from '../../domain/payPeriod';
import { rulesFor } from '../../domain/stateRules';
import { mealSummary, overtimeSummary } from '../../domain/time';
import type { ScreenProps } from '../../navigation/types';
import { syncReminders } from '../../services/reminders';
import { openShiftOf, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate } from '../../util/format';

// The form's fields and the company they make are the domain's (companyForm.ts), shared with the office dashboard.
type Draft = CompanyDraft;

/**
 * The company the crew works for: its name as the pay stub prints it, the
 * state whose hours rules apply, and its pay periods, if it wants them shown.
 * Supervisors only.
 */
export function CompanyScreen({ navigation }: ScreenProps<'Company'>) {
  const company = useStore((s) => s.settings.company);
  const { setCompany, showToast } = useStore.getState();
  const [draft, setDraft] = useState(() => draftOf(company));
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (part: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...part }));
    setError(null);
  };

  const schedule = scheduleOf(draft);
  const scheduleProblem = schedule ? checkPaySchedule(schedule) : undefined;
  const preview = useMemo(() => {
    if (!schedule || scheduleProblem) return null;
    return { said: describePaySchedule(schedule), next: nextPayday(Date.now(), schedule).payDate };
  }, [schedule, scheduleProblem]);

  const byWeek = draft.often === 'weekly' || draft.often === 'biweekly';
  const paidBy: PaidBy = paidByOf(draft);

  const save = () => {
    // With no time clock the pay periods are not shown, so what was saved stays as it was for when it is turned back on.
    const next = companyFromDraft(company, draft);
    const problem = checkCompany({ ...next, name: next.name.trim() });
    if (problem) {
      setError(problem);
      return;
    }
    const result = setCompany(next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The lunch reminders already waiting on this phone follow the state, so bring them in line with the new one.
    const { shifts, session, settings } = useStore.getState();
    // With no time clock there is no lunch to remind anyone of.
    const shift = keepsTime(next) ? openShiftOf(shifts, session?.employeeId ?? '', Date.now()) : undefined;
    if (session) void syncReminders(shift, settings.lunchReminders, rulesFor(next.state));
    showToast('Company details saved.');
    navigation.goBack();
  };

  return (
    <Page
      testID="company-screen"
      title="Company"
      sub="Name, state and pay periods"
      onBack={navigation.goBack}
      footer={<Button testID="company-save" label="Save company details" onPress={save} />}
    >
      <View style={{ gap: space.lg }}>
        <Panel title="The company">
          <View style={{ gap: space.lg }}>
            <Field
              testID="company-name"
              label="Company name"
              hint="The way the pay stub prints it. It heads the payroll export."
              value={draft.name}
              onChangeText={(name) => change({ name })}
              autoCapitalize="words"
            />
            <View style={{ gap: 6 }}>
              <Txt v="smallStrong">State</Txt>
              <Row
                testID="company-state"
                title={stateName(draft.state) || 'Choose the state'}
                sub="Overtime and meal rules follow the state the crew works in."
                chevron
                onPress={() => setPicking(true)}
              />
              {draft.state ? (
                <View style={styles.preview} testID="company-rules">
                  <Txt v="small">{overtimeSummary(rulesFor(draft.state))}</Txt>
                  <Txt v="small">{mealSummary(rulesFor(draft.state))}</Txt>
                  {rulesFor(draft.state).note ? <Txt v="small" testID="company-rules-note">{rulesFor(draft.state).note}</Txt> : null}
                  <Txt v="small" c={color.silica}>A summary in plain language, not legal advice.</Txt>
                </View>
              ) : null}
            </View>
            <Field
              testID="company-place"
              label="Where the crew works (optional)"
              hint="Shown on the sign-in screen, like Fallon, Nevada."
              value={draft.place}
              onChangeText={(place) => change({ place })}
              autoCapitalize="words"
            />
            <Field
              testID="company-mine-id"
              label="MSHA mine ID (optional)"
              hint="Seven digits. Printed on the records for an inspector."
              value={draft.mineId}
              onChangeText={(mineId) => change({ mineId })}
              keyboardType="number-pad"
              maxLength={9}
            />
            <View style={{ gap: space.sm }}>
              <Txt v="smallStrong">Logo</Txt>
              {company.logo ? (
                <CompanyLogoPlate logo={company.logo} name={company.name} width={200} />
              ) : (
                <Txt v="small" c={color.silica} testID="company-no-logo">
                  No logo. The top of the clock screen shows its plain colour.
                </Txt>
              )}
            </View>
          </View>
        </Panel>

        <Panel title="What the crew uses" flush>
          <Toggle
            testID="company-time-clock"
            label="Time clock and hours"
            sub={
              draft.timeClock
                ? 'The crew clocks in and out, and supervisors see hours and payroll. Turn off to use the safety forms only.'
                : 'Safety forms only: equipment checklists, pre shift exams and maintenance requests. No clock, hours or payroll.'
            }
            value={draft.timeClock}
            onChange={(timeClock) => change({ timeClock })}
          />
        </Panel>

        {draft.timeClock ? (
          <Panel title="Pay periods">
            <View style={{ gap: space.lg }}>
              <Txt v="small" c={color.silica}>
                With pay periods, everyone sees the hours for each one and the next payday. Without, hours are shown by the workweek and the month. Every figure is before taxes.
              </Txt>
              <Chips<Often> wrap testID="company-often" options={OFTEN} value={draft.often} onChange={(often) => change({ often })} />

              {byWeek ? (
                <Field
                  testID="company-first-day"
                  label="First day of any one pay period"
                  hint="As year-month-day, like 2026-11-01. Every period runs from that weekday."
                  value={draft.firstDay}
                  onChangeText={(firstDay) => change({ firstDay })}
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                />
              ) : null}

              {draft.often === 'semimonthly' || draft.often === 'monthly' ? (
                <Chips<PaidBy>
                  wrap
                  testID="company-paid-by"
                  options={PAID_BY}
                  value={draft.paidBy}
                  onChange={(next) => change({ paidBy: next })}
                />
              ) : null}

              {draft.often !== 'none' && paidBy === 'daysAfter' ? (
                <Field
                  testID="company-days-after"
                  label="Paid how many days after the last day"
                  hint="0 pays on the last day of the period."
                  value={draft.daysAfter}
                  onChangeText={(daysAfter) => change({ daysAfter })}
                  keyboardType="number-pad"
                />
              ) : null}

              {draft.often === 'semimonthly' && paidBy === 'dayOfMonth' ? (
                <View style={styles.pair}>
                  <View style={{ flex: 1 }}>
                    <Field
                      testID="company-first-half"
                      label="1st–15th paid on the"
                      value={draft.firstHalf}
                      onChangeText={(firstHalf) => change({ firstHalf })}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      testID="company-second-half"
                      label="16th–end paid on the"
                      value={draft.secondHalf}
                      onChangeText={(secondHalf) => change({ secondHalf })}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
              ) : null}

              {draft.often === 'monthly' && paidBy === 'dayOfMonth' ? (
                <Field
                  testID="company-first-half"
                  label="Paid on this day of the month"
                  hint="A day past the end of a short month means its last day."
                  value={draft.firstHalf}
                  onChangeText={(firstHalf) => change({ firstHalf })}
                  keyboardType="number-pad"
                />
              ) : null}

              {draft.often !== 'none' ? (
                <View style={{ gap: 6 }}>
                  <Txt v="smallStrong">A pay date the bank is closed</Txt>
                  <Chips<IfBankClosed> wrap testID="company-bank" options={BANK} value={draft.ifBankClosed} onChange={(ifBankClosed) => change({ ifBankClosed })} />
                </View>
              ) : null}

              {preview ? (
                <View style={styles.preview} testID="company-pay-preview">
                  <Txt v="body">{preview.said}</Txt>
                  <Txt v="small" c={color.silica}>Next payday {fmtDate(preview.next)}.</Txt>
                </View>
              ) : scheduleProblem ? (
                <Txt v="small" c={color.red}>{scheduleProblem}</Txt>
              ) : null}
            </View>
          </Panel>
        ) : null}

        {draft.timeClock ? (
          <Panel title="Earning codes">
            <View style={{ gap: space.lg }}>
              <Txt v="small" c={color.silica}>
                The code your payroll system uses for each kind of hours. They go on the payroll hours file, one line for each.
              </Txt>
              {CODE_ROWS.map((pair) => (
                <View key={pair[0].key} style={styles.pair}>
                  {pair.map(({ key, label }) => (
                    <View key={key} style={{ flex: 1 }}>
                      <Field
                        testID={`company-code-${key}`}
                        label={label}
                        value={draft.codes[key]}
                        onChangeText={(text) => change({ codes: { ...draft.codes, [key]: text.toUpperCase() } })}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        maxLength={12}
                      />
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </Panel>
        ) : null}

        {error ? (
          <Txt v="body" c={color.red} testID="company-error">
            {error}
          </Txt>
        ) : null}
      </View>

      <Sheet testID="state-sheet" visible={picking} onClose={() => setPicking(false)} title="State the crew works in">
        <View>
          {Object.entries(STATES).map(([code, name], i) => (
            <View key={code}>
              {i > 0 ? <Divider /> : null}
              <Row
                testID={`state-${code}`}
                title={name}
                right={draft.state === code ? <Check color={color.ink} size={22} strokeWidth={3} /> : undefined}
                onPress={() => {
                  change({ state: code });
                  setPicking(false);
                }}
              />
            </View>
          ))}
        </View>
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md },
  preview: { gap: 4, padding: space.md, backgroundColor: color.kaolin, borderRadius: 8 },
});
