import { LocateFixed, Minus, Plus } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SiteMap } from '../../components/SiteMap';
import { Button, Divider, IconButton, Notice, Page, Panel, Txt } from '../../components/ui';
import { checkFix, circleAcres, haversineM, type FixCheck, type RawFix } from '../../domain/geofence';
import { IONE_TOWN_CENTER, MAX_RADIUS_M, MIN_RADIUS_M, PROPERTY_FACTS } from '../../domain/site';
import type { ScreenProps } from '../../navigation/types';
import { locate } from '../../services/location';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDistance } from '../../util/format';

const commas = (n: number) => Math.round(n).toLocaleString('en-US');

export function SiteScreen({ navigation }: ScreenProps<'Site'>) {
  const me = useMe();
  const settings = useStore((s) => s.settings);
  const { setRadius } = useStore.getState();
  const site = settings.site;

  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState<RawFix | null>(null);
  const [check, setCheck] = useState<FixCheck | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const townDistance = haversineM(site.center, IONE_TOWN_CENTER);
  const gap = townDistance - site.radiusM;

  const find = async () => {
    setBusy(true);
    setFailed(null);
    const result = await locate(site, settings.demoLocation);
    setBusy(false);
    if (!result.ok) {
      setFix(null);
      setCheck(null);
      setFailed(result.reason === 'denied' ? 'Location is turned off for this app. Turn it on in your phone settings.' : 'The phone could not get a position. Step into the open and try again.');
      return;
    }
    setFix(result.fix);
    setCheck(checkFix(site, result.fix));
  };

  return (
    <Page testID="site-screen" title="Mine boundary" sub={site.name} onBack={navigation.goBack}>
      <SiteMap site={site} you={fix ?? undefined} youInside={check?.verdict === 'inside'} />

      {check ? (
        <Notice
          tone={check.verdict === 'inside' ? 'ok' : 'bo'}
          title={
            check.verdict === 'inside'
              ? `You are at the mine, ${fmtDistance(Math.max(0, check.marginM))} inside the boundary`
              : check.verdict === 'outside'
                ? `You are ${fmtDistance(-check.marginM)} outside the boundary`
                : check.verdict === 'weak_gps'
                  ? 'The GPS signal is too weak to place you'
                  : 'The phone reported a simulated location'
          }
          body={`${fmtDistance(check.distanceM)} from the mine pin${settings.demoLocation !== 'gps' ? '. This is the demo GPS setting, not your real position.' : fix?.accuracyM ? `, accurate to about ${fmtDistance(fix.accuracyM)}.` : '.'}`}
        />
      ) : null}
      {failed ? <Notice tone="warn" title="No position" body={failed} /> : null}

      <Button testID="check-location" label="Check where I am" icon={LocateFixed} kind="ink" loading={busy} onPress={find} />

      <Panel title="The clock-in boundary" flush>
        <View style={styles.fact}>
          <Txt v="strong">{fmtDistance(site.radiusM)} around the mine pin</Txt>
          <Txt v="body" c={color.inkSoft}>
            About {commas(circleAcres(site.radiusM))} acres. You have to be inside it to clock in or to come back from lunch.
          </Txt>
        </View>
        <Divider inset={space.lg} />
        <View style={styles.fact}>
          <Txt v="strong">Town is outside it</Txt>
          <Txt v="body" c={color.inkSoft}>
            Downtown Ione is {fmtDistance(townDistance)} from the pin, {fmtDistance(gap)} beyond the boundary. A punch from town is turned down.
          </Txt>
        </View>
        <Divider inset={space.lg} />
        <View style={styles.fact}>
          <Txt v="strong">Your location is read only when you punch</Txt>
          <Txt v="body" c={color.inkSoft}>
            The app never follows you in the background. Clocking out and starting lunch are never blocked: the location is noted, and an off-site clock-out is flagged for review.
          </Txt>
        </View>
      </Panel>

      {me?.role === 'supervisor' ? (
        <Panel title="Adjust the boundary">
          <View style={styles.stepper}>
            <IconButton testID="radius-minus" icon={Minus} label="Smaller boundary" bg={color.grayTint} onPress={() => setRadius(site.radiusM - 50)} />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Txt v="num" testID="radius-value">{commas(site.radiusM)} m</Txt>
              <Txt v="small" c={color.silica}>{fmtDistance(site.radiusM)} radius, {commas(circleAcres(site.radiusM))} acres</Txt>
            </View>
            <IconButton testID="radius-plus" icon={Plus} label="Larger boundary" bg={color.grayTint} onPress={() => setRadius(site.radiusM + 50)} />
          </View>
          <Txt v="small" c={color.silica} style={{ marginTop: space.md }}>
            Between {MIN_RADIUS_M} and {commas(MAX_RADIUS_M)} m, in steps of 50 m. Past about {commas(Math.floor((townDistance - 800) / 50) * 50)} m the circle starts to reach the south side of town.
          </Txt>
        </Panel>
      ) : null}

      <Panel title="About the property">
        <Txt v="body" c={color.inkSoft}>
          The US Mine Ione Plant sits about {PROPERTY_FACTS.milesSouthOfIone} miles south of Ione on roughly {commas(PROPERTY_FACTS.totalAcres)} acres. About {PROPERTY_FACTS.activeAcres} acres have been mined, built on or reclaimed, all south of town and west of Highway 124.
        </Txt>
        <Txt v="small" c={color.silica} style={{ marginTop: space.sm }}>
          Source: {PROPERTY_FACTS.source}. The boundary here is a circle around the pin sized to cover the working area. It can be swapped for the surveyed property outline (parcels {PROPERTY_FACTS.parcels.join(', ')}).
        </Txt>
      </Panel>
    </Page>
  );
}

const styles = StyleSheet.create({
  fact: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
