import { useNavigation } from '@react-navigation/native';
import React from 'react';

import { Panel, Row, UnitPlate } from '../../components/ui';
import { unitsCheckedOut } from '../../domain/fleet';
import { useStore } from '../../store/useStore';
import { fmtTime } from '../../util/format';

/**
 * "You have checked out": the units a person has checked out on this phone (unitsCheckedOut), each opening
 * End use. The Clock screen lists them all. The Checklists screen lists the fleet, so it lists here only
 * the units taken out of the fleet while they were checked out (`takenOutOnly`), which the phone keeps
 * until their use is ended: a company with the time clock off has no Clock screen, and signing out of the
 * phone waits until every unit is checked back in.
 */
export function CheckedOutUnits({ employeeId, takenOutOnly = false }: { employeeId: string; takenOutOnly?: boolean }) {
  const navigation = useNavigation();
  const equipment = useStore((s) => s.equipment);
  const opLogs = useStore((s) => s.opLogs);
  const gone = useStore((s) => s.receiving?.gone);
  const units = unitsCheckedOut(employeeId, opLogs, equipment, gone).filter((u) => !takenOutOnly || u.takenOut);
  if (!units.length) return null;
  return (
    <Panel title="You have checked out" flush>
      {units.map(({ log, unit, takenOut }) => (
        <Row
          key={log.id}
          testID={`in-use-${unit.unit}`}
          left={<UnitPlate unit={unit.unit} />}
          title={`${unit.make} ${unit.model}`}
          sub={`Since ${fmtTime(log.startAt)}.${takenOut ? ' Taken out of the fleet.' : ''} Tap to end use.`}
          chevron
          onPress={() => navigation.navigate('EndUse', { logId: log.id })}
        />
      ))}
    </Panel>
  );
}
