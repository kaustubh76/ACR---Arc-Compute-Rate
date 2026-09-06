"""Pytest bootstrap — keep the suite hermetic and credential-free.

Tests must not depend on a developer's local ``.env`` (Circle API keys, Arc RPC,
x402 facilitator URL, …). We disable dotenv loading and strip any ``ACR_*`` env
vars before collection, so every path-selection (sim vs arc tape, dev vs Circle
facilitator, raw-key vs Circle signer) resolves to the offline default unless a
test sets it explicitly via ``monkeypatch.setenv`` + ``reset_settings()``.
"""

from __future__ import annotations

import os

# Single-threaded BLAS, set before numpy is imported anywhere.
#
# Two LAPACK paths sit on the hot path, not one: `np.linalg.solve` in the RTS
# smoother (observation_model.py), on a structurally near-singular k x k system —
# Q is rank-1 and F is a shift matrix, so the conditioning is dominated by an
# absolute 1e-12 jitter — and, larger, the SVD behind statsmodels' WLS in
# hedonic.py, which factorises a ~2500 x 5 design on every print.
# Multithreaded LAPACK blocks the factorisation
# differently per thread count, which changes the summation order and therefore
# the low bits. A suite that pins estimator output to a literal has to fix that,
# or the golden file fails on a machine with a different core count for reasons
# that have nothing to do with the engine.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_var, "1")


def pytest_configure(config) -> None:  # noqa: ARG001 - pytest hook signature
    from acr_core import reset_settings
    from acr_core.config import ACRSettings

    ACRSettings.model_config["env_file"] = None
    for key in [k for k in os.environ if k.startswith("ACR_")]:
        del os.environ[key]
    reset_settings()
