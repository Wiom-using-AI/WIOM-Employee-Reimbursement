import os
import re
import json
from datetime import datetime as _dt
from typing import List, Optional
from models.schemas import ExpenseRow, ExpenseStatus, SheetsExportResult

try:
    import gspread
    from google.oauth2.service_account import Credentials
    GSPREAD_AVAILABLE = True
except ImportError:
    GSPREAD_AVAILABLE = False

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

HEADERS = [
    "Row #", "Employee Name", "Employee ID", "Department", "Expense Date",
    "Category", "Description", "Claimed Amount ₹", "Bill Amount ₹",
    "Attachment", "Status", "Remarks", "Pushed On",
]

_DATA_SHEET_NAME = "All Data"
_COL_COUNT = len(HEADERS)

STATUS_COLORS = {
    "Approved": {"red": 0.776, "green": 0.937, "blue": 0.808},
    "Rejected": {"red": 1.0,   "green": 0.780, "blue": 0.808},
    "Flagged":  {"red": 1.0,   "green": 0.922, "blue": 0.612},
}


def _get_gc(credentials_path: Optional[str] = None):
    if not GSPREAD_AVAILABLE:
        raise RuntimeError("gspread / google-auth not installed")

    # 1. Try Application Default Credentials — strip quota project, refresh token
    try:
        import google.auth
        from google.auth.transport.requests import Request as _GRequest
        creds, _ = google.auth.default(scopes=SCOPES)
        if hasattr(creds, "with_quota_project"):
            creds = creds.with_quota_project(None)
        if not creds.valid:
            creds.refresh(_GRequest())
        return gspread.Client(auth=creds)
    except Exception:
        pass

    # 2. Fall back to service account JSON file
    creds_file = credentials_path or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if creds_file and os.path.exists(creds_file):
        creds = Credentials.from_service_account_file(creds_file, scopes=SCOPES)
        return gspread.Client(auth=creds)

    raise FileNotFoundError(
        "No Google credentials found. Run 'gcloud auth application-default login' "
        "or place service_account.json at credentials/service_account.json"
    )


def _bill_cell(session_id: str, api_base: str, row: ExpenseRow) -> str:
    """Return a HYPERLINK formula for the bill, or '—' if no file matched."""
    keys = row.matched_files or ([row.matched_file] if row.matched_file else [])
    if not keys:
        return "—"
    # Link to first bill; label shows filename
    key   = keys[0]
    url   = f"{api_base}/bill/{session_id}/{key}"
    label = os.path.basename(key)
    # If multiple bills, label shows count
    if len(keys) > 1:
        label = f"{len(keys)} bills"
    return f'=HYPERLINK("{url}","{label}")'


_REMARK_STRIP = re.compile(
    r"(Matched via \w+\s*—?\s*|Amount matches exactly\.?\s*|"
    r"\[Manual Override\]\s*|"
    r"bill\s*matched\s*via\s*\w+\s*—?\s*)", re.I
)

def _shorten_remarks(remarks: List[str]) -> str:
    if not remarks:
        return "—"
    clean = []
    seen  = set()
    for r in remarks:
        r = _REMARK_STRIP.sub("", r).strip().rstrip(".")
        if not r or r.lower() in seen:
            continue
        seen.add(r.lower())
        # Truncate long remarks
        if len(r) > 60:
            r = r[:57] + "…"
        clean.append(r)
    return "; ".join(clean) if clean else "—"


_SHEETS_CONFIG_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "sheets_config.json"
)
_PERSISTENT_SHEET_TITLE = "Wiom Expense Validation"


def _load_sheets_config() -> dict:
    try:
        with open(_SHEETS_CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_sheets_config(cfg: dict) -> None:
    os.makedirs(os.path.dirname(_SHEETS_CONFIG_PATH), exist_ok=True)
    with open(_SHEETS_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def _get_or_create_spreadsheet(gc):
    """Return (spreadsheet, is_new). Opens existing persistent sheet or creates one."""
    cfg = _load_sheets_config()
    sid = cfg.get("spreadsheet_id")
    if sid:
        try:
            sp = gc.open_by_key(sid)
            return sp, False
        except Exception:
            pass  # deleted/inaccessible — create fresh
    sp = gc.create(_PERSISTENT_SHEET_TITLE)
    sp.share(None, perm_type="anyone", role="reader")
    cfg["spreadsheet_id"] = sp.id
    _save_sheets_config(cfg)
    return sp, True


def _col_letter(n: int) -> str:
    """Convert 1-based column index to letter (1→A, 13→M, etc.)."""
    result = ""
    while n:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result

_LAST_COL = _col_letter(_COL_COUNT)   # e.g. "M" for 13 columns


def push_to_google_sheets(
    rows: List[ExpenseRow],
    sheet_title: str = "Expense Validation Report",
    credentials_path: Optional[str] = None,
    session_id: Optional[str] = None,
    api_base: str = "http://localhost:8002",
) -> SheetsExportResult:
    gc = _get_gc(credentials_path)
    spreadsheet, is_new = _get_or_create_spreadsheet(gc)

    # Get or create the single "All Data" worksheet
    existing_titles = {ws.title for ws in spreadsheet.worksheets()}
    if _DATA_SHEET_NAME in existing_titles:
        worksheet = spreadsheet.worksheet(_DATA_SHEET_NAME)
        # Find last used row so we can append
        all_vals = worksheet.get_all_values()
        start_row = len(all_vals) + 1   # next empty row (1-based)
    else:
        worksheet = spreadsheet.add_worksheet(
            title=_DATA_SHEET_NAME, rows=1000, cols=_COL_COUNT + 2
        )
        start_row = 1

    # If this is a brand-new spreadsheet, remove the default Sheet1
    if is_new:
        try:
            spreadsheet.del_worksheet(spreadsheet.worksheet("Sheet1"))
        except Exception:
            pass

    pushed_on = _dt.now().strftime("%d %b %Y %H:%M")

    # Write header only on first push (row 1 empty)
    if start_row == 1:
        worksheet.update(f"A1:{_LAST_COL}1", [HEADERS], value_input_option="RAW")
        worksheet.format(f"A1:{_LAST_COL}1", {
            "backgroundColor": {"red": 0.118, "green": 0.094, "blue": 0.490},
            "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
            "horizontalAlignment": "CENTER",
        })
        start_row = 2

    # Build plain data rows (no formulas yet)
    plain_rows = []
    for row in rows:
        plain_rows.append([
            row.row_index,
            row.employee_name or "",
            row.employee_id or "",
            row.department or "—",
            row.expense_date or "",
            row.expense_category or "",
            row.description or "",
            row.claimed_amount,
            row.bill_amount if row.bill_amount is not None else "N/A",
            "",              # attachment — filled below with formula
            row.status.value,
            _shorten_remarks(row.remarks),
            pushed_on,
        ])

    end_row = start_row + len(plain_rows) - 1
    worksheet.update(
        f"A{start_row}:{_LAST_COL}{end_row}",
        plain_rows,
        value_input_option="RAW",
    )

    # Attachment hyperlink formulas — column J (index 10, 1-based)
    attach_col = _col_letter(10)
    if session_id:
        attachment_cells = []
        for i, row in enumerate(rows, start=start_row):
            attachment_cells.append({
                "range": f"{attach_col}{i}",
                "values": [[_bill_cell(session_id, api_base, row)]],
            })
        if attachment_cells:
            worksheet.batch_update(attachment_cells, value_input_option="USER_ENTERED")

    # Color-code status rows
    status_col = _col_letter(11)
    for i, row in enumerate(rows, start=start_row):
        color = STATUS_COLORS.get(row.status.value)
        if color:
            worksheet.format(f"A{i}:{_LAST_COL}{i}", {"backgroundColor": color})

    return SheetsExportResult(
        spreadsheet_id=spreadsheet.id,
        spreadsheet_url=spreadsheet.url,
        sheet_name=_DATA_SHEET_NAME,
    )
