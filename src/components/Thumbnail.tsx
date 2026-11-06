import React, { useEffect, useState } from 'react';
import { Video } from 'lucide-react';

interface ThumbnailProps {
  src?: string;
  alt: string;
  className?: string;
  iconClassName?: string;
}

// A video's picture, loaded only as it scrolls into view. No picture, or one that fails to load, shows a plain tile rather than a broken image.
export const Thumbnail: React.FC<ThumbnailProps> = ({ src, alt, className = 'w-full h-full object-cover', iconClassName = 'w-4 h-4' }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#1b2233]" role="img" aria-label={alt}>
        <Video className={`${iconClassName} text-slate-500`} />
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={className} />;
};
