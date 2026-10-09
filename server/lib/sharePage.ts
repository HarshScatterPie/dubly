import { buildCaptionCards, type CaptionCard, type CaptionLine } from '../../src/lib/captionCues';

// The public page a share link opens: plain server-rendered HTML with a small inline player that behaves like the one in the studio
// (captions that light up word by word, a CC switch, speed, fullscreen). Nothing outside this page's own files may load or run.

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

// The one inline script is allowed by its per-request nonce; the video comes from Cloud Storage, the logo from this server.
export function shareCsp(nonce?: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "img-src 'self' data:",
    "media-src 'self' https://storage.googleapis.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const SHARE_LOGO_PATH = '/api/share/_assets/scatterpie-logo.png';

const CSS = `
:root{--coral:#F05637;--coral-d:#D94B2E;--ink:#0F172A;--muted:#64748B;--bg:#FAFAF7;--line:#E2E8F0}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;align-items:center;position:relative;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.glow{position:fixed;width:30rem;height:30rem;border-radius:50%;filter:blur(70px);pointer-events:none;z-index:0}
.g1{top:-11rem;left:-11rem;background:rgba(29,111,232,.10)}.g2{bottom:-11rem;right:-11rem;background:rgba(240,86,55,.11)}
.top,main,.foot{position:relative;z-index:1;width:100%;max-width:1000px;padding-left:16px;padding-right:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:22px;padding-bottom:18px}
.sp-logo{height:28px;width:auto;display:block}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.badge .d{width:24px;height:24px;border-radius:8px;background:var(--coral);color:#fff;display:grid;place-items:center;box-shadow:0 0 16px rgba(240,86,55,.35)}
.badge .d svg{width:14px;height:14px}.badge b{color:var(--ink);font-weight:700}
main{flex:1}
.card{background:#fff;border:1px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:0 24px 70px rgba(15,23,42,.10)}
.stage{position:relative;background:#000;container-type:inline-size;outline:none;display:flex;justify-content:center;align-items:center;user-select:none;-webkit-user-select:none}
.stage video{display:block;width:100%;max-height:72vh;background:#000;object-fit:contain}
.stage:fullscreen{width:100%;height:100%}.stage:fullscreen video{max-height:100vh;height:100%}
.big,.capwrap,.bar,.spin,.err{display:none}
.js .big{display:grid}.js .capwrap{display:flex}.js .bar{display:block}
.big{position:absolute;inset:0;margin:auto;width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.96);border:0;color:var(--ink);place-items:center;cursor:pointer;box-shadow:0 20px 50px rgba(0,0,0,.4);transition:transform .15s;z-index:4}
.big:hover{transform:scale(1.06)}.big:active{transform:scale(.96)}.big svg{width:28px;height:28px;transform:translateX(2px)}
.js .big.hide{display:none}
.spin{position:absolute;inset:0;margin:auto;width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:sp .8s linear infinite;z-index:3;pointer-events:none}
.spin.on{display:block}@keyframes sp{to{transform:rotate(360deg)}}
.err{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.8);color:#fff;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:14px;line-height:1.5}
.err.on{display:flex}
.capwrap{position:absolute;left:0;right:0;bottom:7%;justify-content:center;padding:0 6%;pointer-events:none;transition:bottom .3s;z-index:2}
.stage.ctl .capwrap{bottom:76px}
.cap{margin:0;max-width:88%;text-align:center;font-weight:600;line-height:1.35;padding:.25em .6em;border-radius:.45em;background:rgba(0,0,0,.65);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);text-shadow:0 1px 2px rgba(0,0,0,.6);font-size:clamp(13px,3.1cqw,30px);color:#fff;animation:fi .25s ease both}
@keyframes fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.w{color:rgba(255,255,255,.55);transition:color .1s}.w.s{color:#fff}.w.c{color:#FF9A85}
.bar{position:absolute;left:0;right:0;bottom:0;padding:40px 14px 10px;background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.45),transparent);transition:opacity .3s;z-index:6}
.bar.off{opacity:0;pointer-events:none}
.seek{position:relative;height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.track{position:relative;width:100%;height:4px;border-radius:99px;background:rgba(255,255,255,.2);overflow:hidden;transition:height .15s}
.seek:hover .track{height:6px}
.buf,.prog{position:absolute;top:0;bottom:0;left:0;width:0}.buf{background:rgba(255,255,255,.25)}.prog{background:var(--coral)}
.knob{position:absolute;top:50%;left:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:0;transition:opacity .15s}
.seek:hover .knob{opacity:1}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}
.grp{display:flex;align-items:center;gap:2px}
.ib{background:none;border:0;color:#fff;padding:7px;border-radius:9px;cursor:pointer;display:grid;place-items:center}
.ib:hover{background:rgba(255,255,255,.14)}.ib svg{width:20px;height:20px}
.vol{width:0;opacity:0;transition:width .2s,opacity .2s;height:4px;accent-color:#fff;cursor:pointer}
.grp:hover .vol,.vol:focus{width:64px;opacity:1}
.time{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.85);margin-left:6px;white-space:nowrap}
.cc,.spd{border:0;background:none;color:rgba(255,255,255,.85);font-weight:700;font-size:11px;padding:6px 8px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.cc svg{width:15px;height:15px}.cc:hover,.spd:hover{background:rgba(255,255,255,.14);color:#fff}
.cc.on{background:#fff;color:var(--ink)}.spd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.meta{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;padding:18px 22px}
h1{font-size:19px;line-height:1.3;margin:0 0 7px;word-break:break-word}
.sub{font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;font-size:12px;font-weight:600;color:var(--coral-d);background:#FFF4F1;border:1px solid #FFC4B3;border-radius:999px;padding:3px 10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--coral);color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:12px;box-shadow:0 8px 24px rgba(240,86,55,.3);transition:background .15s}
.btn:hover{background:var(--coral-d)}.btn svg{width:17px;height:17px}
.empty{padding:64px 24px;text-align:center}.empty h1{font-size:22px;margin-bottom:8px}.empty .sub{justify-content:center;font-size:14px}
.foot{display:flex;justify-content:center;align-items:center;gap:8px;padding-top:22px;padding-bottom:26px;font-size:12px;color:var(--muted)}
.foot img{height:14px;width:auto;opacity:.85}
@media(max-width:560px){.btn{width:100%}.meta{padding:16px}.vol{display:none}.time{margin-left:2px}.spd{display:none}}
@media(prefers-reduced-motion:reduce){.cap,.spin{animation:none}}
`;

const LOGO_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';

function chrome(title: string, description: string, body: string, extraHead = '', script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#FAFAF7"><title>${escapeHtml(title)}</title>
<meta property="og:site_name" content="Dubly"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">${extraHead}
<style>${CSS}</style></head><body><div class="glow g1"></div><div class="glow g2"></div>
<header class="top"><img class="sp-logo" src="${SHARE_LOGO_PATH}" alt="ScatterPie"><span class="badge"><span class="d">${LOGO_MARK}</span><span>Dubbed with <b>Dubly</b></span></span></header>
<main>${body}</main>
<footer class="foot"><span>Powered by</span><img src="${SHARE_LOGO_PATH}" alt="ScatterPie"><span>· Dubly, AI dubbing</span></footer>${script}</body></html>`;
}

// A link that is unknown, switched off, expired or whose video is gone.
export function renderMessagePage(heading: string, text: string): string {
  return chrome(`${heading} · Dubly`, text, `<div class="card empty"><h1>${escapeHtml(heading)}</h1><div class="sub">${escapeHtml(text)}</div></div>`);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// [start, end, [[word, followedBySpace, start, end], ...]]: the cards the player lights up, kept small because every viewer downloads them.
export function compactCards(cards: CaptionCard[]): unknown[] {
  return cards.map((c) => [round2(c.start), round2(c.end), c.words.map((w) => [w.text, w.space ? 1 : 0, round2(w.start), round2(w.end)])]);
}

// JSON that is safe to place inside a <script> block.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function jsonForScript(value: unknown): string {
  // `<` can open `</script>` or `<!--`; the two separators end a line in JavaScript source though not in JSON.
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

export interface SharePageInput {
  title: string;
  languageName: string;
  streamUrl: string;
  downloadUrl: string;
  hoursLeft: number;
  // The dub's translated lines, or null when whoever shared it switched captions off.
  captions: CaptionLine[] | null;
  nonce: string;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>',
  cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>',
  max: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>',
};

// Runs in the viewer's browser. Plain ES5 so the oldest phones that can play the video can also run it.
const PLAYER_JS = `(function(){
var $=function(i){return document.getElementById(i)};
var v=$('v'),stage=$('stage'),big=$('big'),capEl=$('cap'),bar=$('bar'),seek=$('seek'),buf=$('buf'),prog=$('prog'),knob=$('knob'),pp=$('pp'),mute=$('mute'),vol=$('vol'),time=$('time'),cc=$('cc'),spd=$('spd'),fs=$('fs'),spin=$('spin'),err=$('err');
var I=${jsonForScript(ICON)};
var cards=[];try{var raw=$('cards');if(raw)cards=JSON.parse(raw.textContent)}catch(e){}
var showCC=cards.length>0,playing=false,raf=0,hideT=0,lastKey='',speeds=[0.75,1,1.25,1.5,2],si=1;
stage.className+=' js';v.controls=false;
function fmt(s){if(!isFinite(s))return'0:00';s=Math.max(0,Math.floor(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return(h?h+':'+(m<10?'0':''):'')+m+':'+(r<10?'0':'')+r}
function active(t){var lo=0,hi=cards.length-1,f=-1;while(lo<=hi){var mid=(lo+hi)>>1;if(cards[mid][0]<=t){f=mid;lo=mid+1}else hi=mid-1}
if(f<0)return -1;var next=cards[f+1],until=Math.min(cards[f][1]+0.35,next?next[0]:Infinity);return t<=until?f:-1}
function paintCaption(t){if(!showCC||!cc.classList.contains('on')){if(lastKey!==''){capEl.hidden=true;capEl.innerHTML='';lastKey=''}return}
var i=active(t);if(i<0){if(lastKey!==''){capEl.hidden=true;capEl.innerHTML='';lastKey=''}return}
var words=cards[i][2],key=i+':';for(var k=0;k<words.length;k++)key+=t>=words[k][3]?'s':t>=words[k][2]?'c':'u';
if(key===lastKey)return;var fresh=lastKey.split(':')[0]!==String(i);lastKey=key;
var html='';for(k=0;k<words.length;k++){var w=words[k];var st=t>=w[3]?'s':t>=w[2]?'c':'';html+='<span class="w '+st+'">'+esc(w[0])+(w[1]&&k<words.length-1?' ':'')+'</span>'}
capEl.innerHTML=html;capEl.hidden=false;if(fresh){capEl.style.animation='none';void capEl.offsetWidth;capEl.style.animation=''}}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function tick(){var d=v.duration||0,t=v.currentTime||0,p=d?t/d*100:0;prog.style.width=p+'%';knob.style.left=p+'%';time.textContent=fmt(t)+' / '+fmt(d);
if(v.buffered&&v.buffered.length&&d)buf.style.width=v.buffered.end(v.buffered.length-1)/d*100+'%';paintCaption(t)}
function loop(){tick();raf=requestAnimationFrame(loop)}
function setPlaying(p){playing=p;pp.innerHTML=p?I.pause:I.play;pp.setAttribute('aria-label',p?'Pause':'Play');big.className=p?'big hide':'big';if(p){cancelAnimationFrame(raf);raf=requestAnimationFrame(loop);reveal()}else{cancelAnimationFrame(raf);tick();show()}}
function show(){bar.className='bar';stage.className=stage.className.replace(/ ctl/g,'')+' ctl'}
function hide(){bar.className='bar off';stage.className=stage.className.replace(/ ctl/g,'')}
function reveal(){show();clearTimeout(hideT);hideT=setTimeout(function(){if(playing)hide()},2600)}
function toggle(){if(v.paused){var p=v.play();if(p&&p.catch)p.catch(function(){})}else v.pause()}
function seekTo(x){var r=seek.getBoundingClientRect(),d=v.duration||0;if(!d)return;v.currentTime=Math.max(0,Math.min(1,(x-r.left)/r.width))*d;tick()}
function jump(s){v.currentTime=Math.max(0,Math.min(v.duration||0,v.currentTime+s));tick()}
function setMute(m){v.muted=m;mute.innerHTML=m||v.volume===0?I.mute:I.vol;vol.value=m?0:v.volume}
function fullscreen(){var d=document,el=stage;if(d.fullscreenElement||d.webkitFullscreenElement){(d.exitFullscreen||d.webkitExitFullscreen).call(d)}
else if(el.requestFullscreen)el.requestFullscreen();else if(el.webkitRequestFullscreen)el.webkitRequestFullscreen();else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen()}
function toggleCC(){var on=!cc.classList.contains('on');cc.classList.toggle('on',on);cc.setAttribute('aria-pressed',on);lastKey='x';paintCaption(v.currentTime||0)}
pp.innerHTML=I.play;mute.innerHTML=I.vol;fs.innerHTML=I.max;big.innerHTML=I.play;
if(showCC){cc.classList.add('on');cc.setAttribute('aria-pressed','true')}
v.volume=0.9;vol.value=0.9;
v.addEventListener('play',function(){setPlaying(true)});v.addEventListener('pause',function(){setPlaying(false)});v.addEventListener('ended',function(){setPlaying(false)});
v.addEventListener('loadedmetadata',tick);v.addEventListener('timeupdate',function(){if(!playing)tick()});v.addEventListener('progress',tick);v.addEventListener('seeked',tick);
v.addEventListener('waiting',function(){spin.className='spin on'});v.addEventListener('playing',function(){spin.className='spin'});v.addEventListener('canplay',function(){spin.className='spin'});
v.addEventListener('error',function(){err.className='err on';spin.className='spin'});
v.addEventListener('click',toggle);big.addEventListener('click',toggle);pp.addEventListener('click',toggle);
mute.addEventListener('click',function(){setMute(!v.muted)});
vol.addEventListener('input',function(){var x=parseFloat(vol.value);v.volume=x;v.muted=x===0;mute.innerHTML=x===0?I.mute:I.vol});
if(showCC)cc.addEventListener('click',toggleCC);
spd.addEventListener('click',function(){si=(si+1)%speeds.length;v.playbackRate=speeds[si];spd.textContent=speeds[si]+'x'});
fs.addEventListener('click',fullscreen);
function fsChange(){var on=document.fullscreenElement===stage||document.webkitFullscreenElement===stage;fs.innerHTML=on?I.min:I.max}
document.addEventListener('fullscreenchange',fsChange);document.addEventListener('webkitfullscreenchange',fsChange);
var drag=false;seek.addEventListener('pointerdown',function(e){drag=true;seek.setPointerCapture(e.pointerId);seekTo(e.clientX)});
seek.addEventListener('pointermove',function(e){if(drag)seekTo(e.clientX)});seek.addEventListener('pointerup',function(){drag=false});seek.addEventListener('pointercancel',function(){drag=false});
stage.addEventListener('mousemove',reveal);stage.addEventListener('touchstart',reveal,{passive:true});stage.addEventListener('mouseleave',function(){if(playing)hide()});
stage.addEventListener('keydown',function(e){var k=e.key.toLowerCase();if([' ','k','j','l','arrowleft','arrowright','m','c','f'].indexOf(k)<0)return;e.preventDefault();reveal();
if(k===' '||k==='k')toggle();else if(k==='j'||k==='arrowleft')jump(-5);else if(k==='l'||k==='arrowright')jump(5);else if(k==='m')setMute(!v.muted);else if(k==='c'&&showCC)toggleCC();else if(k==='f')fullscreen()});
show();tick();
})();`;

export function renderSharePage(input: SharePageInput): string {
  const cards = input.captions ? buildCaptionCards(input.captions) : [];
  const hasCaptions = cards.length > 0;
  const hours = `about ${input.hoursLeft} hour${input.hoursLeft === 1 ? '' : 's'}`;
  const heading = `${input.title} · ${input.languageName} dub`;
  const body = `<div class="card">
<div class="stage" id="stage" tabindex="0">
<video id="v" src="${escapeHtml(input.streamUrl)}#t=0.1" playsinline preload="metadata" controls></video>
<button class="big" id="big" type="button" aria-label="Play"></button>
<div class="capwrap"><p class="cap" id="cap" hidden></p></div>
<div class="spin" id="spin"></div>
<div class="err" id="err">This video could not be loaded. Reload the page, or ask the sender for a new link.</div>
<div class="bar" id="bar">
<div class="seek" id="seek" role="slider" aria-label="Seek"><div class="track"><div class="buf" id="buf"></div><div class="prog" id="prog"></div></div><div class="knob" id="knob"></div></div>
<div class="row"><div class="grp">
<button class="ib" id="pp" type="button" aria-label="Play"></button>
<button class="ib" id="mute" type="button" aria-label="Mute"></button><input class="vol" id="vol" type="range" min="0" max="1" step="0.05" aria-label="Volume">
<span class="time" id="time">0:00 / 0:00</span></div>
<div class="grp">${hasCaptions ? `<button class="cc" id="cc" type="button" aria-pressed="true" title="Captions (C)">${ICON.cc}<span>CC</span></button>` : '<button class="cc" id="cc" type="button" hidden></button>'}
<button class="spd" id="spd" type="button" title="Playback speed">1x</button>
<button class="ib" id="fs" type="button" aria-label="Fullscreen"></button></div></div>
</div></div>
<div class="meta"><div><h1>${escapeHtml(input.title)}</h1>
<div class="sub"><span class="pill">${escapeHtml(input.languageName)}</span><span>AI dub · link expires in ${hours}</span></div></div>
<a class="btn" href="${escapeHtml(input.downloadUrl)}">${ICON.down}<span>Download video</span></a></div></div>`;
  const cardsBlock = hasCaptions ? `<script type="application/json" id="cards">${jsonForScript(compactCards(cards))}</script>` : '';
  return chrome(heading, `Watch the ${input.languageName} dub of ${input.title}`, body, '', `${cardsBlock}<script nonce="${input.nonce}">${PLAYER_JS}</script>`);
}
