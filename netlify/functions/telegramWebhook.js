// netlify/functions/telegramWebhook.js
// Minimal Telegram webhook for Netlify Functions (CommonJS).
// Expects env: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (or anon key if you prefer).
// Optional: VERIFY_TOKEN to avoid random requests (we'll accept a query param ?token=VERIFY_TOKEN).

const { URL } = require('url');
const fetch = global.fetch || require('node-fetch'); // node-fetch fallback

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service role ONLY if you must

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in env');
}

exports.handler = async function (event, context) {
  try {
    // Quick health: Netlify sometimes sends GET for function preview - just return OK
    if (event.httpMethod === 'GET') {
      return { statusCode: 200, body: 'OK' };
    }

    // Simple token check: set Netlify webhook URL to include ?token=xxx and set VERIFY_TOKEN in env
    if (VERIFY_TOKEN) {
      const url = new URL('http://dummy' + (event.path || '') + (event.rawQueryString ? `?${event.rawQueryString}` : ''));
      const t = url.searchParams.get('token');
      if (!t || t !== VERIFY_TOKEN) {
        return { statusCode: 403, body: 'Forbidden' };
      }
    }

    // Parse Telegram update
    const update = JSON.parse(event.body || '{}');

    // IMMEDIATE ACK: Telegram needs quick 200 OK. We'll do minimal work then respond.
    // But we still perform DB insert before returning (keep it lightweight).
    // If you need heavier processing, push to external job queue instead of doing it here.
    (async () => {
      try {
        // Example: store update metadata to Supabase via REST
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
          // Build a tiny payload to persist
          const payload = {
            raw_update: update,
            created_at: new Date().toISOString()
          };

          // Use REST insert into a simple table 'incoming_updates' (create this table in Supabase)
          await fetch(`${SUPABASE_URL}/rest/v1/incoming_updates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
              Prefer: 'return=representation'
            },
            body: JSON.stringify(payload)
          }).catch(e => {
            console.warn('Supabase store failed', e && e.message);
          });
        }

        // Example quick reaction: if message.text === '/ping', reply
        if (update.message && update.message.text) {
          const txt = String(update.message.text || '').trim().toLowerCase();
          if (txt === '/ping') {
            const chatId = update.message.chat.id;
            const sendUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            await fetch(sendUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: 'pong' })
            }).catch(() => {});
          }
        }

        // If update contains voice/file you may enqueue a job to a dedicated worker (preferred).
      } catch (err) {
        console.error('background processing error', err && err.message);
      }
    })();

    // IMPORTANT: return OK right away
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('webhook handler error', err && err.message);
    return { statusCode: 500, body: 'Server error' };
  }
};