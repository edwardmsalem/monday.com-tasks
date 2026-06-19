# SS-Number Flow (season-ticket SIM setup) — build + deploy runbook

Created 2026-06-19. Recreates the manual "create an SS number" step as code,
triggered from Monday. Replaces what used to be done by hand / via Bod.

## The flow

1. Operator sets a Lead's **Status** to **"Request Setup"** (Leads board
   `7511353720`, column `lead_status`, label index 2).
2. forwarding-monday webhook fires `handleSsNumberRequest`:
   - reads the lead's identity (name, `address_1`, `text_mkq99yqj` city,
     `text_mkn97bke` state-abbr, `lead_zipcode` zip),
   - calls farm-b `POST /api/sim/ss-number-swap`.
3. farm-b: claims a call-forward-safe SIM from Master Numbers, runs JUST the
   Unavo swap unsandboxed (`execute_standalone` -> new MDN + writeback to Master
   Numbers, all already built), returns the new SS number.
4. forwarding-monday stamps the SS number on the lead's `ss_mobile` and sets
   Status -> **"Setup Complete"**.

## DEPLOYMENT STATUS (2026-06-19) — built + verified, NOT yet firing real swaps

DONE (poll model chosen — see "Trigger path" below):
- farm-b `/opt/salem/tm_deterministic/bin/ss_swap.py` (manual swap CLI) — deployed, imports OK.
- farm-b `/usr/local/bin/ss-swap-unsandboxed` + sudoers `/etc/sudoers.d/ss-swap` (`salem` NOPASSWD) — deployed, visudo OK.
- farm-b `POST /api/sim/ss-number-swap` appended to `api.py` (backup `api.py.bak-ssnumber-*`) — service restarted, route live. Dry-run tested on `127.0.0.1:18792`: 883 eligible SIMs.
- farm-b `/opt/salem/tm_deterministic/bin/ss_poller.py` + `salem-ss-poller.{service,timer}` — deployed, daemon-reloaded. **TIMER DISABLED + INACTIVE** (intentional). Read path + identity resolution verified (Marcus Crawley -> Detroit MI 48235, no missing fields).
- Monday side `monday.com-tasks` — deployed DISABLED (this push path is NOT used in the poll model; harmless, left off).

NOTE the farm_b-api listens on **127.0.0.1:18792** (18791 is the OpenClaw gateway). farm-b is localhost-only; the poll model needs no inbound path.

REMAINING (each needs Eddie's go — fires a REAL irreversible Unavo swap):
1. One sacrificial test SIM -> `curl -X POST 127.0.0.1:18792/api/sim/ss-number-swap` with a real identity, verify new MDN + Master Numbers update.
2. Then `sudo systemctl enable --now salem-ss-poller.timer` to turn the trigger on.

## What is built where

### Monday side (DONE, deployed disabled) — repo `monday.com-tasks`
- `src/services/ssNumberRequest.ts` — the handler.
- `src/routes/mondayWebhook.ts` — wired (board+column match).
- GATE: fires a real swap ONLY when env `SS_NUMBER_FLOW_ENABLED=true`. Otherwise
  dry-run (logs intent; if `FARM_B_API_URL` set, asks farm-b for a dry-run
  allocation preview). Env needed: `FARM_B_API_URL`, optional `FARM_B_API_KEY`.

### farm-b side (STAGED here, NOT deployed — additive, nothing existing edited)
- `ss_swap.py`            -> `/opt/salem/tm_deterministic/bin/ss_swap.py`
- `ss-swap-unsandboxed`   -> `/usr/local/bin/ss-swap-unsandboxed` (root, chmod 755)
- `endpoint-snippet.py`   -> append the route block into `/opt/salem/farm_b/api.py`
  near the other `/api/sim/*` routes.

## Deploy steps (do only on Eddie's go)

1. Copy the two new files:
   - `scp ss_swap.py farm-b:/opt/salem/tm_deterministic/bin/ss_swap.py`
   - `scp ss-swap-unsandboxed farm-b:/tmp/` then as root:
     `install -m 755 -o root -g root /tmp/ss-swap-unsandboxed /usr/local/bin/`
2. Sudoers (root): allow the API service user to run the wrapper without a
   password, mirroring the aao line. Find the existing aao entry first:
   `grep -rn aao-run-unsandboxed /etc/sudoers /etc/sudoers.d/` then add a
   parallel line for `ss-swap-unsandboxed` for the same user. `visudo -c` after.
3. Add the endpoint block from `endpoint-snippet.py` into `api.py`. Confirm the
   referenced names exist as-is: `sim_claim_eligible`, `sim_available_count`,
   `sim_release` (POST `/api/sim/release/{phone}`), `_sim_master_items`,
   `_sim_column_map`, `_AAO_RUNNING`. Restart the farm_b-api service.
4. Set `FARM_B_API_URL` (+ `FARM_B_API_KEY` if used) in forwarding-monday's
   Railway env. NOTE: confirm Railway can actually reach farm-b's API
   (138.201.142.186) — if the API is not publicly reachable, this needs a
   tunnel/allowlist. This is the one network unknown.

## Test plan (gated — fires a REAL, irreversible carrier swap)

1. Dry-run end to end first: leave `SS_NUMBER_FLOW_ENABLED` unset, flip a test
   lead to "Request Setup", confirm the log shows the right identity + a farm-b
   dry-run preview with `eligible_count > 0`. No swap happens.
2. Standalone smoke test on ONE sacrificial SIM (Eddie picks it): call
   `POST /api/sim/ss-number-swap` directly with a real test identity. Verify:
   new MDN returned, Master Numbers row updated, SIM marked in-use.
3. Only then set `SS_NUMBER_FLOW_ENABLED=true` and run one real lead.

## Decisions captured (Eddie 2026-06-19)
- Flow ALLOCATES the SIM (auto-pick), operator does not pre-link.
- SWAP ONLY, no email (writeback writes MDN only; owner_email omitted).

## Open / residual items
- **Call-forward safety**: the allocator (`claim-eligible`) does not itself check
  the new Call Forwards column; it prefers bank 50028 (safe). The new endpoint
  double-checks the claimed row (bank not in {50024,50032} and Call Forwards !=
  "No") and releases + errors if unsafe. Long-term cleaner: add the check inside
  `_sim_master_ready_row`, or backfill Call Forwards="Yes" on good banks.
- **Single-run collision**: ss-swap and AAO share the headed :99 browser. The
  new endpoint refuses if an AAO or ss-swap run is active. But AAO's own guard
  does NOT know about ss-swap, so an AAO run STARTED during an ss-swap could
  collide. Swaps are operator-driven + rare; run when AAO idle. A shared lock is
  the proper fix (needs an existing-code change -> Rigel).
- **SIM<->person link**: at lead stage the person is a Lead, not yet an
  Associate, so the Master Numbers "Associate" relation can't point at them. The
  number lands on the lead's `ss_mobile`; the SIM is reserved (in-use). The
  Master<->Associate link is finalized later via the existing associate-link flow
  when the lead becomes an associate. Confirm this is acceptable.
- **Network reachability** farm-b API from Railway (see deploy step 4).
