import os
import re
import pandas as pd
from typing import Dict, List, Tuple, Optional, TYPE_CHECKING
from models.schemas import ExpenseRow

if TYPE_CHECKING:
    from models.schemas import OCRResult

try:
    from thefuzz import fuzz
    FUZZ_AVAILABLE = True
except ImportError:
    try:
        from fuzzywuzzy import fuzz
        FUZZ_AVAILABLE = True
    except ImportError:
        FUZZ_AVAILABLE = False


# Maps internal field name → list of possible column header names (case-insensitive)
# Includes Keka's native Excel export column names (from Reports → Expense Claim Report)
COLUMN_CANDIDATES = {
    "employee_id":      ["employee number", "employee id", "emp id", "emp no", "employee no",
                         "employee code", "emp code", "staff id", "staff code"],
    "employee_name":    ["employee name", "name", "emp name"],
    "expense_date":     ["expense date", "submitted on", "date", "claim date", "submitted on date"],
    "expense_category": ["expense title", "expense category", "category", "title", "expense type",
                         "expense category name", "claim title"],
    "description":      ["description", "remarks", "details", "expense title", "expense description",
                         "comment"],
    "claimed_amount":   ["total amount", "claimed amount", "amount", "claim amount",
                         "amount (inr)", "amount in inr", "total amount (inr)"],
    "claim_number":     ["claim number", "claim no", "claim#", "claim #"],
    "claim_id":         ["claim id", "claim_id", "claimid", "claim uuid"],
    "department":       ["department", "dept", "department name", "team", "business unit", "bu",
                         "sub department"],
}

ATTACHMENT_COLUMNS = [
    "attachment name", "file name", "filename",
    "attachment", "bill name", "receipt name",
]

FILE_MATCH_THRESHOLD = 75


# ─── Helpers ────────────────────────────────────────────────────────────────

def _normalise(s: str) -> str:
    return s.strip().lower().replace("_", " ").replace("-", " ")


def _find_column(df_cols: List[str], candidates: List[str]) -> Optional[str]:
    norm = {_normalise(c): c for c in df_cols}
    for c in candidates:
        if _normalise(c) in norm:
            return norm[_normalise(c)]
    return None


def _find_header_row(excel_path: str) -> int:
    """
    Auto-detect which row contains the actual column headers.
    Looks for a row that contains multiple recognised column-header keywords.
    """
    HEADER_KEYWORDS = {
        "employee number", "employee name", "employee id", "emp id",
        "expense title", "expense category", "claim number", "total amount",
        "claimed amount", "submitted on", "expense date",
    }
    df_raw = pd.read_excel(excel_path, header=None, nrows=10, dtype=str)
    for i, row in df_raw.iterrows():
        vals = {str(v).strip().lower() for v in row if pd.notna(v) and str(v).strip()}
        matches = vals & HEADER_KEYWORDS
        if len(matches) >= 2:   # at least 2 known column names in this row
            return int(i)
    return 0


def _parse_amount(raw: str) -> float:
    """Parse amounts like 'INR 480.0000', '₹480', '1,234.56', '480.00'."""
    if not raw:
        return 0.0
    # Strip currency prefixes
    cleaned = re.sub(r"(?i)(inr|rs\.?|₹)\s*", "", str(raw))
    cleaned = cleaned.replace(",", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _best_fuzzy(query: str, choices: List[str], threshold: int) -> Tuple[Optional[str], int]:
    if not FUZZ_AVAILABLE or not choices:
        return None, 0
    q = query.lower().strip()
    best_key, best_score = None, 0
    for choice in choices:
        score = max(
            fuzz.ratio(q, choice.lower()),
            fuzz.partial_ratio(q, choice.lower()),
            fuzz.token_sort_ratio(q, choice.lower()),
        )
        if score > best_score:
            best_score, best_key = score, choice
    return (best_key, best_score) if best_score >= threshold else (None, 0)


# ─── Claim-folder lookup ────────────────────────────────────────────────────

def _find_claim_folder(
    claim_number: str,
    by_folder: Dict[str, Dict[str, str]],
    claim_id: Optional[str] = None,
    employee_name: Optional[str] = None,
    employee_id: Optional[str] = None,
) -> Tuple[Optional[str], str]:
    """
    Find the ZIP folder for a claim.

    PRIORITY:
      1. claim_id (UUID) — UNIQUE, never duplicated.
      2. claim_number — Keka UI uses "{ClaimNumber}_{Title}".
      3. employee_name / employee_id folder — Bulk receipt zips sometimes
         organise by employee, e.g. "Sidharth Jain/" or "EMP1234/".

    Folder name examples observed in real Keka bulk-receipt zips:
      "04812122-affd-4396-a085-8c92a69fe7f9"  ← UUID
      "2268_Claude", "2253_Travel to CC"     ← {claim_no}_{title}
      "Sidharth Jain", "Tushar Kumar Gupta"  ← employee name
      "EMP2025221"                            ← employee id
    """
    # ── 1. UUID (claim_id) match ──
    if claim_id:
        cid = str(claim_id).strip()
        if cid in by_folder:
            return cid, f"matched folder '{cid}' by claim_id (UUID)"
        for folder_key in by_folder:
            if folder_key.startswith(cid):
                return folder_key, f"matched folder '{folder_key}' by claim_id prefix"

    # ── 2. Claim number match ──
    if claim_number:
        cn = claim_number.strip()
        prefix = f"{cn}_"
        for folder_key in by_folder:
            if folder_key == cn or folder_key.startswith(prefix):
                return folder_key, f"matched folder '{folder_key}' by claim number"
        for folder_key in by_folder:
            folder_base = folder_key.split("_")[0].strip()
            if folder_base == cn:
                return folder_key, f"matched folder '{folder_key}' by claim prefix"

    # ── 3. Employee-name folder match (Bulk Receipt sometimes groups this way) ──
    if employee_name:
        en = employee_name.strip().lower()
        en_compact = en.replace(" ", "").replace("_", "")
        for folder_key in by_folder:
            fk_lower = folder_key.strip().lower()
            fk_compact = fk_lower.replace(" ", "").replace("_", "")
            if fk_lower == en or fk_compact == en_compact:
                return folder_key, f"matched folder '{folder_key}' by employee name"
            # Match if folder name CONTAINS employee name (e.g. "2293_Sidharth Jain_Late Night")
            if en in fk_lower:
                return folder_key, f"matched folder '{folder_key}' by employee name (contains)"

    # ── 4. Employee ID folder match ──
    if employee_id:
        eid = str(employee_id).strip()
        for folder_key in by_folder:
            if folder_key.strip() == eid or folder_key.startswith(eid + "_") or folder_key.endswith("_" + eid):
                return folder_key, f"matched folder '{folder_key}' by employee_id"

    target = claim_number or claim_id or employee_name or "(no identifier)"
    return None, f"no folder found for claim '{target}'"


# ─── Bill-within-folder lookup ──────────────────────────────────────────────

def _filter_files_by_claim_id(
    filenames: List[str],
    claim_id: Optional[str] = None,
    claim_number: Optional[str] = None,
) -> Tuple[List[str], str]:
    """
    Filter filenames to those whose name contains claim_id (UUID) or
    claim_number — used ONLY for employee-name folders that may contain
    bills from multiple claims.
    Returns (filtered, note); falls back to all bills if filter returns 0.
    """
    matched: List[str] = []

    if claim_id:
        cid_lc = str(claim_id).strip().lower()
        cid_short = cid_lc.split("-")[0] if "-" in cid_lc else cid_lc[:8]
        for f in filenames:
            f_lc = f.lower()
            if cid_lc in f_lc or (len(cid_short) >= 6 and cid_short in f_lc):
                matched.append(f)

    if not matched and claim_number:
        cn = str(claim_number).strip()
        import re as _re
        pat = _re.compile(rf"(?:^|[_\-\s\(]){_re.escape(cn)}(?:[_\-\s\.\)]|$)")
        for f in filenames:
            if pat.search(f):
                matched.append(f)

    if matched:
        return matched, (
            f"large folder dual-filter: {len(matched)} of {len(filenames)} files "
            f"match claim_id/number"
        )
    # Fallback: large folder but no markers → still take all (safer than 0)
    return filenames, "large folder; no claim markers — using all bills"


def _find_bills_in_folder(
    attachment_name: Optional[str],
    folder_files: Dict[str, str],
    folder_key: str,
    claim_id: Optional[str] = None,
    claim_number: Optional[str] = None,
    matched_by_employee: bool = False,
) -> Tuple[List[str], str]:
    """
    Return bill display_keys from the claim folder.

    UNIVERSAL RULE: take EVERY bill in the matched folder.
    Validator will sum their OCR amounts and compare against claimed_amount.

    EXCEPTION: if the folder was matched by EMPLOYEE NAME (not claim_id /
    claim_number), the folder may contain bills from MULTIPLE claims of
    that employee. Apply a filename-level dual check to keep only this
    claim's bills. If filter returns nothing, fall back to all bills.
    """
    filenames = list(folder_files.keys())
    folder_key_note: Optional[str] = None

    # Dual check ONLY for employee-name folders (potential cross-claim mixing)
    if matched_by_employee and (claim_id or claim_number) and len(filenames) > 1:
        filtered, dual_note = _filter_files_by_claim_id(filenames, claim_id, claim_number)
        if filtered != filenames and len(filtered) > 0:
            filenames = filtered
            folder_key_note = dual_note

    def make_key(fname: str) -> str:
        return f"{folder_key}/{fname}" if folder_key else fname

    if not filenames:
        return [], "empty claim folder"

    # If no specific attachment requested — return ALL bills (post dual-check)
    if not attachment_name:
        keys = [make_key(f) for f in filenames]
        if folder_key_note:
            note = f"{folder_key_note}; {len(filenames)} bill(s) assigned"
        else:
            note = (
                f"auto-assigned (only bill in claim folder)" if len(filenames) == 1
                else f"all {len(filenames)} bills in claim folder assigned"
            )
        return keys, note

    att = attachment_name.strip()

    # 1. Exact match
    if att in folder_files:
        return [make_key(att)], "exact filename match"

    # 2. Case-insensitive
    att_lower = att.lower()
    for f in filenames:
        if f.lower() == att_lower:
            return [make_key(f)], "case-insensitive filename match"

    # 3. Fuzzy filename
    att_base = os.path.splitext(att)[0].lower()
    if FUZZ_AVAILABLE:
        best_key, best_score = None, 0
        for f in filenames:
            f_base = os.path.splitext(f)[0].lower()
            score = fuzz.ratio(att_base, f_base)
            if score > best_score:
                best_score, best_key = score, f
        if best_score >= FILE_MATCH_THRESHOLD and best_key:
            return [make_key(best_key)], f"fuzzy filename match '{best_key}' ({best_score}%)"

    # 4. Not found — return all files as fallback
    keys = [make_key(f) for f in filenames]
    return keys, f"file '{att}' not found; assigned all {len(filenames)} bills in folder"


# ─── Excel reader ────────────────────────────────────────────────────────────

def read_excel_rows(excel_path: str) -> Tuple[List[ExpenseRow], List[str]]:
    warnings: List[str] = []

    # Auto-detect which row is the header
    header_row = _find_header_row(excel_path)
    df = pd.read_excel(excel_path, header=header_row, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]

    col_map: Dict[str, str] = {}
    for field, candidates in COLUMN_CANDIDATES.items():
        col = _find_column(df.columns.tolist(), candidates)
        if col:
            col_map[field] = col
        elif field not in ("claim_number", "description"):
            warnings.append(f"Column not found for '{field}' (tried: {candidates})")

    attachment_col = _find_column(df.columns.tolist(), ATTACHMENT_COLUMNS)

    rows: List[ExpenseRow] = []
    for i, row in df.iterrows():
        def get(field: str, default: str = "") -> str:
            col = col_map.get(field)
            if col and col in row:
                v = str(row[col]).strip()
                return "" if v.lower() in ("nan", "none", "") else v
            return default

        # Skip footer/empty rows (no employee number)
        emp_id_raw = get("employee_id")
        if not emp_id_raw or emp_id_raw.lower().startswith("generated"):
            continue

        claimed_raw = get("claimed_amount", "0")
        claimed = _parse_amount(claimed_raw)

        attachment = ""
        if attachment_col:
            v = str(row[attachment_col]).strip()
            attachment = "" if v.lower() in ("nan", "none", "") else v

        # Use expense_title for both category and description when description is blank
        category = get("expense_category")
        description = get("description") or category

        dept_raw = get("department") or ""
        department = dept_raw.strip() if dept_raw.strip() and dept_raw.lower() not in ("nan", "none") else None

        rows.append(ExpenseRow(
            row_index=int(i) + 2,
            employee_name=get("employee_name"),
            employee_id=emp_id_raw,
            expense_date=get("expense_date"),
            expense_category=category,
            description=description,
            claimed_amount=claimed,
            claim_number=get("claim_number") or None,
            attachment_name=attachment or None,
            department=department,
            keka_claim_id=get("claim_id") or None,
        ))

    return rows, warnings


# ─── Main matching entry point ───────────────────────────────────────────────

def match_bills_to_rows(
    rows: List[ExpenseRow],
    by_folder: Dict[str, Dict[str, str]],
    all_files: Dict[str, str],
) -> Tuple[List[ExpenseRow], List[str]]:
    """
    Match each ExpenseRow to a bill.

    Primary: find the claim's folder (named "{ClaimNumber}_{Title}"),
             then auto-assign the bill inside it.
    Fallback: flat file search by attachment_name.
    """
    used_files: Dict[str, List[int]] = {}
    mapped_keys: set = set()

    for row in rows:
        display_key = None

        bill_keys: List[str] = []

        # Track whether this row has a strict claim_id — if yes, NEVER fall
        # back to global fuzzy matching (would pick bills from OTHER claims).
        has_strict_claim_id = bool(row.keka_claim_id)

        # ── Primary: claim_id (UUID) → claim_number → employee name/ID folder ──
        if row.keka_claim_id or row.claim_number or row.employee_name:
            folder_key, folder_note = _find_claim_folder(
                row.claim_number, by_folder,
                claim_id=row.keka_claim_id,
                employee_name=row.employee_name,
                employee_id=row.employee_id,
            )
            if folder_key is not None:
                folder_files = by_folder[folder_key]
                # Universal rule: take ALL bills in the matched folder.
                # The validator sums their OCR amounts vs claimed_amount.
                # Dual filename filter ONLY applied for employee-name folders
                # (where multiple claims of the same employee may be mixed).
                matched_by_employee = "by employee" in folder_note
                bill_keys, bill_note = _find_bills_in_folder(
                    None,
                    folder_files, folder_key,
                    claim_id=row.keka_claim_id,
                    claim_number=row.claim_number,
                    matched_by_employee=matched_by_employee,
                )
                if bill_keys:
                    row.matched_files = bill_keys
                    row.matched_file = bill_keys[0]
                    row.remarks.append(f"Matched via {folder_note} — {bill_note}")
                else:
                    row.remarks.append(f"Claim folder found ({folder_note}) but {bill_note}")
            else:
                row.remarks.append(folder_note)

        # ── Fallback A: EXACT attachment_name match (safe even in strict mode) ──
        # Keka filenames are unique (UUIDs / timestamps), so an exact filename
        # match across the zip is reliable and won't cause cross-claim mixing.
        # Allowed for both strict (claim_id present) and lax rows.
        if not row.matched_file and row.attachment_name:
            att = row.attachment_name.strip()
            # Excel may list several attachments separated by ";" or ","
            att_list = [a.strip() for a in att.replace(";", ",").split(",") if a.strip()]
            exact_hits: List[str] = []
            for one_att in att_list:
                for dk in all_files:
                    fname = os.path.basename(dk)
                    if fname == one_att or fname.lower() == one_att.lower():
                        if dk not in exact_hits:
                            exact_hits.append(dk)
            if exact_hits:
                row.matched_files = exact_hits
                row.matched_file = exact_hits[0]
                row.remarks.append(
                    f"Exact filename match — {len(exact_hits)} bill(s) found"
                )

        # ── Fallback B: FUZZY filename match (BLOCKED for strict claim_id rows) ──
        if not row.matched_file and row.attachment_name and not has_strict_claim_id:
            att = row.attachment_name.strip()
            if FUZZ_AVAILABLE:
                att_base = os.path.splitext(att)[0].lower()
                best_key, best_score = None, 0
                for dk in all_files:
                    base = os.path.splitext(os.path.basename(dk))[0].lower()
                    score = fuzz.ratio(att_base, base)
                    if score > best_score:
                        best_score, best_key = score, dk
                if best_score >= FILE_MATCH_THRESHOLD and best_key:
                    row.matched_file = best_key
                    row.matched_files = [best_key]
                    row.remarks.append(f"Flat fuzzy match: '{best_key}' ({best_score}%)")
                else:
                    row.remarks.append(f"Bill not found in ZIP: '{att}'")
        elif not row.matched_file and has_strict_claim_id:
            row.remarks.append(
                "Strict claim_id matching: no folder/exact-filename match → skipping fuzzy "
                "(prevents cross-claim contamination)"
            )

        for k in row.matched_files:
            mapped_keys.add(k)
            used_files.setdefault(k, []).append(row.row_index)

    # ── Duplicate detection ──────────────────────────────────────────────────
    for display_key, row_indices in used_files.items():
        if len(row_indices) > 1:
            for row in rows:
                if row.matched_file == display_key:
                    row.is_duplicate = True
                    row.remarks.append(
                        f"Duplicate Attachment — same bill used in rows {row_indices}"
                    )

    all_display_keys = set(all_files.keys())
    unmapped = sorted(all_display_keys - mapped_keys)
    return rows, unmapped


# ─── Amount-based fallback (second pass, after OCR) ─────────────────────────

def match_by_amount_fallback(
    rows: List[ExpenseRow],
    by_folder: Dict[str, Dict[str, str]],
    all_files: Dict[str, str],
    ocr_map: Dict,
    amount_tolerance: float = 50.0,
) -> List[ExpenseRow]:
    """
    Second-pass matching for rows still unmatched after claim-folder matching.
    Searches unassigned bills globally for the closest OCR amount.

    SKIPPED for rows with `keka_claim_id` — UUID matching is strict, no
    cross-claim guessing allowed.
    """
    already_used = {r.matched_file for r in rows if r.matched_file}

    for row in rows:
        if row.matched_file:
            continue

        # Skip global amount-based matching for strict claim_id rows —
        # would pull bills from other claims into the wrong row.
        if row.keka_claim_id:
            continue

        candidates = [k for k in all_files.keys() if k not in already_used]
        if not candidates:
            continue

        best_key: Optional[str] = None
        best_diff = float("inf")

        for dk in candidates:
            ocr = ocr_map.get(dk)
            if ocr and ocr.total_amount is not None:
                diff = abs(row.claimed_amount - ocr.total_amount)
                if diff < best_diff:
                    best_diff = diff
                    best_key = dk

        if best_key is not None and best_diff <= amount_tolerance:
            row.matched_file = best_key
            already_used.add(best_key)
            row.remarks.append(
                f"Amount-based fallback match — "
                f"bill amount INR {ocr_map[best_key].total_amount:,.2f}, "
                f"diff INR {best_diff:.2f}"
            )
        elif best_key is not None and candidates:
            row.matched_file = best_key
            already_used.add(best_key)
            row.remarks.append(
                f"Best-available bill assigned (diff INR {best_diff:.2f} > INR {amount_tolerance} tolerance) — "
                f"amount mismatch expected"
            )
        elif candidates:
            row.remarks.append("No OCR amount extracted from any unassigned bill — manual review needed")

    return rows
