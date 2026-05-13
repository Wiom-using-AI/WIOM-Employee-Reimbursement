# Expense Validator

Automated Employee Expense Validation — upload an Excel report + ZIP of bills, get instant OCR-validated results with Excel/Google Sheets export.

---

## Architecture

```
Frontend (React + Vite + Tailwind)  →  Backend (FastAPI + Python)
         Vercel                              Render / Railway
```

**Processing pipeline:**
```
Upload Excel + ZIP
  → Extract ZIP (flat file map)
  → Read Excel rows
  → Match bills (exact → case-insensitive → fuzzy filename)
  → OCR each bill (Tesseract / pdf2image)
  → Validate (amount ±₹5, date ±2 days, vendor fuzzy ≥70%)
  → Detect duplicates
  → Return JSON results
  → Export: color-coded Excel  OR  Google Sheets
```

---

## Quick Start

### 1. Backend

**Prerequisites**
- Python 3.10+
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) installed on OS
- [Poppler](https://poppler.freedesktop.org/) (for PDF→image conversion)

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env as needed

uvicorn main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

---

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local      # only needed for production
npm run dev
```

App: http://localhost:3000

---

### 3. Generate Sample Files

```bash
cd samples
pip install openpyxl
python generate_sample.py
# Creates: samples/sample_expense_report.xlsx
```

Then create `samples/sample_bills.zip` with a few PDF/image files named:
`bill_001.pdf`, `bill_002.pdf`, …, `bill_007.pdf`

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `UPLOAD_DIR` | No | Where to store uploaded files (default: OS temp) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Only for Sheets export | Path to GCP service account JSON |

### Frontend (`frontend/.env.local`)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | Production only | Backend URL (e.g. `https://expense-validator.onrender.com`) |

---

## Google Sheets Setup (optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → Enable **Google Sheets API** + **Google Drive API**
3. Create a **Service Account** → download JSON key
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json` in backend `.env`

---

## Windows — Tesseract Setup

1. Download installer: https://github.com/UB-Mannheim/tesseract/wiki
2. Install to `C:\Program Files\Tesseract-OCR\`
3. Add to PATH, or set in your Python code:
   ```python
   pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
   ```

## Windows — Poppler Setup

1. Download: https://github.com/oschwartz10612/poppler-windows/releases
2. Extract and add `bin/` folder to PATH

---

## Deployment

### Backend → Render

1. Push `backend/` to GitHub
2. New Web Service on Render → Python → start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Set env vars in Render dashboard

### Frontend → Vercel

1. Push `frontend/` to GitHub
2. Import on Vercel → auto-detects Vite
3. Set `VITE_API_URL` to your Render backend URL

---

## Validation Logic

| Check | Pass Condition |
|---|---|
| Amount | `|claimed - ocr_amount| ≤ ₹5` |
| Date | `|claimed_date - bill_date| ≤ 2 days` |
| Vendor | Fuzzy match ≥ 70% |
| Bill Present | Attachment filename found in ZIP |
| Duplicate | Same bill file referenced by only 1 row |
| OCR Quality | Confidence score ≥ 30% |

**Status logic:**
- Any hard fail (amount/date/vendor mismatch, bill missing) → **Rejected**
- Only soft issues (low OCR confidence, duplicate) → **Flagged**
- All checks pass → **Approved**

---

## Excel Column Mapping

The system auto-detects these column names (case-insensitive):

| Expected | Accepted variants |
|---|---|
| Employee Name | `employee name`, `emp name` |
| Employee ID | `employee id`, `emp id` |
| Expense Date | `expense date`, `date` |
| Expense Category | `expense category`, `category` |
| Description | `description`, `desc` |
| Claimed Amount | `claimed amount`, `amount` |
| Attachment Name | `attachment name`, `file name`, `filename`, `bill name` |
