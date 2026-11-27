import { Truck, X } from '../../components/icons';
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Divider, Field, IconButton, Notice, Page, Panel, Row, Segmented, Sheet, Toggle, Txt, UnitPlate } from '../../components/ui';
import { examFindings, ON_THE_SHEET } from '../../domain/areaExam';
import { meterText, parseReading, readingProblem, readingText } from '../../domain/reading';
import { CATEGORY_LABEL } from '../../domain/templates';
import type { MrfPriority } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { useDecimalMark } from '../../services/decimalMark';
import { haptic } from '../../services/haptics';
import { alreadyOnRequest, inspectionHasHazard, mrfItemsFromInspection, useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDateTime, fullName } from '../../util/format';

/**
 * Maintenance Request, in the order of the paper form: by, date, location and
 * problem. It can be for a fleet unit or for anything else in the plant, and it
 * comes pre-filled when it follows a Bad Order on a checklist or an exam.
 */
export function MrfFormScreen({ navigation, route }: ScreenProps<'MrfForm'>) {
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const inspection = useStore((s) => s.inspections.find((i) => i.id === route.params.inspectionId));
  const exam = useStore((s) => s.exams.find((x) => x.id === route.params.examId));
  const { createMrf, showToast } = useStore.getState();
  // The phone's own decimal mark, which its number pad types, and the reading is read and written with.
  const mark = useDecimalMark();

  const finding = exam ? examFindings(exam).find((f) => f.key === route.params.findingKey) : undefined;
  const [unitId, setUnitId] = useState(route.params.equipmentId ?? inspection?.equipmentId);
  const [picking, setPicking] = useState(false);
  const unit = equipment.find((e) => e.id === unitId);
  const items = inspection && unit ? mrfItemsFromInspection(inspection, unit) : [];
  const forced = !!inspection && !!unit && inspectionHasHazard(inspection, unit);

  const [priority, setPriority] = useState<MrfPriority>(forced || finding?.danger ? 'safety' : inspection || finding ? 'high' : 'routine');
  const [description, setDescription] = useState(
    finding
      ? // The column it was found in goes first. The conditions page and a one-column sheet have none to name.
        `${finding.where === 'Conditions' || finding.where === ON_THE_SHEET ? '' : `${finding.where}: `}${finding.note ?? ''}`
      : items.map((i) => (i.note ? `${i.label}: ${i.note}` : i.label)).join('\n'),
  );
  const [location, setLocation] = useState(route.params.location ?? '');
  const [meter, setMeter] = useState(inspection ? readingText(inspection.meter, mark) : unit ? readingText(unit.meter, mark) : '');
  const [tagged, setTagged] = useState(forced);
  const [error, setError] = useState<{ field: 'location' | 'problem' | 'meter'; text: string } | null>(null);

  const taggedOut = !!unit && (priority === 'safety' || tagged);
  const sent = useRef(false);

  const submit = () => {
    // One request for one tap on Send, however many land before the screen has gone.
    if (sent.current) return;
    if (!unit && !location.trim()) {
      haptic.error();
      setError({ field: 'location', text: 'Say where the problem is, or pick the unit it is on.' });
      return;
    }
    // Read as the store reads it (parseReading): left blank there is none, and one an Android number pad let
    // a minus sign into is turned back, not dropped without a word.
    const meterValue = unit ? parseReading(meter, mark) : undefined;
    if (meterValue != null && Number.isNaN(meterValue)) {
      haptic.error();
      setError({ field: 'meter', text: readingProblem(mark) });
      return;
    }
    const result = createMrf({
      equipmentId: unit?.id,
      location,
      priority,
      description,
      items,
      meter: meterValue,
      taggedOut,
      inspectionId: inspection?.id,
      examId: finding ? exam?.id : undefined,
      findingKey: finding?.key,
    });
    if (!result.ok) {
      haptic.error();
      setError({ field: result.error === readingProblem(mark) ? 'meter' : 'problem', text: result.error });
      return;
    }
    sent.current = true;
    haptic.success();
    // A checklist that found what the person's own request, still open, already says goes on that request.
    showToast(
      inspection && result.mrf.inspectionId !== inspection.id
        ? alreadyOnRequest(result.mrf.number)
        : `Maintenance request #${result.mrf.number} sent`,
    );
    if (inspection || finding) navigation.goBack();
    else navigation.replace('MrfDetail', { mrfId: result.mrf.id });
  };

  return (
    <Page
      testID="mrf-form"
      title="Maintenance request"
      sub={me ? `By ${fullName(me)}, ${fmtDateTime(Date.now())}` : undefined}
      onBack={navigation.goBack}
      footer={<Button testID="mrf-submit" label="Send maintenance request" kind={taggedOut ? 'red' : 'yellow'} onPress={submit} />}
    >
      {unit ? (
        <Panel>
          <View style={styles.head}>
            <UnitPlate unit={unit.unit} size="lg" />
            <View style={{ flex: 1 }}>
              <Txt v="strong">{unit.make} {unit.model}</Txt>
              {/* The unit's reading as the box below has it, with the phone's mark. */}
              <Txt v="small" c={color.silica}>{CATEGORY_LABEL[unit.category]}, {meterText(unit.meter, mark)} {unit.meterUnit}</Txt>
            </View>
            {!inspection ? (
              <IconButton
                icon={X}
                label="This is not about a unit"
                testID="mrf-clear-unit"
                bg={color.grayTint}
                onPress={() => {
                  setUnitId(undefined);
                  setTagged(false);
                }}
              />
            ) : null}
          </View>
        </Panel>
      ) : finding ? (
        <Notice tone="info" title={`From the ${exam?.area} pre shift exam`} body="When this request is completed, the date goes on the exam as the date it was fixed." />
      ) : (
        <Button testID="mrf-pick-unit" label="It is on a unit in the fleet" icon={Truck} kind="quiet" onPress={() => setPicking(true)} />
      )}

      {forced ? (
        <Notice tone="bo" title="Safety defect. The unit stays red tagged." body="It cannot be checked out again until maintenance completes this request." />
      ) : null}

      <Field
        testID="mrf-location"
        label={unit ? 'Location: where is the unit now?' : 'Location'}
        placeholder={unit ? 'Bad-order row, shop, pit entrance' : 'The area, and the pump, belt or door it is on'}
        value={location}
        onChangeText={(text) => {
          setLocation(text);
          setError(null);
        }}
        error={error?.field === 'location' ? error.text : null}
      />

      <Field
        testID="mrf-description"
        label="Problem"
        placeholder="Describe the problem and when it happens"
        value={description}
        onChangeText={(text) => {
          setDescription(text);
          setError(null);
        }}
        multiline
        error={error?.field === 'problem' ? error.text : null}
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
            ? unit
              ? 'Unsafe to run. The unit is taken out of service.'
              : 'Someone could get hurt. It goes to the top of the list.'
            : priority === 'high'
              ? 'Needs fixing soon, but it is safe to keep working.'
              : 'Can wait for the next scheduled service.'}
        </Txt>
      </View>

      {unit && priority !== 'safety' ? (
        <Panel flush>
          <Toggle
            testID="mrf-tagged"
            label="Red tag it"
            sub="Take the unit out of service until this is fixed."
            value={tagged}
            onChange={setTagged}
          />
        </Panel>
      ) : null}

      {unit ? (
        <Field
          testID="mrf-meter"
          label={unit.meterUnit === 'mi' ? 'Odometer (miles)' : 'Equipment hours'}
          value={meter}
          onChangeText={(text) => {
            setMeter(text);
            setError(null);
          }}
          keyboardType="decimal-pad"
          error={error?.field === 'meter' ? error.text : null}
        />
      ) : null}

      <Sheet testID="mrf-unit-sheet" visible={picking} onClose={() => setPicking(false)} title="Which unit?">
        <Panel flush>
          {equipment.map((e, i) => (
            <View key={e.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row
                testID={`mrf-unit-${e.unit}`}
                left={<UnitPlate unit={e.unit} />}
                title={`${e.make} ${e.model}`}
                sub={CATEGORY_LABEL[e.category]}
                onPress={() => {
                  setUnitId(e.id);
                  setMeter(readingText(e.meter, mark));
                  setError(null);
                  setPicking(false);
                }}
              />
            </View>
          ))}
        </Panel>
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
