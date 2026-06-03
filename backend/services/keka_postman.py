"""
Postman-style direct Keka OAuth API workflow.

Flow:
  1. User picks date range in UI
  2. Backend calls Keka OAuth v1 API directly (like Postman)
  3. Saves claims as a clean Excel file → input/{session}/claims.xlsx
  4. Downloads ALL receipts via every known endpoint → input/{session}/bills/{claim}/
  5. Zips bills folder → input/{session}/bills.zip
  6. Runs the existing validation pipeline on the saved input
  7. Saves the matched output → output/{session}/validation_report.xlsx

The user can inspect the input folder, re-upload it manually if desired,
and review the output folder for matched results.
"""

import os
import json
import time
import logging
import zipfile
import requests
from datetime import datetime
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

log = logging.getLogger(__name__)

# Persistent folders next to the backend
_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
INPUT_ROOT  = os.path.join(_BASE_DIR, "keka_input")
OUTPUT_ROOT = os.path.join(_BASE_DIR, "keka_output")
os.makedirs(INPUT_ROOT,  exist_ok=True)
os.makedirs(OUTPUT_ROOT, exist_ok=True)


def _make_session_dirs(from_date: str, to_date: str) -> tuple[str, str, str]:
    """Create timestamped input + output folders for a sync run.
    Returns (session_id, input_dir, output_dir)."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    session_id = f"keka_{from_date}_to_{to_date}_{ts}"
    inp = os.path.join(INPUT_ROOT,  session_id)
    out = os.path.join(OUTPUT_ROOT, session_id)
    os.makedirs(os.path.join(inp, "bills"), exist_ok=True)
    os.makedirs(out, exist_ok=True)
    return session_id, inp, out


# ── Step 1: Fetch claims from Keka OAuth API ──────────────────────────────────

# Keka v1 API approvalStatus codes (observed):
#   1 = Approved (fully approved across all levels, awaiting payment)
#   2 = Pending Approval (currently in approval workflow)
#   3 = Approved by L1 / In progress
#   4 = Paid
#   5 = Rejected (or Submitted at level 0 in approvalLogs)
# "In approval process" = status 1, 2, 3 (not yet paid, not rejected)
APPROVAL_PROCESS_STATUSES = {1, 2, 3}


def _fetch_claims_via_spa(
    from_date: str,
    to_date: str,
    company: Optional[str] = None,
) -> list[dict]:
    """
    Fetch claims using Keka's INTERNAL SPA endpoint
    (`/k/default/api/expense/claims/pending`) — has wider visibility than the
    public OAuth v1 API. Falls back to empty list if SPA session unavailable.

    The SPA endpoint returns all claims the logged-in user can see (matching
    what their Expense Claim Report page shows), then we client-side filter
    by submission date.
    """
    from services.keka_browser import (
        _get_session_cookies, _cookies_to_header, get_spa_access_token,
        KEKA_COMPANY_NAME,
    )
    co = company or KEKA_COMPANY_NAME
    base = f"https://{co}.keka.com"

    try:
        cookies = _get_session_cookies(co)
    except Exception:
        return []
    spa_token = get_spa_access_token(co) or ""
    if not spa_token:
        return []

    hdrs = {
        "Authorization": f"Bearer {spa_token}",
        "Accept":        "application/json",
        "Cookie":        _cookies_to_header(cookies),
        "User-Agent":    "Mozilla/5.0",
        "Origin":        base,
        "Referer":       f"{base}/",
    }

    all_claims: list[dict] = []
    # Two SPA endpoints to merge: pending + recent (covers all statuses)
    endpoints = [
        f"{base}/k/default/api/expense/claims/pending",
        f"{base}/k/default/api/expense/claims",
    ]
    for url in endpoints:
        for page in range(1, 6):
            try:
                r = requests.get(
                    url,
                    params={"pageNumber": page, "pageSize": 500},
                    headers=hdrs, timeout=20,
                )
                if r.status_code != 200:
                    break
                data = r.json().get("data") or []
                if not data:
                    break
                all_claims.extend(data)
                if len(data) < 500:
                    break
            except Exception as e:
                log.warning("SPA fetch %s page %d: %s", url, page, e)
                break

    # De-dup by id
    seen: set = set()
    deduped: list[dict] = []
    for c in all_claims:
        cid = c.get("id")
        if cid and cid not in seen:
            seen.add(cid)
            deduped.append(c)

    # Client-side filter by submittedOn date range
    import re as _re
    fd = from_date
    td = to_date
    filtered = []
    for c in deduped:
        raw_date = (
            c.get("submittedOn") or c.get("submittedDate") or
            c.get("submissionDate") or c.get("claimDate") or ""
        )
        m = _re.search(r"\d{4}-\d{2}-\d{2}", str(raw_date))
        d_str = m.group(0) if m else ""
        if d_str and fd <= d_str <= td:
            filtered.append(c)

    log.info("SPA fetch: %d total → %d after date filter", len(deduped), len(filtered))
    return filtered


def _spa_claim_to_oauth_shape(c: dict) -> dict:
    """
    Convert SPA claim shape (numeric ids, fewer fields) to look like
    OAuth v1 claim shape used downstream by claims_to_expense_rows etc.
    """
    out = dict(c)        # copy
    # Keep numeric id, but expose claimNumber + employeeName + employeeNumber
    out.setdefault("claimNumber", c.get("claimNumber"))
    out.setdefault("employeeName", c.get("employeeName"))
    out.setdefault("employeeIdentifier", c.get("employeeNumber") or c.get("employeeId"))
    out.setdefault("submittedOn", c.get("submittedOn"))
    out.setdefault("totalAmount", c.get("totalAmount") or c.get("claimedAmount"))
    out.setdefault("currency", "INR")
    out.setdefault("title", c.get("title"))
    # SPA gives `expenseIds` (numeric list) not `expenses` (full objects).
    # We don't have line-item details from this endpoint, so synthesize empty.
    if "expenses" not in out:
        out["expenses"] = [
            {"id": eid, "amount": (c.get("totalAmount") or 0) / max(1, len(c.get("expenseIds") or [1])),
             "title": c.get("title", ""), "attachments": []}
            for eid in (c.get("expenseIds") or [])
        ]
    out.setdefault("waitingOn", c.get("waitingOnEmployees") or c.get("payoutApproverWaitingOnEmployees"))
    return out


def fetch_claims_to_excel(
    from_date: str,
    to_date: str,
    excel_path: str,
    company: Optional[str] = None,
    waiting_on: Optional[str] = None,
    in_approval_only: bool = True,
) -> tuple[list[dict], list[dict]]:
    """
    Fetch claims and save as Excel.
    Tries Keka SPA internal API first (wider visibility — matches what the
    user's Expense Claim Report page shows). Falls back to OAuth v1 API
    if SPA session is unavailable.
    """
    from services.keka import (
        get_keka_token, fetch_expense_claims,
    )

    # ── Try SPA API first (matches user's Keka UI view) ──
    spa_claims = _fetch_claims_via_spa(from_date, to_date, company=company)
    if spa_claims:
        claims = [_spa_claim_to_oauth_shape(c) for c in spa_claims]
        log.info("Fetched %d claims via SPA API (matches Keka UI)", len(claims))
    else:
        # Fallback: OAuth v1 (limited visibility)
        token = get_keka_token()
        claims = fetch_expense_claims(token, from_date=from_date, to_date=to_date, company=company)
        log.info("Fetched %d claims via OAuth v1 API (fallback)", len(claims))

    # ── Filter by approval status — only "in approval process" claims ──
    if in_approval_only:
        before = len(claims)
        in_process = [
            c for c in claims
            if c.get("approvalStatus") in APPROVAL_PROCESS_STATUSES
        ]
        skipped_paid_rejected = before - len(in_process)
        log.info("Filtered to in-approval-process claims: %d (skipped %d paid/rejected)",
                 len(in_process), skipped_paid_rejected)
        claims = in_process

    # ── Optional approver-name filter (for specific approver's queue) ──
    if waiting_on:
        wl = waiting_on.lower()
        filtered = [
            c for c in claims
            if wl in (
                c.get("waitingOn") or c.get("currentApproverName") or
                c.get("waitingOnEmployees") or
                c.get("payoutApproverWaitingOnEmployees") or
                (c.get("approver") or {}).get("name") or
                c.get("pendingWith") or ""
            ).lower()
        ]
        if filtered:
            claims = filtered
            log.info("Filtered by approver '%s': %d claims", waiting_on, len(claims))

    log.info("Fetched %d claims for date range %s..%s (after all filters)",
             len(claims), from_date, to_date)

    # ONE ROW PER CLAIM (not per expense). Aggregate amounts, attachments, categories.
    import re as _re
    rows = []
    for c in claims:
        cid = str(c.get("id") or c.get("claimId") or "")
        emp_name = c.get("employeeName") or (c.get("employee") or {}).get("displayName", "")
        emp_id   = c.get("employeeIdentifier") or c.get("employeeNumber") or ""
        emp_email = c.get("employeeEmail") or (c.get("employee") or {}).get("email", "")
        claim_num = c.get("claimNumber") or c.get("claimNo") or cid
        title     = c.get("title") or c.get("claimTitle") or ""
        submitted = (c.get("submittedOn") or c.get("submittedDate") or "")[:10]
        currency  = c.get("currency") or "INR"

        expenses = c.get("expenses") or c.get("expenseItems") or []

        # Aggregate across all expense line items
        total_amount     = 0.0
        all_attachments  = []
        all_descriptions = []
        all_subcategories = set()
        all_dates        = []
        expense_ids      = []

        for exp in expenses:
            amt = exp.get("amount") or exp.get("claimedAmount") or 0
            if isinstance(amt, str):
                m = _re.search(r"[\d,]+\.?\d*", amt)
                amt = float(m.group(0).replace(",", "")) if m else 0.0
            total_amount += float(amt)

            for att in (exp.get("attachments") or []):
                if att.get("name"):
                    all_attachments.append(att["name"])

            desc = exp.get("comment") or exp.get("description") or exp.get("title") or ""
            if desc and desc not in all_descriptions:
                all_descriptions.append(desc)

            for cf in (exp.get("customFields") or []):
                if isinstance(cf, dict) and cf.get("value"):
                    all_subcategories.add(str(cf["value"]).strip())

            d = (exp.get("date") or exp.get("expenseDate") or "")[:10]
            if d:
                all_dates.append(d)

            if exp.get("id"):
                expense_ids.append(str(exp["id"]))

        # Use claim-level total if expenses are empty
        if total_amount == 0:
            t = c.get("totalAmount") or c.get("amount") or 0
            if isinstance(t, str):
                m = _re.search(r"[\d,]+\.?\d*", t)
                total_amount = float(m.group(0).replace(",", "")) if m else 0.0
            else:
                total_amount = float(t or 0)

        rows.append({
            "Claim Number":       claim_num,
            "Claim ID":           cid,
            "Employee Number":    emp_id,
            "Employee Name":      emp_name,
            "Employee Email":     emp_email,
            "Submitted On":       submitted,
            "Expense Date":       min(all_dates) if all_dates else submitted,
            "Expense Title":      title,
            "Sub Category":       "; ".join(sorted(all_subcategories)) if all_subcategories else "",
            "Description":        " | ".join(all_descriptions[:3]) if all_descriptions else title,
            "Total Amount":       f"{total_amount:.2f} {currency}",
            "Claimed Amount":     round(total_amount, 2),
            "Currency":           currency,
            "Expense Items":      len(expenses),
            "Attachment Name":    "; ".join(all_attachments),
            "Attachment Count":   len(all_attachments),
            "Expense IDs":        ", ".join(expense_ids),
            "Waiting On":         c.get("waitingOn", ""),
        })

    # Save as Excel
    import pandas as pd
    df = pd.DataFrame(rows)
    df.to_excel(excel_path, index=False, engine="openpyxl")
    log.info("Saved %d claim rows (1 per claim) to %s", len(rows), excel_path)
    return claims, rows


# ── Step 2A: Bulk Receipt download via Keka UI automation ─────────────────────

def _keka_click_set_date_and_fill(page, from_dt, to_dt, on_step=None, out_dir=None):
    """
    Click the 'Set date' button in Keka's toolbar, then fill in the date range.
    This is the primary strategy based on the actual Keka UI.
    """
    def _step(m):
        log.info(m)
        if on_step: on_step(m)

    def _shot(name):
        if out_dir:
            try: page.screenshot(path=os.path.join(out_dir, name))
            except Exception: pass

    from_str = from_dt.strftime("%d-%m-%Y")
    to_str   = to_dt.strftime("%d-%m-%Y")

    # ── Click the "Set date" toolbar button ──────────────────────────────────
    clicked_set_date = False
    for btn_text in ["Set date", "Set Date", "Date", "Date Range"]:
        try:
            btn = page.locator(f'button:has-text("{btn_text}"), a:has-text("{btn_text}"), span:has-text("{btn_text}")').first
            if btn.is_visible(timeout=3000):
                btn.click()
                page.wait_for_timeout(800)
                _step(f"✓ Clicked '{btn_text}' toolbar button")
                clicked_set_date = True
                break
        except Exception:
            pass

    _shot("set_date_after_click.png")

    # ── Fill the date inputs that appear ────────────────────────────────────
    filled = False
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            inputs = [i for i in page.locator('input[type="text"], input[type="date"]').all()
                      if i.is_visible()]
            if len(inputs) >= 2:
                inputs[0].triple_click(); page.wait_for_timeout(200)
                inputs[0].fill(from_dt.strftime(fmt))
                page.wait_for_timeout(300)
                inputs[1].triple_click(); page.wait_for_timeout(200)
                inputs[1].fill(to_dt.strftime(fmt))
                page.wait_for_timeout(400)
                page.keyboard.press("Tab")
                page.wait_for_timeout(300)
                page.keyboard.press("Enter")
                page.wait_for_timeout(600)
                _step(f"✓ Filled dates ({fmt}): {from_dt.strftime(fmt)} → {to_dt.strftime(fmt)}")
                filled = True
                break
        except Exception as ex:
            _step(f"Fill dates ({fmt}) error: {ex}")

    # Confirm/Apply button if present
    for ok_text in ["Apply", "OK", "Set", "Confirm", "Done"]:
        try:
            ok = page.locator(f'button:has-text("{ok_text}")').first
            if ok.is_visible(timeout=1500):
                ok.click()
                page.wait_for_timeout(800)
                _step(f"✓ Clicked '{ok_text}'")
                break
        except Exception:
            pass

    return filled or clicked_set_date


def _keka_set_date_range(page, from_dt, to_dt, on_step=None, out_dir=None):
    """
    Set the Submitted On Date range in Keka Expense Claim Report.
    Flow: click date filter -> Custom Range -> navigate calendar -> click from/to days.
    """
    def _step(m):
        log.info(m)
        if on_step: on_step(m)

    def _shot(name):
        if out_dir:
            try: page.screenshot(path=os.path.join(out_dir, name))
            except Exception: pass

    import calendar as _cal
    MONTH_NAMES = list(_cal.month_name)  # ['', 'January', ..., 'December']

    def _get_cal_months():
        """Return [leftMonth, leftYear, rightMonth, rightYear] from the open calendar."""
        return page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll(
                'bs-daterangepicker-container button'))
                .filter(e => e.offsetParent)
                .map(e => (e.innerText||'').trim())
                .filter(t => t && t.length > 1 && !/^[<>‹›◄►]$/.test(t));
            return btns;
        }""")

    def _nav_cal(direction):
        """Native-click the prev (<) or next (>) button in the open calendar."""
        bbox = page.evaluate("""(dir) => {
            const btns = Array.from(document.querySelectorAll(
                'bs-daterangepicker-container button'))
                .filter(e => e.offsetParent);
            const btn = dir === 'prev' ? btns[0] : btns[btns.length - 1];
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }""", direction)
        if bbox:
            page.mouse.click(bbox['x'], bbox['y'])
        page.wait_for_timeout(400)

    def _click_cal_day(target_day, table_index):
        """Native-mouse-click a day in the left (0) or right (1) calendar table."""
        bbox = page.evaluate("""([day, idx]) => {
            const tables = Array.from(document.querySelectorAll(
                'bs-daterangepicker-container table'));
            if (tables.length <= idx) return null;
            const tds = Array.from(tables[idx].querySelectorAll('td'))
                .filter(td => {
                    const t = (td.innerText||'').trim();
                    if (t !== String(day)) return false;
                    const cls = td.className || '';
                    if (cls.includes('disabled') || cls.includes('is-other') ||
                        cls.includes('off')) return false;
                    const sp = td.querySelector('span');
                    if (sp && parseFloat(getComputedStyle(sp).opacity||'1') < 0.5)
                        return false;
                    return td.offsetParent !== null;
                });
            if (!tds[0]) return null;
            const r = tds[0].getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }""", [target_day, table_index])
        if bbox:
            page.mouse.click(bbox['x'], bbox['y'])
        page.wait_for_timeout(600)

    # ── Step 1: Open the date filter dropdown ─────────────────────────────
    _step("Opening date filter dropdown...")
    # Robust approach: one combined CSS selector (fast 10-second wait),
    # then Playwright text locators (2 s each), then JS mouse-click fallback.
    # This avoids the original single-selector 30-second hard timeout.
    _date_filter_clicked = False

    # Pass 1 — combined CSS (all non-text selectors in one call)
    _CSS_DATE = (
        'a[id^="dateRange"], [id^="dateRange"], a[id*="dateRange"], [id*="dateRange"], '
        'a[id*="date-range"], [id*="date-range"], [data-id*="dateRange"], '
        '[aria-label*="Date Range"], [aria-label*="Submitted On"]'
    )
    try:
        el = page.wait_for_selector(_CSS_DATE, state="visible", timeout=10000)
        if el:
            el.scroll_into_view_if_needed()
            el.click()
            _date_filter_clicked = True
            _step("Date filter opened via CSS selector")
    except Exception:
        pass

    # Pass 2 — Playwright has-text locators (2 s per attempt, fast if absent)
    if not _date_filter_clicked:
        for _sel in [
            'a:has-text("Date Range")', 'button:has-text("Date Range")',
            'span:has-text("Date Range")', 'li:has-text("Date Range")',
            'a:has-text("Submitted On")', 'button:has-text("Submitted On")',
        ]:
            try:
                loc = page.locator(_sel).first
                if loc.is_visible(timeout=2000):
                    loc.scroll_into_view_if_needed()
                    loc.click()
                    _date_filter_clicked = True
                    _step(f"Date filter opened via: {_sel}")
                    break
            except Exception:
                pass

    # Pass 3 — JS evaluate + native mouse click (zero timeout, instant)
    if not _date_filter_clicked:
        _step("CSS/text selectors missed — trying JS element search for date filter")
        _bbox = page.evaluate("""() => {
            const keywords = ['daterange','date-range','submitted on','datefilter'];
            const el = Array.from(document.querySelectorAll('a,button,span,li,div,input'))
                .find(e => {
                    if (!e.offsetParent) return false;
                    const id_  = (e.id||'').toLowerCase();
                    const text_ = (e.innerText||e.textContent||'').trim().toLowerCase();
                    const lbl_  = (e.getAttribute('aria-label')||'').toLowerCase();
                    return keywords.some(k => id_.includes(k) || text_.includes(k) || lbl_.includes(k));
                });
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }""")
        if _bbox:
            page.mouse.click(_bbox['x'], _bbox['y'])
            _date_filter_clicked = True
            _step("Date filter opened via JS element search")
        else:
            _step("WARNING: date filter element not found in DOM — continuing anyway")

    page.wait_for_timeout(800)

    # ── Step 2: Click "Custom Range" (only if visible — newer Keka opens ────
    # directly as a dual-month date range picker without this step)
    try:
        cr = page.locator('text="Custom Range"').first
        if cr.is_visible(timeout=1500):
            cr.click()
            page.wait_for_timeout(1000)
            _step("Clicked Custom Range")
        else:
            _step("Custom Range not needed — calendar already open")
    except Exception:
        _step("Custom Range not present — calendar already in date-range mode")

    # ── Step 3: Wait for calendar ─────────────────────────────────────────
    try:
        page.wait_for_selector('bs-daterangepicker-container', state='visible', timeout=8000)
        _step("Date range calendar confirmed visible")
    except Exception:
        _step("bs-daterangepicker-container not found — proceeding with visible calendar")
        # Don't return — the calendar might still be usable
    _shot("date_01_calendar_open.png")

    # ── Step 4: Navigate left calendar to from_dt month ───────────────────
    for _ in range(24):
        months = _get_cal_months()
        if not months or len(months) < 2:
            break
        left_m, left_y = months[0], months[1]
        try:
            lm = MONTH_NAMES.index(left_m)
            ly = int(left_y)
        except (ValueError, IndexError):
            break
        if lm == from_dt.month and ly == from_dt.year:
            break
        if (ly, lm) > (from_dt.year, from_dt.month):
            _nav_cal('prev')
        else:
            _nav_cal('next')

    _step(f"Calendar at from_dt month — clicking day {from_dt.day}")
    _click_cal_day(from_dt.day, 0)
    _shot("date_02_from_clicked.png")

    # ── Step 5: Navigate to to_dt month and click ─────────────────────────
    for _ in range(24):
        months = _get_cal_months()
        if not months or len(months) < 4:
            break
        left_m, left_y   = months[0], months[1]
        right_m, right_y  = months[2], months[3]
        try:
            lm = MONTH_NAMES.index(left_m);  ly = int(left_y)
            rm = MONTH_NAMES.index(right_m); ry = int(right_y)
        except (ValueError, IndexError):
            break
        if lm == to_dt.month and ly == to_dt.year:
            _click_cal_day(to_dt.day, 0)
            break
        elif rm == to_dt.month and ry == to_dt.year:
            _click_cal_day(to_dt.day, 1)
            break
        elif (ly, lm) > (to_dt.year, to_dt.month):
            _nav_cal('prev')
        else:
            _nav_cal('next')

    _step(f"Clicked to_dt day {to_dt.day}")
    page.wait_for_timeout(800)
    _shot("date_03_final.png")


def _keka_set_status_filter(page, on_step=None, out_dir=None):
    """
    Click the Status dropdown (a[id^='approvalStatus']) and select 'In Approval Process'.
    The dropdown shows checkboxes: Select All / Waiting for approval / ... / In Approval Process
    """
    def _step(m):
        log.info(m)
        if on_step: on_step(m)

    def _shot(name):
        if out_dir:
            try: page.screenshot(path=os.path.join(out_dir, name))
            except Exception: pass

    # ── Open the Status dropdown ─────────────────────────────────────────────
    _step("Opening Status dropdown...")
    _status_clicked = False

    # Pass 1 — combined CSS (10-second wait, single call)
    _CSS_STATUS = (
        'a[id^="approvalStatus"], [id^="approvalStatus"], '
        'a[id*="approvalStatus"], [id*="approvalStatus"], '
        'a[id*="approval-status"], [id*="approval-status"], '
        '[aria-label*="Approval Status"], [aria-label*="Status"]'
    )
    try:
        el = page.wait_for_selector(_CSS_STATUS, state="visible", timeout=10000)
        if el:
            el.scroll_into_view_if_needed()
            el.click()
            _status_clicked = True
            _step("Status filter opened via CSS selector")
    except Exception:
        pass

    # Pass 2 — Playwright has-text locators (2 s each)
    if not _status_clicked:
        for _sel in [
            'a:has-text("Status")', 'button:has-text("Status")',
            'span:has-text("Approval Status")', 'li:has-text("Status")',
        ]:
            try:
                loc = page.locator(_sel).first
                if loc.is_visible(timeout=2000):
                    loc.scroll_into_view_if_needed()
                    loc.click()
                    _status_clicked = True
                    _step(f"Status filter opened via: {_sel}")
                    break
            except Exception:
                pass

    # Pass 3 — JS evaluate + native mouse click
    if not _status_clicked:
        _step("CSS/text selectors missed — trying JS element search for status filter")
        _bbox = page.evaluate("""() => {
            const keywords = ['approvalstatus','approval-status','approval status'];
            const el = Array.from(document.querySelectorAll('a,button,span,li,div'))
                .find(e => {
                    if (!e.offsetParent) return false;
                    const id_  = (e.id||'').toLowerCase();
                    const text_ = (e.innerText||e.textContent||'').trim().toLowerCase();
                    const lbl_  = (e.getAttribute('aria-label')||'').toLowerCase();
                    return keywords.some(k => id_.includes(k) || lbl_.includes(k))
                           || text_ === 'status';
                });
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }""")
        if _bbox:
            page.mouse.click(_bbox['x'], _bbox['y'])
            _status_clicked = True
            _step("Status filter opened via JS element search")
        else:
            _step("WARNING: status filter element not found in DOM — continuing anyway")

    page.wait_for_timeout(600)
    _shot("status_01_after_open.png")

    # ── Click "In Approval Process" via native mouse click ───────────────────
    bbox = page.evaluate("""() => {
        const items = Array.from(document.querySelectorAll(
            '.dropdown-menu li, .dropdown-menu .dropdown-item, .dropdown-item'));
        const target = items.find(e =>
            e.offsetParent !== null &&
            (e.innerText||e.textContent||'').trim() === 'In Approval Process'
        ) || items.find(e =>
            e.offsetParent !== null &&
            (e.innerText||e.textContent||'').toLowerCase().includes('approval process')
        );
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    }""")

    if bbox:
        page.mouse.click(bbox['x'], bbox['y'])
        _step("Status: In Approval Process clicked (native)")
    else:
        _step("Status 'In Approval Process' not found in dropdown")

    # Close dropdown by clicking elsewhere
    page.mouse.click(800, 400)
    page.wait_for_timeout(300)
    _shot("status_02_after_select.png")


def download_bulk_receipts_fully_auto(
    from_date: str,
    to_date: str,
    out_dir: str,
    company: Optional[str] = None,
    on_step=None,
) -> dict:
    """
    Fully automated Keka expense claim report bulk download.
    Opens a visible Chrome window and does ALL steps automatically:
      1. Navigate to Expense Claim Report
      2. Set date range (from_date → to_date) via Submitted On Date filter
      3. Set Status → In Approval Process
      4. Click Run
      5. Click 'click here' to download Excel
      6. Click Bulk Receipt to download ZIP
    No manual user interaction required.
    Returns {'xlsx_path': ..., 'zip_path': ..., 'all_files': [...]}
    """
    from playwright.sync_api import sync_playwright
    from services.keka_browser import (
        is_authenticated, _save_session_to_disk,
        _session_cache, KEKA_COMPANY_NAME, _LAUNCH_ARGS, _UA, _STEALTH_SCRIPT,
        _get_storage_state, _get_session_cookies,
    )
    from datetime import datetime as _dt

    def _step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    if not is_authenticated():
        _step("Not authenticated to Keka — login first")
        return {"xlsx_path": None, "zip_path": None, "all_files": []}

    co = company or KEKA_COMPANY_NAME
    os.makedirs(out_dir, exist_ok=True)
    captured_xlsx: Optional[str] = None
    captured_zip:  Optional[str] = None
    all_captured:  list[str] = []
    from_dt = _dt.strptime(from_date, "%Y-%m-%d")
    to_dt   = _dt.strptime(to_date,   "%Y-%m-%d")

    _HEADLESS_ARGS = _LAUNCH_ARGS + [
        "--window-size=1920,1080",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=_HEADLESS_ARGS)
        storage = _get_storage_state(co)
        if storage:
            ctx = browser.new_context(user_agent=_UA, storage_state=storage, accept_downloads=True)
        else:
            ctx = browser.new_context(user_agent=_UA, accept_downloads=True)
            ctx.add_cookies(_get_session_cookies(co))
        ctx.add_init_script(_STEALTH_SCRIPT)
        ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
            status=200, content_type="application/javascript",
            body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};"
        ))

        def _on_download(d):
            nonlocal captured_xlsx, captured_zip
            try:
                fname = d.suggested_filename or f"keka_download_{int(time.time())}"
                target = os.path.join(out_dir, fname)
                d.save_as(target)
                all_captured.append(target)
                lower = fname.lower()
                if lower.endswith((".xlsx", ".xls", ".csv")):
                    captured_xlsx = target
                    _step(f"✓ Excel: {fname}")
                elif lower.endswith(".zip"):
                    captured_zip = target
                    _step(f"✓ ZIP: {fname}")
                else:
                    _step(f"✓ File: {fname}")
            except Exception as e:
                _step(f"Download save error: {e}")

        def _on_response(resp):
            nonlocal captured_xlsx, captured_zip
            url = resp.url
            ct  = resp.headers.get("content-type", "").lower()
            is_excel = ".xlsx" in url.lower() or "spreadsheetml" in ct or "officedocument" in ct or "ms-excel" in ct
            is_zip   = ".zip" in url.lower() or "application/zip" in ct
            if not (is_excel or is_zip):
                return
            try:
                body = resp.body()
                if not body or len(body) < 200:
                    return
                if is_excel and not captured_xlsx:
                    fname = f"keka_report_{int(time.time())}.xlsx"
                    target = os.path.join(out_dir, fname)
                    with open(target, "wb") as f:
                        f.write(body)
                    captured_xlsx = target
                    all_captured.append(target)
                    _step(f"✓ Excel via response: {fname} ({len(body)} bytes)")
                elif is_zip and not captured_zip:
                    fname = f"keka_bulk_{int(time.time())}.zip"
                    target = os.path.join(out_dir, fname)
                    with open(target, "wb") as f:
                        f.write(body)
                    captured_zip = target
                    all_captured.append(target)
                    _step(f"✓ ZIP via response: {fname} ({len(body)} bytes)")
            except Exception as e:
                _step(f"Response capture error: {e}")

        page = ctx.new_page()
        page.set_viewport_size({"width": 1600, "height": 950})
        page.on("download", _on_download)
        page.on("response", _on_response)
        ctx.on("download", _on_download)

        def _shot(name):
            try:
                page.screenshot(path=os.path.join(out_dir, name))
                _step(f"Screenshot: {name}")
            except Exception:
                pass

        try:
            # 1. Load dashboard
            _step("Loading Keka dashboard…")
            page.goto(f"https://{co}.keka.com/#/home/dashboard", timeout=40000, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            # ── Session-stale check ──────────────────────────────────────────
            # If our saved cookies are expired on Keka's side, navigation
            # redirects to app.keka.com/Account/Login. Detect and abort with
            # a clear message so user knows to re-login.
            cur_url = page.url
            if "app.keka.com/Account/Login" in cur_url or "/Account/Login" in cur_url:
                _step(
                    "✗ Keka session expired on server side — saved cookies no longer "
                    "valid. Please use 'Login to Keka' button to re-authenticate."
                )
                from services.keka_browser import clear_session_cache
                try:
                    clear_session_cache(co)
                    _step("Cleared stale session cache.")
                except Exception:
                    pass
                browser.close()
                return {
                    "xlsx_path":     None,
                    "zip_path":      None,
                    "all_files":     [],
                    "session_stale": True,
                    "error":         "Keka session expired — re-login required via 'Login to Keka' button.",
                }

            for _ in range(3):
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)

            _shot("01_dashboard.png")

            # 2. Navigate to Expense Claim Report
            # Strategy A: Direct URL (confirmed working on May 11, 2026)
            # Strategy B: Sidebar menu click fallback (robust against URL changes)
            _step("Navigating to Expense Claim Report…")

            def _is_on_report_page():
                """Return True if the Expense Claim Report page is loaded."""
                try:
                    page.wait_for_selector('button:has-text("Run")', timeout=3000)
                    return True
                except Exception:
                    pass
                # Also check page title / heading
                try:
                    heading = page.evaluate("""() => {
                        const h = document.querySelector('h1,h2,h3,[class*="title"],[class*="heading"]');
                        return h ? (h.innerText||'').trim() : '';
                    }""")
                    if "expense claim report" in heading.lower():
                        return True
                except Exception:
                    pass
                return False

            def _nav_via_url():
                """Try known direct URLs for the Expense Claim Report page."""
                _urls = [
                    f"https://{co}.keka.com/#/org/expenses/reports/expenseclaim",
                    f"https://{co}.keka.com/#/org/expense/reports/expenseclaim",
                    f"https://{co}.keka.com/#/org/expenses/reports/expenseclaims",
                    f"https://{co}.keka.com/#/org/expenses/expenseclaimreport",
                    f"https://{co}.keka.com/#/org/reports/expenseclaim",
                ]
                for _u in _urls:
                    try:
                        page.goto(_u, wait_until="domcontentloaded", timeout=15000)
                        try:
                            page.wait_for_load_state("networkidle", timeout=6000)
                        except Exception:
                            pass
                        page.wait_for_timeout(2000)
                        _cur = page.url
                        # If still on dashboard/home after navigation → this URL redirected
                        if any(x in _cur for x in ["dashboard", "/home/", "/Account/Login"]):
                            _step(f"  URL {_u} → redirected to {_cur}")
                            continue
                        if _is_on_report_page():
                            _step(f"✓ Report page via direct URL: {_u}")
                            return True
                        _step(f"  URL {_u} → landed at {_cur} (no Run button)")
                    except Exception as _ex:
                        _step(f"  URL {_u} failed: {_ex}")
                return False

            def _nav_via_menu():
                """Navigate to Expense Claim Report by clicking through Keka's sidebar."""
                # Go to the confirmed-working expense claims page first
                _step("  Fallback: navigating via menu from expense claims page…")
                try:
                    page.goto(
                        f"https://{co}.keka.com/#/org/expenses/expenseclaims/pending",
                        wait_until="domcontentloaded", timeout=15000,
                    )
                    try:
                        page.wait_for_load_state("networkidle", timeout=8000)
                    except Exception:
                        pass
                    page.wait_for_timeout(2000)
                    _step(f"  On page: {page.url}")
                except Exception as _ex:
                    _step(f"  Failed to load pending claims page: {_ex}")
                    return False

                # Dump all nav links for diagnosis
                try:
                    _nav_links = page.evaluate("""() =>
                        Array.from(document.querySelectorAll('a[href*="report"], a[routerLink*="report"], [href*="report"]'))
                            .filter(e => e.offsetParent)
                            .map(e => ({href: e.href||e.getAttribute('routerLink')||'',
                                        text: (e.innerText||'').trim().substring(0,60)}))
                    """)
                    _step(f"  Report links found: {_nav_links}")
                except Exception:
                    pass

                # Try clicking any visible "Reports" tab or link on the page
                for _txt in ["Reports", "Report", "Expense Claim Report"]:
                    try:
                        loc = page.locator(
                            f'a:has-text("{_txt}"), button:has-text("{_txt}"), '
                            f'span:has-text("{_txt}"), li:has-text("{_txt}")'
                        ).first
                        if loc.is_visible(timeout=2000):
                            loc.click()
                            page.wait_for_timeout(2000)
                            if _is_on_report_page():
                                _step(f"✓ Report page via menu click: '{_txt}'")
                                return True
                    except Exception:
                        pass

                # JS fallback: click any element mentioning 'report'
                try:
                    _bbox = page.evaluate("""() => {
                        const kw = ['expense claim report', 'reports'];
                        const el = Array.from(document.querySelectorAll('a,button,span,li,div'))
                            .find(e => {
                                if (!e.offsetParent) return false;
                                const t = (e.innerText||e.textContent||'').trim().toLowerCase();
                                return kw.some(k => t === k || t.startsWith(k));
                            });
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return {x: r.left+r.width/2, y: r.top+r.height/2};
                    }""")
                    if _bbox:
                        page.mouse.click(_bbox['x'], _bbox['y'])
                        page.wait_for_timeout(2000)
                        if _is_on_report_page():
                            _step("✓ Report page via JS menu click")
                            return True
                except Exception:
                    pass

                return False

            # Run strategies
            _run_btn_found = _nav_via_url() or _nav_via_menu()

            if not _run_btn_found:
                _step(f"WARNING: Could not load Expense Claim Report page (url: {page.url})")
                # Dump nav links for future debugging
                try:
                    _all_links = page.evaluate("""() =>
                        Array.from(document.querySelectorAll('a[href]'))
                            .filter(e => e.offsetParent)
                            .map(e => e.href).filter(Boolean)
                    """)
                    _step(f"All links on page: {_all_links[:20]}")
                except Exception:
                    pass

            _shot("02_report_page.png")

            # Save page HTML for debugging (full dump to diagnose DOM structure)
            try:
                html = page.content()
                with open(os.path.join(out_dir, "page_dump.html"), "w", encoding="utf-8") as f:
                    f.write(html)
                _step(f"HTML dump saved → page_dump.html ({len(html)} chars)")
            except Exception as ex:
                _step(f"HTML dump error: {ex}")

            # 3. Set date range
            _step(f"Setting date range: {from_date} → {to_date}…")
            _keka_set_date_range(page, from_dt, to_dt, _step, out_dir)

            _shot("03_after_dates.png")

            # 4. Set Status → In Approval Process
            _step("Setting Status → In Approval Process…")
            _keka_set_status_filter(page, _step, out_dir)

            _shot("04_after_status.png")

            # 5. Click Run — try toolbar button first, then JS fallback
            _step("Clicking Run…")
            run_clicked = False

            # Log all visible buttons to help diagnose
            try:
                vis_btns = page.evaluate("""() => Array.from(document.querySelectorAll('button'))
                    .filter(e => e.offsetParent !== null)
                    .map(e => (e.innerText||'').replace(/\\s+/g,' ').trim().substring(0,40))
                    .filter(t => t)""")
                _step(f"Visible buttons before Run: {vis_btns}")
            except Exception:
                pass

            for run_sel in [
                'button:has-text("Run")',
                'input[value="Run"]',
                '[class*="run-btn"]',
                '[class*="runBtn"]',
            ]:
                try:
                    btn = page.wait_for_selector(run_sel, state="visible", timeout=5000)
                    if btn:
                        btn.scroll_into_view_if_needed()
                        btn.click()
                        run_clicked = True
                        _step("✓ Run clicked — waiting for results…")
                        break
                except Exception as ex:
                    _step(f"Run selector '{run_sel}' failed: {ex}")

            if not run_clicked:
                _step("⚠ Run button not found via selector — trying JS click")
                page.evaluate("""() => {
                    const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
                        .find(e => (e.innerText||e.value||'').replace(/\\s+/g,' ').trim().toLowerCase() === 'run'
                                   && e.offsetParent !== null);
                    if (btn) { btn.click(); return true; }
                    return false;
                }""")

            # Wait for results table to appear after Run, fallback 4s
            try:
                page.wait_for_selector('table, [class*="grid"], [class*="table"], [class*="result"]', timeout=20000)
            except Exception:
                pass
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

            _shot("05_after_run.png")

            # 6. Click "Download" button (top-right of results table) via native mouse click
            _step("Looking for Download button…")
            excel_clicked = False

            dl_bbox = page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .filter(e => e.offsetParent !== null &&
                        (e.innerText||'').replace(/\\s+/g,' ').trim() === 'Download');
                if (!btns[0]) return null;
                const r = btns[0].getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2};
            }""")
            if dl_bbox:
                page.mouse.click(dl_bbox['x'], dl_bbox['y'])
                _step("✓ Download button clicked — checking for dropdown…")
                page.wait_for_timeout(800)  # wait for dropdown to open

                # "Download" opens a dropdown; look for "Download Excel" inside it
                excel_dl_bbox = page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll(
                        'button, a, [role="button"], li, .dropdown-item, [role="menuitem"]'))
                        .filter(e => e.offsetParent !== null &&
                            (e.innerText||'').replace(/\\s+/g,' ').trim() === 'Download Excel');
                    if (!btns[0]) return null;
                    const r = btns[0].getBoundingClientRect();
                    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
                }""")
                if excel_dl_bbox:
                    page.mouse.click(excel_dl_bbox['x'], excel_dl_bbox['y'])
                    _step("✓ Download Excel option clicked — waiting for export banner…")
                    page.wait_for_timeout(1500)
                else:
                    _step("⚠ Download Excel dropdown not found — will look for click-here banner")

                # Keka export is async: it queues the job then shows "click here" banner
                for _ in range(8):
                    try:
                        link = page.locator(
                            'a:has-text("click here"), a:has-text("Click here")'
                        ).first
                        if link.is_visible(timeout=1500):
                            link.click()
                            excel_clicked = True
                            _step("✓ Excel 'click here' banner clicked")
                            page.wait_for_timeout(1500)
                            break
                    except Exception:
                        pass
                    page.wait_for_timeout(1200)

                if not excel_clicked:
                    excel_clicked = True
                    _step("⚠ No click-here banner found — download may have been direct")
            else:
                _step("⚠ Download button not found")

            _shot("06_after_excel_click.png")

            # 7. Select all rows (enables Bulk download receipts), then click it
            # Log visible buttons for diagnostics
            try:
                all_btns = page.evaluate("""() => Array.from(document.querySelectorAll('button, a'))
                    .filter(e => e.offsetParent !== null)
                    .map(e => (e.innerText||e.textContent||e.href||'').replace(/\\s+/g,' ').trim().substring(0,50))
                    .filter(t => t)""")
                _step(f"All visible buttons/links before Bulk download: {all_btns}")
            except Exception:
                pass

            _step("Selecting all rows via header checkbox…")
            sel_all_bbox = page.evaluate("""() => {
                // Header checkbox (Select All)
                const th = document.querySelector(
                    'thead input[type="checkbox"], th input[type="checkbox"]');
                if (th && th.offsetParent) {
                    const r = th.getBoundingClientRect();
                    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
                }
                // Fallback: first visible checkbox on page
                const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
                    .find(e => e.offsetParent !== null);
                if (!cb) return null;
                const r = cb.getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2};
            }""")
            if sel_all_bbox:
                page.mouse.click(sel_all_bbox['x'], sel_all_bbox['y'])
                _step("✓ Select All checkbox clicked (native)")
                page.wait_for_timeout(800)
            else:
                _step("⚠ Select All checkbox not found")

            _step("Looking for Bulk download receipts button…")
            bulk_clicked = False

            bulk_bbox = page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'))
                    .filter(e => e.offsetParent !== null);
                const btn = btns.find(e =>
                    (e.innerText||'').replace(/\\s+/g,' ').trim().toLowerCase() === 'bulk download receipts'
                ) || btns.find(e =>
                    (e.innerText||'').replace(/\\s+/g,' ').trim().toLowerCase().includes('bulk download')
                );
                if (!btn) return null;
                const r = btn.getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2};
            }""")
            if bulk_bbox:
                page.mouse.click(bulk_bbox['x'], bulk_bbox['y'])
                bulk_clicked = True
                _step("✓ Bulk download receipts clicked (native)")
                # Wait for confirmation modal ("Download Expense Receipts") to appear
                page.wait_for_timeout(1000)
                _shot("07a_modal_appeared.png")

                # Click "Download" inside the modal — it's the last visible Download button
                modal_dl_bbox = page.evaluate("""() => {
                    // Try known modal selectors first
                    for (const sel of [
                        '.modal button', '[role="dialog"] button',
                        '.modal-content button', '[class*="modal"] button',
                        'keka-modal button', 'kekaui-modal button',
                    ]) {
                        const btns = Array.from(document.querySelectorAll(sel))
                            .filter(e => e.offsetParent !== null &&
                                (e.innerText||'').replace(/\\s+/g,' ').trim() === 'Download');
                        if (btns[0]) {
                            const r = btns[0].getBoundingClientRect();
                            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
                        }
                    }
                    // Fallback: last visible "Download" button (modal floats on top)
                    const allDl = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                        .filter(e => e.offsetParent !== null &&
                            (e.innerText||'').replace(/\\s+/g,' ').trim() === 'Download');
                    const btn = allDl[allDl.length - 1];
                    if (!btn) return null;
                    const r = btn.getBoundingClientRect();
                    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
                }""")
                if modal_dl_bbox:
                    page.mouse.click(modal_dl_bbox['x'], modal_dl_bbox['y'])
                    _step("✓ Modal Download button clicked (native)")
                    page.wait_for_timeout(1500)
                else:
                    _step("⚠ Modal Download button not found")
            else:
                _step("⚠ Bulk download receipts button not found — check screenshots")

            _shot("07_after_bulk_click.png")

            # 8. Wait for downloads (3 min max)
            _step("Waiting for downloads…")
            deadline = time.time() + 180
            while time.time() < deadline:
                if captured_xlsx and captured_zip:
                    _step("✓ Both files downloaded!")
                    page.wait_for_timeout(3000)  # allow pending download events to flush
                    break
                page.wait_for_timeout(1000)

            if not (captured_xlsx and captured_zip):
                missing = [x for x, v in [("Excel", captured_xlsx), ("ZIP", captured_zip)] if not v]
                _step(f"⚠ Downloads incomplete — missing: {', '.join(missing)}")

            _shot("08_final.png")

            # Save fresh session
            try:
                fresh = ctx.storage_state()
                cached = _session_cache.get(co)
                if cached:
                    cached["storage_state"] = fresh
                    _save_session_to_disk()
            except Exception:
                pass

        except Exception as e:
            _step(f"Automation error: {e}")
            import traceback as _tb
            log.error("Traceback: %s", _tb.format_exc())
            try:
                page.screenshot(path=os.path.join(out_dir, "error.png"))
            except Exception:
                pass
        finally:
            try:
                browser.close()
            except Exception:
                pass

    return {
        "xlsx_path": captured_xlsx,
        "zip_path":  captured_zip,
        "all_files": all_captured,
    }


def _date_to_keka_format(date_str: str) -> str:
    """Convert YYYY-MM-DD → DD-Mon-YYYY (e.g. 2026-04-01 → 01-Apr-2026)."""
    from datetime import datetime as _dt
    try:
        d = _dt.strptime(date_str, "%Y-%m-%d")
        return d.strftime("%d-%b-%Y")
    except Exception:
        return date_str


def download_bulk_receipts_via_ui(
    from_date: str,
    to_date: str,
    out_dir: str,
    company: Optional[str] = None,
    on_step=None,
) -> Optional[str]:
    """
    Automate the Keka UI flow:
      Org → Expense and Travel → Reports → Expense Claim
      → Set Submitted On Date range
      → Click Run
      → Click Bulk Receipt download
      → Save downloaded zip to out_dir/keka_bulk_receipts.zip

    Returns absolute path to the saved file, or None on failure.
    """
    from playwright.sync_api import sync_playwright
    from services.keka_browser import (
        is_authenticated, _new_authenticated_context, _save_session_to_disk,
        _session_cache, KEKA_COMPANY_NAME,
    )

    def _step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    if not is_authenticated():
        _step("Not authenticated to Keka — login first")
        return None

    co = company or KEKA_COMPANY_NAME
    os.makedirs(out_dir, exist_ok=True)

    saved_path: Optional[str] = None

    with sync_playwright() as p:
        browser, ctx = _new_authenticated_context(p, co)
        ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
            status=200, content_type="application/javascript",
            body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};"
        ))
        page = ctx.new_page()
        page.set_viewport_size({"width": 1600, "height": 1000})

        # 1. Init SPA
        _step("Loading Keka dashboard…")
        page.goto(f"https://{co}.keka.com/#/home/dashboard", wait_until="domcontentloaded", timeout=30000)
        try:
            page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:
            pass
        page.wait_for_timeout(1500)

        # 2. Navigate to Expense Claim report
        # NOTE: window.location.hash via evaluate() does NOT trigger Angular routing.
        _step("Navigating to Expense Claim Report…")
        _REPORT_URLS_UI = [
            f"https://{co}.keka.com/#/org/expenses/reports/expenseclaim",
            f"https://{co}.keka.com/#/org/expenses/reports/expenseclaims",
            f"https://{co}.keka.com/#/org/reports/expenseclaim",
        ]
        _run_btn_found_ui = False
        for _rurl_ui in _REPORT_URLS_UI:
            try:
                page.goto(_rurl_ui, wait_until="domcontentloaded", timeout=20000)
                try:
                    page.wait_for_load_state("networkidle", timeout=8000)
                except Exception:
                    pass
                page.wait_for_timeout(2500)
                try:
                    page.wait_for_selector('button:has-text("Run"), [class*="run-btn"]', timeout=6000)
                    _run_btn_found_ui = True
                    _step(f"✓ Report page loaded: {_rurl_ui} (url: {page.url})")
                    break
                except Exception:
                    _step(f"Run button not found at {_rurl_ui} — url: {page.url}")
            except Exception as _ex_ui:
                _step(f"Navigation to {_rurl_ui} failed: {_ex_ui}")

        if not _run_btn_found_ui:
            _step(f"Failed to reach report page (url: {page.url})")
            browser.close()
            return None

        # Pre-emptive: dismiss any popups (Esc multiple times)
        try:
            for _ in range(3):
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)
            page.mouse.click(900, 50)
            page.wait_for_timeout(500)
        except Exception:
            pass

        # 3. Click "Submitted On Date" calendar icon
        _step("Opening date picker…")
        try:
            page.evaluate("""
                () => {
                    const labels = Array.from(document.querySelectorAll('*')).filter(e =>
                        (e.innerText || '').trim() === 'Submitted On Date'
                    );
                    for (const lbl of labels) {
                        let parent = lbl;
                        for (let i = 0; i < 4; i++) {
                            if (!parent) break;
                            const icon = parent.querySelector('[class*="calendar"], [class*="date"], i, button');
                            if (icon) { icon.click(); return; }
                            parent = parent.parentElement;
                        }
                    }
                }
            """)
            page.wait_for_timeout(2000)
        except Exception as e:
            _step(f"Open picker error: {e}")

        # 4. Navigate calendar to From-month, click From-date, then To-date
        from datetime import datetime as _dt
        try:
            from_dt = _dt.strptime(from_date, "%Y-%m-%d")
            to_dt   = _dt.strptime(to_date,   "%Y-%m-%d")
            from_month_label = from_dt.strftime("%B")  # "April"
            from_year        = from_dt.year
            to_month_label   = to_dt.strftime("%B")
            to_year          = to_dt.year

            _step(f"Navigating calendar to {from_month_label} {from_year}…")

            # Read currently displayed month from calendar header
            def _get_visible_months():
                try:
                    return page.evaluate("""
                        () => {
                            const cells = Array.from(document.querySelectorAll('*'));
                            const monthRegex = /^(January|February|March|April|May|June|July|August|September|October|November|December)$/;
                            const out = [];
                            for (const c of cells) {
                                const txt = (c.innerText || '').trim();
                                if (monthRegex.test(txt) && c.children.length === 0) {
                                    // Find sibling year
                                    const parent = c.parentElement;
                                    const yearEl = parent ? Array.from(parent.children).find(s => /^\\d{4}$/.test((s.innerText || '').trim())) : null;
                                    if (yearEl) out.push({month: txt, year: parseInt(yearEl.innerText.trim())});
                                }
                            }
                            return out;
                        }
                    """)
                except Exception:
                    return []

            # Click "<" prev arrow until from_month is visible
            for _ in range(36):  # max 3 years back
                visible = _get_visible_months()
                if any(m["month"] == from_month_label and m["year"] == from_year for m in visible):
                    break
                # Click prev arrow (< symbol)
                clicked = page.evaluate("""
                    () => {
                        const arrows = Array.from(document.querySelectorAll('button, a, span, i, [class*="prev"], [class*="left"], [class*="back"]'));
                        for (const a of arrows) {
                            const txt = (a.innerText || '').trim();
                            const cls = (a.className || '').toString().toLowerCase();
                            if (txt === '<' || txt === '‹' || txt === '◀' ||
                                cls.includes('prev') || cls.includes('left') || cls.includes('back') ||
                                a.getAttribute('aria-label') === 'Previous') {
                                if (a.offsetParent !== null) { a.click(); return true; }
                            }
                        }
                        return false;
                    }
                """)
                if not clicked:
                    break
                page.wait_for_timeout(400)

            # Click on the from-date number (matching the visible month)
            _step(f"Clicking From={from_dt.day} in {from_month_label}…")
            page.evaluate(f"""
                () => {{
                    // Find day cells
                    const cells = Array.from(document.querySelectorAll('td, button, span, div'))
                        .filter(e => {{
                            const t = (e.innerText || '').trim();
                            return t === '{from_dt.day}' && e.offsetParent !== null && !e.classList.toString().includes('disabled');
                        }});
                    // Pick the first non-greyed-out match
                    for (const c of cells) {{
                        const style = getComputedStyle(c);
                        if (parseFloat(style.opacity) > 0.5 && !style.color.includes('rgb(204')) {{
                            c.click();
                            return;
                        }}
                    }}
                    if (cells.length) cells[0].click();
                }}
            """)
            page.wait_for_timeout(1000)

            # Now navigate forward if to-date is in a different month
            for _ in range(12):
                visible = _get_visible_months()
                if any(m["month"] == to_month_label and m["year"] == to_year for m in visible):
                    break
                clicked = page.evaluate("""
                    () => {
                        const arrows = Array.from(document.querySelectorAll('button, a, span, i'));
                        for (const a of arrows) {
                            const txt = (a.innerText || '').trim();
                            const cls = (a.className || '').toString().toLowerCase();
                            if (txt === '>' || txt === '›' || txt === '▶' ||
                                cls.includes('next') || cls.includes('right') ||
                                a.getAttribute('aria-label') === 'Next') {
                                if (a.offsetParent !== null) { a.click(); return true; }
                            }
                        }
                        return false;
                    }
                """)
                if not clicked:
                    break
                page.wait_for_timeout(400)

            _step(f"Clicking To={to_dt.day} in {to_month_label}…")
            page.evaluate(f"""
                () => {{
                    const cells = Array.from(document.querySelectorAll('td, button, span, div'))
                        .filter(e => {{
                            const t = (e.innerText || '').trim();
                            return t === '{to_dt.day}' && e.offsetParent !== null && !e.classList.toString().includes('disabled');
                        }});
                    for (const c of cells) {{
                        const style = getComputedStyle(c);
                        if (parseFloat(style.opacity) > 0.5 && !style.color.includes('rgb(204')) {{
                            c.click();
                            return;
                        }}
                    }}
                    if (cells.length) cells[0].click();
                }}
            """)
            page.wait_for_timeout(1500)

            # Click outside the picker to commit (calendar usually auto-closes after 2 clicks)
            page.mouse.click(800, 600)
            page.wait_for_timeout(1000)
        except Exception as e:
            _step(f"Calendar navigation error: {e}")

        # 4. Click "Run"
        _step("Clicking Run…")
        try:
            run_btn = page.wait_for_selector('button:has-text("Run"):visible', timeout=10000)
            run_btn.click()
            try:
                page.wait_for_selector('table, [class*="grid"], [class*="result"]', timeout=15000)
            except Exception:
                pass
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(2000)
        except Exception as e:
            _step(f"Run click error: {e}")

        # Take screenshot to verify state
        try:
            shot = os.path.join(out_dir, "after_run.png")
            page.screenshot(path=shot, full_page=False)
            _step(f"Saved screenshot: {shot}")
        except Exception:
            pass

        # 5. Find and click "Bulk Receipt" / "Download" button
        _step("Looking for Bulk Receipt download…")
        download_clicked = False

        # Listen for download events
        download_event = None
        def _on_download(d):
            nonlocal download_event, saved_path
            try:
                fname = d.suggested_filename or "keka_bulk_receipts.zip"
                target = os.path.join(out_dir, fname)
                d.save_as(target)
                saved_path = target
                download_event = fname
                _step(f"✓ Downloaded: {fname}")
            except Exception as e:
                _step(f"Download save error: {e}")

        page.on("download", _on_download)

        # Try every plausible button text
        for sel_text in [
            "Bulk Receipt", "Bulk Receipts", "Download Receipts", "Download Bills",
            "Download Bulk", "Download All", "Bulk Download",
        ]:
            if download_clicked:
                break
            for sel in [
                f'button:has-text("{sel_text}")',
                f'a:has-text("{sel_text}")',
                f'[role="button"]:has-text("{sel_text}")',
            ]:
                try:
                    btn = page.query_selector(sel)
                    if btn and btn.is_visible():
                        btn.click(timeout=3000)
                        download_clicked = True
                        _step(f"Clicked: {sel_text}")
                        break
                except Exception:
                    pass

        # If not found, try opening the Save/Export dropdown
        if not download_clicked:
            _step("Bulk Receipt button not directly visible — trying Save/Export dropdown…")
            for sel in [
                'button:has-text("Save"):visible',
                'button:has-text("Export"):visible',
                'button:has-text("Download"):visible',
                '[class*="dropdown"] button:visible',
            ]:
                try:
                    btn = page.query_selector(sel)
                    if btn:
                        btn.click(timeout=2000)
                        page.wait_for_timeout(1500)
                        # Now look in dropdown
                        for txt in ("Bulk Receipt", "Receipts", "Bills", "Download Receipts"):
                            opt = page.query_selector(f'text="{txt}"')
                            if opt and opt.is_visible():
                                opt.click(timeout=2000)
                                download_clicked = True
                                _step(f"Found in dropdown: {txt}")
                                break
                        if download_clicked:
                            break
                except Exception:
                    pass

        # Wait for the download to start + complete
        if download_clicked:
            for _ in range(120):  # up to 2 minutes
                if saved_path:
                    break
                page.wait_for_timeout(1000)

        # Final screenshot
        try:
            shot2 = os.path.join(out_dir, "after_download.png")
            page.screenshot(path=shot2, full_page=False)
        except Exception:
            pass

        # Save fresh session
        try:
            fresh_storage = ctx.storage_state()
            cached = _session_cache.get(co)
            if cached:
                cached["storage_state"] = fresh_storage
                _save_session_to_disk()
        except Exception:
            pass

        browser.close()

    if saved_path and os.path.exists(saved_path):
        _step(f"✓ Bulk receipts saved: {saved_path} ({os.path.getsize(saved_path):,} bytes)")
        return saved_path

    _step("✗ Bulk receipt download failed — see screenshots for diagnosis")
    return None


# ── Step 2: Download bills via every known endpoint ───────────────────────────

def _try_download_attachment(token: str, claim_id: str, att: dict, company: str) -> Optional[bytes]:
    """Try every documented + undocumented Keka attachment endpoint."""
    co = company or os.environ.get("KEKA_COMPANY_NAME", "omniainformation")
    base = f"https://{co}.keka.com"
    att_id = str(att.get("id") or att.get("attachmentId") or "")
    if not att_id:
        return None

    hdrs_oauth = {
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0",
        "Origin": base,
        "Referer": f"{base}/",
    }

    # Add session cookies if available
    hdrs_session = dict(hdrs_oauth)
    try:
        from services.keka_browser import _get_session_cookies, _cookies_to_header
        cookies = _get_session_cookies(co)
        hdrs_session["Cookie"] = _cookies_to_header(cookies)
    except Exception:
        pass

    candidate_urls = [
        # OAuth-documented endpoints
        f"{base}/api/v1/expense/claims/{claim_id}/attachments/{att_id}/download",
        f"{base}/api/v1/expense/claims/{claim_id}/attachments/{att_id}",
        f"{base}/api/v1/expense/attachments/{att_id}/download",
        f"{base}/api/v1/expense/attachments/{att_id}",
        f"{base}/api/v1/payloads/filedownload?identifier={att_id}",
        f"{base}/api/v1/payloads/filedownload/{att_id}",
        # Internal proxy endpoints
        f"{base}/files/{att_id}",
        f"{base}/documents/{att_id}",
    ]

    for url in candidate_urls:
        for label, hdrs in [("oauth", hdrs_oauth), ("session", hdrs_session)]:
            try:
                r = requests.get(url, headers=hdrs, timeout=30, allow_redirects=True)
                if r.status_code == 200 and len(r.content) > 100:
                    ct = r.headers.get("Content-Type", "").lower()
                    if not any(x in ct for x in ("html", "json", "xml", "text/plain")):
                        log.info("✓ Downloaded att=%s via %s [%s] (%d bytes)",
                                 att_id[:8], url[len(base):][:40], label, len(r.content))
                        return r.content
                    if "json" in ct:
                        # Maybe response has a downloadUrl field
                        try:
                            d = r.json()
                            dl = (d.get("downloadUrl") or d.get("url") or d.get("fileUrl") or
                                  (d.get("data") or {}).get("downloadUrl"))
                            if dl:
                                r2 = requests.get(dl, timeout=30, allow_redirects=True)
                                if r2.status_code == 200 and len(r2.content) > 100:
                                    return r2.content
                        except Exception:
                            pass
            except Exception as e:
                log.debug("URL %s [%s]: %s", url[:60], label, e)

    return None


def download_bills_to_folder(
    claims: list[dict],
    bills_dir: str,
    company: Optional[str] = None,
    on_progress=None,
) -> dict:
    """
    Download every attachment for every claim into bills_dir/{claim_id}/{filename}.
    Returns a mapping {claim_id: [saved_paths]}.
    """
    from services.keka import get_keka_token

    token = get_keka_token()
    saved: dict[str, list[str]] = {}

    # Build flat task list
    tasks = []
    for c in claims:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        for exp in (c.get("expenses") or [{}]):
            for att in (exp.get("attachments") or []):
                if att.get("id"):
                    tasks.append((cid, att))

    total = len(tasks)
    log.info("Attempting to download %d attachments for %d claims", total, len(claims))

    if not tasks:
        return saved

    completed = 0
    co = company or os.environ.get("KEKA_COMPANY_NAME", "omniainformation")

    def _worker(task):
        cid, att = task
        data = _try_download_attachment(token, cid, att, co)
        return cid, att, data

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(_worker, t) for t in tasks]
        for fut in as_completed(futures):
            completed += 1
            try:
                cid, att, data = fut.result()
            except Exception as e:
                log.warning("Worker failed: %s", e)
                continue

            if on_progress:
                on_progress(completed, total)

            if not data:
                continue

            fname = att.get("name") or f"{att.get('id','attachment')}"
            # Ensure extension
            if not any(fname.lower().endswith(ext) for ext in (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp")):
                fname += ".pdf"

            claim_dir = os.path.join(bills_dir, cid)
            os.makedirs(claim_dir, exist_ok=True)
            fpath = os.path.join(claim_dir, fname)
            if os.path.exists(fpath):
                base_n, ext = os.path.splitext(fname)
                fpath = os.path.join(claim_dir, f"{base_n}_{att.get('id','')[:6]}{ext}")
            with open(fpath, "wb") as f:
                f.write(data)
            saved.setdefault(cid, []).append(fpath)

    n_saved = sum(len(v) for v in saved.values())
    log.info("Downloaded %d / %d attachments to %s", n_saved, total, bills_dir)
    return saved


# ── Step 3: Zip bills folder ─────────────────────────────────────────────────

def fetch_all_pending_via_spa(company: Optional[str] = None, max_pages: int = 10) -> list[dict]:
    """
    Fetch ALL pending claims via Keka SPA endpoint.
    Returns a list of claim dicts (numeric ids, full metadata).
    Used as a metadata lookup pool when bills.zip drives the claim list.
    """
    from services.keka_browser import (
        _get_session_cookies, _cookies_to_header, get_spa_access_token,
        KEKA_COMPANY_NAME,
    )
    co = company or KEKA_COMPANY_NAME
    base = f"https://{co}.keka.com"

    try:
        cookies = _get_session_cookies(co)
        spa_token = get_spa_access_token(co) or ""
    except Exception:
        return []
    if not spa_token:
        return []

    hdrs = {
        "Authorization": f"Bearer {spa_token}",
        "Accept":        "application/json",
        "Cookie":        _cookies_to_header(cookies),
        "User-Agent":    "Mozilla/5.0",
        "Referer":       f"{base}/",
        "Origin":        base,
    }

    all_claims: list[dict] = []
    seen_ids: set = set()
    for url in (
        f"{base}/k/default/api/expense/claims/pending",
        f"{base}/k/default/api/expense/claims",
    ):
        for page in range(1, max_pages + 1):
            try:
                r = requests.get(
                    url,
                    params={"pageNumber": page, "pageSize": 500},
                    headers=hdrs, timeout=20,
                )
                if r.status_code != 200:
                    break
                data = r.json().get("data") or []
                if not data:
                    break
                added = 0
                for c in data:
                    cid = c.get("id")
                    if cid and cid not in seen_ids:
                        seen_ids.add(cid)
                        all_claims.append(c)
                        added += 1
                if added == 0 or len(data) < 500:
                    break
            except Exception as e:
                log.warning("SPA pool fetch %s page %d: %s", url, page, e)
                break
    log.info("SPA metadata pool: %d unique claims", len(all_claims))
    return all_claims


def build_claims_from_bills_zip(
    bills_dir: str,
    excel_path: str,
    company: Optional[str] = None,
    on_step=None,
) -> tuple[list[dict], list[dict]]:
    """
    Read bills folder structure and build the claim list from folder names.
    Each subfolder name like "2293_Late Night Expense" becomes one claim.
    Looks up extra metadata (employee, amount) via SPA + OAuth APIs.

    Returns (synthesized_claims, excel_rows).
    """
    import re as _re
    import pandas as pd
    from services.keka import get_keka_token, fetch_expense_claims

    def _step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    if not os.path.isdir(bills_dir):
        return [], []

    # 1. Read folder names from bills_dir
    folders = []
    for entry in sorted(os.listdir(bills_dir)):
        full = os.path.join(bills_dir, entry)
        if not os.path.isdir(full):
            continue
        # Count files in folder
        files = []
        for root, _, fs in os.walk(full):
            files.extend(fs)
        folders.append({
            "folder_name": entry,
            "file_count":  len(files),
            "files":       files[:20],  # sample
        })

    if not folders:
        return [], []

    _step(f"Found {len(folders)} claim folders in bills.zip")

    # 2. Build metadata lookup pool from SPA + OAuth
    spa_pool = fetch_all_pending_via_spa(company=company)
    spa_by_number: dict = {}
    for c in spa_pool:
        cn = str(c.get("claimNumber") or "").strip()
        if cn:
            spa_by_number[cn] = c

    # Also try OAuth API
    oauth_by_number: dict = {}
    try:
        token = get_keka_token()
        # Fetch a wide range — we'll match by claim_number
        oauth_claims = fetch_expense_claims(
            token,
            from_date="2024-01-01",
            to_date="2030-12-31",
            company=company,
        )
        for c in oauth_claims:
            cn = str(c.get("claimNumber") or c.get("claimNo") or "").strip()
            if cn:
                oauth_by_number[cn] = c
        _step(f"OAuth pool: {len(oauth_by_number)} claims by number")
    except Exception as e:
        _step(f"OAuth fetch failed: {e}")

    # 3. Build synthesized claim list from folders
    synthesized: list[dict] = []
    rows: list[dict] = []

    for f in folders:
        fname = f["folder_name"]
        # Parse "2293_Late Night Expense" → number=2293, title="Late Night Expense"
        m = _re.match(r"^(\d+)[_\-\s](.*)$", fname)
        cnum = m.group(1) if m else fname
        title = (m.group(2) if m else "").strip()

        # Lookup metadata in pools
        meta = spa_by_number.get(cnum) or oauth_by_number.get(cnum) or {}

        # Extract fields
        employee_name = meta.get("employeeName", "")
        employee_id   = meta.get("employeeNumber") or meta.get("employeeIdentifier", "")
        employee_email = meta.get("employeeEmail", "")
        claim_id      = str(meta.get("id", ""))
        submitted     = (meta.get("submittedOn") or meta.get("submittedDate") or "")[:10]
        amount        = meta.get("totalAmount") or meta.get("claimedAmount") or 0
        if isinstance(amount, str):
            am = _re.search(r"[\d,]+\.?\d*", amount)
            amount = float(am.group(0).replace(",", "")) if am else 0
        currency      = meta.get("currency", "INR")
        if isinstance(currency, dict):
            currency = currency.get("code", "INR")
        waiting_on    = (meta.get("waitingOnEmployees") or meta.get("payoutApproverWaitingOnEmployees")
                        or meta.get("waitingOn", ""))

        # Aggregate sub-categories from expense items
        sub_categories: set = set()
        descriptions: list = []
        for exp in (meta.get("expenses") or []):
            for cf in (exp.get("customFields") or []):
                if isinstance(cf, dict) and cf.get("value"):
                    sub_categories.add(str(cf["value"]).strip())
            d = exp.get("comment") or exp.get("description") or exp.get("title") or ""
            if d and d not in descriptions:
                descriptions.append(d)

        synthesized.append({
            **meta,
            "_folder":      fname,
            "_file_count":  f["file_count"],
            "_synthesized": meta == {},
        })

        rows.append({
            "Claim Number":      cnum,
            "Claim ID":          claim_id,
            "Employee Number":   employee_id,
            "Employee Name":     employee_name or "(unknown — folder: " + fname + ")",
            "Employee Email":    employee_email,
            "Submitted On":      submitted,
            "Expense Date":      submitted,
            "Expense Title":     title or meta.get("title", ""),
            "Sub Category":      "; ".join(sorted(sub_categories)),
            "Description":       " | ".join(descriptions[:3]) if descriptions else (title or fname),
            "Total Amount":      f"{float(amount):.2f} {currency}",
            "Claimed Amount":    round(float(amount), 2),
            "Currency":          currency,
            "Expense Items":     len(meta.get("expenses") or []),
            "Attachment Name":   "; ".join(f["files"][:8]),
            "Attachment Count":  f["file_count"],
            "Folder Name":       fname,
            "Metadata Source":   "SPA" if meta and cnum in spa_by_number else
                                 "OAuth" if meta and cnum in oauth_by_number else
                                 "FOLDER ONLY",
            "Waiting On":        waiting_on,
        })

    # 4. Save Excel
    df = pd.DataFrame(rows)
    df.to_excel(excel_path, index=False, engine="openpyxl")
    matched_meta = sum(1 for r in rows if r["Metadata Source"] != "FOLDER ONLY")
    _step(f"Built Excel from bills.zip: {len(rows)} claims ({matched_meta} with metadata, {len(rows)-matched_meta} folder-only)")

    return synthesized, rows


def normalize_bills_to_claim_id(
    bills_dir: str,
    claims: list[dict],
    on_step=None,
) -> dict:
    """
    After extracting Keka's bulk-receipt zip, the folders are named using
    Keka's UI convention `{ClaimNumber}_{Title}` (e.g. `2186_Petty cash`).
    This is NOT unique across companies — claim_number can be reused.

    Rename every folder to the claim's unique UUID (`keka_claim_id`) so
    matching downstream uses the unique identifier.

    Returns: { renamed: int, unmatched: list[str] }
    """
    import re as _re
    import shutil as _sh

    def _step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    if not os.path.isdir(bills_dir):
        return {"renamed": 0, "unmatched": []}

    # Build lookup: claim_number → claim_id, also title-prefix → claim_id
    by_number = {}
    by_title  = {}
    for c in claims:
        cid = str(c.get("id") or c.get("claimId") or "")
        cnum = str(c.get("claimNumber") or c.get("claimNo") or "").strip()
        title = (c.get("title") or "").strip().lower()
        if cid and cnum:
            by_number[cnum] = cid
        if cid and title:
            # Use first 30 chars of title for fuzzy lookup
            by_title[title[:30]] = cid

    renamed = 0
    unmatched = []

    for entry in list(os.listdir(bills_dir)):
        full_path = os.path.join(bills_dir, entry)
        if not os.path.isdir(full_path):
            continue

        # Already a UUID? skip
        if _re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", entry, _re.IGNORECASE):
            continue

        # Try splitting "{number}_{title}" and look up
        target_cid = None
        m = _re.match(r"^(\d+)[_\-\s](.*)$", entry)
        if m:
            num, _title = m.group(1), m.group(2)
            target_cid = by_number.get(num)

        # Fallback: try whole-folder fuzzy match on title
        if not target_cid:
            entry_lower = entry.lower().replace("_", " ").strip()
            for title_key, cid_val in by_title.items():
                if entry_lower.startswith(title_key) or title_key in entry_lower:
                    target_cid = cid_val
                    break

        if target_cid:
            new_path = os.path.join(bills_dir, target_cid)
            try:
                if os.path.exists(new_path):
                    # Merge contents into existing claim_id folder
                    for fn in os.listdir(full_path):
                        src = os.path.join(full_path, fn)
                        dst = os.path.join(new_path, fn)
                        if os.path.exists(dst):
                            base, ext = os.path.splitext(fn)
                            dst = os.path.join(new_path, f"{base}_dup{ext}")
                        _sh.move(src, dst)
                    _sh.rmtree(full_path)
                else:
                    os.rename(full_path, new_path)
                renamed += 1
            except Exception as e:
                _step(f"Rename failed for {entry}: {e}")
                unmatched.append(entry)
        else:
            unmatched.append(entry)

    if renamed:
        _step(f"Renamed {renamed} bill folder(s) to claim_id UUIDs")
    if unmatched:
        _step(f"⚠ {len(unmatched)} folder(s) could not be matched to a claim_id: {unmatched[:5]}")
    return {"renamed": renamed, "unmatched": unmatched}


def zip_bills_folder(bills_dir: str, zip_path: str) -> int:
    """Zip bills_dir into zip_path, preserving the {claim_id}/{file} structure."""
    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(bills_dir):
            for f in files:
                full = os.path.join(root, f)
                arc  = os.path.relpath(full, bills_dir)
                zf.write(full, arc)
                file_count += 1
    return file_count


# ── Main orchestration ────────────────────────────────────────────────────────

def run_postman_sync(
    from_date: str,
    to_date: str,
    company: Optional[str] = None,
    waiting_on: Optional[str] = None,
    on_step=None,
) -> dict:
    """
    End-to-end Postman-style fetch.
    Returns: {
        "session_id": str,
        "input_dir":  str,
        "output_dir": str,
        "excel_path": str,
        "bills_zip":  str,
        "claims_count": int,
        "rows_count":   int,
        "bills_downloaded": int,
        "bills_attempted":  int,
    }
    """
    def _step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    session_id, inp_dir, out_dir = _make_session_dirs(from_date, to_date)
    _step(f"Created input folder: {inp_dir}")

    # 1. Fetch claims → Excel
    excel_path = os.path.join(inp_dir, "claims.xlsx")
    _step(f"Fetching claims from Keka API ({from_date} → {to_date})…")
    claims, rows = fetch_claims_to_excel(
        from_date, to_date, excel_path,
        company=company, waiting_on=waiting_on,
        in_approval_only=True,        # match bulk receipt scope
    )
    _step(f"Saved {len(rows)} expense rows to {excel_path}")

    # 2. Download bills — try Keka UI's "Bulk Receipt" feature first (most reliable)
    bills_dir = os.path.join(inp_dir, "bills")
    bills_attempted = sum(
        len(exp.get("attachments") or [])
        for c in claims
        for exp in (c.get("expenses") or [{}])
    )

    bulk_zip_path = None
    bills_downloaded = 0
    bills_zip = os.path.join(inp_dir, "bills.zip")

    _step("Attempting Bulk Receipt download via Keka UI (Reports → Expense Claim)…")
    try:
        bulk_zip_path = download_bulk_receipts_via_ui(
            from_date, to_date, inp_dir,
            company=company, on_step=on_step,
        )
    except Exception as e:
        _step(f"Bulk Receipt UI flow error: {e}")
        bulk_zip_path = None

    if bulk_zip_path and os.path.exists(bulk_zip_path):
        try:
            with zipfile.ZipFile(bulk_zip_path, "r") as zf:
                zf.extractall(bills_dir)
            # Rename Keka's "{ClaimNumber}_{Title}" folders → claim_id UUIDs
            # so downstream matching uses the unique claim_id.
            normalize_bills_to_claim_id(bills_dir, claims, on_step=on_step)
            # Count files after rename
            bills_downloaded = 0
            for root, _, files in os.walk(bills_dir):
                bills_downloaded += len(files)
            _step(f"Extracted {bills_downloaded} files from {os.path.basename(bulk_zip_path)}")
            zip_bills_folder(bills_dir, bills_zip)
        except Exception as e:
            _step(f"Bulk zip extraction error: {e}")
            import shutil as _sh
            _sh.copy(bulk_zip_path, bills_zip)
            bills_downloaded = bills_attempted
    else:
        # Per-attachment OAuth API endpoints all return 404 — skip the slow fallback.
        # User must use Bulk Receipt UI mode (interactive) to get bills.
        _step("Bulk Receipt UI flow did not capture a download. "
              "Skipping slow per-attachment fallback (Keka API doesn't expose them).")

    # 4. Save metadata
    meta = {
        "session_id":       session_id,
        "from_date":        from_date,
        "to_date":          to_date,
        "company":          company or os.environ.get("KEKA_COMPANY_NAME", ""),
        "fetched_at":       datetime.now().isoformat(),
        "claims_count":     len(claims),
        "rows_count":       len(rows),
        "bills_attempted":  bills_attempted,
        "bills_downloaded": bills_downloaded,
        "input_dir":        inp_dir,
        "output_dir":       out_dir,
    }
    with open(os.path.join(inp_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    return {
        **meta,
        "excel_path": excel_path,
        "bills_zip":  bills_zip if os.path.exists(bills_zip) else None,
    }
