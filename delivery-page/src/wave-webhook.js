// Wave webhook receiver logic (POST /webhooks/wave). Pure/crypto only -- index.js does the I/O.
//
// Wave (Pro plan) POSTs invoice events to our endpoint. Verified against the official Webhooks Setup Guide
// (developer.waveapps.com, 2026-09-25):
//   headers  x-wave-signature: "t=<unix seconds>,v1=<hex hmac>"   (+ x-wave-timestamp)
//   signed   "<t>.<raw request body>"  HMAC-SHA256 with the webhook secret; reject when t is > 5 min off
//   body     {"business_id","event_id","event_type":"invoice.paid","data":{"invoice_id":"2496756670638588934",
//             "amount_paid":"8.98","remaining_balance":"0.00","paid_date":"2026-04-29","currency_code","customer_id"}}
//   events   invoice.paid / invoice.overpaid / invoice.partially_paid (also .sent/.viewed/... which we ignore)
// `invoice_id` is the numeric part of the GraphQL invoice id (Business:<uuid>;Invoice:<n>) -- 19 digits, so
// ALWAYS a string here, never a JS number.
//
// A Job is unlocked ONLY when the invoice is FULLY paid (remaining balance <= 0); a partial payment is
// recorded (so /admin can show "paid $X, $Y left") but does not unlock.

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// "t=1714400000,v1=abcdef..." -> { t: '1714400000', v1: 'abcdef...' } (tolerates spaces / ':' instead of '=').
export function parseSignatureHeader(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const m = /^\s*([a-z0-9]+)\s*[=:]\s*(\S+)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return { t: out.t || '', v1: (out.v1 || '').toLowerCase() };
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// rawBody must be the untouched request text (re-serialising breaks the signature).
export async function verifyWaveSignature({ header, rawBody, secret, nowMs = Date.now(), toleranceSec = 300 }) {
  if (!secret) return false;
  const { t, v1 } = parseSignatureHeader(header);
  if (!/^\d{9,13}$/.test(t) || !v1) return false;
  const tSec = t.length > 11 ? Number(t) / 1000 : Number(t);   // tolerate a millisecond timestamp
  if (Math.abs(nowMs / 1000 - tSec) > toleranceSec) return false;
  return safeEqualHex(await hmacHex(secret, `${t}.${rawBody}`), v1);
}

// "8.98" / "1,695.00" -> 898 / 169500; anything else -> null.
export function moneyToCents(value) {
  const s = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// -> { kind: 'paid' | 'partial' | 'ignore', invoiceId, paidCents, remainingCents, paidDate }
export function classifyWaveEvent(evt) {
  const type = evt && evt.event_type;
  const d = (evt && evt.data) || {};
  const invoiceId = d.invoice_id == null ? '' : String(d.invoice_id);
  const paidCents = moneyToCents(d.amount_paid);
  const remainingCents = moneyToCents(d.remaining_balance);
  const paidDate = typeof d.paid_date === 'string' ? d.paid_date : null;
  const base = { invoiceId, paidCents, remainingCents, paidDate };
  if (!/^\d{1,30}$/.test(invoiceId)) return { kind: 'ignore', ...base };
  if (type === 'invoice.partially_paid') return { kind: 'partial', ...base };
  if (type === 'invoice.paid' || type === 'invoice.overpaid') {
    // "paid in full" by definition -- but if the payload itself says money is still owed, believe that.
    if (remainingCents != null && remainingCents > 0) return { kind: 'partial', ...base };
    return { kind: 'paid', ...base };
  }
  return { kind: 'ignore', ...base };
}
