import { useNavigation } from '@react-navigation/native';
import { CalendarClock, ClipboardCheck, FileSpreadsheet, MapPin, Truck, Users, UserCheck, Wrench } from '../../components/icons';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Divider, Panel, Row, Stat, Tag, TopBar, Txt, UnitPlate } from '../../components/ui';
import { employeeName, useStore } from '../../store/useStore';
import { color, radius, space } from '../../theme/theme';
import { fmtDate, fmtDateLong, fmtTime, fullName, initials } from '../../util/format';
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

  const crew = useMemo(() => crewNow(employees, shifts, now), [employees, shifts, now]);
  const working = crew.filter((c) => c.presence === 'working').length;
  const atLunch = crew.filter((c) => c.presence === 'lunch').length;
  const alerts = crew.filter((c) => c.urgency >= 3);
  const missing = missingClockOuts(shifts, now);
  const openMrfs = mrfs.filter((m) => m.status !== 'completed');
  const safetyMrfs = openMrfs.filter((m) => m.taggedOut);
  const outOfService = equipment.filter((e) => e.status === 'out_of_service').length;
  const nothing = alerts.length === 0 && missing.length === 0 && safetyMrfs.length === 0;

  return (
    <View style={styles.root}>
      <TopBar title="Crew" sub={fmtDateLong(now)} />
      <ScrollView testID="crew-screen" contentContainerStyle={styles.content}>
        <View style={styles.stats}>
          <Stat value={String(working)} label="Working" />
          <Stat value={String(atLunch)} label="At lunch" />
          <Stat value={String(alerts.length)} label="Lunch due" tone={alerts.length ? 'bo' : undefined} />
          <Stat value={String(outOfService)} label="Units down" tone={outOfService ? 'bo' : undefined} />
        </View>

        <Panel title="Needs you now" flush>
          {nothing ? (
            <View style={{ padding: space.lg }}>
              <Txt v="body" c={color.silica}>Nothing is waiting on you. Lunch deadlines, missing clock-outs and tagged-out units show up here.</Txt>
            </View>
          ) : null}
          {alerts.map((line, i) => (
            <View key={line.employee.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
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
                  title={`MRF #${mrf.number}, tagged out`}
                  sub={mrf.description}
                  right={<Tag label={mrf.status === 'open' ? 'Open' : 'In progress'} tone={mrf.status === 'open' ? 'bo' : 'warn'} />}
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: mrf.id })}
                />
              </View>
            );
          })}
        </Panel>

        <Panel title="Time and payroll" flush>
          <Row testID="go-onsite" left={<UserCheck color={color.ink} size={24} />} title="Who is on site" sub={`${working + atLunch} of ${crew.length} here now`} chevron onPress={() => navigation.navigate('OnSite')} />
          <Divider inset={space.lg} />
          <Row testID="go-timelogs" left={<CalendarClock color={color.ink} size={24} />} title="Time log" sub="Arrivals, lunches and departures by day" chevron onPress={() => navigation.navigate('TimeLogs')} />
          <Divider inset={space.lg} />
          <Row testID="go-payroll" left={<FileSpreadsheet color={color.ink} size={24} />} title="Payroll" sub="Hours by employee, ready for Excel" chevron onPress={() => navigation.navigate('Payroll')} />
        </Panel>

        <Panel title="Safety and equipment" flush>
          <Row testID="go-safety" left={<ClipboardCheck color={color.ink} size={24} />} title="Pre-ops and equipment use" sub="Who ran what, and what they found" chevron onPress={() => navigation.navigate('SafetyLog')} />
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
          <Row testID="go-roster" left={<Users color={color.ink} size={24} />} title="Roster" sub={`${employees.filter((e) => e.active).length} people can sign in`} chevron onPress={() => navigation.navigate('Roster')} />
          <Divider inset={space.lg} />
          <Row testID="go-site" left={<MapPin color={color.ink} size={24} />} title="Mine boundary" sub="The area people can clock in from" chevron onPress={() => navigation.navigate('Site')} />
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
