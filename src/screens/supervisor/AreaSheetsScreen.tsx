import { Factory, Plus } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Button, Divider, EmptyState, Field, Notice, Page, Panel, Row, Sheet, Tag, Toggle, Txt } from '../../components/ui';
import { openFindings } from '../../domain/areaExam';
import type { AreaSheet } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';

/**
 * The pre shift exam sheet of each work area. Every area has its own lines;
 * the conditions page is the same for all of them. A new paper sheet is typed
 * in here, one line of the sheet to a line.
 */
export function AreaSheetsScreen({ navigation }: ScreenProps<'AreaSheets'>) {
  const sheets = useStore((s) => s.areaSheets);
  const exams = useStore((s) => s.exams);
  const { addAreaSheet, updateAreaSheet, setAreaSheetActive, showToast } = useStore.getState();

  /** `null` is closed, `'new'` a blank sheet, otherwise the sheet being changed. */
  const [editing, setEditing] = useState<AreaSheet | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [rows, setRows] = useState('');
  /** One OK/BO column for each line, in place of guarding, electrical and safe access. */
  const [single, setSingle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = sheets.filter((s) => s.active);
  const removed = sheets.filter((s) => !s.active);
  const current = editing && editing !== 'new' ? editing : undefined;
  const lineCount = rows.split('\n').filter((line) => line.trim()).length;

  const open = (sheet: AreaSheet | 'new') => {
    setTitle(sheet === 'new' ? '' : sheet.title);
    setRows(sheet === 'new' ? '' : sheet.rows.map((r) => r.label).join('\n'));
    setSingle(sheet === 'new' ? false : !!sheet.single);
    setError(null);
    setEditing(sheet);
  };

  const save = () => {
    // The toast gives the name as it was saved: a heading typed as "North Plant areas:" is kept as "North Plant".
    let saved: string | undefined;
    let problem: string | undefined;
    if (current) {
      const result = updateAreaSheet(current.id, title, rows, single);
      if (result.ok) saved = useStore.getState().areaSheets.find((s) => s.id === current.id)?.title;
      else problem = result.error;
    } else {
      const result = addAreaSheet(title, rows, single);
      if (result.ok) saved = result.sheet.title;
      else problem = result.error;
    }
    if (problem != null) {
      haptic.error();
      setError(problem);
      return;
    }
    haptic.success();
    showToast(`${saved ?? title.trim()} sheet ${current ? 'saved' : 'added'}`);
    setEditing(null);
  };
  /** Conditions found in the area being changed that have no date fixed yet. */
  const openHere = current ? openFindings(exams, current.id).length : 0;

  return (
    <Page
      testID="area-sheets-screen"
      title="Area sheets"
      sub="The pre shift exam sheet for each work area"
      onBack={navigation.goBack}
      footer={<Button testID="sheet-add" label="Add an area sheet" icon={Plus} kind="yellow" onPress={() => open('new')} />}
    >
      <Txt v="body" c={color.inkSoft}>
        Each area has its own lines. Most sheets check each line for guarding, electrical and safe access; some have one OK/BO column instead. The 20 conditions on the second page are the same for every area.
      </Txt>

      {active.length === 0 ? (
        <EmptyState icon={Factory} title="No area sheets yet" body="Add one for each work area. Type its lines in from the paper sheet." />
      ) : (
        <Panel flush>
          {active.map((sheet, i) => {
            const made = exams.filter((x) => x.sheetId === sheet.id).length;
            return (
              <View key={sheet.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  testID={`sheet-${sheet.id}`}
                  left={<Factory color={color.ink} size={24} />}
                  title={sheet.title}
                  sub={`${sheet.rows.length} ${sheet.rows.length === 1 ? 'line' : 'lines'} of its own${sheet.single ? ' in one OK/BO column' : ''}, plus the 20 conditions. ${made} ${made === 1 ? 'exam' : 'exams'} on record.`}
                  chevron
                  onPress={() => open(sheet)}
                />
              </View>
            );
          })}
        </Panel>
      )}

      {removed.length > 0 ? (
        <Panel title="Taken off the list" flush>
          {removed.map((sheet, i) => (
            <View key={sheet.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row
                testID={`sheet-back-${sheet.id}`}
                title={sheet.title}
                sub="Its exams stay on record. Tap to put it back."
                right={<Tag label="Off" tone="neutral" />}
                onPress={() => {
                  setAreaSheetActive(sheet.id, true);
                  showToast(`${sheet.title} is back on the list`);
                }}
              />
            </View>
          ))}
        </Panel>
      ) : null}

      <Sheet testID="sheet-editor" visible={editing != null} onClose={() => setEditing(null)} title={current ? 'Change the sheet' : 'Add an area sheet'}>
        <Field
          testID="sheet-title"
          label="Work area"
          placeholder="The name printed at the top of the sheet"
          value={title}
          onChangeText={(text) => { setTitle(text); setError(null); }}
          autoCapitalize="words"
          error={error}
        />
        <Field
          testID="sheet-rows"
          label="Lines of the sheet"
          placeholder={'One line for each line of the paper sheet'}
          value={rows}
          onChangeText={setRows}
          multiline
          autoCapitalize="characters"
          autoCorrect={false}
          hint={`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}. Type each the way it is printed. An area can start with none and still get the conditions page.`}
        />
        <Toggle
          testID="sheet-single"
          label="One OK/BO column"
          sub="For a sheet that marks each line OK or BO once, with no guarding, electrical and safe access columns."
          value={single}
          onChange={setSingle}
        />
        {current ? (
          <Txt v="small" c={color.silica}>Exams already signed keep the lines and the columns they were made on.</Txt>
        ) : null}
        <Button testID="sheet-save" label={current ? 'Save the sheet' : 'Add the sheet'} kind="ink" onPress={save} />
        {current && openHere > 0 ? (
          <View testID="sheet-open-warning">
            <Notice
              tone="bo"
              title={openHere === 1 ? 'One condition is still open in this area' : `${openHere} conditions are still open in this area`}
              body="Off the list, the crew no longer sees the area or what is open in it. It stays on the Crew board until its date fixed is recorded."
            />
          </View>
        ) : null}
        {current ? (
          <Button
            testID="sheet-remove"
            label="Take it off the list"
            kind="outline"
            onPress={() => {
              setAreaSheetActive(current.id, false);
              showToast(
                openHere > 0
                  ? `${current.title} taken off the list. ${openHere} still open on the Crew board.`
                  : `${current.title} taken off the list`,
                openHere > 0 ? 'warn' : 'info',
              );
              setEditing(null);
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}
