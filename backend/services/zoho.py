"""
Zoho Books integration — push approved expense claims as expense entries.
Uses India region API (books.zoho.in).
"""
import os
import mimetypes
from typing import List, Dict, Optional
from models.schemas import ExpenseRow, ExpenseStatus

ZOHO_API_BASE   = "https://www.zohoapis.in/books/v3"
ZOHO_AUTH_URL   = "https://accounts.zoho.in/oauth/v2/token"

ORG_ID          = os.environ.get("ZOHO_ORG_ID",          "60036724867")
CLIENT_ID       = os.environ.get("ZOHO_CLIENT_ID",        "")
CLIENT_SECRET   = os.environ.get("ZOHO_CLIENT_SECRET",    "")
REFRESH_TOKEN   = os.environ.get("ZOHO_REFRESH_TOKEN",    "")

_FOOD_KW   = {"food","meal","dining","restaurant","cafe","snack","beverage","lunch","dinner",
              "breakfast","tea","coffee","eat","drink","swiggy","zomato","tiffin","canteen","pantry"}
_TRAVEL_KW = {"travel","transport","bus","train","cab","auto","taxi","flight","uber","ola",
              "metro","petrol","fuel","vehicle","conveyance","fare","toll","parking"}
_SUB_KW    = {"subscription","software","tool","ai","saas","license","app","cloud","aws",
              "azure","github","notion","slack","zoom","openai","anthropic","chatgpt","copilot",
              "figma","jira","confluence","linear","vercel","netlify","digital"}
_ACCOM_KW  = {"hotel","accommodation","stay","lodge","hostel","airbnb","oyo","inn","resort"}

# Desired account names in priority order — first one found in Zoho chart wins.
# Zoho Books India system defaults are listed last as ultimate fallback.
_ACCOUNT_CANDIDATES = {
    "food":   ["Staff and Welfare", "Staff Welfare", "Employee Welfare",
               "Meals and Entertainment", "Meals & Entertainment", "Entertainment",
               "Other Expense"],
    "travel": ["Conveyance", "Conveyance Expenses", "Travel & Conveyance",
               "Travel Expense", "Travel", "Transportation", "Automobile Expense",
               "Other Expense"],
    "sub":    ["Subscription Charges", "Software Subscriptions", "Subscriptions",
               "Software & Subscriptions", "IT and Internet Expenses",
               "IT Expenses", "Other Expense"],
    "accom":  ["Accommodation", "Hotel & Accommodation", "Lodging",
               "Travel Expense", "Other Expense"],
}

# Cache: populated on first call to get_expense_accounts()
_accounts_cache: Optional[List[Dict]] = None


def _get_access_token() -> str:
    global _token_cache
    # Return cached token if still valid (with 60s buffer)
    if _token_cache.get("token") and _time.time() < _token_cache.get("expires_at", 0) - 60:
        return _token_cache["token"]
    import requests
    # Retry with backoff to handle Zoho rate limiting automatically
    delays = [5, 15, 30]
    last_err = None
    for attempt, wait in enumerate([0] + delays):
        if wait:
            _time.sleep(wait)
        try:
            r = requests.post(ZOHO_AUTH_URL, data={
                "grant_type":    "refresh_token",
                "client_id":     CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": REFRESH_TOKEN,
            }, timeout=15)
            data = r.json()
            # Rate limited — retry
            if r.status_code == 400 and "too many" in data.get("error_description", "").lower():
                last_err = data.get("error_description", "rate limited")
                continue
            r.raise_for_status()
            if "access_token" not in data:
                raise RuntimeError(f"Zoho token error: {data}")
            _token_cache = {
                "token":      data["access_token"],
                "expires_at": _time.time() + int(data.get("expires_in", 3600)),
            }
            return _token_cache["token"]
        except RuntimeError:
            raise
        except Exception as e:
            last_err = str(e)
            continue
    raise RuntimeError(f"Zoho auth failed after retries: {last_err}")


def _headers(token: str) -> Dict:
    return {
        "Authorization": f"Zoho-oauthtoken {token}",
        "X-com-zoho-books-organizationid": ORG_ID,
    }


import time as _time
_token_cache: dict = {}   # {"token": str, "expires_at": float}
_reim_counter: Optional[int] = None  # cached next number within a push session

_BILL_PREFIX = "Reim-"


def _next_bill_number(token: str) -> str:
    """
    Return the next bill number in the Reim-XX series.
    Queries Zoho for existing Reim-* bills, picks max, increments by 1.
    Within a push session the counter is bumped in-memory to avoid duplicate numbers.
    """
    global _reim_counter
    import requests, re

    if _reim_counter is None:
        # Scan existing bills for highest Reim-XX number
        max_num = 0
        page = 1
        while True:
            r = requests.get(
                f"{ZOHO_API_BASE}/bills",
                headers=_headers(token),
                params={"organization_id": ORG_ID, "per_page": 200, "page": page},
            )
            data = r.json()
            for b in data.get("bills", []):
                bn = b.get("bill_number", "")
                if bn.upper().startswith(_BILL_PREFIX.upper()):
                    m = re.search(r"\d+$", bn)
                    if m:
                        max_num = max(max_num, int(m.group()))
            if not data.get("page_context", {}).get("has_more_page", False):
                break
            page += 1
        _reim_counter = max_num

    _reim_counter += 1
    return f"{_BILL_PREFIX}{_reim_counter:02d}"


_EXPENSE_ACCOUNT_TYPES = {
    "expense", "other_expense", "cost_of_goods_sold", "direct costs",
    "other costs",
}

def get_expense_accounts(token: Optional[str] = None) -> List[Dict]:
    """
    Fetch expense accounts from Zoho using search_text for each candidate name.
    The paginated list endpoint only returns asset accounts for this org,
    so we must use search to find expense-type accounts by name.
    Returns list of {account_id, account_name, account_type}.
    """
    global _accounts_cache
    if _accounts_cache is not None:
        return _accounts_cache
    if token is None:
        token = _get_access_token()
    import requests

    seen_ids: set = set()
    accounts: List[Dict] = []

    # Search for all candidate account names across all categories
    all_candidates = [name for names in _ACCOUNT_CANDIDATES.values() for name in names]
    for candidate in all_candidates:
        r = requests.get(
            f"{ZOHO_API_BASE}/chartofaccounts",
            headers=_headers(token),
            params={"organization_id": ORG_ID, "search_text": candidate, "per_page": 10},
        )
        for acct in r.json().get("chartofaccounts", []):
            aid = acct.get("account_id", "")
            if aid and aid not in seen_ids:
                atype = acct.get("account_type", "").lower()
                if "expense" in atype or atype in _EXPENSE_ACCOUNT_TYPES:
                    seen_ids.add(aid)
                    accounts.append({
                        "account_id":   aid,
                        "account_name": acct.get("account_name", ""),
                        "account_type": acct.get("account_type", ""),
                    })

    _accounts_cache = accounts
    return accounts


def _pick_account(kind: str, accounts: List[Dict]) -> Dict:
    """Pick the best candidate account for the given expense kind.
    Returns {account_id, account_name} dict."""
    by_name = {a["account_name"].lower(): a for a in accounts}
    for candidate in _ACCOUNT_CANDIDATES.get(kind, []):
        if candidate.lower() in by_name:
            return by_name[candidate.lower()]
    # Fallback: return preferred name so _ensure_account will create it
    return {"account_id": None, "account_name": _ACCOUNT_CANDIDATES[kind][0]}


def _account_code(name: str) -> str:
    """Generate a short unique account code from the account name."""
    import re
    words = re.sub(r"[^a-zA-Z0-9 ]", "", name).split()
    code = "".join(w[:3].upper() for w in words)[:9]
    return code or "EXP"


def _ensure_account(token: str, account_name: str) -> Optional[str]:
    """
    Ensure the account exists in Zoho Books. Returns its account_id.
    Creates it if missing; searches if cache doesn't have it.
    """
    global _accounts_cache
    import requests

    # Check cache first
    if _accounts_cache:
        for a in _accounts_cache:
            if a["account_name"].lower() == account_name.lower():
                return a["account_id"]

    # Search Zoho directly (the list endpoint misses expense accounts for this org)
    r_search = requests.get(
        f"{ZOHO_API_BASE}/chartofaccounts",
        headers=_headers(token),
        params={"organization_id": ORG_ID, "search_text": account_name, "per_page": 10},
    )
    for acct in r_search.json().get("chartofaccounts", []):
        if acct.get("account_name", "").lower() == account_name.lower():
            aid = acct["account_id"]
            _accounts_cache = None  # invalidate so next get re-fetches
            return aid

    # Not found — create it
    r = requests.post(
        f"{ZOHO_API_BASE}/chartofaccounts",
        headers=_headers(token),
        params={"organization_id": ORG_ID},
        json={
            "account_name": account_name,
            "account_type": "expense",
            "account_code": _account_code(account_name),
        },
    )
    data = r.json()
    msg = data.get("message", "")
    if data.get("code") == 0:
        _accounts_cache = None
        return data.get("chartofaccount", {}).get("account_id")
    if data.get("code") in (3002,) or "already exists" in msg.lower():
        _accounts_cache = None
        return None  # will be found on next search
    raise RuntimeError(f"Could not create account '{account_name}': {msg or data}")


def _map_to_account(category: str, description: str, accounts: List[Dict]) -> Dict:
    """Return {account_id, account_name} for the best matching expense category."""
    text = (category + " " + description).lower()
    words = set(text.replace(",", " ").replace("/", " ").split())
    if words & _FOOD_KW:
        return _pick_account("food", accounts)
    if words & _TRAVEL_KW:
        return _pick_account("travel", accounts)
    if words & _SUB_KW:
        return _pick_account("sub", accounts)
    if words & _ACCOM_KW:
        return _pick_account("accom", accounts)
    return _pick_account("food", accounts)   # default


_GST_VENDOR_FIELDS = {
    "gst_treatment":   "business_none",   # unregistered vendor (correct for employees)
    "place_of_supply": "DL",
}

# "Employe Reimbursement Payable" — accounts_payable type, under Accounts Payable group
_PAYABLE_ACCOUNT_ID = "2295010000011558933"
_PAYABLE_ACCOUNT_NAME = "Employe Reimbursement Payable"


def _get_payable_account_id(token: str) -> str:
    """Return account_id for 'Employe Reimbursement Payable' (accounts_payable type).
    Uses known ID; verifies via Zoho search on first call in case org data changes."""
    import requests, sys as _sys
    # Quick verify: search by name and return matching AP-type account
    try:
        r = requests.get(
            f"{ZOHO_API_BASE}/chartofaccounts",
            headers=_headers(token),
            params={"organization_id": ORG_ID, "search_text": "Employe Reimbursement", "per_page": 20},
            timeout=8,
        )
        for acct in r.json().get("chartofaccounts", []):
            if (acct.get("account_type", "").lower() == "accounts_payable" and
                    "employ" in acct.get("account_name", "").lower()):
                return acct["account_id"]
    except Exception:
        pass
    # Fall back to hardcoded known-good ID
    return _PAYABLE_ACCOUNT_ID

_PROJECT_NAME = "Delhi 1"
_project_id_cache: Optional[str] = None


def _get_project_id(token: str) -> Optional[str]:
    """Return project_id for 'Delhi 1', or None if not found."""
    global _project_id_cache
    if _project_id_cache is not None:
        return _project_id_cache
    import requests
    r = requests.get(
        f"{ZOHO_API_BASE}/projects",
        headers=_headers(token),
        params={"organization_id": ORG_ID, "per_page": 200},
    )
    for p in r.json().get("projects", []):
        if p.get("project_name", "").strip().lower() == _PROJECT_NAME.lower():
            _project_id_cache = p["project_id"]
            return _project_id_cache
    return None

def _submit_vendor_for_approval(token: str, contact_id: str) -> None:
    """Submit a draft vendor for approval (moves draft → submitted). No-op if already submitted/active."""
    import requests
    requests.post(
        f"{ZOHO_API_BASE}/contacts/{contact_id}/submittoapproval",
        headers=_headers(token),
        params={"organization_id": ORG_ID},
    )


def _get_or_create_vendor(token: str, employee_name: str, employee_id: str) -> str:
    """Return vendor_id for the employee, creating the vendor contact if needed.

    When creating a new vendor the employee code from the file (employee_id)
    is used as the Zoho contact_number so the auto-generated VND-XXXXX number
    is replaced by the actual employee code (e.g. "WI0047").

    New vendors are created as draft contacts.
    """
    import requests, sys as _sys

    emp_code = (employee_id or "").strip()   # e.g. "WI0047"

    def _find_in_list(contacts):
        name_lo = employee_name.strip().lower()
        for c in contacts:
            # Match by name OR by contact_number (employee code)
            if c.get("contact_name", "").strip().lower() == name_lo:
                return c
            if emp_code and c.get("contact_number", "").strip() == emp_code:
                return c
        return None

    # 1. Search by employee code (contact_number) — most precise
    if emp_code:
        r_code = requests.get(f"{ZOHO_API_BASE}/contacts", headers=_headers(token),
                              params={"organization_id": ORG_ID, "contact_number": emp_code})
        found = _find_in_list(r_code.json().get("contacts", []))
        if found:
            return found["contact_id"]

    # 2. Search by name + vendor type
    r = requests.get(f"{ZOHO_API_BASE}/contacts", headers=_headers(token),
                     params={"organization_id": ORG_ID, "contact_type": "vendor",
                             "search_text": employee_name})
    found = _find_in_list(r.json().get("contacts", []))

    # 3. Broad search (any contact type)
    if not found:
        r_broad = requests.get(f"{ZOHO_API_BASE}/contacts", headers=_headers(token),
                               params={"organization_id": ORG_ID, "search_text": employee_name})
        found = _find_in_list(r_broad.json().get("contacts", []))

    if found:
        return found["contact_id"]

    # ── Not found — create new vendor ────────────────────────────────────────
    payable_account_id = _get_payable_account_id(token)

    # Use employee code (employee_id) as the Zoho vendor contact_number
    # so it matches the employee code from the expense file instead of VND-XXXXX
    vendor_payload: dict = {
        "contact_name":   employee_name,
        "contact_type":   "vendor",
        "notes":          f"Employee Code: {emp_code}" if emp_code else "",
        "currency_code":  "INR",
        **_GST_VENDOR_FIELDS,
    }
    if emp_code:
        vendor_payload["contact_number"] = emp_code   # replaces auto-generated VND-XXXXX
    if payable_account_id:
        vendor_payload["account_id"] = payable_account_id

    r2 = requests.post(
        f"{ZOHO_API_BASE}/contacts",
        headers=_headers(token),
        params={"organization_id": ORG_ID},
        json=vendor_payload,
    )
    d2 = r2.json()
    if d2.get("code") != 0:
        msg = d2.get("message", "")
        if "already exists" in msg.lower():
            # Race condition or duplicate — fetch by code then name
            if emp_code:
                r3 = requests.get(f"{ZOHO_API_BASE}/contacts", headers=_headers(token),
                                  params={"organization_id": ORG_ID, "contact_number": emp_code})
                found = _find_in_list(r3.json().get("contacts", []))
                if found:
                    return found["contact_id"]
            r3 = requests.get(f"{ZOHO_API_BASE}/contacts", headers=_headers(token),
                              params={"organization_id": ORG_ID, "search_text": employee_name,
                                      "per_page": 10})
            found = _find_in_list(r3.json().get("contacts", []))
            if found:
                return found["contact_id"]
        raise RuntimeError(f"Could not create vendor for {employee_name}: {msg or d2}")

    contact_id = d2["contact"]["contact_id"]
    print(f"[ZohoVendor] Created {employee_name} / {emp_code} → contact_id={contact_id}",
          file=_sys.stderr, flush=True)
    return contact_id


def _bill_exists(token: str, bill_number: str) -> Optional[str]:
    """Return existing bill_id if a bill with this bill_number already exists in Zoho, else None."""
    import requests
    try:
        r = requests.get(
            f"{ZOHO_API_BASE}/bills",
            headers=_headers(token),
            params={"organization_id": ORG_ID, "bill_number": bill_number, "per_page": 5},
            timeout=10,
        )
        for b in r.json().get("bills", []):
            if str(b.get("bill_number", "")).strip() == str(bill_number).strip():
                return b["bill_id"]
    except Exception:
        pass
    return None


def _create_bill(token: str, row: ExpenseRow, vendor_id: str,
                 accounts: List[Dict], account_override: Optional[str] = None) -> str:
    """Create a Zoho Books vendor bill (draft) and return its bill_id.
    If a bill with the same bill_number (claim_number) already exists, returns its ID instead."""
    import requests, sys as _sys

    # Resolve account — prefer override by name, else auto-detect from category
    if account_override:
        acct_name = account_override
        acct_id   = _ensure_account(token, acct_name)
    else:
        acct_dict = _map_to_account(
            row.expense_nature or row.expense_category or "",
            row.description or "",
            accounts,
        )
        acct_name = acct_dict["account_name"]
        acct_id   = acct_dict.get("account_id") or _ensure_account(token, acct_name)

    # If we still don't have an id, do one more search (handles race with cache invalidation)
    if not acct_id:
        acct_id = _ensure_account(token, acct_name)

    if not acct_id:
        raise RuntimeError(f"Cannot resolve account_id for '{acct_name}'")

    from datetime import datetime as _dt
    amount   = row.bill_amount if row.bill_amount is not None else row.claimed_amount
    today    = _dt.today().strftime("%Y-%m-%d")
    notes    = f"Claim #{row.claim_number or row.row_index} | {row.description}"
    # Use claim number as bill number; fall back to Reim-XX if claim number missing
    bill_num = str(row.claim_number).strip() if row.claim_number else _next_bill_number(token)

    # Check if bill already exists in Zoho (cross-session duplicate guard)
    existing_id = _bill_exists(token, bill_num)
    if existing_id:
        print(f"[ZohoBill] Bill {bill_num} already exists ({existing_id}) — skipping creation", file=_sys.stderr, flush=True)
        return existing_id, bill_num, False   # is_new=False → skip attachments

    line_item: Dict = {
        "account_id":  acct_id,
        "description": row.description[:200] if row.description else acct_name,
        "rate":        amount,
        "quantity":    1,
    }

    payload = {
        "vendor_id":      vendor_id,
        "bill_number":    bill_num,
        "date":           today,
        "due_date":       today,
        "txn_value_date": today,   # Transaction Posting Date (Zoho India GST API field)
        "reference_number": bill_num,
        "notes":          notes[:500],
        "status":         "draft",
        "line_items":     [line_item],
        "custom_fields": [
            {"customfield_id": "2295010000003329419", "value": "DELHI 1"},
            {"customfield_id": "2295010000003734096", "value": "Prepaid Bill"},
        ],
    }
    r = requests.post(
        f"{ZOHO_API_BASE}/bills",
        headers=_headers(token),
        params={"organization_id": ORG_ID},
        json=payload,
    )
    data = r.json()
    print(f"[ZohoBill] {r.status_code} code={data.get('code')} msg={data.get('message')}", file=_sys.stderr, flush=True)
    if r.status_code in (200, 201) and data.get("code") == 0:
        return data["bill"]["bill_id"], bill_num, True   # is_new=True → attach files

    raise RuntimeError(f"Zoho create bill failed: {data.get('message', data)}")


def _attach_file(token: str, bill_id: str, file_path: str) -> None:
    """Attach a bill PDF/image to a Zoho vendor bill."""
    import requests
    fname = os.path.basename(file_path)
    mime  = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        r = requests.post(
            f"{ZOHO_API_BASE}/bills/{bill_id}/attachment",
            headers={
                "Authorization": f"Zoho-oauthtoken {token}",
                "X-com-zoho-books-organizationid": ORG_ID,
            },
            params={"organization_id": ORG_ID},
            files={"attachment": (fname, f, mime)},
        )
    data = r.json()
    if r.status_code not in (200, 201) or data.get("code") != 0:
        raise RuntimeError(f"Attachment failed for {fname}: {data.get('message', data)}")


def _normalise_date(raw: str) -> str:
    from datetime import datetime
    FMTS = [
        "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d",
        "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
        "%d/%m/%y", "%d-%m-%y",
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
    ]
    for fmt in FMTS:
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    if " " in raw:
        return _normalise_date(raw.split()[0])
    return raw[:10]


def fetch_bill_status(bill_id: str) -> Dict:
    """
    Fetch a single Zoho bill's live status and metadata.
    Returns dict with: bill_id, bill_number, status, vendor_name, total.
    """
    import requests
    token = _get_access_token()
    r = requests.get(
        f"{ZOHO_API_BASE}/bills/{bill_id}",
        headers=_headers(token),
        params={"organization_id": ORG_ID},
        timeout=12,
    )
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(data.get("message", f"Zoho error fetching bill {bill_id}"))
    bill = data.get("bill", {})
    return {
        "bill_id":     bill.get("bill_id", bill_id),
        "bill_number": str(bill.get("bill_number", "")).strip(),
        "status":      (bill.get("status") or "unknown").lower(),
        "vendor_name": (bill.get("vendor_name") or "").strip(),
        "total":       float(bill.get("total") or 0),
    }


def fix_vendor_numbers(rows: List[ExpenseRow]) -> Dict:
    """
    For vendors already created in Zoho with auto-generated VND-XXXXX numbers,
    update their contact_number to the employee code from the expense file.

    Iterates over unique employees in rows, looks each up in Zoho by name,
    and if the current contact_number is VND-XXXXX (auto-generated) or empty,
    updates it to the employee code (e.g. WI0047).

    Returns { updated: [...], skipped: [...], errors: [...] }
    """
    import requests, sys as _sys, re as _re

    if not CLIENT_ID or not REFRESH_TOKEN:
        raise RuntimeError("Zoho credentials not configured.")

    token = _get_access_token()

    # Build unique employee → code mapping from rows
    emp_map: Dict[str, str] = {}
    for row in rows:
        name = (row.employee_name or "").strip()
        code = (row.employee_id or "").strip()
        if name and code:
            emp_map[name] = code

    updated = []
    skipped = []
    errors  = []

    _vnd_pat = _re.compile(r'^VND-\d+$', _re.IGNORECASE)

    for emp_name, emp_code in emp_map.items():
        try:
            # Search Zoho for this employee by name
            r = requests.get(
                f"{ZOHO_API_BASE}/contacts",
                headers=_headers(token),
                params={"organization_id": ORG_ID, "contact_type": "vendor",
                        "search_text": emp_name},
                timeout=10,
            )
            contacts = r.json().get("contacts", [])
            # Find exact name match
            contact = next(
                (c for c in contacts
                 if c.get("contact_name", "").strip().lower() == emp_name.lower()),
                None
            )
            if not contact:
                skipped.append({"employee": emp_name, "reason": "not found in Zoho"})
                continue

            current_num = (contact.get("contact_number") or "").strip()
            contact_id  = contact["contact_id"]

            # Skip if already set to employee code
            if current_num == emp_code:
                skipped.append({"employee": emp_name, "contact_number": current_num,
                                 "reason": "already correct"})
                continue

            # Only update if it's VND-XXXXX (auto-generated) or blank
            if current_num and not _vnd_pat.match(current_num):
                skipped.append({"employee": emp_name, "contact_number": current_num,
                                 "reason": "custom number already set — not overwriting"})
                continue

            # Update contact_number to employee code
            upd = requests.put(
                f"{ZOHO_API_BASE}/contacts/{contact_id}",
                headers=_headers(token),
                params={"organization_id": ORG_ID},
                json={"contact_number": emp_code},
                timeout=10,
            )
            d = upd.json()
            if d.get("code") == 0:
                updated.append({
                    "employee":      emp_name,
                    "contact_id":    contact_id,
                    "old_number":    current_num or "(blank)",
                    "new_number":    emp_code,
                })
                print(f"[ZohoFix] {emp_name}: {current_num or '(blank)'} → {emp_code}",
                      file=_sys.stderr, flush=True)
            else:
                errors.append({"employee": emp_name, "error": d.get("message", str(d))})

        except Exception as ex:
            errors.append({"employee": emp_name, "error": str(ex)})

    return {"updated": updated, "skipped": skipped, "errors": errors}


def push_approved_to_zoho(
    rows: List[ExpenseRow],
    bills_dir: str,
    row_overrides: Optional[Dict[int, Dict]] = None,  # row_index → {account, selected}
) -> Dict:
    """
    Push selected Approved rows to Zoho Books as draft expense entries with attachments.
    row_overrides: per-row account name override and selection flag.
    Returns { pushed: [...], errors: [...], total: int, accounts: [...] }
    """
    if not CLIENT_ID or not REFRESH_TOKEN:
        raise RuntimeError(
            "Zoho credentials not configured. "
            "Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in .env"
        )

    global _reim_counter
    _reim_counter = None  # reset so we re-query Zoho for latest bill number each push

    token    = _get_access_token()
    accounts = get_expense_accounts(token)
    pushed   = []
    errors   = []
    approved = [r for r in rows if r.status == ExpenseStatus.APPROVED]

    # Apply selection filter if overrides provided
    if row_overrides:
        approved = [r for r in approved
                    if row_overrides.get(r.row_index, {}).get("selected", True)]

    # Load previously-pushed entries from this session (prevents duplicate bills per claim)
    import json as _json
    session_dir   = os.path.dirname(bills_dir)
    push_path     = os.path.join(session_dir, "zoho_push.json")
    prev_pushed: Dict[int, Dict] = {}   # row_index → existing pushed entry
    if os.path.exists(push_path):
        try:
            with open(push_path, encoding="utf-8") as _pf:
                _prev = _json.load(_pf)
            for _e in _prev.get("pushed", []):
                prev_pushed[int(_e["row_index"])] = _e
        except Exception:
            pass

    for row in approved:
        # Guard: skip rows that already have a bill in Zoho for this session
        if row.row_index in prev_pushed:
            existing = prev_pushed[row.row_index]
            errors.append(
                f"Row {row.row_index} ({row.employee_name}): already pushed as "
                f"{existing.get('bill_number', existing.get('bill_id','?'))} — skipped to prevent duplicate"
            )
            continue

        try:
            account_override = None
            if row_overrides and row.row_index in row_overrides:
                account_override = row_overrides[row.row_index].get("account")

            # Get or create vendor (employee) contact
            vendor_id = _get_or_create_vendor(token, row.employee_name, row.employee_id)

            # Create vendor bill in draft (returns is_new=False if bill already existed)
            bill_id, bill_num, is_new = _create_bill(token, row, vendor_id, accounts, account_override)

            # Attach files only for newly created bills — never re-attach to existing bills
            import hashlib
            attached = []
            if is_new:
                all_keys = list(dict.fromkeys(
                    (row.matched_files or []) +
                    ([row.matched_file] if row.matched_file else [])
                ))
                seen_hashes: set = set()
                for key in all_keys:
                    file_path = os.path.join(bills_dir, key)
                    if not os.path.exists(file_path):
                        continue
                    with open(file_path, "rb") as _f:
                        fhash = hashlib.md5(_f.read()).hexdigest()
                    if fhash in seen_hashes:
                        continue
                    seen_hashes.add(fhash)
                    try:
                        _attach_file(token, bill_id, file_path)
                        attached.append(key)
                    except Exception as att_err:
                        errors.append(f"Row {row.row_index}: attachment failed — {att_err}")

            used_account = account_override or _map_to_account(
                row.expense_nature or row.expense_category or "",
                row.description or "",
                accounts,
            ).get("account_name", "")
            pushed.append({
                "row_index":        row.row_index,
                "employee":         row.employee_name,
                "employee_id":      row.employee_id,
                "amount":           row.bill_amount or row.claimed_amount,
                "bill_id":          bill_id,
                "bill_number":      bill_num,
                "vendor_id":        vendor_id,
                "account":          used_account,
                "expense_category": row.expense_category or "",
                "attached":         attached,
                "zoho_url":         f"https://books.zoho.in/app#/bills/{bill_id}",
            })
        except Exception as e:
            errors.append(f"Row {row.row_index} ({row.employee_name}): {e}")

    # Merge new pushed entries with previous ones and persist to disk
    # (previous entries kept so re-pushes know which rows are already done)
    merged_pushed = list(prev_pushed.values()) + pushed
    # Deduplicate: new entries win over old for the same row_index
    merged_by_row: Dict[int, Dict] = {}
    for e in merged_pushed:
        merged_by_row[int(e["row_index"])] = e

    return {
        "pushed":        pushed,          # only this run's new pushes (for UI display)
        "all_pushed":    list(merged_by_row.values()),   # full history (for status tab)
        "errors":        errors,
        "total":         len(approved),
        "accounts":      [a["account_name"] for a in accounts],
    }
