-- ===========================================================================
-- FranVision core schema -- DRAFT, NOT EXECUTED against production. For review only.
-- STATUS (2026-09-24): parked, not needed yet -- Wave invoicing (Job Generator) runs without these tables.
-- Apply when e-Transfer reconciliation / the agent+billing directory actually starts; review then first.
-- Kept in main so it is not forgotten (it used to sit on the unmerged branch `core-schema`).
-- Syntax + runtime behavior VERIFIED 2026-09-22 against a local Postgres 16
-- (brew install postgresql@16), loaded together with job-generator's own
-- supabase/schema.sql (jg_jobs must exist first for the mirror trigger).
-- Exercised: a real job mirrors correctly (pricing + commission fields),
-- a draft (job_id null) never mirrors, and a malformed shoot_date degrades
-- to a NULL column instead of blocking the whole upsert (the try/catch
-- around the date parse works as designed).
-- ===========================================================================
-- Target project: the shared Supabase project (papaswihicvajzcubbri) that
-- Feature Sheet Builder / photo-sync-worker / Job Generator already use.
--
-- Purpose (2026-09-21 scope): the data foundation for AUTOMATING WAVE
-- INVOICES. Agent login / registration / the agent portal are deliberately
-- out of scope (low priority) -- only a nullable agents.auth_user_id is
-- reserved for them.
--
-- Access model (same spirit as jg_jobs): RLS ON, NO policies => anon and
-- authenticated users can read/write nothing. Only server code using the
-- service_role key (Cloudflare Workers) or SECURITY DEFINER functions can
-- touch these tables. ALL money tables (jobs prices, invoices, payments,
-- commissions) are Franky-only; when staff/agent accounts arrive, do NOT add
-- policies to the money tables for them.
--
-- jg_jobs (Job Generator's working copy) is NOT modified. Real jobs are
-- mirrored one-way jg_jobs -> jobs by an AFTER trigger (bottom of file) that
-- swallows its own errors so it can never block a Create Job.
-- ===========================================================================

create extension if not exists pgcrypto;

-- shared updated_at helper
create or replace function public.core_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- agents: the agent DIRECTORY (a contact list, works without any login).
-- An agent is the PERSON who orders shoots and receives deliveries. Who PAYS
-- (the agent, his own company, his brokerage) is a separate concept:
-- billing_parties, below. Seeds planned (later, low priority): profile info
-- harvested from Franky's old Feature Sheets (headshot/logo/brokerage).
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id               uuid primary key default gen_random_uuid(),
  auth_user_id     uuid unique references auth.users(id) on delete set null,  -- reserved for future agent login
  name             text not null,
  email            text,                        -- store lowercased
  phone_norm       text,                        -- digits only, e.g. '4165551234'
  brokerage        text,
  aliases          text[] not null default '{}',   -- other spellings seen in Job Generator "client name"
  brokerage_party_id uuid,                         -- FK added after billing_parties exists: this agent's brokerage. A brokerage pays for ALL its agents (open-ended, growing), so it is a rule on the agent, not an enumerated agent<->party list
  profile          jsonb not null default '{}'::jsonb,  -- credentials, website, headshot/logo refs, ...
  source           text not null default 'manual', -- 'fsb_import' | 'manual' | 'signup' | 'wechat_note'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint agents_email_lower check (email is null or email = lower(email))
);
create unique index if not exists agents_email_key on public.agents (email) where email is not null;
create index if not exists agents_phone_idx on public.agents (phone_norm) where phone_norm is not null;
create index if not exists agents_aliases_gin on public.agents using gin (aliases);
drop trigger if exists agents_touch on public.agents;
create trigger agents_touch before update on public.agents for each row execute function public.core_touch_updated_at();
alter table public.agents enable row level security;

-- ---------------------------------------------------------------------------
-- billing_parties: WHO IS INVOICED / WHO PAYS. Usually the agent personally,
-- but can be his personal company or his brokerage. One party can serve
-- several agents (a brokerage paying for many), and one agent can use several
-- parties. `aliases` holds the names this party shows up under on e-Transfers
-- and in Franky's WeChat contact remarks; it grows over time: every time
-- Franky confirms an unmatched e-Transfer, that payer name is appended.
-- Matching only ever SUGGESTS; Franky confirms (never silent auto-bind).
-- A one-time payer (e.g. a homeowner who paid once) is NOT a party and must never be added here or to
-- aliases; such a payment is matched by reference note or amount and confirmed by Franky only.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_parties (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,                                  -- display name, as invoiced
  kind             text not null default 'self' check (kind in ('self', 'personal_company', 'brokerage', 'other')),
  wave_customer_id text unique,                                    -- the Wave customer invoices are issued to
  email            text,
  phone_norm       text,
  aliases          text[] not null default '{}',                   -- e-Transfer sender names, WeChat remark spellings, ...
  notes            text,
  active           boolean not null default true,                  -- false = hidden from the customer picker, still kept
  source           text not null default 'manual',                 -- 'wave' | 'wechat_note' | 'manual' | 'payment_match'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint billing_parties_email_lower check (email is null or email = lower(email))
);
create index if not exists billing_parties_aliases_gin on public.billing_parties using gin (aliases);
create index if not exists billing_parties_name_idx on public.billing_parties (lower(name));
drop trigger if exists billing_parties_touch on public.billing_parties;
create trigger billing_parties_touch before update on public.billing_parties for each row execute function public.core_touch_updated_at();
alter table public.billing_parties enable row level security;
alter table public.agents drop constraint if exists agents_brokerage_party_fk;
alter table public.agents add constraint agents_brokerage_party_fk foreign key (brokerage_party_id) references public.billing_parties(id) on delete set null;

-- many-to-many: which parties an agent may be billed through (personal company etc.; the brokerage comes from agents.brokerage_party_id); at most one default per agent
create table if not exists public.agent_billing_parties (
  agent_id   uuid not null references public.agents(id) on delete cascade,
  party_id   uuid not null references public.billing_parties(id) on delete cascade,
  is_default boolean not null default false,
  primary key (agent_id, party_id)
);
create unique index if not exists agent_default_party_key on public.agent_billing_parties (agent_id) where is_default;
create index if not exists agent_billing_parties_party_idx on public.agent_billing_parties (party_id);
alter table public.agent_billing_parties enable row level security;

-- ---------------------------------------------------------------------------
-- jobs: business truth for REAL jobs (drafts never reach here).
-- Mirrored from jg_jobs; the columns below marked OWNED-HERE are never
-- overwritten by the mirror.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  job_id          text primary key,             -- 'FVS-YYYYMMDD-NNN' (same value as projects.id)
  folder_name     text not null unique,         -- link back to jg_jobs
  client_name     text not null default '',     -- text snapshot as typed in Job Generator, never rewritten
  address         text not null default '',
  shoot_date      date,                         -- parsed from jg 'yyyy/mm/dd'; null if unparseable
  property_type   text not null default '',
  photographer    text not null default '',
  services        jsonb not null default '{}'::jsonb,   -- the pricing 'order' object
  pricing         jsonb not null default '{}'::jsonb,   -- FROZEN full snapshot (lineItems, adjustments, hst, ...)
  subtotal_cents  integer,                      -- finalSubtotalCents (pre-tax, after manual adjustment)
  tax_cents       integer,                      -- hstCents
  total_cents     integer,                      -- totalCents
  agent_id        uuid references public.agents(id) on delete set null,   -- OWNED-HERE: the ordering agent (delivery / portal); set by Franky, never by mirror
  bill_to_party_id uuid references public.billing_parties(id) on delete set null,  -- OWNED-HERE: who gets invoiced; defaults to the agent's default party, Franky may override
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  mirrored_at     timestamptz not null default now()
);
create index if not exists jobs_agent_idx on public.jobs (agent_id);
create index if not exists jobs_bill_to_idx on public.jobs (bill_to_party_id);
create index if not exists jobs_shoot_date_idx on public.jobs (shoot_date desc);
drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs for each row execute function public.core_touch_updated_at();
alter table public.jobs enable row level security;

-- ---------------------------------------------------------------------------
-- job_commissions: ADMIN-ONLY (Franky). Photographer commission per job.
-- ---------------------------------------------------------------------------
create table if not exists public.job_commissions (
  job_id       text primary key references public.jobs(job_id) on delete cascade,
  photographer text not null default '',
  items        jsonb not null default '[]'::jsonb,
  travel_cents integer not null default 0,
  total_cents  integer not null default 0,
  updated_at   timestamptz not null default now()
);
alter table public.job_commissions enable row level security;

-- ---------------------------------------------------------------------------
-- invoices: one job -> MANY invoices over time (original order, later add-ons).
-- Never edit a paid invoice; a later purchase is a new row (kind='addon').
-- Created as 'draft' automatically; Franky approves, THEN it is sent.
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  job_id             text not null references public.jobs(job_id),
  billing_party_id   uuid references public.billing_parties(id),  -- who this invoice was issued to (a job may have several invoices, even to different parties)
  kind               text not null default 'original' check (kind in ('original', 'addon', 'other')),
  status             text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'paid', 'void')),
  subtotal_cents     integer not null,
  tax_cents          integer not null,
  total_cents        integer not null,
  line_items         jsonb not null default '[]'::jsonb,    -- snapshot of what was invoiced
  memo               text,                                   -- include address / original invoice no. for bookkeeping
  wave_invoice_id    text unique,
  wave_invoice_number text,
  wave_view_url      text,                                   -- link the client opens = the payment page (also goes in the Delivery Email)
  wave_status        text,                                   -- Wave's own status as last polled: DRAFT/SAVED/VIEWED/PAID/...
  wave_total_cents   integer,                                -- total Wave computed. Cent-level differences vs total_cents (per-line vs single HST rounding) are expected and need NO review; only a gap > ~$1 is suspicious (wrong product/price)
  po_number          text,                                   -- what was written to Wave's P.O./S.O. field = the FVS job id
  invoice_date       date,
  due_date           date,                                   -- Franky's habit: invoice date + 30 days
  approved_at        timestamptz,                            -- Franky's confirmation before sending
  sent_at            timestamptz,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists invoices_job_idx on public.invoices (job_id);
create index if not exists invoices_status_idx on public.invoices (status);
drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices for each row execute function public.core_touch_updated_at();
alter table public.invoices enable row level security;

-- ---------------------------------------------------------------------------
-- payments + allocations: one incoming payment (e.g. one e-Transfer) can be
-- split across several invoices (the N:M case decided 2026-09-15).
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),
  amount_cents integer not null check (amount_cents > 0),
  method       text not null check (method in ('emt', 'card', 'other')),
  payer_name   text,                         -- e-Transfer sender name exactly as received
  payer_party_id uuid references public.billing_parties(id),  -- set only once Franky confirms who paid; confirming appends payer_name to that party's aliases
  reference    text,                         -- Interac reference number from the notification email (also the dedupe key)
  source       text not null default 'manual',   -- 'manual' | 'wave_webhook' | ...
  raw          jsonb,
  created_at   timestamptz not null default now()
);
create unique index if not exists payments_reference_key on public.payments (reference) where reference is not null;
alter table public.payments enable row level security;

create table if not exists public.payment_allocations (
  payment_id   uuid not null references public.payments(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id),
  amount_cents integer not null check (amount_cents > 0),
  primary key (payment_id, invoice_id)
);
create index if not exists payments_payer_party_idx on public.payments (payer_party_id);
create index if not exists payment_alloc_invoice_idx on public.payment_allocations (invoice_id);
alter table public.payment_allocations enable row level security;

-- (No wave_map table here: the pricing-id -> Wave product-id map already lives in job-generator's
-- supabase/schema.sql as jg_wave_map, applied to production 2026-09-24. HST's Wave tax id is looked up live.)

-- ---------------------------------------------------------------------------
-- MIRROR: jg_jobs (real jobs only) -> jobs / job_commissions.
-- Runs AFTER insert/update on jg_jobs. Any error is downgraded to a WARNING
-- so Job Generator's Create/Update Job can never fail because of this.
-- Only build-time columns are written; agent_id is never touched.
-- Assumes jg_jobs.data = { job: <job.json shape>, form: {...} }.
-- ---------------------------------------------------------------------------
create or replace function public.core_mirror_jg_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j        jsonb := coalesce(new.data->'job', '{}'::jsonb);
  pr       jsonb := coalesce(j->'pricing', '{}'::jsonb);
  cm       jsonb := coalesce(j->'commission', '{}'::jsonb);
  v_date   date;
begin
  if new.job_id is null then return new; end if;   -- drafts are never mirrored
  begin
    begin v_date := to_date(replace(new.shoot_date, '/', '-'), 'YYYY-MM-DD');
    exception when others then v_date := null; end;

    insert into public.jobs (job_id, folder_name, client_name, address, shoot_date, property_type,
                             photographer, services, pricing, subtotal_cents, tax_cents, total_cents, created_at)
    values (new.job_id, new.folder_name, new.client_name, new.address, v_date,
            coalesce(j#>>'{property,propertyType}', ''), coalesce(j->>'photographer', ''),
            coalesce(j->'services', '{}'::jsonb), pr,
            nullif(pr->>'finalSubtotalCents', '')::integer, nullif(pr->>'hstCents', '')::integer,
            nullif(pr->>'totalCents', '')::integer, new.created_at)
    on conflict (job_id) do update set
      folder_name = excluded.folder_name, client_name = excluded.client_name, address = excluded.address,
      shoot_date = excluded.shoot_date, property_type = excluded.property_type,
      photographer = excluded.photographer, services = excluded.services, pricing = excluded.pricing,
      subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents,
      total_cents = excluded.total_cents, mirrored_at = now();

    insert into public.job_commissions (job_id, photographer, items, travel_cents, total_cents)
    values (new.job_id, coalesce(j->>'photographer', ''), coalesce(cm->'items', '[]'::jsonb),
            coalesce(nullif(cm->>'travel_cents', '')::integer, 0), coalesce(nullif(cm->>'total_cents', '')::integer, 0))
    on conflict (job_id) do update set
      photographer = excluded.photographer, items = excluded.items,
      travel_cents = excluded.travel_cents, total_cents = excluded.total_cents, updated_at = now();
  exception when others then
    raise warning 'core_mirror_jg_job failed for %: %', new.job_id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists jg_jobs_mirror on public.jg_jobs;
create trigger jg_jobs_mirror after insert or update on public.jg_jobs
  for each row execute function public.core_mirror_jg_job();

-- ---------------------------------------------------------------------------
-- Not in this draft on purpose: agent claim/link log, RLS policies for staff or
-- agents, any jobStatus field (design still TBD per the user), backfill of
-- pre-existing jobs (explicitly deferred).
-- ---------------------------------------------------------------------------
