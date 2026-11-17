import { useEffect, useState } from 'react';

import type { CompanyLogo } from '@app/domain/company';

type Art = typeof import('@app/components/logoArt').LOGO_ART;

/**
 * A company's own logo, only when it has one, always on white, the way the app
 * draws it. The built-in traced art is drawn from the app's own outlines, as
 * they are: never redrawn, recoloured or stretched. It is loaded only for a
 * company that uses it.
 */
export function CompanyLogoPlate({ logo, name }: { logo?: CompanyLogo; name: string }) {
  const [art, setArt] = useState<Art | null>(null);
  const wantsArt = !!logo && 'art' in logo;
  useEffect(() => {
    if (!wantsArt) return;
    let live = true;
    import('@app/components/logoArt').then((m) => live && setArt(m.LOGO_ART));
    return () => {
      live = false;
    };
  }, [wantsArt]);

  if (!logo) return null;
  if ('art' in logo) {
    if (!art) return null;
    return (
      <span className="logo-plate">
        <svg role="img" aria-label={name || 'Company logo'} viewBox={`0 0 ${art.width} ${art.height}`} style={{ width: '9.5rem', height: 'auto' }}>
          <path d={art.lettering} fill={art.navy} fillRule="evenodd" />
          <path d={art.rule} fill="none" stroke={art.gold} strokeWidth={art.ruleWidth} />
        </svg>
      </span>
    );
  }
  // The same rule the app keeps for a logo: an https address or an image held in the record. Anything else is not drawn.
  if (!/^https:\/\/\S+$/.test(logo.uri) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo.uri)) return null;
  return (
    <span className="logo-plate">
      <img src={logo.uri} alt={name || 'Company logo'} referrerPolicy="no-referrer" />
    </span>
  );
}

/** MineMuster's own logo. It is made for a dark background, so it only ever sits on one. */
export function MineMusterLogo({ width = '10.5rem', className }: { width?: string; className?: string }) {
  return <img className={className} src="/brand/minemuster-logo-800.webp" width={800} height={371} alt="MineMuster" style={{ width }} />;
}
