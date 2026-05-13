"""
Anomaly Detection Engine
────────────────────────
Scans expense rows for suspicious patterns — both within-session
and cross-session (reads historical result.json files).

Called after validate_expenses() in main.py:
    rows = detect_anomalies(rows, session_id, upload_base)

Returns the same rows list with `.anomaly_flags` populated.
"""

import os
import json
import logging
from datetime import date, datetime
from typing import List, Optional, Dict
from collections import defaultdict

log = logging.getLogger(__name__)

# ── Indian Public Holidays (2025–2026) ────────────────────────────────────────
_HOLIDAYS: set = {
    # 2025
    date(2025, 1, 1),  date(2025, 1, 26), date(2025, 3, 14),
    date(2025, 4, 14), date(2025, 4, 18), date(2025, 5, 1),
    date(2025, 8, 15), date(2025, 8, 16), date(2025, 10, 2),
    date(2025, 10, 22),date(2025, 11, 1), date(2025, 11, 5),
    date(2025, 12, 25),
    # 2026
    date(2026, 1, 1),  date(2026, 1, 26), date(2026, 3, 17),
    date(2026, 4, 2),  date(2026, 4, 14), date(2026, 5, 1),
    date(2026, 8, 15), date(2026, 8, 19), date(2026, 10, 2),
    date(2026, 10, 20),date(2026, 11, 9), date(2026, 11, 10),
    date(2026, 12, 25),
}

_DATE_FORMATS = [
    "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    "%d/%m/%y", "%d-%m-%y",
]


def _parse_date(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    s = str(s).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _load_policy_limits(backend_dir: str) -> Dict[str, float]:
    """Return {category_keyword: limit_amount} for enabled rules."""
    limits: Dict[str, float] = {}
    policy_path = os.path.join(backend_dir, "policy_rules.json")
    if not os.path.isfile(policy_path):
        return limits
    try:
        with open(policy_path, "r", encoding="utf-8") as f:
            policy = json.load(f)
        for rule in policy.get("rules", []):
            if not rule.get("enabled"):
                continue
            cat = (rule.get("category") or "").lower().strip()
            lim = float(rule.get("limit") or 0)
            if cat and lim > 0:
                limits[cat] = lim
    except Exception:
        pass
    return limits


def _load_history(upload_base: str, exclude_session: str) -> List[dict]:
    """Read all past result.json rows from disk (excluding current session)."""
    history: List[dict] = []
    try:
        for sid in os.listdir(upload_base):
            if sid == exclude_session:
                continue
            path = os.path.join(upload_base, sid, "result.json")
            if not os.path.isfile(path):
                continue
            try:
                for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
                    try:
                        with open(path, encoding=enc) as f:
                            data = json.load(f)
                        break
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                else:
                    continue
                for r in data.get("rows", []):
                    history.append(r)
            except Exception:
                continue
    except Exception:
        pass
    return history


# ── Main entry point ─────────────────────────────────────────────────────────

def detect_anomalies(rows, session_id: str, upload_base: str) -> list:
    """
    Run all anomaly checks on the given rows.
    Populates row.anomaly_flags (list of human-readable warning strings).
    Returns the same rows list (mutated in place).
    """
    if not rows:
        return rows

    backend_dir = os.path.join(os.path.dirname(__file__), "..")
    policy_limits = _load_policy_limits(backend_dir)

    # Convert rows to plain dicts for history checks, but keep objects for mutation
    row_dicts = []
    for r in rows:
        if hasattr(r, "model_dump"):
            row_dicts.append(r.model_dump())
        elif hasattr(r, "__dict__"):
            row_dicts.append(r.__dict__)
        else:
            row_dicts.append(r)

    # ── Check 1: Bill date on Sunday or public holiday ────────────────────────
    for row, rd in zip(rows, row_dicts):
        d = _parse_date(rd.get("expense_date") or rd.get("bill_date"))
        if d:
            if d.weekday() == 6:
                _add_flag(row, f"Bill date {d.strftime('%d %b %Y')} is a Sunday")
            elif d in _HOLIDAYS:
                _add_flag(row, f"Bill date {d.strftime('%d %b %Y')} is a public holiday")

    # ── Check 2: Amount suspiciously close to policy limit (within 5 %) ──────
    for row, rd in zip(rows, row_dicts):
        cat = (rd.get("expense_nature") or rd.get("expense_category") or "").lower()
        amt = float(rd.get("claimed_amount") or 0)
        for kw, limit in policy_limits.items():
            if kw not in cat:
                continue
            # Flag if amount is within 5 % BELOW the limit (classic split-bill trick)
            if limit * 0.95 <= amt < limit:
                _add_flag(row,
                    f"Amount ₹{amt:.0f} is suspiciously close to policy limit ₹{limit:.0f}"
                )

    # ── Check 3: Vendor appears in many rows of this same batch ──────────────
    vendor_rows: Dict[str, List[int]] = defaultdict(list)
    for rd in row_dicts:
        ocr = rd.get("ocr_result") or {}
        vendor = (ocr.get("vendor_name") or "").strip().lower()
        if vendor and len(vendor) > 3:
            vendor_rows[vendor].append(rd.get("row_index", -1))

    for row, rd in zip(rows, row_dicts):
        ocr = rd.get("ocr_result") or {}
        vendor = (ocr.get("vendor_name") or "").strip().lower()
        if vendor and vendor in vendor_rows:
            count = len(vendor_rows[vendor])
            if count >= 4:
                _add_flag(row,
                    f"Vendor '{vendor}' appears in {count} claims in this batch"
                )

    # ── Check 4: Vendor-category mismatch (via vendor master) ────────────────
    try:
        from services.vendor_master import is_vendor_category_mismatch
        for row, rd in zip(rows, row_dicts):
            ocr = rd.get("ocr_result") or {}
            vendor = (ocr.get("vendor_name") or "").strip()
            category = rd.get("expense_nature") or rd.get("expense_category") or ""
            if vendor and category:
                if is_vendor_category_mismatch(vendor, category):
                    _add_flag(row,
                        f"Vendor '{vendor}' doesn't match category '{category}'"
                    )
    except Exception as e:
        log.debug("Vendor-category mismatch check failed: %s", e)

    # ── Cross-session checks ──────────────────────────────────────────────────
    try:
        history = _load_history(upload_base, session_id)
        _check_cross_session(rows, row_dicts, history, policy_limits)
    except Exception as e:
        log.debug("Cross-session anomaly check failed: %s", e)

    return rows


def _check_cross_session(rows, row_dicts, history: List[dict], policy_limits: Dict[str, float]):
    """
    Cross-session checks that need historical data.
    """
    # Build employee → [past rows] map
    emp_history: Dict[str, List[dict]] = defaultdict(list)
    for h in history:
        emp = (h.get("employee_name") or "").lower().strip()
        if emp:
            emp_history[emp].append(h)

    for row, rd in zip(rows, row_dicts):
        emp  = (rd.get("employee_name") or "").lower().strip()
        amt  = float(rd.get("claimed_amount") or 0)
        cat  = (rd.get("expense_category") or "").lower().strip()

        if not emp or amt <= 0:
            continue

        past = emp_history.get(emp, [])
        if not past:
            continue

        # Check 5: Identical claim (same amount + same category) submitted before
        matching = [
            h for h in past
            if abs(float(h.get("claimed_amount") or 0) - amt) < 1.0
            and (h.get("expense_category") or "").lower().strip() == cat
        ]
        if len(matching) >= 2:
            _add_flag(row,
                f"Identical claim (₹{amt:.0f}, {cat}) has been submitted "
                f"{len(matching)} times before by this employee"
            )

        # Check 6: Repeated just-below-limit pattern across sessions
        for kw, limit in policy_limits.items():
            if kw not in cat:
                continue
            if not (limit * 0.95 <= amt < limit):
                continue
            # Count how many past claims for this employee are also just below limit
            near_limit_past = [
                h for h in past
                if kw in (h.get("expense_category") or "").lower()
                and limit * 0.95 <= float(h.get("claimed_amount") or 0) < limit
            ]
            if len(near_limit_past) >= 2:
                _add_flag(row,
                    f"Employee has submitted amounts near policy limit "
                    f"(₹{limit:.0f}) {len(near_limit_past)+1} times — possible limit avoidance"
                )


def _add_flag(row, message: str):
    """Safely append a flag to row.anomaly_flags."""
    try:
        if not hasattr(row, "anomaly_flags") or row.anomaly_flags is None:
            row.anomaly_flags = []
        if message not in row.anomaly_flags:
            row.anomaly_flags.append(message)
    except Exception:
        pass
