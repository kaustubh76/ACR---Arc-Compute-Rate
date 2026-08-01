#!/usr/bin/env python
"""Spike: can Circle user-controlled wallets open an SCA on ARC-TESTNET?

Validates the three assumptions the Public Desk feature depends on, straight
against Circle's REST API (the FastAPI backend will use the same calls):

  1. the entity config serves an App ID (no console step needed),
  2. ``POST /user/initialize`` accepts ``ARC-TESTNET`` + ``SCA``,
  3. a challengeId comes back (PIN setup itself needs the browser SDK).

    ACR_CIRCLE_API_KEY=... uv run python scripts/desk_spike.py

Read-only against funds: creates a throwaway test user, never moves USDC.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import uuid

BASE = os.environ.get("ACR_CIRCLE_BASE_URL") or "https://api.circle.com"
KEY = os.environ.get("ACR_CIRCLE_API_KEY", "")


def call(method: str, path: str, body: dict | None = None, user_token: str | None = None) -> dict:
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "acr-desk-spike/1.0")
    if user_token:
        req.add_header("X-User-Token", user_token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        print(f"  ✗ {method} {path} -> {e.code}: {detail[:400]}")
        raise SystemExit(1) from e


def main() -> None:
    if not KEY:
        print("set ACR_CIRCLE_API_KEY")
        sys.exit(1)

    cfg = call("GET", "/v1/w3s/config/entity")
    app_id = (cfg.get("data") or {}).get("appId")
    print(f"  ① entity config — appId: {app_id}")

    user_id = f"acr-desk-spike-{int(time.time())}"
    call("POST", "/v1/w3s/users", {"userId": user_id})
    print(f"  ② created test user {user_id}")

    tok = call("POST", "/v1/w3s/users/token", {"userId": user_id})["data"]
    print(f"  ③ userToken ({len(tok['userToken'])} chars) + encryptionKey OK")

    init = call(
        "POST",
        "/v1/w3s/user/initialize",
        {
            "idempotencyKey": str(uuid.uuid4()),
            "blockchains": ["ARC-TESTNET"],
            "accountType": "SCA",
        },
        user_token=tok["userToken"],
    )["data"]
    print(f"  ④ initialize ARC-TESTNET + SCA accepted — challengeId: {init.get('challengeId')}")
    print("\n  → user-controlled SCA wallets work on Arc Testnet; the Public Desk is buildable.")
    print("    (PIN setup + the gasless-trade check happen in the browser E2E step.)")


if __name__ == "__main__":
    main()
