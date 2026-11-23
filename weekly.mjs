// The weekly summary, sent on Sunday morning: the 7 Israel days ending yesterday (from bot_reports), vs the week before.
// Env: as report.mjs; REPORT_DAY=YYYY-MM-DD sets the week's last day. Without the Telegram pair it only prints.
import { reportDay, weekOf, weeklyText, claudeLines } from './lib.mjs';
import { sb, telegram } from './supabase.mjs';

const end = process.env.REPORT_DAY || reportDay(Date.now());     // Sunday morning = Saturday
const days = weekOf(end), prevDays = weekOf(end, 7);
const all = await sb(`bot_reports?select=day,facts&day=gte.${prevDays[0]}&day=lte.${end}&order=day.asc`);
const issues = await sb('bot_issues?select=bot,station,title,day_counts');
const claude = await sb('aura_metrics?select=value,updated_at&key=eq.claude_usage_week').catch(() => []);   // counts from the office on the Mac
const text = [weeklyText({ days, reports: all.filter((r) => days.includes(r.day)), prevReports: all.filter((r) => prevDays.includes(r.day)), issues }), ...claudeLines(claude?.[0], Date.now())].join('\n');
console.log(text);
await telegram(text);
