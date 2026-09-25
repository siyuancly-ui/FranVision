-- ===========================================================================
-- FranVision -- Delivery Hub page (2026-09-25)
-- ===========================================================================
-- Run ONCE in the Supabase SQL editor of the SAME project as schema.sql
-- (papaswihicvajzcubbri), AFTER schema.sql (uses jg_check_token) and
-- gallery.sql. Re-running is safe.
--
-- The Delivery Hub (delivery-page/src/hub.js) is the page the Delivery Email
-- links to for everything AFTER the "-----" line: one button per deliverable,
-- locked until the Job is paid (or Franky unlocks it for a deliver-first
-- client). One row per Job:
--   * token          random 128-bit URL token (like gallery_tokens) -- the hub URL
--                    is /deliver/<address-slug>/<token>, unguessable from the Job ID;
--   * lines          which buttons exist + the Dropbox link behind each, written by
--                    Job Generator at Create/Update Job from the SAME
--                    getDeliverableLines() logic the email uses:
--                    [{"key":"HDR"},{"key":"MLS","url":"https://www.dropbox.com/..."},...]
--                    (HDR -> the Gallery page and THREE_D -> projects.tourUrl are resolved
--                    at click time, so they carry no url here);
--   * wave_view_url  the Wave invoice's payment page (the "Pay now" button);
--   * total_cents    invoice total incl. HST, shown in the lock dialog;
--   * wave_invoice_id  the numeric part of the Wave invoice's id (the GraphQL id is
--                    base64("Business:<uuid>;Invoice:<n>"); Wave's webhook `invoice_id` is that <n>,
--                    kept as text -- it is 19 digits, beyond a JS safe integer);
--   * paid / unlocked  OWNED BY THE ADMIN SIDE (delivery-page /admin + the Wave webhook) --
--                    this function never touches them, so re-running Create/Update Job
--                    can't re-lock a paid Job. `unlocked` = "deliver first, pay later".
--                    paid_source 'wave' = set by Wave's invoice.paid webhook (fully paid only;
--                    the admin page shows it greyed-out and un-untickable), 'manual' = ticked
--                    by hand (e-Transfer). wave_paid_cents / wave_remaining_cents = the last
--                    partial-payment notice (a partial payment does NOT unlock).
-- Access model: RLS ON, no policies (anon/authenticated read nothing). Job
-- Generator writes via jg_delivery_hub() with its own JG_TOKEN; the delivery-page
-- Worker reads/writes with its service-role key -- so the Dropbox links behind
-- locked buttons never reach an unpaid browser.
-- ===========================================================================

create table if not exists public.delivery_hub (
  job_id        text primary key,
  token         text not null unique,
  lines         jsonb not null default '[]'::jsonb,
  wave_view_url text,
  total_cents   integer,
  wave_invoice_id text,
  paid          boolean not null default false,
  paid_source   text check (paid_source in ('manual', 'wave')),
  paid_at       timestamptz,
  wave_paid_cents      integer,
  wave_remaining_cents integer,
  unlocked      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.delivery_hub enable row level security;
revoke all on public.delivery_hub from anon, authenticated;
create index if not exists delivery_hub_wave_invoice_idx on public.delivery_hub (wave_invoice_id);

-- Every Wave webhook delivery, once (event_id is the dedupe key: Wave retries) -- also the audit
-- trail for events that matched no Job. Written/read only by the delivery-page Worker (service role).
create table if not exists public.wave_events (
  event_id     text primary key,
  event_type   text not null,
  invoice_id   text,
  business_id  text,
  payload      jsonb not null,
  job_id       text,
  result       text,
  received_at  timestamptz not null default now()
);
alter table public.wave_events enable row level security;
revoke all on public.wave_events from anon, authenticated;

create or replace function public.jg_delivery_hub(p_token text, p_job_id text, p_lines jsonb, p_wave_view_url text, p_total_cents integer, p_wave_invoice_id text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text;
begin
  perform public.jg_check_token(p_token);
  if p_job_id is null or p_job_id !~ '^FVS-[0-9]{8}-[0-9]{3,}$' then
    raise exception 'jg: not a valid job id';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'jg: lines must be a JSON array';
  end if;
  if p_wave_invoice_id is not null and p_wave_invoice_id !~ '^[0-9]{1,30}$' then
    raise exception 'jg: wave invoice id must be digits';
  end if;
  insert into public.delivery_hub (job_id, token, lines, wave_view_url, total_cents, wave_invoice_id)
  values (p_job_id, encode(extensions.gen_random_bytes(16), 'hex'), p_lines, nullif(btrim(p_wave_view_url), ''), p_total_cents, p_wave_invoice_id)
  on conflict (job_id) do update set
    lines = excluded.lines,
    wave_view_url = coalesce(excluded.wave_view_url, public.delivery_hub.wave_view_url),  -- a later Update without a picked customer keeps the earlier link
    total_cents = coalesce(excluded.total_cents, public.delivery_hub.total_cents),
    wave_invoice_id = coalesce(excluded.wave_invoice_id, public.delivery_hub.wave_invoice_id),
    updated_at = now();
  select token into v_token from public.delivery_hub where job_id = p_job_id;
  return v_token;
end $$;

revoke all on function public.jg_delivery_hub(text, text, jsonb, text, integer, text) from public;
grant execute on function public.jg_delivery_hub(text, text, jsonb, text, integer, text) to anon;
