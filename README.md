# aura-report

The nightly bots report for AURA HQ (Maor's bot office). Every night at 23:30 Israel time (00:30 in summer) GitHub
Actions reads the day's technical data from Supabase, computes the facts per bot (runs, success, durations, AI cost,
products, missing scheduled runs, health 0-100), keeps every problem in `bot_issues` until it is solved, asks a cheap
model (gpt-6-luna) to explain new problems and suggest savings, saves `bot_reports`, and sends a short Telegram summary.
The office shows it at http://localhost:4747/report.html. Design: bot-office/docs/2026-11-20-bot-report-design.md.

Secrets (Settings > Secrets and variables > Actions): SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY,
REPORT_TELEGRAM_TOKEN, REPORT_TELEGRAM_CHAT. Without OPENAI_API_KEY the report has facts only; without the Telegram
pair nothing is sent.

- `node test.mjs` checks the facts; `node report.mjs` builds a report (REPORT_DAY=YYYY-MM-DD rebuilds a day).
- A run before noon (Israel) covers yesterday. 07:30: catch-up if the night's report is missing. A failed run alerts on Telegram.
- A problem not seen for 3 days while its bot runs closes by itself. Telegram shows the month's AI spend and forecast,
  with an alert over REPORT_BUDGET (default $15).
- `node weekly.mjs`: the weekly summary (Sunday 08:00, or the workflow's "weekly" input); prints it and sends it.

## aura-watch (Supabase)
`watch/index.ts` is a Supabase Edge Function (`aura-watch`, no JWT: it checks its own key). pg_cron in Supabase calls it
(migration `aura_watch`): every hour at :50 the watch (a run that failed without its product, a scheduled run 3 hours
late, a dead webhook of Yahli or finance, a missing morning report; each alert once, kept in `bot_alerts`; quiet at
night), and at 23:30 / 07:30 / Sunday 08:00 it starts this workflow on GitHub at the exact time (GitHub's cron stays as
a fallback). It also gets the "✔️ תיקנתי" buttons of the nightly message (run `?job=setup` once to set the webhook).
Secrets (Supabase > Edge Functions > Secrets): REPORT_TELEGRAM_TOKEN, REPORT_TELEGRAM_CHAT, GH_DISPATCH_TOKEN
(fine-grained, this repo only, Actions: read and write), YAHLI_TELEGRAM_TOKEN, FINANCE_TELEGRAM_TOKEN.
Deploy with `watch/index.ts`, `lib.mjs` and `bots.json` (the function imports them from `..`).
- `bots.json` is exported from the office manifest (office/public/js/aura.config.js); re-export when it changes.
- Only technical data reaches the model: station names, error lines, numbers, times, costs. Never message content.
