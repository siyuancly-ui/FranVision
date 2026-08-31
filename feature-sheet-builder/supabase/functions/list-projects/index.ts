/*
 * Supabase Edge Function: list-projects
 * -------------------------------------
 * Franky's admin view calls this to list EVERY feature sheet. Interim,
 * pre-auth: gated by a single shared secret. Not for agents.
 *
 * Request:  POST { "token": "<ADMIN_TOKEN>", "view"?: "trash" }
 *           view omitted -> active sheets; view:"trash" -> recycle bin
 * Response: 200 { projects: [ { id, address, city, agents, theme,
 *                       confirmed, createdAt, updatedAt, deletedAt } ] }
 *           401 { error } on a bad / missing token
 *
 * Env (Supabase dashboard -> Edge Functions -> Secrets):
 *   ADMIN_TOKEN   (required)  -- the shared admin secret; never in the repo
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 *
 * Deploy:  supabase functions deploy list-projects
 *   (or paste this file in the dashboard's function editor and Deploy)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// constant-time-ish compare so a bad token can't be timed out char by char
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "";
  if (!ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN not configured" }, 500);

  let token = "";
  let view = "";
  try {
    ({ token, view = "" } = await req.json());
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!token || !safeEqual(String(token), ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await admin
    .from("projects")
    .select("id, data, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) return json({ error: error.message }, 500);

  const wantTrash = view === "trash";
  const projects = (data ?? [])
    .filter((row: any) => wantTrash ? !!row.data?.deletedAt : !row.data?.deletedAt)
    .map((row: any) => {
      const d = row.data ?? {};
      const pi = d.propertyInfo ?? {};
      const agents = [d.agentInfo?.name, d.agentInfo2?.name].filter(Boolean);
      return {
        id: row.id,
        address: pi.address ?? "",
        city: pi.city ?? "",
        agents,
        theme: d.colorTheme ?? "navy",
        confirmed: !!d.confirmed,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: d.deletedAt ?? null,
      };
    });

  return json({ projects });
});
