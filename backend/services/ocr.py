import re
import os
import json
import hashlib
import threading
import base64
from typing import Optional
from models.schemas import OCRResult

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env")))
except Exception:
    pass

# ── Persistent OCR cache (keyed by MD5 of file content) ─────────────────────
_OCR_CACHE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "ocr_cache.json")
OCR_CACHE_VERSION = "ai-fallback-v2"
os.makedirs(os.path.dirname(_OCR_CACHE_PATH), exist_ok=True)
_ocr_cache_lock = threading.Lock()

def _load_ocr_cache() -> dict:
    try:
        with open(_OCR_CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def flush_ocr_cache():
    """Save OCR cache to disk once. Call after all OCR tasks complete."""
    with _ocr_cache_lock:
        try:
            with open(_OCR_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(_ocr_cache, f, ensure_ascii=False)
        except Exception:
            pass

_ocr_cache: dict = _load_ocr_cache()

def _file_md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

# PyMuPDF — primary PDF text extractor (no binary needed)
try:
    import fitz  # PyMuPDF
    PYMUPDF_AVAILABLE = True
except ImportError:
    PYMUPDF_AVAILABLE = False

# Pillow — for image files
try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False

# RapidOCR — disabled (ONNX model uses ~150MB RAM, causes OOM on Railway 512MB)
RAPIDOCR_AVAILABLE = False

# Tesseract — optional fallback
try:
    import pytesseract
    pytesseract.get_tesseract_version()
    TESSERACT_AVAILABLE = True
except Exception:
    TESSERACT_AVAILABLE = False

# Anthropic Vision — secondary fallback
try:
    import anthropic as _anthropic_module
    _ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
    _ANTHROPIC_OCR_MODEL = os.environ.get("ANTHROPIC_OCR_MODEL", "claude-3-5-haiku-latest")
    ANTHROPIC_AVAILABLE = bool(_ANTHROPIC_API_KEY)
except ImportError:
    ANTHROPIC_AVAILABLE = False
    _ANTHROPIC_API_KEY = ""
    _ANTHROPIC_OCR_MODEL = "claude-3-5-haiku-latest"

# pdf2image — only needed if PyMuPDF unavailable
try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False


# ─── Regex patterns ──────────────────────────────────────────────────────────

# Amount patterns — priority order (lower index = higher priority).
# Each tier is tried in order; we stop at the first tier that yields candidates.
# TIER 0: Explicit "grand total / total amount / net amount / payable" keyword
# TIER 1: Standalone "Total" line
# TIER 2: Currency symbol / code directly before number (with or without decimals)
# TIER 3: Indian "480/-" notation
# TIER 4: Fallback — any decimal number (used only if all above fail)

AMOUNT_PATTERNS = [
    # Tier 0 — explicit total keyword (multi-line safe)
    r"(?:grand\s*total|total\s*amount|net\s*amount|amount\s*payable|total\s*due|payable|net\s*payable)[:\s]*[\n\r]*\s*[₹$]?\s*(?:inr|rs\.?)?\s*([0-9,]+\.?[0-9]*)",
    r"(?:grand\s*total|total\s*amount|net\s*amount|amount\s*payable|total\s*due|payable|net\s*payable)[:\s₹Rs.INR]*([0-9,]+\.?[0-9]*)",
    # Tier 0 — petrol/fuel bill: "Amount(Rs):03349.89" or "Sale :RS.2733.94"
    r"(?:amount\s*\(\s*rs\.?\s*\)|sale\s*amount)[:\s]*([0-9,]+\.?[0-9]*)",
    r"\bsale\b[:\s]*(?:rs\.?)?\s*([0-9,]+\.?[0-9]*)",
    # Tier 1 — "Total" line — allow any non-digit separator (handles "TOTAL: 天290" etc.)
    r"\btotal\b[^a-zA-Z0-9]{0,15}([0-9,]+\.?[0-9]*)",
    # Tier 2 — currency symbol/code + number (with OR without .xx)
    r"[₹]\s*([0-9,]+\.?[0-9]*)",
    r"\bRs\.?\s*([0-9,]+\.?[0-9]*)",
    r"\bINR\s*([0-9,]+\.?[0-9]*)",
    # Tier 3 — Indian "480/-" or "480.00/-" notation
    r"([0-9,]+\.?[0-9]*)\s*/\s*-",
    # Tier 4 — fallback: any number with exactly 2 decimal places
    r"([0-9,]+\.[0-9]{2})",
]

# Patterns in tier 4 (fallback) — used only when nothing better found
_FALLBACK_TIER = {9}

DATE_PATTERNS = [
    r"\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b",
    r"\b(\d{4}[\/\-]\d{2}[\/\-]\d{2})\b",
    r"\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})\b",
    r"\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b",
]

GSTIN_PATTERN = r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b"

# Common OCR misread substitutions (handwritten / low-quality scans)
_OCR_CHAR_MAP = str.maketrans("oOlIsSeEzZbBgqyY", "0011550022668044")


def _decode_ocr_token(token: str) -> Optional[float]:
    """
    Try to recover a number from a garbled OCR token (e.g. 'yoo' → '400').
    Returns float if the substituted string looks like a valid number, else None.
    """
    fixed = token.translate(_OCR_CHAR_MAP).replace(",", "")
    if re.match(r"^[0-9]+\.?[0-9]*$", fixed):
        try:
            v = float(fixed)
            return v if v > 0 else None
        except ValueError:
            pass
    return None


# ─── Field extractors ────────────────────────────────────────────────────────

_UPI_MARKERS = re.compile(
    r"UPItransactionID|UPI\s*transaction\s*ID|GooglePay|Google\s*Pay"
    r"|POWERED\s+BY\s+UPI|UPI\s+POWERED|LPIAUTOPAY|LPI\s*AUTO\s*PAY"
    r"|okhdfcbank|@okaxis|@ybl|@paytm|@okicici|@kotak|UPIAutoPay"
    r"|PhonePe|Phonepe|BHIM\s*UPI|upitransaction",
    re.IGNORECASE,
)

# Matches a standalone comma-formatted number on its own line: "2,100" or "1,999"
_UPI_AMOUNT_LINE = re.compile(
    r"(?:^|\n)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)\s*(?:\n|$)",
    re.MULTILINE,
)
# Fallback: plain integer (3-6 digits) on its own line for small round amounts
_UPI_AMOUNT_PLAIN = re.compile(
    r"(?:^|\n)\s*([1-9]\d{2,5})\s*(?:\n|$)",
    re.MULTILINE,
)


def _extract_upi_amount(text: str) -> Optional[float]:
    """Return the payment amount from a Google Pay / UPI confirmation screenshot.

    UPI screenshots have no '₹' or 'Total' keyword near the amount — the amount
    appears as a standalone line (e.g. '2,100' or '1,999') right below the
    recipient/vendor name.  Standard regex tiers miss it entirely.
    """
    if not _UPI_MARKERS.search(text):
        return None
    # First try comma-formatted numbers ("2,100" / "1,999")
    for m in _UPI_AMOUNT_LINE.finditer(text):
        try:
            val = float(m.group(1).replace(",", ""))
            if val > 0:
                return val
        except ValueError:
            pass
    # Fallback: plain integer on its own line
    for m in _UPI_AMOUNT_PLAIN.finditer(text):
        try:
            val = float(m.group(1))
            if val > 0:
                return val
        except ValueError:
            pass
    return None


def extract_amount(text: str, claimed_hint: Optional[float] = None) -> Optional[float]:
    """
    Extract the total payable amount from bill text.

    Strategy:
    - When claimed_hint is given (almost always the case during validation):
        Search ALL tiers from highest to lowest priority.
        In each tier pick the candidate closest to the hint.
        Accept it if it is within 60 % of the hint value — this handles
        genuine mismatches while still preferring explicit total labels.
        If no tier yields a close-enough candidate, fall back to the
        globally closest value across all candidates.
    - When no hint:
        Use highest-priority tier; remove outliers vs. the *median*
        (not the minimum — a stray ₹1 line-item must not suppress the real total).
    """
    if not text:
        return None

    # ── UPI / Google Pay screenshot: highest-priority special case ───────────
    # Amount appears as a bare line "2,100" with NO ₹ / Total prefix.
    # Detect it before running general patterns so it wins at tier -1.
    upi_amount = _extract_upi_amount(text)

    candidates: list = []   # (value, tier_index)

    # Seed with UPI amount at tier -1 (highest priority) if found
    if upi_amount is not None:
        candidates.append((upi_amount, -1))

    for i, pattern in enumerate(AMOUNT_PATTERNS):
        matches = re.findall(pattern, text, re.IGNORECASE | re.MULTILINE)
        for raw in matches:
            cleaned = raw.replace(",", "").strip()
            try:
                val = float(cleaned)
                if val > 0:
                    candidates.append((val, i))
            except ValueError:
                continue

    # ── Fallback 1: OCR character substitution on "Total" lines ────────────────
    # Handles handwritten bills where "Total 480" is OCR'd as "Total yoo".
    if not candidates or (claimed_hint and not any(
            abs(v - claimed_hint) <= claimed_hint * 0.60 for v, _ in candidates)):
        for m in re.finditer(r"\btotal[^a-zA-Z0-9\n]{0,10}([a-zA-Z0-9,\.]+)", text, re.IGNORECASE):
            token = m.group(1).strip()
            val = _decode_ocr_token(token)
            if val and val > 10:
                candidates.append((val, 1))   # treat as Tier 1

    # ── Fallback 2: integers ≥ 3 digits (for plain cash memos with no symbols) ─
    if not candidates:
        for m in re.finditer(r"\b([0-9]{3,})\b", text):
            try:
                val = float(m.group(1))
                if val > 0:
                    candidates.append((val, len(AMOUNT_PATTERNS)))  # lowest priority
            except ValueError:
                pass

    # ── Fallback 3: line-item sum (when total line unreadable) ─────────────────
    # Collect all 2-4 digit integers, sum them; add as a candidate if reasonable.
    if candidates and claimed_hint and claimed_hint > 0:
        integers = [float(m) for m in re.findall(r"\b([0-9]{2,4})\b", text)]
        if integers:
            item_sum = sum(integers)
            if 0 < item_sum <= claimed_hint * 1.5:
                candidates.append((item_sum, len(AMOUNT_PATTERNS)))

    if not candidates:
        return None

    # ── Deprioritize repeated amounts (they are unit prices, not grand totals) ──
    # e.g. EatSure bill: ₹479 appears for every pizza item (20 times) — NOT total.
    # Any amount appearing ≥ 3 times is pushed to the lowest tier so the Grand
    # Total (which appears only 1–2 times) wins at a higher tier.
    from collections import Counter as _Counter
    rounded_counts = _Counter(round(v) for v, _ in candidates)
    _max_tier = len(AMOUNT_PATTERNS)
    candidates = [
        (v, _max_tier if rounded_counts[round(v)] >= 3 else t)
        for v, t in candidates
    ]

    # ── Hint-guided path ─────────────────────────────────────────────────────
    if claimed_hint and claimed_hint > 0:
        # Walk tiers best → worst; within each tier pick candidate closest to hint.
        # Prefer candidates that are ≤ claimed_hint (underclaiming is valid; OCR
        # should not pick a higher subtotal/tax-inclusive line over the net payable).
        best_tier = min(c[1] for c in candidates)
        worst_tier = max(c[1] for c in candidates)
        for tier in range(best_tier, worst_tier + 1):
            tier_vals = [v for v, t in candidates if t == tier]
            if not tier_vals:
                continue
            # At the lowest fallback tier (plain integer scan + item sums), the
            # "Total" line itself was unreadable — don't restrict to ≤ hint, because
            # the item-sum candidate (e.g. 120+380=500) may be the true total even
            # if it's slightly above claimed (rounding / discount accounted for).
            # For all better tiers, keep the ≤ hint+5 preference.
            if tier == worst_tier:
                pool = tier_vals          # no restriction at absolute fallback
            else:
                # Allow up to 15% above claimed — handles cases where the bill
                # total is slightly higher than claimed (e.g. delivery charges,
                # minor rounding). Still excludes wildly inflated tax-inclusive
                # lines that are 30%+ above the claimed amount.
                upper = claimed_hint * 1.15
                below = [v for v in tier_vals if v <= upper]
                pool = below if below else tier_vals
            closest = min(pool, key=lambda v: abs(v - claimed_hint))
            # Accept if within 60 % of hint (handles genuine small over/under-claims)
            if abs(closest - claimed_hint) <= claimed_hint * 0.60:
                return closest
        # No tier matched well — return globally closest (better than None)
        return min((v for v, _ in candidates), key=lambda v: abs(v - claimed_hint))

    # ── No-hint path ─────────────────────────────────────────────────────────
    best_tier = min(c[1] for c in candidates)
    tier_candidates = sorted(v for v, t in candidates if t == best_tier)

    # Outlier filter relative to MEDIAN (not min) so a stray ₹1 line-item
    # doesn't suppress the real total via the old `min * 50` rule.
    median = tier_candidates[len(tier_candidates) // 2]
    tier_candidates = [v for v in tier_candidates
                       if median * 0.05 <= v <= median * 20]

    if not tier_candidates:
        return None

    # Grand Total is ALWAYS the MAXIMUM value among top-tier candidates.
    # (Sub-totals, per-item totals, and taxes are always ≤ the grand total.)
    # Using median previously caused item-price repeats to drag the result down.
    return max(tier_candidates)


def extract_date(text: str) -> Optional[str]:
    for pattern in DATE_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            return matches[0]
    return None


def extract_gstin(text: str) -> Optional[str]:
    matches = re.findall(GSTIN_PATTERN, text.upper())
    return matches[0] if matches else None


def extract_vendor(text: str) -> Optional[str]:
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    skip = re.compile(r"^\d|^(?:phone|tel|mob|email|gst|date|invoice|bill|address|receipt|tax)", re.IGNORECASE)
    for line in lines[:10]:
        if len(line) > 3 and not skip.match(line):
            vendor = re.sub(r"[^a-zA-Z0-9 &\-'.]", "", line).strip()
            if len(vendor) > 3:
                return vendor
    return None


def compute_confidence(ocr_result: OCRResult, raw_text: str) -> float:
    score = 0.0
    if raw_text and len(raw_text.strip()) > 50:
        score += 0.2
    if ocr_result.total_amount is not None:
        score += 0.45
    if ocr_result.bill_date is not None:
        score += 0.20
    if ocr_result.vendor_name is not None:
        score += 0.10
    if ocr_result.gstin is not None:
        score += 0.05
    return round(score, 2)


# ─── Text extraction ─────────────────────────────────────────────────────────

def extract_text_pdf(pdf_path: str) -> str:
    """Extract text from PDF using PyMuPDF. Falls back to RapidOCR for scanned PDFs.
    For scanned (image-based) PDFs, OCRs ALL pages so multi-page bills (e.g. EatSure
    group orders) have their Grand Total captured from the last page.
    """
    text = ""
    if PYMUPDF_AVAILABLE:
        try:
            doc = fitz.open(pdf_path)
            text = "\n".join(page.get_text() for page in doc)
        except Exception:
            text = ""
    else:
        text = _extract_text_pdf_fallback(pdf_path)

    # Scanned PDF (no text layer): OCR ALL pages, not just the first one.
    # This is critical for multi-page bills (food orders, travel bundles) where
    # the Grand Total appears on the LAST page, not page 1.
    if len(text.strip()) < 30:
        if PYMUPDF_AVAILABLE and RAPIDOCR_AVAILABLE:
            import tempfile as _tempfile
            import os as _os
            import gc as _gc
            try:
                doc = fitz.open(pdf_path)
                page_texts = []
                for page in doc:
                    # Use 1.5× zoom instead of 2× — reduces pixmap RAM by ~44%
                    mat = fitz.Matrix(1.5, 1.5)
                    pix = page.get_pixmap(matrix=mat)
                    img_bytes = pix.tobytes("png")
                    del pix  # free pixmap immediately after encoding
                    with _tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                        tf.write(img_bytes)
                        tmp_path = tf.name
                    del img_bytes  # free encoded bytes
                    try:
                        page_text = extract_text_image(tmp_path)
                    finally:
                        try:
                            _os.unlink(tmp_path)
                        except Exception:
                            pass
                    if page_text.strip():
                        page_texts.append(page_text)
                doc.close()
                del doc
                _gc.collect()
                if page_texts:
                    text = "\n--- PAGE BREAK ---\n".join(page_texts)
            except Exception:
                pass
        if not text.strip() and ANTHROPIC_AVAILABLE:
            text = _extract_text_claude_vision(pdf_path)
    return text


def _extract_text_pdf_fallback(pdf_path: str) -> str:
    """Fallback: pdf2image + Tesseract if PyMuPDF unavailable."""
    if not PDF2IMAGE_AVAILABLE or not TESSERACT_AVAILABLE:
        return ""
    try:
        import pytesseract
        pages = convert_from_path(pdf_path, dpi=200)
        return "\n".join(pytesseract.image_to_string(p, lang="eng", config="--psm 6") for p in pages)
    except Exception:
        return ""


def extract_text_image(image_path: str) -> str:
    """Extract text from image. Priority: RapidOCR → Tesseract → Claude Vision."""
    # 1. RapidOCR (no binary/cloud needed, works offline)
    if RAPIDOCR_AVAILABLE:
        try:
            ocr_input = image_path
            if PILLOW_AVAILABLE:
                try:
                    import numpy as np
                    img = Image.open(image_path).convert("RGB")
                    w, h = img.size
                    if max(w, h) > 2000:
                        scale = 2000 / max(w, h)
                        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
                    ocr_input = np.array(img)
                except Exception:
                    ocr_input = image_path
            result, _ = _rapid_ocr(ocr_input)
            if result:
                return "\n".join(line[1] for line in result if line and len(line) > 1)
        except Exception:
            pass

    # 2. Tesseract
    if TESSERACT_AVAILABLE and PILLOW_AVAILABLE:
        try:
            import pytesseract
            img = Image.open(image_path)
            w, h = img.size
            if w < 1000 or h < 1000:
                img = img.resize((w * 2, h * 2), Image.LANCZOS)
            return pytesseract.image_to_string(img, lang="eng", config="--psm 6")
        except Exception:
            pass

    # 3. Claude Vision
    if ANTHROPIC_AVAILABLE:
        return _extract_text_claude_vision(image_path)
    return ""


def _extract_text_claude_vision(file_path: str) -> str:
    """Use Claude Vision to extract text from an image or scanned PDF."""
    try:
        _, ext = os.path.splitext(file_path.lower())
        # Determine media type
        media_map = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".pdf": "application/pdf",
        }
        media_type = media_map.get(ext)
        if not media_type:
            return ""

        with open(file_path, "rb") as f:
            data = base64.standard_b64encode(f.read()).decode("utf-8")

        client = _anthropic_module.Anthropic(api_key=_ANTHROPIC_API_KEY)

        # For PDFs, use document type; for images, use image type
        if media_type == "application/pdf":
            source = {"type": "base64", "media_type": media_type, "data": data}
            content_item = {"type": "document", "source": source}
        else:
            source = {"type": "base64", "media_type": media_type, "data": data}
            content_item = {"type": "image", "source": source}

        resp = client.messages.create(
            model=_ANTHROPIC_OCR_MODEL,
            max_tokens=512,
            messages=[{
                "role": "user",
                "content": [
                    content_item,
                    {
                        "type": "text",
                        "text": (
                            "Extract text from this bill/receipt. "
                            "Return the raw text as-is, including all numbers, dates, vendor name, "
                            "and especially the total/grand total amount. "
                            "Do not summarize — just return the raw text content."
                        ),
                    },
                ],
            }],
        )
        return resp.content[0].text if resp.content else ""
    except Exception:
        return ""


_vision_amount_cache: dict = {}
_vision_struct_cache: dict = {}


def extract_structured_vision(file_path: str) -> Optional[dict]:
    """
    Extract ALL bill fields in a single Claude Vision call.
    Returns: {
        "vendor_name": str | None,
        "bill_date":   str | None,
        "total_amount": float | None,
        "gstin":       str | None,
        "raw_text":    str
    }

    Used as PRIMARY OCR for image bills. Beats RapidOCR/Tesseract on:
      - Blurry / low-resolution photos
      - Handwritten amounts and totals
      - Mixed-language receipts (Hindi/English)
      - Faded thermal-printer paper
    """
    if not ANTHROPIC_AVAILABLE or not file_path:
        return None

    cache_key = f"struct:{file_path}"
    if cache_key in _vision_struct_cache:
        return _vision_struct_cache[cache_key]

    try:
        _, ext = os.path.splitext(file_path.lower())
        media_map = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".pdf": "application/pdf",
        }
        media_type = media_map.get(ext)
        if not media_type:
            return None

        with open(file_path, "rb") as f:
            data = base64.standard_b64encode(f.read()).decode("utf-8")

        client = _anthropic_module.Anthropic(api_key=_ANTHROPIC_API_KEY)
        content_item = (
            {"type": "document", "source": {"type": "base64", "media_type": media_type, "data": data}}
            if media_type == "application/pdf"
            else {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
        )

        prompt = (
            "Read this expense bill / receipt carefully. Extract these fields and "
            "return ONLY valid JSON (no markdown, no commentary):\n"
            "{\n"
            '  "vendor_name":  "<merchant / restaurant / shop name on top of bill, or null>",\n'
            '  "bill_date":    "<bill date in DD/MM/YYYY format, or null>",\n'
            '  "total_amount": <final paid amount as a number, no currency symbol, or null>,\n'
            '  "gstin":        "<15-char GSTIN if present on the bill, or null>",\n'
            '  "raw_text":     "<all readable text from the bill, line-by-line>"\n'
            "}\n\n"
            "★ CRITICAL — total_amount priority order (use HIGHEST that exists on the bill):\n"
            "  1. \"PAID AMOUNT\" / \"AMOUNT PAID\" / \"PAID\" → if the bill explicitly shows what was paid, ALWAYS use this.\n"
            "  2. \"NET PAYABLE\" / \"AMOUNT PAYABLE\" / \"NET AMOUNT\" / \"FINAL AMOUNT\" → after taxes & discounts.\n"
            "  3. \"GRAND TOTAL\" / \"TOTAL AMOUNT\" / \"BILL TOTAL\" → bottom-line summary on the bill.\n"
            "  4. \"TOTAL\" → if standalone and clearly the largest summary amount.\n"
            "★ NEVER return:\n"
            "  - Sub-total (before tax)\n"
            "  - Individual line item amounts (e.g. one dish price out of many)\n"
            "  - Tax / GST / CGST / SGST / IGST values alone\n"
            "  - Pre-discount values when a final amount is shown\n"
            "  - Invoice number, GSTIN, phone numbers, PIN codes — these are NOT amounts\n\n"
            "Special cases:\n"
            "- UPI / GooglePay / PhonePe / PayTM screenshots: total is the large bold number near the recipient's name (e.g. '₹2,100' shown prominently).\n"
            "- Restaurant bills: use \"Grand Total\" or \"Net Payable\" at the very bottom (after service charge & GST).\n"
            "- Hotel / travel: use \"Total Payable\" or \"Amount Due\".\n"
            "- Petrol pumps: use \"Sale\" / \"Amount(Rs)\" / \"Total Sale\".\n"
            "- Handwritten / blurry: decode handwritten digits carefully (4↔y, 0↔o/O, 1↔l/I, 6↔b, 9↔g, 7↔l).\n"
            "- USD invoices with INR equivalent shown: return the INR value.\n"
            "- Multi-page PDF: total is on the LAST page. Always pick from the last page.\n"
            "- If field missing / unreadable, use null (NOT empty string, NOT 0)."
        )

        resp = client.messages.create(
            model=_ANTHROPIC_OCR_MODEL,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [content_item, {"type": "text", "text": prompt}],
            }],
        )
        raw = resp.content[0].text.strip() if resp.content else ""

        # Strip optional markdown fences
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            if raw.endswith("```"):
                raw = raw.rsplit("```", 1)[0]
            raw = raw.strip()
            if raw.startswith("json"):
                raw = raw[4:].strip()

        try:
            parsed = json.loads(raw)
        except Exception:
            # Best-effort: extract JSON object from response
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            parsed = json.loads(m.group(0)) if m else {}

        # Normalise fields
        result = {
            "vendor_name":  parsed.get("vendor_name") or None,
            "bill_date":    parsed.get("bill_date")   or None,
            "total_amount": None,
            "gstin":        parsed.get("gstin")       or None,
            "raw_text":     str(parsed.get("raw_text") or "")[:2000],
        }
        amt = parsed.get("total_amount")
        if amt is not None:
            try:
                v = float(str(amt).replace(",", "").replace("₹", "").strip())
                if v > 0:
                    result["total_amount"] = v
            except Exception:
                pass

        _vision_struct_cache[cache_key] = result
        return result

    except Exception as e:
        # Fail silently — caller will fall back to regex OCR
        _vision_struct_cache[cache_key] = None
        return None


def extract_amount_vision(file_path: str, claimed_hint: Optional[float] = None) -> Optional[float]:
    """
    Ask Claude Vision directly for the grand total on a bill image/PDF.
    Used as a last-resort fallback when regex OCR can't find the right amount.
    Returns the extracted float, or None on any failure.
    """
    if not ANTHROPIC_AVAILABLE or not file_path:
        return None
    cache_key = f"{file_path}:{claimed_hint}"
    if cache_key in _vision_amount_cache:
        return _vision_amount_cache[cache_key]
    try:
        _, ext = os.path.splitext(file_path.lower())
        media_map = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".pdf": "application/pdf",
        }
        media_type = media_map.get(ext)
        if not media_type:
            return None

        with open(file_path, "rb") as f:
            data = base64.standard_b64encode(f.read()).decode("utf-8")

        client = _anthropic_module.Anthropic(api_key=_ANTHROPIC_API_KEY)
        content_item = (
            {"type": "document", "source": {"type": "base64", "media_type": media_type, "data": data}}
            if media_type == "application/pdf"
            else {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
        )
        hint_text = (
            f" The employee claims ₹{claimed_hint:.0f} for this bill."
            f" Look for the amount on the bill that is closest to ₹{claimed_hint:.0f}."
        ) if claimed_hint else ""

        resp = _anthropic_module.Anthropic(api_key=_ANTHROPIC_API_KEY).messages.create(
            model=_ANTHROPIC_OCR_MODEL,
            max_tokens=64,
            messages=[{
                "role": "user",
                "content": [
                    content_item,
                    {
                        "type": "text",
                        "text": (
                            f"Look at this bill/receipt.{hint_text} "
                            "What is the final AMOUNT PAYABLE / NET PAYABLE / GRAND TOTAL that the customer "
                            "actually pays? This is the bottom-line amount after all discounts and taxes. "
                            "Do NOT return a subtotal, tax amount, or pre-discount figure. "
                            "If the bill is in USD, return the INR equivalent shown on the bill (or the USD amount if no INR shown). "
                            "Reply with ONLY the numeric value (e.g. 11034 or 11034.00). "
                            "No currency symbol, no explanation, no extra text."
                        ),
                    },
                ],
            }],
        )
        raw = resp.content[0].text.strip() if resp.content else ""
        cleaned = re.sub(r"[^\d.]", "", raw.split()[0] if raw.split() else "")
        val = float(cleaned) if cleaned else None
        result_val = val if val and val > 0 else None
        _vision_amount_cache[cache_key] = result_val
        return result_val
    except Exception:
        _vision_amount_cache[cache_key] = None
        return None


# ─── Main entry point ─────────────────────────────────────────────────────────

# Local OCR runs first; AI Vision repairs weak/incomplete/suspicious OCR.
AI_OCR_FALLBACK_ENABLED = (
    ANTHROPIC_AVAILABLE
    and os.environ.get("AI_OCR_FALLBACK", "true").lower() not in ("0", "false", "no")
)

# Optional override: send images/PDFs straight to AI Vision.
USE_CLAUDE_VISION_PRIMARY = (
    ANTHROPIC_AVAILABLE
    and os.environ.get("CLAUDE_VISION_PRIMARY", "false").lower() in ("1", "true", "yes")
)


def process_bill_ocr(file_path: str, claimed_hint: Optional[float] = None) -> OCRResult:
    """
    Process any bill file and return extracted fields + confidence score.
    Results are cached by file MD5 — identical files across uploads are instant.

    Pipeline (when CLAUDE_VISION_PRIMARY=true and ANTHROPIC_API_KEY is set):
      1. PDF → PyMuPDF text-layer extraction (free, instant). If text found, regex fields.
      2. Image / scanned PDF → Claude Vision structured extraction (vendor, date, amount, GSTIN).
      3. If Claude Vision result is incomplete, fall back to RapidOCR / Tesseract regex.
      4. Final regex pass on raw_text fills any gaps.
    """
    # ── Cache lookup ─────────────────────────────────────────────────────────
    try:
        fhash = _file_md5(file_path)
        if fhash in _ocr_cache:
            cached = _ocr_cache[fhash]
            return OCRResult(**cached)
    except Exception:
        fhash = None

    _, ext = os.path.splitext(file_path.lower())
    is_image = ext in {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}
    is_pdf   = ext == ".pdf"

    raw_text = ""
    vision_struct: Optional[dict] = None

    # ── Step 1: PDFs — try text layer first (free, instant) ─────────────────
    if is_pdf and PYMUPDF_AVAILABLE:
        try:
            doc = fitz.open(file_path)
            text_layer = "\n".join(page.get_text() for page in doc)
            if len(text_layer.strip()) >= 30:
                raw_text = text_layer
        except Exception:
            pass

    # ── Step 2: Claude Vision PRIMARY for images (and scanned PDFs) ─────────
    # Only call vision if we don't already have a clean text layer.
    if not raw_text and USE_CLAUDE_VISION_PRIMARY and (is_image or is_pdf):
        try:
            vision_struct = extract_structured_vision(file_path)
        except Exception:
            vision_struct = None

    # ── Step 3: Local OCR fallback (RapidOCR / Tesseract) ───────────────────
    if not raw_text and not vision_struct:
        try:
            if is_pdf:
                raw_text = extract_text_pdf(file_path)
            elif is_image:
                raw_text = extract_text_image(file_path)
        except Exception:
            raw_text = ""

    # If vision worked, use its raw_text for the regex passes too
    if vision_struct and vision_struct.get("raw_text"):
        raw_text = vision_struct["raw_text"]

    # ── Step 4: Build result — prefer vision values, fall back to regex ─────
    def _pick(vision_val, regex_val):
        return vision_val if vision_val not in (None, "", []) else regex_val

    regex_amount = extract_amount(raw_text, claimed_hint=claimed_hint) if raw_text else None
    regex_vendor = extract_vendor(raw_text) if raw_text else None
    regex_date   = extract_date(raw_text)   if raw_text else None
    regex_gstin  = extract_gstin(raw_text)  if raw_text else None

    if vision_struct:
        total = _pick(vision_struct.get("total_amount"), regex_amount)
        vendor = _pick(vision_struct.get("vendor_name"), regex_vendor)
        date   = _pick(vision_struct.get("bill_date"),   regex_date)
        gstin  = _pick(vision_struct.get("gstin"),       regex_gstin)
    else:
        total, vendor, date, gstin = regex_amount, regex_vendor, regex_date, regex_gstin

    result = OCRResult(
        vendor_name=vendor,
        bill_date=date,
        total_amount=total,
        gstin=gstin,
        raw_text=raw_text[:2000] if raw_text else "",
    )
    result.confidence = compute_confidence(result, raw_text)

    # ── Cache (thread-safe; disk flush happens once after all OCR) ──────────
    if fhash:
        with _ocr_cache_lock:
            _ocr_cache[fhash] = result.model_dump()

    return result


# Upgraded OCR entry point: local OCR first, AI Vision only as fallback.
# This later definition intentionally overrides the legacy implementation above.
def process_bill_ocr(file_path: str, claimed_hint: Optional[float] = None) -> OCRResult:
    """Process a bill using local OCR, then repair weak results with AI Vision."""
    try:
        fhash = _file_md5(file_path)
        if fhash in _ocr_cache:
            cached = _ocr_cache[fhash]
            if cached.get("_cache_version") == OCR_CACHE_VERSION:
                return OCRResult(**cached)
    except Exception:
        fhash = None

    _, ext = os.path.splitext(file_path.lower())
    is_image = ext in {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}
    is_pdf = ext == ".pdf"

    raw_text = ""
    local_engine = None
    vision_struct: Optional[dict] = None

    if is_pdf and PYMUPDF_AVAILABLE:
        try:
            doc = fitz.open(file_path)
            text_layer = "\n".join(page.get_text() for page in doc)
            if len(text_layer.strip()) >= 30:
                raw_text = text_layer
                local_engine = "pdf-text"
        except Exception:
            pass

    if not raw_text and USE_CLAUDE_VISION_PRIMARY and (is_image or is_pdf):
        try:
            vision_struct = extract_structured_vision(file_path)
        except Exception:
            vision_struct = None

    if not raw_text and not vision_struct:
        try:
            if is_pdf:
                raw_text = extract_text_pdf(file_path)
                local_engine = "pdf-ocr"
            elif is_image:
                raw_text = extract_text_image(file_path)
                local_engine = "local-image-ocr"
        except Exception:
            raw_text = ""

    if vision_struct and vision_struct.get("raw_text"):
        raw_text = str(vision_struct["raw_text"])

    result = OCRResult(
        vendor_name=extract_vendor(raw_text) if raw_text else None,
        bill_date=extract_date(raw_text) if raw_text else None,
        total_amount=extract_amount(raw_text, claimed_hint=claimed_hint) if raw_text else None,
        gstin=extract_gstin(raw_text) if raw_text else None,
        raw_text=raw_text[:2000] if raw_text else "",
        ocr_engine=local_engine,
    )
    result.confidence = compute_confidence(result, raw_text)

    def fallback_reason() -> Optional[str]:
        reasons = []
        if not raw_text or len(raw_text.strip()) < 80:
            reasons.append("low_text")
        if result.total_amount is None:
            reasons.append("missing_amount")
        if result.vendor_name is None:
            reasons.append("missing_vendor")
        if result.bill_date is None:
            reasons.append("missing_date")
        if result.confidence < 0.65:
            reasons.append("low_confidence")
        if claimed_hint and result.total_amount is not None:
            threshold = max(50.0, claimed_hint * 0.20)
            if abs(result.total_amount - claimed_hint) > threshold:
                reasons.append("amount_far_from_claim")
        return ",".join(reasons) if reasons else None

    reason = fallback_reason()
    should_try_ai = (
        (is_image or is_pdf)
        and (USE_CLAUDE_VISION_PRIMARY or (AI_OCR_FALLBACK_ENABLED and reason))
    )

    if should_try_ai and not vision_struct:
        try:
            vision_struct = extract_structured_vision(file_path)
        except Exception:
            vision_struct = None

    if vision_struct:
        used = False
        vision_amount = vision_struct.get("total_amount")
        if vision_amount is not None:
            if result.total_amount is None:
                result.total_amount = vision_amount
                used = True
            elif claimed_hint and claimed_hint > 0:
                if abs(vision_amount - claimed_hint) < abs(result.total_amount - claimed_hint):
                    result.total_amount = vision_amount
                    used = True

        if vision_struct.get("vendor_name") and (not result.vendor_name or result.confidence < 0.65):
            result.vendor_name = vision_struct.get("vendor_name")
            used = True
        if vision_struct.get("bill_date") and not result.bill_date:
            result.bill_date = vision_struct.get("bill_date")
            used = True
        if vision_struct.get("gstin") and not result.gstin:
            result.gstin = vision_struct.get("gstin")
            used = True
        if vision_struct.get("raw_text") and len(raw_text.strip()) < 80:
            raw_text = str(vision_struct.get("raw_text"))
            result.raw_text = raw_text[:2000]
            used = True

        if used or USE_CLAUDE_VISION_PRIMARY:
            result.ai_fallback_used = not USE_CLAUDE_VISION_PRIMARY
            result.ai_fallback_reason = reason or "primary_ai"
            result.ocr_engine = "ai-vision" if USE_CLAUDE_VISION_PRIMARY else "local+ai-fallback"
            result.confidence = max(result.confidence, compute_confidence(result, raw_text))

    if fhash:
        with _ocr_cache_lock:
            cached = result.model_dump()
            cached["_cache_version"] = OCR_CACHE_VERSION
            _ocr_cache[fhash] = cached

    return result
