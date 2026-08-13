// Live gauntlet monitor. Reads real run state off disk on every request —
// workflow journals, verdicts, git log — and serves a self-refreshing page.
// Runs on its own port so it can never disturb the app or a running build.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 3021);
const REPO = '/Users/richgates/Documents/claude/maxmusic';
const WF_DIR =
  '/Users/richgates/.claude/projects/-Users-richgates-Documents-claude-maxmusic/' +
  '2c515c86-c33f-4f4b-8cbe-f4c4939918f3/subagents/workflows';

const RUNS = [
  { id: 'wf_8401baa0-418', round: 1, phases: ['Shell', 'Build', 'Capture', 'Judge'], expect: 13 },
  { id: 'wf_7ab77267-c25', round: 2, phases: ['Chrome', 'Rebuild', 'Capture', 'Judge'], expect: 12 },
  { id: 'wf_62701ce0-1d9', round: 3, phases: ['Design', 'Lanes', 'Capture', 'Judge'], expect: 12 },
];

const ago = (ms) => {
  if (ms == null) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

function readRun(run) {
  const dir = path.join(WF_DIR, run.id);
  const journal = path.join(dir, 'journal.jsonl');
  if (!fs.existsSync(journal)) return { ...run, state: 'not started', started: 0, done: 0 };

  const rows = fs
    .readFileSync(journal, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);

  const started = rows.filter((r) => r.type === 'started').length;
  const done = rows.filter((r) => r.type === 'result').length;
  const stat = fs.statSync(journal);
  const idleMs = Date.now() - stat.mtimeMs;

  // Per-agent transcripts tell us which workers are still writing.
  let agents = [];
  try {
    agents = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
      .map((f) => {
        const s = fs.statSync(path.join(dir, f));
        return { file: f.slice(6, 14), kb: Math.round(s.size / 1024), idleMs: Date.now() - s.mtimeMs };
      })
      .sort((a, b) => a.idleMs - b.idleMs);
  } catch { /* directory may vanish mid-read */ }

  const inFlight = started - done;
  const state =
    done >= run.expect ? 'complete'
    : inFlight > 0 && idleMs < 180000 ? 'running'
    : inFlight > 0 ? 'running (quiet)'
    : 'between phases';

  return { ...run, state, started, done, idleMs, lastEvent: ago(idleMs), agents: agents.slice(0, 8) };
}

function readVerdicts() {
  const p = path.join(REPO, 'shots/round1-verdicts.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function readCommits() {
  try {
    const out = execFileSync('git', ['-C', REPO, 'log', '-8', '--pretty=%h%ar%s'], {
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [hash, when, subject] = l.split('');
      return { hash, when, subject };
    });
  } catch { return []; }
}

function readTree() {
  try {
    const out = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function scanBans() {
  const grep = (args) => {
    try { return execFileSync('grep', args, { encoding: 'utf8', cwd: REPO }).trim().split('\n').filter(Boolean).length; }
    catch { return 0; }
  };
  return {
    gradients: grep(['-rl', 'linear-gradient', 'public/css/screens/']),
    stripes: grep(['-rnE', 'border-left:\\s*[234]px', 'public/css/']),
    plumbing: grep(['-rlE', '192\\.168\\.1\\.100|POST /api|ConvRot', 'public/js/']),
    coversNamed: grep(['-rl', 'covers', 'public/js/screens/']),
  };
}

function state() {
  return {
    now: new Date().toISOString(),
    runs: RUNS.map(readRun),
    verdicts: readVerdicts(),
    commits: readCommits(),
    dirty: readTree(),
    bans: scanBans(),
  };
}

const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MaxMusic — gauntlet monitor</title><style>
:root{--bg:#08080C;--panel:#101018;--hair:#1F1F2B;--hair2:#2C2C3C;--ink:#E8E8F0;--dim:#9A9AAE;
--mute:#6A6A7E;--cyan:#00C0E0;--win:#3DD68C;--loss:#F04060;--amber:#E0A040;
--mono:ui-monospace,"SF Mono",Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:26px;margin:0;letter-spacing:-.02em;font-weight:650}
h1 span{color:var(--cyan)}
.sub{color:var(--dim);margin:6px 0 0;font-size:13.5px}
.live{display:inline-flex;align-items:center;gap:7px;font:11px var(--mono);letter-spacing:.1em;
text-transform:uppercase;color:var(--mute);margin-top:10px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--win);animation:p 1.6s ease-in-out infinite}
@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.dot{animation:none}}
.eyebrow{font:11px var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute);
margin:34px 0 12px;display:flex;align-items:center;gap:12px}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--hair)}
.card{background:var(--panel);border:1px solid var(--hair);border-radius:10px;padding:15px 17px;margin-bottom:10px}
.rowtop{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap}
.rname{font-weight:620}
.chip{font:10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;
border-radius:4px;border:1px solid var(--hair2);color:var(--dim)}
.chip.run{color:var(--cyan);border-color:#0a5a6a}
.chip.ok{color:var(--win);border-color:#1d6b48}
.chip.warn{color:var(--amber);border-color:#6b5220}
.bar{height:6px;background:#191924;border-radius:3px;overflow:hidden;margin-top:11px}
.bar i{display:block;height:100%;background:var(--cyan)}
.meta{font:11.5px var(--mono);color:var(--mute);margin-top:9px;display:flex;gap:16px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:6px 0;border-bottom:1px solid var(--hair);vertical-align:top}
td:first-child{color:var(--dim);white-space:nowrap;padding-right:14px;font:11.5px var(--mono)}
tr:last-child td{border-bottom:0}
.num{font-variant-numeric:tabular-nums}
.ok{color:var(--win)}.bad{color:var(--loss)}.warnc{color:var(--amber)}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--hair);color:var(--mute);font-size:12px}
</style></head><body><div class="wrap">
<h1><span>MaxMusic</span> — gauntlet monitor</h1>
<p class="sub">Reads the run journals, git log and source tree directly. No manual updates.</p>
<div class="live"><span class="dot"></span><span id="tick">connecting…</span></div>
<div id="body"></div>
<footer>Polls every 3 seconds. Serving from the repo, independent of the app on :3020.</footer>
</div><script>
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tick(){
  let d; try { d = await (await fetch('/api/state',{cache:'no-store'})).json(); }
  catch(e){ document.getElementById('tick').textContent='monitor unreachable'; return; }
  document.getElementById('tick').textContent = 'updated ' + new Date(d.now).toLocaleTimeString();
  const runs = d.runs.map(r=>{
    const pct = Math.min(100, Math.round(r.done / r.expect * 100));
    const cls = r.state==='complete'?'ok':r.state.startsWith('running')?'run':'warn';
    const agents = (r.agents||[]).map(a=>a.file+' '+a.kb+'kb'+(a.idleMs<60000?' ·live':'')).join('   ');
    return '<div class="card"><div class="rowtop"><span class="rname">Round '+r.round+'</span>'
      +'<span class="chip '+cls+'">'+esc(r.state)+'</span></div>'
      +'<div class="bar"><i style="width:'+pct+'%"></i></div>'
      +'<div class="meta"><span class="num">'+r.done+' / '+r.expect+' agents</span>'
      +'<span class="num">'+(r.started-r.done)+' in flight</span>'
      +'<span>last event '+esc(r.lastEvent||'—')+'</span></div>'
      +(agents?'<div class="meta">'+esc(agents)+'</div>':'')+'</div>';
  }).join('');
  const v = d.verdicts.length ? '<div class="eyebrow">Round 1 blind verdicts</div><div class="card"><table>'
    + d.verdicts.map(x=>'<tr><td>'+esc(x.piece)+'</td><td><span class="'+(x.we_won?'ok':'bad')+'">'
    + (x.we_won?'won':'lost')+'</span> · '+esc(x.confidence)+'<br><span style="color:var(--dim)">'
    + esc(x.biggest_gap.slice(0,190))+'…</span></td></tr>').join('') + '</table></div>' : '';
  const b = d.bans;
  const row = (label,n,good) => '<tr><td>'+label+'</td><td class="num '+(n===good?'ok':'warnc')+'">'+n+'</td></tr>';
  const bans = '<div class="eyebrow">Outstanding review items</div><div class="card"><table>'
    + row('gradient stylesheets', b.gradients, 0)
    + row('left-edge stripes', b.stripes, 0)
    + row('modules with plumbing', b.plumbing, 0)
    + row('files still named covers', b.coversNamed, 0)
    + '<tr><td>uncommitted files</td><td class="num">'+d.dirty+'</td></tr></table></div>';
  const c = '<div class="eyebrow">Commits</div><div class="card"><table>'
    + d.commits.map(x=>'<tr><td>'+esc(x.hash)+'</td><td>'+esc(x.subject)
    + '<br><span style="color:var(--mute);font-size:12px">'+esc(x.when)+'</span></td></tr>').join('')
    + '</table></div>';
  document.getElementById('body').innerHTML =
    '<div class="eyebrow">Runs</div>' + runs + bans + v + c;
}
tick(); setInterval(tick, 3000);
</script></body></html>`;

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/state')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(state()));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  })
  .listen(PORT, () => console.log(`\n  gauntlet monitor → http://localhost:${PORT}\n`));
