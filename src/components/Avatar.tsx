import React from 'react';

export const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

interface AvatarProps {
  name: string;
  // The picture the person chose in Settings; initials stand in until they do.
  src?: string | null;
  // Size and text size, e.g. "w-9 h-9 text-xs".
  className?: string;
  // Rounded square (settings, profile card) or circle (lists, sidebar).
  shape?: 'circle' | 'square';
  tone?: 'coral' | 'slate';
}

export const Avatar: React.FC<AvatarProps> = ({ name, src, className = 'w-9 h-9 text-xs', shape = 'circle', tone = 'coral' }) => {
  const rounded = shape === 'circle' ? 'rounded-full' : 'rounded-2xl';
  if (src) return <img src={src} alt={name} className={`${className} ${rounded} object-cover shrink-0`} />;
  return (
    <div
      aria-label={name}
      className={`${className} ${rounded} flex items-center justify-center font-bold shrink-0 ${tone === 'coral' ? 'bg-[#F05637] text-white' : 'bg-[#E2E8F0] text-[#0F172A]'}`}
    >
      {initialsOf(name)}
    </div>
  );
};
