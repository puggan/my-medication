# What's left

Status 2026-11-01: the CLI and https://med.sundragon.se are live, with all medications, stock, prescriptions and
prices entered. These are the parts still to do, roughly in order of usefulness.

## Promised, not built yet

- [ ] **Fix an earlier transfer** from the CLI: list a medication's transfers with ids
      (`med transfers <name>`), then change the tablets or date (`med transfer set <id> …`) or delete one
      (`med transfer delete <id>`), stamping `updated_at`. Until then a drop can compensate for a mistake.

## When a second user arrives

- [ ] **`med user add <name>`**: today a user can only be created with SQL. Creating one should also set up
      their organizers.
- [ ] **Optional tier 1**: every dose has to belong to an organizer now. Let a dose have no organizer and
      drain straight from the cupboard (tier 2), with no refill events for it.
- [ ] Decide whether two users should be able to see each other's stock (a shared household view) or
      only their own, as now.

## Prices and the high-cost protection

- [ ] **Yearly cost on the web page**: the full-price total and the discounted total from `med price list`,
      e.g. as a line under the stock table.
- [ ] **High-cost period tracker**: store the period (now 2026-10-13 to 2027-10-12, with 722.11 kr paid on
      2026-11-01) and project the free-card date from the planned pickups and the latest prices. Rules for
      periods from 2025-07-01: full price up to 2,000 kr, free card at 7,117 kr of full-price cost, i.e.
      3,800 kr paid.
- [ ] **Update the cap every year**: `HIGH_COST_CAP` in `packages/cli/src/main.ts` is 3800 kr. The amounts
      follow the price base amount (prisbasbelopp), so check 1177.se each January.
- [ ] **Product picker at pickup**: choose the product and package size from the price history in the
      pickup dialog instead of typing them; the web dialog has no product field yet.
- [ ] **Amlodipin price**: the recorded price assumes the 100-pack (124.49 kr). Enter the real price and
      package size at the next pickup (due 11/11); the newer price then counts instead.

## Small things

- [ ] **HSTS**: Apache sends `max-age=86400` for med.sundragon.se. Raise it to 31536000 in
      `deploy/apache-med.conf` (and on ns1) once the site has worked for a while.
- [ ] **Metformin default package size** is 100 while the packages hold 105; kept on purpose. It only
      affects when the "under one package" warning comes.
- [ ] **Calendar feed name in the web**: feeds can only be listed and revoked from the CLI; the web shows
      the URL once at creation.

## Done today, for reference

- Workspace (pnpm, Drizzle on MariaDB `med` on ns1), schema with three tiers, organizers (morning 2×7,
  evening 1×7), transfers, counts, passkeys, calendar feeds and prices.
- `@med/core`: the stock history and projection, the event list rules (90 % pickup rule, expiry pickups,
  doctor lead time, pickups from a prescription still to be renewed).
- CLI: stock, events, refill, pickup, renew, count, drop, medication/dose/organizer management, passkeys,
  feeds, prices with the yearly cost.
- Web: passkey login with CLI approval, stock table, event list, refill/pickup/new prescription/count
  dialogs, calendar feed creation. Deployed with `deploy/deploy.sh`.
