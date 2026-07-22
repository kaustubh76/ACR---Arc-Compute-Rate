"""Pytest bootstrap — keep the suite hermetic and credential-free.

Tests must not depend on a developer's local ``.env`` (Circle API keys, Arc RPC,
x402 facilitator URL, …). We disable dotenv loading and strip any ``ACR_*`` env
vars before collection, so every path-selection (sim vs arc tape, dev vs Circle
facilitator, raw-key vs Circle signer) resolves to the offline default unless a
test sets it explicitly via ``monkeypatch.setenv`` + ``reset_settings()``.
"""

from __future__ import annotations

import os


def pytest_configure(config) -> None:  # noqa: ARG001 - pytest hook signature
    from acr_core import reset_settings
    from acr_core.config import ACRSettings

    ACRSettings.model_config["env_file"] = None
    for key in [k for k in os.environ if k.startswith("ACR_")]:
        del os.environ[key]
    reset_settings()
