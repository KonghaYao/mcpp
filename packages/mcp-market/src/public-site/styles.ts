/**
 * The Public Market design system: one hand-written stylesheet, inlined into
 * every document.
 *
 * It is the only place where the public surface decides how something looks.
 * Nothing is fetched — no font, no image, no stylesheet — because the Content
 * Security Policy has no `script-src`/`font-src` and the public read path must
 * survive with no runtime at all.
 *
 * The shared `THEME_TOKENS` are inherited, never redefined: they also dress the
 * Admin console. Everything this surface adds is namespaced `--m-*` so a public
 * redesign can never move the console.
 */

import { THEME_TOKENS } from "../html.ts";

export const PUBLIC_STYLES = `
${THEME_TOKENS}
:root {
  color-scheme:light;
  --m-max:1180px; --m-gutter:20px;
  --m-radius-sm:8px; --m-radius-md:12px; --m-radius-lg:16px;
  --m-shadow-soft:0 8px 28px rgba(20,24,35,.06);
  --m-shadow-card:0 18px 48px rgba(20,24,35,.08);
  --m-cobalt-hover:#254FD9; --m-cobalt-soft:#DDE6FF; --m-cobalt-line:#C7D2FE;
  --m-rule-strong:#D8DCE4;
  --m-ok:#23815F; --m-ok-soft:#E8F4EF;
  --m-caution-ink:#8A6A12; --m-caution-bg:#FFF9E8; --m-caution-line:#F0DFA9;
  --m-font-mono:ui-monospace, SFMono-Regular, Menlo, monospace;
  --m-tone-0-bg:#E8EEFF; --m-tone-0-ink:#24409E;
  --m-tone-1-bg:#E8F4EF; --m-tone-1-ink:#1F6B50;
  --m-tone-2-bg:#FFF3E2; --m-tone-2-ink:#8A5A12;
  --m-tone-3-bg:#F1ECFF; --m-tone-3-ink:#4B3A96;
  --m-tone-4-bg:#FDECEA; --m-tone-4-ink:#96372A;
  --m-tone-5-bg:#EAF3FA; --m-tone-5-ink:#1F5A7A;
}
.wrap { max-width:var(--m-max); margin-inline:auto; padding-inline:var(--m-gutter); }
.skip-link {
  position:absolute; left:-9999px; top:10px; z-index:20; padding:10px 16px;
  border-radius:var(--m-radius-sm); background:var(--ink); color:#fff;
  font-size:13px; text-decoration:none;
}
.skip-link:focus { left:16px; }
:focus-visible { outline:2px solid var(--cobalt); outline-offset:2px; }
.sr-only {
  position:absolute; width:1px; height:1px; margin:-1px; padding:0; border:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap;
}
main { display:block; padding-bottom:72px; }
.site-header {
  position:sticky; top:0; z-index:10; border-bottom:1px solid var(--line);
  background:rgba(255,255,255,.92); backdrop-filter:blur(14px);
}
.site-header .wrap { display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; padding-block:12px; }
.brand {
  display:inline-flex; align-items:center; gap:9px; min-width:0; font-size:17px;
  font-weight:600; letter-spacing:-.03em; text-decoration:none;
}
.brand-mark {
  display:grid; place-items:center; flex:none; width:30px; height:30px;
  border:1px solid var(--line); border-radius:9px; background:var(--ink);
  color:var(--paper); font-family:var(--m-font-mono); font-size:14px;
}
.brand-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.site-nav { display:flex; gap:4px; font-size:13px; }
.site-nav a { display:inline-flex; align-items:center; min-height:36px; padding:0 11px; border-radius:999px; text-decoration:none; }
.site-nav a:hover { background:var(--fog); color:var(--ink); }
.site-nav a[aria-current="page"] { background:var(--fog); color:var(--ink); font-weight:600; }
.site-search { display:flex; flex:1 1 100%; gap:8px; min-width:0; }
input[type=search], input[type=text] {
  flex:1 1 auto; min-width:0; border:1px solid var(--line); border-radius:var(--m-radius-md);
  padding:9px 12px; font-family:inherit; font-size:14px; background:#fff; color:var(--ink);
}
input[type=search]::placeholder { color:var(--muted); }
button {
  flex:none; min-height:44px; border:0; border-radius:var(--m-radius-md);
  background:var(--ink); color:#fff; padding:9px 18px; font-family:inherit;
  font-size:13px; font-weight:600; cursor:pointer;
}
button:hover { background:#000; }
.hero { position:relative; overflow:hidden; border-bottom:1px solid var(--line); background:var(--paper); }
.hero .wrap { position:relative; padding-block:40px 44px; }
.grid-paper {
  position:absolute; inset:0; opacity:.35; background-image:radial-gradient(rgba(23,25,28,.1) .65px, transparent .65px);
  background-size:18px 18px;
}
.hero-badge {
  display:inline-flex; align-items:center; gap:8px; margin:0; border:1px solid var(--line);
  border-radius:999px; background:#fff; padding:5px 12px; font-size:12px; color:var(--muted);
}
.hero-badge .dot { width:6px; height:6px; border-radius:50%; background:var(--cobalt); }
h1 { margin:20px 0 0; font-size:clamp(28px,4.6vw,44px); line-height:1.12; letter-spacing:-.045em; }
h2 { margin:0 0 12px; font-size:clamp(19px,2.4vw,26px); line-height:1.25; letter-spacing:-.03em; }
h3 { margin:0; font-size:16px; line-height:1.4; letter-spacing:-.01em; }
p { margin:0; }
.lede { max-width:68ch; font-size:15px; line-height:1.65; color:var(--muted); }
.hero .lede { margin-top:14px; }
.cta-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:26px; }
.cta {
  display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 20px;
  border:1px solid transparent; border-radius:var(--m-radius-md); background:var(--cobalt);
  color:#fff; font-size:14px; font-weight:600; text-decoration:none;
}
.cta:hover { background:var(--m-cobalt-hover); }
.cta.secondary { border-color:var(--line); background:#fff; color:var(--ink); }
.cta.secondary:hover { background:var(--fog); }
.band { border-bottom:1px solid var(--line); background:var(--paper); }
.band .wrap { display:flex; flex-wrap:wrap; gap:12px 32px; padding-block:18px; }
.band-item { display:flex; flex:1 1 200px; align-items:baseline; gap:8px; margin:0; }
.band-item strong { font-size:16px; letter-spacing:-.02em; }
.band-item span { font-size:12px; color:var(--muted); }
.section { padding-top:44px; }
.steps { display:grid; gap:1px; border:1px solid var(--line); border-radius:var(--m-radius-lg); background:var(--line); overflow:hidden; }
.step { padding:20px; background:#fff; }
.step-no { font-family:var(--m-font-mono); font-size:12px; color:var(--cobalt); }
.step h3 { margin-top:26px; font-size:17px; }
.step p { margin-top:8px; font-size:13px; line-height:1.6; color:var(--muted); }
.grid { display:grid; gap:16px; grid-template-columns:minmax(0,1fr); margin-top:20px; }
.card {
  display:flex; flex-direction:column; gap:8px; padding:16px; border:1px solid var(--line);
  border-radius:var(--m-radius-lg); background:var(--paper);
  transition:box-shadow .15s ease, transform .15s ease;
}
.card-head { display:flex; align-items:flex-start; gap:12px; }
.card-head .body { flex:1 1 auto; min-width:0; }
.card h3 { font-size:16px; }
.card h3 a { display:block; text-decoration:none; overflow-wrap:anywhere; }
.card h3 a:hover { color:var(--cobalt); }
.summary {
  display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;
  overflow:hidden; font-size:13.5px; line-height:1.55; color:var(--muted);
}
.name, .mono { font-family:var(--m-font-mono); font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.tone {
  display:grid; place-items:center; flex:none; width:40px; height:40px;
  border-radius:var(--m-radius-md); background:var(--fog); color:var(--ink);
  font-size:15px; font-weight:600;
}
.tone-0 { background:var(--m-tone-0-bg); color:var(--m-tone-0-ink); }
.tone-1 { background:var(--m-tone-1-bg); color:var(--m-tone-1-ink); }
.tone-2 { background:var(--m-tone-2-bg); color:var(--m-tone-2-ink); }
.tone-3 { background:var(--m-tone-3-bg); color:var(--m-tone-3-ink); }
.tone-4 { background:var(--m-tone-4-bg); color:var(--m-tone-4-ink); }
.tone-5 { background:var(--m-tone-5-bg); color:var(--m-tone-5-ink); }
.rig { display:flex; align-items:center; gap:8px; margin:0; font-size:12px; color:var(--muted); }
.rig-node { display:inline-flex; align-items:baseline; gap:4px; white-space:nowrap; }
.rig-node strong { font-family:var(--m-font-mono); font-size:13px; font-weight:600; color:var(--ink); }
.rig-link { display:flex; flex:1 1 24px; align-items:center; justify-content:center; min-width:24px; font-size:11px; color:var(--m-rule-strong); }
.rig-link::before, .rig-link::after {
  content:""; flex:1 1 auto; height:1px;
  background:repeating-linear-gradient(90deg,var(--m-rule-strong) 0 4px,transparent 4px 8px);
}
.rig--lg { margin-top:14px; font-size:13px; }
.rig--lg .rig-node strong { font-size:20px; }
.rig--lg .rig-link { min-width:56px; }
.meta-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; font-size:12px; color:var(--muted); }
.tag {
  display:inline-flex; align-items:center; min-height:26px; padding:2px 10px;
  border:1px solid var(--line); border-radius:999px; background:#fff;
  font-size:12px; color:var(--muted); text-decoration:none;
}
a.tag:hover { border-color:var(--m-cobalt-line); color:var(--cobalt); }
.tag.strong { border-color:var(--m-cobalt-line); background:var(--m-cobalt-soft); color:var(--cobalt); }
.chips { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:16px; }
.chips-label { margin:0; font-size:12px; color:var(--muted); }
.crumbs { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 14px; font-size:12px; color:var(--muted); }
.crumbs a { text-decoration:none; }
.crumbs a:hover { color:var(--cobalt); }
.crumbs .sep { color:var(--m-rule-strong); }
.panel { margin-top:20px; border:1px solid var(--line); border-radius:var(--m-radius-lg); background:#fff; padding:18px; }
.kv { display:grid; gap:10px; margin:0; font-size:13px; }
.kv dt { font-size:12px; color:var(--muted); }
.kv dd { margin:0; overflow-wrap:anywhere; }
.disclaimer { margin-top:12px; font-size:12px; line-height:1.6; color:var(--muted); }
.notice {
  margin-top:16px; padding:12px 14px; border:1px solid var(--m-caution-line);
  border-left:3px solid var(--coral); border-radius:var(--m-radius-sm);
  background:var(--m-caution-bg); color:var(--m-caution-ink); font-size:13px;
}
.empty { padding:28px 0; font-size:14px; color:var(--muted); }
.table-scroll { margin-top:12px; border:1px solid var(--line); border-radius:var(--m-radius-md); overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
caption { padding:12px 14px; text-align:left; font-size:12px; color:var(--muted); }
th, td { padding:10px 14px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
th { background:var(--fog); font-size:12px; font-weight:500; color:var(--muted); }
tbody tr:last-child td { border-bottom:0; }
.pager { display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; font-size:13px; }
.pager a {
  display:inline-flex; align-items:center; min-height:36px; padding:0 14px;
  border:1px solid var(--line); border-radius:999px; text-decoration:none;
}
.pager a:hover { border-color:var(--m-cobalt-line); color:var(--cobalt); }
.site-footer { border-top:1px solid var(--line); background:var(--paper); color:var(--muted); font-size:12px; }
.site-footer .wrap { display:flex; flex-wrap:wrap; gap:8px 24px; justify-content:space-between; padding-block:26px; }
.site-footer p { max-width:54ch; line-height:1.6; }
@media (min-width:640px) {
  :root { --m-gutter:28px; }
  .site-search { flex:1 1 240px; }
  .grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .kv { grid-template-columns:150px minmax(0,1fr); gap:8px 16px; }
  .hero .wrap { padding-block:56px 60px; }
  .section { padding-top:56px; }
}
@media (min-width:1024px) {
  .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .steps { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .section { padding-top:64px; }
  .hero .wrap { padding-block:76px 80px; }
}
@media (hover:hover) and (prefers-reduced-motion:no-preference) {
  .card:hover { transform:translateY(-2px); box-shadow:var(--m-shadow-card); }
}
@media (prefers-reduced-motion:reduce) {
  *, *::before, *::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; }
}
`;
