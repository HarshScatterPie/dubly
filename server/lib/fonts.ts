import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheDir, serverRoot } from './paths';

/**
 * Fonts for burned-in captions.
 *
 * libass (ffmpeg's `subtitles` filter) finds fonts only through fontconfig, and the static
 * ffmpeg builds (ffmpeg-static on Windows and Linux) ship fontconfig *without* a config
 * file. With none, fontconfig knows no font directories, libass finds no font at all, and
 * every burned caption comes out blank — no error, just a video without its captions. So a
 * config is written here pointing at the host's own fonts (plus any the app bundles) and
 * handed to ffmpeg through FONTCONFIG_FILE.
 */
export const bundledFontsDir = path.join(serverRoot, 'assets', 'fonts');
const fontCacheDir = path.join(cacheDir, 'fontconfig');
const configPath = path.join(cacheDir, 'fontconfig', 'fonts.conf');

function systemFontDirs(): string[] {
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || 'C:\\Windows';
    return [path.join(windir, 'Fonts'), process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : ''].filter(Boolean);
  }
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local', 'share', 'fonts')];
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let written: Promise<string> | null = null;

function writeConfig(): Promise<string> {
  written ??= (async () => {
    await mkdir(fontCacheDir, { recursive: true });
    const dirs = [bundledFontsDir, ...systemFontDirs()].filter((dir) => existsSync(dir));
    const systemConfig = process.platform === 'win32' ? '' : '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n';
    const body = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${systemConfig}${dirs.map((dir) => `  <dir>${xml(dir)}</dir>`).join('\n')}
  <cachedir>${xml(fontCacheDir)}</cachedir>
</fontconfig>
`;
    await writeFile(configPath, body, 'utf8');
    return configPath;
  })().catch((err) => {
    written = null;
    throw err;
  });
  return written;
}

/** The environment ffmpeg needs to find fonts for captions. */
export async function captionRenderEnv(): Promise<NodeJS.ProcessEnv> {
  try {
    return { ...process.env, FONTCONFIG_FILE: await writeConfig() };
  } catch {
    return process.env;
  }
}

type Script = 'devanagari' | 'bengali' | 'gurmukhi' | 'gujarati' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'arabic' | 'japanese' | 'korean' | 'chinese' | 'thai' | 'latin';

const SCRIPT_RANGES: [Script, RegExp][] = [
  ['devanagari', /[\u0900-\u097F]/g],
  ['bengali', /[\u0980-\u09FF]/g],
  ['gurmukhi', /[\u0A00-\u0A7F]/g],
  ['gujarati', /[\u0A80-\u0AFF]/g],
  ['tamil', /[\u0B80-\u0BFF]/g],
  ['telugu', /[\u0C00-\u0C7F]/g],
  ['kannada', /[\u0C80-\u0CFF]/g],
  ['malayalam', /[\u0D00-\u0D7F]/g],
  ['arabic', /[\u0600-\u06FF\u0750-\u077F]/g],
  ['japanese', /[\u3040-\u30FF]/g],
  ['korean', /[\uAC00-\uD7AF\u1100-\u11FF]/g],
  ['chinese', /[\u4E00-\u9FFF]/g],
  ['thai', /[\u0E00-\u0E7F]/g],
];

/** The script most of the caption text is written in. */
export function dominantScript(text: string): Script {
  let best: Script = 'latin';
  let bestCount = 0;
  for (const [script, pattern] of SCRIPT_RANGES) {
    const count = text.match(pattern)?.length ?? 0;
    // Kana decides Japanese even when kanji outnumber it.
    const weighted = script === 'japanese' ? count * 3 : count;
    if (weighted > bestCount) {
      best = script;
      bestCount = weighted;
    }
  }
  return best;
}

// A family that has the script's glyphs on each host; fontconfig substitutes the closest match if it is missing.
const WINDOWS_FAMILY: Record<Script, string> = {
  devanagari: 'Nirmala UI',
  bengali: 'Nirmala UI',
  gurmukhi: 'Nirmala UI',
  gujarati: 'Nirmala UI',
  tamil: 'Nirmala UI',
  telugu: 'Nirmala UI',
  kannada: 'Nirmala UI',
  malayalam: 'Nirmala UI',
  arabic: 'Segoe UI',
  japanese: 'Yu Gothic UI',
  korean: 'Malgun Gothic',
  chinese: 'Microsoft YaHei',
  thai: 'Leelawadee UI',
  latin: 'Arial',
};
const NOTO_FAMILY: Record<Script, string> = {
  devanagari: 'Noto Sans Devanagari',
  bengali: 'Noto Sans Bengali',
  gurmukhi: 'Noto Sans Gurmukhi',
  gujarati: 'Noto Sans Gujarati',
  tamil: 'Noto Sans Tamil',
  telugu: 'Noto Sans Telugu',
  kannada: 'Noto Sans Kannada',
  malayalam: 'Noto Sans Malayalam',
  arabic: 'Noto Sans Arabic',
  japanese: 'Noto Sans CJK JP',
  korean: 'Noto Sans CJK KR',
  chinese: 'Noto Sans CJK SC',
  thai: 'Noto Sans Thai',
  latin: 'Noto Sans',
};

export function captionFontFamily(text: string): string {
  const script = dominantScript(text);
  return (process.platform === 'win32' ? WINDOWS_FAMILY : NOTO_FAMILY)[script];
}
