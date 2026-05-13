"""
Vendor Master Database
─────────────────────
Maps common vendor names → expense category + type.
Used for:
  1. Smart category auto-suggestion (from OCR vendor name)
  2. Anomaly detection: vendor-category mismatch
"""

from typing import Optional, Dict

# ── Master database ───────────────────────────────────────────────────────────
# key: lowercase vendor keyword  →  value: { category, type, ambiguous }
# ambiguous=True means the vendor sells multiple things (e.g. Amazon) — lower
# confidence match, never used to override a human-set category.

VENDOR_MASTER: Dict[str, dict] = {

    # ── Travel & Transport ────────────────────────────────────────────────────
    "uber":              {"category": "Travel & Transport", "type": "cab"},
    "ola cabs":          {"category": "Travel & Transport", "type": "cab"},
    "meru":              {"category": "Travel & Transport", "type": "cab"},
    "irctc":             {"category": "Travel & Transport", "type": "train"},
    "indian railway":    {"category": "Travel & Transport", "type": "train"},
    "indian railways":   {"category": "Travel & Transport", "type": "train"},
    "makemytrip":        {"category": "Travel & Transport", "type": "flight"},
    "make my trip":      {"category": "Travel & Transport", "type": "flight"},
    "goibibo":           {"category": "Travel & Transport", "type": "flight"},
    "cleartrip":         {"category": "Travel & Transport", "type": "flight"},
    "indigo":            {"category": "Travel & Transport", "type": "flight"},
    "spicejet":          {"category": "Travel & Transport", "type": "flight"},
    "air india":         {"category": "Travel & Transport", "type": "flight"},
    "vistara":           {"category": "Travel & Transport", "type": "flight"},
    "akasa":             {"category": "Travel & Transport", "type": "flight"},
    "redbus":            {"category": "Travel & Transport", "type": "bus"},
    "abhibus":           {"category": "Travel & Transport", "type": "bus"},
    "yatra":             {"category": "Travel & Transport", "type": "flight"},
    "ease my trip":      {"category": "Travel & Transport", "type": "flight"},
    "easemytrip":        {"category": "Travel & Transport", "type": "flight"},
    "ixigo":             {"category": "Travel & Transport", "type": "flight"},
    "confirmtkt":        {"category": "Travel & Transport", "type": "train"},
    "trainman":          {"category": "Travel & Transport", "type": "train"},

    # ── Conveyance (two-wheeler / short distance) ─────────────────────────────
    "rapido":            {"category": "Conveyance", "type": "bike_taxi"},
    "yulu":              {"category": "Conveyance", "type": "bike_rental"},
    "bounce":            {"category": "Conveyance", "type": "bike_rental"},
    "vogo":              {"category": "Conveyance", "type": "bike_rental"},

    # ── Staff Welfare / Food ──────────────────────────────────────────────────
    "swiggy":            {"category": "Staff Welfare", "type": "food_delivery"},
    "zomato":            {"category": "Staff Welfare", "type": "food_delivery"},
    "dunzo":             {"category": "Staff Welfare", "type": "grocery"},
    "dominos":           {"category": "Staff Welfare", "type": "restaurant"},
    "domino's":          {"category": "Staff Welfare", "type": "restaurant"},
    "pizza hut":         {"category": "Staff Welfare", "type": "restaurant"},
    "mcdonalds":         {"category": "Staff Welfare", "type": "restaurant"},
    "mcdonald's":        {"category": "Staff Welfare", "type": "restaurant"},
    "kfc":               {"category": "Staff Welfare", "type": "restaurant"},
    "subway":            {"category": "Staff Welfare", "type": "restaurant"},
    "starbucks":         {"category": "Staff Welfare", "type": "restaurant"},
    "cafe coffee day":   {"category": "Staff Welfare", "type": "restaurant"},
    "ccd":               {"category": "Staff Welfare", "type": "restaurant"},
    "chaayos":           {"category": "Staff Welfare", "type": "restaurant"},
    "freshmenu":         {"category": "Staff Welfare", "type": "food_delivery"},
    "box8":              {"category": "Staff Welfare", "type": "food_delivery"},
    "faasos":            {"category": "Staff Welfare", "type": "food_delivery"},
    "licious":           {"category": "Staff Welfare", "type": "grocery"},
    "bigbasket":         {"category": "Staff Welfare", "type": "grocery", "ambiguous": True},
    "grofers":           {"category": "Staff Welfare", "type": "grocery", "ambiguous": True},
    "blinkit":           {"category": "Staff Welfare", "type": "grocery", "ambiguous": True},
    "zepto":             {"category": "Staff Welfare", "type": "grocery", "ambiguous": True},

    # ── Accommodation ─────────────────────────────────────────────────────────
    "oyo":               {"category": "Accommodation", "type": "budget_hotel"},
    "oyo rooms":         {"category": "Accommodation", "type": "budget_hotel"},
    "treebo":            {"category": "Accommodation", "type": "budget_hotel"},
    "fabhotel":          {"category": "Accommodation", "type": "budget_hotel"},
    "zostel":            {"category": "Accommodation", "type": "hostel"},
    "airbnb":            {"category": "Accommodation", "type": "rental"},
    "taj hotel":         {"category": "Accommodation", "type": "luxury_hotel"},
    "marriott":          {"category": "Accommodation", "type": "luxury_hotel"},
    "hyatt":             {"category": "Accommodation", "type": "luxury_hotel"},
    "holiday inn":       {"category": "Accommodation", "type": "hotel"},
    "ibis":              {"category": "Accommodation", "type": "hotel"},
    "lemon tree":        {"category": "Accommodation", "type": "hotel"},
    "ginger hotel":      {"category": "Accommodation", "type": "budget_hotel"},

    # ── Subscriptions / SaaS ─────────────────────────────────────────────────
    "openai":            {"category": "Subscription", "type": "ai_tool"},
    "open ai":           {"category": "Subscription", "type": "ai_tool"},
    "anthropic":         {"category": "Subscription", "type": "ai_tool"},
    "claude":            {"category": "Subscription", "type": "ai_tool"},
    "chatgpt":           {"category": "Subscription", "type": "ai_tool"},
    "midjourney":        {"category": "Subscription", "type": "ai_tool"},
    "perplexity":        {"category": "Subscription", "type": "ai_tool"},
    "github":            {"category": "Subscription", "type": "dev_tool"},
    "gitlab":            {"category": "Subscription", "type": "dev_tool"},
    "figma":             {"category": "Subscription", "type": "design_tool"},
    "canva":             {"category": "Subscription", "type": "design_tool"},
    "notion":            {"category": "Subscription", "type": "productivity"},
    "zoom":              {"category": "Subscription", "type": "communication"},
    "slack":             {"category": "Subscription", "type": "communication"},
    "microsoft 365":     {"category": "Subscription", "type": "productivity"},
    "office 365":        {"category": "Subscription", "type": "productivity"},
    "adobe":             {"category": "Subscription", "type": "design_tool"},
    "aws":               {"category": "Subscription", "type": "cloud"},
    "amazon web services": {"category": "Subscription", "type": "cloud"},
    "google cloud":      {"category": "Subscription", "type": "cloud"},
    "azure":             {"category": "Subscription", "type": "cloud"},
    "vercel":            {"category": "Subscription", "type": "cloud"},
    "netlify":           {"category": "Subscription", "type": "cloud"},
    "digitalocean":      {"category": "Subscription", "type": "cloud"},
    "heroku":            {"category": "Subscription", "type": "cloud"},
    "jira":              {"category": "Subscription", "type": "project_mgmt"},
    "confluence":        {"category": "Subscription", "type": "project_mgmt"},
    "linear":            {"category": "Subscription", "type": "project_mgmt"},
    "trello":            {"category": "Subscription", "type": "project_mgmt"},
    "asana":             {"category": "Subscription", "type": "project_mgmt"},
    "dropbox":           {"category": "Subscription", "type": "storage"},
    "grammarly":         {"category": "Subscription", "type": "productivity"},
    "lottiefiles":       {"category": "Subscription", "type": "design_tool"},
    "semrush":           {"category": "Subscription", "type": "marketing"},
    "mailchimp":         {"category": "Subscription", "type": "marketing"},
    "hubspot":           {"category": "Subscription", "type": "crm"},
    "salesforce":        {"category": "Subscription", "type": "crm"},
    "intercom":          {"category": "Subscription", "type": "support"},
    "freshdesk":         {"category": "Subscription", "type": "support"},
    "postman":           {"category": "Subscription", "type": "dev_tool"},
    "sentry":            {"category": "Subscription", "type": "dev_tool"},
    "datadog":           {"category": "Subscription", "type": "dev_tool"},

    # ── Fuel & Vehicle ────────────────────────────────────────────────────────
    "hp petrol":         {"category": "Fuel & Vehicle", "type": "fuel"},
    "hindustan petroleum": {"category": "Fuel & Vehicle", "type": "fuel"},
    "indian oil":        {"category": "Fuel & Vehicle", "type": "fuel"},
    "iocl":              {"category": "Fuel & Vehicle", "type": "fuel"},
    "bharat petroleum":  {"category": "Fuel & Vehicle", "type": "fuel"},
    "bpcl":              {"category": "Fuel & Vehicle", "type": "fuel"},
    "reliance petrol":   {"category": "Fuel & Vehicle", "type": "fuel"},
    "nayara energy":     {"category": "Fuel & Vehicle", "type": "fuel"},
    "shell":             {"category": "Fuel & Vehicle", "type": "fuel"},
    "essar":             {"category": "Fuel & Vehicle", "type": "fuel"},

    # ── Internet & Communication ──────────────────────────────────────────────
    "airtel":            {"category": "Internet & Communication", "type": "telecom"},
    "jio":               {"category": "Internet & Communication", "type": "telecom"},
    "vodafone":          {"category": "Internet & Communication", "type": "telecom"},
    "vi ":               {"category": "Internet & Communication", "type": "telecom"},
    "idea":              {"category": "Internet & Communication", "type": "telecom"},
    "bsnl":              {"category": "Internet & Communication", "type": "telecom"},
    "act fibernet":      {"category": "Internet & Communication", "type": "broadband"},
    "hathway":           {"category": "Internet & Communication", "type": "broadband"},
    "you broadband":     {"category": "Internet & Communication", "type": "broadband"},
    "excitel":           {"category": "Internet & Communication", "type": "broadband"},

    # ── Office Supplies ───────────────────────────────────────────────────────
    "staples":           {"category": "Office Supplies", "type": "stationery"},
    "officeyes":         {"category": "Office Supplies", "type": "stationery"},
    "classmate":         {"category": "Office Supplies", "type": "stationery"},
    "camlin":            {"category": "Office Supplies", "type": "stationery"},

    # ── Medical ───────────────────────────────────────────────────────────────
    "apollo pharmacy":   {"category": "Medical & Health", "type": "pharmacy"},
    "medplus":           {"category": "Medical & Health", "type": "pharmacy"},
    "1mg":               {"category": "Medical & Health", "type": "pharmacy"},
    "netmeds":           {"category": "Medical & Health", "type": "pharmacy"},
    "pharmeasy":         {"category": "Medical & Health", "type": "pharmacy"},
    "practo":            {"category": "Medical & Health", "type": "clinic"},

    # ── Training & Development ────────────────────────────────────────────────
    "udemy":             {"category": "Training & Development", "type": "e_learning"},
    "coursera":          {"category": "Training & Development", "type": "e_learning"},
    "linkedin learning": {"category": "Training & Development", "type": "e_learning"},
    "pluralsight":       {"category": "Training & Development", "type": "e_learning"},
    "skillshare":        {"category": "Training & Development", "type": "e_learning"},
    "simplilearn":       {"category": "Training & Development", "type": "e_learning"},
    "upgrad":            {"category": "Training & Development", "type": "e_learning"},
}

# Categories that are close enough to not flag as mismatch
_COMPATIBLE_PAIRS = {
    frozenset({"travel & transport", "conveyance"}),
    frozenset({"travel & transport", "fuel & vehicle"}),
    frozenset({"staff welfare", "food & meals"}),
    frozenset({"office supplies", "miscellaneous"}),
    frozenset({"internet & communication", "subscription"}),
}


def suggest_category(vendor_name: str) -> Optional[dict]:
    """
    Given a vendor name (from OCR), return best matching category.
    Returns None if no confident match found.

    Return shape:
      { "category": str, "confidence": "high"|"medium", "matched_vendor": str, "type": str }
    """
    if not vendor_name:
        return None

    v = vendor_name.lower().strip()

    # 1. Exact key match
    if v in VENDOR_MASTER:
        info = VENDOR_MASTER[v]
        if info.get("ambiguous"):
            return None  # Skip ambiguous vendors
        return {
            "category":       info["category"],
            "confidence":     "high",
            "matched_vendor": v,
            "type":           info.get("type", ""),
        }

    # 2. Substring match: known vendor keyword inside the OCR name, or vice-versa
    best = None
    best_len = 0
    for known, info in VENDOR_MASTER.items():
        if info.get("ambiguous"):
            continue
        if known in v or v in known:
            # Prefer longer (more specific) matches
            if len(known) > best_len:
                best = (known, info)
                best_len = len(known)

    if best:
        known_v, info = best
        return {
            "category":       info["category"],
            "confidence":     "medium",
            "matched_vendor": known_v,
            "type":           info.get("type", ""),
        }

    return None


def is_vendor_category_mismatch(vendor_name: str, claimed_category: str) -> bool:
    """
    Returns True if the vendor's known category significantly differs from the
    claimed category. Only fires when confidence is 'high' to avoid false positives.
    """
    if not vendor_name or not claimed_category:
        return False

    suggestion = suggest_category(vendor_name)
    if not suggestion or suggestion["confidence"] != "high":
        return False  # Only flag high-confidence mismatches

    expected = suggestion["category"].lower()
    claimed  = claimed_category.lower().strip()

    if expected == claimed:
        return False

    # Allow compatible category pairs
    pair = frozenset({expected, claimed})
    if pair in _COMPATIBLE_PAIRS:
        return False

    # Partial text overlap is also fine
    if expected in claimed or claimed in expected:
        return False

    return True
