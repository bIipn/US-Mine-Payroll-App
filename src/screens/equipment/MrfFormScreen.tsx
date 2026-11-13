import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Divider, Field, Notice, Page, Panel, Row, Segmented, Toggle, Txt, UnitPlate } from '../../components/ui';
import { CATEGORY_LABEL } from '../../domain/templates';
import type { MrfPriority } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { inspectionHasHazard, mrfItemsFromInspection, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtMeter } from '../../util/format';

/** Maintenance Request Form. Pre-filled when it follows a Bad Order on a pre-op. */
export function MrfFormScreen({ navigation, route }: ScreenProps<'MrfForm'>) {
  const equipment = useStore((s) => s.equipment);
  const inspection = useStore((s) => s.inspections.find((i) => i.id === route.params.inspectionId));
  const { createMrf, showToast } = useStore.getState();

  const [unitId, setUnitId] = useState(route.params.equipmentId ?? inspection?.equipmentId);
  const unit = equipment.find((e) => e.id === unitId);
  const items = inspection && unit ? mrfItemsFromInspection(inspection, unit) : [];
  const forced = !!inspection && !!unit && inspectionHasHazard(inspection, unit);

  const [priority, setPriority] = useState<MrfPriority>(forced ? 'safety' : inspection ? 'high' : 'routine');
  const [description, setDescription] = useState(items.map((i) => (i.note ? `${i.label}: ${i.note}` : i.label)).join('\n'));
  const [location, setLocation] = useState('');
  const [meter, setMeter] = useState(inspection ? String(inspection.meter) : unit ? String(unit.meter) : '');
  const [tagged, setTagged] = useState(forced);
  const [error, setError] = useState<string | null>(null);

  const taggedOut = priority === 'safety' || tagged;

  const submit = () => {
    if (!unit) return;
    const meterValue = Number(meter.replace(/,/g, ''));
    const result = createMrf({
      equipmentId: unit.id,
      priority,
      description,
      items,
      meter: Number.isFinite(meterValue) && meter.trim() ? meterValue : undefined,
      location,
      taggedOut,
      inspectionId: inspection?.id,
    });
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast(`MRF #${result.mrf.number} sent to maintenance`);
    if (inspection) navigation.goBack();
    else navigation.replace('MrfDetail', { mrfId: result.mrf.id });
  };

  return (
    <Page
      testID="mrf-form"
      title="Maintenance request"
      sub="MRF"
      onBack={navigation.goBack}
      footer={unit ? <Button testID="mrf-submit" label="Send maintenance request" kind={taggedOut ? 'red' : 'yellow'} onPress={submit} /> : undefined}
    >
      {!unit ? (
        <Panel title="Which unit?" flush>
          {equipment.map((e, i) => (
            <View key={e.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row left={<UnitPlate unit={e.unit} />} title={`${e.make} ${e.model}`} sub={CATEGORY_LABEL[e.category]} onPress={() => { setUnitId(e.id); setMeter(String(e.meter)); }} />
            </View>
          ))}
        </Panel>
      ) : (
        <>
          <Panel>
            <View style={styles.head}>
              <UnitPlate unit={unit.unit} size="lg" />
              <View style={{ flex: 1 }}>
                <Txt v="strong">{unit.make} {unit.model}</Txt>
                <Txt v="small" c={color.silica}>{CATEGORY_LABEL[unit.category]}, {fmtMeter(unit.meter)} {unit.meterUnit}</Txt>
              </View>
            </View>
          </Panel>

          {forced ? (
            <Notice tone="bo" title="Safety defect. The unit stays tagged out." body="It cannot be checked out again until maintenance completes this request." />
          ) : null}

          <Field
            testID="mrf-description"
            label="What is wrong?"
            placeholder="Describe the problem and when it happens"
            value={description}
            onChangeText={(text) => {
              setDescription(text);
              setError(null);
            }}
            multiline
            error={error}
          />

          <View style={{ gap: 6 }}>
            <Txt v="smallStrong">How urgent is it?</Txt>
            <Segmented<MrfPriority>
              testID="mrf-priority"
              value={priority}
              onChange={(next) => !forced && setPriority(next)}
              options={[
                { value: 'safety', label: 'Safety' },
                { value: 'high', label: 'High' },
                { value: 'routine', label: 'Routine' },
              ]}
            />
            <Txt v="small" c={color.silica}>
              {priority === 'safety'
                ? 'Unsafe to run. The unit is taken out of service.'
                : priority === 'high'
                  ? 'Needs fixing soon, but the unit is safe to run.'
                  : 'Can wait for the next scheduled service.'}
            </Txt>
          </View>

          {priority !== 'safety' ? (
            <Panel flush>
              <Toggle
                testID="mrf-tagged"
                label="Tag it out"
                sub="Take the unit out of service until this is fixed."
                value={tagged}
                onChange={setTagged}
              />
            </Panel>
          ) : null}

          <Field
            testID="mrf-location"
            label="Where is the unit now?"
            placeholder="Bad-order row, shop, pit entrance"
            value={location}
            onChangeText={setLocation}
          />
          <Field
            testID="mrf-meter"
            label={unit.meterUnit === 'mi' ? 'Odometer (miles)' : 'Hour meter'}
            value={meter}
            onChangeText={setMeter}
            keyboardType="decimal-pad"
          />
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
