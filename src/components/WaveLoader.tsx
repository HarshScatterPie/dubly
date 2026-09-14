/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface WaveLoaderProps {
  label?: string;
  className?: string;
}

export const WaveLoader: React.FC<WaveLoaderProps> = ({ label, className = '' }) => (
  <div className={`flex flex-col items-center gap-4 ${className}`}>
    <div className="text-coral-500 inline-flex items-end h-6">
      <span className="wave-bar h-3" />
      <span className="wave-bar h-3" />
      <span className="wave-bar h-3" />
      <span className="wave-bar h-3" />
      <span className="wave-bar h-3" />
    </div>
    {label && <p className="text-xs text-muted-foreground font-mono">{label}</p>}
  </div>
);
