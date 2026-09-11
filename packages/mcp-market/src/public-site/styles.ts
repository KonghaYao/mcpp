/** Public Market visual system, inlined so the static read path has no runtime dependency. */

import { THEME_TOKENS } from "../html.ts";

export const PUBLIC_STYLES = `
${THEME_TOKENS}
:root {
  color-scheme:light;
  --m-max:1280px; --m-gutter:20px; --m-radius-sm:9px; --m-radius-md:13px; --m-radius-lg:20px;
  --m-shadow-soft:0 10px 30px rgba(27,35,58,.07); --m-shadow-card:0 24px 70px rgba(27,35,58,.12);
  --m-cobalt-hover:#254FD9; --m-cobalt-soft:#E5EBFF; --m-cobalt-line:#CAD5FF; --m-rule-strong:#D5D9E2;
  --m-ok:#23815F; --m-ok-soft:#E8F4EF; --m-caution-ink:#8A6A12; --m-caution-bg:#FFF9E8; --m-caution-line:#F0DFA9;
  --m-font-mono:ui-monospace, SFMono-Regular, Menlo, monospace;
  --m-tone-0-bg:#E8EEFF; --m-tone-0-ink:#24409E; --m-tone-1-bg:#E8F4EF; --m-tone-1-ink:#1F6B50;
  --m-tone-2-bg:#FFF3E2; --m-tone-2-ink:#8A5A12; --m-tone-3-bg:#F1ECFF; --m-tone-3-ink:#4B3A96;
  --m-tone-4-bg:#FDECEA; --m-tone-4-ink:#96372A; --m-tone-5-bg:#EAF3FA; --m-tone-5-ink:#1F5A7A;
}
.wrap { width:100%; max-width:var(--m-max); margin-inline:auto; padding-inline:var(--m-gutter); }
.skip-link { position:absolute; left:-9999px; top:10px; z-index:20; padding:10px 16px; border-radius:9px; background:var(--ink); color:#fff; font-size:13px; text-decoration:none; }
.skip-link:focus { left:16px; }
:focus-visible { outline:2px solid var(--cobalt); outline-offset:3px; }
.sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; border:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
main { display:block; min-height:calc(100vh - 150px); padding-bottom:80px; }
p { margin:0; }
h1,h2,h3 { color:var(--ink); }
.site-header { position:sticky; top:0; z-index:10; border-bottom:1px solid rgba(231,233,238,.92); background:rgba(255,255,255,.9); backdrop-filter:blur(18px); }
.site-header .wrap { min-height:64px; display:flex; align-items:center; gap:18px; }
.brand { display:inline-flex; align-items:center; gap:10px; flex:none; font-size:16px; font-weight:650; letter-spacing:-.03em; text-decoration:none; }
.brand-image { width:32px; height:32px; border:1px solid #DDE1EA; border-radius:9px; object-fit:cover; box-shadow:0 4px 14px rgba(49,92,236,.13); }
.brand-mark { display:grid; place-items:center; width:32px; height:32px; border:1px solid #DDE1EA; border-radius:9px; background:linear-gradient(145deg,#1C2130,#315CEC); color:#fff; font-family:var(--m-font-mono); font-size:13px; box-shadow:0 4px 14px rgba(49,92,236,.16); }
.site-nav { align-self:stretch; display:flex; align-items:center; gap:3px; }
.site-nav a { position:relative; display:inline-flex; align-items:center; height:100%; padding:0 14px; color:var(--muted); font-size:13px; text-decoration:none; }
.site-nav a:hover,.site-nav a[aria-current="page"] { color:var(--ink); }
.site-nav a[aria-current="page"]::after { position:absolute; left:50%; bottom:0; width:20px; height:3px; border-radius:9px; background:var(--ink); transform:translateX(-50%); content:""; }
.search-trigger { margin-left:auto; min-width:82px; }
.search-dialog { width:min(760px,calc(100vw - 32px)); max-height:min(720px,calc(100vh - 48px)); border:1px solid var(--line); border-radius:20px; padding:0; background:#fff; color:var(--ink); box-shadow:0 30px 100px rgba(18,24,43,.24); }
.search-dialog::backdrop { background:rgba(19,23,34,.42); backdrop-filter:blur(5px); }
.search-dialog-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:26px 28px 18px; }
.search-dialog-head h2 { margin-top:5px; }
.search-close { width:40px; padding:0; border:1px solid var(--line); background:#fff; color:var(--ink); font-size:24px; line-height:1; }
.dialog-search-form { display:flex; gap:8px; padding:0 28px 18px; }
.dialog-search-form input { height:46px; }
.search-status { border-top:1px solid var(--line); padding:16px 28px; color:var(--muted); font-size:12px; }
.search-results { display:grid; gap:10px; max-height:420px; overflow:auto; padding:0 28px 28px; }
.search-result { display:block; border:1px solid var(--line); border-radius:13px; padding:15px 16px; text-decoration:none; transition:border-color .15s ease,transform .15s ease; }
.search-result:hover { border-color:var(--m-cobalt-line); transform:translateY(-1px); }
.search-result strong { display:block; margin-bottom:3px; font-size:15px; }
.search-result span { display:block; color:var(--muted); font-size:12px; }
.search-result small { display:inline-block; margin-top:8px; color:var(--cobalt); font-size:10px; font-weight:700; letter-spacing:.08em; }
.search-empty { padding:22px 0; color:var(--muted); text-align:center; }
body:has(.search-dialog[open]) { overflow:hidden; }
input[type=search],input[type=text] { width:100%; min-width:0; height:40px; border:1px solid transparent; border-radius:12px; padding:0 13px; background:var(--fog); color:var(--ink); font:inherit; font-size:13px; }
input[type=search]:focus,input[type=text]:focus { border-color:var(--m-cobalt-line); background:#fff; box-shadow:0 0 0 3px rgba(49,92,236,.09); }
button { flex:none; min-height:40px; border:0; border-radius:11px; padding:8px 15px; background:var(--ink); color:#fff; font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
.hero { position:relative; overflow:hidden; border-bottom:1px solid var(--line); background:#fff; }
.grid-paper { position:absolute; inset:0; opacity:.32; background-image:radial-gradient(rgba(23,25,28,.12) .65px,transparent .65px); background-size:18px 18px; }
.hero-grid { position:relative; display:grid; align-items:center; min-height:650px; gap:56px; padding-block:76px; }
.hero-copy { position:relative; z-index:1; }
.hero-badge { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line); border-radius:999px; padding:6px 12px; background:#fff; color:var(--muted); font-size:10px; font-weight:650; box-shadow:0 3px 12px rgba(20,24,35,.04); }
.hero-badge .dot { width:6px; height:6px; border-radius:50%; background:var(--cobalt); }
h1 { margin:22px 0 0; font-size:clamp(36px,5.4vw,68px); line-height:1.04; letter-spacing:-.062em; }
.hero h1 span { color:var(--cobalt); }
h2 { margin:0 0 12px; font-size:clamp(21px,2.4vw,28px); line-height:1.2; letter-spacing:-.035em; }
h3 { margin:0; font-size:16px; line-height:1.4; letter-spacing:-.015em; }
.lede { max-width:68ch; color:var(--muted); font-size:15px; line-height:1.75; }
.hero .lede { max-width:560px; margin-top:22px; }
.cta-row,.empty-actions { display:flex; flex-wrap:wrap; gap:11px; margin-top:28px; }
.cta { display:inline-flex; align-items:center; gap:9px; min-height:46px; padding:0 20px; border:1px solid transparent; border-radius:12px; background:var(--cobalt); color:#fff; font-size:13px; font-weight:650; text-decoration:none; transition:transform .18s ease,box-shadow .18s ease,background .18s ease; }
.cta:hover { background:var(--m-cobalt-hover); transform:translateY(-1px); box-shadow:0 12px 30px rgba(49,92,236,.2); }
.cta.secondary { border-color:var(--line); background:#fff; color:var(--ink); }
.cta.secondary:hover { border-color:#CCD0D9; box-shadow:var(--m-shadow-soft); }
.trust-points { display:flex; flex-wrap:wrap; gap:12px 24px; margin-top:34px; color:var(--muted); font-size:10px; }
.trust-points span { display:flex; align-items:center; gap:8px; }
.trust-points span::before { width:5px; height:5px; border-radius:50%; background:var(--m-ok); content:""; }
.hero-stage { position:relative; min-width:0; }
.stage-canvas { position:relative; min-height:420px; overflow:hidden; border:1px solid var(--line); border-radius:28px; background:linear-gradient(145deg,#F6F8FF,#EDF1FB 48%,#FBF7F3); box-shadow:var(--m-shadow-card); }
.stage-canvas::before,.stage-canvas::after { position:absolute; border:1px solid rgba(49,92,236,.13); border-radius:50%; content:""; }
.stage-canvas::before { width:420px; height:420px; right:-110px; top:-170px; }
.stage-canvas::after { width:300px; height:300px; left:-130px; bottom:-160px; }
.stage-task,.stage-result,.stage-node { position:absolute; z-index:2; border:1px solid rgba(220,224,234,.9); background:rgba(255,255,255,.91); box-shadow:var(--m-shadow-soft); backdrop-filter:blur(12px); }
.stage-task { left:24px; top:24px; padding:12px 14px; border-radius:13px; }
.stage-task small,.stage-result small,.stage-node span { display:block; color:var(--muted); font-size:9px; letter-spacing:.04em; }
.stage-task strong,.stage-node strong { display:block; margin-top:3px; font-size:11px; }
.stage-node { width:150px; padding:14px; border-radius:15px; }
.stage-node-a { left:16%; top:42%; }
.stage-node-b { right:12%; top:30%; }
.stage-node span { color:var(--cobalt); font-family:var(--m-font-mono); font-size:8px; font-weight:700; }
.stage-path { position:absolute; left:32%; right:25%; top:49%; height:1px; border-top:1px dashed rgba(49,92,236,.45); transform:rotate(-10deg); }
.stage-result { left:24px; right:24px; bottom:24px; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:12px; padding:15px; border-radius:17px; }
.stage-result i { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; background:var(--m-ok-soft); color:var(--m-ok); font-style:normal; font-weight:700; }
.stage-result strong { display:block; font-size:12px; }
.stage-result b { border-radius:99px; padding:7px 10px; background:var(--fog); color:var(--muted); font-size:9px; font-weight:500; }
.band { border-bottom:1px solid var(--line); background:var(--paper); }
.stat-band { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
.band-item { padding:22px 18px; border-right:1px solid var(--line); }
.band-item:nth-child(2n) { border-right:0; }
.band-item strong { display:block; font-size:19px; letter-spacing:-.035em; }
.band-item span { display:block; margin-top:2px; color:var(--muted); font-size:10px; }
.section { padding-top:62px; }
.steps { display:grid; gap:1px; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:var(--line); }
.step { min-height:170px; padding:22px; background:#fff; }
.step-no,.eyebrow { color:var(--cobalt); font-family:var(--m-font-mono); font-size:10px; font-weight:650; letter-spacing:.13em; }
.step h3 { margin-top:28px; }
.step p { margin-top:8px; color:var(--muted); font-size:13px; line-height:1.65; }
.market-shell { padding-top:26px; }
.market-intro { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:18px; }
.market-intro h1 { margin-top:5px; font-size:clamp(24px,3vw,32px); letter-spacing:-.045em; }
.market-intro>p { max-width:420px; color:var(--muted); font-size:11px; text-align:right; }
.scene-rail { position:relative; margin-right:calc(var(--m-gutter) * -1); }
.scene-rail::after { position:absolute; top:0; right:0; bottom:0; z-index:3; width:88px; pointer-events:none; background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.82) 68%,#fff); content:""; }
.scene-grid { display:grid; grid-auto-flow:column; grid-auto-columns:clamp(280px,31vw,390px); grid-template-rows:repeat(2,126px); gap:10px; padding:0 88px 12px 0; overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-color:var(--m-rule-strong) var(--fog); scrollbar-width:thin; scroll-snap-type:x proximity; }
.scene-grid::-webkit-scrollbar { height:8px; }
.scene-grid::-webkit-scrollbar-track { border-radius:999px; background:var(--fog); }
.scene-grid::-webkit-scrollbar-thumb { border:2px solid var(--fog); border-radius:999px; background:var(--m-rule-strong); }
.scene-card { position:relative; min-height:126px; overflow:hidden; border:1px solid var(--line); border-radius:15px; background:#F5F7FA; color:var(--ink); text-decoration:none; isolation:isolate; scroll-snap-align:start; }
.scene-card::after { position:absolute; inset:0; z-index:1; background:linear-gradient(90deg,rgba(255,255,255,.94),rgba(255,255,255,.72) 48%,rgba(255,255,255,.08) 82%); content:""; }
.scene-card img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .32s ease; }
.scene-card span { position:absolute; left:16px; right:12px; bottom:14px; z-index:2; }
.scene-card strong,.scene-card small { display:block; }.scene-card strong { font-size:14px; }.scene-card small { margin-top:2px; color:var(--muted); font-size:9px; }
.catalogue-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; }
.catalogue-head h2,.catalogue-head h1 { margin-top:4px; margin-bottom:0; }
.catalogue-head h1 { font-size:clamp(32px,4vw,48px); letter-spacing:-.05em; }
.catalogue-head .lede { max-width:520px; font-size:13px; line-height:1.65; text-align:right; }
.catalogue-section { padding-top:38px; }
.catalogue-head h2 span,.catalogue-head h1 span { display:inline-grid; place-items:center; min-width:24px; height:24px; margin-left:6px; border-radius:999px; background:var(--fog); color:var(--muted); font-family:var(--m-font-mono); font-size:11px; vertical-align:3px; }
.section-empty { margin-top:18px; padding:26px; border:1px dashed var(--line); border-radius:15px; background:var(--paper); color:var(--muted); font-size:13px; text-align:center; }
.market-head { border-bottom:1px solid var(--line); background:linear-gradient(180deg,#FAFBFF,#fff); }
.grid { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; margin-top:24px; }
.card { display:grid; grid-template-columns:148px minmax(0,1fr); min-height:220px; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:#fff; transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease; }
.card-visual { min-height:100%; background:var(--fog); }
.card-artwork { display:block; width:100%; height:100%; min-height:220px; object-fit:cover; }
.card-content { display:flex; min-width:0; flex-direction:column; padding:22px 24px 18px; }
.card-kind { margin-bottom:8px; color:var(--cobalt); font-size:10px; font-weight:700; letter-spacing:.1em; }
.card h3 { font-size:19px; line-height:1.32; }
.card h3 a { display:block; text-decoration:none; overflow-wrap:break-word; word-break:normal; }
.card h3 a:hover { color:var(--cobalt); }
.summary { display:-webkit-box; max-width:60ch; margin-top:9px; overflow:hidden; color:var(--muted); font-size:13px; line-height:1.65; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.capability-list { display:flex; flex-wrap:wrap; gap:8px 18px; margin:18px 0 0; padding:0; list-style:none; color:var(--ink); font-size:12px; font-weight:600; }
.capability-list li { display:flex; align-items:center; gap:7px; }
.capability-list li::before { width:6px; height:6px; border-radius:50%; background:var(--cobalt); content:""; }
.card-meta { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:auto; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-family:var(--m-font-mono); font-size:10px; }
.card-meta .name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.connector-card { position:relative; display:block; min-height:214px; }
.connector-card .card-visual { position:absolute; top:22px; left:22px; width:48px; min-height:0; }
.connector-card .tone { width:48px; height:48px; min-height:0; border-radius:14px; font-size:15px; }
.connector-card .card-content { min-height:214px; padding:22px 24px 18px; }
.connector-card .card-kind,.connector-card h3 { margin-left:64px; }
.connector-card .summary { margin-top:18px; }
.connector-card .capability-list { margin-top:14px; }
.connector-card .card-meta { width:100%; }
.name,.mono { color:var(--muted); font-family:var(--m-font-mono); font-size:11px; overflow-wrap:break-word; word-break:normal; }
.tone { display:grid; place-items:center; width:100%; height:100%; min-height:220px; border-radius:0; background:var(--fog); font-size:28px; font-weight:650; }
.tone-0 { background:var(--m-tone-0-bg); color:var(--m-tone-0-ink); }.tone-1 { background:var(--m-tone-1-bg); color:var(--m-tone-1-ink); }
.tone-2 { background:var(--m-tone-2-bg); color:var(--m-tone-2-ink); }.tone-3 { background:var(--m-tone-3-bg); color:var(--m-tone-3-ink); }
.tone-4 { background:var(--m-tone-4-bg); color:var(--m-tone-4-ink); }.tone-5 { background:var(--m-tone-5-bg); color:var(--m-tone-5-ink); }
.rig { display:flex; align-items:center; gap:8px; margin:auto 0 0; color:var(--muted); font-size:11px; }
.rig-node { display:inline-flex; align-items:baseline; gap:4px; white-space:nowrap; }.rig-node strong { color:var(--ink); font-family:var(--m-font-mono); font-size:12px; }
.rig-link { display:flex; min-width:24px; flex:1; align-items:center; justify-content:center; color:var(--m-rule-strong); }
.rig-link::before,.rig-link::after { height:1px; flex:1; background:repeating-linear-gradient(90deg,var(--m-rule-strong) 0 4px,transparent 4px 8px); content:""; }
.rig--lg { margin-top:14px; font-size:13px; }.rig--lg .rig-node strong { font-size:20px; }.rig--lg .rig-link { min-width:56px; }
.meta-row { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:10px; color:var(--muted); font-size:11px; }
.tag { display:inline-flex; align-items:center; min-height:25px; padding:2px 9px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:11px; text-decoration:none; }
a.tag:hover { border-color:var(--m-cobalt-line); color:var(--cobalt); }.tag.strong { border-color:var(--m-cobalt-line); background:var(--m-cobalt-soft); color:var(--cobalt); }
.chips { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:16px; }.chips-label { color:var(--muted); font-size:11px; }
.empty-state { max-width:760px; margin:38px auto 10px; padding:54px 28px; border:1px solid var(--line); border-radius:24px; background:linear-gradient(145deg,#fff,#F8F9FD); text-align:center; box-shadow:var(--m-shadow-soft); }
.empty-state h2 { margin-top:10px; font-size:clamp(24px,3vw,34px); }.empty-state>p:not(.eyebrow) { max-width:540px; margin:0 auto; color:var(--muted); font-size:14px; line-height:1.7; }
.empty-actions { justify-content:center; margin-top:24px; }
.empty-orbit { position:relative; width:112px; height:72px; margin:0 auto 25px; }
.empty-orbit::before { position:absolute; left:20px; right:20px; top:35px; border-top:1px dashed var(--m-cobalt-line); content:""; }
.empty-orbit span,.empty-orbit i,.empty-orbit b { position:absolute; display:block; border-radius:13px; box-shadow:0 7px 20px rgba(49,92,236,.12); }
.empty-orbit span { left:0; top:18px; width:38px; height:38px; background:var(--m-cobalt-soft); }.empty-orbit i { left:45px; top:0; width:26px; height:26px; background:#fff; border:1px solid var(--line); }.empty-orbit b { right:0; bottom:0; width:42px; height:42px; background:var(--m-ok-soft); }
.crumbs { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 24px; color:var(--muted); font-size:12px; }.crumbs a { text-decoration:none; }.crumbs a:hover { color:var(--cobalt); }.crumbs .sep { color:var(--m-rule-strong); }
.detail-page { padding-top:40px; padding-bottom:72px; }
.detail-page .crumbs { margin-bottom:28px; }
.detail-header { max-width:880px; }
.detail-header h1 { max-width:20ch; margin:0; font-size:clamp(30px,3.5vw,46px); line-height:1.12; }
.detail-header>.lede { margin-top:14px; }
.detail-header>.meta-row { margin-top:16px; }
.detail-page>.rig--lg { margin:28px 0 0; }
.detail-page>.notice { margin-top:24px; }
.detail-section { margin-top:44px; }
.detail-columns { display:grid; grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr); align-items:start; gap:20px; margin-top:44px; }
.detail-columns>.detail-section { min-width:0; margin-top:0; }
.detail-columns>.detail-section:only-child { grid-column:1/-1; }
.detail-columns .source-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
.detail-columns .source-grid>div { border-right:1px solid var(--line); }
.detail-columns .source-grid>div:nth-child(2n) { border-right:0; }
.detail-columns .source-integrity { grid-column:1/-1; border-right:0; }
.detail-columns>.source-section:only-child .source-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
.detail-columns>.source-section:only-child .source-grid>div:nth-child(2n) { border-right:1px solid var(--line); }
.detail-columns>.source-section:only-child .source-grid>div:nth-child(3n) { border-right:0; }
.detail-section>h2 { margin:0 0 14px; }
.detail-section>.table-scroll { margin-top:0; }
.section-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:14px; }
.section-heading h2 { margin:0; }
.section-heading .lede { margin:0; font-size:12px; }
.source-panel { padding:0; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:#fff; }
.source-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:0; }
.source-grid>div { min-width:0; padding:16px 18px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
.source-grid>div:nth-child(3n) { border-right:0; }
.source-grid dt { margin-bottom:5px; color:var(--muted); font-size:10px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; }
.source-grid dd { margin:0; overflow-wrap:anywhere; font-size:13px; }
.source-integrity { grid-column:1/-1; border-right:0!important; }
.source-link,.source-panel .disclaimer { margin:0; padding:13px 18px; }
.source-link { border-bottom:1px solid var(--line); font-size:12px; }
.source-panel .disclaimer { color:var(--muted); font-size:11px; }
.member-list { margin:0; padding:0; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:#fff; list-style:none; }
.member-item { display:grid; grid-template-columns:42px minmax(0,1fr) minmax(110px,auto); align-items:center; gap:14px; padding:15px 18px; border-bottom:1px solid var(--line); }
.member-item:last-child { border-bottom:0; }
.member-avatar { display:grid; place-items:center; width:42px; height:42px; border-radius:12px; background:var(--fog); font-size:13px; font-weight:700; }
.member-copy strong { font-size:14px; }
.member-copy p { margin-top:3px; color:var(--muted); font-size:12px; line-height:1.5; }
.skill-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:0; padding:0; list-style:none; }
.skill-item { min-width:0; padding:16px 18px; border:1px solid var(--line); border-radius:14px; background:#fff; }
.skill-item strong { font-size:14px; }
.skill-item p { margin-top:4px; color:var(--muted); font-size:12px; line-height:1.55; }
.skill-item code { display:block; margin-top:12px; overflow-wrap:anywhere; color:var(--muted); font-family:var(--m-font-mono); font-size:9px; }
.member-id { color:var(--muted); font-family:var(--m-font-mono); font-size:10px; text-align:right; }
.server-action { min-width:128px; text-align:right; white-space:nowrap; }
.server-action button { min-height:34px; padding:0 12px; font-size:11px; }
.server-action .copy-status { display:inline-block; min-width:0; margin-left:6px; color:var(--muted); font-size:11px; }
.panel { margin-top:20px; padding:20px; border:1px solid var(--line); border-radius:18px; background:#fff; }.kv { display:grid; gap:10px; margin:0; font-size:13px; }.kv dt { color:var(--muted); font-size:12px; }.kv dd { margin:0; overflow-wrap:anywhere; }
.disclaimer { margin-top:12px; color:var(--muted); font-size:12px; line-height:1.6; }.notice { margin-top:16px; padding:12px 14px; border:1px solid var(--m-caution-line); border-left:3px solid var(--coral); border-radius:9px; background:var(--m-caution-bg); color:var(--m-caution-ink); font-size:13px; }
.empty { padding:28px 0; color:var(--muted); font-size:14px; }.table-scroll { margin-top:12px; overflow-x:auto; border:1px solid var(--line); border-radius:13px; }
table { width:100%; border-collapse:collapse; font-size:13px; }caption { padding:12px 14px; text-align:left; color:var(--muted); font-size:12px; }th,td { padding:10px 14px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }th { background:var(--fog); color:var(--muted); font-size:12px; font-weight:500; }tbody tr:last-child td { border-bottom:0; }
.pager { display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; font-size:13px; }.pager a { display:inline-flex; align-items:center; min-height:36px; padding:0 14px; border:1px solid var(--line); border-radius:999px; text-decoration:none; }
.site-footer { border-top:1px solid var(--line); background:var(--paper); color:var(--muted); font-size:11px; }.site-footer .wrap { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px 24px; padding-block:26px; }.site-footer p { max-width:54ch; line-height:1.6; }
@media (min-width:900px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.card { grid-template-columns:132px minmax(0,1fr); } }
@media (max-width:560px) { .scene-grid { grid-auto-columns:78vw; grid-template-rows:repeat(2,112px); }.scene-card { min-height:112px; }.scene-rail::after { width:56px; }.scene-grid { padding-right:56px; }.card { grid-template-columns:96px minmax(0,1fr); min-height:190px; }.card-artwork,.tone { min-height:190px; }.card-content { padding:17px 16px 14px; }.card h3 { font-size:16px; }.summary { -webkit-line-clamp:3; }.capability-list { margin-top:13px; gap:6px 12px; }.card-meta { align-items:flex-start; flex-direction:column; gap:4px; padding-top:13px; }.card-meta .name { width:100%; }.connector-card { display:block; min-height:196px; }.connector-card .card-visual { top:17px; left:16px; }.connector-card .tone { width:48px; height:48px; min-height:0; }.connector-card .card-content { min-height:196px; padding:17px 16px 14px; }.connector-card .card-kind,.connector-card h3 { margin-left:60px; }.connector-card .summary { margin-top:15px; } }
@media (min-width:640px) { :root { --m-gutter:28px; }.kv { grid-template-columns:150px minmax(0,1fr); gap:8px 16px; }.stat-band { grid-template-columns:repeat(4,minmax(0,1fr)); }.band-item:nth-child(2) { border-right:1px solid var(--line); }.band-item:last-child { border-right:0; } }
@media (min-width:900px) { .hero-grid { grid-template-columns:.84fr 1.16fr; }.steps { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (min-width:1200px) { .scene-grid { grid-auto-columns:390px; } }
@media (max-width:720px) { .site-header .wrap { padding-block:10px; }.site-nav { height:44px; }.search-trigger { margin-left:auto; }.search-dialog { width:calc(100vw - 20px); max-height:calc(100vh - 20px); }.search-dialog-head { padding:22px 20px 16px; }.dialog-search-form { padding:0 20px 16px; }.search-status { padding:14px 20px; }.search-results { padding:0 20px 20px; }.hero-grid { min-height:0; padding-block:52px; }.stage-canvas { min-height:330px; }.stage-result b { display:none; }.market-intro,.catalogue-head,.section-heading { align-items:flex-start; flex-direction:column; }.market-intro>p,.catalogue-head .lede { text-align:left; }.detail-page { padding-top:28px; padding-bottom:52px; }.detail-page .crumbs { margin-bottom:22px; }.detail-header>.lede { margin-top:12px; }.detail-header>.meta-row { margin-top:14px; }.detail-page>.rig--lg { margin-top:22px; }.detail-section,.detail-columns { margin-top:36px; }.detail-columns { grid-template-columns:1fr; }.source-grid,.detail-columns .source-grid,.detail-columns>.source-section:only-child .source-grid { grid-template-columns:1fr; }.source-grid>div,.detail-columns .source-grid>div,.detail-columns>.source-section:only-child .source-grid>div { border-right:0; }.member-item { grid-template-columns:42px minmax(0,1fr); }.member-id { grid-column:2; text-align:left; }.skill-list { grid-template-columns:1fr; } }
@media (hover:hover) and (prefers-reduced-motion:no-preference) { .card:hover { transform:translateY(-3px); border-color:#D7DBE5; box-shadow:var(--m-shadow-card); } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; } }
`;
