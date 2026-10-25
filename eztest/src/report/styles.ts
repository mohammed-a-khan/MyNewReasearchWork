/**
 * The report's design system: tokens (colour, spacing, radius, shadow, type
 * scale) for light and dark (selected, not inverted), components (header,
 * status bar, tabs, cards, tables, chips, badges, list, detail, timeline,
 * lightbox), charts, print and reduced motion. Status colours are marks;
 * text uses the ink tokens, which clear 4.5:1 on their surfaces. The brand
 * palette (brand.ts) overrides the brand and status tokens.
 */
import { brandPalette, paletteCss } from './brand.js';

const NEUTRAL_LIGHT = `color-scheme:light;
--bg:#f5f6f8;--surface:#ffffff;--surface-2:#f9fafb;--surface-3:#eff1f4;--surface-sunk:#eceef2;--border:#e2e5ea;--border-strong:#cdd2da;
--text:#16181d;--text-2:#3b4048;--muted:#5b616b;--field:#80868f;--link:var(--brand-ink);
--grid:#e8eaee;--axis:#cdd2da;--surface-ring:#ffffff;--q0:#eff1f4;--q1:#d5ddfb;--q2:#a9bbf5;--q3:#6f8ced;--q4:#3b5bdb;--q5:#253c9a;
--shadow-sm:0 1px 2px rgba(22,24,29,.06);--shadow:0 1px 2px rgba(22,24,29,.05),0 4px 14px rgba(22,24,29,.06);--shadow-lg:0 12px 40px rgba(22,24,29,.18);
--scrim:rgba(22,24,29,.45)`;
const NEUTRAL_DARK = `color-scheme:dark;
--bg:#111317;--surface:#1b1d22;--surface-2:#202329;--surface-3:#272b32;--surface-sunk:#16181c;--border:#2e333b;--border-strong:#454b55;
--text:#eceef2;--text-2:#c7ccd4;--muted:#a0a7b2;--field:#7b838f;--link:var(--brand-ink);
--grid:#2a2e35;--axis:#454b55;--surface-ring:#1b1d22;--q0:#272b32;--q1:#25336b;--q2:#304595;--q3:#4566d6;--q4:#7b93ee;--q5:#b3c2f6;
--shadow-sm:0 1px 2px rgba(0,0,0,.4);--shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.3);--shadow-lg:0 16px 48px rgba(0,0,0,.6);
--scrim:rgba(0,0,0,.6)`;

/** The default palette (brand and status tokens), the same derivation a brand colour goes through. */
const DEFAULT_PALETTE = paletteCss(brandPalette({}));

export const REPORT_CSS = `
:root{${NEUTRAL_LIGHT};
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--fs-xs:11.5px;--fs-sm:12.5px;--fs-md:14px;--fs-lg:16px;--fs-xl:20px;--fs-2xl:24px;--fs-3xl:30px;
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;
--r-sm:6px;--r:10px;--r-lg:14px;--r-pill:999px;
--w-heading:650;--ease:cubic-bezier(.2,.7,.2,1)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${NEUTRAL_DARK}}}
:root[data-theme=dark]{${NEUTRAL_DARK}}
:root[data-theme=light]{${NEUTRAL_LIGHT}}
${DEFAULT_PALETTE}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--stick,150px) + 8px)}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-md)/1.5 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:var(--link);text-underline-offset:2px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:-9999px;top:8px;z-index:100;background:var(--surface);padding:8px 12px;border-radius:var(--r-sm);box-shadow:var(--shadow)}.skip:focus{left:8px}
code,.mono{font-family:var(--mono);font-size:.92em}
h1,h2,h3,h4{margin:0;font-weight:var(--w-heading);letter-spacing:-.01em;line-height:1.25}
h2{font-size:var(--fs-xl)}h3{font-size:var(--fs-lg)}h4{font-size:var(--fs-md)}
p{margin:0 0 var(--s2)}
.muted{color:var(--muted)}.small{font-size:var(--fs-sm)}.num{font-variant-numeric:tabular-nums;text-align:right}
[hidden]{display:none!important}
button,select,input{font:inherit;color:inherit}
svg{flex:none}
.ico{width:16px;height:16px}

/* ------------------------------------------------------------ buttons, chips, badges */
.btn{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:6px 12px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-size:var(--fs-sm);font-weight:550;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s var(--ease),border-color .15s var(--ease)}
.btn:hover{background:var(--surface-3);text-decoration:none}
.btn svg{width:15px;height:15px}
.btn.primary{background:var(--brand-btn);border-color:var(--brand-btn);color:var(--on-brand)}.btn.primary:hover{filter:brightness(1.08)}
.btn.quiet{border-color:transparent;background:transparent}.btn.quiet:hover{background:var(--surface-3)}
.iconbtn{display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:var(--r-sm);background:transparent;color:var(--text-2);cursor:pointer}
.iconbtn:hover{background:var(--surface-3);color:var(--text)}.iconbtn svg{width:16px;height:16px}
.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;min-height:24px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--surface-2);color:var(--text-2);font-size:var(--fs-xs);line-height:1.6;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.chip{color:var(--link);text-decoration:none}a.chip:hover{border-color:var(--brand-ink)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px 1px 6px;border-radius:var(--r-pill);font-size:var(--fs-xs);font-weight:650;line-height:1.7;white-space:nowrap;border:1px solid transparent}
.badge svg{width:12px;height:12px;stroke-width:2.6}
.b-passed{background:var(--soft-passed);color:var(--ink-passed)}.b-healed{background:var(--soft-healed);color:var(--ink-healed)}.b-flaky{background:var(--soft-flaky);color:var(--ink-flaky)}
.b-failed{background:var(--soft-failed);color:var(--ink-failed)}.b-error{background:var(--soft-error);color:var(--ink-error)}.b-skipped,.b-neutral{background:var(--soft-skipped);color:var(--ink-skipped)}
.cat{display:inline-flex;align-items:center;padding:0 8px;border-radius:var(--r-pill);font-size:var(--fs-xs);font-weight:600;line-height:1.75;white-space:nowrap;border:1px solid currentColor}
.c-product{color:var(--ink-failed);background:var(--soft-failed)}.c-test{color:var(--ink-healed);background:var(--soft-healed)}.c-environment{color:var(--ink-error);background:var(--soft-error)}
.c-data,.c-flaky{color:var(--ink-flaky);background:var(--soft-flaky)}.c-unknown{color:var(--ink-skipped);background:var(--soft-skipped)}.c-new{color:var(--ink-failed);background:transparent}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.kbd{display:inline-block;padding:0 5px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:4px;font:11px/1.6 var(--mono);color:var(--text-2);background:var(--surface-2)}
.info{display:inline-grid;place-items:center;width:20px;height:20px;padding:0;margin-left:2px;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:help;vertical-align:middle}
.info:hover,.info:focus-visible{color:var(--brand-ink);background:var(--brand-soft)}.info svg{width:14px;height:14px}
.tip{position:fixed;z-index:80;pointer-events:none;background:var(--text);color:var(--surface);padding:7px 10px;border-radius:var(--r-sm);font-size:var(--fs-sm);max-width:320px;box-shadow:var(--shadow-lg);line-height:1.4}

/* ------------------------------------------------------------ header */
.topbar{position:sticky;top:0;z-index:30;background:var(--head-bg,var(--surface));color:var(--head-text,var(--text));border-bottom:1px solid var(--border);box-shadow:var(--shadow-sm)}
.topbar::before{content:"";display:block;height:3px;background:var(--brand)}
.head-in{max-width:1480px;margin:0 auto;padding:0 var(--s5)}
.head-top{display:flex;align-items:center;gap:var(--s4);padding:var(--s3) 0 var(--s2);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:var(--s3);min-width:0;flex:1 1 380px}
.brand-logo{height:36px;width:auto;max-width:180px;object-fit:contain;display:block}
.brand-logo.dark{display:none}
:root[data-theme=dark] .brand-logo.has-dark.light{display:none}:root[data-theme=dark] .brand-logo.dark{display:block}
.brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:var(--r);background:var(--brand-btn);color:var(--on-brand);flex:none;overflow:hidden}
.brand-mark svg{width:22px;height:22px}.brand-mark img{width:100%;height:100%;object-fit:contain}
.brand-text{min-width:0}
.brand-eyebrow{font-size:var(--fs-xs);font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--head-muted,var(--muted))}
.brand-title{font-size:var(--fs-xl);font-weight:var(--w-heading);line-height:1.2;overflow-wrap:anywhere}
.brand-sub{font-weight:450;color:var(--head-muted,var(--muted))}
.top-actions{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
.topbar .btn{background:transparent;color:inherit;border-color:var(--border-strong)}
.topbar .btn:hover{background:var(--surface-3);color:var(--text)}
.run-meta{display:flex;flex-wrap:wrap;gap:4px 18px;padding:0 0 var(--s3);font-size:var(--fs-sm);color:var(--head-muted,var(--muted));list-style:none;margin:0}
.run-meta li{display:inline-flex;align-items:center;gap:6px}.run-meta svg{width:14px;height:14px}
.run-meta b{color:var(--head-text,var(--text));font-weight:600}
.statusbar{display:flex;align-items:center;gap:var(--s3);padding:var(--s2) 0;border-top:1px solid var(--border);flex-wrap:wrap}
.sb-bar{flex:1 1 160px;display:flex;height:8px;border-radius:var(--r-pill);overflow:hidden;background:var(--surface-3);min-width:120px;gap:2px}
.sb-bar span{display:block;height:100%}
.sb-tiles{display:flex;gap:6px;flex-wrap:wrap;margin:0;padding:0;list-style:none}
.sb-tile a,.sb-tile>span{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);text-decoration:none;font-size:var(--fs-sm);line-height:1.3}
.sb-tile a:hover{border-color:var(--border-strong);background:var(--surface-2)}
.sb-tile .v{font-size:var(--fs-lg);font-weight:700;font-variant-numeric:tabular-nums}
.sb-tile .l{color:var(--muted)}.sb-tile .dot{align-self:center}
.sb-tile .d{font-size:var(--fs-xs);color:var(--muted)}.sb-tile .d.bad{color:var(--ink-failed)}.sb-tile .d.good{color:var(--ink-passed)}
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1 * var(--s2));padding:0 var(--s2)}
.tabs::-webkit-scrollbar{display:none}
.tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:10px 12px 12px;border:0;background:transparent;color:var(--head-muted,var(--muted));font-size:var(--fs-md);font-weight:550;cursor:pointer;white-space:nowrap;border-radius:var(--r-sm) var(--r-sm) 0 0}
.tab svg{width:16px;height:16px}
.tab:hover{color:var(--head-text,var(--text));background:var(--surface-2)}
.tab[aria-selected=true]{color:var(--head-text,var(--text))}
.tab[aria-selected=true]::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--brand)}
.tab.secondary{margin-left:auto;font-size:var(--fs-sm)}
.tab .alert{width:7px;height:7px;border-radius:50%;background:var(--st-failed)}

/* ------------------------------------------------------------ panels and cards */
main{max-width:1480px;margin:0 auto;padding:var(--s5)}
.js .tabpanel:not(.is-active){display:none}
.tabpanel:focus{outline:none}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s3);margin:0 0 var(--s4);flex-wrap:wrap}
.panel-head p{margin:0;color:var(--muted);font-size:var(--fs-sm)}
.grid{display:grid;gap:var(--s4);grid-template-columns:repeat(12,minmax(0,1fr))}
.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}.span-12{grid-column:span 12}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:var(--s4) var(--s5) var(--s5);min-width:0}
.card-h{display:flex;align-items:center;gap:var(--s2);margin:0 0 var(--s3);min-height:28px}
.card-h h3{font-size:var(--fs-md);font-weight:var(--w-heading)}
.card-h .grow{flex:1}
.card-sub{color:var(--muted);font-size:var(--fs-sm);margin:-6px 0 var(--s3)}
.empty-state{display:grid;justify-items:center;gap:var(--s2);text-align:center;padding:var(--s6) var(--s4);color:var(--muted)}
.empty-state .halo{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--soft-passed);color:var(--ink-passed)}
.empty-state .halo.n{background:var(--surface-3);color:var(--muted)}
.empty-state .halo svg{width:24px;height:24px}
.empty-state strong{color:var(--text);font-size:var(--fs-lg);font-weight:var(--w-heading)}
.banner{display:flex;gap:var(--s3);align-items:flex-start;padding:var(--s3) var(--s4);border:1px solid var(--st-error);border-left-width:4px;border-radius:var(--r);background:var(--soft-error);color:var(--text);margin:0 0 var(--s4)}
.banner svg{width:18px;height:18px;color:var(--ink-error);margin-top:2px}

/* tables */
table{border-collapse:collapse;width:100%;font-size:var(--fs-sm)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--grid);vertical-align:top}
thead th{font-size:var(--fs-xs);font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border)}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
caption{text-align:left;font-weight:600;padding:0 0 6px}
.tbl-wrap{overflow-x:auto;max-width:100%}
.tbl-wrap table{min-width:100%}
td.bar-cell{width:38%;min-width:90px}
.hbar{display:flex;height:8px;border-radius:var(--r-pill);overflow:hidden;background:var(--surface-3);gap:1px}.hbar span{display:block;height:100%}
.rate{font-variant-numeric:tabular-nums;font-weight:600}
.kv{display:grid;grid-template-columns:minmax(110px,max-content) minmax(0,1fr);gap:6px 18px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}.kv dd a{display:inline-block;min-height:24px;min-width:24px;line-height:24px}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:var(--s2);padding:8px 0;border-bottom:1px solid var(--grid);min-width:0}
.list li:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list .n{font-variant-numeric:tabular-nums;color:var(--text-2);font-weight:600}

/* overview */
.reason{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px var(--s3);align-items:center;padding:10px 0;border-bottom:1px solid var(--grid)}
.reason:last-child{border-bottom:0}
.reason .msg{font-family:var(--mono);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.reason .cnt{font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink-failed);min-width:24px;text-align:right}
.reason a{text-decoration:none;color:inherit}.reason a:hover .msg{text-decoration:underline}
.outcome{display:flex;align-items:center;gap:var(--s5);flex-wrap:wrap}
.outcome svg{width:168px;height:168px}
.outcome .legend{flex:1;min-width:150px}

/* ------------------------------------------------------------ tests explorer */
.explorer{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);gap:var(--s4);align-items:start}
.ex-side{position:sticky;top:var(--stick,150px);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);display:flex;flex-direction:column;height:calc(100vh - var(--stick,150px) - 24px);min-height:420px;overflow:hidden}
.ex-tools{padding:var(--s3);display:grid;gap:var(--s2);border-bottom:1px solid var(--border)}
.search{position:relative}.search svg{position:absolute;left:10px;top:50%;margin-top:-8px;width:16px;height:16px;color:var(--muted)}
input[type=search],select{min-height:34px;border:1px solid var(--field);border-radius:var(--r-sm);background:var(--surface);padding:5px 9px;font-size:var(--fs-sm)}
.search input{width:100%;padding-left:32px}
::placeholder{color:var(--muted);opacity:1}
.filters{display:flex;gap:4px;flex-wrap:wrap}
.fchip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:3px 10px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--surface);font-size:var(--fs-sm);cursor:pointer;color:var(--text-2)}
.fchip:hover{border-color:var(--border-strong)}
.fchip[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand-ink);color:var(--text);font-weight:600}
.ex-row2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.ex-row2 label{display:grid;gap:2px;font-size:var(--fs-xs);color:var(--muted);font-weight:600}
.ex-row2 select{width:100%;min-width:0}
.more{font-size:var(--fs-sm)}.more summary{cursor:pointer;color:var(--muted);width:max-content;min-height:24px;display:flex;align-items:center;padding:2px 0}
.ex-count{padding:6px var(--s3);font-size:var(--fs-xs);color:var(--muted);border-bottom:1px solid var(--border);background:var(--surface-2)}
.vlist{flex:1;overflow:auto;position:relative;outline:none}
.vlist:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.vlist-inner{position:relative}
.row{position:absolute;left:0;right:0;height:52px;display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--grid);cursor:pointer;background:var(--surface)}
.row:hover{background:var(--surface-2)}
.row.active{background:var(--brand-soft);box-shadow:inset 3px 0 0 var(--brand)}
.row:focus{outline:none}.row:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.sicon{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;flex:none}
.sicon svg{width:12px;height:12px;stroke-width:2.8}
.si-passed{background:var(--soft-passed);color:var(--ink-passed)}.si-healed{background:var(--soft-healed);color:var(--ink-healed)}.si-flaky{background:var(--soft-flaky);color:var(--ink-flaky)}
.si-failed{background:var(--soft-failed);color:var(--ink-failed)}.si-error{background:var(--soft-error);color:var(--ink-error)}.si-skipped{background:var(--soft-skipped);color:var(--ink-skipped)}
.rmain{flex:1;min-width:0}
.rname{font-size:var(--fs-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsub{font-size:var(--fs-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rtail{display:flex;align-items:center;gap:6px;flex:none}
.rdur{font-size:var(--fs-xs);color:var(--muted);font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.row.group{background:var(--surface-2);font-weight:600;font-size:var(--fs-sm);height:52px}
.row.group .rname{font-size:var(--fs-sm)}
.twisty{width:14px;height:14px;transition:transform .15s var(--ease);color:var(--muted)}
.row.group[aria-expanded=true] .twisty{transform:rotate(90deg)}
.gbar{width:64px;height:6px;border-radius:var(--r-pill);overflow:hidden;display:flex;background:var(--surface-3);gap:1px}.gbar span{display:block;height:100%}
.ex-detail{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);min-height:420px;min-width:0}
.ex-detail:focus{outline:none}
.d-empty{display:grid;place-items:center;min-height:420px;padding:var(--s6);text-align:center;color:var(--muted)}
.d-empty svg{width:40px;height:40px;color:var(--border-strong);margin-bottom:var(--s2)}
.d-head{padding:var(--s4) var(--s5);border-bottom:1px solid var(--border);display:grid;gap:var(--s2)}
.d-top{display:flex;gap:var(--s3);align-items:flex-start}
.d-top .grow{flex:1;min-width:0}
.d-title{font-size:var(--fs-xl);overflow-wrap:anywhere;margin-top:4px}
.d-back{display:none}
.d-meta{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:var(--fs-sm);color:var(--muted);margin:0;padding:0;list-style:none}
.d-meta b{color:var(--text);font-weight:600}
.d-actions{display:flex;gap:4px;flex:none}
.seg{justify-self:start;display:inline-flex;border:1px solid var(--border-strong);border-radius:var(--r-sm);overflow:hidden;flex-wrap:wrap;max-width:100%}
.seg button{border:0;background:var(--surface);padding:5px 12px;font-size:var(--fs-sm);cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:32px;color:var(--text-2)}
.seg button+button{border-left:1px solid var(--border-strong)}
.seg button[aria-pressed=true]{background:var(--brand-soft);color:var(--text);font-weight:600}
.cause{margin:var(--s4) var(--s5) 0;padding:var(--s3) var(--s4);border:1px solid var(--border);border-left:4px solid var(--st-failed);border-radius:var(--r);background:var(--surface-2);display:grid;gap:6px;font-size:var(--fs-sm)}
.cause.flaky{border-left-color:var(--st-flaky)}
.cause .row1{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cause details summary{cursor:pointer;color:var(--muted)}
.subtabs{display:flex;gap:2px;padding:0 var(--s4);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none;margin-top:var(--s3)}
.subtabs::-webkit-scrollbar{display:none}
.subtab{position:relative;border:0;background:transparent;padding:9px 10px 11px;font-size:var(--fs-sm);font-weight:550;color:var(--muted);cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.subtab .n{font-size:var(--fs-xs);color:var(--muted);font-weight:500}
.subtab:hover{color:var(--text)}
.subtab[aria-selected=true]{color:var(--text)}.subtab[aria-selected=true]::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:2px;background:var(--brand);border-radius:2px}
.subpanel{padding:var(--s4) var(--s5) var(--s5)}
.subpanel:focus{outline:none}

/* step timeline */
.steps,.step-children{list-style:none;margin:0;padding:0}
.steps{position:relative}
.step{position:relative;padding-left:26px}
.step::before{content:"";position:absolute;left:9px;top:0;bottom:0;width:2px;background:var(--grid)}
.steps>.step:first-child::before{top:18px}.steps>.step:last-child::before{bottom:auto;height:18px}
.step-children{margin-left:6px}
.step-line{display:flex;align-items:center;gap:6px;min-width:0}
.step>.step-line>.sicon,.step-dot{position:absolute;left:0;top:8px;z-index:1;box-shadow:0 0 0 3px var(--surface)}
.step-row{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 8px;border:0;border-radius:var(--r-sm);background:transparent;text-align:left;cursor:pointer;color:var(--text)}
.step-row:hover:not([disabled]){background:var(--surface-2)}
.step-row[disabled]{cursor:default}
.step-row .chev{width:14px;height:14px;color:var(--muted);transition:transform .15s var(--ease)}
.step-row[aria-expanded=true] .chev{transform:rotate(90deg)}
.step-row[disabled] .chev{visibility:hidden}
.step-int{flex:1;min-width:0;overflow-wrap:anywhere;font-size:var(--fs-md)}
.step-int .no{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:4px}
.step.failed>.step-line .step-int{color:var(--ink-failed);font-weight:600}
.step-dur{font-size:var(--fs-xs);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.step-thumb{flex:none;width:52px;height:34px;padding:0;border:1px solid var(--border);border-radius:5px;overflow:hidden;background:var(--surface-3);cursor:zoom-in}
.step-thumb img{width:100%;height:100%;object-fit:cover;object-position:left top;display:block}
.step-body{margin:2px 0 10px 8px;padding:var(--s3) var(--s4);border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2);display:grid;gap:var(--s3);min-width:0}
.step-body h4{font-size:var(--fs-sm);color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.err{border:1px solid var(--st-failed);border-left-width:4px;border-radius:var(--r-sm);background:var(--soft-failed);padding:10px 12px;color:var(--text);min-width:0}
.err strong{color:var(--ink-failed)}
.err pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:var(--fs-sm)/1.5 var(--mono);color:var(--text)}
.err details summary{cursor:pointer;font-size:var(--fs-sm);color:var(--muted);margin-top:6px}
pre.code{white-space:pre-wrap;word-break:break-word;background:var(--surface-sunk);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px;font:var(--fs-sm)/1.5 var(--mono);margin:0;max-height:420px;overflow:auto}
.ea{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s2)}
.ea>div{border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;background:var(--surface);min-width:0}
.ea .k{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.04em;font-weight:650;color:var(--muted)}
.ea .v{font-family:var(--mono);font-size:var(--fs-sm);overflow-wrap:anywhere}
.ea .exp .k{color:var(--ink-passed)}.ea .act .k{color:var(--ink-failed)}
.shot-big{display:block;padding:0;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;cursor:zoom-in;background:var(--surface-3);max-width:100%}
.shot-big img{display:block;max-width:100%;height:auto;max-height:520px}
.heal-diff{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center}
.heal-diff code{display:block;padding:6px 8px;border-radius:4px;word-break:break-all}
.heal-diff .old{background:var(--soft-failed);color:var(--ink-failed);text-decoration:line-through}.heal-diff .new{background:var(--soft-passed);color:var(--ink-passed)}
.box{border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);padding:10px 12px;display:grid;gap:6px;min-width:0}
.box-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:var(--fs-sm);font-weight:600}
.box details summary{cursor:pointer;font-size:var(--fs-sm);color:var(--muted)}
.attempt-steps{list-style:none;margin:0;padding:0}.attempt-steps li{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--grid)}
.attempt-steps li.diff .grow{color:var(--ink-failed);font-weight:600}
.attempt-steps .grow{flex:1;min-width:0}

/* compare, snapshots, video, network, evidence */
.cmp-bar{display:flex;gap:6px;margin-bottom:8px}
.cmp-stage{position:relative;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;background:var(--surface-3);max-height:560px;overflow-y:auto}
.cmp-stage img{display:block;width:100%;height:auto}
.cmp-top{position:absolute;top:0;left:0;bottom:0;overflow:hidden;border-right:2px solid var(--brand);box-sizing:border-box}
.cmp-top img{max-width:none;height:auto}
.cmp-diff{position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;pointer-events:none}
.cmp-lbl{position:absolute;top:6px;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;background:var(--surface);color:var(--text);padding:2px 6px;border-radius:4px;border:1px solid var(--border)}
.cmp-lbl.l{left:6px}.cmp-lbl.r{right:6px}
.cmp-tools{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px}.cmp-tools input[type=range]{width:200px;max-width:100%;vertical-align:middle;height:24px}
.ba{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.ba figure{margin:0}.ba button{padding:0;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;cursor:zoom-in;background:var(--surface-3);display:block;width:100%}
.ba img{display:block;width:100%;height:auto}.ba .lbl{font-size:var(--fs-xs);font-weight:650;color:var(--muted);margin-bottom:4px;text-transform:uppercase}
.snapframe{width:100%;height:420px;border:1px solid var(--border);border-radius:var(--r-sm);background:#fff;margin-top:6px}.snapframe.tall{height:820px}
.vwrap{position:relative}.vplayer{width:100%;max-height:560px;background:#000;border-radius:var(--r-sm);display:block}
.vmarks{position:relative;height:10px;margin:4px 0 0;background:var(--surface-3);border-radius:4px}
.vmark{position:absolute;top:1px;width:2px;height:8px;background:var(--muted)}.vmark.f{width:4px;top:0;height:10px;background:var(--st-failed)}
.vtools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}
.vchapters{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:5px}
.vchapters .fchip[aria-current=true]{border-color:var(--brand-ink);background:var(--brand-soft)}
.vchapters .vfail{border-color:var(--st-failed);color:var(--ink-failed)}
.evb-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.evb-tools input[type=search]{flex:1 1 200px}
.evthumb{display:block;padding:0;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);cursor:zoom-in;width:64px;height:42px;overflow:hidden}
.evthumb img{width:100%;height:100%;object-fit:cover;object-position:left top;display:block}
.evkind{display:grid;place-items:center;width:64px;height:42px;border-radius:4px;background:var(--surface-3);color:var(--text-2);font-size:11px;font-weight:700;letter-spacing:.05em}
.evacts{display:flex;gap:4px;flex-wrap:wrap}
.ev-path{overflow-wrap:anywhere}
table.net td{vertical-align:middle}.net-url{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.net-bad td{background:var(--soft-failed)}
td.wf,th.wf{width:180px;min-width:120px}td.wf{position:relative}
.wf-bar{position:absolute;top:50%;height:8px;margin-top:-4px;background:var(--series-1);border-radius:3px;min-width:2px}.wf-bar.bad{background:var(--st-failed)}
.spark{display:inline-flex;gap:2px;align-items:flex-end;vertical-align:middle}.spark i{display:block;width:6px;height:14px;border-radius:2px}
.spark .P{background:var(--st-passed)}.spark .H{background:var(--st-healed)}.spark .F{background:var(--st-failed)}
.copy-ok{font-size:var(--fs-xs);color:var(--ink-passed);margin-left:4px}

/* lightbox */
.lightbox{border:0;padding:0;background:transparent;max-width:96vw;max-height:96vh;color:var(--text)}
.lightbox::backdrop{background:rgba(10,12,16,.82)}
.lb-in{display:grid;gap:8px;background:var(--surface);padding:10px;border-radius:var(--r-lg);max-height:94vh;overflow:auto}
.lb-in img{max-width:92vw;max-height:78vh;object-fit:contain;display:block;margin:0 auto;background:var(--surface-3);border-radius:var(--r-sm)}
.lb-in img.actual{max-width:none;max-height:none}
.lb-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.lb-cap{flex:1 1 200px;font-size:var(--fs-sm);color:var(--text-2)}

/* failures */
.cat-sec{margin:0 0 var(--s5)}
.cat-sec>h3{display:flex;align-items:center;gap:var(--s2);margin:0 0 var(--s3);font-size:var(--fs-lg)}
.cause-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);margin:0 0 var(--s3);overflow:hidden}
.cause-card:target{box-shadow:0 0 0 2px var(--focus)}
.group-h{display:flex;gap:var(--s3);align-items:flex-start;padding:var(--s3) var(--s4);border-left:4px solid var(--st-failed)}
.cause-card.flaky .group-h{border-left-color:var(--st-flaky)}
.group-h .grow{flex:1;min-width:0}
.group-msg{font:var(--fs-sm)/1.5 var(--mono);color:var(--text);overflow-wrap:anywhere;margin:0}
.group-meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:var(--fs-xs);color:var(--muted);margin-top:6px}
.group-n{font-size:var(--fs-2xl);font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink-failed);line-height:1;text-align:right}
.group-n small{display:block;font-size:var(--fs-xs);font-weight:500;color:var(--muted)}
.cause-card.flaky .group-n{color:var(--ink-flaky)}
.next{display:flex;gap:8px;align-items:flex-start;padding:var(--s2) var(--s4);background:var(--brand-soft);font-size:var(--fs-sm);color:var(--text)}
.next svg{width:16px;height:16px;color:var(--brand-ink);margin-top:2px}
.group-tests{list-style:none;margin:0;padding:var(--s1) var(--s4) var(--s3)}
.group-tests li{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--grid);min-width:0;font-size:var(--fs-sm)}
.group-tests li:last-child{border-bottom:0}
.group-tests a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-tests .where{color:var(--muted);font-size:var(--fs-xs);max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* environment */
details.sect{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);margin:0 0 var(--s3)}
details.sect>summary{list-style:none;display:flex;align-items:center;gap:var(--s2);padding:var(--s3) var(--s4);cursor:pointer;font-weight:var(--w-heading)}
details.sect>summary::-webkit-details-marker{display:none}
details.sect>summary .chev{width:16px;height:16px;color:var(--muted);transition:transform .15s var(--ease)}
details.sect[open]>summary .chev{transform:rotate(90deg)}
details.sect>summary .hint{font-weight:400;color:var(--muted);font-size:var(--fs-sm);margin-left:auto}
details.sect>.sect-b{padding:0 var(--s4) var(--s4)}
.env-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--s3);align-items:start}
.cfg-filter{display:flex;gap:8px;align-items:center;margin-bottom:8px}.cfg-filter input{flex:1 1 220px}
table.cfg td{font-family:var(--mono);font-size:var(--fs-xs);overflow-wrap:anywhere}

/* policy (opt-in) */
.policy{border-left:4px solid var(--border-strong)}
.policy.d-pass{border-left-color:var(--st-passed)}.policy.d-risk{border-left-color:var(--st-flaky)}.policy.d-stop{border-left-color:var(--st-failed)}
.policy .decision{font-size:var(--fs-2xl);font-weight:700}
.reasons{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:var(--fs-sm)}
.reasons li{display:flex;gap:8px;align-items:baseline}
.rk{flex:none;font-size:var(--fs-xs);font-weight:650;text-transform:uppercase;letter-spacing:.04em;padding:0 6px;border-radius:4px;background:var(--surface-3);color:var(--text-2)}
.gate{display:inline-block;margin:2px 4px 0 0;font-size:var(--fs-xs);padding:1px 8px;border-radius:var(--r-pill);background:var(--surface-3)}

/* charts */
.viz{display:block;max-width:100%;height:auto;overflow:visible}
.viz text{font-family:var(--sans);fill:var(--text-2)}
.viz .tick{font-size:11px;fill:var(--muted)}.viz .blabel{font-size:12px;fill:var(--text)}.viz .bvalue{font-size:11.5px;fill:var(--text-2)}
.viz .grid{stroke:var(--grid);stroke-width:1}.viz .axis{stroke:var(--axis);stroke-width:1}
.viz .line{stroke-width:2;stroke-linejoin:round;stroke-linecap:round;fill:none}
.viz .line.series-1{stroke:var(--series-1)}.viz .line.series-2{stroke:var(--series-2)}
.viz .area.series-1{fill:var(--series-1);opacity:.12}.viz .area.series-2{fill:var(--series-2);opacity:.12}
.viz .dot{stroke:var(--surface-ring);stroke-width:2}.viz .dot.series-1{fill:var(--series-1)}.viz .dot.series-2{fill:var(--series-2)}
.viz .endlabel{font-size:12px;font-weight:600;fill:var(--text)}
.viz .viz-hero{font-size:28px;font-weight:700;fill:var(--text)}.viz .viz-muted{font-size:11.5px;fill:var(--muted)}
.viz .guide{stroke:var(--axis);stroke-width:1;opacity:0}.viz .hit:hover .guide,.viz .hit:focus .guide{opacity:1}
.viz .hit:hover .mark,.viz .hit:focus .mark,.viz .mark:hover,.viz .mark:focus{filter:brightness(1.1)}
.viz .hit:focus,.viz .mark:focus{outline:none}.viz .hit:focus rect,.viz .mark:focus{stroke:var(--focus);stroke-width:2}
.viz .track{stroke:var(--surface-3)}
.viz .mark.muted{fill:var(--q2)}.mark.series-1,.key.series-1{fill:var(--series-1);background:var(--series-1)}.mark.series-2,.key.series-2{fill:var(--series-2);background:var(--series-2)}
.st-passed{fill:var(--st-passed);background:var(--st-passed)}.st-healed{fill:var(--st-healed);background:var(--st-healed)}.st-flaky{fill:var(--st-flaky);background:var(--st-flaky)}
.st-failed{fill:var(--st-failed);background:var(--st-failed)}.st-error{fill:var(--st-error);background:var(--st-error)}.st-skipped{fill:var(--st-skipped);background:var(--st-skipped)}
.viz .cell.q0{fill:var(--q0)}.viz .cell.q1{fill:var(--q1)}.viz .cell.q2{fill:var(--q2)}.viz .cell.q3{fill:var(--q3)}.viz .cell.q4{fill:var(--q4)}.viz .cell.q5{fill:var(--q5)}
.viz .cell.none{fill:none;stroke:var(--grid)}
.gantt .mark{stroke:var(--surface-ring);stroke-width:1}
.donut{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.donut svg{width:168px;flex:none}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:6px;min-width:150px;flex:1}
.legend li{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:8px;align-items:center;font-size:var(--fs-sm)}
.legend .key{width:10px;height:10px;border-radius:3px}.legend .lv{font-variant-numeric:tabular-nums;font-weight:600}.legend .lp{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.viz-table{margin-top:6px;font-size:var(--fs-sm)}.viz-table summary{cursor:pointer;color:var(--muted);font-size:var(--fs-xs);width:max-content}
.viz-table table{margin-top:6px}
.meter{display:grid;gap:4px;margin:0 0 14px}.meter-head{display:flex;justify-content:space-between;font-size:var(--fs-sm)}.meter-value{font-weight:650;font-variant-numeric:tabular-nums}
.meter-track{height:8px;border-radius:4px;background:var(--surface-3);overflow:hidden}.meter-fill{height:100%;border-radius:4px}
.meter-fill.t-good{background:var(--st-passed)}.meter-fill.t-warn{background:var(--st-flaky)}.meter-fill.t-bad{background:var(--st-failed)}
.meter-detail{font-size:var(--fs-xs);color:var(--muted)}

/* companion pages (comparison, trends, summary) */
.block{margin:0 0 var(--s5)}.block-head{margin:0 0 var(--s3)}.block-head p{color:var(--muted);margin:4px 0 0}
.topbar-in{max-width:1480px;margin:0 auto;padding:var(--s3) var(--s5);display:flex;align-items:center;gap:var(--s4);flex-wrap:wrap}
.brand-name{font-size:var(--fs-xs);font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--s3);margin:0 0 var(--s4)}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s3) var(--s4)}
.kpi-label{font-size:var(--fs-xs);color:var(--muted);font-weight:600}.kpi-value{font-size:var(--fs-2xl);font-weight:700;font-variant-numeric:tabular-nums}
.cnt{display:inline-block;min-width:22px;padding:0 6px;border-radius:var(--r-pill);background:var(--surface-3);font-size:var(--fs-xs);text-align:center;margin-left:6px}
.cmp-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.cmp-cols ul{list-style:none;margin:0;padding:0;font-size:var(--fs-sm);max-height:260px;overflow:auto}.cmp-cols li{padding:4px 0;border-bottom:1px solid var(--grid)}
.ink-failed{color:var(--ink-failed)}.ink-passed{color:var(--ink-passed)}
.g-2{grid-template-columns:repeat(2,minmax(0,1fr))}.g-3{grid-template-columns:repeat(3,minmax(0,1fr))}

footer.foot{max-width:1480px;margin:0 auto;padding:var(--s4) var(--s5) var(--s6);display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between;color:var(--muted);font-size:var(--fs-xs);border-top:1px solid var(--border)}
footer.foot .legal{flex-basis:100%;color:var(--text-2)}
.menu{position:relative}
.menu-list{position:absolute;right:0;top:calc(100% + 6px);z-index:40;min-width:240px;margin:0;padding:6px;list-style:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow-lg)}
.menu-list a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r-sm);color:var(--text);text-decoration:none;font-size:var(--fs-sm)}
.menu-list a:hover,.menu-list a:focus-visible{background:var(--surface-3)}
.print-only{display:none}

/* ------------------------------------------------------------ responsive */
@media (max-width:1100px){.span-4,.span-5,.span-6,.span-7,.span-8{grid-column:span 12}.explorer{grid-template-columns:minmax(260px,340px) minmax(0,1fr)}}
@media (max-width:860px){
  .head-in,main,footer.foot{padding-left:var(--s4);padding-right:var(--s4)}
  .explorer{grid-template-columns:minmax(0,1fr)}
  .ex-side{position:static;height:auto;min-height:0;max-height:none}
  .vlist{height:62vh;flex:none}
  .ex-detail{display:none}
  .ex-detail.open{display:block;position:fixed;inset:0;z-index:50;border-radius:0;border:0;overflow:auto;overscroll-behavior:contain}
  .ex-detail.open .d-head{position:sticky;top:0;z-index:2;background:var(--surface)}
  .d-back{display:inline-flex}
  .d-top{flex-wrap:wrap}.d-top .grow{order:3;flex-basis:100%}.d-actions{margin-left:auto}
  .bar-col{display:none}
  .reason{grid-template-columns:auto minmax(0,1fr)}.reason .cat{grid-column:2;justify-self:start}
  .reason .msg{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .env-grid,.ea,.g-2,.g-3{grid-template-columns:minmax(0,1fr)}
  .brand{flex-basis:100%}
  .brand-title{font-size:var(--fs-lg)}
  .top-actions .btn span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .top-actions{position:absolute;right:var(--s4);top:calc(3px + var(--s3))}
  .head-top{padding-right:120px}
  .card{padding:var(--s3) var(--s4) var(--s4)}
  .sb-bar{display:none}
  .sb-tile a,.sb-tile>span{padding:3px 8px}
  .sb-tile .v{font-size:var(--fs-md)}
  .sb-tile .d{display:none}
  .tab.secondary{margin-left:0}
}
@media (max-width:520px){.ex-row2{grid-template-columns:repeat(2,minmax(0,1fr))}.d-head,.subpanel{padding-left:var(--s3);padding-right:var(--s3)}.cause{margin-left:var(--s3);margin-right:var(--s3)}.group-tests .where{display:none}.heal-diff{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.tab[aria-selected=true]{outline:2px solid CanvasText}.fchip[aria-pressed=true],.seg button[aria-pressed=true]{outline:2px solid CanvasText}.sb-bar span,.hbar span,.dot{forced-color-adjust:none}}

/* ------------------------------------------------------------ print: every section, no tabs, one test per section */
@media print{
  :root{color-scheme:light}
  body{background:#fff;font-size:11pt}
  .topbar{position:static;box-shadow:none;border:0}
  .tabs,.top-actions,.skip,.ex-side,.ex-detail,.no-print,.tip,.lightbox,.cfg-filter,.d-actions,.subtabs{display:none!important}
  .js .tabpanel:not(.is-active),.tabpanel{display:block!important}
  .tabpanel{break-before:page}
  .tabpanel:first-of-type{break-before:auto}
  .tabpanel[data-print=skip]{display:none!important}
  main{padding:0;max-width:none}
  .card,.cause-card,details.sect{box-shadow:none;break-inside:avoid}
  details.sect>.sect-b{display:block!important}
  .print-only{display:block}
  .ptest{break-inside:avoid;border:1px solid #ccc;border-radius:6px;padding:8px 10px;margin:0 0 8px}
  .ptest.fail{break-before:page}
  .ptest h3{font-size:12pt}
  .ptest ol{margin:4px 0 0;padding-left:20px;font-size:9.5pt}
  a{color:inherit;text-decoration:none}
  .viz-table{display:none}
}
`;
