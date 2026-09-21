/*
 * Supabase Edge Function: notify-submission
 * -----------------------------------------
 * Called by the app when an agent clicks "Confirm & Submit". Emails the
 * studio a summary of the Feature Sheet plus links to open the project and
 * download the print PDF (the client uploads it to
 * storage: submissions/<projectId>.pdf just before calling this).
 *
 * A sheet connected to a Job uploads NO PDF when a client submits it: the print PDF needs
 * the paid full-resolution photos, which only the studio's admin export can fetch. When no
 * PDF exists the email has no download button, just how to export it.
 *
 * Request:  POST { "projectId": "<id>" }   (Authorization: Bearer <anon key>, sent automatically by supabase-js)
 * Response: 200 { ok: true }  |  4xx/5xx { error }
 *
 * Environment (set in the Supabase dashboard -> Edge Functions -> Secrets):
 *   RESEND_API_KEY   (required)  -- secret; never in the repo
 *   SUBMIT_TO        (optional)  -- default frankystudio@mail.com
 *   SUBMIT_FROM      (optional)  -- default onboarding@resend.dev
 *   APP_BASE_URL     (optional)  -- default https://franvision.frankystudio-6f3.workers.dev
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 *
 * Deploy:  supabase functions deploy notify-submission
 *   (or paste this file in the dashboard's function editor and Deploy)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TO = Deno.env.get("SUBMIT_TO") ?? "frankystudio@mail.com";
const FROM = Deno.env.get("SUBMIT_FROM") ?? "FranVision <onboarding@resend.dev>";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://franvision.frankystudio-6f3.workers.dev";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function phone(raw: unknown): string {
  const s = String(raw ?? "").trim();
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return s;
}

function row(label: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return `<tr><td style="padding:3px 12px 3px 0;color:#667;white-space:nowrap;vertical-align:top">${esc(label)}</td>` +
    `<td style="padding:3px 0">${esc(value)}</td></tr>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let projectId = "";
  try {
    ({ projectId } = await req.json());
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!projectId || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) {
    return json({ error: "bad projectId" }, 400);
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: proj, error: projErr } = await admin
    .from("projects").select("*").eq("id", projectId).single();
  if (projErr || !proj) return json({ error: "project not found" }, 404);

  const d = proj.data ?? {};
  const pi = d.propertyInfo ?? {};
  const ai = d.agentInfo ?? {};

  // Link to the print PDF the client just uploaded (photos bucket,
  // submissions/ prefix). Try a long-lived signed URL first; fall back to
  // the public URL if the bucket is public.
  // A sheet connected to a Job gets NO client-built PDF (it needs the paid full-resolution
  // originals, only the admin export can fetch) -- unless the admin submitted it. So decide by
  // whether the file actually exists, not by the project.
  const pdfKey = `submissions/${projectId}.pdf`;
  const { data: listed } = await admin.storage.from("photos")
    .list("submissions", { search: `${projectId}.pdf`, limit: 5 });
  const hasPdf = !!listed?.some((f: { name: string }) => f.name === `${projectId}.pdf`);
  let pdfUrl = "";
  if (hasPdf) {
    const { data: signed } = await admin.storage.from("photos")
      .createSignedUrl(pdfKey, 60 * 60 * 24 * 30);
    pdfUrl = signed?.signedUrl ??
      admin.storage.from("photos").getPublicUrl(pdfKey).data.publicUrl;
  }

  const openUrl = `${APP_BASE_URL}/?p=${encodeURIComponent(projectId)}`;
  const addr = [pi.address, pi.city].filter(Boolean).join(", ") || "(no address)";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e2530;font-size:14px;line-height:1.5">
    <h2 style="margin:0 0 4px">Feature Sheet submitted for printing</h2>
    <p style="margin:0 0 16px;color:#667">${esc(addr)}</p>

    <p style="margin:0 0 16px">
      ${hasPdf ? `<a href="${esc(pdfUrl)}" style="display:inline-block;background:#1f5fd6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600">Download print PDF</a>
      &nbsp;&nbsp;` : ""}
      <a href="${esc(openUrl)}" style="display:inline-block;background:#eef3ff;color:#1f5fd6;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600">Open project</a>
    </p>
    ${!hasPdf ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fff8e6;border-radius:6px">
      <b>No print PDF is attached for this job.</b> Open the project with your admin link
      (<code>?p=${esc(projectId)}&amp;admin=&lt;token&gt;</code>) and click <b>Export PDF 导出</b> —
      it pulls the full-resolution photos with your token.<br>
      <b>没有随附打印 PDF。</b>请用管理员链接打开此项目，点击「Export PDF 导出」生成高清打印文件。
    </p>` : ""}

    <h3 style="margin:18px 0 6px;font-size:14px">Property</h3>
    <table style="border-collapse:collapse">
      ${row("Address", pi.address)}
      ${row("City", pi.city)}
      ${row("Description", pi.description)}
    </table>

    <h3 style="margin:18px 0 6px;font-size:14px">Agent</h3>
    <table style="border-collapse:collapse">
      ${row("Name", ai.name)}
      ${row("Credentials", ai.credentials)}
      ${row("Phone (Bus)", phone(ai.busPhone))}
      ${row("Cell", phone(ai.cellPhone))}
      ${row("Email", ai.email)}
      ${row("Brokerage", ai.brokerage)}
      ${row("Brokerage address", ai.brokerageAddress)}
      ${row("Website", ai.website)}
      ${row("Online tour", ai.onlineTourUrl)}
    </table>

    <p style="margin:20px 0 0;color:#8a94a3;font-size:12px">
      Project ${esc(projectId)} · submitted ${esc(new Date().toISOString())}<br>
      ${hasPdf ? "Download link valid ~30 days. Open the project to re-generate or make changes." : "Open the project to export the print PDF or make changes."}
    </p>
  </div>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      reply_to: ai.email || undefined,
      subject: `Feature Sheet submitted — ${addr}`,
      html,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    return json({ error: `email send failed: ${resp.status} ${t}` }, 502);
  }

  return json({ ok: true, pdf: !!pdfUrl });
});
