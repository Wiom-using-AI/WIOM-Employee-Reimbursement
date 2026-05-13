"""
Keka HR API integration — official OAuth2 only.

Auth: POST https://login.keka.com/connect/token
      grant_type=kekaapi, scope=kekaapi, client_id, client_secret, api_key
API:  https://{company}.keka.com/api/v1/

Env vars:
    KEKA_CLIENT_ID     - Keka Settings → Developer → Apps → Create App
    KEKA_CLIENT_SECRET - Keka Settings → Developer → Apps → Create App
    KEKA_API_KEY       - Global Admin Settings → Integrations → API access → API key
    KEKA_COMPANY_NAME  - subdomain, e.g. "omniainformation"
"""

import os
import re
import time
import logging
import requests
from datetime import datetime, timedelta
from typing import Optional

log = logging.getLogger(__name__)

KEKA_CLIENT_ID     = os.environ.get("KEKA_CLIENT_ID", "")
KEKA_CLIENT_SECRET = os.environ.get("KEKA_CLIENT_SECRET", "")
KEKA_API_KEY       = os.environ.get("KEKA_API_KEY", "")
KEKA_COMPANY_NAME  = os.environ.get("KEKA_COMPANY_NAME", "omniainformation")

TOKEN_URL = "https://login.keka.com/connect/token"

_token_cache: dict = {}

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


def _api_base(company: str = None) -> str:
    return f"https://{company or KEKA_COMPANY_NAME}.keka.com/api/v1"


def _auth_headers(token: str, company: str = None) -> dict:
    co = company or KEKA_COMPANY_NAME
    return {
        **_BROWSER_HEADERS,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Origin":  f"https://{co}.keka.com",
        "Referer": f"https://{co}.keka.com/",
    }


def _parse_amount(val) -> float:
    """Parse amounts like '1320.00 INR', 1320.0, or '1,320.00' → float."""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    m = re.search(r"[\d,]+\.?\d*", s)
    if m:
        return float(m.group(0).replace(",", ""))
    return 0.0


def get_keka_token(
    client_id: str = None,
    client_secret: str = None,
    api_key: str = None,
) -> str:
    """Obtain Bearer token via Keka API key grant. Cached until 60s before expiry."""
    cid  = client_id     or KEKA_CLIENT_ID
    csec = client_secret or KEKA_CLIENT_SECRET
    akey = api_key       or KEKA_API_KEY

    if not cid or not csec:
        raise RuntimeError(
            "Keka credentials missing.\n"
            "Set in .env:\n"
            "  KEKA_CLIENT_ID     → Keka Settings → Developer → Apps\n"
            "  KEKA_CLIENT_SECRET → Keka Settings → Developer → Apps\n"
            "  KEKA_API_KEY       → Global Admin → Integrations → API access"
        )
    if not akey:
        raise RuntimeError(
            "KEKA_API_KEY missing.\n"
            "Get it from: Keka Global Admin Settings → Integrations & Automations → API access → API key"
        )

    cache_key = f"{cid}:{akey}"
    cached = _token_cache.get(cache_key)
    if cached and cached["expires_at"] > time.time() + 60:
        return cached["token"]

    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type":    "kekaapi",
            "client_id":     cid,
            "client_secret": csec,
            "scope":         "kekaapi",
            "api_key":       akey,
        },
        headers={
            **_BROWSER_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin":  f"https://{KEKA_COMPANY_NAME}.keka.com",
            "Referer": f"https://{KEKA_COMPANY_NAME}.keka.com/",
        },
        timeout=20,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Keka token request failed ({resp.status_code}): {resp.text[:400]}"
        )
    data = resp.json()
    token = data.get("access_token") or data.get("token")
    if not token:
        raise RuntimeError(f"Keka token response missing access_token: {str(data)[:200]}")
    expires_in = int(data.get("expires_in", 3600))
    _token_cache[cache_key] = {"token": token, "expires_at": time.time() + expires_in}
    return token


def fetch_expense_claims(
    token: str,
    from_date: str,
    to_date: str,
    status: str = "pending",
    company: str = None,
    page_size: int = 200,
) -> list[dict]:
    """
    Fetch expense claims in a date range from Keka official API.
    Official API uses pageNumber pagination and lastModified filter.
    Client-side filters by submittedDate/claimDate to honour the user's date range.
    """
    base     = _api_base(company)
    url      = f"{base}/expense/claims"
    all_data = []
    page     = 1

    # Use a date 90 days BEFORE from_date as lastModified bound.
    # Keka's `lastModified` filter excludes claims whose last modification
    # predates the bound, even if the claim was SUBMITTED inside our range.
    # Backing up 90 days ensures we don't miss recent submissions of older claims.
    from datetime import datetime as _dt, timedelta as _td
    try:
        _fd = _dt.strptime(from_date, "%Y-%m-%d")
        _lm = _fd - _td(days=90)
        last_modified_ts = _lm.strftime("%Y-%m-%dT00:00:00Z")
    except Exception:
        last_modified_ts = f"{from_date}T00:00:00Z"

    while True:
        params = {
            "pageNumber":   page,
            "pageSize":     page_size,
            "lastModified": last_modified_ts,
        }
        resp = requests.get(url, headers=_auth_headers(token, company), params=params, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(
                f"Keka claims API failed ({resp.status_code}): {resp.text[:400]}"
            )

        raw  = resp.json()
        # Handle various response shapes: {data:[...]} / {data:{data:[...]}} / plain list
        if isinstance(raw, list):
            batch = raw
            has_more = False
        else:
            inner = raw.get("data", raw)
            if isinstance(inner, list):
                batch    = inner
                has_more = len(inner) == page_size
            elif isinstance(inner, dict):
                batch    = inner.get("data", inner.get("results", []))
                total    = inner.get("totalCount", inner.get("total", 0))
                has_more = (page * page_size) < total
            else:
                batch    = []
                has_more = False

        all_data.extend(batch)
        if not batch or not has_more:
            break
        page += 1

    # Client-side filter: keep only claims whose date falls in [from_date, to_date]
    if from_date or to_date:
        import re as _re
        fd = from_date or "1970-01-01"
        td = to_date   or "9999-12-31"
        filtered = []
        for c in all_data:
            raw_date = (
                c.get("submittedOn")   or c.get("submittedDate") or
                c.get("submissionDate") or c.get("claimDate") or
                c.get("createdOn")     or c.get("date") or ""
            )
            m = _re.search(r"\d{4}-\d{2}-\d{2}", str(raw_date))
            d_str = m.group(0) if m else ""
            if not d_str or fd <= d_str <= td:
                filtered.append(c)
        all_data = filtered

    return all_data


def fetch_claim_details(token: str, claim_id: str, company: str = None) -> dict:
    """Fetch full details + expense line items for a single claim."""
    base = _api_base(company)
    resp = requests.get(
        f"{base}/expense/claims/{claim_id}",
        headers=_auth_headers(token, company),
        timeout=20,
    )
    if resp.status_code == 404:
        return {}
    if resp.status_code != 200:
        log.warning("Claim details fetch failed for %s: %s", claim_id, resp.status_code)
        return {}
    raw = resp.json()
    if isinstance(raw, dict):
        return raw.get("data", raw)
    return {}


def fetch_claim_attachments_info(token: str, claim_id: str, company: str = None) -> list[dict]:
    """
    Return attachment metadata for a claim.
    Tries /attachments endpoint; if 404, returns empty (caller should check embedded data).
    """
    base = _api_base(company)
    for path in [
        f"{base}/expense/claims/{claim_id}/attachments",
        f"{base}/expense/claims/{claim_id}/receipts",
    ]:
        try:
            resp = requests.get(path, headers=_auth_headers(token, company), timeout=20)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list):
                    return data
                inner = data.get("data", data)
                if isinstance(inner, list):
                    return inner
            elif resp.status_code == 404:
                continue
        except Exception as e:
            log.debug("Attachment endpoint %s error: %s", path, e)
    return []


def download_attachment(
    token: str,
    attachment: dict,
    claim_id: str = "",
    expense_id: str = "",
    company: str = None,
) -> Optional[bytes]:
    """
    Download a single attachment. Tries Keka API proxy endpoints first,
    then falls back to a direct URL if present.
    """
    co   = company or KEKA_COMPANY_NAME
    base = _api_base(co)
    att_id = str(attachment.get("id") or attachment.get("attachmentId") or "")
    hdrs = _auth_headers(token, co)

    # 1. Try Keka proxy endpoints (these work without SAS tokens)
    proxy_urls = []
    if claim_id and att_id:
        proxy_urls += [
            f"{base}/expense/claims/{claim_id}/attachments/{att_id}",
            f"{base}/expense/claims/{claim_id}/attachments/{att_id}/download",
        ]
    if expense_id and att_id:
        proxy_urls += [
            f"{base}/expense/expenses/{expense_id}/attachments/{att_id}",
            f"{base}/expense/attachments/{att_id}",
        ]
    if att_id:
        proxy_urls.append(f"{base}/expense/attachments/{att_id}")

    for url in proxy_urls:
        try:
            resp = requests.get(url, headers=hdrs, timeout=60, allow_redirects=True)
            if resp.status_code == 200 and resp.content:
                ct = resp.headers.get("Content-Type", "")
                if "json" not in ct:  # skip if it returned JSON error
                    log.info("Attachment downloaded via proxy: %s", url)
                    return resp.content
        except Exception as e:
            log.debug("Proxy URL %s failed: %s", url, e)

    # 2. Fall back to explicit URL in attachment dict
    url = (attachment.get("downloadUrl") or attachment.get("url") or
           attachment.get("fileUrl") or attachment.get("blobUrl") or "")
    if url:
        if url.startswith("/"):
            url = f"https://{co}.keka.com{url}"
        try:
            resp = requests.get(url, headers=hdrs, timeout=60, allow_redirects=True)
            if resp.status_code == 200 and resp.content:
                ct = resp.headers.get("Content-Type", "")
                if "json" not in ct:
                    return resp.content
        except Exception as e:
            log.warning("Attachment download failed for url %s: %s", url[:80], e)

    # 3. Last resort: browser session download (requires KEKA_EMAIL + KEKA_PASSWORD)
    try:
        from services.keka_browser import get_attachment_bytes_via_session, KEKA_EMAIL
        if KEKA_EMAIL and att_id:
            data = get_attachment_bytes_via_session(
                att_id=att_id,
                claim_id=claim_id,
                expense_id=expense_id,
                att_name=str(attachment.get("name") or attachment.get("fileName") or ""),
                company=co,
            )
            if data:
                return data
    except Exception as e:
        log.debug("Browser session download failed: %s", e)

    return None


def download_all_attachments_to_dir(
    token: str,
    claim_id: str,
    out_dir: str,
    company: str = None,
    embedded_attachments: list = None,
) -> list[str]:
    """
    Download all attachments for a claim to out_dir.
    Uses embedded_attachments if provided (from claim response), otherwise calls API.
    Returns list of saved file paths.
    """
    os.makedirs(out_dir, exist_ok=True)
    attachments = embedded_attachments or fetch_claim_attachments_info(token, claim_id, company)
    saved = []
    for att in attachments:
        exp_id = str(att.get("expenseId") or att.get("expense_id") or "")
        data = download_attachment(
            token, att,
            claim_id=claim_id,
            expense_id=exp_id,
            company=company,
        )
        if data:
            fname = (att.get("fileName") or att.get("name") or att.get("originalName") or
                     f"attachment_{att.get('id', len(saved))}")
            fpath = os.path.join(out_dir, fname)
            with open(fpath, "wb") as f:
                f.write(data)
            saved.append(fpath)
    return saved


def _resolve_spa_claim_id(base: str, hdrs: dict, claim_uuid: str):
    """
    Find the SPA numeric claim ID for a given OAuth UUID by searching multiple
    Keka endpoints. Returns (numeric_id, found_claim_dict) or (None, None).
    """
    # Endpoints to try, in order of likelihood
    endpoints = [
        (f"{base}/k/default/api/expense/claims/pending",           {"pageNumber": 1, "pageSize": 500}),
        (f"{base}/k/default/api/expense/claims/underprogress",     {"pageNumber": 1, "pageSize": 500}),
        (f"{base}/k/default/api/expense/claims",                   {"pageNumber": 1, "pageSize": 500}),
        (f"{base}/k/default/api/expense/claims",                   {"pageNumber": 1, "pageSize": 500, "claimStatus": 1}),
        (f"{base}/k/default/api/expense/claims",                   {"pageNumber": 1, "pageSize": 500, "claimStatus": 2}),
    ]
    uuid_lower = claim_uuid.lower().strip("{}")
    for url, params in endpoints:
        try:
            r = requests.get(url, params=params, headers=hdrs, timeout=15)
            if r.status_code != 200:
                continue
            body = r.json()
            items = body.get("data") or (body if isinstance(body, list) else [])
            for c in items:
                # Search ALL string values AND numeric values for the claim identifier
                for v in c.values():
                    if isinstance(v, str) and v.lower().strip("{}") == uuid_lower:
                        log.info("Resolved claim %s → numeric id %s via %s (string match)",
                                 claim_uuid, c.get("id"), url)
                        return c.get("id"), c
                    # Keka often stores claimNumber as int — match numerically too
                    if isinstance(v, (int, float)) and str(int(v)) == uuid_lower:
                        log.info("Resolved claim %s → numeric id %s via %s (int match)",
                                 claim_uuid, c.get("id"), url)
                        return c.get("id"), c
                # Exact id match (uuid IS the numeric spa id)
                if str(c.get("id")) == uuid_lower:
                    return c.get("id"), c
        except Exception as e:
            log.debug("Endpoint %s failed: %s", url, e)
            continue
    return None, None


def _spa_action_call(action: str, claim_uuid: str, payload: dict = None,
                     comment: str = "", company: str = None) -> dict:
    """
    Call Keka's internal SPA API for expense claim actions
    (the OAuth v1 API doesn't expose approve/reject/markaspaid endpoints).

    Uses session cookies + SPA access_token saved during browser login.
    Endpoint: PUT /k/default/api/expense/claims/{action}
    """
    from services.keka_browser import (
        _get_session_cookies, _cookies_to_header,
        get_spa_access_token, KEKA_COMPANY_NAME,
    )
    co = company or KEKA_COMPANY_NAME

    cookies = _get_session_cookies(co)
    spa_token = get_spa_access_token(co) or ""
    if not spa_token:
        raise RuntimeError(
            "Keka session required — please log in via the Keka Sync page first."
        )

    base = f"https://{co}.keka.com"
    hdrs = {
        "Authorization": f"Bearer {spa_token}",
        "Accept":        "application/json",
        "Content-Type":  "application/json",
        "Cookie":        _cookies_to_header(cookies),
        "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin":        base,
        "Referer":       f"{base}/",
        "X-Requested-With": "XMLHttpRequest",
    }

    # Resolve UUID → numeric SPA claim id (action endpoints use numeric id)
    numeric_id, found_claim = _resolve_spa_claim_id(base, hdrs, claim_uuid)
    if numeric_id is None:
        raise RuntimeError(
            f"Claim not found in Keka (id: {claim_uuid[:8]}…). "
            f"It may already be actioned, or the Keka session may be stale — "
            f"try re-logging in via Keka Sync page."
        )

    # Payload shapes to try — Keka's internal API varies by tenant/version
    c_str = comment or ""
    list_payloads = [
        # array of objects (most common shape)
        [{"id": numeric_id, "approverComment": c_str, "approvalActionReason": c_str}],
        [{"id": numeric_id, "comment": c_str}],
        [{"claimId": numeric_id, "comment": c_str, "level": 1}],
        [{"id": numeric_id, "remarks": c_str, "comment": c_str}],
    ]
    obj_payloads = [
        # single object shape
        {"id": numeric_id, "approverComment": c_str, "approvalActionReason": c_str},
        {"id": numeric_id, "comment": c_str},
        {"claimId": numeric_id, "comment": c_str},
    ]
    if payload:
        # For mark_paid: fill in the numeric id
        filled = []
        for item in payload:
            item_copy = dict(item)
            if item_copy.get("id") is None:
                item_copy["id"] = numeric_id
            filled.append(item_copy)
        list_payloads.insert(0, filled)

    # URL candidates — try ID-in-path first (most likely for 405 fixes), then action-only path
    url_candidates = [
        f"{base}/k/default/api/expense/claims/{numeric_id}/{action}",
        f"{base}/k/default/api/expense/claims/{action}",
        f"{base}/k/default/api/expense/approvals/claims/{action}",
        f"{base}/k/default/api/expense/approvals/{action}",
    ]

    last_err = ""
    all_payloads = list_payloads + obj_payloads
    for url in url_candidates:
        url_got_405 = False
        for method in ("put", "post", "patch"):
            if url_got_405:
                break
            for p in all_payloads:
                try:
                    fn = getattr(requests, method)
                    r = fn(url, headers=hdrs, json=p, timeout=20)
                    if r.status_code in (200, 201, 204):
                        log.info("✓ %s %s succeeded for claim %s (numeric=%s)",
                                 method.upper(), url, claim_uuid[:8], numeric_id)
                        try: return r.json()
                        except Exception: return {"success": True, "claim_id": numeric_id}
                    last_err = f"{r.status_code}: {r.text[:200]}"
                    log.debug("%s %s → %s", method.upper(), url, last_err)
                    if r.status_code == 405:
                        url_got_405 = True
                        break
                except Exception as e:
                    last_err = str(e)

    # All REST attempts exhausted — try browser JS fetch (same-origin, real SPA token)
    try:
        from services.keka_browser import approve_claim_js
        js_res = approve_claim_js(numeric_id, action, comment or "", company)
        if js_res.get("success"):
            log.info("✓ Browser JS fetch succeeded for claim %s via %s %s",
                     claim_uuid[:8], js_res.get("method"), js_res.get("url"))
            return {"success": True, "claim_id": numeric_id, "via": "browser_js",
                    "url": js_res.get("url")}
        last_err = f"Browser JS also failed: {js_res.get('error', '')}"
        log.warning("Browser JS fetch failed for claim %s: %s", claim_uuid[:8], last_err)
    except Exception as _je:
        log.warning("approve_claim_js raised: %s", _je)

    # Signal caller to try Playwright UI click fallback
    display_number = (
        found_claim.get("claimNumber") or found_claim.get("claimNo") or claim_uuid
        if found_claim else claim_uuid
    )
    raise RuntimeError(
        f"REST_FAILED|{action}|{claim_uuid}|{numeric_id}|{display_number}"
        f"|Last error: {last_err}"
    )


def approve_claim(token: str, claim_id: str, company: str = None) -> dict:
    """Approve an expense claim in Keka via SPA REST API."""
    return _spa_action_call("approve", claim_id, company=company)


def reject_claim(token: str, claim_id: str, reason: str, company: str = None) -> dict:
    """Reject an expense claim — Keka emails the employee with the reason."""
    return _spa_action_call("reject", claim_id, comment=reason or "", company=company)


def mark_claim_paid(
    token: str,
    claim_id: str,
    company: str = None,
    payment_mode: str = "BankTransfer",
    payment_date: str = None,
    reference_no: str = "",
) -> dict:
    """Mark an approved expense claim as PAID via Keka SPA internal API."""
    from datetime import date as _date
    pay_date = payment_date or _date.today().isoformat()

    # Map UI-friendly names to Keka enums
    mode_map = {
        "BankTransfer":  3, "Bank Transfer": 3, "bank":   3,
        "Cash":          1, "cash":          1,
        "Cheque":        2, "cheque":        2,
        "DigitalWallet": 4, "UPI":           4, "upi":    4,
    }
    pay_mode_code = mode_map.get(payment_mode, 3)

    payload = [{
        "id":                  None,                    # filled inside _spa_action_call
        "paymentMode":         pay_mode_code,
        "paymentDate":         pay_date,
        "paymentReference":    reference_no,
        "referenceNumber":     reference_no,
        "comment":             f"Paid via Expense Validator on {pay_date}",
    }]
    return _spa_action_call("markaspaid", claim_id,
                             payload=payload, comment=reference_no, company=company)


def _extract_employee(claim: dict) -> tuple[str, str, str]:
    """Return (employee_name, employee_id, employee_email) from a claim dict."""
    emp = claim.get("employee") or {}
    # Keka API uses: employeeIdentifier, displayName
    name  = (claim.get("employeeName")      or emp.get("displayName") or
             emp.get("name")               or emp.get("fullName") or "")
    empid = (claim.get("employeeIdentifier") or claim.get("employeeNumber") or
             claim.get("employeeId")        or emp.get("employeeIdentifier") or
             emp.get("employeeNumber")      or emp.get("id") or "")
    email = (claim.get("employeeEmail")     or emp.get("email") or
             emp.get("emailAddress")        or "")
    return str(name), str(empid), str(email)


def _extract_attachments_from_expense(exp: dict) -> list[dict]:
    """Extract attachment metadata embedded inside an expense line item."""
    for key in ("attachments", "receipts", "documents", "files"):
        val = exp.get(key)
        if isinstance(val, list) and val:
            return val
    for key in ("attachmentUrl", "receiptUrl", "fileUrl", "downloadUrl", "blobUrl"):
        url = exp.get(key)
        if url:
            return [{"downloadUrl": url, "fileName": f"receipt_{exp.get('id','')}.pdf"}]
    return []


def _extract_category_from_expense(exp: dict, fallback: str = "") -> str:
    """
    Keka embeds human-readable category in customFields[].
    Falls back to expenseCategoryId or fallback string.
    """
    for cf in (exp.get("customFields") or []):
        if isinstance(cf, dict):
            v = str(cf.get("value") or "").strip()
            if v:
                return v
    return (exp.get("category") or exp.get("expenseType") or
            exp.get("categoryName") or fallback)


def claims_to_expense_rows(claims: list[dict], claim_details_map: dict) -> list[dict]:
    """
    Convert Keka claim dicts into row dicts compatible with the validator's ExpenseRow schema.
    Handles both flat claims and claims with embedded expense line items.
    """
    rows = []
    for claim in claims:
        cid            = str(claim.get("id") or claim.get("claimId") or claim.get("expenseClaimId") or "")
        employee_name, employee_id, employee_email = _extract_employee(claim)
        # Keka API uses submittedOn (not submittedDate)
        submitted_date = (claim.get("submittedOn") or claim.get("submittedDate") or
                          claim.get("submissionDate") or claim.get("claimDate") or "")
        # Strip time part if present: "2025-04-01T00:00:00Z" → "2025-04-01"
        if submitted_date and "T" in str(submitted_date):
            submitted_date = str(submitted_date)[:10]
        claim_number   = claim.get("claimNumber") or claim.get("claimNo") or cid
        title          = claim.get("title") or claim.get("claimTitle") or ""

        # Line items come from detail call or embedded in claim response itself
        detail   = claim_details_map.get(cid, claim)
        expenses = (
            detail.get("expenses") or detail.get("expenseItems") or
            detail.get("lineItems") or detail.get("items") or
            claim.get("expenses")  or claim.get("expenseItems") or []
        )

        if not expenses:
            rows.append({
                "keka_claim_id":      cid,
                "keka_claim_number":  claim_number,
                "employee_name":      employee_name,
                "employee_id":        employee_id,
                "employee_email":     employee_email,
                "expense_date":       submitted_date,
                "expense_category":   title,
                "expense_nature":     title,
                "description":        title,
                "claimed_amount":     _parse_amount(claim.get("totalAmount") or claim.get("amount")),
                "currency":           claim.get("currency") or "INR",
                "attachments":        [],
            })
        else:
            for exp in expenses:
                amt = _parse_amount(
                    exp.get("amount") or exp.get("claimedAmount") or
                    exp.get("requestedAmount") or exp.get("approvedAmount")
                )
                exp_date = (exp.get("expenseDate") or exp.get("date") or submitted_date)
                if exp_date and "T" in str(exp_date):
                    exp_date = str(exp_date)[:10]
                # Keka: expense.title = claim title, expense.comment = remark/description
                exp_title    = exp.get("title") or title
                exp_comment  = exp.get("comment") or exp.get("description") or exp_title
                category     = _extract_category_from_expense(exp, fallback=exp_title)
                rows.append({
                    "keka_claim_id":      cid,
                    "keka_claim_number":  claim_number,
                    "employee_name":      employee_name,
                    "employee_id":        employee_id,
                    "employee_email":     employee_email,
                    "expense_date":       exp_date,
                    "expense_category":   category,
                    "expense_nature":     category,
                    "description":        exp_comment,
                    "claimed_amount":     amt,
                    "currency":           exp.get("currency") or claim.get("currency") or "INR",
                    "keka_expense_id":    str(exp.get("id") or exp.get("expenseId") or ""),
                    "attachments":        _extract_attachments_from_expense(exp),
                })
    return rows
