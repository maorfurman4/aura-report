// The bots report, built every night by GitHub Actions (and on demand): reads the day's technical data from Supabase,
// computes the facts (lib.mjs), keeps every problem in public.bot_issues until it is solved, asks a cheap model to
// explain the new ones and to suggest savings, writes public.bot_reports, and sends Maor a short Telegram summary.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (required); OPENAI_API_KEY, REPORT_MODEL (default gpt-6-luna);
// REPORT_TELEGRAM_TOKEN, REPORT_TELEGRAM_CHAT (optional); REPORT_DAY=YYYY-MM-DD to rebuild a day (no Telegram);
// REPORT_SCHEDULED=1 skips a day already built, REPORT_MORNING=1 marks the message as the morning catch-up.
// Only technical data reaches the model: station names, headlines of errors, numbers, times, costs.
import { botOf, ilDay, ilDayStart, reportDay, fingerprint, botFacts, staleIssues, budget, limitOf, telegramText } from './lib.mjs';
import { sb, telegram } from './supabase.mjs';

const env = process.env;
const bots = (await sb('bots?select=*&order=sort.asc')).map(botOf);   // the registry (public.bots)
if (!bots.length) throw new Error('public.bots is empty: run node office/registry.mjs in bot-office');

const now = Date.now();
const day = env.REPORT_DAY || reportDay(now);                    // 23:30 = today; after midnight (summer, or a late start) = yesterday
const from = new Date(ilDayStart(day)).toISOString(), to = new Date(ilDayStart(day) + 26 * 3600_000).toISOString();
const yesterday = ilDay(ilDayStart(day) - 12 * 3600_000), weekFrom = ilDay(ilDayStart(day) - 7 * 86_400_000);
console.log(`[report] ${day} (${from} .. )`);
// a scheduled run skips a day whose full report is built (the morning check, or a nightly run GitHub started very late)
if (env.REPORT_SCHEDULED && !env.REPORT_DAY) {
  const built = (await sb(`bot_reports?select=created_at&day=eq.${day}`))[0];
  if (built && Date.parse(built.created_at) - ilDayStart(day) > 23 * 3600_000) { console.log(`[report] ${day} is already built`); process.exit(0); }
}

// ---------- the day's data ----------
const events = (await sb(`bot_events?select=id,ts,bot,kind,text,station_id,status,metrics,run_id&ts=gte.${from}&ts=lt.${to}&order=ts.asc&limit=20000`))
  .filter((r) => ilDay(Date.parse(r.ts)) === day);
const aiRows = await sb(`ai_usage_daily?select=day,bot,station,model,calls,cost_usd&day=gte.${weekFrom}&day=lte.${day}`);
const aiMonth = await sb(`ai_usage_daily?select=day,cost_usd&day=gte.${day.slice(0, 7)}-01&day=lte.${day}`);
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
// a problem not seen for 3 days while its bot kept running closes by itself; seen again later, it "came back"
const closed = staleIssues(issues, day, new Set(events.map((e) => e.bot)));
for (const it of closed) Object.assign(it, { status: 'fixed', fixed_at: new Date(now).toISOString(), note: 'נסגרה לבד: 3 ימים בלי להופיע' });
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
  const [saved] = await sb('bot_issues?on_conflict=fingerprint&select=id', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
  it.id = saved?.id ?? it.id;                                     // a new problem gets its id here, for its Telegram button
}
for (const it of closed) {
  await sb(`bot_issues?id=eq.${it.id}`, { method: 'PATCH', body: JSON.stringify({ status: it.status, fixed_at: it.fixed_at, note: it.note, updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
}
const auraCfg = await sb('rpc/aura_config', { method: 'POST', body: JSON.stringify({ p_bot: 'aura' }) }).catch(() => null);   // Maor's budget field
const money = budget(aiMonth, day, limitOf(auraCfg, env.REPORT_BUDGET));
const cost = usage ? (usage.prompt_tokens * 0.1 + usage.completion_tokens * 0.5) / 1e6 : null;   // gpt-6-luna's price (bot-office/office/lib/prices.mjs)
const report = { day, facts: { total, bots: facts, newProblems: [...touched.values()].filter((i) => i._new).length, regressed: [...touched.values()].filter((i) => i.status === 'regressed').length, closed: closed.length, budget: money }, analysis, model: env.OPENAI_API_KEY ? model : null, cost_usd: cost, created_at: new Date().toISOString() };   // a rerun of the same day shows when it was rebuilt
await sb('bot_reports?on_conflict=day', { method: 'POST', body: JSON.stringify(report), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
console.log(`[report] saved: ${total.runs} runs, ${total.failedRuns} failed, ${touched.size} problems seen, AI $${total.aiCost}`);

// ---------- Telegram: a short summary ----------
if (!env.REPORT_DAY) {
  const text = telegramText({ day, total, facts, problems: [...touched.values()], closed, budget: money, summary: analysis?.summary, late: Boolean(env.REPORT_MORNING) });
  // a "✔️ תיקנתי" button per problem still open; the aura-watch function (Supabase) gets the press
  const open = [...touched.values()].filter((i) => i.id && i.status !== 'fixed').slice(0, 6);
  const buttons = open.length ? { reply_markup: { inline_keyboard: open.map((i) => [{ text: `✔️ תיקנתי: ${String(i.title || i.station || 'שגיאה').slice(0, 40)}`, callback_data: `fixed:${i.id}` }]) } } : {};
  if (await telegram(text, buttons)) await sb(`bot_reports?day=eq.${day}`, { method: 'PATCH', body: JSON.stringify({ telegram: true }), headers: { Prefer: 'return=minimal' } });
}
