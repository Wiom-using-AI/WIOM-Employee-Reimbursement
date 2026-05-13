"""
SQLite database for user management and activity logging.
Auto-migrates on startup — no external tools needed.
"""
import os
import sqlite3
import hashlib
import hmac
import secrets
import time
import json
from typing import Optional, List

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "app.db")

# Thread-safe connections: each call gets its own connection
def _conn():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    c = _conn()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    UNIQUE NOT NULL,
            password_hash TEXT   NOT NULL,
            role         TEXT    NOT NULL DEFAULT 'reviewer',
            full_name    TEXT    NOT NULL DEFAULT '',
            email        TEXT    NOT NULL DEFAULT '',
            is_active    INTEGER NOT NULL DEFAULT 1,
            created_at   REAL    NOT NULL,
            last_login   REAL
        );

        CREATE TABLE IF NOT EXISTS activity_logs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    NOT NULL,
            action       TEXT    NOT NULL,
            entity_type  TEXT    NOT NULL DEFAULT '',
            entity_id    TEXT    NOT NULL DEFAULT '',
            details      TEXT    NOT NULL DEFAULT '{}',
            ip_address   TEXT    NOT NULL DEFAULT '',
            created_at   REAL    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_logs_username   ON activity_logs(username);
        CREATE INDEX IF NOT EXISTS idx_logs_action     ON activity_logs(action);
        CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_logs(created_at DESC);

        CREATE TABLE IF NOT EXISTS sessions (
            id           TEXT PRIMARY KEY,
            username     TEXT    NOT NULL DEFAULT '',
            filename     TEXT    NOT NULL DEFAULT '',
            source       TEXT    NOT NULL DEFAULT 'upload',
            status       TEXT    NOT NULL DEFAULT 'processing',
            total_claims INTEGER NOT NULL DEFAULT 0,
            approved     INTEGER NOT NULL DEFAULT 0,
            rejected     INTEGER NOT NULL DEFAULT 0,
            flagged      INTEGER NOT NULL DEFAULT 0,
            created_at   REAL    NOT NULL,
            completed_at REAL,
            ip_address   TEXT    NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_username   ON sessions(username);
        CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
    """)
    c.commit()

    # Auto-migrate: add session lock columns if they don't exist
    existing_cols = [row[1] for row in c.execute("PRAGMA table_info(sessions)").fetchall()]
    if "locked" not in existing_cols:
        c.execute("ALTER TABLE sessions ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")
    if "locked_by" not in existing_cols:
        c.execute("ALTER TABLE sessions ADD COLUMN locked_by TEXT NOT NULL DEFAULT ''")
    if "locked_at" not in existing_cols:
        c.execute("ALTER TABLE sessions ADD COLUMN locked_at REAL")
    c.commit()

    # Seed default admin if table is empty
    count = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count == 0:
        admin_user = os.environ.get("APP_USERNAME", "admin")
        admin_pass = os.environ.get("APP_PASSWORD", "wiom@2026")
        c.execute(
            "INSERT INTO users (username, password_hash, role, full_name, is_active, created_at) VALUES (?, ?, 'admin', 'Administrator', 1, ?)",
            (admin_user, _hash_password(admin_pass), time.time()),
        )
        c.commit()
    c.close()


# ── Password hashing ──────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"pbkdf2:{salt}:{key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, key_hex = stored.split(":", 2)
        key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
        return hmac.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


# ── User CRUD ─────────────────────────────────────────────────────────────────

def get_user(username: str) -> Optional[dict]:
    c = _conn()
    row = c.execute("SELECT * FROM users WHERE username = ? AND is_active = 1", (username,)).fetchone()
    c.close()
    return dict(row) if row else None


def get_user_by_id(user_id: int) -> Optional[dict]:
    c = _conn()
    row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    c.close()
    return dict(row) if row else None


def get_all_users() -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT id, username, role, full_name, email, is_active, created_at, last_login FROM users ORDER BY created_at"
    ).fetchall()
    c.close()
    return [dict(r) for r in rows]


def create_user(username: str, password: str, role: str = "reviewer",
                full_name: str = "", email: str = "") -> dict:
    c = _conn()
    c.execute(
        "INSERT INTO users (username, password_hash, role, full_name, email, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        (username, _hash_password(password), role, full_name, email, time.time()),
    )
    c.commit()
    row = c.execute(
        "SELECT id, username, role, full_name, email, is_active, created_at FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    c.close()
    return dict(row)


def update_user(user_id: int, **kwargs) -> Optional[dict]:
    _ALLOWED = {"role", "full_name", "email", "is_active"}
    updates = {k: v for k, v in kwargs.items() if k in _ALLOWED and v is not None}
    if "password" in kwargs and kwargs["password"]:
        updates["password_hash"] = _hash_password(kwargs["password"])
    if not updates:
        return get_user_by_id(user_id)
    c = _conn()
    sets = ", ".join(f"{k} = ?" for k in updates)
    c.execute(f"UPDATE users SET {sets} WHERE id = ?", [*updates.values(), user_id])
    c.commit()
    row = c.execute(
        "SELECT id, username, role, full_name, email, is_active, created_at, last_login FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    c.close()
    return dict(row) if row else None


def delete_user(user_id: int):
    c = _conn()
    c.execute("DELETE FROM users WHERE id = ?", (user_id,))
    c.commit()
    c.close()


def update_last_login(username: str):
    c = _conn()
    c.execute("UPDATE users SET last_login = ? WHERE username = ?", (time.time(), username))
    c.commit()
    c.close()


# ── Activity Logging ──────────────────────────────────────────────────────────

def log_activity(username: str, action: str, entity_type: str = "",
                 entity_id: str = "", details: dict = None, ip_address: str = ""):
    c = _conn()
    c.execute(
        "INSERT INTO activity_logs (username, action, entity_type, entity_id, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (username, action, entity_type, entity_id, json.dumps(details or {}), ip_address, time.time()),
    )
    c.commit()
    c.close()


def get_activity_logs(limit: int = 100, offset: int = 0,
                      username: str = None, action: str = None) -> List[dict]:
    c = _conn()
    where, params = ["1=1"], []
    if username:
        where.append("username = ?"); params.append(username)
    if action:
        where.append("action = ?");   params.append(action)
    params.extend([limit, offset])
    rows = c.execute(
        f"SELECT * FROM activity_logs WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    c.close()
    result = []
    for r in rows:
        d = dict(r)
        try:    d["details"] = json.loads(d["details"])
        except: d["details"] = {}
        result.append(d)
    return result


def get_log_stats() -> dict:
    c = _conn()
    total = c.execute("SELECT COUNT(*) FROM activity_logs").fetchone()[0]
    users = c.execute("SELECT COUNT(DISTINCT username) FROM activity_logs").fetchone()[0]
    today_ts = time.time() - 86400
    today = c.execute("SELECT COUNT(*) FROM activity_logs WHERE created_at > ?", (today_ts,)).fetchone()[0]
    c.close()
    return {"total": total, "unique_users": users, "last_24h": today}


# ── Session Records ───────────────────────────────────────────────────────────

def create_session_record(session_id: str, username: str, filename: str,
                           source: str = "upload", ip_address: str = "") -> None:
    c = _conn()
    c.execute(
        "INSERT OR IGNORE INTO sessions (id, username, filename, source, status, created_at, ip_address) VALUES (?, ?, ?, ?, 'processing', ?, ?)",
        (session_id, username, filename, source, time.time(), ip_address),
    )
    c.commit()
    c.close()


def update_session_record(session_id: str, status: str, total_claims: int = 0,
                           approved: int = 0, rejected: int = 0, flagged: int = 0) -> None:
    c = _conn()
    completed_at = time.time() if status != "processing" else None
    c.execute(
        "UPDATE sessions SET status=?, total_claims=?, approved=?, rejected=?, flagged=?, completed_at=? WHERE id=?",
        (status, total_claims, approved, rejected, flagged, completed_at, session_id),
    )
    c.commit()
    c.close()


def get_all_sessions(limit: int = 100, offset: int = 0) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    c.close()
    return [dict(r) for r in rows]


# ── Session Locking ───────────────────────────────────────────────────────────

def lock_session(session_id: str, username: str) -> None:
    c = _conn()
    c.execute(
        "UPDATE sessions SET locked=1, locked_by=?, locked_at=? WHERE id=?",
        (username, time.time(), session_id),
    )
    c.commit()
    c.close()


def unlock_session(session_id: str) -> None:
    c = _conn()
    c.execute(
        "UPDATE sessions SET locked=0, locked_by='', locked_at=NULL WHERE id=?",
        (session_id,),
    )
    c.commit()
    c.close()


def is_session_locked(session_id: str) -> bool:
    c = _conn()
    row = c.execute("SELECT locked FROM sessions WHERE id=?", (session_id,)).fetchone()
    c.close()
    return bool(row and row["locked"])


def get_session_lock_info(session_id: str) -> Optional[dict]:
    c = _conn()
    row = c.execute(
        "SELECT locked, locked_by, locked_at FROM sessions WHERE id=?", (session_id,)
    ).fetchone()
    c.close()
    if not row:
        return None
    return {"locked": bool(row["locked"]), "locked_by": row["locked_by"], "locked_at": row["locked_at"]}


def get_sessions_stats() -> dict:
    c = _conn()
    total     = c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    completed = c.execute("SELECT COUNT(*) FROM sessions WHERE status='completed'").fetchone()[0]
    today_ts  = time.time() - 86400
    today     = c.execute("SELECT COUNT(*) FROM sessions WHERE created_at > ?", (today_ts,)).fetchone()[0]
    c.close()
    return {"total": total, "completed": completed, "last_24h": today}
