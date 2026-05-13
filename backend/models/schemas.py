from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class ExpenseStatus(str, Enum):
    APPROVED = "Approved"
    REJECTED = "Rejected"
    FLAGGED = "Flagged"


class OCRResult(BaseModel):
    vendor_name: Optional[str] = None
    bill_date: Optional[str] = None
    total_amount: Optional[float] = None
    gstin: Optional[str] = None
    confidence: float = 0.0
    raw_text: str = ""
    ocr_engine: Optional[str] = None           # rapidocr/tesseract/pdf-text/ai-vision/mixed
    ai_fallback_used: bool = False             # True when AI vision repaired weak local OCR
    ai_fallback_reason: Optional[str] = None


class ExpenseRow(BaseModel):
    row_index: int
    employee_name: str
    employee_id: str
    expense_date: str
    expense_category: str
    description: str
    claimed_amount: float
    claim_number: Optional[str] = None
    attachment_name: Optional[str] = None

    matched_file: Optional[str] = None          # primary bill (for compat)
    matched_files: List[str] = []               # ALL bills in this claim folder
    ocr_results: List[OCRResult] = []           # OCR per bill
    ocr_result: Optional[OCRResult] = None      # primary OCR (kept for compat)
    status: ExpenseStatus = ExpenseStatus.FLAGGED
    remarks: List[str] = []
    is_duplicate: bool = False
    bill_amount: Optional[float] = None
    amount_diff: Optional[float] = None        # claimed - bill (positive = overclaimed)
    expense_nature: Optional[str] = None       # tagged category label for output
    department: Optional[str] = None           # department from Excel (if column exists)

    # Keka-specific fields (populated only for Keka-synced sessions)
    keka_claim_id: Optional[str] = None
    keka_claim_number: Optional[str] = None
    keka_expense_id: Optional[str] = None
    employee_email: Optional[str] = None
    keka_actioned: Optional[str] = None        # "approved" | "rejected" | None

    # Zoho Books sync fields (populated after push + status sync)
    zoho_bill_id: Optional[str] = None         # Zoho bill_id after push
    zoho_bill_status: Optional[str] = None     # "paid" | "open" | "pending_approval" | "draft" | etc.

    # Anomaly detection flags (populated by anomaly.py after validation)
    anomaly_flags: List[str] = []              # list of human-readable anomaly warnings

    # Vendor Master suggestion (populated by vendor_master.py during validation)
    suggested_category: Optional[str] = None           # suggested category from OCR vendor name
    suggested_category_confidence: Optional[str] = None # "high" | "medium"
    suggested_vendor_type: Optional[str] = None         # e.g. "cab", "food_delivery", "fuel"


class SessionResult(BaseModel):
    session_id: str
    processing_status: str = "processing"
    current_step: Optional[str] = None
    error: Optional[str] = None
    total_claims: int = 0
    approved: int = 0
    rejected: int = 0
    flagged: int = 0
    rows: List[ExpenseRow] = []
    unmapped_bills: List[str] = []
    login_required: bool = False    # True when Keka session expired / not yet logged in
    bills_downloaded: int = 0       # how many attachment files were saved


class SheetsExportResult(BaseModel):
    spreadsheet_id: str
    spreadsheet_url: str
    sheet_name: str
