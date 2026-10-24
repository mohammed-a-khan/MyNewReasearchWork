/**
 * The report's design tokens and styles. One token set, light and dark
 * (selected, not inverted), plus print. Status colours are mark colours only;
 * text uses the ink tokens (every ink token clears 4.5:1 on its surface).
 */
export const REPORT_CSS = `
:root{color-scheme:light;
--bg:#f4f4f2;--surface:#ffffff;--surface-2:#f8f8f6;--surface-3:#eeeeeb;--border:#dddcd6;--border-strong:#c3c2b7;
--text:#141413;--text-2:#45443f;--muted:#5f5e59;--link:#1c5cab;--focus:#1c5cab;--accent:#2a78d6;--accent-soft:#e7f0fb;
--shadow:0 1px 2px rgba(20,20,19,.06),0 2px 8px rgba(20,20,19,.04);
--st-passed:#0ca30c;--st-healed:#6250d6;--st-flaky:#fab219;--st-failed:#d03b3b;--st-error:#ec835a;--st-skipped:#898781;
--ink-passed:#0a6a0a;--ink-healed:#4a3aa7;--ink-flaky:#7a5200;--ink-failed:#b02a2a;--ink-error:#9a4010;--ink-skipped:#5f5e59;
--soft-passed:#e9f6e9;--soft-healed:#efedfb;--soft-flaky:#fdf4dd;--soft-failed:#fbeaea;--soft-error:#fcefe8;--soft-skipped:#f0efec;
--series-1:#2a78d6;--series-2:#eb6834;--grid:#e8e7e1;--axis:#c3c2b7;--surface-ring:#ffffff;
--field:#7f7e78;--q0:#f0efec;--q1:#cde2fb;--q2:#9ec5f4;--q3:#5598e7;--q4:#256abf;--q5:#104281;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--r:10px;--r-sm:6px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
--bg:#0e0e0d;--surface:#1a1a19;--surface-2:#20201e;--surface-3:#2a2a27;--border:#34332f;--border-strong:#4a4944;
--text:#f0efec;--text-2:#d0cfc6;--muted:#b0afa6;--link:#8dbcf2;--focus:#8dbcf2;--accent:#3987e5;--accent-soft:#1b2a3d;
--shadow:0 1px 2px rgba(0,0,0,.4);
--st-passed:#0ca30c;--st-healed:#9085e9;--st-flaky:#fab219;--st-failed:#d03b3b;--st-error:#ec835a;--st-skipped:#898781;
--ink-passed:#5fd35f;--ink-healed:#b3abf2;--ink-flaky:#f5c451;--ink-failed:#ff8f8a;--ink-error:#f5a37f;--ink-skipped:#b0afa6;
--soft-passed:#13261a;--soft-healed:#221f3a;--soft-flaky:#2e2613;--soft-failed:#341a1a;--soft-error:#33221a;--soft-skipped:#262624;
--series-1:#3987e5;--series-2:#d95926;--grid:#2c2c2a;--axis:#4a4944;--surface-ring:#1a1a19;
--field:#8a8982;--q0:#262624;--q1:#184f95;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--q5:#9ec5f4}}
:root[data-theme=dark]{color-scheme:dark;
--bg:#0e0e0d;--surface:#1a1a19;--surface-2:#20201e;--surface-3:#2a2a27;--border:#34332f;--border-strong:#4a4944;
--text:#f0efec;--text-2:#d0cfc6;--muted:#b0afa6;--link:#8dbcf2;--focus:#8dbcf2;--accent:#3987e5;--accent-soft:#1b2a3d;
--shadow:0 1px 2px rgba(0,0,0,.4);
--st-passed:#0ca30c;--st-healed:#9085e9;--st-flaky:#fab219;--st-failed:#d03b3b;--st-error:#ec835a;--st-skipped:#898781;
--ink-passed:#5fd35f;--ink-healed:#b3abf2;--ink-flaky:#f5c451;--ink-failed:#ff8f8a;--ink-error:#f5a37f;--ink-skipped:#b0afa6;
--soft-passed:#13261a;--soft-healed:#221f3a;--soft-flaky:#2e2613;--soft-failed:#341a1a;--soft-error:#33221a;--soft-skipped:#262624;
--series-1:#3987e5;--series-2:#d95926;--grid:#2c2c2a;--axis:#4a4944;--surface-ring:#1a1a19;
--field:#8a8982;--q0:#262624;--q1:#184f95;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--q5:#9ec5f4}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:112px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px;top:0}.skip:focus{left:12px;top:12px;z-index:50;background:var(--surface);padding:8px 12px;border:1px solid var(--border);border-radius:var(--r-sm)}
code,.mono{font-family:var(--mono);font-size:12.5px}
h1,h2,h3,h4{margin:0;line-height:1.25;font-weight:600}
h2{font-size:18px}h3{font-size:15px}h4{font-size:13.5px}
.muted{color:var(--muted)}.ink-failed{color:var(--ink-failed)}.ink-passed{color:var(--ink-passed)}.small{font-size:12.5px}.num{font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit}
select,input{max-width:100%}
/* top bar */
.topbar{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--border)}
.topbar-in{max-width:1440px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img{height:32px;width:auto;max-width:160px;object-fit:contain}
.brand-mark{width:32px;height:32px;border-radius:8px;background:#1c5cab;color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;letter-spacing:.02em}
.brand-text{min-width:0}.brand-name{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.brand h1{font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-sm);padding:5px 10px;cursor:pointer;color:var(--text);text-decoration:none;font-size:13px;line-height:1.3}
.btn:hover{background:var(--surface-2)}.btn[aria-pressed=true]{background:var(--accent-soft);border-color:var(--accent)}
.btn.quiet{border-color:transparent;background:transparent}.btn.quiet:hover{background:var(--surface-3)}
.btn svg{width:14px;height:14px;flex:none}
.menu{position:relative}.menu-list{position:absolute;right:0;top:calc(100% + 4px);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);box-shadow:var(--shadow);padding:4px;min-width:200px;z-index:30;list-style:none;margin:0}
.menu-list a{display:block;padding:6px 10px;border-radius:4px;color:var(--text);text-decoration:none}.menu-list a:hover,.menu-list a:focus{background:var(--surface-3)}
.sections{max-width:1440px;margin:0 auto;padding:0 24px;display:flex;gap:2px;overflow-x:auto}
.sections a{padding:8px 12px;color:var(--text-2);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;font-weight:500;font-size:13.5px}
.sections a:hover{color:var(--text)}.sections a[aria-current=true]{color:var(--text);border-bottom-color:var(--accent)}
.sections .count{display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--surface-3);font-size:11.5px;text-align:center;color:var(--text-2)}
main{max-width:1440px;margin:0 auto;padding:20px 24px 48px}
section.block{margin:0 0 28px}
.block-head{display:flex;align-items:baseline;gap:12px;margin:0 0 12px;flex-wrap:wrap}
.block-head p{margin:0;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);padding:16px}
.card>h3{margin-bottom:10px}.card-sub{color:var(--muted);font-size:12.5px;margin:-6px 0 10px}
.grid{display:grid;gap:16px}
.g-2{grid-template-columns:repeat(2,minmax(0,1fr))}.g-3{grid-template-columns:repeat(3,minmax(0,1fr))}.g-3-2{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
@media (max-width:1100px){.g-3,.g-3-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){.g-2,.g-3,.g-3-2{grid-template-columns:minmax(0,1fr)}.topbar-in,.sections,main{padding-left:16px;padding-right:16px}}
/* verdict */
.verdict{display:grid;grid-template-columns:auto 1fr;gap:16px 20px;border-left:4px solid var(--border-strong)}
.verdict.v-GO{border-left-color:var(--st-passed)}.verdict.v-GO_WITH_RISKS{border-left-color:var(--st-flaky)}.verdict.v-NO_GO{border-left-color:var(--st-failed)}
.v-badge{display:flex;align-items:center;gap:10px}
.v-icon{width:44px;height:44px;border-radius:50%;display:grid;place-items:center}
.v-GO .v-icon{background:var(--soft-passed);color:var(--ink-passed)}.v-GO_WITH_RISKS .v-icon{background:var(--soft-flaky);color:var(--ink-flaky)}.v-NO_GO .v-icon{background:var(--soft-failed);color:var(--ink-failed)}
.v-icon svg{width:24px;height:24px}
.v-label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.v-decision{font-size:26px;font-weight:700;line-height:1.1}
.v-GO .v-decision{color:var(--ink-passed)}.v-GO_WITH_RISKS .v-decision{color:var(--ink-flaky)}.v-NO_GO .v-decision{color:var(--ink-failed)}
.v-score{color:var(--muted);font-size:13px}
.reasons{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.reasons li{display:flex;gap:8px;align-items:baseline}.reasons li>*{min-width:0;overflow-wrap:anywhere}
.rk{flex:none;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:4px;background:var(--surface-3);color:var(--text-2)}
.rk.violation{background:var(--soft-failed);color:var(--ink-failed)}.rk.risk,.rk.waived{background:var(--soft-flaky);color:var(--ink-flaky)}.rk.pass{background:var(--soft-passed);color:var(--ink-passed)}
.cites a{font-family:var(--mono);font-size:12px}
.gates{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.gate{font-size:12px;border:1px solid var(--border);border-radius:12px;padding:1px 8px;color:var(--text-2)}
.gate.g-fail{border-color:var(--st-failed);color:var(--ink-failed)}.gate.g-pass{color:var(--ink-passed)}.gate.g-waived{color:var(--ink-flaky)}
/* kpis */
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;box-shadow:var(--shadow);position:relative}
.kpi::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--kc,transparent)}
.kpi-label{font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:6px}.kpi-label svg{width:14px;height:14px;flex:none}
.kpi-value{font-size:26px;font-weight:650;line-height:1.2;margin-top:2px}
.kpi-delta{font-size:12px;color:var(--muted)}.kpi-delta.good{color:var(--ink-passed)}.kpi-delta.bad{color:var(--ink-failed)}
.kpi a{color:inherit;text-decoration:none}.kpi a:hover .kpi-value{text-decoration:underline}
.k-passed{--kc:var(--st-passed)}.k-failed{--kc:var(--st-failed)}.k-flaky{--kc:var(--st-flaky)}.k-healed{--kc:var(--st-healed)}.k-skipped{--kc:var(--st-skipped)}.k-error{--kc:var(--st-error)}.k-accent{--kc:var(--accent)}
/* charts */
.viz{display:block;max-width:100%;height:auto;overflow:visible}
.viz text{font-family:var(--sans);fill:var(--text-2)}
.viz .tick{font-size:11px;fill:var(--muted)}.viz .blabel{font-size:12px;fill:var(--text)}.viz .bvalue{font-size:11.5px;fill:var(--text-2)}
.viz .grid{stroke:var(--grid);stroke-width:1}.viz .axis{stroke:var(--axis);stroke-width:1}
.viz .line{stroke-width:2;stroke-linejoin:round;stroke-linecap:round;fill:none}
.viz .line.series-1{stroke:var(--series-1)}.viz .line.series-2{stroke:var(--series-2)}
.viz .area.series-1{fill:var(--series-1);opacity:.1}.viz .area.series-2{fill:var(--series-2);opacity:.1}
.viz .dot{stroke:var(--surface-ring);stroke-width:2}.viz .dot.series-1{fill:var(--series-1)}.viz .dot.series-2{fill:var(--series-2)}
.viz .endlabel{font-size:12px;font-weight:600;fill:var(--text)}
.viz .viz-hero{font-size:28px;font-weight:650;fill:var(--text)}.viz .viz-muted{font-size:11.5px;fill:var(--muted)}
.viz .guide{stroke:var(--axis);stroke-width:1;opacity:0}.viz .hit:hover .guide,.viz .hit:focus .guide{opacity:1}
.viz .hit:hover .mark,.viz .hit:focus .mark,.viz .mark:hover,.viz .mark:focus{filter:brightness(1.12)}
.viz .hit:focus,.viz .mark:focus{outline:none}.viz .hit:focus rect,.viz .mark:focus{stroke:var(--focus);stroke-width:2}
.viz .track{stroke:var(--surface-3)}
.viz .mark.muted{fill:var(--q2)}.mark.series-1,.key.series-1{fill:var(--series-1);background:var(--series-1)}.mark.series-2,.key.series-2{fill:var(--series-2);background:var(--series-2)}
.st-passed{fill:var(--st-passed);background:var(--st-passed)}.st-healed{fill:var(--st-healed);background:var(--st-healed)}.st-flaky{fill:var(--st-flaky);background:var(--st-flaky)}
.st-failed{fill:var(--st-failed);background:var(--st-failed)}.st-error{fill:var(--st-error);background:var(--st-error)}.st-skipped{fill:var(--st-skipped);background:var(--st-skipped)}
.viz .cell.q0{fill:var(--q0)}.viz .cell.q1{fill:var(--q1)}.viz .cell.q2{fill:var(--q2)}.viz .cell.q3{fill:var(--q3)}.viz .cell.q4{fill:var(--q4)}.viz .cell.q5{fill:var(--q5)}
.viz .cell.none{fill:none;stroke:var(--grid)}
.gantt .mark{stroke:var(--surface-ring);stroke-width:1}
.donut{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.donut svg{width:180px;flex:none}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:5px;min-width:180px;flex:1}
.legend li{display:grid;grid-template-columns:12px 1fr auto 52px;gap:8px;align-items:center;font-size:13px}
.legend .key{width:12px;height:12px;border-radius:3px}.legend .lv{font-variant-numeric:tabular-nums;font-weight:600}.legend .lp{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.legend-inline{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-2);margin:4px 0 6px}
.legend-inline .key{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
.viz-table{margin-top:6px;font-size:12.5px}.viz-table summary{cursor:pointer;color:var(--muted);font-size:12px;width:max-content}
.viz-table table{margin-top:6px}
.tip{position:fixed;z-index:60;pointer-events:none;background:var(--text);color:var(--surface);padding:6px 9px;border-radius:6px;font-size:12px;max-width:320px;box-shadow:var(--shadow);line-height:1.35}
[hidden]{display:none!important}
.meter{display:grid;gap:4px;margin:0 0 14px}.meter-head{display:flex;justify-content:space-between;font-size:13px}.meter-value{font-weight:650;font-variant-numeric:tabular-nums}
.meter-track{height:8px;border-radius:4px;background:var(--surface-3);overflow:hidden}.meter-fill{height:100%;border-radius:4px}
.meter-fill.t-good{background:var(--st-passed)}.meter-fill.t-warn{background:var(--st-flaky)}.meter-fill.t-bad{background:var(--st-failed)}
.meter-detail{font-size:12px;color:var(--muted)}
/* tables */
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
thead th{font-weight:600;color:var(--text-2);font-size:12px;background:var(--surface-2);position:sticky;top:0}
caption{text-align:left;font-weight:600;padding:0 0 6px}
.tbl-wrap{position:relative;overflow:auto;max-height:520px;border:1px solid var(--border);border-radius:var(--r-sm)}
.tbl-wrap table{border:0}
/* badges */
.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:1px 8px 1px 6px;border-radius:11px;white-space:nowrap;line-height:18px}
.badge svg{width:12px;height:12px}
.b-passed{background:var(--soft-passed);color:var(--ink-passed)}.b-healed{background:var(--soft-healed);color:var(--ink-healed)}.b-flaky{background:var(--soft-flaky);color:var(--ink-flaky)}
.b-failed{background:var(--soft-failed);color:var(--ink-failed)}.b-error{background:var(--soft-error);color:var(--ink-error)}.b-skipped{background:var(--soft-skipped);color:var(--ink-skipped)}
.b-info{background:var(--accent-soft);color:var(--link)}.b-neutral{background:var(--surface-3);color:var(--text-2)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:1px 8px;border-radius:11px;border:1px solid var(--border);color:var(--text-2);background:var(--surface);white-space:nowrap;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
a.chip,button.chip{min-height:24px}a.chip:hover{border-color:var(--link);color:var(--link)}.viz a text{fill:var(--link);text-decoration:underline}
.chips{display:flex;flex-wrap:wrap;gap:5px;min-width:0;max-width:100%}.reasons>li{min-width:0}
/* explorer */
.explorer{display:grid;grid-template-columns:minmax(320px,420px) minmax(0,1fr);gap:0;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow);height:min(82vh,900px);min-height:520px;overflow:hidden}
.ex-side{display:flex;flex-direction:column;border-right:1px solid var(--border);min-height:0}
.ex-tools{padding:10px;border-bottom:1px solid var(--border);display:grid;gap:8px;background:var(--surface-2)}
.ex-search{display:flex;gap:6px}
.ex-search input{flex:1;min-width:0}input::placeholder{color:var(--muted);opacity:1}
input[type=search],select{background:var(--surface);color:var(--text);border:1px solid var(--field);min-height:28px;border-radius:var(--r-sm);padding:5px 8px;font:inherit;font-size:13px}
.filters{display:flex;flex-wrap:wrap;gap:6px}
.fchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--field);background:var(--surface);border-radius:13px;padding:1px 10px;font-size:12px;cursor:pointer;min-height:26px}
.fchip[aria-pressed=true]{border-color:var(--text);background:var(--surface-3);font-weight:600}
.fchip .dot{width:8px;height:8px;border-radius:50%}
.ex-row2{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px 8px}
.ex-row2 label{font-size:11.5px;color:var(--muted);display:grid;gap:2px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.ex-row2 select{width:100%;text-transform:none;letter-spacing:0;font-weight:400}
.ex-count{font-size:12px;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--border)}
.vlist{flex:1;overflow:auto;position:relative;outline:none;min-height:0}
.vlist-inner{position:relative}
.row{position:absolute;left:0;right:0;height:44px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--grid);cursor:pointer;background:var(--surface)}
.row:hover{background:var(--surface-2)}.row.active{background:var(--accent-soft)}.row:focus{outline:2px solid var(--focus);outline-offset:-2px}
.row .sicon{flex:none;width:18px;height:18px;display:grid;place-items:center;border-radius:50%}
.row .sicon svg{width:12px;height:12px}
.row .rmain{min-width:0;flex:1}.row .rname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.row .rsub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;color:var(--muted)}
.row .rdur{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.row.group{background:var(--surface-2);font-weight:600}
.row.group .gcount{margin-left:auto;display:flex;gap:4px}
.twisty{width:16px;flex:none;color:var(--muted);transition:transform .15s}.row.group[aria-expanded=true] .twisty{transform:rotate(90deg)}
.si-passed{background:var(--soft-passed);color:var(--ink-passed)}.si-healed{background:var(--soft-healed);color:var(--ink-healed)}.si-flaky{background:var(--soft-flaky);color:var(--ink-flaky)}
.si-failed{background:var(--soft-failed);color:var(--ink-failed)}.si-error{background:var(--soft-error);color:var(--ink-error)}.si-skipped{background:var(--soft-skipped);color:var(--ink-skipped)}
.ex-detail{overflow:auto;min-height:0;padding:20px 24px}
.empty{display:grid;place-items:center;height:100%;color:var(--muted);text-align:center}
@media (max-width:900px){.explorer{grid-template-columns:minmax(0,1fr);height:auto}.ex-side{height:70vh;border-right:0}.ex-detail{border-top:1px solid var(--border)}.ex-detail.closed{display:none}}
/* detail */
.d-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:10px}
.d-title{font-size:18px;font-weight:600;word-break:break-word}.d-id{font-family:var(--mono);font-size:12px;color:var(--muted)}
.d-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--text-2);margin:8px 0 14px}
.d-meta b{color:var(--text);font-weight:600}
.panel{border:1px solid var(--border);border-radius:var(--r-sm);margin:0 0 14px;background:var(--surface)}
.panel>h3,.panel>.ph{padding:9px 12px;border-bottom:1px solid var(--border);background:var(--surface-2);font-size:13.5px;display:flex;align-items:center;gap:8px;border-radius:var(--r-sm) var(--r-sm) 0 0}
.panel>.pb{padding:12px}.pb>ul:first-child{margin-top:0}
.err{border-left:3px solid var(--st-failed);background:var(--soft-failed);padding:10px 12px;border-radius:0 var(--r-sm) var(--r-sm) 0;margin:0 0 10px}
.err pre{margin:6px 0 0}
pre{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12.5px;margin:0;line-height:1.45}
pre.code{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;max-height:320px;overflow:auto}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-word}
.steps{list-style:none;margin:0;padding:0}
.step{border-bottom:1px solid var(--grid)}
.step-row{display:grid;grid-template-columns:22px minmax(0,1fr) 140px 64px;gap:8px;align-items:center;padding:6px 4px;width:100%;background:none;border:0;text-align:left;cursor:pointer}
.step-row:hover{background:var(--surface-2)}
.step-row .sicon{width:18px;height:18px;display:grid;place-items:center;border-radius:50%}.step-row .sicon svg{width:11px;height:11px}
.step-int{min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis}
.step-bar{height:8px;background:var(--surface-3);border-radius:4px;position:relative;overflow:hidden}
.step-bar span{position:absolute;top:0;bottom:0;border-radius:4px;background:var(--series-1);min-width:2px}
.step-bar span.f{background:var(--st-failed)}.step-bar span.h{background:var(--st-healed)}
.step-dur{font-size:12px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.step-body{padding:6px 10px 12px 34px}
.step-children{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--grid);margin-left:12px}
.heal-diff{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin:6px 0}
.heal-diff code{display:block;padding:6px 8px;border-radius:4px;word-break:break-all}
.heal-diff .old{background:var(--soft-failed);color:var(--ink-failed);text-decoration:line-through}.heal-diff .new{background:var(--soft-passed);color:var(--ink-passed)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.shot{margin:0;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;background:var(--surface-2)}
.shot button{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}
.shot img{display:block;width:100%;height:130px;object-fit:cover;object-position:left top}
.shot figcaption{font-size:11.5px;padding:4px 6px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ba img{height:auto;max-height:360px;object-fit:contain;background:var(--surface-3)}
.ba .lbl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:4px 6px;color:var(--muted)}
.step-line{display:flex;align-items:center;gap:4px}.step-line>.step-row{flex:1;min-width:0}
.step-acts{display:flex;gap:2px;flex:none}
.iconbtn{width:28px;height:28px;display:inline-grid;place-items:center;border:1px solid transparent;border-radius:6px;background:none;color:var(--text-2);cursor:pointer;padding:0}
.iconbtn:hover{background:var(--surface-2);border-color:var(--border)}.iconbtn svg{width:15px;height:15px}
.iconbtn[aria-expanded=true] svg{transform:rotate(90deg)}
.step-body h4,.panel h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 0 6px}
.step-shots .shot img{height:180px}
.shot-big{display:block;padding:0;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-3);cursor:zoom-in;max-width:100%}.shot-big img{display:block;max-width:100%;max-height:520px}
.cmp-bar{display:flex;gap:6px;margin-bottom:8px}
.cmp-stage{position:relative;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;background:var(--surface-3);max-height:560px;overflow-y:auto}
.cmp-stage img{display:block;width:100%;height:auto}
.cmp-top{position:absolute;top:0;left:0;bottom:0;overflow:hidden;border-right:2px solid var(--accent);box-sizing:border-box}
.cmp-top img{max-width:none;height:auto}
.cmp-diff{position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;pointer-events:none}
.cmp-lbl{position:absolute;top:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;background:var(--surface);color:var(--text);padding:2px 6px;border-radius:4px;border:1px solid var(--border)}
.cmp-lbl.l{left:6px}.cmp-lbl.r{right:6px}
.cmp-tools{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px}.cmp-tools input[type=range]{width:220px;vertical-align:middle}
.snapframe{width:100%;height:420px;border:1px solid var(--border);border-radius:var(--r-sm);background:#fff;margin-top:6px}.snapframe.tall{height:820px}
.vwrap{position:relative}.vplayer{width:100%;max-height:560px;background:#000;border-radius:var(--r-sm);display:block}
.vmarks{position:relative;height:10px;margin:4px 0 0;background:var(--surface-3);border-radius:4px}
.vmark{position:absolute;top:1px;width:2px;height:8px;background:var(--muted)}.vmark.f{width:4px;top:0;height:10px;background:var(--st-failed)}
.vtools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}
.vchapters{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:5px}
.vchapters .fchip[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.vchapters .vfail{border-color:var(--st-failed);color:var(--ink-failed)}
.evb-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}.evb-tools input[type=search]{min-width:240px;flex:1}
.evb td{vertical-align:top}.ev-path{overflow-wrap:anywhere}.ev-meta{white-space:nowrap}.evb tbody tr{border-top:1px solid var(--grid)}
.evthumb{display:block;padding:0;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);cursor:zoom-in;width:72px;height:48px;overflow:hidden}
.evthumb img{width:100%;height:100%;object-fit:cover;object-position:left top;display:block}
.evkind{display:grid;place-items:center;width:72px;height:48px;border-radius:4px;background:var(--surface-3);color:var(--text-2);font-size:11px;font-weight:700;letter-spacing:.05em}
.evacts{display:flex;gap:6px;flex-wrap:wrap}.evacts .btn{min-width:32px;min-height:30px}.evb>.btn{margin-top:8px}
table.net td{vertical-align:middle}.net-url{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.net-bad td{background:var(--soft-failed)}
td.wf,th.wf{width:200px;min-width:140px}td.wf{position:relative}
.wf-bar{position:absolute;top:50%;height:8px;margin-top:-4px;background:var(--series-1);border-radius:3px;min-width:2px}.wf-bar.bad{background:var(--st-failed)}
.cmp-tools input[type=range],.vtools select{min-height:24px}.cmp-tools input[type=range]{height:24px}
.evb td a,.tbl-wrap td a{display:inline-block;min-height:24px;min-width:24px;line-height:24px}
.lb-in img.actual{max-width:none;max-height:none}
.lb-in{max-height:94vh;overflow:auto}
.spark{display:inline-flex;gap:2px;align-items:flex-end;vertical-align:middle}.spark i{display:block;width:6px;border-radius:2px}
.spark .P{height:14px;background:var(--st-passed)}.spark .H{height:14px;background:var(--st-healed)}.spark .F{height:14px;background:var(--st-failed)}
.attempts td.diff{color:var(--ink-failed);font-weight:600}
.lightbox{border:0;padding:0;background:transparent;max-width:96vw;max-height:96vh;color:var(--text)}
.lightbox::backdrop{background:rgba(0,0,0,.78)}
.lb-in{display:grid;gap:8px;background:var(--surface);padding:10px;border-radius:var(--r)}
.lb-in img{max-width:92vw;max-height:80vh;object-fit:contain;display:block;margin:0 auto;background:var(--surface-3)}
.lb-bar{display:flex;align-items:center;gap:8px}.lb-cap{flex:1;font-size:13px;color:var(--text-2)}
.int-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;align-items:start}
.int-card h3{display:flex;align-items:center;gap:8px}
.int-card .status{margin-left:auto}
.int-card ul{margin:6px 0 0;padding-left:18px}
.int-card .none{color:var(--muted);font-size:13px}
.links{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:13px}
.ctx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.cmp-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.cmp-cols ul{list-style:none;margin:0;padding:0;font-size:13px;max-height:260px;overflow:auto}.cmp-cols li{padding:4px 0;border-bottom:1px solid var(--grid)}
.cnt{font-size:22px;font-weight:650}
.copy-ok{color:var(--ink-passed);font-size:12px}
footer.foot{max-width:1440px;margin:0 auto;padding:16px 24px 32px;color:var(--muted);font-size:12px;display:flex;gap:16px;flex-wrap:wrap;justify-content:space-between}
.kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--surface-2)}
.banner{border:1px solid var(--st-flaky);background:var(--soft-flaky);color:var(--text);border-radius:var(--r-sm);padding:10px 12px;margin:0 0 14px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.mark,.key,.cell{forced-color-adjust:none}.badge,.chip,.fchip{border:1px solid CanvasText}}
@media print{
:root{--bg:#fff;--surface:#fff;--shadow:none}
body{font-size:11.5px;background:#fff}
.topbar{position:static;border:0}.sections,.top-actions,.ex-tools,.vlist,.viz-table summary,.no-print,.skip,#tests .explorer{display:none!important}
.viz-table[open] table{display:table}
main{padding:0;max-width:none}.card,.kpi{box-shadow:none;break-inside:avoid}
section.block{break-inside:auto}.block-head{break-after:avoid}
a{color:#000;text-decoration:none}
.print-only{display:block!important}
.tbl-wrap{max-height:none;overflow:visible}
}
.print-only{display:none}
/* failure categories, attention, quality, configuration */
.cat{display:inline-block;font-size:11px;font-weight:600;padding:0 7px;border-radius:9px;line-height:18px;white-space:nowrap;border:1px solid transparent}
.c-product{background:var(--soft-failed);color:var(--ink-failed);border-color:var(--st-failed)}
.c-test{background:var(--soft-healed);color:var(--ink-healed);border-color:var(--st-healed)}
.c-environment{background:var(--soft-error);color:var(--ink-error);border-color:var(--st-error)}
.c-data,.c-flaky{background:var(--soft-flaky);color:var(--ink-flaky);border-color:var(--st-flaky)}
.c-unknown{background:var(--soft-skipped);color:var(--ink-skipped);border-color:var(--st-skipped)}
.c-new{background:var(--surface);color:var(--ink-failed);border-color:var(--st-failed)}
.row .rtail{flex:none;display:flex;align-items:center;gap:6px}
.spark.sm i{width:4px}.spark.sm .P,.spark.sm .H,.spark.sm .F{height:10px}
.catbox{border:1px solid var(--border);border-left-width:4px;border-radius:var(--r-sm);padding:8px 10px;margin:8px 0 0;background:var(--surface-2)}
.catbox.c-product{border-left-color:var(--st-failed)}.catbox.c-test{border-left-color:var(--st-healed)}.catbox.c-environment{border-left-color:var(--st-error)}.catbox.c-data,.catbox.c-flaky{border-left-color:var(--st-flaky)}.catbox.c-unknown{border-left-color:var(--st-skipped)}
.catbox p{margin:6px 0 0}
.attn{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:14px 0}
.attn .card{padding:12px 14px}.attn h3{display:flex;align-items:baseline;gap:8px;font-size:13.5px}.attn h3 .cnt{font-size:20px}
.attn ul{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}.attn li{padding:3px 0;border-top:1px solid var(--grid);overflow-wrap:anywhere}
.attn li a{display:inline-block;min-height:24px;line-height:24px}
.clusters{list-style:none;margin:0;padding:0;display:grid;gap:12px}.clusters li{border-top:1px solid var(--grid);padding-top:10px}.clusters li:first-child{border-top:0;padding-top:0}.clusters .cl-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}.clusters pre{margin:6px 0}
.attn li .cat{margin-left:4px}
.fixline{font-size:12.5px;color:var(--text-2);margin:4px 0 0}
.q-counts{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}
.cfg-filter{margin:0 0 8px}.cfg-filter input{width:100%;max-width:360px;padding:5px 8px;border:1px solid var(--field);border-radius:var(--r-sm);background:var(--surface);color:var(--text)}
table.cfg td:first-child{white-space:nowrap}table.cfg td{word-break:break-word}
.g-features,.g-scenarios,.g-steps{list-style:none;padding-left:18px;margin:4px 0}.g-features{padding-left:0}.g-kw{font-weight:600}.g-step{margin:3px 0}.g-err{color:var(--ink-failed);margin-left:28px;white-space:pre-wrap}.g-feature>details>summary,.g-rule>details>summary,.g-scenario>details>summary{cursor:pointer;padding:3px 0}
`;
