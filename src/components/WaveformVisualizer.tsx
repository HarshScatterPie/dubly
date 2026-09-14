/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';

interface WaveformVisualizerProps {
  isPlaying: boolean;
  peaks?: number[];
  progress?: number; // 0 to 1
  height?: number;
  barWidth?: number;
  barGap?: number;
  color?: string;
  progressColor?: string;
  onSeek?: (ratio: number) => void;
  className?: string;
}

export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({
  isPlaying,
  peaks,
  progress = 0,
  height = 56,
  barWidth = 3,
  barGap = 2,
  color = '#E2E8F0',
  progressColor = '#D94B2E',
  onSeek,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Generate deterministic peaks if none provided
  const barPeaks = peaks && peaks.length > 0
    ? peaks
    : Array.from({ length: 64 }, (_, i) => {
        const val = 0.25 + 0.55 * Math.abs(Math.sin((i / 64) * Math.PI * 3.5 + 0.4));
        return Math.min(1, Math.max(0.15, val));
      });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let animOffset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const totalBars = barPeaks.length;
      const totalWidth = totalBars * (barWidth + barGap);
      const startX = Math.max(0, (canvas.width - totalWidth) / 2);

      if (isPlaying) {
        animOffset += 0.12;
      }

      for (let i = 0; i < totalBars; i++) {
        const x = startX + i * (barWidth + barGap);
        let normalizedHeight = barPeaks[i];

        if (isPlaying) {
          const wave = Math.sin(i * 0.4 + animOffset) * 0.25;
          normalizedHeight = Math.min(1, Math.max(0.15, normalizedHeight + wave));
        }

        const barH = Math.max(4, normalizedHeight * (canvas.height - 8));
        const y = (canvas.height - barH) / 2;

        const isPast = (i / totalBars) <= progress;

        ctx.fillStyle = isPast ? progressColor : color;
        ctx.beginPath();
        // Rounded bar
        ctx.roundRect(x, y, barWidth, barH, barWidth / 2);
        ctx.fill();
      }

      if (isPlaying) {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, progress, barPeaks, color, progressColor, barWidth, barGap, height]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    onSeek(ratio);
  };

  return (
    <div className={`relative flex items-center justify-center cursor-pointer select-none ${className}`}>
      <canvas
        ref={canvasRef}
        width={380}
        height={height}
        onClick={handleClick}
        className="w-full h-full"
      />
    </div>
  );
};
