import React from 'react';

// The ScatterPie mark, traced from the official logo: 8 wedges, listed clockwise from the big one on the left (the draw-in order).
const SCATTERPIE_BLUE = '#0033CC';
const WEDGES = [
  '10.9,40.0 32.9,40.1 37.3,44.6 30.9,48.6 12.7,56.1 6.9,54.0',
  '19.0,19.1 26.0,13.7 29.2,14.6 42.2,21.4 39.5,26.4 20.8,24.6',
  '47.7,5.9 57.0,7.0 59.5,7.3 61.9,12.4 55.8,13.1 46.7,7.9',
  '78.6,17.7 81.1,18.1 85.5,22.9 85.7,24.3 82.7,25.0 81.5,23.0',
  '90.8,41.8 93.6,41.6 93.9,43.9 95.0,52.3 92.7,51.6 89.9,44.3',
  '76.6,81.1 79.3,70.8 83.0,65.2 85.9,69.2 86.4,73.5 79.1,82.3',
  '46.5,87.5 57.3,72.6 64.6,72.8 60.0,88.3 56.8,92.2 46.1,90.9',
  '18.1,70.6 40.2,59.8 45.8,62.7 43.8,66.5 27.6,84.5 15.2,75.0',
];
// Wedges are inset slightly in WEDGES; this round-joined stroke adds that back as the logo's soft corners.
const CORNER_STROKE = 4.4;
const SPOKES = WEDGES.map((points, i) => ({ points, delay: i * 0.11 }));

interface BrandMarkProps {
  size?: number;
  animated?: boolean;
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ size = 56, animated = true, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    role="img"
    aria-label="ScatterPie"
    className={`${animated ? 'brand-mark-animated' : ''} ${className}`}
  >
    {SPOKES.map((spoke, i) => (
      <polygon
        key={i}
        className="brand-spoke"
        points={spoke.points}
        fill={SCATTERPIE_BLUE}
        stroke={SCATTERPIE_BLUE}
        strokeWidth={CORNER_STROKE}
        strokeLinejoin="round"
        style={{ animationDelay: `${spoke.delay}s` }}
      />
    ))}
  </svg>
);

interface BrandLoaderProps {
  label?: string;
  size?: number;
  className?: string;
}

// Inline loader for panels and lazy-loaded screens.
export const BrandLoader: React.FC<BrandLoaderProps> = ({ label, size = 56, className = '' }) => (
  <div className={`flex flex-col items-center gap-4 ${className}`} role="status" aria-live="polite">
    <BrandMark size={size} />
    {label && <p className="text-xs text-muted-foreground tracking-wide">{label}</p>}
  </div>
);

// Full-screen splash shown while the app boots and the session is restored.
export const BrandSplash: React.FC<{ label?: string }> = ({ label = 'Getting your studio ready…' }) => (
  <div className="relative h-screen w-full flex flex-col items-center justify-center bg-background overflow-hidden" role="status" aria-live="polite">
    <div aria-hidden className="pointer-events-none absolute w-[36rem] h-[36rem] rounded-full bg-[#1D4ED8]/[0.07] blur-3xl" />
    <div className="relative flex flex-col items-center gap-6">
      <BrandMark size={88} />
      <div className="text-center space-y-1.5">
        <p className="text-lg font-bold tracking-tight text-foreground font-display">Dubly</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
    <p className="absolute bottom-8 text-[11px] text-muted-foreground tracking-wide">A ScatterPie product</p>
  </div>
);
