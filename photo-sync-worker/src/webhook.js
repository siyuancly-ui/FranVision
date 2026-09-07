// Dropbox webhook verification.
//
// - GET  /webhook?challenge=xxx  -> echo the challenge back as text/plain
//   (handled in index.js; nothing to verify).
// - POST /webhook               -> body is HMAC-SHA256'd with the app secret;
//   the hex digest must equal the X-Dropbox-Signature header.
//   https://www.dropbox.com/developers/rega/webhooks

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Constant-time-ish string compare (equal length, XOR accumulate).
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyDropboxSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody,
  );
  return timingSafeEqual(toHex(mac), String(signatureHeader).toLowerCase());
}

export { timingSafeEqual, toHex };
