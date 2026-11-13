import { ClipboardList, Wrench } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Divider, EmptyState, Page, Panel, Row, Segmented, Tag, UnitPlate } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';
import { useMe, useStore } from '../../store/useStore';
import { space } from '../../theme/theme';
import { fmtDateTime } from '../../util/format';
import { RESULT_TAG } from '../equipment/InspectionDetailScreen';
import { MRF_STATUS } from '../equipment/MrfDetailScreen';

type Tab = 'preops' | 'requests';

export function MyRecordsScreen({ navigation }: ScreenProps<'MyRecords'>) {
  const me = useMe();
  const equipment = useStore((s) => s.equipment);
  const inspections = useStore((s) => s.inspections);
  const mrfs = useStore((s) => s.mrfs);
  const [tab, setTab] = useState<Tab>('preops');

  const mine = inspections.filter((i) => i.employeeId === me?.id).reverse().slice(0, 60);
  const requests = mrfs.filter((m) => m.requestedBy === me?.id).reverse();
  const unitOf = (id: string) => equipment.find((e) => e.id === id);

  return (
    <Page testID="my-records" title="My records" onBack={navigation.goBack}>
      <Segmented<Tab>
        testID="records-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'preops', label: `Pre-ops (${mine.length})` },
          { value: 'requests', label: `Requests (${requests.length})` },
        ]}
      />
      {tab === 'preops' ? (
        mine.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No pre-ops yet" body="Pick a unit on the Equipment tab to do your first one." />
        ) : (
          <Panel flush>
            {mine.map((i, n) => {
              const unit = unitOf(i.equipmentId);
              const tag = RESULT_TAG[i.result];
              return (
                <View key={i.id}>
                  {n > 0 ? <Divider inset={space.lg} /> : null}
                  <Row
                    left={unit ? <UnitPlate unit={unit.unit} /> : undefined}
                    title={unit ? `${unit.make} ${unit.model}` : 'Unit removed'}
                    sub={fmtDateTime(i.submittedAt)}
                    right={<Tag label={tag.label} tone={tag.tone} />}
                    onPress={() => navigation.navigate('InspectionDetail', { inspectionId: i.id })}
                  />
                </View>
              );
            })}
          </Panel>
        )
      ) : requests.length === 0 ? (
        <EmptyState icon={Wrench} title="No maintenance requests" body="Requests you send show up here with their status." />
      ) : (
        <Panel flush>
          {requests.map((m, n) => {
            const unit = unitOf(m.equipmentId);
            const status = MRF_STATUS[m.status];
            return (
              <View key={m.id}>
                {n > 0 ? <Divider inset={space.lg} /> : null}
                <Row
                  left={unit ? <UnitPlate unit={unit.unit} /> : undefined}
                  title={`MRF #${m.number}`}
                  sub={m.description}
                  right={<Tag label={status.label} tone={status.tone} />}
                  onPress={() => navigation.navigate('MrfDetail', { mrfId: m.id })}
                />
              </View>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}
