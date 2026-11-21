// node test.mjs : the report's facts are right
import assert from 'node:assert/strict';
import { ilDay, ilDayStart, reportDay, normalizeError, fingerprint, runsOf, expectedRuns, productsOf, health, botFacts, telegramText } from './lib.mjs';

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
console.log('ok: report facts');
