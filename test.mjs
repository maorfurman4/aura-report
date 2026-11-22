// node test.mjs : the report's facts are right
import assert from 'node:assert/strict';
import { ilDay, ilDayStart, reportDay, normalizeError, fingerprint, runsOf, expectedRuns, productsOf, health, botFacts, staleIssues, budget, weekOf, weeklyText, telegramText, slotsOf, watchAlerts, botOf, budgetAlert, limitOf } from './lib.mjs';

assert.equal(ilDay(Date.parse('2026-11-19T22:30:00Z')), '2026-11-20', 'Israel is UTC+2 in winter');
assert.equal(new Date(ilDayStart('2026-11-20')).toISOString(), '2026-11-19T22:00:00.000Z');
assert.equal(new Date(ilDayStart('2026-07-01')).toISOString(), '2026-06-30T21:00:00.000Z', 'UTC+3 in summer');
assert.equal(normalizeError('HTTPError: 503 for order 12345 "abc"'), normalizeError('HTTPError: 502 for order 999 "xyz"'), 'numbers and quotes do not split a problem');
assert.notEqual(fingerprint('news', 'proof', 'x'), fingerprint('news', 'editor', 'x'));

const at = (h, m = 0) => new Date(Date.parse('2026-11-19T22:00:00Z') + (h * 60 + m) * 60_000).toISOString();   // Israel time on 2026-11-20
const rows = [
  { ts: at(7), station_id: 'slot', status: 'working' }, { ts: at(7, 1), station_id: 'broadcast', status: 'done', metrics: { sent: 1 } },
  { ts: at(8), station_id: 'slot', status: 'working' }, { ts: at(8, 2), station_id: 'fit', status: 'error', text: 'boom', metrics: { limit: true } },
  { ts: at(12), station_id: 'guard', status: 'done' },
];
const runs = runsOf(rows);
assert.equal(runs.length, 3, 'bursts with a 5-minute gap are runs');
assert.deepEqual(runs.map((r) => r.failed), [false, true, false]);
const bot = { bot: 'panda', name: 'פנדה', schedule: { hourly: [7, 23] }, checkMissing: true, pipelines: [['slot', 'fit', 'broadcast'], ['guard', 'card']], stations: [{ id: 'slot' }, { id: 'fit' }, { id: 'broadcast' }, { id: 'guard' }, { id: 'card' }] };
assert.equal(expectedRuns(bot), 17);
assert.equal(expectedRuns({ schedule: { il: ['07:00'] } }), null, 'only bots marked checkMissing expect runs');
assert.equal(productsOf(bot, rows).delivered, 1);
assert.equal(productsOf(bot, rows).metrics['broadcast.sent'], 1);
assert.deepEqual(health({ failedRuns: 1, missing: 2, issues: [{ severity: 'critical', title: 'x' }] }).score, 100 - 15 - 20 - 20);
assert.equal(health({ failedRuns: 9 }).score, 0, 'never below 0');

const f = botFacts(bot, rows, { day: '2026-11-20', now: Date.parse('2026-11-20T21:59:00Z'), ai: [{ calls: 3, cost_usd: 0.03 }, { calls: 1, cost_usd: null }], aiWeek: [], openIssues: [] });
assert.equal(f.runs, 3); assert.equal(f.failedRuns, 1); assert.equal(f.success, 67);
assert.equal(f.missing, 17 - 2, 'the deals runs (with slot) count against the hourly schedule; the search burst does not');
assert.equal(f.aiCost, 0.03); assert.equal(f.aiUnpriced, 1); assert.equal(f.costPerProduct, 0.03);
assert.equal(f.limits, 1);
assert.deepEqual(f.silentStations, ['card']);
const early = botFacts(bot, rows, { day: '2026-11-20', now: Date.parse('2026-11-20T10:00:00Z') });
assert.equal(early.missing, 0, 'a day that is not over misses nothing yet');
// the day a report covers, whenever GitHub starts it
assert.equal(reportDay(Date.parse('2026-11-20T21:30:00Z')), '2026-11-20', '23:30 in winter = today');
assert.equal(reportDay(Date.parse('2026-11-21T00:39:00Z')), '2026-11-20', 'a run 5 hours late = yesterday (the bug of 2026-11-21)');
assert.equal(reportDay(Date.parse('2026-11-21T05:30:00Z')), '2026-11-20', 'the morning check = yesterday');
assert.equal(reportDay(Date.parse('2026-07-01T21:30:00Z')), '2026-07-01', '00:30 in summer = yesterday');
assert.equal(reportDay(Date.parse('2026-11-21T10:30:00Z')), '2026-11-21', 'after noon = today');

const tg = (over) => telegramText({ day: '2026-11-20', total: { runs: 3, failedRuns: 1, aiCost: 0.03 }, facts: [f, { ...f, bot: 'news', name: 'חדשות', health: 100, healthMinus: [] }], ...over });
assert.ok(tg({ facts: [{ ...f, health: 100, healthMinus: [] }] }).includes('כל 1 הבוטים תקינים'), 'all well = one line');
const t = tg({ problems: [{ bot: 'panda', station: 'fit', _new: true, title: 'x<y', explanation: 'למה', suggestion: 'מה', file: 'a.js', line: 3, day_counts: { '2026-11-20': 2 } }], late: true });
assert.ok(t.startsWith('⚠️') && t.includes('🔴 <b>פנדה</b>') && t.includes('🟢 תקינים: חדשות'));
assert.ok(t.includes('x&lt;y') && t.includes('×2') && t.includes('מה לבדוק: מה (a.js:3)') && !t.includes('localhost'));
const long = tg({ problems: Array.from({ length: 40 }, () => ({ bot: 'panda', explanation: 'א'.repeat(220), suggestion: 'ב'.repeat(220) })) });
assert.ok(long.length <= 4000 && long.endsWith('\n…'), 'Telegram\'s limit, cut on a line');
// problems close by themselves after 3 clean days, only while the bot keeps running
const iss = (bot, last, status = 'open') => ({ bot, status, last_seen: `${last}T10:00:00Z` });
const stale = staleIssues([iss('panda', '2026-11-17'), iss('panda', '2026-11-18'), iss('news', '2026-11-10'), iss('panda', '2026-11-01', 'fixed')], '2026-11-20', new Set(['panda']));
assert.deepEqual(stale.map((i) => i.last_seen.slice(0, 10)), ['2026-11-17'], '18, 19, 20 are not 3 clean days after the 18th; a bot that did not run closes nothing');

// the month's AI money: spent + the last days' average for the days left
assert.equal(limitOf({ settings: { budget_usd: 20 } }, undefined), 20, 'the AURA field wins');
assert.equal(limitOf({ settings: {} }, '12'), 12, 'then REPORT_BUDGET');
assert.equal(limitOf(null, undefined), 15, 'then 15');
assert.equal(limitOf({ settings: { budget_usd: 'x' } }, undefined), 15, 'a bad value is ignored');
const m = budget([{ day: '2026-11-19', cost_usd: 0.2 }, { day: '2026-11-20', cost_usd: 0.4 }, { day: '2026-10-31', cost_usd: 9 }], '2026-11-20', 15);
assert.equal(m.spent, 0.6, 'only this month');
assert.equal(m.forecast, Number((0.6 + 0.3 * 10).toFixed(4))); assert.equal(m.over, false);
assert.equal(budget([{ day: '2026-11-20', cost_usd: 2 }], '2026-11-20').over, true, '$2 a day for the 10 days left = $22, over $15');
const tm = tg({ closed: [{ title: 'ישנה' }], budget: { spent: 0.6, forecast: 16, limit: 15, over: true } });
assert.ok(tm.includes('נסגרו לבד') && tm.includes('ישנה') && tm.includes('⚠️ מעל התקציב ($15)'));

// the weekly summary
assert.deepEqual(weekOf('2026-11-21'), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
assert.equal(weekOf('2026-11-21', 7)[6], '2026-11-14');
assert.equal(weekOf('2026-03-28')[0], '2026-03-22', 'over the March DST change');
const day1 = { facts: { total: { aiCost: 1 }, bots: [{ bot: 'panda', name: 'פנדה', runs: 9, failedRuns: 1, missing: 0, aiCost: 1 }, { bot: 'news', name: 'חדשות', runs: 0, failedRuns: 0, missing: 0, aiCost: 0 }] } };
const w = weeklyText({ days: weekOf('2026-11-21'), reports: [day1, day1], prevReports: [{ facts: { total: { aiCost: 1 } } }],
  issues: [{ bot: 'panda', title: 'חוזרת', day_counts: { '2026-11-16': 2, '2026-11-18': 1 } }, { bot: 'panda', title: 'פעם', day_counts: { '2026-11-16': 1 } }] });
assert.ok(w.includes('15/11–21/11') && w.includes('2/7 ימים') && w.includes('(שבוע קודם $1.00, +100%)'));
assert.ok(w.includes("🔴 <b>פנדה</b>: אמינות 89% · 18 ריצות · 2 נכשלו") && w.includes('⚪ <b>חדשות</b>: לא רץ'), '16 of 18');
assert.ok(w.includes('• חוזרת (פנדה · 2 ימים · ×3)') && !w.includes('פעם'));
// the hourly watch (now: 2026-11-20 14:00 in Israel)
const NOW = Date.parse('2026-11-20T12:00:00Z');
assert.ok(slotsOf({ il: ['05:30'] }, NOW).includes(Date.parse('2026-11-20T03:30:00Z')));
assert.ok(slotsOf({ utc: ['04:00'] }, NOW).includes(Date.parse('2026-11-20T04:00:00Z')));
assert.equal(slotsOf({ hourly: [7, 23] }, NOW).length, 34);
const wb = [
  { bot: 'debi', name: 'דבי', schedule: { il: ['05:30', '22:00'] }, checkMissing: true, pipelines: [['weather', 'writer']] },
  { bot: 'news', name: 'חדשות', schedule: { utc: ['04:00'] }, checkMissing: true, pipelines: [['market', 'courier']] },
  { bot: 'panda', name: 'פנדה', pipelines: [['slot', 'fit', 'broadcast']] },
];
const ev = (bot, iso, station_id, status, text) => ({ bot, ts: `2026-11-${iso}Z`, station_id, status, text });
const alerts = watchAlerts({ bots: wb, now: NOW, events: [
  ev('debi', '20T03:31:00', 'writer', 'done'), ev('news', '20T04:20:00', 'courier', 'done'),
  ev('panda', '20T10:00:00', 'fit', 'error', 'soft'), ev('panda', '20T10:01:00', 'broadcast', 'done'),
  ev('panda', '20T11:00:00', 'slot', 'working'), ev('panda', '20T11:01:00', 'fit', 'error', 'boom <x>'),
] });
assert.deepEqual(alerts.map((a) => a.key), ['miss|debi|2026-11-19T20:00:00.000Z', 'fail|panda|2026-11-20T11:00:00.000Z'],
  'debi ran at 05:30 but not at 22:00 yesterday; news ran late but within 3 hours; panda delivered at 12:00 despite an error, not at 13:00');
assert.ok(alerts[0].text.includes('22:00 לא קרתה') && alerts[1].text.includes('תחנה fit') && alerts[1].text.includes('boom &lt;x&gt;'));
assert.equal(watchAlerts({ bots: wb.slice(2), now: Date.parse('2026-11-20T11:05:00Z'), events: [ev('panda', '20T11:00:00', 'slot', 'working'), ev('panda', '20T11:01:00', 'fit', 'error')] }).length, 0, 'a run 4 minutes old may still retry');
// the registry row (public.bots) and the budget alert
const row = { id: 'news', name: 'חדשות', schedule: { utc: ['04:00'] }, pipelines: [['a']], stations: [{ id: 'a' }], check_missing: true, paused: false };
assert.equal(botOf(row).bot, 'news'); assert.equal(expectedRuns(botOf(row)), 1);
assert.equal(expectedRuns(botOf({ ...row, paused: true })), null, 'a paused bot expects no runs');
assert.equal(budgetAlert({ spent: 11, forecast: 14, limit: 15 }, '2026-11-21'), null);
assert.equal(budgetAlert({ spent: 12, forecast: 20, limit: 15 }, '2026-11-21').key, 'budget|2026-11|80');
assert.equal(budgetAlert({ spent: 15.5, forecast: 20, limit: 15 }, '2026-11-21').key, 'budget|2026-11|over');
console.log('ok: report facts');

// stage 6: the knowledge file and the setting actions
{
  const { knowledgeMd, cleanSuggestions } = await import('./lib.mjs');
  const kbots = [
    botOf({ id: 'debi', name: 'דבי', repo: 'maorfurman4/bot-debi-briefing', host: 'GitHub Actions', schedule: { il: ['05:30'] }, pipelines: [['calendar', 'writer']], stations: [{ id: 'calendar', name: 'המזכירה', does: 'יומנים' }, { id: 'writer', name: 'הכותבת', does: 'שולחת' }] }),
    botOf({ id: 'mail', name: 'מייל', repo: 'maorfurman4/bot-mailbox-sync', pipelines: [['smart']], stations: [{ id: 'smart', name: 'הממיין', does: 'AI' }], settings: [{ key: 'DAILY_LIMIT', kind: 'int', min: 0, max: 20 }] }),
  ];
  const day = '2026-11-21', ts = (d) => `${d}T08:00:00Z`;
  const md = knowledgeMd({
    day, builtAt: Date.parse('2026-11-21T21:30:00Z'), bots: kbots,
    week: [{ day: '2026-11-20', bots: [{ bot: 'debi', runs: 2, failedRuns: 1 }] }, { day, bots: [{ bot: 'debi', runs: 2, failedRuns: 0, health: 90, costPerProduct: 0.01 }] }],
    issues: [{ bot: 'debi', title: 'שגיאת יומן', count: 3, file: 'briefing.py', line: 40, status: 'open', last_seen: ts('2026-11-20') },
      { bot: 'debi', title: 'ישנה', count: 9, status: 'open', last_seen: ts('2026-11-01') }],
    changes: [{ id: 1, ts: ts('2026-11-19'), actor: 'maor', bot: 'mail', key: 'DAILY_LIMIT', old: 3, new: 5 },
      { id: 2, ts: ts('2026-11-19'), actor: 'maor', bot: 'mail', key: 'DAILY_LIMIT', old: 5, new: 3, undo_of: 1 }],
    ai: { week: [{ bot: 'mail', cost_usd: 0.5 }], month: [{ bot: 'mail', cost_usd: 1.25 }] }, money: { spent: 4, limit: 15, forecast: 9 },
    suggestions: [{ bot: 'mail', kind: 'cost', text: 'להוריד מגבלה', action: { key: 'DAILY_LIMIT', value: 2 } }],
    lessons: [{ bot: 'debi', lesson: 'ICS מחזיר 500 בלילה' }],
  });
  assert.match(md, /^# AURA/);
  assert.ok(md.includes('## דבי (debi)'));
  assert.ok(md.includes('- שגיאת יומן (3) briefing.py:40 — פתוחה'), 'an issue of this week with its place');
  assert.ok(!md.includes('ישנה'), 'an issue last seen weeks ago is not "this week"');
  assert.ok(md.includes('השבוע: 4 ריצות, 1 נכשלו (75% הצלחה) · ציון היום 90'));
  assert.ok(md.includes('DAILY_LIMIT: 3→5 (maor) (בוטל)'), 'an undone change is marked, the undo row itself is not listed');
  assert.ok(md.includes('עלות AI: השבוע $0.50 · החודש $1.25'));
  assert.ok(md.includes('[הגדרה DAILY_LIMIT → 2]'));
  assert.ok(md.includes('ICS מחזיר 500 בלילה'));
  // 7 big bots stay short
  const big = Array.from({ length: 7 }, (_, n) => botOf({ id: `b${n}`, name: `b${n}`, pipelines: [Array.from({ length: 11 }, (_, k) => `s${k}`)], stations: Array.from({ length: 11 }, (_, k) => ({ id: `s${k}`, name: 's', does: 'd' })) }));
  const many = big.flatMap((b) => Array.from({ length: 20 }, () => ({ bot: b.bot, title: 'x', count: 1, status: 'open', last_seen: ts(day) })));
  const chs = big.flatMap((b, n) => Array.from({ length: 20 }, (_, k) => ({ id: n * 100 + k + 1, ts: ts(day), actor: 'maor', bot: b.bot, key: 'K', old: 1, new: 2 })));
  const sgs = big.slice(0, 2).flatMap((b) => Array.from({ length: 3 }, () => ({ bot: b.bot, text: "t" })));   // the report keeps 6 in all
  const lines = knowledgeMd({ day, builtAt: Date.now(), bots: big, issues: many, changes: chs, suggestions: sgs, lessons: Array(20).fill({ lesson: 'l' }) }).split('\n').length;
  assert.ok(lines <= 250, `knowledge file is ${lines} lines`);
  // setting actions survive only for a key the bot has
  const cs = cleanSuggestions([{ bot: 'mail', text: 'a', action: { key: 'DAILY_LIMIT', value: 5 } }, { bot: 'mail', text: 'b', action: { key: 'NOPE', value: 1 } }, { bot: 'debi', text: 'c', action: { key: 'DAILY_LIMIT', value: 1 } }, { bot: 'mail', text: 'd', action: { key: 'DAILY_LIMIT' } }], kbots);
  assert.deepEqual(cs.map((s) => s.action || null), [{ key: 'DAILY_LIMIT', value: 5 }, null, null, null]);
  assert.equal(cleanSuggestions(null, kbots).length, 0);
  assert.equal(cleanSuggestions(Array(9).fill({ bot: 'mail', text: 'x' }), kbots).length, 6);
  console.log('ok: knowledge file');
}

// the central scheduler (stage 7): AURA starts GitHub-dispatched bots at Maor's RUN_TIMES, only when the switch is on
{
  const { dueSlots, scheduleOf, scheduleJobs, dispatchBody, runSchedule, auraTimesOf, withAuraTimes } = await import('./lib.mjs');
  const Z = (iso) => Date.parse(iso);
  // 05:33 Israel (winter) -> the 05:30 slot with its input tag; 05:41 -> none (10-minute window)
  assert.deepEqual(dueSlots(['05:30 morning', '22:00 evening'], Z('2026-11-22T03:33:00Z')), [{ slot: Z('2026-11-22T03:30:00Z'), input: 'morning' }]);
  assert.deepEqual(dueSlots(['05:30 morning'], Z('2026-11-22T03:41:00Z')), []);
  assert.deepEqual(dueSlots(['05:30 morning'], Z('2026-11-22T03:29:59Z')), [], 'not before the slot');
  assert.deepEqual(dueSlots(['hourly 07-23'], Z('2026-11-22T07:02:00Z')), [{ slot: Z('2026-11-22T07:00:00Z'), input: null }], '09:02 -> the 09:00 slot');
  assert.deepEqual(dueSlots(['hourly 07-23'], Z('2026-11-22T22:02:00Z')), [], 'midnight is outside 07-23');
  // daylight saving: 05:30 stays 05:30 Israel time on the change day (2026-03-27) and in summer
  assert.deepEqual(dueSlots(['05:30'], Z('2026-03-27T02:31:00Z')).map((s) => s.slot), [Z('2026-03-27T02:30:00Z')]);
  assert.deepEqual(dueSlots(['05:30'], Z('2026-07-01T02:31:00Z')).map((s) => s.slot), [Z('2026-07-01T02:30:00Z')]);
  assert.deepEqual(dueSlots(['bad', '25:00'], Z('2026-11-22T03:33:00Z')), [], 'bad entries are skipped');
  // RUN_TIMES -> the schedule shape the missed-run check reads
  assert.deepEqual(scheduleOf(['05:30 morning', '22:00 evening', 'hourly 07-23']), { il: ['05:30', '22:00'], hourly: [7, 23] });
  const debi = botOf({ id: 'debi', name: 'דבי', schedule: { il: ['05:30', '22:00'] }, check_missing: true, dispatch: { repo: 'o/debi', file: 'main.yml', input: 'mode' } });
  const panda = botOf({ id: 'panda', name: 'פנדה', schedule: { hourly: [7, 23] }, dispatch: { repo: 'o/panda', file: 'daily-deals.yml', inputs: { force: 'false' } } });
  const news = botOf({ id: 'news', name: 'חדשות', schedule: { utc: ['04:00'] }, dispatch: { repo: 'o/news', file: 'main.yml' } });
  const paused = botOf({ id: 'mail', name: 'מייל', paused: true, dispatch: { repo: 'o/mail', file: 'x.yml' } });
  const settings = [
    { bot: 'debi', key: 'AURA_SCHEDULES', value: true }, { bot: 'debi', key: 'RUN_TIMES', value: ['05:30 morning', '22:00 evening'] },
    { bot: 'panda', key: 'AURA_SCHEDULES', value: true },   // no RUN_TIMES row: the schema default is the bot's real schedule
    { bot: 'news', key: 'RUN_TIMES', value: ['05:30'] },     // times without the switch: nothing
    { bot: 'mail', key: 'AURA_SCHEDULES', value: true }, { bot: 'mail', key: 'RUN_TIMES', value: ['05:30'] },   // paused: nothing
  ];
  const defaults = { panda: ['hourly 07-23'], debi: ['05:30 morning', '22:00 evening'] };
  assert.deepEqual(auraTimesOf(settings, defaults), { debi: ['05:30 morning', '22:00 evening'], panda: ['hourly 07-23'], mail: ['05:30'] }, 'only switched-on bots (pause is checked by scheduleJobs)');
  const jobs = scheduleJobs({ bots: [debi, panda, news, paused], settings, defaults, now: Z('2026-11-22T03:33:00Z') });
  assert.deepEqual(jobs.map((j) => [j.bot, j.input]), [['debi', 'morning']], '05:33: Debi only (panda starts at 07:00)');
  assert.equal(scheduleJobs({ bots: [debi], settings: [{ bot: 'debi', key: 'AURA_SCHEDULES', value: false }], defaults, now: Z('2026-11-22T03:33:00Z') }).length, 0, 'switch off -> nothing');
  assert.deepEqual(dispatchBody(debi.dispatch, 'morning'), { ref: 'main', inputs: { mode: 'morning' } });
  assert.deepEqual(dispatchBody(panda.dispatch, null), { ref: 'main', inputs: { force: 'false' } });
  assert.deepEqual(dispatchBody({ repo: 'o/x', file: 'y.yml' }, 'tag'), { ref: 'main' }, 'a tag without an input name is dropped');
  // each (bot, slot) is dispatched once: a second run in the same window inserts nothing and dispatches nothing
  const seen = new Set(), calls = [], alerts = [];
  const io = {
    insert: async (j) => { const k = `${j.bot}|${j.slot}`; if (seen.has(k)) return false; seen.add(k); return true; },
    dispatch: async (j) => { calls.push(j.bot); return { ok: true, status: 204 }; },
    record: async () => {}, alert: async (k) => { alerts.push(k); },
  };
  assert.deepEqual(await runSchedule(jobs, io), { dispatched: 1, skipped: 0, failed: 0 });
  assert.deepEqual(await runSchedule(jobs, io), { dispatched: 0, skipped: 1, failed: 0 });
  assert.deepEqual(calls, ['debi']);
  // a failed dispatch -> a once-alert, counted
  const bad = { ...io, insert: async () => true, dispatch: async () => ({ ok: false, status: 404 }) };
  assert.deepEqual(await runSchedule(jobs, bad), { dispatched: 0, skipped: 0, failed: 1 });
  assert.equal(alerts.length, 1);
  // the missed-run check follows RUN_TIMES when the switch is on
  const moved = withAuraTimes([debi], { debi: ['06:15 morning'] });
  assert.deepEqual(moved[0].schedule, { il: ['06:15'] });
  assert.deepEqual(withAuraTimes([news], {})[0].schedule, { utc: ['04:00'] }, 'switch off -> the registry schedule');
  console.log('ok: scheduler');
}
