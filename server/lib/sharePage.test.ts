import { describe, expect, it } from 'vitest';
import { compactCards, jsonForScript, renderMessagePage, renderSharePage, shareCsp, SHARE_LOGO_PATH } from './sharePage';
import { buildCaptionCards } from '../../src/lib/captionCues';

const lines = [
  { startTime: 0, endTime: 2, translatedText: 'Namaste doston, swagat hai.' },
  { startTime: 2.5, endTime: 5, translatedText: 'Aaj hum seekhenge dubbing.' },
];

const base = {
  title: 'Launch film',
  languageName: 'Hindi',
  streamUrl: 'https://storage.googleapis.com/b/o/dub.mp4?X-Goog-Signature=abc&x=1',
  downloadUrl: 'https://storage.googleapis.com/b/o/dub.mp4?response-content-disposition=attachment',
  hoursLeft: 5,
  nonce: 'bm9uY2U=',
};

describe('share page', () => {
  it('carries the ScatterPie logo, the title, the language, the expiry and a download button', () => {
    const html = renderSharePage({ ...base, captions: lines });
    expect(html).toContain(`src="${SHARE_LOGO_PATH}"`);
    expect(html).toContain('<h1>Launch film</h1>');
    expect(html).toContain('<span class="pill">Hindi</span>');
    expect(html).toContain('expires in about 5 hours');
    expect(html).toContain('Download video');
    expect(html).toContain('Powered by');
  });

  it('shows a CC switch and embeds the caption cards when captions are on', () => {
    const html = renderSharePage({ ...base, captions: lines });
    expect(html).toContain('id="cc"');
    expect(html).not.toMatch(/<button class="cc" id="cc" type="button" hidden>/);
    const cards = html.match(/<script type="application\/json" id="cards">(.*?)<\/script>/s);
    expect(cards).not.toBeNull();
    const parsed = JSON.parse(cards![1]) as [number, number, [string, number, number, number][]][];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0][2].map((w) => w[0]).join(' ')).toContain('Namaste');
    expect(parsed).toEqual(JSON.parse(JSON.stringify(compactCards(buildCaptionCards(lines)))));
  });

  it('has no captions, no card data and no visible CC button when whoever shared it switched them off', () => {
    const html = renderSharePage({ ...base, captions: null });
    expect(html).not.toContain('id="cards"');
    expect(html).toContain('<button class="cc" id="cc" type="button" hidden></button>');
    expect(html).not.toContain('Namaste');
  });

  it('treats a language with no translated lines as having no captions', () => {
    const html = renderSharePage({ ...base, captions: [{ startTime: 0, endTime: 1, translatedText: '   ' }] });
    expect(html).not.toContain('id="cards"');
  });

  it('escapes the title and URLs, and cannot be broken out of by caption text', () => {
    const html = renderSharePage({
      ...base,
      title: '<img src=x onerror=alert(1)> "quoted"',
      streamUrl: 'https://storage.googleapis.com/x?a=1&b="2"',
      captions: [{ startTime: 0, endTime: 2, translatedText: '</script><script>alert(1)</script>' }],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
    // The only scripts are the data block and the player, whatever a caption says.
    expect((html.match(/<script/g) ?? []).length).toBe(2);
    expect(html).not.toContain('</script><script>alert');
  });

  it('puts the nonce on the one executable script, and the policy allows exactly that', () => {
    const html = renderSharePage({ ...base, captions: lines });
    expect(html).toContain('<script nonce="bm9uY2U=">');
    const csp = shareCsp('bm9uY2U=');
    expect(csp).toContain("script-src 'nonce-bm9uY2U='");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain('https://storage.googleapis.com');
    expect(csp).not.toContain('unsafe-eval');
    expect(shareCsp()).toContain("script-src 'none'");
  });

  it('keeps JSON safe inside a script block', () => {
    const separators = String.fromCharCode(0x2028, 0x2029);
    const safe = jsonForScript({ a: '</script><!--', b: separators });
    expect(safe).not.toContain('</script');
    expect(safe).not.toContain('<!--');
    expect(safe).not.toContain(String.fromCharCode(0x2028));
    expect(safe).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(jsonForScript({ a: '</script>' }))).toEqual({ a: '</script>' });
  });

  it('renders the same chrome, without any script, for a link that is off, expired or missing', () => {
    const html = renderMessagePage('This link has expired', 'Shared videos stay available for 24 hours.');
    expect(html).toContain(`src="${SHARE_LOGO_PATH}"`);
    expect(html).toContain('This link has expired');
    expect(html).not.toContain('<script');
  });
});
