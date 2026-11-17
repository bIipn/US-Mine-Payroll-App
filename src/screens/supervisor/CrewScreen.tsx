import { useNavigation } from '@react-navigation/native';
import { CalendarClock, ClipboardCheck, Factory, FileSpreadsheet, ListChecks, MapPin, Siren, Truck, Users, UserCheck, Wrench } from '../../components/icons';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Divider, Panel, Row, Stat, Tag, TopBar, Txt, UnitPlate } from '../../components/ui';
import { foundLine, openFindings } from '../../domain/areaExam';
import { keepsTime } from '../../domain/company';
import { employeeName, useRules, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtDateLong, fmtRelativeDay, fmtTime, fullName, initials, peopleCount, startOfDay } from '../../util/format';
import { useNow } from '../../util/hooks';
import { crewNow, missingClockOuts } from './crewStatus';

/** The supervisor's board: who is here, who needs a lunch, what is broken. */
export function CrewScreen() {
  const navigation = useNavigation();
  const now = useNow(15_000);
  const employees = useStore((s) => s.employees);
  const shifts = useStore((s) => s.shifts);
  const equipment = useStore((s) => s.equipment);
  const mrfs = useStore((s) => s.mrfs);
  const exams = useStore((s) => s.exams);
  const sheets = useStore((s) => s.areaSheets);
  // A company that uses the app for the safety forms only keeps no time: the board is safety alone.
  const time = useStore((s) => keepsTime(s.settings.company));
  const noSite = useStore((s) => !s.settings.site);

  const rules = useRules();
  const hasDeadline = time && rules.meal?.startByMs != null;
  const crew = useMemo(() => crewNow(employees, shifts, now, rules), [employees, shifts, now, rules]);
  const working = crew.filter((c) => c.presence === 'working').length;
  const atLunch = crew.filter((c) => c.presence === 'lunch').length;
  const alerts = time ? crew.filter((c) => c.urgency >= 3) : [];
  const missing = time ? missingClockOuts(shifts, now) : [];
  const openMrfs = mrfs.filter((m) => m.status !== 'completed');
  const safetyMrfs = openMrfs.filter((m) => m.taggedOut);
  const outOfService = equipment.filter((e) => e.status === 'out_of_service').length;
  const conditions = useMemo(() => openFindings(exams), [exams]);
  const madeToday = new Set(exams.filter((x) => x.submittedAt >= startOfDay(now)).map((x) => x.sheetId));
  const areas = sheets.filter((s) => s.active);
  // Only the areas still on the list count, so a sheet taken off it cannot push the tally past the total.
  const examinedToday = areas.filter((s) => madeToday.has(s.id)).length;
  const unset = time && noSite;
  const nothing = !unset && alerts.length === 0 && missing.length === 0 && safetyMrfs.length === 0 && conditions.length === 0;

  return (
    <View style={styles.root}>
      <TopBar title="Crew" sub={fmtDateLong(now)} />
      <ScrollView testID="crew-screen" contentContainerStyle={styles.content}>
        <View style={styles.stats}>
          {time ? <Stat value={String(working)} label="Working" /> : null}
          {time ? <Stat value={String(atLunch)} label="At lunch" /> : null}
          {/* Only where the state sets a time a lunch must start by is there a lunch to be due. */}
          {hasDeadline ? <Stat value={String(alerts.length)} label="Lunch due" tone={alerts.length ? 'bo' : undefined} /> : null}
          <Stat value={String(outOfService)} label="Units down" tone={outOfService ? 'bo' : undefined} />
          {time ? null : <Stat value={`${examinedToday}/${areas.length}`} label="Areas examined" />}
        </View>

        <Panel title="Needs you now" flush>
          {nothing ? (
            <View style={{ padding: space.lg }}>
              <Txt v="body" c={color.silica}>
                {time
                  ? `Nothing is waiting on you. ${hasDeadline ? 'Lunch deadlines, missing' : 'Missing'} clock-outs, red-tagged units and open work-area conditions show up here.`
                  : 'Nothing is waiting on you. Red-tagged units and open work-area conditions show up here.'}
              </Txt>
            </View>
          ) : null}
          {unset ? (
            <Row
              testID="alert-no-site"
              left={<MapPin color={color.red} size={28} />}
              title="The mine boundary is not set"
              sub="No one can clock in until it is. Put the pin on the mine."
              right={<Tag label="Set it" tone="bo" solid />}
              onPress={() => navigation.navigate('Site')}
            />
          ) : null}
          {alerts.map((line, i) => (
            <View key={line.employee.id}>
              {i > 0 || unset ? <Divider inset={space.lg} /> : null}
              <Row
                testID={`alert-${line.employee.id}`}
                left={<Avatar initials={initials(line.employee.firstName, line.employee.lastName)} tone={line.tone} />}
                title={fullName(line.employee)}
                sub={line.shift ? `In at ${fmtTime(line.shift.clockIn.at)}` : undefined}
                right={<Tag label={line.label} tone={line.tone} solid={line.solid} />}
                onPress={() => line.shift && navigation.navigate('ShiftDetail', { shiftId: line.shift.id })}
              />
            </View>
          ))}
          {missing.map((shift) => (
            <View key={shift.id}>
              <Divider inset={space.lg} />
              <Row
                testID={`missing-${shift.employeeId}`}
                left={<CalendarClock color={color.red} size={28} />}
                title={employeeName(employees, shift.employeeId)}
                sub={`${fmtDate(shift.clockIn.at)} has no clock-out. Set the time so it can be paid.`}
                right={<Tag label="Fix" tone="bo" solid />}
                onPress={() => navigation.navigate('ShiftDetail', { shiftId: shift.id })}
              />
            </View>
          ))}
          {safetyMrfs.map((mrf) => {
            const unit = equipment.find((e) => e.id === mrf.equipmentId);
            return (
              <View key={mrf.id}>
                <Divider inset={space.lg} />
                <Row
                  testID={`safety-mrf-${mrf.number}`}
                  left={unit ? <UnitPlate unit={unit.unit} /> : undefined}
                  title={`Request #${mrf.number}, red tagged`}
                  sub={mrf.description}
                  below={<Tag label={mrf.status === 'open' ? 'Open' : 'In progress'} tone={mrf.status === 'open' ? 'bo' : 'warn'} />}
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: mrf.id })}
                />
              </View>
            );
          })}
          {conditions.slice(0, 5).map((f) => (
            <View key={`${f.examId}-${f.key}`}>
              <Divider inset={space.lg} />
              <Row
                testID={`condition-${f.key}`}
                left={f.danger ? <Siren color={color.red} size={28} /> : <Factory color={color.red} size={28} />}
                title={`${f.area}: ${f.label}`}
                sub={foundLine(f.note ?? f.where, fmtRelativeDay(f.foundAt, now).toLowerCase())}
                below={<Tag label={f.danger ? 'Danger' : f.mrfId ? 'With maintenance' : 'Open'} tone="bo" solid={f.danger} />}
                onPress={() => navigation.navigate('AreaExamDetail', { examId: f.examId })}
              />
            </View>
          ))}
          {conditions.length > 5 ? (
            <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
              <Txt v="small" c={color.silica}>And {conditions.length - 5} more open in the work areas.</Txt>
            </View>
          ) : null}
        </Panel>

        {time ? (
          <Panel title="Time and payroll" flush>
            <Row testID="go-onsite" left={<UserCheck color={color.ink} size={24} />} title="Who is on site" sub={`${working + atLunch} of ${crew.length} here now`} chevron onPress={() => navigation.navigate('OnSite')} />
            <Divider inset={space.lg} />
            <Row testID="go-timelogs" left={<CalendarClock color={color.ink} size={24} />} title="Time log" sub="Arrivals, lunches and departures by day" chevron onPress={() => navigation.navigate('TimeLogs')} />
            <Divider inset={space.lg} />
            <Row testID="go-payroll" left={<FileSpreadsheet color={color.ink} size={24} />} title="Payroll" sub="Hours by employee, ready for Excel" chevron onPress={() => navigation.navigate('Payroll')} />
          </Panel>
        ) : null}

        <Panel title="Safety and equipment" flush>
          <Row
            testID="go-safety"
            left={<ClipboardCheck color={color.ink} size={24} />}
            title="Checklists and exams"
            sub={`Equipment cards and pre shift exams. ${examinedToday} of ${areas.length} ${areas.length === 1 ? 'area' : 'areas'} examined today`}
            chevron
            onPress={() => navigation.navigate('SafetyLog')}
          />
          <Divider inset={space.lg} />
          <Row
            testID="go-mrfs"
            left={<Wrench color={color.ink} size={24} />}
            title="Maintenance requests"
            sub={openMrfs.length ? `${openMrfs.length} open` : 'None open'}
            right={openMrfs.length ? <Tag label={String(openMrfs.length)} tone="bo" solid /> : undefined}
            chevron
            onPress={() => navigation.navigate('MrfQueue')}
          />
          <Divider inset={space.lg} />
          <Row testID="go-fleet" left={<Truck color={color.ink} size={24} />} title="Fleet" sub={`${equipment.length} units`} chevron onPress={() => navigation.navigate('Fleet')} />
        </Panel>

        <Panel title="Setup" flush>
          <Row testID="go-roster" left={<Users color={color.ink} size={24} />} title="Roster" sub={`${peopleCount(employees.filter((e) => e.active).length)} can sign in`} chevron onPress={() => navigation.navigate('Roster')} />
          <Divider inset={space.lg} />
          <Row testID="go-sheets" left={<ListChecks color={color.ink} size={24} />} title="Area sheets" sub={`${areas.length} work ${areas.length === 1 ? 'area' : 'areas'} with a pre shift exam sheet`} chevron onPress={() => navigation.navigate('AreaSheets')} />
          {time ? <Divider inset={space.lg} /> : null}
          {time ? (
            <Row testID="go-site" left={<MapPin color={color.ink} size={24} />} title="Mine boundary" sub={noSite ? 'Not set: no one can clock in yet' : 'The area people can clock in from'} chevron onPress={() => navigation.navigate('Site')} />
          ) : null}
        </Panel>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.xl },
  stats: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
});
