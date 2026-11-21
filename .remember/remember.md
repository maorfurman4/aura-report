# Handoff

## State
AURA control-center design approved: bot-office/docs/2026-11-21-control-center-design.md. Nothing built.
Full plan + report-bot gaps in /Users/admin/bots/bot-office/HANDOFF.md (rewritten 2026-11-21 21:20).
aura-report has uncommitted changes (weekly.mjs, supabase.mjs, lib/report/test/nightly.yml) from another session.

## Next
1. aura-report: run node test.mjs, then commit/push the open changes (ask Maor).
2. One bot registry: Supabase table `bots`, seeded from aura.config.js + aura-report/bots.json.
3. Cloud alerts every 15 min in aura-report (failure, missed run, budget, Render down) via Telegram.

## Context
Reply to Maor in Hebrew. Never print secrets. Bot repos: branch + PR only. Order after: Tailscale, dashboard, control.
