import { Search, UserPlus, Users } from '../../components/icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { Avatar, Button, Divider, EmptyState, Field, Notice, Page, Panel, Row, Segmented, Sheet, Tag, Toggle, Txt } from '../../components/ui';
import type { Employee, Role } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { haptic } from '../../services/haptics';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fullName, initials } from '../../util/format';

type Adding = 'one' | 'list';

/** The roster decides who can create an account. Nobody off this list gets in. */
export function RosterScreen({ navigation }: ScreenProps<'Roster'>) {
  const me = useMe();
  const employees = useStore((s) => s.employees);
  const accounts = useStore((s) => s.accounts);
  const { addEmployee, addEmployeesBulk, setEmployeeActive, setEmployeeRole, showToast } = useStore.getState();

  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<Adding>('one');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [supervisor, setSupervisor] = useState(false);
  const [list, setList] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const text = query.trim().toLowerCase();
  const active = employees
    .filter((e) => e.active)
    .filter((e) => !text || fullName(e).toLowerCase().includes(text) || (e.title ?? '').toLowerCase().includes(text))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const removed = employees.filter((e) => !e.active);
  const signedUp = (e: Employee) => accounts.some((a) => a.employeeId === e.id);
  const open = employees.find((e) => e.id === openId);
  const total = employees.filter((e) => e.active).length;
  const registered = employees.filter((e) => e.active && signedUp(e)).length;

  const reset = () => {
    setFirst(''); setLast(''); setTitle(''); setSupervisor(false); setList(''); setError(null);
  };

  const save = () => {
    if (mode === 'one') {
      const role: Role = supervisor ? 'supervisor' : 'employee';
      const result = addEmployee(first, last, role, title);
      if (!result.ok) {
        haptic.error();
        setError(result.error);
        return;
      }
      haptic.success();
      showToast(`${first.trim()} ${last.trim()} can now create an account`);
    } else {
      const { added, skipped } = addEmployeesBulk(list);
      if (added === 0) {
        haptic.error();
        setError(skipped > 0 ? 'Nobody new was added. Those names are already on the roster, or are missing a last name.' : 'Type or paste one name per line.');
        return;
      }
      haptic.success();
      showToast(`${added} ${added === 1 ? 'person' : 'people'} added${skipped ? `, ${skipped} skipped` : ''}`);
    }
    reset();
    setAdding(false);
  };

  return (
    <Page
      testID="roster-screen"
      title="Roster"
      sub={`${total} people, ${registered} with an account`}
      onBack={navigation.goBack}
      footer={<Button testID="roster-add" label="Add people" icon={UserPlus} kind="yellow" onPress={() => { reset(); setAdding(true); }} />}
    >
      <Notice tone="info" title="Only people on this list can sign up" body="A new account has to match a first and last name here. Remove someone and their sign-in stops working; their hours and records are kept." />
      <Field testID="roster-search" label="Find a person" value={query} onChangeText={setQuery} placeholder="Name or job title" autoCorrect={false} right={<Search color={color.silica} size={22} />} />

      {active.length === 0 ? (
        <EmptyState icon={Users} title={text ? 'Nobody matches' : 'The roster is empty'} body={text ? 'Check the spelling or clear the search.' : 'Add people so they can create their accounts.'} />
      ) : (
        <Panel flush>
          {active.map((e, i) => (
            <View key={e.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row
                testID={`person-${e.id}`}
                left={<Avatar initials={initials(e.firstName, e.lastName)} tone={e.role === 'supervisor' ? 'ink' : 'neutral'} />}
                title={`${e.lastName}, ${e.firstName}`}
                sub={[e.title, e.role === 'supervisor' ? 'Supervisor' : null].filter(Boolean).join(', ') || undefined}
                right={<Tag label={signedUp(e) ? 'Has account' : 'Not signed up'} tone={signedUp(e) ? 'ok' : 'neutral'} />}
                onPress={() => setOpenId(e.id)}
              />
            </View>
          ))}
        </Panel>
      )}

      {removed.length > 0 ? (
        <Panel title="Removed" flush>
          {removed.map((e, i) => (
            <View key={e.id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Row title={`${e.lastName}, ${e.firstName}`} sub="Cannot sign in. Records kept." titleColor={color.silica} right={<Tag label="Removed" tone="neutral" />} onPress={() => setOpenId(e.id)} />
            </View>
          ))}
        </Panel>
      ) : null}

      <Sheet testID="add-sheet" visible={adding} onClose={() => setAdding(false)} title="Add people">
        <Segmented<Adding>
          testID="add-mode"
          value={mode}
          onChange={(next) => { setMode(next); setError(null); }}
          options={[
            { value: 'one', label: 'One person' },
            { value: 'list', label: 'Paste a list' },
          ]}
        />
        {mode === 'one' ? (
          <>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ flex: 1 }}><Field testID="add-first" label="First name" value={first} onChangeText={(v) => { setFirst(v); setError(null); }} autoCapitalize="words" /></View>
              <View style={{ flex: 1 }}><Field testID="add-last" label="Last name" value={last} onChangeText={(v) => { setLast(v); setError(null); }} autoCapitalize="words" /></View>
            </View>
            <Field testID="add-title" label="Job title (optional)" value={title} onChangeText={setTitle} autoCapitalize="words" />
            <Toggle testID="add-supervisor" label="Supervisor" sub="Can see the crew, correct times, run payroll and manage this roster." value={supervisor} onChange={setSupervisor} />
          </>
        ) : (
          <Field
            testID="add-list"
            label="One name per line"
            value={list}
            onChangeText={(v) => { setList(v); setError(null); }}
            multiline
            placeholder={'Alex Carter\nMorgan, Riley\nSam Ortiz'}
            hint={'"First Last" or "Last, First". Names already on the roster are skipped.'}
            autoCapitalize="words"
            style={{ minHeight: 180 }}
          />
        )}
        {error ? <Txt v="smallStrong" c={color.red} testID="add-error">{error}</Txt> : null}
        <Button testID="add-save" label={mode === 'one' ? 'Add to roster' : 'Add everyone'} kind="ink" onPress={save} />
      </Sheet>

      <Sheet testID="person-sheet" visible={!!open} onClose={() => setOpenId(null)} title={open ? fullName(open) : ''}>
        {open ? (
          <>
            <Txt v="body" c={color.inkSoft}>
              {open.title ? `${open.title}. ` : ''}{signedUp(open) ? 'Has created an account.' : 'Has not signed up yet.'}
            </Txt>
            {open.active ? (
              <>
                <Toggle
                  testID="person-supervisor"
                  label="Supervisor"
                  sub="Can see the crew, correct times, run payroll and manage the roster."
                  value={open.role === 'supervisor'}
                  onChange={(on) => {
                    if (open.id === me?.id && !on) {
                      showToast('You cannot remove your own supervisor access.', 'warn');
                      return;
                    }
                    setEmployeeRole(open.id, on ? 'supervisor' : 'employee');
                  }}
                />
                <Button
                  testID="person-remove"
                  label="Remove from roster"
                  kind="red"
                  disabled={open.id === me?.id}
                  onPress={() => {
                    setEmployeeActive(open.id, false);
                    showToast(`${fullName(open)} can no longer sign in`, 'info');
                    setOpenId(null);
                  }}
                />
              </>
            ) : (
              <Button
                testID="person-restore"
                label="Put back on the roster"
                kind="ink"
                onPress={() => {
                  setEmployeeActive(open.id, true);
                  showToast(`${fullName(open)} is back on the roster`);
                  setOpenId(null);
                }}
              />
            )}
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
