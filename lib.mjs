// The bots report: the facts, computed by code (docs/2026-11-20-bot-report-design.md in bot-office).
// Pure functions, no network: report.mjs fetches and saves, test.mjs checks these.

export const ilDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
// the UTC moment an Israel calendar day starts (DST-safe: read Israel's offset at that moment)
export function ilDayStart(day) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  for (const off of [2, 3]) { const t = guess - off * 3600_000; if (ilDay(t) === day && ilDay(t - 1) !== day) return t; }
  return guess - 2 * 3600_000;
}
// the day a report covers: a run before noon in Israel covers yesterday (GitHub can start the 23:30 run hours late)
export function reportDay(now) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
  return ilDay(h < 12 ? ilDayStart(ilDay(now)) - 1 : now);
}
// a scheduled run (AURA at 23:30, the 07:30 check, GitHub's fallback cron) builds the night's day: today from 23:00,
// else yesterday. A fallback GitHub starts hours late (15:29 on 2026-11-22) then finds yesterday built and stops.
export function scheduledDay(now) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
  return ilDay(h >= 23 ? now : ilDayStart(ilDay(now)) - 1);
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

// a bot's runs in a day: run-level rows when there are some, else bursts of station reports with no 5-minute gap. A
// station still "working" keeps its run open up to `openMs` (reels' render reports nothing for 5+ minutes). A run failed
// when a station's LAST report in it is an error (or a run-level "failed"): an error the station recovered from on a
// retry is not a failure (reels 2026-11-22: timing erred, the script was rewritten, the reel went out).
export function runsOf(rows, gapMs = 5 * 60_000, openMs = 30 * 60_000) {
  const runs = [];
  let cur = null;
  const close = (run) => { run.failed = run.kindFailed || [...run.last.values()].includes('error'); };
  for (const r of rows) {
    const ts = Date.parse(r.ts), gap = cur ? ts - cur.end : Infinity;
    const open = cur && [...cur.last.values()].includes('working');
    if (gap > gapMs && !(open && gap <= openMs)) {
      if (cur) close(cur);
      cur = { start: ts, end: ts, rows: [], failed: false, kindFailed: false, stations: new Set(), last: new Map() };
      runs.push(cur);
    }
    cur.end = ts; cur.rows.push(r);
    if (r.station_id) { cur.stations.add(r.station_id); if (r.status) cur.last.set(r.station_id, r.status); }
    if (r.kind === 'failed') cur.kindFailed = true;
  }
  if (cur) close(cur);
  return runs;
}

// a row of public.bots (the registry, filled from the office manifest by bot-office/office/registry.mjs) in the shape
// the report and the watch use; a paused bot expects no runs
export const botOf = (r) => ({ bot: r.id, name: r.name, repo: r.repo, schedule: r.schedule, hours: r.hours, pipelines: r.pipelines || [],
  stations: r.stations || [], checkMissing: Boolean(r.check_missing && !r.paused), paused: Boolean(r.paused), host: r.host || null, settings: r.settings || [], dispatch: r.dispatch || null });

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

// problems that close by themselves: open, but not seen for `clean` days in a row while their bot kept running
export function staleIssues(issues, day, ranToday, clean = 3) {
  const before = ilDayStart(day) - (clean - 1) * 86_400_000;                // the start of the first clean day
  return issues.filter((i) => ['new', 'open', 'regressed'].includes(i.status) && ranToday.has(i.bot) && Date.parse(i.last_seen) < before);
}

// the month's AI spend so far and where it is heading: spent + the average of the last 7 days with data for every day left
// the monthly AI budget: Maor's field in AURA (rpc aura_config('aura').settings.budget_usd), else REPORT_BUDGET, else 15
export function limitOf(cfg, envBudget) {
  const v = cfg?.settings?.budget_usd;
  if (typeof v === 'number' && v > 0) return v;
  return Number(envBudget) || 15;
}

export function budget(rows, day, limit = 15) {
  const byDay = {};
  for (const r of rows) if (r.day.slice(0, 7) === day.slice(0, 7) && r.day <= day) byDay[r.day] = (byDay[r.day] || 0) + (Number(r.cost_usd) || 0);
  const spent = Object.values(byDay).reduce((a, b) => a + b, 0), last = Object.keys(byDay).sort().slice(-7);
  const avg = last.length ? last.reduce((n, d) => n + byDay[d], 0) / last.length : 0;
  const [y, m] = day.split('-').map(Number), left = new Date(Date.UTC(y, m, 0)).getUTCDate() - Number(day.slice(8));
  const forecast = spent + avg * left;
  return { spent: Number(spent.toFixed(4)), forecast: Number(forecast.toFixed(4)), limit, over: forecast > limit };
}

// a fixed schedule's run times (ms) on yesterday and today; Israel times are counted from the day's start (shortcut:
// on a DST day an Israel time is an hour off, fine for a 3-hour grace)
export function slotsOf(sc, now) {
  const today = ilDay(now), out = [];
  for (const d of [ilDay(ilDayStart(today) - 1), today]) {
    const start = ilDayStart(d);
    if (sc.hourly) for (let h = sc.hourly[0]; h <= sc.hourly[1]; h++) out.push(start + h * 3600_000);
    for (const t of sc.il || []) { const [h, m] = t.split(':').map(Number); out.push(start + (h * 60 + m) * 60_000); }
  }
  for (const k of [1, 0]) for (const t of sc.utc || []) out.push(Date.parse(`${new Date(now - k * 86_400_000).toISOString().slice(0, 10)}T${t}:00Z`));
  return out;
}

// the watch (every 15 minutes), only what is critical: a run that failed without its product, or a scheduled run that did not happen
// within `graceH` hours. Every alert has a key, so it is sent once (the watch keeps the keys).
export function watchAlerts({ bots, events, now, graceH = 3 }) {
  const esc = (s) => String(s ?? '').replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const out = [];
  for (const b of bots) {
    const rows = events.filter((e) => e.bot === b.bot), last = new Set(b.pipelines.map((p) => p.at(-1)));
    for (const run of runsOf(rows)) {
      if (!run.failed || run.end > now - 10 * 60_000 || run.end < now - 2 * 3600_000) continue;   // a run still going may retry
      if (run.rows.some((r) => r.status === 'done' && last.has(r.station_id))) continue;           // it failed on the way but delivered
      const err = run.rows.find((r) => r.status === 'error' || r.kind === 'failed');
      out.push({ key: `fail|${b.bot}|${new Date(run.start).toISOString()}`,
        text: `🚨 <b>${esc(b.name)}</b>: ריצה נכשלה בלי תוצר (${ilHM(run.start)}${err?.station_id ? `, תחנה ${esc(err.station_id)}` : ''})${err?.text ? `\n<code>${esc(String(err.text).slice(0, 200))}</code>` : ''}` });
    }
    if (!b.checkMissing || !b.schedule) continue;
    const ran = b.schedule.hourly ? rows.filter((r) => b.pipelines[0].includes(r.station_id)) : rows;   // panda: the deals runs, not searches
    for (const slot of slotsOf(b.schedule, now)) {
      if (slot + graceH * 3600_000 > now || slot < now - 24 * 3600_000 || slot < (b.scheduleSince || 0)) continue;   // a time added today is not owed yesterday
      if (ran.some((r) => { const t = Date.parse(r.ts); return t >= slot - 15 * 60_000 && t <= slot + graceH * 3600_000; })) continue;
      out.push({ key: `miss|${b.bot}|${new Date(slot).toISOString()}`, text: `🚨 <b>${esc(b.name)}</b>: הריצה של ${ilHM(slot)} לא קרתה (עברו ${graceH} שעות)` });
    }
  }
  return out;
}

// the month's AI spend against the budget: one alert at 80%, one more once it is over (each once a month)
export function budgetAlert(money, day) {
  const m = day.slice(0, 7), line = `$${money.spent.toFixed(2)} מתוך $${money.limit} · צפי לסוף החודש $${money.forecast.toFixed(2)}`;
  if (money.spent > money.limit) return { key: `budget|${m}|over`, text: `💸 <b>תקציב ה-AI עבר</b>: ${line}. הבוטים ממשיכים לרוץ.` };
  if (money.spent >= 0.8 * money.limit) return { key: `budget|${m}|80`, text: `⚠️ <b>80% מתקציב ה-AI</b>: ${line}` };
  return null;
}

// GitHub Actions minutes of the month in the private repos (aura_metrics 'actions_minutes', counted by the office on the
// Mac): at 80% a warning, at 100% GitHub stops every private repo's runs until the 1st (2026-11-23 it stopped the bots)
export function minutesAlert(m) {
  if (!m?.month || !m.free || typeof m.minutes !== 'number') return null;
  const top = Object.entries(m.byRepo || {}).sort((a, b) => b[1].minutes - a[1].minutes).slice(0, 3).map(([r, v]) => `${r.split('/').pop()} ${v.minutes}`).join(', ');
  const line = `${m.minutes} מתוך ${m.free} דקות${top ? ` · הכי הרבה: ${top}` : ''}`;
  if (m.minutes >= m.free) return { key: `ghmin|${m.month}|out`, text: `🚨 <b>נגמרו דקות GitHub Actions</b>: ${line}. ריפו פרטיים לא ירוצו עד ה-1 בחודש (הבוטים ציבוריים ולא נפגעים).` };
  if (m.minutes >= 0.8 * m.free) return { key: `ghmin|${m.month}|80`, text: `⚠️ <b>80% מדקות GitHub Actions</b>: ${line}` };
  return null;
}

// the 7 Israel days that end on `end`, oldest first (noon of each day, so a DST change never skips one)
export const weekOf = (end, back = 0) => Array.from({ length: 7 }, (_, i) => ilDay(ilDayStart(end) + 12 * 3600_000 - (6 - i + back) * 86_400_000));

// the weekly summary: per bot reliability (runs that worked of all expected), cost vs the week before, problems that kept coming
export function weeklyText({ days, reports, prevReports = [], issues = [] }) {
  const esc = (s) => String(s ?? '').replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
  const cost = (rs) => rs.reduce((n, r) => n + (r.facts?.total?.aiCost || 0), 0);
  const bots = new Map();
  for (const r of reports) for (const f of r.facts?.bots || []) {
    const b = bots.get(f.bot) || { name: f.name, runs: 0, failed: 0, missing: 0, cost: 0 };
    Object.assign(b, { runs: b.runs + f.runs, failed: b.failed + f.failedRuns, missing: b.missing + (f.missing || 0), cost: b.cost + (f.aiCost || 0) });
    bots.set(f.bot, b);
  }
  const runs = [...bots.values()].reduce((n, b) => n + b.runs, 0), failed = [...bots.values()].reduce((n, b) => n + b.failed, 0);
  const now = cost(reports), before = prevReports.length ? cost(prevReports) : null;
  const lines = [`<b>סיכום שבועי · ${dm(days[0])}–${dm(days.at(-1))}</b>`,
    `${reports.length}/7 ימים בדוח · ${runs} ריצות · ${failed === 1 ? 'אחת נכשלה' : `${failed} נכשלו`} · AI $${now.toFixed(2)}${before != null ? ` (שבוע קודם $${before.toFixed(2)}${before > 0.01 ? `, ${now >= before ? '+' : ''}${Math.round((now / before - 1) * 100)}%` : ''})` : ''}`, ''];
  for (const b of bots.values()) {
    const ok = b.runs + b.missing ? Math.round((100 * (b.runs - b.failed)) / (b.runs + b.missing)) : null;
    const extra = [b.failed && (b.failed === 1 ? 'אחת נכשלה' : `${b.failed} נכשלו`), b.missing && (b.missing === 1 ? 'אחת לא קרתה' : `${b.missing} לא קרו`)].filter(Boolean).join(' · ');
    lines.push(`${ok == null ? '⚪' : ok >= 98 ? '🟢' : ok >= 90 ? '🟡' : '🔴'} <b>${esc(b.name)}</b>: ${ok == null ? 'לא רץ' : `אמינות ${ok}%`} · ${b.runs === 1 ? 'ריצה אחת' : `${b.runs} ריצות`}${extra ? ` · ${extra}` : ''} · $${b.cost.toFixed(2)}`);
  }
  const back = issues.map((i) => ({ ...i, days: days.filter((d) => i.day_counts?.[d]).length })).filter((i) => i.days >= 2).sort((a, b) => b.days - a.days);
  if (back.length) lines.push('', '<b>בעיות שחזרו השבוע</b>', ...back.slice(0, 8).map((i) => `• ${esc(i.title || i.station || 'שגיאה')} (${esc(bots.get(i.bot)?.name || i.bot)} · ${i.days} ימים · ×${days.reduce((n, d) => n + (i.day_counts[d] || 0), 0)})`));
  else lines.push('', '✅ אף בעיה לא חזרה ביותר מיום אחד');
  return lines.join('\n');
}

// the Telegram summary: one line when all is well, the details only where something is wrong
export function telegramText({ day, total, facts, problems = [], closed = [], budget: money, summary, late = false }) {
  const esc = (s) => String(s ?? '').replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
  const name = Object.fromEntries(facts.map((f) => [f.bot, f.name]));
  const lines = late ? ['⚠️ הדוח של הלילה לא רץ בזמן; נבנה עכשיו בבדיקת הבוקר', ''] : [];
  lines.push(`<b>דוח הבוטים · ${day}</b>`, `${total.runs} ריצות · ${total.failedRuns === 1 ? 'אחת נכשלה' : `${total.failedRuns} נכשלו`} · AI ≈ $${total.aiCost.toFixed(2)}`, '');
  const bad = facts.filter((f) => f.health < 100), ok = facts.filter((f) => f.health === 100);
  if (!bad.length) lines.push(`🟢 כל ${facts.length} הבוטים תקינים`);
  for (const f of bad) lines.push(`${f.health >= 90 ? '🟢' : f.health >= 60 ? '🟡' : '🔴'} <b>${esc(f.name)}</b> ${f.health}: ${f.healthMinus.map((m) => esc(m.why)).join(' · ')}`);
  if (bad.length && ok.length) lines.push(`🟢 תקינים: ${ok.map((f) => esc(f.name)).join(', ')}`);
  if (money) lines.push('', `💰 AI החודש: $${money.spent.toFixed(2)} · צפי לסוף החודש: $${money.forecast.toFixed(2)}${money.over ? ` ⚠️ מעל התקציב ($${money.limit})` : ''}`);
  if (problems.length) lines.push('', '<b>בעיות היום</b>');
  for (const p of problems) {
    const tag = p._new ? 'חדשה' : p.status === 'regressed' ? 'חזרה' : 'ממשיכה';
    lines.push(`• <b>${esc(p.title || p.station || 'שגיאה')}</b> (${esc(name[p.bot] || p.bot)}${p.station ? ` · ${esc(p.station)}` : ''} · ${tag} · ×${p.day_counts?.[day] ?? p.count ?? 1})`);
    if (p.explanation) lines.push(`  ${esc(cut(p.explanation, 220))}`);
    else if (p.sample) lines.push(`  <code>${esc(cut(p.sample, 160))}</code>`);
    if (p.suggestion) lines.push(`  מה לבדוק: ${esc(cut(p.suggestion, 220))}${p.file ? ` (${esc(p.file)}${p.line ? `:${p.line}` : ''})` : ''}`);
  }
  if (closed.length) lines.push('', `✅ נסגרו לבד (3 ימים בלי להופיע): ${closed.map((p) => esc(p.title || p.station || 'שגיאה')).join(', ')}`);
  if (summary) lines.push('', esc(summary));
  let text = lines.join('\n');
  if (text.length > 4000) text = `${text.slice(0, text.lastIndexOf('\n', 3950))}\n…`;   // cut on a line: every line closes its own tags
  return text;
}

// ---------- stage 6: the live knowledge file every Claude session about the bots starts from ----------
// the model may attach {key, value} to a suggestion only for a setting the bot really has (the office validates the value)
export function cleanSuggestions(list, bots) {
  return (Array.isArray(list) ? list : []).slice(0, 6).map(({ action, ...s }) => {
    const ok = action && typeof action === 'object' && 'value' in action && bots.find((b) => b.bot === s.bot)?.settings?.some((e) => e.key === action.key);
    return ok ? { ...s, action: { key: action.key, value: action.value } } : s;
  });
}

const STATUS_HE = { new: 'חדשה', open: 'פתוחה', regressed: 'חזרה', fixed: 'תוקנה', ignored: 'לא רלוונטית' };
const usd2 = (v) => `$${(Number(v) || 0).toFixed(2)}`;
const dm = (ts) => { const d = ilDay(Date.parse(ts)); return `${d.slice(8)}.${d.slice(5, 7)}`; };
const val = (v) => (v == null ? 'ברירת מחדל' : Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const schedText = (sc) => (!sc ? 'לפי בקשה (webhook)' : sc.hourly ? `כל שעה ${sc.hourly[0]}:00-${sc.hourly[1]}:00` : sc.utc ? `${sc.utc.join(', ')} UTC` : `${(sc.il || []).join(', ')} שעון ישראל`);

// -> markdown (Hebrew). week = [{day, bots: [botFacts]}] for the last 7 days including `day`; ai = {week, month} rows
// of ai_usage_daily with bot; changes = aura_changes of the last 30 days. Capped so the file stays short.
export function knowledgeMd({ day, builtAt, bots, week = [], issues = [], changes = [], ai = {}, money, suggestions = [], lessons = [] }) {
  const weekFrom = ilDayStart(day) - 6 * 86_400_000, undone = new Set(changes.map((c) => c.undo_of).filter(Boolean));
  const sum = (rows, bot) => (rows || []).filter((r) => r.bot === bot).reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
  const open = issues.filter((i) => ['new', 'open', 'regressed'].includes(i.status));
  const out = ['# AURA — ידע חי על הבוטים', '',
    `נוצר אוטומטית בדוח הלילי של ${day} (${ilHM(builtAt)}). לא לערוך ידנית: נכתב מחדש כל לילה מ-Supabase.`,
    `AI החודש: ${usd2(money?.spent)} מתוך ${usd2(money?.limit)} · תחזית ${usd2(money?.forecast)} · בעיות פתוחות: ${open.length}`,
    'הגדרות משנים רק דרך aura_set (ראה bot-office/CLAUDE.md, "Control"); כל שינוי נרשם וניתן לביטול.'];
  for (const b of bots) {
    const days = week.map((w) => w.bots?.find((f) => f.bot === b.bot)).filter(Boolean);
    const today = week.find((w) => w.day === day)?.bots?.find((f) => f.bot === b.bot);
    const runs = days.reduce((n, f) => n + (f.runs || 0), 0), failed = days.reduce((n, f) => n + (f.failedRuns || 0), 0);
    const order = [...new Set((b.pipelines || []).flat())], st = (id) => b.stations.find((s) => s.id === id);
    out.push('', `## ${b.name} (${b.bot})`,
      `${b.repo || 'בלי מאגר'} · ${b.host || '—'} · ${schedText(b.schedule)}${b.paused ? ' · **מושהה ב-AURA**' : ''}`,
      'מה הוא עושה:', ...(order.length ? order : b.stations.map((s) => s.id)).map((id) => `- ${st(id)?.name || id} (${id}): ${st(id)?.does || ''}`));
    out.push(`השבוע: ${runs} ריצות, ${failed} נכשלו${runs ? ` (${Math.round((100 * (runs - failed)) / runs)}% הצלחה)` : ''}${today ? ` · ציון היום ${today.health}` : ''}`);
    const seen = issues.filter((i) => i.bot === b.bot && Date.parse(i.last_seen) >= weekFrom).sort((x, y) => (y.count || 0) - (x.count || 0));
    out.push(seen.length ? 'נכשל השבוע:' : 'נכשל השבוע: כלום');
    for (const i of seen.slice(0, 5)) out.push(`- ${i.title || i.sample?.slice(0, 60) || 'שגיאה'} (${i.count || 0})${i.file ? ` ${i.file}:${i.line}` : ''} — ${STATUS_HE[i.status] || i.status}${i.station ? ` · תחנה ${i.station}` : ''}`);
    if (seen.length > 5) out.push(`- ועוד ${seen.length - 5}`);
    const ch = changes.filter((c) => c.bot === b.bot && !c.undo_of);
    if (ch.length) out.push('הגדרות ששונו (30 יום):', ...ch.slice(0, 5).map((c) => `- ${dm(c.ts)} ${c.key}: ${val(c.old)}→${val(c.new)} (${c.actor})${undone.has(c.id) ? ' (בוטל)' : ''}`));
    out.push(`עלות AI: השבוע ${usd2(sum(ai.week, b.bot))} · החודש ${usd2(sum(ai.month, b.bot))}${today?.costPerProduct != null ? ` · לתוצר היום ${usd2(today.costPerProduct)}` : ''}`);
    const sg = suggestions.filter((s) => s.bot === b.bot);
    if (sg.length) out.push('הצעות מהלילה:', ...sg.slice(0, 3).map((s) => `- ${s.text}${s.action ? ` [הגדרה ${s.action.key} → ${val(s.action.value)}]` : ''}`));
  }
  if (lessons.length) out.push('', '## שיעורים', ...lessons.slice(0, 10).map((l) => `- ${l.bot ? `${l.bot}: ` : ''}${l.lesson}`));
  return `${out.join('\n')}\n`;
}

// ---- the central scheduler (stage 7, bot-office docs/superpowers/plans/2026-11-22-aura-remaining.md, Part 4) ----
// Maor's RUN_TIMES (settings, Israel time: "HH:MM [input tag]" | "hourly HH-HH") start a GitHub-dispatched bot, only
// while its AURA_SCHEDULES switch is on and it is not paused. Each (bot, slot) is dispatched once (aura_dispatches).
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?: (\w{1,20}))?$/, HOURLY = /^hourly ([01]\d|2[0-3])-([01]\d|2[0-3])$/;
// Israel wall time on an Israel day -> UTC ms, with the offset of that very moment (daylight saving safe)
export function ilToUtc(day, h, m) {
  const start = ilDayStart(day), want = h * 60 + m;
  const p = (t) => { const [hh, mm] = ilHM(t).split(':').map(Number); return hh * 60 + mm; };
  let t = start + want * 60_000;
  for (let i = 0; i < 2; i++) t += (want - p(t)) * 60_000;   // a DST day: the wall clock jumped, so correct by the difference
  return t;
}
export function dueSlots(times, now, windowMin = 10) {
  const out = [];
  // today and yesterday: a slot near midnight (23:57) is still due at 00:02, which is already the next Israel day
  for (const day of [ilDay(ilDayStart(ilDay(now)) - 1), ilDay(now)]) for (const t of times || []) {
    const hr = HOURLY.exec(t), tm = TIME.exec(t);
    const slots = hr ? Array.from({ length: Math.max(0, hr[2] - hr[1] + 1) }, (_, i) => [Number(hr[1]) + i, 0, null]) : tm ? [[Number(tm[1]), Number(tm[2]), tm[3] || null]] : [];
    for (const [h, m, input] of slots) { const slot = ilToUtc(day, h, m); if (slot <= now && now < slot + windowMin * 60_000) out.push({ slot, input }); }
  }
  return out;
}
export function scheduleOf(times) {
  const il = [], hourly = [];
  for (const t of times || []) { const hr = HOURLY.exec(t), tm = TIME.exec(t); if (hr) hourly.push([Number(hr[1]), Number(hr[2])]); else if (tm) il.push(`${tm[1]}:${tm[2]}`); }
  return { ...(il.length ? { il } : {}), ...(hourly.length ? { hourly: [Math.min(...hourly.map((x) => x[0])), Math.max(...hourly.map((x) => x[1]))] } : {}) };
}
// bot_settings rows -> {bot: RUN_TIMES} for the bots whose switch is on (no RUN_TIMES row = the schema default)
export function auraTimesOf(settings, defaults = {}) {
  const by = {};
  for (const r of settings || []) (by[r.bot] ||= {})[r.key] = r.value;
  return Object.fromEntries(Object.entries(by).filter(([, s]) => s.AURA_SCHEDULES === true)
    .map(([bot, s]) => [bot, Array.isArray(s.RUN_TIMES) ? s.RUN_TIMES : defaults[bot]]).filter(([, t]) => Array.isArray(t) && t.length));
}
export function scheduleJobs({ bots, settings, defaults = {}, now }) {
  const times = auraTimesOf(settings, defaults);
  return bots.filter((b) => times[b.bot] && !b.paused && b.dispatch?.repo && b.dispatch?.file)
    .flatMap((b) => dueSlots(times[b.bot], now).map(({ slot, input }) => ({ bot: b.bot, name: b.name, slot, input, dispatch: b.dispatch })));
}
export const dispatchBody = (d, input) => {
  const inputs = { ...(d.inputs || {}), ...(input && d.input ? { [d.input]: input } : {}) };
  return { ref: 'main', ...(Object.keys(inputs).length ? { inputs } : {}) };
};
// io: insert(job) -> true only for a fresh (bot, slot) row; dispatch(job) -> {ok, status}; record(job, res); alert(key, text)
export async function runSchedule(jobs, io) {
  const out = { dispatched: 0, skipped: 0, failed: 0 };
  for (const j of jobs) {
    if (!(await io.insert(j))) { out.skipped++; continue; }
    const r = await io.dispatch(j).catch((e) => ({ ok: false, status: 0, error: String(e?.message || e) }));
    await io.record(j, r);
    if (r.ok) out.dispatched++;
    else { out.failed++; await io.alert(`sched|${j.bot}|${new Date(j.slot).toISOString()}`, `🚨 <b>${j.name}</b>: AURA לא הצליח להפעיל את הריצה של ${ilHM(j.slot)} ב-GitHub (${r.status || r.error || '?'}).`); }
  }
  return out;
}
// the missed-run check reads RUN_TIMES for the switched-on bots
export const withAuraTimes = (bots, times, since = {}) => bots.map((b) => (times[b.bot] ? { ...b, schedule: scheduleOf(times[b.bot]), scheduleSince: since[b.bot] || 0 } : b));
// bot_settings rows -> {bot: ms of the latest switch or times change}: the missed-run check skips slots before it
export function auraSinceOf(settings) {
  const out = {};
  for (const r of settings || []) { const t = Date.parse(r.updated_at); if (t > (out[r.bot] || 0)) out[r.bot] = t; }
  return out;
}
