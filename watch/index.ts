// aura-watch (Supabase Edge Function): the bots report's watch, run by pg_cron in Supabase.
//   ?job=watch          every 15 minutes: a run that failed without its product, a scheduled run that did not happen, a dead
//                       webhook of Yahli or finance, a report that was not built by the morning. Each alert is sent once.
//   ?job=dispatch&kind= nightly | morning | weekly: starts the report workflow on GitHub at the exact time.
//   ?job=setup          points the report bot's Telegram webhook here (the "✔️ תיקנתי" buttons of the nightly report).
// Jobs need the x-watch-key header (public.watch_key(), kept in Supabase Vault); Telegram is checked by its secret token.
// Secrets (Edge Functions > Secrets): REPORT_TELEGRAM_TOKEN, REPORT_TELEGRAM_CHAT, GH_DISPATCH_TOKEN,
// YAHLI_TELEGRAM_TOKEN, FINANCE_TELEGRAM_TOKEN. A missing one turns its part off. Optional: REPORT_BUDGET (default 15; Maor's field in AURA wins),
// RENDER_HEALTH_URL (default the Panda search bot's /health).
import { botOf, budget, budgetAlert, ilDay, ilDayStart, limitOf, watchAlerts } from '../lib.mjs';

const env = (k: string) => Deno.env.get(k) || '';
const SB = env('SUPABASE_URL'), SK = env('SUPABASE_SERVICE_ROLE_KEY'), TG = env('REPORT_TELEGRAM_TOKEN'), CHAT = env('REPORT_TELEGRAM_CHAT');
const esc = (s: unknown) => String(s ?? '').replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]!));
const ilHour = (ms: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

async function sb(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${path.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
async function tg(method: string, body: object, token = TG) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return r ? await r.json().catch(() => ({ ok: false })) : { ok: false };
}
// the Telegram webhook's secret: derived from the bot token, so there is no extra secret to keep
const secret = async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aura-watch|${TG}`)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);

// an alert is sent once: its key goes into bot_alerts first; if Telegram fails the key is removed, so the next check retries
async function once(key: string, text: string) {
  const added = await sb('bot_alerts?on_conflict=key', { method: 'POST', body: JSON.stringify({ key }), headers: { Prefer: 'resolution=ignore-duplicates,return=representation' } });
  if (!added?.length) return false;
  const h = ilHour(Date.now());
  const sent = await tg('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: h < 7 || h >= 23 });
  if (!sent.ok) await sb(`bot_alerts?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
  return Boolean(sent.ok);
}

async function watch() {
  const now = Date.now(), sent: string[] = [], hooks: Record<string, string> = {};
  const events = await sb(`bot_events?select=ts,bot,kind,text,station_id,status&ts=gte.${new Date(now - 28 * 3600_000).toISOString()}&order=ts.asc&limit=20000`);
  const bots = (await sb('bots?select=*&order=sort.asc')).map(botOf);   // the registry (public.bots)
  for (const a of watchAlerts({ bots, events, now })) if (await once(a.key, a.text)) sent.push(a.key);
  // the month's AI budget: 80%, then over
  const today = ilDay(now), money = budget(await sb(`ai_usage_daily?select=day,cost_usd&day=gte.${today.slice(0, 7)}-01&day=lte.${today}`), today, limitOf(await sb('rpc/aura_config', { method: 'POST', body: JSON.stringify({ p_bot: 'aura' }) }).catch(() => null), env('REPORT_BUDGET')));
  const b = budgetAlert(money, today);
  if (b && await once(b.key, b.text)) sent.push(b.key);
  // Render (Panda's search bot, the reels approval): only 07-23, when its own pinger keeps it awake, so this adds no hours
  const hr = ilHour(now);
  if (hr >= 7 && hr < 23) {
    const r = await fetch(env('RENDER_HEALTH_URL') || 'https://panda-ali-bot.onrender.com/health', { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!r?.ok && await once(`render|${today}|${hr}`, `🚨 <b>Render</b>: השרת של פנדה (בוט החיפוש ואישור הרילס) לא עונה${r ? ` (${r.status})` : ''}`)) sent.push('render');
  }
  // the bots that only answer messages: Telegram tells whether their webhook is set and whether it fails
  for (const [bot, name, token] of [['yahli', 'יהלי', env('YAHLI_TELEGRAM_TOKEN')], ['finance', 'בוט הכספים', env('FINANCE_TELEGRAM_TOKEN')]]) {
    if (!token) { hooks[bot] = 'no token'; continue; }
    const info = (await tg('getWebhookInfo', {}, token)).result;
    const [kind, why] = !info ? ['tg', 'טלגרם לא ענה על מצב ה-webhook']
      : !info.url ? ['none', 'אין webhook: הבוט לא מקבל הודעות']
      : info.last_error_date * 1000 > now - 2 * 3600_000 ? ['error', `ה-webhook נכשל: ${info.last_error_message || ''}`]
      : info.pending_update_count >= 5 ? ['pending', `${info.pending_update_count} הודעות מחכות ולא נמסרו לבוט`] : [];
    hooks[bot] = kind || 'ok';
    if (why && await once(`hook|${bot}|${ilDay(now)}|${kind}`, `🚨 <b>${name}</b>: ${esc(why)}`)) sent.push(`hook|${bot}`);
  }
  // the morning: yesterday's full report is built (the night's run, or the 07:30 catch-up)
  const h = ilHour(now);
  if (h >= 9 && h < 12) {
    const y = ilDay(ilDayStart(ilDay(now)) - 1), [r] = await sb(`bot_reports?select=created_at&day=eq.${y}`);
    if (!r || Date.parse(r.created_at) - ilDayStart(y) < 23 * 3600_000) {
      if (await once(`report|${y}`, `🚨 <b>דוח הבוטים</b>: הדוח המלא של ${y} לא נבנה, גם לא בבדיקת הבוקר. כדאי לבדוק את ה-workflow ב-GitHub (aura-report).`)) sent.push(`report|${y}`);
    }
  }
  return { ok: true, events: events.length, sent, hooks };
}

async function dispatch(kind: string) {
  const inputs = kind === 'weekly' ? { weekly: true } : { scheduled: true, morning: kind === 'morning' };
  const r = await fetch('https://api.github.com/repos/maorfurman4/aura-report/actions/workflows/nightly.yml/dispatches', {
    method: 'POST', headers: { Authorization: `Bearer ${env('GH_DISPATCH_TOKEN')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aura-watch' },
    body: JSON.stringify({ ref: 'main', inputs }), signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) await once(`dispatch|${kind}|${ilDay(Date.now())}`, `🚨 <b>דוח הבוטים</b>: לא הצלחתי להפעיל את הדוח ב-GitHub (${kind}, ${r.status}). ה-cron של GitHub נשאר כגיבוי.`);
  return { ok: r.ok, status: r.status };
}

// a "✔️ תיקנתי" button of the nightly report: the problem is marked fixed (only from Maor's chat)
async function button(update: any) {
  const q = update.callback_query;
  if (!q) return;
  const id = /^fixed:(\d+)$/.exec(q.data || '')?.[1];
  if (!id || String(q.message?.chat?.id) !== CHAT) return tg('answerCallbackQuery', { callback_query_id: q.id });
  const [it] = await sb(`bot_issues?id=eq.${id}&select=title,station`);
  await sb(`bot_issues?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'fixed', fixed_at: new Date().toISOString(), note: 'סומנה כתוקנה בטלגרם', updated_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: `✔️ סימנתי כתוקנה: ${it?.title || it?.station || id}. אם תחזור, הדוח יגיד "חזרה".` });
}

async function setup(url: string) {
  const info = (await tg('getWebhookInfo', {})).result;
  if (!info) return { ok: false, why: 'Telegram did not answer (is REPORT_TELEGRAM_TOKEN set?)' };
  if (info.url && info.url !== url) return { ok: false, why: 'the report bot already has another webhook; not replacing it', url: info.url };
  return tg('setWebhook', { url, secret_token: await secret(), allowed_updates: ['callback_query'] });
}

Deno.serve(async (req) => {
  const u = new URL(req.url), json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const tgSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (tgSecret != null) {
      if (!TG || tgSecret !== await secret()) return json({ ok: false }, 401);
      await button(await req.json());
      return json({ ok: true });
    }
    const key = await sb('rpc/watch_key', { method: 'POST', body: '{}' });
    if (!key || req.headers.get('x-watch-key') !== key) return json({ ok: false }, 401);
    const job = u.searchParams.get('job');
    if (job === 'watch') return json(await watch());
    if (job === 'dispatch') return json(await dispatch(u.searchParams.get('kind') || 'nightly'));
    if (job === 'setup') return json(await setup(`${SB}/functions/v1/aura-watch`));
    return json({ ok: false, why: 'unknown job' }, 400);
  } catch (e) {
    console.error('[watch]', e);
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  }
});
