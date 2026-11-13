import { Plus, Truck } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Button, Chips, Divider, EmptyState, Field, Page, Panel, Row, Sheet, Tag, Txt, UnitPlate } from '../../components/ui';
import { CATEGORY_LABEL, CATEGORY_ORDER, templateFor, templateItems } from '../../domain/templates';
import type { EquipmentCategory, EquipmentStatus } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, space, type Tone } from '../../theme/theme';
import { fmtMeter } from '../../util/format';

const STATUS: Record<EquipmentStatus, { label: string; tone: Tone; solid?: boolean }> = {
  ready: { label: 'Ready', tone: 'ok' },
  defect: { label: 'Defect reported', tone: 'warn' },
  out_of_service: { label: 'Out of service', tone: 'bo', solid: true },
};

/** The units people can pre-op and check out. Each type gets its own checklist. */
export function FleetScreen({ navigation }: ScreenProps<'Fleet'>) {
  const equipment = useStore((s) => s.equipment);
  const { addEquipment, removeEquipment, showToast } = useStore.getState();

  const [adding, setAdding] = useState(false);
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState<EquipmentCategory>('loader');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [meter, setMeter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const sorted = [...equipment].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.unit.localeCompare(b.unit, undefined, { numeric: true }),
  );
  const open = equipment.find((e) => e.id === openId);

  const save = () => {
    const result = addEquipment({ unit, category, make, model, meter: Number(meter.replace(/,/g, '')) || 0 });
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast(`Unit ${unit.trim().toUpperCase()} added to the fleet`);
    setUnit(''); setMake(''); setModel(''); setMeter(''); setError(null);
    setAdding(false);
  };

  return (
    <Page
      testID="fleet-screen"
      title="Fleet"
      sub={`${equipment.length} units`}
      onBack={navigation.goBack}
      footer={<Button testID="fleet-add" label="Add a unit" icon={Plus} kind="yellow" onPress={() => { setError(null); setAdding(true); }} />}
    >
      {sorted.length === 0 ? (
        <EmptyState icon={Truck} title="No units yet" body="Add the equipment the crew runs so they can pre-op it." />
      ) : (
        <Panel flush>
          {sorted.map((e, i) => {
            const status = STATUS[e.status];
            return (
              <View key={e.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`fleet-${e.unit}`}
                  left={<UnitPlate unit={e.unit} />}
                  title={`${e.make} ${e.model}`}
                  sub={`${CATEGORY_LABEL[e.category]}, ${fmtMeter(e.meter)} ${e.meterUnit}`}
                  below={<Tag label={status.label} tone={status.tone} solid={status.solid} />}
                  chevron
                  onPress={() => setOpenId(e.id)}
                />
              </View>
            );
          })}
        </Panel>
      )}

      <Sheet testID="fleet-sheet" visible={adding} onClose={() => setAdding(false)} title="Add a unit">
        <Field testID="fleet-unit" label="Unit number" value={unit} onChangeText={(v) => { setUnit(v); setError(null); }} autoCapitalize="characters" placeholder="L-16" error={error} />
        <View style={{ gap: 6 }}>
          <Txt v="smallStrong">Type of equipment</Txt>
          <Chips<EquipmentCategory> value={category} onChange={setCategory} options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
          <Txt v="small" c={color.silica}>Gets the {CATEGORY_LABEL[category].toLowerCase()} pre-op: {templateItems(templateFor(category)).length} checks.</Txt>
        </View>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}><Field testID="fleet-make" label="Make" value={make} onChangeText={setMake} autoCapitalize="words" placeholder="CAT" /></View>
          <View style={{ flex: 1 }}><Field testID="fleet-model" label="Model" value={model} onChangeText={setModel} autoCapitalize="characters" placeholder="980M" /></View>
        </View>
        <Field testID="fleet-meter" label={category === 'light_vehicle' ? 'Odometer now (miles)' : 'Hour meter now'} value={meter} onChangeText={setMeter} keyboardType="decimal-pad" placeholder="0" />
        <Button testID="fleet-save" label="Add to fleet" kind="ink" onPress={save} />
      </Sheet>

      <Sheet testID="unit-admin-sheet" visible={!!open} onClose={() => setOpenId(null)} title={open ? `${open.unit}, ${open.make} ${open.model}` : ''}>
        {open ? (
          <>
            <Txt v="body" c={color.inkSoft}>
              {CATEGORY_LABEL[open.category]}, meter {fmtMeter(open.meter)} {open.meterUnit}. Uses the {CATEGORY_LABEL[open.category].toLowerCase()} pre-op with {templateItems(templateFor(open.category)).length} checks.
            </Txt>
            <Txt v="small" c={color.silica}>Removing a unit takes it off the list people pick from. Its past pre-ops and requests stay on record.</Txt>
            <Button
              testID="fleet-remove"
              label="Remove from fleet"
              kind="red"
              onPress={() => {
                removeEquipment(open.id);
                showToast(`Unit ${open.unit} removed`, 'info');
                setOpenId(null);
              }}
            />
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
