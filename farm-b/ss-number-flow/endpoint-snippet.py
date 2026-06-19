# ============================================================================
# SS-NUMBER SWAP ENDPOINT  --  ADD to /opt/salem/farm_b/api.py (additive only)
# ----------------------------------------------------------------------------
# New on-demand endpoint for the season-ticket flow:
#   claim a call-forward-safe SIM  ->  run JUST the Unavo swap unsandboxed
#   (execute_standalone, which also writes the new MDN back to Master Numbers)
#   ->  return the new SS number.
#
# Reuses existing functions only (sim_claim_eligible, the release endpoint,
# _sim_column_map, the SIM_MASTER_COL_* constants). Nothing existing is edited.
#
# Drop this block near the other /api/sim/* routes. Bind the two TODO names to
# the real functions in api.py before deploy.
# ============================================================================

import asyncio as _asyncio
import json as _json
import subprocess as _subprocess

SS_SWAP_WRAPPER = "/usr/local/bin/ss-swap-unsandboxed"
SS_BAD_BANKS = {"50024", "50032"}            # no call forwarding -> never for season tickets
SS_CALL_FWD_COL = "color_mm4fkbhq"           # "Call Forwards?" status (Yes/No)
_SS_SWAP_RUNNING = False                      # module-scope, like _AAO_RUNNING


class SsNumberSwapRequest(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=80)
    last_name: str = Field(default="", max_length=80)
    address1: str = Field(..., min_length=2, max_length=200)
    city: str = Field(..., min_length=1, max_length=80)
    state: str = Field(..., min_length=2, max_length=2)   # 2-letter
    zip: str = Field(..., min_length=3, max_length=12)
    dry_run: bool = Field(default=False)
    prefer_bank_id: str | None = Field(default=None)


@app.post("/api/sim/ss-number-swap")
async def sim_ss_number_swap(req: SsNumberSwapRequest) -> dict:
    global _SS_SWAP_RUNNING

    # --- DRY RUN: report the eligible pool, claim nothing, swap nothing -------
    if req.dry_run:
        count = await sim_available_count()              # existing endpoint fn
        return {
            "ok": True,
            "dry_run": True,
            "eligible_count": count.get("available_count"),
            "would_claim": (count.get("sample_ready_rows") or [None])[0],
            "note": "no SIM claimed, no swap run",
        }

    # --- single-run guard: the headed browser shares the :99 display with AAO -
    busy = (
        _SS_SWAP_RUNNING
        or _AAO_RUNNING
        or _subprocess.run(["pgrep", "-f", "tm_deterministic.bin.run_az"],
                           capture_output=True).returncode == 0
        or _subprocess.run(["pgrep", "-f", "tm_deterministic.bin.ss_swap"],
                           capture_output=True).returncode == 0
    )
    if busy:
        raise HTTPException(status_code=409,
                            detail="swap_in_progress: shared :99 browser is single-run; retry when idle")

    # --- claim a call-forward-safe SIM ---------------------------------------
    # sim_claim_eligible defaults to preferring bank 50028 (AAO-clean, has call
    # forwarding). We still verify the claimed row is not a no-call-forward bank
    # and is not explicitly Call Forwards=No, and release it if so.
    claim = await sim_claim_eligible(prefer_bank_id=req.prefer_bank_id)
    if not claim.get("ok"):
        return {"ok": False, "reason": "no_eligible_sim", "claim": claim}

    sim_item_id = claim.get("sim_item_id")
    iccid = claim.get("sim_iccid")
    bank_id = str(claim.get("sim_bank_id") or "")

    # Call-forward safety check on the actual claimed row.
    items = await _sim_master_items()
    row = next((it for it in items if str(it.get("id")) == str(sim_item_id)), None)
    cf = ""
    if row is not None:
        cf = (_sim_column_map(row).get(SS_CALL_FWD_COL) or "").strip().lower()
    if bank_id in SS_BAD_BANKS or cf == "no":
        # release is keyed on phone; no bound email was set, so force=False is fine
        await sim_release(phone=str(claim.get("sim_phone") or ""))
        return {"ok": False, "reason": "claimed_sim_no_call_forwarding",
                "sim_item_id": sim_item_id, "bank_id": bank_id}

    # --- run the swap unsandboxed --------------------------------------------
    _SS_SWAP_RUNNING = True
    try:
        proc = await _asyncio.create_subprocess_exec(
            "sudo", "-n", SS_SWAP_WRAPPER,
            str(iccid), req.first_name, req.last_name, req.address1,
            req.city, req.state.upper(), req.zip,
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.STDOUT,
        )
        out_b, _ = await proc.communicate()
        out = (out_b or b"").decode("utf-8", errors="replace")
        # ss_swap prints a single JSON object last; parse the last {...} block.
        result = {}
        try:
            start = out.rindex("{"); result = _json.loads(out[start:])
        except Exception:
            result = {"result": "HALT", "reason": f"unparseable_output: {out[-400:]}"}
    finally:
        _SS_SWAP_RUNNING = False

    ok = result.get("result") == "ok"
    new_mdn = (result.get("data") or {}).get("new_mdn")

    # On failure, release the SIM back to the pool (it was claimed in-use).
    if not ok:
        try:
            await sim_release(phone=str(claim.get("sim_phone") or ""))
        except Exception as _e:
            pass
        return {"ok": False, "result": "HALT", "reason": result.get("reason"),
                "sim_item_id": sim_item_id, "sim_iccid": iccid}

    return {
        "ok": True,
        "result": "ok",
        "sim_item_id": sim_item_id,
        "sim_iccid": iccid,
        "sim_phone": claim.get("sim_phone"),   # old number
        "new_mdn": new_mdn,                     # the SS number (already on Master Numbers via writeback)
        "bank_id": bank_id,
    }
