import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { offsetM } from '../domain/geofence';
import { townGap } from '../domain/site';
import type { LatLng, SiteConfig } from '../domain/types';
import { color, font } from '../theme/theme';
import { fmtDistance } from '../util/format';

/**
 * A to-scale diagram of the clock-in boundary: the mine pin, the boundary
 * around it, the nearest town for reference when the site names one, and
 * (when known) where the phone is.
 * North is up. It is a diagram, not a street map.
 */
export function SiteMap({ site, you, youInside, height = 300 }: {
  site: SiteConfig;
  you?: LatLng;
  youInside?: boolean;
  height?: number;
}) {
  const W = 340;
  const H = Math.round((height / 300) * 300);
  const town = site.town ? offsetM(site.center, site.town.center) : undefined;
  const me = you ? offsetM(site.center, you) : undefined;

  // Fit the boundary, the town and the phone, with a margin.
  const points = [
    { east: -site.radiusM, north: -site.radiusM },
    { east: site.radiusM, north: site.radiusM },
    ...(town ? [town] : []),
    ...(me ? [me] : []),
  ];
  const minE = Math.min(...points.map((p) => p.east));
  const maxE = Math.max(...points.map((p) => p.east));
  const minN = Math.min(...points.map((p) => p.north));
  const maxN = Math.max(...points.map((p) => p.north));
  const pad = 46;
  const scale = Math.min((W - pad * 2) / (maxE - minE), (H - pad * 2) / (maxN - minN));
  const cx = W / 2 - ((minE + maxE) / 2) * scale;
  const cy = H / 2 + ((minN + maxN) / 2) * scale;
  const x = (east: number) => cx + east * scale;
  const y = (north: number) => cy - north * scale;

  const away = townGap(site);
  const half = 804.672; // half a mile, in metres
  const outline = site.polygon?.map((p) => offsetM(site.center, p));

  const label = { fontFamily: font.bodySemi, fontSize: 12 } as const;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`Diagram of the clock-in boundary, ${fmtDistance(site.radiusM)} around the mine pin.${away ? ` ${away.name} is ${fmtDistance(away.distanceM)} away, ${fmtDistance(away.gapM)} outside the boundary.` : ''}`}
      style={{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: color.rule, backgroundColor: color.kaolin }}
    >
      <Svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`}>
        <Rect x={0} y={0} width={W} height={H} fill={color.kaolin} />

        {/* Mine to town, with the distance */}
        {town ? <Line x1={x(0)} y1={y(0)} x2={x(town.east)} y2={y(town.north)} stroke={color.silicaLight} strokeWidth={1.5} strokeDasharray="5 5" /> : null}

        {/* The boundary */}
        {outline ? (
          <Polygon
            points={outline.map((p) => `${x(p.east)},${y(p.north)}`).join(' ')}
            fill={color.yellow}
            fillOpacity={0.4}
            stroke={color.ink}
            strokeWidth={2.5}
          />
        ) : (
          <Circle cx={x(0)} cy={y(0)} r={site.radiusM * scale} fill={color.yellow} fillOpacity={0.4} stroke={color.ink} strokeWidth={2.5} />
        )}

        {/* Mine pin */}
        <Circle cx={x(0)} cy={y(0)} r={6} fill={color.ink} />
        <SvgText x={x(0)} y={y(0) + 20} fill={color.ink} textAnchor="middle" {...label}>Mine pin</SvgText>
        <SvgText x={x(0)} y={y(-site.radiusM) + 16} fill={color.ink} textAnchor="middle" {...label}>
          {`Clock-in boundary, ${fmtDistance(site.radiusM)} out`}
        </SvgText>

        {/* Town */}
        {town && away ? (
          <G>
            <Rect x={x(town.east) - 6} y={y(town.north) - 6} width={12} height={12} fill={color.silica} />
            <SvgText x={x(town.east) - 22} y={y(town.north) + 4} fill={color.inkSoft} textAnchor="end" {...label}>
              {`${away.name}, ${fmtDistance(away.distanceM)}`}
            </SvgText>
          </G>
        ) : null}

        {/* The phone */}
        {me ? (
          <G>
            <Circle cx={x(me.east)} cy={y(me.north)} r={13} fill={youInside ? color.green : color.red} fillOpacity={0.22} />
            <Circle cx={x(me.east)} cy={y(me.north)} r={7} fill={youInside ? color.green : color.red} stroke={color.white} strokeWidth={2} />
            <SvgText x={x(me.east) + 17} y={y(me.north) + 5} fill={youInside ? color.green : color.red} fontFamily={font.bodyBold} fontSize={13}>
              You
            </SvgText>
          </G>
        ) : null}

        {/* North arrow and scale */}
        <Path d={`M${W - 24} 34 L${W - 30} 48 L${W - 24} 44 L${W - 18} 48 Z`} fill={color.ink} />
        <SvgText x={W - 24} y={26} fill={color.ink} textAnchor="middle" fontFamily={font.bodyBold} fontSize={12}>N</SvgText>
        <Line x1={16} y1={H - 18} x2={16 + half * scale} y2={H - 18} stroke={color.ink} strokeWidth={2.5} />
        <Line x1={16} y1={H - 23} x2={16} y2={H - 13} stroke={color.ink} strokeWidth={2.5} />
        <Line x1={16 + half * scale} y1={H - 23} x2={16 + half * scale} y2={H - 13} stroke={color.ink} strokeWidth={2.5} />
        <SvgText x={22 + half * scale} y={H - 14} fill={color.ink} {...label}>½ mile</SvgText>
      </Svg>
    </View>
  );
}
