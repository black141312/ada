// The analytics dashboard, served by the backend at /admin/analytics. One self-contained HTML
// string, zero dependencies, dark instrument-panel styling to match the product. The page holds no
// data and no secrets: it asks for the operator's admin key (kept in localStorage) and renders
// whatever GET /v1/admin/analytics returns, so it can be cached, curl'd, or proxied freely.
//
// Chart colors are not decoration: #9085e9 (violet) and #c98500 (amber) are validated steps for
// this surface (CVD-separated, ≥3:1 contrast); the neutral #3f424d appears only as a labeled state,
// never as an unlabeled data mark. Single-series charts carry no legend — the title names them.
export const ANALYTICS_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Ada — analytics</title>
<style>
  :root { --void:#0e1019; --panel:#161826; --panel2:#1a1c2b; --line:#2a2d3f; --ink:#e9e9ed; --ink2:#b2b6ca; --dim:#75798c;
          --s1:#9085e9; --s2:#c98500; --neutral:#3f424d; --good:#4ade80;
          --mono:ui-monospace,'JetBrains Mono',Consolas,monospace; --sans:system-ui,-apple-system,'Inter',sans-serif; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--void); color:var(--ink); font:14px/1.6 var(--sans); }
  header { display:flex; align-items:center; gap:14px; padding:18px 28px; border-bottom:1px solid var(--line); }
  header .mk { font:600 14px var(--mono); color:var(--s1); letter-spacing:.1em; }
  header h1 { font:600 15px var(--sans); margin:0; }
  header .spacer { flex:1; }
  .range { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:2px; background:var(--panel); }
  .range button { font:500 11px var(--mono); letter-spacing:.06em; color:var(--dim); background:none; border:0; border-radius:999px; padding:6px 14px; cursor:pointer; }
  .range button.on { color:var(--ink); background:var(--panel2); }
  main { max-width:1080px; margin:0 auto; padding:26px 28px 80px; }
  .gate { max-width:420px; margin:12vh auto; text-align:center; }
  .gate input { width:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--ink); padding:10px 12px; font:13px var(--mono); margin:14px 0 10px; }
  .gate button { width:100%; background:var(--s1); color:var(--void); border:0; border-radius:8px; padding:11px; font:600 14px var(--sans); cursor:pointer; }
  .gate .err { color:#e66767; font-size:13px; min-height:18px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:0 0 22px; }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .tile .k { font:500 10.5px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--dim); }
  .tile .v { font:600 26px/1.2 var(--sans); letter-spacing:-.01em; margin-top:4px; font-variant-numeric:tabular-nums; }
  .tile .s { font:400 11px var(--mono); color:var(--dim); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:860px){ .grid2 { grid-template-columns:1fr; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 14px; }
  .card h2 { font:500 11px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--dim); margin:0 0 12px; }
  svg text { font:10.5px var(--mono); fill:var(--dim); }
  .bars .row { display:grid; grid-template-columns:minmax(90px,1fr) 3fr 70px; gap:10px; align-items:center; font-size:12.5px; padding:4px 0; }
  .bars .name { color:var(--ink2); font-family:var(--mono); font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bars .track { display:block; height:14px; border-radius:4px; background:var(--panel2); overflow:hidden; }
  .bars .fill { display:block; height:100%; border-radius:4px 0 0 4px; background:var(--s1); min-width:2px; }
  .bars .val { text-align:right; color:var(--ink2); font-family:var(--mono); font-size:11px; }
  .hours { display:grid; grid-template-columns:repeat(24,1fr); gap:3px; align-items:end; height:110px; }
  .hcol { display:flex; flex-direction:column; justify-content:flex-end; height:100%; }
  .hbar { background:var(--s1); border-radius:3px 3px 0 0; min-height:2px; }
  .hlab { text-align:center; font-family:var(--mono); font-size:9.5px; color:var(--ink2); padding-top:4px; height:14px; }
  .note { color:var(--ink2); font-size:11.5px; margin:10px 0 0; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; font:500 10.5px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--dim); padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:7px 8px; border-bottom:1px solid var(--line); color:var(--ink2); font-variant-numeric:tabular-nums; }
  td.num { text-align:right; font-family:var(--mono); font-size:11.5px; }
  .pill { display:inline-block; font:500 10px var(--mono); letter-spacing:.06em; text-transform:uppercase; border-radius:999px; padding:2px 8px; background:var(--panel2); border:1px solid var(--line); color:var(--ink2); }
  .insights li { margin:0 0 10px; padding:10px 12px 10px 14px; border-left:3px solid var(--line); background:var(--panel2); border-radius:0 8px 8px 0; list-style:none; color:var(--ink2); }
  .insights li.warn { border-left-color:var(--s2); }
  .insights li.good { border-left-color:var(--good); }
  .insights li.info { border-left-color:var(--s1); }
  .insights ul { margin:0; padding:0; }
  #tip { position:fixed; pointer-events:none; background:var(--panel2); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font:11px var(--mono); color:var(--ink); display:none; z-index:9; }
  .empty { color:var(--dim); font-size:12.5px; }
</style>
<header>
  <span class="mk">&gt;&thinsp;&lt;</span><h1>Ada analytics</h1><span class="spacer"></span>
  <div class="range" id="range" style="display:none">
    <button data-d="7">7d</button><button data-d="30" class="on">30d</button><button data-d="90">90d</button>
  </div>
</header>
<main id="main"></main>
<div id="tip"></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n));
let days = 30;

function gate(msg) {
  $('main').innerHTML = '<div class="gate"><p class="mk" style="color:var(--s1);font-family:var(--mono)">&gt;&thinsp;&lt; analytics</p>' +
    '<p style="color:var(--ink2)">Enter the analytics password (or an admin key) to view the dashboard.</p>' +
    '<input id="key" type="password" placeholder="analytics password" value="">' +
    '<p class="err">' + esc(msg || '') + '</p><button id="go">View analytics</button></div>';
  $('go').onclick = () => { localStorage.setItem('ada.adminKey', $('key').value.trim()); load(); };
  $('key').onkeydown = (e) => { if (e.key === 'Enter') $('go').onclick(); };
}

// Single series → no legend; the card title names it. Area fill kept faint so the line stays the mark.
function lineChart(daily) {
  const W = 1020, H = 180, P = { l: 46, r: 10, t: 12, b: 22 };
  const xs = daily.length > 1 ? daily.length - 1 : 1;
  const max = Math.max(1, ...daily.map((d) => d.tokens));
  const X = (i) => P.l + (i / xs) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  const pts = daily.map((d, i) => X(i).toFixed(1) + ',' + Y(d.tokens).toFixed(1)).join(' ');
  const gridY = [0, 0.5, 1].map((f) => { const v = max * f; return '<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+Y(v)+'" y2="'+Y(v)+'" stroke="var(--line)" stroke-width="1"/>' +
    '<text x="'+(P.l-6)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+fmt(v)+'</text>'; }).join('');
  const lab = (i) => '<text x="'+X(i)+'" y="'+(H-6)+'" text-anchor="middle">'+daily[i].date.slice(5)+'</text>';
  const xLabels = daily.length ? [0, Math.floor(daily.length/2), daily.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(lab).join('') : '';
  return '<svg id="line" viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto" role="img" aria-label="Tokens per day">' + gridY + xLabels +
    '<polyline points="'+pts+'" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>' +
    '<polygon points="'+P.l+','+Y(0)+' '+pts+' '+(W-P.r)+','+Y(0)+'" fill="var(--s1)" opacity="0.08"/></svg>';
}

function wireLineHover(daily) {
  const svg = $('line'); if (!svg || !daily.length) return;
  const tip = $('tip');
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left - r.width * 0.045) / (r.width * 0.94)));
    const d = daily[Math.round(frac * (daily.length - 1))];
    if (!d) return;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 12) + 'px';
    tip.style.top = (e.clientY - 34) + 'px';
    tip.textContent = d.date + ' — ' + fmt(d.tokens) + ' tok · ' + d.requests + ' req · ' + d.activeUsers + ' users';
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

function bars(rows, nameKey, valKey, color) {
  if (!rows.length) return '<p class="empty">No data in this window.</p>';
  const max = Math.max(...rows.map((r) => r[valKey]), 1);
  return '<div class="bars">' + rows.map((r) =>
    '<div class="row"><span class="name" title="'+esc(r[nameKey])+'">'+esc(r[nameKey])+'</span>' +
    '<span class="track"><span class="fill" style="width:'+Math.max(1,(r[valKey]/max)*100)+'%;background:'+(color||'var(--s1)')+'"></span></span>' +
    '<span class="val">'+fmt(r[valKey])+'</span></div>').join('') + '</div>';
}

// Hour-of-day as a compact column chart. Requests are bucketed in each user's OWN local time, so
// this reads as "when do people work", not "when is our server busy" — the two differ by however
// spread out the user base is.
function hourChart(hourly) {
  const max = Math.max(1, ...hourly.map((h) => h.requests));
  return '<div class="hours">' + hourly.map((h) =>
    '<div class="hcol" title="' + h.hour + ':00 local &middot; ' + h.requests + ' requests">' +
      '<div class="hbar" style="height:' + Math.round((h.requests / max) * 100) + '%"></div>' +
      '<div class="hlab">' + (h.hour % 6 === 0 ? h.hour : '') + '</div></div>').join('') + '</div>';
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ms(v) { return v === null || v === undefined ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms'; }

function render(a) {
  $('range').style.display = '';
  const conv = a.funnel.conversionPct === null ? '—' : a.funnel.conversionPct + '%';
  const tiles = [
    ['Tokens · ' + a.windowDays + 'd', fmt(a.totals.tokens), ''],
    ['Requests', fmt(a.totals.requests), ''],
    ['Active users', String(a.totals.activeUsers), ''],
    ['Checkout conversion', conv, a.funnel.paid + ' paid / ' + a.funnel.minted + ' started'],
    a.revenue ? ['MRR', a.revenue.currency + ' ' + a.revenue.mrr, a.revenue.activeSubs + ' active subs'] : ['MRR', '—', 'Kelviq not configured'],
  ];
  const funnelRows = [
    { name: 'Paid', v: a.funnel.paid, c: 'var(--s1)' },
    { name: 'Expired unpaid', v: a.funnel.expired, c: 'var(--s2)' },
    { name: 'Pending', v: a.funnel.pending, c: 'var(--neutral)' },
  ];
  const fmax = Math.max(1, ...funnelRows.map((r) => r.v));
  $('main').innerHTML =
    '<div class="tiles">' + tiles.map((t) => '<div class="tile"><div class="k">'+t[0]+'</div><div class="v">'+t[1]+'</div><div class="s">'+(t[2]||'&nbsp;')+'</div></div>').join('') + '</div>' +
    '<div class="card"><h2>Tokens per day</h2>' + lineChart(a.daily) + '</div>' +
    '<div class="grid2">' +
      '<div class="card"><h2>Models by tokens</h2>' + bars(a.models.map((m) => ({ name: m.model, v: m.tokens })), 'name', 'v') + '</div>' +
      '<div class="card"><h2>Upgrade funnel · ' + a.windowDays + 'd</h2><div class="bars">' +
        funnelRows.map((r) => '<div class="row"><span class="name">'+r.name+'</span><span class="track"><span class="fill" style="width:'+Math.max(1,(r.v/fmax)*100)+'%;background:'+r.c+'"></span></span><span class="val">'+r.v+'</span></div>').join('') +
      '</div><p class="empty" style="margin:10px 0 0">Plans: ' + (a.plans.map((p) => esc(p.plan)+' × '+p.users).join(' · ') || 'no paid plans yet') + '</p></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="card"><h2>Top accounts · ' + a.windowDays + 'd</h2>' + (a.topUsers.length ?
        '<table><tr><th>account</th><th>plan</th><th style="text-align:right">tokens</th><th style="text-align:right">quota</th></tr>' +
        a.topUsers.map((u) => '<tr><td>'+esc(u.user)+'</td><td><span class="pill">'+esc(u.plan)+'</span></td><td class="num">'+fmt(u.tokens)+'</td><td class="num">'+u.pctOfQuota+'%</td></tr>').join('') + '</table>'
        : '<p class="empty">No usage in this window.</p>') + '</div>' +
      '<div class="card"><h2>Where to improve</h2>' + (a.insights.length ?
        '<ul class="insights">' + a.insights.map((i) => '<li class="'+i.level+'">'+esc(i.text)+'</li>').join('') + '</ul>'
        : '<p class="empty">Nothing flagged — collect more data.</p>') + '</div>' +
    '</div>' +
    '<div class="card"><h2>When it is used &middot; local time</h2>' + hourChart(a.timing.hourly) +
      '<p class="note">' + (a.timing.unknownTzPct > 0
        ? a.timing.unknownTzPct + '% of requests reported no timezone and are not shown here.'
        : 'Every request reported a timezone.') + '</p></div>' +
    '<div class="grid2">' +
      '<div class="card"><h2>By weekday</h2>' + bars(a.timing.weekday.map((d) => ({ name: DOW[d.day], v: d.requests })), 'name', 'v') + '</div>' +
      '<div class="card"><h2>Response latency</h2><table>' +
        '<tr><th>metric</th><th style="text-align:right">p50</th><th style="text-align:right">p95</th></tr>' +
        '<tr><td>time to first token</td><td class="num">'+ms(a.timing.latency.ttftP50)+'</td><td class="num">'+ms(a.timing.latency.ttftP95)+'</td></tr>' +
        '<tr><td>full response</td><td class="num">'+ms(a.timing.latency.p50)+'</td><td class="num">'+ms(a.timing.latency.p95)+'</td></tr>' +
        '</table><p class="note">' + fmt(a.timing.latency.measured) + ' measured responses.</p></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="card"><h2>Timezones</h2>' + bars(a.locations.timezones.map((t) => ({ name: t.tz, v: t.requests })), 'name', 'v') + '</div>' +
      '<div class="card"><h2>Countries</h2>' + (a.locations.countries.length
        ? bars(a.locations.countries.map((c) => ({ name: c.country, v: c.requests })), 'name', 'v')
        : '<p class="empty">No country data — the proxy in front of this server does not add a country header.</p>') + '</div>' +
    '</div>';
  wireLineHover(a.daily);
}

async function load() {
  const key = localStorage.getItem('ada.adminKey') || '';
  if (!key) return gate();
  let r, data;
  try {
    r = await fetch('/v1/admin/analytics?days=' + days, { headers: { authorization: 'Bearer ' + key } });
    data = await r.json();
  } catch { return gate('Could not reach the backend.'); }
  if (!r.ok) return gate((data && data.error && data.error.message) || 'Not authorized.');
  render(data);
}

document.querySelectorAll('#range button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#range button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    days = Number(b.dataset.d);
    load();
  };
});
load();
</script>`;
