"""
Zoho entry verification agent — uses Claude to check each pushed bill
against OCR text from its bill PDF and flags mismatches.
"""
import os
import json
import re
from typing import List, Dict, Optional

try:
    import anthropic as _anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


def _claude_verify(
    employee: str,
    claimed_amount: float,
    bill_amount: Optional[float],
    account: str,
    description: str,
    expense_category: str,
    ocr_texts: List[str],
    attached_count: int = 0,
    unique_attached_count: int = 0,
) -> Dict:
    # Pre-checks that don't need Claude
    issues_pre: List[str] = []
    if attached_count > unique_attached_count:
        issues_pre.append(f"Duplicate attachments detected ({attached_count - unique_attached_count} removed)")
    if bill_amount is not None and abs(claimed_amount - bill_amount) > 5:
        issues_pre.append(f"Bill total ₹{bill_amount:.2f} does not match claimed ₹{claimed_amount:.2f}")

    if not ANTHROPIC_AVAILABLE:
        ok = not issues_pre and (bill_amount is None or abs(claimed_amount - (bill_amount or 0)) < 5)
        return {
            "ok": ok,
            "confidence": 0.5,
            "issues": issues_pre or ([] if ok else ["Amount mismatch"]),
            "summary": "Basic checks only (Claude not available).",
        }

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        ok = len(issues_pre) == 0
        return {
            "ok": ok,
            "confidence": 0.0 if ok else 0.8,
            "issues": issues_pre,
            "summary": "Pre-checks passed." if ok else "; ".join(issues_pre),
        }

    client = _anthropic.Anthropic(api_key=api_key)
    ocr_combined = "\n\n---\n\n".join(ocr_texts[:3]) if ocr_texts else "(no OCR text)"

    pre_issues_txt = ("\n\nPre-check flags (already detected):\n" + "\n".join(f"- {i}" for i in issues_pre)) if issues_pre else ""

    prompt = f"""You are a finance auditor verifying a Zoho Books vendor bill entry for employee reimbursement.

BILL ENTRY:
- Employee (vendor): {employee}
- Claimed amount: ₹{claimed_amount:.2f}
- Bill amount from OCR: {f"₹{bill_amount:.2f}" if bill_amount is not None else "not extracted"}
- Expense account: {account}
- Category: {expense_category}
- Description: {description}
- Attachments: {unique_attached_count} unique file(s) attached{pre_issues_txt}

BILL OCR TEXT:
{ocr_combined[:3000]}

Verify:
1. Does the total/grand total in the OCR bill match ₹{claimed_amount:.2f}? (within ₹5 tolerance). If multiple OCR docs, do their totals sum to the claimed amount?
2. Is the expense account "{account}" correct for "{expense_category}" / "{description}"?
3. Any red flags (duplicate amounts across attachments, suspicious details, wrong dates)?

Respond ONLY with JSON (no markdown):
{{"ok": true/false, "confidence": 0.0-1.0, "issues": ["..."], "summary": "one sentence"}}"""

    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            result = json.loads(m.group())
            # Merge pre-check issues
            result["issues"] = issues_pre + result.get("issues", [])
            if issues_pre:
                result["ok"] = False
            return result
        return {"ok": False, "confidence": 0.0, "issues": issues_pre + ["Parse error"], "summary": text[:200]}
    except Exception as e:
        return {"ok": False, "confidence": 0.0, "issues": issues_pre + [f"Claude error: {e}"], "summary": "Verification error."}


def _check_zoho_duplicate(bill_number: str) -> Optional[str]:
    """
    Query Zoho API to check if a bill with this number already exists.
    Returns existing bill_id if found, else None.
    Silently returns None on any error (verifier should never crash the main flow).
    """
    try:
        from services.zoho import _get_access_token, _bill_exists
        token = _get_access_token()
        return _bill_exists(token, bill_number)
    except Exception:
        return None


def verify_zoho_entries(pushed: List[Dict], rows_by_index: Dict, all_pushed: Optional[List[Dict]] = None) -> List[Dict]:
    """
    For each pushed bill, run AI verification using the row's OCR texts.
    Returns list of verification dicts keyed by row_index.
    """
    # Build duplicate-claim index from full session history (in-session check)
    dup_bill_map: dict = {}   # row_index → list of bill numbers that already exist
    if all_pushed:
        from collections import defaultdict
        seen: dict = defaultdict(list)
        for e in all_pushed:
            seen[int(e["row_index"])].append(e.get("bill_number") or e.get("bill_id", "?"))
        for ri, bills in seen.items():
            if len(bills) > 1:
                dup_bill_map[ri] = bills

    results = []
    for entry in pushed:
        row = rows_by_index.get(entry["row_index"])
        if row is None:
            results.append({"row_index": entry["row_index"], "ok": None, "summary": "Row not found"})
            continue

        # Pre-check: duplicate bill for same claim (in-session)
        extra_pre: List[str] = []
        if entry["row_index"] in dup_bill_map:
            extra_pre.append(
                f"Duplicate bill detected — claim row {entry['row_index']} pushed "
                f"{len(dup_bill_map[entry['row_index']])} times: "
                + ", ".join(dup_bill_map[entry["row_index"]])
            )

        # Cross-session duplicate check via Zoho API
        bill_num = entry.get("bill_number", "")
        if bill_num:
            existing = _check_zoho_duplicate(bill_num)
            current_bill_id = entry.get("bill_id", "")
            if existing and existing != current_bill_id:
                extra_pre.append(
                    f"Cross-session duplicate: bill number {bill_num} already exists in Zoho "
                    f"(bill_id: {existing}) — possible duplicate push from a previous session"
                )

        ocr_texts = [r.raw_text for r in (row.ocr_results or []) if r and r.raw_text]
        attached = entry.get("attached", [])
        unique_attached_count = len(attached)
        all_matched = list(dict.fromkeys(
            (row.matched_files or []) + ([row.matched_file] if row.matched_file else [])
        ))
        total_matched = len([k for k in all_matched if k])

        verification = _claude_verify(
            employee=entry["employee"],
            claimed_amount=float(entry["amount"]),
            bill_amount=row.bill_amount,
            account=entry.get("account", ""),
            description=row.description or "",
            expense_category=row.expense_category or "",
            ocr_texts=ocr_texts,
            attached_count=total_matched,
            unique_attached_count=unique_attached_count,
        )
        # Merge duplicate-claim pre-check issues in
        if extra_pre:
            verification["issues"] = extra_pre + verification.get("issues", [])
            verification["ok"] = False
        results.append({
            "row_index":  entry["row_index"],
            "employee":   entry["employee"],
            "bill_id":    entry.get("bill_id", ""),
            "bill_number": entry.get("bill_number", ""),
            "zoho_url":   entry.get("zoho_url", ""),
            "attached":   entry.get("attached", []),
            **verification,
        })
    return results
