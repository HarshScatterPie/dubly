// How far a line may be pushed up or down to follow the original; wider than this and a misread level (music under the line) would be audible.
export const MAX_LINE_GAIN_DB = 4;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Gain per line so the dub keeps the original's dynamics (whispers low, shouts high), each side relative to its own median line.
export function lineGainsDb(lines: { id: string; sourceDb: number | null; dubDb: number | null }[]): Map<string, number> {
  const measured = lines.filter((l): l is { id: string; sourceDb: number; dubDb: number } => l.sourceDb !== null && l.dubDb !== null);
  const gains = new Map<string, number>();
  if (measured.length < 3) return gains;
  const sourceMid = median(measured.map((l) => l.sourceDb));
  const dubMid = median(measured.map((l) => l.dubDb));
  for (const l of measured) {
    const gain = l.sourceDb - sourceMid - (l.dubDb - dubMid);
    const bounded = Math.max(-MAX_LINE_GAIN_DB, Math.min(MAX_LINE_GAIN_DB, gain));
    if (Math.abs(bounded) >= 0.5) gains.set(l.id, Math.round(bounded * 10) / 10);
  }
  return gains;
}
