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
- `bots.json` is exported from the office manifest (office/public/js/aura.config.js); re-export when it changes.
- Only technical data reaches the model: station names, error lines, numbers, times, costs. Never message content.
