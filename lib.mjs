// The bots report: the facts, computed by code (docs/2026-11-20-bot-report-design.md in bot-office).
// Pure functions, no network: report.mjs fetches and saves, test.mjs checks these.

export const ilDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
// the UTC moment an Israel calendar day starts (DST-safe: read Israel's offset at that moment)
export function ilDayStart(day) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  for (const off of [2, 3]) { const t = guess - off * 3600_000; if (ilDay(t) === day && ilDay(t - 1) !== day) return t; }
  return guess - 2 * 3600_000;
}
const ilHM = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// the same problem seen again: bot + station + the error text without numbers, ids, quotes, dates and paths
export function normalizeError(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[url\]|\[\.\.\.\]/g, '')
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/\b[0-9a-f]{8,}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
export const fingerprint = (bot, station, text) => `${bot}|${station || '-'}|${normalizeError(text)}`;

// a bot's runs in a day: run-level rows when there are some, else bursts of station reports with no 5-minute gap
export function runsOf(rows, gapMs = 5 * 60_000) {
  const runs = [];
  let cur = null;
  for (const r of rows) {
    const ts = Date.parse(r.ts);
    if (!cur || ts - cur.end > gapMs) { cur = { start: ts, end: ts, rows: [], failed: false, stations: new Set() }; runs.push(cur); }
    cur.end = ts; cur.rows.push(r);
    if (r.station_id) cur.stations.add(r.station_id);
    if (r.status === 'error' || r.kind === 'failed') cur.failed = true;
  }
  return runs;
}

// how many runs a bot's schedule expects on a day (only bots with a fixed schedule: webhook bots expect none)
export function expectedRuns(bot, day) {
  const sc = bot.schedule;
  if (!sc || !bot.checkMissing) return null;
  if (sc.hourly) return sc.hourly[1] - sc.hourly[0] + 1;
  return (sc.il || sc.utc || []).length;
}

// numbers a bot reported for its products: the last station's "done" per run, plus numeric station metrics
export function productsOf(bot, rows) {
  const last = new Set(bot.pipelines.map((p) => p.at(-1)));
  const out = { delivered: 0, metrics: {} };
  for (const r of rows) {
    if (r.status === 'done' && last.has(r.station_id)) out.delivered++;
    for (const [k, v] of Object.entries(r.metrics || {})) {
      if (typeof v === 'number' && Number.isFinite(v) && !['done', 'of', 'ms'].includes(k)) out.metrics[`${r.station_id}.${k}`] = (out.metrics[`${r.station_id}.${k}`] || 0) + v;
    }
  }
  return out;
}

// health 0-100 and the reasons for every point taken
export function health({ failedRuns = 0, missing = 0, issues = [], costJump = 0 }) {
  const minus = [];
  if (failedRuns) minus.push([15 * failedRuns, (failedRuns === 1 ? 'ריצה אחת נכשלה' : `${failedRuns} ריצות נכשלו`)]);
  if (missing) minus.push([10 * missing, (missing === 1 ? 'ריצה מתוזמנת אחת לא קרתה' : `${missing} ריצות מתוזמנות לא קרו`)]);
  for (const i of issues) minus.push([i.severity === 'critical' ? 20 : 5, `בעיה פתוחה: ${i.title || i.station || 'שגיאה'}`]);
  if (costJump > 0.5) minus.push([Math.min(10, Math.round(costJump * 10)), `עלות AI עלתה ב-${Math.round(costJump * 100)}% מהממוצע`]);
  const score = Math.max(0, 100 - minus.reduce((n, [p]) => n + p, 0));
  return { score, minus: minus.map(([points, why]) => ({ points, why })) };
}

// every fact of one bot's day
export function botFacts(bot, rows, { day, ai = [], aiWeek = [], openIssues = [], now = Date.now() }) {
  const runs = runsOf(rows);
  const deals = bot.pipelines[0]?.[0];
  const scheduledRuns = bot.schedule?.hourly ? runs.filter((r) => r.stations.has(deals) || r.stations.has(bot.pipelines[0]?.[1])).length : runs.length;
  const exp = expectedRuns(bot, day);
  const dayDone = now - ilDayStart(day) > 23.5 * 3600_000;                 // only a finished day can miss runs
  const missing = exp != null && dayDone ? Math.max(0, exp - scheduledRuns) : 0;
  const failed = runs.filter((r) => r.failed).length;
  const durations = runs.map((r) => r.end - r.start).filter((d) => d > 0);
  const cost = ai.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0), unpriced = ai.filter((r) => r.cost_usd == null).reduce((n, r) => n + r.calls, 0);
  const weekAvg = aiWeek.length ? aiWeek.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0) / 7 : 0;
  const products = productsOf(bot, rows);
  const errors = rows.filter((r) => r.status === 'error');
  const h = health({ failedRuns: failed, missing, issues: openIssues, costJump: weekAvg > 0.01 ? cost / weekAvg - 1 : 0 });
  const silent = bot.stations.filter((s) => !rows.some((r) => r.station_id === s.id)).map((s) => s.id);
  return {
    bot: bot.bot, name: bot.name, runs: runs.length, failedRuns: failed, success: runs.length ? Math.round((100 * (runs.length - failed)) / runs.length) : null,
    expected: exp, missing, avgRunSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null,
    maxRunSec: durations.length ? Math.round(Math.max(...durations) / 1000) : null,
    firstRun: runs[0] ? ilHM(runs[0].start) : null, lastRun: runs.at(-1) ? ilHM(runs.at(-1).end) : null,
    aiCost: Number(cost.toFixed(6)), aiCalls: ai.reduce((n, r) => n + r.calls, 0), aiUnpriced: unpriced,
    costPerRun: runs.length ? Number((cost / runs.length).toFixed(6)) : null,
    delivered: products.delivered, costPerProduct: products.delivered ? Number((cost / products.delivered).toFixed(6)) : null,
    productMetrics: products.metrics, errors: errors.length, limits: errors.filter((r) => r.metrics?.limit).length,
    silentStations: silent, health: h.score, healthMinus: h.minus,
  };
}
