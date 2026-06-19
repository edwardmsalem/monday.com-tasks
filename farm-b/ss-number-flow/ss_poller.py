"""SS-number poller (season-ticket trigger).

Self-healing trigger for the SS-number flow. Every run it finds Leads in
status "Request Setup" that have no SS Mobile yet, and for ONE of them:
  - calls the local farm_b-api endpoint POST /api/sim/ss-number-swap (which
    allocates a call-forward-safe SIM and runs the Unavo swap unsandboxed,
    writing the new MDN back to Master Numbers),
  - on success, stamps the new SS number onto the lead's ss_mobile and flips
    the lead's Status to "Setup Complete".

Why a poller, not a webhook: no inbound network path to farm-b is needed, no
credentials are exposed, and it is self-healing -- a lead left in "Request
Setup" is always picked up on the next run, even after downtime.

Single-run safety:
  - an flock makes overlapping poller runs exit immediately,
  - the endpoint itself refuses (409) if a swap / AAO run is already active,
  - one lead is processed per run.

Deploy to: /opt/salem/tm_deterministic/bin/ss_poller.py
Run by:    salem-ss-poller.timer -> salem-ss-poller.service (oneshot).
Monday access reuses farm_b config (core-api creds); no new secrets.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import sys

import httpx

from farm_b import config

LEADS_BOARD_ID = "7511353720"
LEAD_STATUS_COL = "lead_status"
LEAD_ADDR1_COL = "address_1"
LEAD_CITY_COL = "text_mkq99yqj"
LEAD_ZIP_COL = "lead_zipcode"
LEAD_STATE_ABBR_COL = "text_mkn97bke"
LEAD_STATE_DROPDOWN_COL = "lead_state"
LEAD_SS_MOBILE_COL = "ss_mobile"

TRIGGER_LABEL = "Request Setup"
DONE_LABEL = "Setup Complete"

_STATE_ABBR = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
}


def _resolve_state(item: dict) -> str:
    """Return a 2-letter state code. Prefer the State Abbreviation column;
    fall back to the Stage/dropdown value (uppercase if already 2 letters,
    else map a full state name)."""
    abbr = _col(item, LEAD_STATE_ABBR_COL).strip()
    if len(abbr) == 2 and abbr.isalpha():
        return abbr.upper()
    raw = (abbr or _col(item, LEAD_STATE_DROPDOWN_COL)).strip()
    if len(raw) == 2 and raw.isalpha():
        return raw.upper()
    return _STATE_ABBR.get(raw.lower(), "")

FARMB_API = "http://127.0.0.1:18792"
SWAP_PATH = "/api/sim/ss-number-swap"
LOCK_PATH = "/tmp/ss_poller.lock"


def _log(msg: str) -> None:
    print(f"[ss_poller] {msg}", flush=True)


async def _monday(query: str) -> dict:
    cfg = config.load()
    headers = {"x-api-key": cfg.core_api.api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{cfg.core_api.url}/monday/query", headers=headers, json={"query": query})
    if r.status_code != 200:
        raise RuntimeError(f"monday http {r.status_code}: {r.text[:200]}")
    data = r.json() or {}
    if "errors" in data:
        raise RuntimeError(f"monday errors: {str(data['errors'])[:300]}")
    return data.get("data") or data


def _col(item: dict, col_id: str) -> str:
    for cv in item.get("column_values") or []:
        if cv.get("id") == col_id:
            return (cv.get("text") or "").strip()
    return ""


def _split_name(full: str) -> tuple[str, str]:
    parts = (full or "").split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


async def _find_pending() -> list[dict]:
    cols = f'["{LEAD_ADDR1_COL}","{LEAD_CITY_COL}","{LEAD_ZIP_COL}","{LEAD_STATE_ABBR_COL}","{LEAD_STATE_DROPDOWN_COL}","{LEAD_SS_MOBILE_COL}"]'
    q = (
        f'query{{items_page_by_column_values(board_id:{LEADS_BOARD_ID}, '
        f'columns:[{{column_id:"{LEAD_STATUS_COL}", column_values:["{TRIGGER_LABEL}"]}}]){{'
        f'items{{id name column_values(ids:{cols}){{id text}}}}}}}}'
    )
    data = await _monday(q)
    items = ((data.get("items_page_by_column_values") or {}).get("items")) or []
    # only those without an SS number yet
    return [it for it in items if not _col(it, LEAD_SS_MOBILE_COL)]


async def _stamp_number(lead_id: str, mdn_digits: str) -> None:
    # Only stamp the SS number. We do NOT set "Setup Complete": the operator
    # sets that after the (still-manual) SS email, and that is what triggers the
    # native Monday move to Associates. Leaving status alone keeps the human in
    # control of the changeover. The poller will not re-process this lead because
    # _find_pending filters out leads that already have an ss_mobile.
    cv = {LEAD_SS_MOBILE_COL: {"phone": mdn_digits, "countryShortName": "US"}}
    mut = (
        "mutation{change_multiple_column_values(board_id:%s, item_id:%s, "
        "column_values:%s, create_labels_if_missing:true){id}}"
        % (LEADS_BOARD_ID, lead_id, json.dumps(json.dumps(cv)))
    )
    await _monday(mut)


async def _run_one(lead: dict) -> None:
    lead_id = str(lead.get("id"))
    first, last = _split_name(lead.get("name") or "")
    identity = {
        "first_name": first,
        "last_name": last,
        "address1": _col(lead, LEAD_ADDR1_COL),
        "city": _col(lead, LEAD_CITY_COL),
        "state": _resolve_state(lead),
        "zip": _col(lead, LEAD_ZIP_COL),
    }
    missing = [k for k in ("first_name", "address1", "city", "state", "zip") if not identity[k]]
    if missing:
        _log(f"lead {lead_id} ({lead.get('name')}) missing {missing} -> skip")
        return

    _log(f"lead {lead_id} ({lead.get('name')}): requesting SS number, zip={identity['zip']}")
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(f"{FARMB_API}{SWAP_PATH}", json={**identity, "dry_run": False})
    if r.status_code == 409:
        _log("endpoint busy (409) -> will retry next run")
        return
    if r.status_code != 200:
        _log(f"lead {lead_id}: endpoint http {r.status_code}: {r.text[:200]}")
        return
    res = r.json()
    if not res.get("ok") or not res.get("new_mdn"):
        _log(f"lead {lead_id}: swap not ok: {json.dumps(res)[:300]}")
        return

    digits = "".join(c for c in str(res["new_mdn"]) if c.isdigit())
    await _stamp_number(lead_id, digits)
    _log(f"lead {lead_id}: SS number {digits} (SIM {res.get('sim_iccid')}) stamped (status left for operator)")


async def main() -> None:
    pending = await _find_pending()
    if not pending:
        _log("no leads in 'Request Setup' awaiting an SS number")
        return
    _log(f"{len(pending)} pending; processing 1 this run (lead {pending[0].get('id')})")
    await _run_one(pending[0])


if __name__ == "__main__":
    # flock: overlapping runs exit immediately (swap can take minutes)
    lock = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[ss_poller] another run holds the lock -> exit", flush=True)
        sys.exit(0)
    asyncio.run(main())
