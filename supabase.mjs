// Supabase REST for the report scripts. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
const URL_ = process.env.SUPABASE_URL?.replace(/\/$/, ''), KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
export async function sb(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${path.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();                                    // a write with return=minimal answers with no body
  return text ? JSON.parse(text) : null;
}

// a Telegram message to Maor (HTML); false when the pair is not set or the send failed
export async function telegram(text) {
  const { REPORT_TELEGRAM_TOKEN: token, REPORT_TELEGRAM_CHAT: chat } = process.env;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => null);
  if (!r?.ok) console.error('[report] telegram failed', r?.status);
  return Boolean(r?.ok);
}
