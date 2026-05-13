"""
Simple username/password authentication for the Expense Validator app.

Credentials are read from the .env file:
    APP_USERNAME=admin
    APP_PASSWORD=<your password>
    APP_SECRET=<random string for token signing>

Tokens are JWT-style HMAC-signed strings stored in localStorage by the frontend
and sent via Authorization: Bearer <token> on every protected request.
"""
import os
import hmac
import json
import time
import base64
import hashlib
from typing import Optional
from fastapi import HTTPException, Header

# 24-hour token validity by default
TOKEN_TTL_SECONDS = int(os.environ.get("APP_SESSION_HOURS", "24")) * 3600

APP_USERNAME = os.environ.get("APP_USERNAME", "admin")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "wiom@2026")
APP_SECRET   = os.environ.get("APP_SECRET", "wiom-expense-validator-secret-change-me")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def create_token(username: str, role: str = "reviewer") -> str:
    """Issue a HMAC-signed token: <payload>.<signature>"""
    payload = {
        "u":    username,
        "role": role,
        "exp":  int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(APP_SECRET.encode("utf-8"), payload_b64.encode("utf-8"),
                   hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)
    return f"{payload_b64}.{sig_b64}"


def verify_token(token: str) -> Optional[dict]:
    """Verify the token signature + expiry. Returns payload dict or None."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected_sig = hmac.new(APP_SECRET.encode("utf-8"), payload_b64.encode("utf-8"),
                                 hashlib.sha256).digest()
        actual_sig = _b64url_decode(sig_b64)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def authenticate(username: str, password: str) -> Optional[str]:
    """Validate creds against DB and return a signed token, or None on failure."""
    try:
        from services.db import get_user, verify_password, update_last_login
        user = get_user(username)
        if user and verify_password(password, user["password_hash"]):
            update_last_login(username)
            return create_token(username, user.get("role", "reviewer"))
    except Exception:
        pass
    # Fallback: env-var credentials (backward compat for fresh installs before DB init)
    if (hmac.compare_digest(username, APP_USERNAME)
            and hmac.compare_digest(password, APP_PASSWORD)):
        return create_token(username, "admin")
    return None


# ── FastAPI dependencies ───────────────────────────────────────────────────────

def require_auth(authorization: Optional[str] = Header(None)) -> dict:
    """Extracts + verifies Bearer token. Returns payload or raises 401."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Authentication required")
    token = authorization[7:].strip()
    payload = verify_token(token)
    if not payload:
        raise HTTPException(401, "Invalid or expired token")
    return payload


def require_admin(authorization: Optional[str] = Header(None)) -> dict:
    """Like require_auth but also enforces admin role."""
    payload = require_auth(authorization)
    if payload.get("role") != "admin":
        raise HTTPException(403, "Admin access required")
    return payload
