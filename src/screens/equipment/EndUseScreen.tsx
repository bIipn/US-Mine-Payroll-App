import { Wrench } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { StandardRefs } from '../../components/Standards';
import { Button, CheckRow, Field, Page, Panel, Txt, UnitPlate } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDur, fmtMeter, fmtTime } from '../../util/format';
import { useNow } from '../../util/hooks';

/** End use of a unit: its hours at the end, the gallons added, and how it was left. */
export function EndUseScreen({ navigation, route }: ScreenProps<'EndUse'>) {
  const now = useNow(30_000);
  const log = useStore((s) => s.opLogs.find((l) => l.id === route.params.logId));
  const unit = useStore((s) => s.equipment.find((e) => e.id === log?.equipmentId));
  const { endUse, showToast } = useStore.getState();

  const [meter, setMeter] = useState('');
  const [fuel, setFuel] = useState('');
  const [notes, setNotes] = useState('');
  const [parked, setParked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!log || !unit) return null;

  const meterValue = Number(meter.replace(/,/g, ''));
  const fuelValue = Number(fuel);
  const used = Number.isFinite(meterValue) && meter.trim() ? meterValue - log.startMeter : null;

  const submit = () => {
    if (!meter.trim() || !Number.isFinite(meterValue)) {
      setError('Enter the reading off the machine.');
      return;
    }
    const result = endUse(log.id, {
      endMeter: meterValue,
      fuelGal: fuel.trim() && Number.isFinite(fuelValue) ? fuelValue : undefined,
      notes: notes.trim() || undefined,
      parkedSafely: parked,
    });
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast(`${unit.unit} checked back in`);
    navigation.goBack();
  };

  return (
    <Page
      testID="end-use-screen"
      title={`End use of ${unit.unit}`}
      sub={`${unit.make} ${unit.model}`}
      onBack={navigation.goBack}
      footer={<Button testID="end-use-submit" label="End use" kind="ink" disabled={!parked} onPress={submit} />}
    >
      <Panel>
        <View style={styles.head}>
          <UnitPlate unit={unit.unit} size="lg" />
          <View style={{ flex: 1 }}>
            <Txt v="strong">Checked out at {fmtTime(log.startAt)}</Txt>
            <Txt v="small" c={color.silica}>
              {fmtDur(now - log.startAt)} ago, {unit.meterUnit === 'mi' ? 'odometer' : 'equipment hours'} {fmtMeter(log.startMeter)} at the start
            </Txt>
          </View>
        </View>
      </Panel>

      <Field
        testID="end-meter"
        label={unit.meterUnit === 'mi' ? 'Odometer at the end (miles)' : 'Equipment hours at the end'}
        value={meter}
        onChangeText={(text) => { setMeter(text); setError(null); }}
        keyboardType="decimal-pad"
        placeholder={fmtMeter(log.startMeter)}
        error={error}
        hint={used != null && used >= 0 ? `${fmtMeter(used)} ${unit.meterUnit} this use` : `Started at ${fmtMeter(log.startMeter)}`}
      />
      <Field testID="end-fuel" label="Gallons of fuel added" value={fuel} onChangeText={setFuel} keyboardType="decimal-pad" placeholder="0" hint="Leave blank if you did not fuel. It goes on the Fuel line of your card." />
      <Field testID="end-notes" label="Anything the next operator should know?" value={notes} onChangeText={setNotes} multiline placeholder="Optional" />

      <Panel>
        <CheckRow
          testID="parked-safe"
          label="Parked safe"
          sub="Bucket, blade or bed on the ground. Parking brake set. Wheels chocked or turned into the bank on a grade."
          value={parked}
          onChange={setParked}
        />
        <StandardRefs cfr="56.14207" />
      </Panel>

      <Button
        testID="end-report"
        label="Something is wrong with this unit"
        icon={Wrench}
        kind="quiet"
        onPress={() => navigation.navigate('MrfForm', { equipmentId: unit.id })}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
