import json as _json
import os as _os
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor as _TPE
from functools import lru_cache
from typing import List, Dict, Optional, Tuple
from models.schemas import ExpenseRow, OCRResult, ExpenseStatus

try:
    import requests as _requests
    _REQUESTS_AVAILABLE = True
except ImportError:
    _REQUESTS_AVAILABLE = False

# ── Disk-based rate cache ─────────────────────────────────────────────────────
_CACHE_PATH = _os.path.join(_os.path.dirname(__file__), "..", "data", "usd_inr_rates.json")
_os.makedirs(_os.path.dirname(_CACHE_PATH), exist_ok=True)

def _load_rate_cache() -> dict:
    try:
        with open(_CACHE_PATH, encoding="utf-8") as f:
            return _json.load(f)
    except Exception:
        return {}

def _save_rate_cache(cache: dict):
    try:
        with open(_CACHE_PATH, "w", encoding="utf-8") as f:
            _json.dump(cache, f)
    except Exception:
        pass

_disk_rates: dict = _load_rate_cache()

try:
    from thefuzz import fuzz
    FUZZ_AVAILABLE = True
except ImportError:
    try:
        from fuzzywuzzy import fuzz
        FUZZ_AVAILABLE = True
    except ImportError:
        FUZZ_AVAILABLE = False

# ─── Thresholds ──────────────────────────────────────────────────────────────
AMOUNT_TOLERANCE     = 5.0    # ₹ — INR bills: strict ±₹5 tolerance
DATE_TOLERANCE_DAYS  = 2      # ± days
VENDOR_FUZZY_MIN     = 70     # % partial ratio
OCR_CONFIDENCE_MIN   = 0.30   # below → flag for manual review

# USD → INR fallback rate (used only when live rate fetch fails)
USD_TO_INR           = 93.0

# Keywords that indicate the bill is likely in USD
USD_BILL_KEYWORDS = {
    "openai", "open ai", "chatgpt", "anthropic", "claude", "midjourney",
    "github", "figma", "notion", "zoom", "slack", "adobe", "aws",
    "amazon web", "google cloud", "azure", "heroku", "vercel",
    "stripe", "digitalocean", "netlify",
}

DATE_FORMATS = [
    "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    "%d/%m/%y", "%d-%m-%y",
]

# Map expense categories to a clean "nature" label shown in the output
NATURE_MAP = {
    "travel":        "Travel & Transport",
    # ── Travel & Transport ───────────────────────────────────────────────────
    "transport":     "Travel & Transport",
    "cab":           "Travel & Transport",
    "flight":        "Travel & Transport",
    "train":         "Travel & Transport",
    "bus":           "Travel & Transport",
    "metro":         "Travel & Transport",
    "auto":          "Travel & Transport",
    "taxi":          "Travel & Transport",
    "uber":          "Travel & Transport",
    "ola":           "Travel & Transport",

    # ── Conveyance (two-wheeler apps) ────────────────────────────────────────
    "rapido":        "Conveyance",
    "bike taxi":     "Conveyance",
    "conveyance":    "Conveyance",

    # ── Staff Welfare (food / eating / snacks) ────────────────────────────────
    "food":          "Staff Welfare",
    "meal":          "Staff Welfare",
    "lunch":         "Staff Welfare",
    "dinner":        "Staff Welfare",
    "breakfast":     "Staff Welfare",
    "snack":         "Staff Welfare",
    "tea":           "Staff Welfare",
    "coffee":        "Staff Welfare",
    "canteen":       "Staff Welfare",
    "swiggy":        "Staff Welfare",
    "zomato":        "Staff Welfare",
    "restaurant":    "Staff Welfare",
    "cafe":          "Staff Welfare",
    "refreshment":   "Staff Welfare",
    "staff welfare": "Staff Welfare",

    # ── Subscriptions (AI tools & software) ──────────────────────────────────
    "openai":        "Subscription",
    "open ai":       "Subscription",
    "chatgpt":       "Subscription",
    "claude":        "Subscription",
    "anthropic":     "Subscription",
    "gemini":        "Subscription",
    "copilot":       "Subscription",
    "midjourney":    "Subscription",
    "perplexity":    "Subscription",
    "github":        "Subscription",
    "notion":        "Subscription",
    "slack":         "Subscription",
    "zoom":          "Subscription",
    "figma":         "Subscription",
    "adobe":         "Subscription",
    "software":      "Subscription",
    "subscription":  "Subscription",
    "saas":          "Subscription",
    "license":       "Subscription",
    "annual plan":   "Subscription",
    "monthly plan":  "Subscription",

    # ── Accommodation ────────────────────────────────────────────────────────
    "accommodation": "Accommodation",
    "hotel":         "Accommodation",
    "lodging":       "Accommodation",
    "oyo":           "Accommodation",
    "airbnb":        "Accommodation",

    # ── Office Supplies ──────────────────────────────────────────────────────
    "office":        "Office Supplies",
    "supply":        "Office Supplies",
    "stationery":    "Office Supplies",
    "printer":       "Office Supplies",

    # ── Medical ──────────────────────────────────────────────────────────────
    "medical":       "Medical & Health",
    "health":        "Medical & Health",
    "medicine":      "Medical & Health",
    "pharmacy":      "Medical & Health",

    # ── Internet & Communication ──────────────────────────────────────────────
    "internet":      "Internet & Communication",
    "broadband":     "Internet & Communication",
    "phone":         "Internet & Communication",
    "mobile":        "Internet & Communication",
    "recharge":      "Internet & Communication",

    # ── Training ─────────────────────────────────────────────────────────────
    "training":      "Training & Development",
    "course":        "Training & Development",
    "workshop":      "Training & Development",
    "seminar":       "Training & Development",

    # ── Fuel & Vehicle ───────────────────────────────────────────────────────
    "fuel":          "Fuel & Vehicle",
    "petrol":        "Fuel & Vehicle",
    "diesel":        "Fuel & Vehicle",
    "vehicle":       "Fuel & Vehicle",
    "parking":       "Fuel & Vehicle",
    "toll":          "Fuel & Vehicle",

    # ── Miscellaneous ────────────────────────────────────────────────────────
    "misc":          "Miscellaneous",
    "other":         "Miscellaneous",
}

# Rules checked BEFORE the keyword map (higher priority, exact phrase match)
_PRIORITY_RULES = [
    # (phrase_in_text,          label)
    ("rapido",                  "Conveyance"),
    ("openai",                  "Subscription"),
    ("open ai",                 "Subscription"),
    ("chatgpt",                 "Subscription"),
    ("claude",                  "Subscription"),
    ("anthropic",               "Subscription"),
    ("staff welfare",           "Staff Welfare"),
    ("swiggy",                  "Staff Welfare"),
    ("zomato",                  "Staff Welfare"),
]


def _tag_expense_nature(category: str, description: str) -> str:
    """
    Classify the expense into a nature tag.

    Priority order:
      1. Priority rules (exact phrase — rapido, openai, claude, swiggy etc.)
      2. Keyword map (word-by-word scan of category + description)
      3. Raw category title as fallback
    """
    text = f"{category} {description}".lower()

    # 1. Priority rules first
    for phrase, label in _PRIORITY_RULES:
        if phrase in text:
            return label

    # 2. Keyword map
    for keyword, label in NATURE_MAP.items():
        if keyword in text:
            return label

    # 3. Fallback
    return category.title() if category else "Miscellaneous"


def _parse_date(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    s = s.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _date_to_iso(date_str: Optional[str]) -> Optional[str]:
    dt = _parse_date(date_str)
    return dt.strftime("%Y-%m-%d") if dt else None


@lru_cache(maxsize=256)
def _get_usd_inr_rate(date_iso: str) -> float:
    """
    Fetch historical USD/INR rate.
    Order: memory cache (lru_cache) → disk cache → Frankfurter API → fallback.
    """
    if date_iso in _disk_rates:
        return float(_disk_rates[date_iso])
    if not _REQUESTS_AVAILABLE:
        return USD_TO_INR
    try:
        resp = _requests.get(
            f"https://api.frankfurter.app/{date_iso}",
            params={"from": "USD", "to": "INR"},
            timeout=3,
        )
        if resp.ok:
            rate = float(resp.json()["rates"]["INR"])
            _disk_rates[date_iso] = rate
            _save_rate_cache(_disk_rates)
            return rate
    except Exception:
        pass
    return USD_TO_INR


def prefetch_usd_rates(rows: List) -> None:
    """Pre-fetch rates for all unique USD-bill dates in parallel before validation."""
    dates = set()
    for row in rows:
        if _is_usd_bill(row.expense_category or "", row.description or "", ""):
            iso = _date_to_iso(row.expense_date)
            if iso and iso not in _disk_rates:
                dates.add(iso)
    if not dates:
        return
    with _TPE(max_workers=min(8, len(dates))) as pool:
        list(pool.map(_get_usd_inr_rate, dates))


# ─── Individual checks ───────────────────────────────────────────────────────

def _is_usd_bill(category: str, description: str, ocr_text: str = "") -> bool:
    """Return True if this expense is likely billed in USD (cloud/SaaS services)."""
    text = f"{category} {description} {ocr_text}".lower()
    return any(kw in text for kw in USD_BILL_KEYWORDS)


def _check_amount(
    claimed: float,
    ocr_amount: Optional[float],
    category: str = "",
    description: str = "",
    ocr_text: str = "",
    **kwargs,
) -> Optional[str]:
    """PRIMARY check — determines Approved vs Rejected.
    For USD-billed services (Claude, OpenAI, etc.) OCR amount is converted
    to INR at USD_TO_INR rate before comparison.
    """
    if ocr_amount is None:
        return None

    effective_ocr = ocr_amount
    currency_note = ""

    # If OCR amount is much smaller than claimed AND it's a USD-billed service,
    # treat it as dollars and convert to INR.
    if _is_usd_bill(category, description, ocr_text):
        rate = USD_TO_INR
        date_iso = _date_to_iso(kwargs.get("expense_date"))
        if date_iso:
            rate = _get_usd_inr_rate(date_iso)
        converted = round(ocr_amount * rate, 2)
        if abs(claimed - converted) < abs(claimed - ocr_amount):
            effective_ocr = converted
            currency_note = f" (USD ${ocr_amount:.2f} × ₹{rate:.2f}/$ = ₹{converted:,.2f})"

    diff = claimed - effective_ocr
    if abs(diff) > AMOUNT_TOLERANCE:
        direction = "overclaimed" if diff > 0 else "underclaimed"
        return (
            f"Amount Mismatch ({direction}) — "
            f"claimed ₹{claimed:,.2f}, bill ₹{effective_ocr:,.2f}{currency_note}, "
            f"diff ₹{abs(diff):,.2f}"
        )
    return None


def _check_date(claimed_str: str, ocr_date_str: Optional[str]) -> Optional[str]:
    if not ocr_date_str:
        return None
    cd = _parse_date(claimed_str)
    od = _parse_date(ocr_date_str)
    if cd is None or od is None:
        return None
    delta = abs((cd - od).days)
    if delta > DATE_TOLERANCE_DAYS:
        return (
            f"Date Mismatch — claimed {claimed_str}, "
            f"bill {ocr_date_str} ({delta} days apart)"
        )
    return None


def _check_vendor(description: str, ocr_vendor: Optional[str]) -> Optional[str]:
    if not ocr_vendor or not description or not FUZZ_AVAILABLE:
        return None
    score = fuzz.partial_ratio(description.lower(), ocr_vendor.lower())
    if score < VENDOR_FUZZY_MIN:
        return (
            f"Vendor Mismatch — description '{description}' vs "
            f"bill vendor '{ocr_vendor}' ({score}% match)"
        )
    return None


def _total_line_unreadable(raw_text: str) -> bool:
    """
    Returns True if the bill contains a 'Total' keyword but no readable number
    follows it on the same or adjacent line.  This signals a garbled/handwritten
    total that OCR could not decode — used to downgrade Rejected → Flagged when
    vision is unavailable, so a human reviewer can check instead.
    """
    import re as _re
    if not raw_text:
        return False
    if not _re.search(r'\btotal\b', raw_text, _re.IGNORECASE):
        return False   # no Total line at all
    # Readable number within ~20 chars after "Total"
    return not bool(_re.search(
        r'\btotal\b[^a-zA-Z0-9\n]{0,20}[₹$]?\s*[0-9,]+\.?[0-9]*',
        raw_text, _re.IGNORECASE
    ))


# ─── Per-row validation ──────────────────────────────────────────────────────

def _sum_bill_amounts(
    row: ExpenseRow,
    ocr_results: list,
    file_paths: Optional[List[str]] = None,
) -> Tuple[Optional[float], List[str]]:
    """
    Sum amounts from all OCR results for a multi-bill claim.
    Returns (total_amount, list_of_notes).
    """
    amounts = []
    notes = []
    is_usd = _is_usd_bill(row.expense_category, row.description,
                           " ".join(r.raw_text for r in ocr_results))

    # Resolve live exchange rate once per row using expense date
    usd_rate = USD_TO_INR
    if is_usd:
        date_iso = _date_to_iso(row.expense_date)
        if date_iso:
            usd_rate = _get_usd_inr_rate(date_iso)

    num_bills = len(ocr_results)
    from services.ocr import extract_amount as _extract_amount

    # Track (amount, original_0idx) so post-sum vision uses the correct file.
    # Bills that return None are tracked separately — vision is tried on them
    # later if the running total is still off from claimed.
    indexed_amounts: list = []   # [(amount_float, orig_0idx)]
    none_indices:    list = []   # [orig_0idx]  for bills OCR couldn't read

    for i, ocr in enumerate(ocr_results, 1):
        orig_idx = i - 1
        hint = row.claimed_amount if num_bills == 1 else None

        if ocr.total_amount is None and ocr.raw_text:
            ocr.total_amount = _extract_amount(ocr.raw_text, claimed_hint=hint)
        elif ocr.total_amount is not None and ocr.raw_text and hint is not None:
            reextracted = _extract_amount(ocr.raw_text, claimed_hint=hint)
            if reextracted is not None and abs(reextracted - hint) < abs(ocr.total_amount - hint):
                ocr.total_amount = reextracted

        # ── USD-aware re-extraction ───────────────────────────────────────────
        # For USD subscription bills (Claude, OpenAI etc.), OCR often reads a
        # wrong INR number (invoice ID, tax total, usage figure) while the actual
        # charge is a "$xxx.xx" value that, when converted at today's rate, matches
        # the claimed amount. Scan raw text for dollar amounts; if any converts
        # closer to claimed than current reading, use it.
        if is_usd and ocr.raw_text and hint is not None:
            import re as _re
            usd_best, usd_best_diff = None, abs(ocr.total_amount - hint) if ocr.total_amount else float('inf')
            for m in _re.findall(r'\$\s*(\d{1,6}\.?\d*)', ocr.raw_text):
                try:
                    v = float(m)
                    if 1 < v < 100000:              # plausible USD range
                        converted = round(v * usd_rate, 2)
                        diff = abs(converted - hint)
                        if diff < usd_best_diff:
                            usd_best_diff = diff
                            usd_best = converted
                except ValueError:
                    pass
            if usd_best is not None:
                notes.append(f"Bill {i}: USD amount found → ₹{usd_best:,.2f} (converted at ₹{usd_rate:.2f}/$)")
                ocr.total_amount = usd_best

        # ── FIX 1: Sanity cap on absurd OCR values ────────────────────────────
        # OCR sometimes reads barcodes, GSTINs, or phone numbers as huge amounts.
        # If a single bill reads > 3× the total claimed amount, it's garbage — skip it.
        if ocr.total_amount is not None and row.claimed_amount > 0:
            if ocr.total_amount > row.claimed_amount * 3:
                notes.append(
                    f"Bill {i}: OCR read implausible ₹{ocr.total_amount:,.2f} "
                    f"(> 3× claimed ₹{row.claimed_amount:,.2f}) — ignoring, needs manual check"
                )
                ocr.total_amount = None

        # Vision fallback (single-bill only): fires when OCR is significantly off
        # in EITHER direction. For multi-bill, vision is handled in post-sum below.
        _vision_threshold = max(50.0, (hint or 0) * 0.15) if hint else 9999
        if (hint is not None
                and ocr.total_amount is not None
                and abs(ocr.total_amount - hint) > _vision_threshold):
            fp = file_paths[orig_idx] if file_paths and orig_idx < len(file_paths) else None
            if fp:
                from services.ocr import extract_amount_vision as _vision_amt
                vision_val = _vision_amt(fp, claimed_hint=hint)
                if vision_val is not None and abs(vision_val - hint) < abs(ocr.total_amount - hint):
                    notes.append(f"Bill {i}: vision read ₹{vision_val:,.2f} (OCR had ₹{ocr.total_amount:,.2f})")
                    ocr.total_amount = vision_val

        if ocr.total_amount is None:
            notes.append(f"Bill {i}: amount not extractable")
            none_indices.append(orig_idx)
            continue
        amt = ocr.total_amount
        if is_usd:
            converted = round(amt * usd_rate, 2)
            if abs(row.claimed_amount - converted) < abs(row.claimed_amount - amt):
                notes.append(f"Bill {i}: ${amt:.2f} × ₹{usd_rate:.2f}/$ = ₹{converted:,.2f}")
                amt = converted
        indexed_amounts.append((amt, orig_idx))

    amounts = [a for a, _ in indexed_amounts]

    if not amounts:
        return None, notes

    if len(amounts) == 1 and not none_indices:
        return round(amounts[0], 2), notes

    claimed = row.claimed_amount

    # ── Multi-bill: try vision on bills OCR couldn't read ─────────────────────
    # If total is already off (or unknown because some bills have None), ask
    # Vision to read each None-result bill using hint = remaining claimed amount.
    if file_paths and none_indices and claimed > 0:
        from services.ocr import extract_amount_vision as _vision_amt
        running = sum(amounts)
        for orig_j in none_indices:
            remaining = round(claimed - running, 2)
            if remaining <= 0:
                break
            fp = file_paths[orig_j] if orig_j < len(file_paths) else None
            if fp:
                v = _vision_amt(fp, claimed_hint=remaining)
                if v is not None and 0 < v <= remaining * 1.30:
                    notes.append(f"Bill {orig_j+1}: vision found ₹{v:,.2f} (OCR had failed)")
                    indexed_amounts.append((v, orig_j))
                    running = round(running + v, 2)
        amounts = [a for a, _ in indexed_amounts]

    if not amounts:
        return None, notes

    regular_sum = round(sum(amounts), 2)

    # ── FIX 2: Smarter dedup — 10% tolerance for USD+INR invoice pairs ────────
    # A USD invoice converted at ₹93/$ and the actual INR bank charge can differ
    # by up to 8-10% due to forex rates and bank fees. Treat them as the same
    # transaction (keep larger = INR bank amount, skip smaller = raw USD converted).
    deduped = []
    removed = []
    for a in sorted(amounts, reverse=True):
        if not any(abs(a - d) <= max(10.0, d * 0.10) for d in deduped):
            deduped.append(a)
        else:
            removed.append(a)
    deduped_sum = round(sum(deduped), 2)

    if removed and abs(deduped_sum - claimed) < abs(regular_sum - claimed):
        for r in removed:
            notes.append(f"Duplicate bill ₹{r:,.2f} skipped (invoice+receipt of same transaction)")
        if len(deduped) == 1:
            notes.append(f"Using ₹{deduped[0]:,.2f} (single invoice amount)")
        else:
            parts = " + ".join(f"₹{a:,.2f}" for a in deduped)
            notes.append(f"After dedup: {parts} = ₹{deduped_sum:,.2f}")
        best_total = deduped_sum
    else:
        parts = " + ".join(f"₹{a:,.2f}" for a in amounts)
        notes.append(f"Total of {len(amounts)} bills: {parts} = ₹{regular_sum:,.2f}")
        best_total = regular_sum

    # ── Post-sum vision correction (multi-bill) ───────────────────────────────
    # If the computed total is still >15% off from claimed, iterate over each
    # bill and ask Vision to re-read it with hint = expected per-bill amount.
    # Uses original file indices (not zip-position) to avoid misalignment bugs.
    if (file_paths
            and claimed > 0
            and abs(best_total - claimed) / claimed > 0.15):
        from services.ocr import extract_amount_vision as _vision_amt
        corrected = list(indexed_amounts)   # [(amount, orig_idx)]
        changed = False
        for j in range(len(corrected)):
            amt_j, orig_j = corrected[j]
            other_sum = sum(a for a, _ in corrected[:j] + corrected[j+1:])
            expected_j = round(claimed - other_sum, 2)
            if expected_j <= 0:
                continue
            if abs(amt_j - expected_j) > max(50.0, expected_j * 0.15):
                fp = file_paths[orig_j] if orig_j < len(file_paths) else None
                if fp:
                    v = _vision_amt(fp, claimed_hint=expected_j)
                    if v is not None and abs(v - expected_j) < abs(amt_j - expected_j):
                        notes.append(
                            f"Bill {orig_j+1}: vision corrected ₹{amt_j:,.2f} → ₹{v:,.2f} "
                            f"(expected ≈₹{expected_j:,.2f})"
                        )
                        corrected[j] = (v, orig_j)
                        changed = True
        if changed:
            corrected_sum = round(sum(a for a, _ in corrected), 2)
            if abs(corrected_sum - claimed) < abs(best_total - claimed):
                return corrected_sum, notes

    return best_total, notes


def _check_policy_limit(row) -> str | None:
    """Check if the claimed amount exceeds the configured policy limit for this category.
    Returns a flag string if exceeded, None if within policy or policy disabled."""
    try:
        import json, os
        policy_file = os.path.join(os.path.dirname(__file__), "..", "policy_rules.json")
        if not os.path.exists(policy_file):
            return None
        with open(policy_file, "r", encoding="utf-8") as f:
            policy = json.load(f)
        if not policy.get("enabled"):
            return None

        # Map expense nature/category to policy category key
        nature = (row.expense_nature or row.expense_category or "").lower()
        cat_map = {
            "food": ["food", "meal", "dining", "restaurant", "snack", "beverage", "lunch", "dinner", "breakfast", "swiggy", "zomato"],
            "travel": ["travel", "transport", "cab", "flight", "train", "bus", "metro", "auto", "taxi", "uber", "ola", "conveyance", "fuel"],
            "accommodation": ["hotel", "accommodation", "stay", "lodge", "airbnb", "oyo"],
            "subscription": ["subscription", "software", "saas", "license", "tool"],
            "office": ["office", "stationery", "supply", "printing"],
        }

        matched_cat = "other"
        for cat, keywords in cat_map.items():
            if any(kw in nature for kw in keywords):
                matched_cat = cat
                break

        for rule in policy.get("rules", []):
            if rule.get("category") == matched_cat and rule.get("enabled"):
                limit = float(rule.get("limit", 0))
                if limit > 0 and row.claimed_amount > limit:
                    return (
                        f"Exceeds policy limit — claimed ₹{row.claimed_amount:,.0f} "
                        f"but {rule.get('label', matched_cat)} limit is ₹{limit:,.0f} per {rule.get('per', 'claim')}"
                    )
        return None
    except Exception:
        return None


def validate_row(row: ExpenseRow, ocr_result: Optional[OCRResult], file_paths: Optional[List[str]] = None) -> ExpenseRow:
    """
    Decision logic (amount is the ONLY hard gate):
      - No bill matched            → Rejected
      - Amount extracted + matches → Approved  (confidence irrelevant)
      - Amount extracted + differs → Rejected
      - Amount not extractable     → Flagged (manual review)
      - Duplicate                  → Flagged (stacked on top of above)
    """
    row.expense_nature = _tag_expense_nature(row.expense_category, row.description)

    if row.matched_file is None:
        row.status = ExpenseStatus.REJECTED
        return row

    hard_fails: List[str] = []
    soft_flags: List[str] = []

    # Use all OCR results if available (multi-bill claim), else fall back to single
    all_ocr = row.ocr_results if row.ocr_results else ([ocr_result] if ocr_result else [])

    if all_ocr:
        total_bill, amount_notes = _sum_bill_amounts(row, all_ocr, file_paths=file_paths)
        row.remarks.extend(amount_notes)

        if total_bill is not None:
            row.bill_amount = total_bill
            signed_diff = round(row.claimed_amount - total_bill, 2)   # + = overclaimed
            row.amount_diff = signed_diff

            ocr_text_combined = " ".join(r.raw_text or "" for r in all_ocr)
            is_usd = _is_usd_bill(row.expense_category or "", row.description or "", ocr_text_combined)

            if is_usd:
                # USD bills: ₹200 tolerance for forex variation.
                # Overclaimed (claimed > bill+tol): hard reject.
                # Underclaimed (claimed < bill-tol): soft flag only — valid to claim less than spent.
                USD_TOLERANCE = 300.0
                if signed_diff > USD_TOLERANCE:
                    hard_fails.append(
                        f"Amount Mismatch (overclaimed) — claimed ₹{row.claimed_amount:,.2f}, "
                        f"bill ₹{total_bill:,.2f}, diff ₹{signed_diff:,.2f} (USD ±₹{USD_TOLERANCE:.0f} tolerance)"
                    )
                elif signed_diff < -USD_TOLERANCE:
                    soft_flags.append(
                        f"Underclaimed — claimed ₹{row.claimed_amount:,.2f} is less than "
                        f"bill ₹{total_bill:,.2f} (by ₹{abs(signed_diff):,.2f}); "
                        f"needs manual review"
                    )
                else:
                    # Within ₹300 — use claimed as bill amount (forex rounding)
                    row.bill_amount = row.claimed_amount
                    row.amount_diff = 0.0
                    min_conf = min(r.confidence for r in all_ocr)
                    if min_conf < OCR_CONFIDENCE_MIN:
                        row.remarks.append(f"Note: low OCR confidence ({int(min_conf*100)}%) but amounts match")
            else:
                # INR bills:
                #   Overclaimed (claimed > bill): hard reject — amount not supported by bill
                #   EXCEPT: if the bill's Total line itself is garbled/unreadable by OCR,
                #     downgrade to soft-flag (Flagged) so a human can verify instead of
                #     auto-rejecting based on an item subtotal that OCR picked by mistake.
                #   Underclaimed (claimed < bill): soft flag — claiming less than spent is valid
                #   Within ±₹5 tolerance: approve
                if signed_diff > AMOUNT_TOLERANCE:
                    # Check whether the bill's Total line was unreadable (garbled)
                    garbled = _total_line_unreadable(ocr_text_combined)
                    if garbled:
                        soft_flags.append(
                            f"Amount uncertain — bill Total unreadable (OCR reads ₹{total_bill:,.2f}, "
                            f"claimed ₹{row.claimed_amount:,.2f}, diff ₹{signed_diff:,.2f}); "
                            f"manual review needed"
                        )
                    else:
                        hard_fails.append(
                            f"Amount Mismatch (overclaimed) — "
                            f"claimed Rs.{row.claimed_amount:,.2f}, bill Rs.{total_bill:,.2f}, "
                            f"diff Rs.{signed_diff:,.2f}"
                        )
                elif signed_diff < -AMOUNT_TOLERANCE:
                    soft_flags.append(
                        f"Underclaimed — claimed Rs.{row.claimed_amount:,.2f} is less than "
                        f"bill total Rs.{total_bill:,.2f} (by Rs.{abs(signed_diff):,.2f}); "
                        f"needs manual review"
                    )
                else:
                    min_conf = min(r.confidence for r in all_ocr)
                    if min_conf < OCR_CONFIDENCE_MIN:
                        row.remarks.append(f"Note: low OCR confidence ({int(min_conf*100)}%) but amounts match")
        else:
            soft_flags.append("Could not extract bill amount — manual review needed")
    else:
        soft_flags.append("No OCR result available — manual review needed")

    if row.is_duplicate:
        soft_flags.append("Duplicate Bill — same attachment file is used in multiple claim rows")

    # Policy limit check — add to soft_flags before final status decision
    policy_flag = _check_policy_limit(row)
    if policy_flag:
        soft_flags.append(policy_flag)

    row.remarks.extend(hard_fails)
    row.remarks.extend(soft_flags)

    if hard_fails:
        row.status = ExpenseStatus.REJECTED
    elif soft_flags:
        row.status = ExpenseStatus.FLAGGED
    else:
        row.status = ExpenseStatus.APPROVED

    return row


# ─── Batch entry point ───────────────────────────────────────────────────────

def _prepare_and_validate(row, ocr_map, file_map):
    if row.matched_files:
        row.ocr_results = [ocr_map[k] for k in row.matched_files if k in ocr_map]
    if not row.ocr_result and row.matched_file:
        row.ocr_result = ocr_map.get(row.matched_file)
    fps = [file_map[k] for k in row.matched_files if k in file_map] if file_map and row.matched_files else None
    return validate_row(row, row.ocr_result, file_paths=fps)


def validate_expenses(
    rows: List[ExpenseRow],
    ocr_map: Dict[str, OCRResult],
    file_map: Optional[Dict[str, str]] = None,
) -> List[ExpenseRow]:
    from concurrent.futures import ThreadPoolExecutor
    workers = min(16, max(4, len(rows)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_prepare_and_validate, row, ocr_map, file_map) for row in rows]
        return [f.result() for f in futures]
