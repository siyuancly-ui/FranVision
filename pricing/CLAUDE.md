# CLAUDE.md (pricing/)

## What this is

The FranVision real estate photography pricing engine — **the single source of truth for pricing logic** across the whole project. `job-generator/pricing-adapter.js` wraps it directly; nothing else should ever reimplement or duplicate a pricing rule. Zero dependencies, UMD (works via `require()` in Node and as a plain `<script>` tag in the browser — no build step).

## Module map

| File | Role |
|---|---|
| `engine.js` | Pure calculation logic — no DOM, no I/O, no hardcoded prices/ids. Takes an `order` + a `config` (the shape `pricing-config.js` exports) and returns a full structured pricing breakdown (line items with labels + amounts + which services a package covers, not just a final total — see "Built for an agent" below). |
| `pricing-config.js` | **The only file that should need editing when prices/packages change.** Plain data (`services`, `packages` — prices, `requires` chains, package `includes`) — there is no separate raw-data layer, this IS the price list, just codified. Never hardcode a price in `engine.js` or any UI. |
| `engine.test.js` | `node pricing/engine.test.js` — 25 tests: the user's required 15, edge cases, an exhaustive 64-combination cross-check against an independently-written reference implementation, and synthetic tests that force otherwise-unreachable branches (`ambiguous`, `invalid`). |
| `tester.html` | Manual interactive tester — double-click to open, no server needed. Lets the user cross-check a quote against their Wave invoice totals by hand. |
| `advisor/` | The Pricing Advisor — see below. |
| `待确认事项.md` | Kept as a **rationale record**, not an open-questions list — three original tentative decisions (Free Twilight never sold standalone, out-of-price-sheet fees like travel/rush go through Manual Adjustment unmodeled, multi-package stacking) were all confirmed final by the user 2026-08-26. |
| `engine.esm.js` / `pricingconfig.esm.js` (repo root, not in this folder) | Hand-kept ES Module ports of `engine.js`/`pricing-config.js`, for the Wix Velo work that used to exist (now discontinued — see the root `franvision-architecture-strategy-decision.md`). Logic must stay identical to the UMD originals if ever touched again; see the files' own header comments first. |

## Confirmed design decisions

- **"Package First"** (the one rule the user was explicit about): a matching package price is always used even when summing standalone items would be cheaper — packages are never chosen to minimize total cost. The matching algorithm (documented in a comment block at the top of `engine.js`) maximizes package coverage first, then prefers leaving the cheaper leftover item as a standalone add-on, and returns an `ambiguous` status with **every** tied candidate (never guesses) when it can't uniquely resolve.
- **Fully config-driven, no hardcoded service/package assumptions** (as of commit `faf922f`, 2026-08-31, "Make pricing engine matching fully config-driven"). Before that, `engine.js` had a fixed addon-id whitelist, a hardcoded Site-Plan-requires-Floor-Plan special case, and hardcoded "always standalone" line-item blocks — all removed. Adding a new service/package to `pricing-config.js` alone is enough to make it participate; no `engine.js` change needed for an ordinary price-sheet update.
- **`finalSubtotalCents = subtotalCents + manualAdjustmentCents`, HST computed off `finalSubtotalCents`** — confirmed correct 2026-09-11 after a real "Subtotal shows the wrong number" complaint turned out to be a `job-generator/public/index.html` display bug (rendering the pre-adjustment `subtotalCents` next to the "Subtotal" label), not an engine bug. `engine.js`/`pricing-config.js` were not touched for that fix.
- **Built for an agent, not just a human reading a total** (stated direction, not yet fully wired up): the engine's output is a full structured breakdown, and `ambiguous`/`invalid` exist as explicit states instead of the engine ever guessing, specifically so a future automated flow (e.g. generating/confirming a Wave invoice — see `job-generator/CLAUDE.md`'s "Wave invoicing" section, now built) can surface those to a human instead of silently picking wrong.

## Pricing Advisor (`pricing/advisor/`)

A **regression guard that runs before a change lands in `pricing-config.js`** — not a side experiment; this is meant to be exactly what a future price-editing UI triggers before committing an edit (confirmed as the actual target, not a local-only tool). Real mechanism (`validator.js`): takes the current config + a queued batch of hypothetical changes (`newService`/`newPackage`/`editServicePrice`/`editPackagePrice`/`setRequires`), then two check tiers:
- `checkStatic` — cheap, per-change: duplicate/dangling ids, malformed price shapes, conflicting package prices on the same `includes` set.
- `runFullCheck`/`runExhaustiveDiff` — the real gate: merges the batch into a draft config, sweeps every order combination through the real `engine.js`, diffs against the current config so only **newly broken** combos are flagged.

Two severities: **hardError** (must fix before merging) vs. **warning** (computes fine but looks suspicious, e.g. a bundle costs more than its parts — a human judgment call, not auto-rejected). `advisor.html` is the UI over this.

## Workflow for a real price-sheet update

Do **not** immediately start editing `pricing-config.js` or `engine.js` when the user's real price sheet changes. Follow this order (explicit user requirement, so a new price sheet is checked against the existing pricing *logic* first and any conflict gets discussed before code changes — see `pricing-update-workflow` in project memory):

1. Reason about whether the new price sheet still fits the existing model: same service categories, same Package First principle, same matching algorithm. Check whether `engine.test.js`'s existing cases would still conceptually pass, and whether anything breaks an assumption the algorithm relies on (a package overlapping two existing packages in a new way, a service needing quantity pricing when the engine assumes flat, a package eligibility rule `eligiblePropertyTypes` doesn't cover).
2. If anything doesn't cleanly fit, surface the specific conflict to the user and discuss **before touching any code**.
3. Only after the user confirms the approach, edit `pricing-config.js` (and `engine.js` only if the algorithm itself genuinely needs to change — should be rare, since it's meant to be config-driven).
4. Re-run `node pricing/engine.test.js` after any change, and add/update test cases for the new prices.

Some price-sheet changes look like "just new numbers" but are actually structural (a new bundle type, new per-unit pricing, a new eligibility rule) — treat those with the same conflict-surfacing discipline as a genuinely new rule, not as a quick edit.
