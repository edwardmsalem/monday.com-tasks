"""Standalone SS-number swap CLI (season-ticket flow).

DUPLICATE of unavo_swap.main(), modified to use execute_standalone (which
launches its own plain headed browser on :99 and does login + swap + the Monday
writeback + SIM re-register inside run()) instead of execute() (which demands a
caller-supplied --cdp-endpoint / pre-opened MLX browser).

Nothing in the existing tm_deterministic code is changed. This is a new entry
point only. Deploy to: /opt/salem/tm_deterministic/bin/ss_swap.py

Invoked unsandboxed by /usr/local/bin/ss-swap-unsandboxed. Prints a single JSON
object to stdout and exits 0 on result==ok, 1 otherwise.

NO owner_email is passed -> the writeback writes only the new MDN to Master
Numbers (Eddie: "swap only, no email").
"""

import argparse
import asyncio
import json
import sys

from tm_deterministic.steps.unavo_swap import execute_standalone


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iccid", required=True)
    ap.add_argument("--first-name", required=True)
    ap.add_argument("--last-name", required=True)
    ap.add_argument("--address1", required=True)
    ap.add_argument("--city", required=True)
    ap.add_argument("--state", required=True, help="2-letter state code")
    ap.add_argument("--zip", required=True, dest="zipcode")
    args = ap.parse_args()
    identity = {
        "first_name": args.first_name,
        "last_name": args.last_name,
        "address1": args.address1,
        "city": args.city,
        "state": args.state.upper(),
        "zip": args.zipcode,
        # no "email" key -> owner_email stays None in the writeback
    }
    result = asyncio.run(execute_standalone(args.iccid, identity))
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("result") == "ok" else 1)


if __name__ == "__main__":
    main()
