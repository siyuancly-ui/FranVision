# FranVision — Architecture Strategy Decision (2026-09-15)

## Context: what triggered this

We were debugging why the Wix Studio delivery page (`/delivery/<jobId>`, a Velo router page) couldn't display Supabase-sourced photos/video. Root cause traced to `secrets.getSecretValue()` (from `wix-secrets-backend.v2`) consistently returning a `FORBIDDEN` applicationError from the backend `.jsw` module — reproduced identically in Editor Preview and on the fully published live site.

Investigation (browser testing + official Wix docs + community forums) ruled out every documented explanation:
- **Not a premium-plan restriction** — no official Wix doc ties Secrets Manager reads to plan tier.
- **Not the documented "Manage Secrets" permission requirement** — that requirement is scoped specifically to `listSecretInfo` inside `.web.js` files using the `webMethod(Permissions.X, ...)` pattern; it doesn't apply to plain `.jsw` files or to `getSecretValue`.
- **Not an agency/delegated-account permission gap** — confirmed the Wix account is Franky's own single account, sole owner/collaborator.
- **Not something fixable via the Roles & Permissions UI** — that page shows no collaborator formally assigned to any standard role, and searching its 84-item permission list for "secret" returns nothing. There is no visible lever to grant or diagnose this from the account side.
- One real but unconfirmed lead: the site's Velo code is developed via Wix CLI + GitHub integration, and the Editor's code panel runs in a read-only "Dev Mode" state as a result. This was flagged as a possible factor and included in the support ticket, but no documentation or forum evidence ties CLI/Git-based development to this specific error.

Net result: a basic, extremely common Velo API call is broken with no self-serviceable fix and no clear documented cause. A support ticket and an isolation test (a minimal HTTP function calling only `getSecretValue`, bypassing the router page and Supabase entirely) were prepared as next diagnostic steps, but this also prompted a step back on the overall platform choice.

## The bigger question: is Wix Velo the right foundation at all?

Prompted by this dead end, we discussed the full scope of what FranVision actually needs to become, not just the delivery page. The user laid out the complete feature list:

**Agent-facing (client of Franky's studio):**
- Login with account/password
- Saved profile: brokerage name, contact info, logo, personal contact, avatar — reused across Feature Sheet generation instead of re-entering every time
- A personal portfolio page showing all properties Franky has shot/listed for that agent — a "track record" page the agent can show their own clients (relationship/stickiness tool)

**Franky-facing (studio admin):**
1. Job/CRM management — every job's info, download links, feature sheet, all-in-one page, in one place
2. Financials — revenue by period (from job pricing), photographer commissions, eventually editor costs → gross margin analysis; reconciliation with Wave and with photographers
3. e-Transfer (EMT) reconciliation — accumulating payer name / paying company name data over time
4. Job Generator integrated into the backend, one-click order → delivery → payment
5. Pricing table + "pricing advisor," tied to the Job Generator
6. Delivery page generation/management, including the payment gate, and eventually automatic delivery emails once customer contact info is on file
7. Multi-role staff accounts with isolated permissions (as Franky brings on employees)

## Why this list changes the platform answer

Two observations came out of walking through this list:

1. **Design-quality requirements are concentrated in exactly two places**: Feature Sheet (already built, already in production as its own site) and the delivery/"All in One" page (the one we were just debugging). Everything else — agent login, the CRM, financial dashboards, job generator, pricing tables, staff role management — is functional/utility UI: forms, tables, dashboards. This is not where Wix's drag-and-resize visual editing provides any advantage; it's exactly the kind of UI that's fast and clean to build with a standard component library in code.

2. **Almost every remaining item is exactly the kind of application logic Wix Velo has now visibly struggled with**, just at higher stakes:
   - Multi-role permission isolation (item 7) is precisely what Supabase Auth + Row Level Security is designed for — enforced at the database layer, not a UI checkbox list you can't even find (as we just experienced with Wix's own Roles & Permissions page).
   - Financial reporting/reconciliation (items 2–3) needs real relational aggregation (group by period, join jobs to payments to commissions). This is a natural fit for Postgres (which Supabase already is) and an awkward fit for Wix Data's collection-store model.
   - Payment gating and one-click order→delivery→payment automation (items 4, 6) put money-handling logic on the same platform layer that just failed unpredictably and undocumented on a simple secret read. That's not a risk worth taking on billing-adjacent code.
   - Automated delivery emails, webhook-driven workflows — standard serverless/backend patterns, no Wix-specific advantage.

## Decision

**Move FranVision's backend/application logic off Wix Studio/Velo entirely.** Build a unified custom system with Claude Code on top of Supabase (already the database for Feature Sheet Builder and the source for delivery-page photo/video data), covering: agent portal, Franky's admin/CRM, financial reporting, Job Generator, pricing engine, delivery page generation with payment gating, and staff RBAC.

The delivery/"All in One" page specifically will be rebuilt in custom code using Franky's existing Zenfolio delivery pages as the visual reference (see `franvision-delivery-page-design-spec.md` — screenshots + extracted computed styles, not a code export, since Zenfolio's and Wix's rendered output isn't reusable source). Feature Sheet Builder stays as-is functionally; it already lives outside Wix.

This does give up Wix's one genuine advantage (Franky being able to drag/resize page layout himself) for the delivery page specifically — judged an acceptable trade, since it's a single reusable template rather than something that needs frequent independent redesign, and it removes Wix Velo's rough edges from every other module in the list, not just this one.

## Domain plan

Once the custom system is live, everything will be consolidated under **a domain related to the "FranVision" name** — not `gta3d.ca`, which currently hosts Feature Sheet Builder separately. Feature Sheet Builder's code doesn't need to change; only its domain/DNS target does, once the new domain is chosen and the hosting is in place.

Two structural options were discussed, not yet decided:
- **Subdomains per module**: e.g. `app.<domain>` (agent portal + Franky admin), `delivery.<domain>` (all-in-one pages), `featuresheet.<domain>` (Feature Sheet Builder)
- **One app, path-based routing**: e.g. `<domain>/app/...`, `<domain>/delivery/...`, `<domain>/features/...` — simpler shared-login/session handling across modules since they'd all sit on one origin

**Open item:** exact domain name and availability (.com/.ca/etc.) still to be checked and registered.

## Immediate next steps (as of this writing)

1. Wix side (in parallel, low priority given the pivot): the support email draft and the minimal HTTP-function isolation test are still there if useful for closing out the old approach cleanly, but are no longer blocking anything.
2. Decide and register the FranVision-branded domain.
3. Decide subdomain-vs-path structure for the new unified app.
4. Begin implementation: likely starting point is the delivery page (design spec already in hand) and/or the shared Supabase schema (agent profiles, jobs, financials) that most other modules depend on.
