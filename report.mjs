// The bots report, built every night by GitHub Actions (and on demand): reads the day's technical data from Supabase,
// computes the facts (lib.mjs), keeps every problem in public.bot_issues until it is solved, asks a cheap model to
// explain the new ones and to suggest savings, writes public.bot_reports, and sends Maor a short Telegram summary.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (required); OPENAI_API_KEY, REPORT_MODEL (default gpt-6-luna);
// REPORT_TELEGRAM_TOKEN, REPORT_TELEGRAM_CHAT (optional); REPORT_DAY=YYYY-MM-DD to rebuild a day.
// Only technical data reaches the model: station names, headlines of errors, numbers, times, costs.
import { readFileSync } from 'node:fs';
import { ilDay, ilDayStart, fingerprint, botFacts } from './lib.mjs';

const env = process.env;
const { bots } = JSON.parse(readFileSync(new URL('./bots.json', import.meta.url), 'utf8'));
const URL_ = env.SUPABASE_URL?.replace(/\/$/, ''), KEY = env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function sb(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${path.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();                                    // a write with return=minimal answers with no body
  return text ? JSON.parse(text) : null;
}

const now = Date.now();
const day = env.REPORT_DAY || ilDay(now - 2 * 3600_000);          // run at 23:30 (or 00:30 in summer): the day that is ending
const from = new Date(ilDayStart(day)).toISOString(), to = new Date(ilDayStart(day) + 26 * 3600_000).toISOString();
const yesterday = ilDay(ilDayStart(day) - 12 * 3600_000), weekFrom = ilDay(ilDayStart(day) - 7 * 86_400_000);
console.log(`[report] ${day} (${from} .. )`);

// ---------- the day's data ----------
const events = (await sb(`bot_events?select=id,ts,bot,kind,text,station_id,status,metrics,run_id&ts=gte.${from}&ts=lt.${to}&order=ts.asc&limit=20000`))
  .filter((r) => ilDay(Date.parse(r.ts)) === day);
const aiRows = await sb(`ai_usage_daily?select=day,bot,station,model,calls,cost_usd&day=gte.${weekFrom}&day=lte.${day}`);
let issues = await sb(`bot_issues?select=*&order=id.asc`);
const lessons = await sb(`bot_lessons?select=bot,lesson,created_at&order=created_at.desc&limit=20`);
const prev = (await sb(`bot_reports?select=facts&day=eq.${yesterday}`))[0]?.facts || null;

// ---------- problems: one per fingerprint, tracked until solved; a fixed one seen again "came back" ----------
const touched = new Map();
for (const r of events.filter((e) => e.status === 'error' || e.kind === 'failed')) {
  const fp = fingerprint(r.bot, r.station_id, r.text), ts = r.ts, w = r.metrics?.where || {};
  let it = touched.get(fp) || issues.find((i) => i.fingerprint === fp);
  if (!it) { it = { fingerprint: fp, bot: r.bot, station: r.station_id || null, first_seen: ts, last_seen: ts, status: 'new', severity: r.metrics?.limit ? 'medium' : 'high', day_counts: {}, _new: true }; issues.push(it); }
  if (!touched.has(fp)) { it.day_counts = { ...(it.day_counts || {}), [day]: 0 }; touched.set(fp, it); }   // this day is counted from scratch: a rebuild never doubles
  it.day_counts[day]++;
  if (Date.parse(ts) >= Date.parse(it.last_seen)) {
    if (it.status === 'fixed' && it.fixed_at && Date.parse(ts) > Date.parse(it.fixed_at)) it.status = 'regressed';
    it.last_seen = ts; it.sample = r.text || it.sample; if (w.file) Object.assign(it, { file: w.file, line: w.line, func: w.func });
  }
  if (Date.parse(ts) < Date.parse(it.first_seen)) it.first_seen = ts;
}
for (const it of touched.values()) it.count = Object.values(it.day_counts).reduce((a, b) => a + b, 0);
// a problem whose bot ran a whole day without it, after it was marked fixed, is confirmed
const openOf = (bot) => issues.filter((i) => i.bot === bot && ['new', 'open', 'regressed'].includes(i.status));

// ---------- the facts per bot ----------
const facts = bots.map((b) => botFacts(b, events.filter((e) => e.bot === b.bot), {
  day, now, ai: aiRows.filter((r) => r.bot === b.bot && r.day === day), aiWeek: aiRows.filter((r) => r.bot === b.bot && r.day < day), openIssues: openOf(b.bot),
}));
for (const f of facts) {
  const p = prev?.bots?.find((x) => x.bot === f.bot);
  f.vsYesterday = p ? { runs: f.runs - p.runs, failedRuns: f.failedRuns - p.failedRuns, aiCost: Number((f.aiCost - p.aiCost).toFixed(6)), health: f.health - p.health } : null;
}
const total = { runs: facts.reduce((n, f) => n + f.runs, 0), failedRuns: facts.reduce((n, f) => n + f.failedRuns, 0), aiCost: Number(facts.reduce((n, f) => n + f.aiCost, 0).toFixed(6)), errors: facts.reduce((n, f) => n + f.errors, 0) };

// ---------- the analysis: a cheap model explains the problems and suggests savings (facts stay facts) ----------
const model = env.REPORT_MODEL || 'gpt-6-luna';
let analysis = null, usage = null;
const toExplain = issues.filter((i) => touched.has(i.fingerprint) && (i._new || i.status === 'regressed' || !i.explanation)).slice(0, 25);
if (env.OPENAI_API_KEY) {
  const brief = {
    day, bots: facts.map(({ healthMinus, productMetrics, ...f }) => ({ ...f, productMetrics })),
    stations: Object.fromEntries(bots.map((b) => [b.bot, b.stations.map((s) => `${s.id}: ${s.name} (${s.kind}) ${s.does}`)])),
    problems: toExplain.map((i) => ({ fingerprint: i.fingerprint, bot: i.bot, station: i.station, count: i.count, status: i.status, error: i.sample, file: i.file, line: i.line, func: i.func })),
    lessons: lessons.map((l) => `${l.bot || ''}: ${l.lesson}`),
  };
  const prompt = `You review a day of Maor's 7 bots (technical data only). Answer in JSON only:
{"summary": "<2 short Hebrew sentences on the day>",
 "problems": [{"fingerprint": "<as given>", "title": "<Hebrew, max 6 words>", "severity": "critical|high|medium|low", "explanation": "<Hebrew, 1 sentence: what happened and the likely cause>", "suggestion": "<Hebrew, 1 sentence: what to check or change in the code; name the file if known>"}],
 "suggestions": [{"bot": "<bot id>", "kind": "cost|reliability|quota", "text": "<Hebrew, 1 sentence, concrete, based on the numbers>"}]}
Rules: base everything on the data; no guesses presented as facts; max 6 suggestions; critical = the bot did not deliver its product.
Data: ${JSON.stringify(brief)}`;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    analysis = JSON.parse(j.choices[0].message.content); usage = j.usage;
    for (const p of analysis.problems || []) {
      const it = issues.find((i) => i.fingerprint === p.fingerprint); if (!it) continue;
      Object.assign(it, { title: p.title || it.title, explanation: p.explanation || it.explanation, suggestion: p.suggestion || it.suggestion, severity: ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : it.severity });
    }
  } catch (e) { console.error('[report] analysis failed:', String(e.message || e)); analysis = { error: String(e.message || e).slice(0, 200) }; }
} else analysis = { error: 'OPENAI_API_KEY is not set: facts only' };

// ---------- save: the problems, then the report ----------
for (const it of touched.values()) {
  const row = { fingerprint: it.fingerprint, bot: it.bot, station: it.station, severity: it.severity, title: it.title || null, sample: it.sample, file: it.file || null, line: it.line || null, func: it.func || null,
    first_seen: it.first_seen, last_seen: it.last_seen, count: it.count, day_counts: it.day_counts, status: it._new ? 'new' : it.status === 'new' ? 'open' : it.status, explanation: it.explanation || null, suggestion: it.suggestion || null, updated_at: new Date().toISOString() };
  await sb('bot_issues?on_conflict=fingerprint', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
}
const cost = usage ? (usage.prompt_tokens * 0.1 + usage.completion_tokens * 0.5) / 1e6 : null;   // gpt-6-luna's price (bot-office/office/lib/prices.mjs)
const report = { day, facts: { total, bots: facts, newProblems: [...touched.values()].filter((i) => i._new).length, regressed: [...touched.values()].filter((i) => i.status === 'regressed').length }, analysis, model: env.OPENAI_API_KEY ? model : null, cost_usd: cost };
await sb('bot_reports?on_conflict=day', { method: 'POST', body: JSON.stringify(report), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
console.log(`[report] saved: ${total.runs} runs, ${total.failedRuns} failed, ${touched.size} problems seen, AI $${total.aiCost}`);

// ---------- Telegram: a short summary ----------
if (env.REPORT_TELEGRAM_TOKEN && env.REPORT_TELEGRAM_CHAT && !env.REPORT_DAY) {
  const esc = (s) => String(s ?? '').replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const lines = [`<b>דוח הבוטים · ${day}</b>`, `${total.runs} ריצות · ${total.failedRuns} נכשלו · AI ≈ $${total.aiCost.toFixed(2)}`, '',
    ...facts.map((f) => `${f.health >= 90 ? '🟢' : f.health >= 60 ? '🟡' : '🔴'} ${esc(f.name)}: ${f.health}${f.healthMinus[0] ? ` · ${esc(f.healthMinus[0].why)}` : ''}`)];
  if (report.facts.newProblems || report.facts.regressed) lines.push('', `בעיות חדשות: ${report.facts.newProblems} · חזרו: ${report.facts.regressed}`);
  if (analysis?.summary) lines.push('', esc(analysis.summary));
  lines.push('', 'המלא: http://localhost:4747/report.html');
  const r = await fetch(`https://api.telegram.org/bot${env.REPORT_TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ chat_id: env.REPORT_TELEGRAM_CHAT, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => null);
  if (r?.ok) await sb(`bot_reports?day=eq.${day}`, { method: 'PATCH', body: JSON.stringify({ telegram: true }), headers: { Prefer: 'return=minimal' } });
  else console.error('[report] telegram failed', r?.status);
}
