import React, { useState } from 'react';
import { View } from 'react-native';

import { Divider, Notice, Page, Panel, Segmented, Txt } from '../../components/ui';
import { JURISDICTION_NOTE, STANDARDS, type Agency } from '../../domain/standards';
import type { ScreenProps } from '../../navigation/types';
import { color, space } from '../../theme/theme';

/** Every standard the checklists point to, in plain language. */
export function StandardsScreen({ navigation }: ScreenProps<'Standards'>) {
  const [agency, setAgency] = useState<Agency>('MSHA');
  const list = Object.entries(STANDARDS).filter(([, std]) => std.agency === agency);
  return (
    <Page testID="standards-screen" title="Safety standards" sub="What the lines on the checklists are based on" onBack={navigation.goBack}>
      <Segmented<Agency>
        testID="agency"
        value={agency}
        onChange={setAgency}
        options={[
          { value: 'MSHA', label: 'MSHA, 30 CFR' },
          { value: 'OSHA', label: 'OSHA, 29 CFR' },
        ]}
      />
      <Notice tone="info" title={agency === 'MSHA' ? 'MSHA governs at the mine' : 'OSHA rules are the cross-reference'} body={JURISDICTION_NOTE} />
      <Panel flush>
        {list.map(([key, std], i) => (
          <View key={key}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 }}>
              <Txt v="smallStrong" c={color.blue}>{std.cite}</Txt>
              <Txt v="strong">{std.title}</Txt>
              <Txt v="body" c={color.inkSoft}>{std.summary}</Txt>
            </View>
          </View>
        ))}
      </Panel>
      <Txt v="small" c={color.silica}>
        These are plain-language summaries for use in the field, not legal advice. Read the regulation itself for the exact wording.
      </Txt>
    </Page>
  );
}
