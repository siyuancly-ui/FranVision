// Stable, path-derived photo id.
//
//   photoId = base64url(sha256(`${jobId}/${relPathFromJob}`)).slice(0, 22)
//
// Deliberately NOT derived from the Dropbox file id: a delete + re-upload of
// the same filename produces a NEW Dropbox file id but the SAME path, so the
// same photoId -- which is what makes the self-heal (§6.2) fall out for free.
// A pure rename changes the path and therefore the id (treated as delete+add,
// acceptable -- renames are rare).

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function photoId(jobId, relPathFromJob) {
  const data = new TextEncoder().encode(`${jobId}/${relPathFromJob}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest)).slice(0, 22);
}

export { base64url };
