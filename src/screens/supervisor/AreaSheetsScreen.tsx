import { Factory, Plus } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Button, Divider, EmptyState, Field, Page, Panel, Row, Sheet, Tag, Txt } from '../../components/ui';
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
  const [error, setError] = useState<string | null>(null);

  const active = sheets.filter((s) => s.active);
  const removed = sheets.filter((s) => !s.active);
  const current = editing && editing !== 'new' ? editing : undefined;
  const lineCount = rows.split('\n').filter((line) => line.trim()).length;

  const open = (sheet: AreaSheet | 'new') => {
    setTitle(sheet === 'new' ? '' : sheet.title);
    setRows(sheet === 'new' ? '' : sheet.rows.map((r) => r.label).join('\n'));
    setError(null);
    setEditing(sheet);
  };

  const save = () => {
    const result = current ? updateAreaSheet(current.id, title, rows) : addAreaSheet(title, rows);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast(current ? `${title.trim()} sheet saved` : `${title.trim()} sheet added`);
    setEditing(null);
  };

  return (
    <Page
      testID="area-sheets-screen"
      title="Area sheets"
      sub="The pre shift exam sheet for each work area"
      onBack={navigation.goBack}
      footer={<Button testID="sheet-add" label="Add an area sheet" icon={Plus} kind="yellow" onPress={() => open('new')} />}
    >
      <Txt v="body" c={color.inkSoft}>
        Each area has its own lines, checked for guarding, electrical and safe access. The 20 conditions on the second page are the same for every area.
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
                  sub={`${sheet.rows.length} ${sheet.rows.length === 1 ? 'line' : 'lines'} of its own, plus the 20 conditions. ${made} ${made === 1 ? 'exam' : 'exams'} on record.`}
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
        {current ? (
          <Txt v="small" c={color.silica}>Exams already signed keep the lines they were made on.</Txt>
        ) : null}
        <Button testID="sheet-save" label={current ? 'Save the sheet' : 'Add the sheet'} kind="ink" onPress={save} />
        {current ? (
          <Button
            testID="sheet-remove"
            label="Take it off the list"
            kind="outline"
            onPress={() => {
              setAreaSheetActive(current.id, false);
              showToast(`${current.title} taken off the list`, 'info');
              setEditing(null);
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}
