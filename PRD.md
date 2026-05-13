# Product Requirements Document
## Expense Validator — Automated Employee Expense Reimbursement Platform

**Company:** Wiom (Omnia Information Pvt. Ltd.)
**Document Version:** 1.0
**Date:** May 2026
**Author:** Engineering Team
**Audience:** CEO, Leadership, Finance

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Product Vision](#3-product-vision)
4. [User Personas](#4-user-personas)
5. [End-to-End Workflow](#5-end-to-end-workflow)
6. [Feature Breakdown](#6-feature-breakdown)
7. [Integrations](#7-integrations)
8. [Security & Access Control](#8-security--access-control)
9. [Technical Architecture](#9-technical-architecture)
10. [Metrics & Business Impact](#10-metrics--business-impact)
11. [Roadmap](#11-roadmap)

---

## 1. Executive Summary

**Expense Validator** is Wiom's internal AI-powered expense reimbursement platform that automates the end-to-end validation, approval, and accounting of employee expense claims.

Before this platform, every expense batch required a finance team member to:
- Manually cross-check hundreds of bills against Excel reports
- Physically verify amounts, dates, and vendor names
- Manually create vendor bills in Zoho Books
- Manually approve/reject claims in Keka (our HR system)

This took **2–3 days per batch** and was highly error-prone.

**After Expense Validator:**
- A full batch of 50+ claims is validated in **under 3 minutes**
- Bills are matched, OCR-scanned, and cross-verified automatically
- Approved claims are pushed directly to **Zoho Books** and **Keka HR** with one click
- Finance has a real-time dashboard with analytics, audit trail, and export to Excel / Google Sheets
- The entire process from upload to payment tracking is handled inside one platform

---

## 2. Problem Statement

### Current Pain Points (Before This System)

| Pain Point | Impact |
|---|---|
| Manual bill verification (amount, date, vendor) | 2–3 hours per batch, high human error |
| No duplicate detection | Same bill submitted twice goes unnoticed |
| Keka approvals done one-by-one | Finance team clicks hundreds of times per cycle |
| Zoho Books entry is fully manual | 30–45 min per batch just for data entry |
| No audit trail | No record of who approved what and when |
| No policy enforcement | Claims exceeding limits approved accidentally |
| Finance can't track what's been paid vs. pending | No visibility into reimbursement status |
| OCR/bill reading done by eye | Fatigue-driven errors increase with batch size |

### Scale of the Problem at Wiom

- Employees submit expense claims every **2 weeks**
- Average batch size: **40–80 claims** per cycle
- Bill types: Fuel, Travel, Food, Accommodation, Subscriptions, Office Supplies
- Some bills are in USD (SaaS subscriptions) requiring live currency conversion
- Bills are a mix of **PDFs, JPEGs, and PNGs** — sometimes blurry or handwritten

---

## 3. Product Vision

> **One platform to validate, approve, book, and track every employee expense — from raw bills to payment confirmation — without any manual data entry.**

### Design Principles

- **Automation First** — Every step that can be automated, is automated
- **Human in the Loop** — Admins retain full override capability on every decision
- **Zero Trust on Bills** — Every bill is OCR-scanned and cross-verified; nothing is approved on faith
- **Full Audit Trail** — Every action (approval, edit, push, login) is logged with actor and timestamp
- **Role-Based Access** — Finance admins can act; reviewers can only view

---

## 4. User Personas

### Persona 1: Finance Admin (Primary User)
- **Who:** Finance/accounts team member at Wiom
- **Goal:** Process an expense batch end-to-end — validate, approve in Keka, book in Zoho — in under 15 minutes
- **Access Level:** Full admin — can edit, approve, reject, export, push to Zoho/Keka
- **Pain Before:** Spending 2–3 days per batch on manual work

### Persona 2: Reviewer / Manager (Read-Only)
- **Who:** Department heads, HR, senior leadership
- **Goal:** View validation results and analytics for their team without making changes
- **Access Level:** Read-only — can view all data, download Excel, generate PDF reports
- **Pain Before:** Had no visibility; had to ask Finance for status updates

### Persona 3: CEO / Leadership (Executive View)
- **Who:** C-suite
- **Goal:** Understand reimbursement spend at a glance — total approved, pending, by category, by employee
- **Access Level:** Overview dashboard + PDF report
- **Pain Before:** No consolidated view; had to ask Finance for a manual summary

---

## 5. End-to-End Workflow

Below is the step-by-step lifecycle of a single expense batch through the platform.

---

### STEP 1 — Data Ingestion (Two Sources)

#### Option A: Manual Upload
The Finance Admin uploads two files:
1. **Excel Report** — exported from Keka, containing one row per claim (employee name, ID, date, category, amount, attachment filename)
2. **ZIP of Bills** — all supporting documents (PDFs, JPEGs, PNGs) in a ZIP archive

#### Option B: Keka Direct Integration (Automated Pull)
The admin enters a date range in the **Keka** tab. The system:
- Logs into Keka using browser automation (Playwright)
- Downloads the expense report and all attached bills automatically
- No manual export/upload required

> **Tech:** Keka uses a proprietary portal with session-based auth. The platform handles login, navigation, report download, and ZIP extraction automatically.

---

### STEP 2 — Bill Matching (Multi-Strategy)

The system matches each Excel row to its physical bill file using three strategies in priority order:

| Strategy | How It Works |
|---|---|
| **Exact match** | Attachment filename in Excel matches bill filename in ZIP (case-insensitive) |
| **Fuzzy match** | Uses file similarity scoring — handles typos and partial names |
| **Amount-based fallback** | If filename doesn't match, OCR the bill and match by amount |

- Bills are organized by employee-ID folders inside the ZIP
- The system handles flat ZIPs and nested folder structures
- Unmapped bills (in ZIP but not referenced in Excel) are flagged separately

---

### STEP 3 — OCR Scanning (Parallel Processing)

Every matched bill is scanned using OCR to extract:

| Field Extracted | Used For |
|---|---|
| **Total Amount** | Cross-verify claimed amount |
| **Bill Date** | Cross-verify claimed date |
| **Vendor Name** | Cross-verify vendor |
| **GSTIN** | Compliance/audit |
| **Confidence Score** | Flag low-quality scans for manual review |

- OCR runs **concurrently** on all bills (up to 32 parallel threads) — a 50-bill batch scans in seconds
- Supports **Tesseract** and **RapidOCR** engines; RapidOCR is preferred for accuracy
- Results are **cached on disk** — re-running validation on the same bills skips re-scanning
- **USD bills** (SaaS: OpenAI, GitHub, Figma, Zoom, etc.) are auto-detected and converted to INR using **live exchange rates** (cached daily, fallback to ₹93)

---

### STEP 4 — Validation Engine

Each claim is run through a 6-check validation pipeline:

| Check | Pass Condition | Fail → |
|---|---|---|
| **Bill Present** | Attachment found and matched in ZIP | Rejected |
| **Amount Match** | `|Claimed − OCR Amount| ≤ ₹5` | Rejected |
| **Date Match** | `|Claimed Date − Bill Date| ≤ 2 days` | Rejected |
| **Vendor Match** | Fuzzy string similarity ≥ 70% | Rejected |
| **Duplicate Detection** | Same bill file not used by multiple rows | Flagged |
| **OCR Quality** | Confidence score ≥ 30% | Flagged |

**Final Status Logic:**
- Any hard fail → **Rejected** (shown in red)
- Only soft issues (low OCR confidence, duplicate flag) → **Flagged** (shown in amber)
- All checks pass → **Approved** (shown in green)

**Policy Rules (Optional):**
- Admins can configure per-category spend limits (e.g., Food ≤ ₹500/claim)
- Claims exceeding limits are flagged as policy violations
- Policy enforcement is on/off toggleable per category

---

### STEP 5 — Results Dashboard

After processing, the admin sees a full dashboard with:

#### Summary Cards
- Total Claims / Approved / Rejected / Flagged counts
- Approval rate percentage

#### Expense Table
- One row per claim with: Employee, Claim #, Date, Category, Claimed ₹, Bill ₹, Diff ₹, Status, Remarks
- **Click any row** to expand — shows full OCR data, all matched bill images, GSTIN, confidence score
- **Sortable** by any column; **filterable** by status, employee, category
- Inline **"View Bill"** link opens the scanned bill directly
- **Zoho status badge** on each row (PAID / OPEN / PENDING / VOID) after Zoho sync

#### Admin-Only Controls (per row)
- **Manual Override** — change status, edit bill amount, add a note/reason
- **Keka Approve / Reject** — approve or reject the claim directly in Keka from this row

#### Tabs
1. **Validation Results** — the main table above
2. **Analytics** — category breakdown charts, spend trends, top claimants
3. **Zoho Status** — live status of all pushed bills fetched from Zoho API

---

### STEP 6 — Keka Actions (HR System)

#### Bulk Approve / Reject
- Admin selects multiple claims using checkboxes
- Clicks **Approve (N)** or **Reject (N)**
- The system calls Keka's API in the background, processes all selected claims simultaneously
- Results shown inline — success count, error count, per-claim errors
- Rejected claims: Admin must enter a rejection reason; Keka emails the employee automatically

#### KekaActionsBar
- Quick-access bar at the top of the validation tab
- Shows count of unactioned Keka claims
- Supports "approve all approved", "reject all rejected" with one button

---

### STEP 7 — Zoho Books Push (Accounting)

#### Configure & Push
Admin clicks **"Push to Zoho Books"** → a config dialog appears:
- Shows all approved claims
- Pre-selects expense account based on category (auto-detected from Zoho chart of accounts)
- Admin can override the account per row or deselect specific rows
- Click "Push N to Zoho Books" → creates vendor bills as **drafts** in Zoho Books

#### What Gets Created in Zoho
- Vendor (employee) — created if not exists; if auto-number assigned, **Fix Vendor Numbers** replaces it with the employee code
- Vendor Bill with: bill number, line item (expense description), amount, date, category account
- Bill attachment (the original scanned bill PDF/image)
- Direct link to the Zoho bill shown in the UI after push

#### Post-Push Verification
After push, each bill is **AI-verified** — the system re-fetches the Zoho bill and checks:
- Amount matches
- Vendor is correct
- Any discrepancies are flagged inline

---

### STEP 8 — Zoho Sync (Live Status Tracking)

After bills are in Zoho:
- Admin clicks 🔄 **"Sync with Zoho"** on the session card (in Session History)
- System fetches live bill status for every pushed bill via Zoho API
- Status updated per row: **PAID / OPEN / PENDING APPROVAL / DRAFT / VOID**
- In the expense table, each row shows a color-coded **"Zoho: PAID"** badge
- The Overview dashboard shows **total amount booked in Zoho** as a KPI

---

### STEP 9 — Export

| Export Type | Who | What |
|---|---|---|
| **Excel Report** | Everyone | Color-coded XLSX — green/red/amber rows by status, all data columns, OCR diff |
| **Google Sheets** | Admin only | Pushes to a new Google Sheet with shareable link |
| **PDF Report** | Everyone | Executive summary PDF — KPIs, charts, top claims, category breakdown |

---

### STEP 10 — Audit Trail & History

**Session History Page:**
- Lists all validation sessions with: date, claim counts, approval rate, Zoho pushed count, Keka actioned count
- Stat bar per session: Approved / Rejected / Flagged / Keka / Zoho progress bars
- 🔄 Sync with Zoho button per session
- Admin can re-validate a session (re-runs OCR + validation with latest logic)
- Admin can delete a session

**Activity Logs Page:**
- Full log of every action: login, upload, edit, export, Keka action, Zoho push
- Timestamp, actor (username), session ID, action type

---

## 6. Feature Breakdown

### Core Features

| Feature | Description |
|---|---|
| Multi-strategy bill matching | Exact → fuzzy → amount-based fallback |
| Parallel OCR processing | Up to 32 concurrent threads; RapidOCR + Tesseract |
| OCR disk cache | Repeat validations skip re-scanning |
| USD auto-detection + live FX | SaaS bills converted at live INR rate |
| Duplicate bill detection | Cross-row duplicate flagging |
| Policy rule engine | Configurable per-category spend limits |
| Manual override | Admin can change status, amount, add notes |
| Re-validate session | Re-run full OCR + validation with latest logic |
| Unmapped bill detection | Bills in ZIP not referenced by Excel are listed |
| Multi-bill per claim | One claim can have multiple physical bills |
| Dark mode | Full dark mode UI |
| Mobile-friendly | Responsive layout works on tablets |

### Anomaly Detection Engine

Runs automatically after every validation. Checks both within-session and cross-session patterns.

| Anomaly Check | What It Detects | Scope |
|---|---|---|
| **Sunday/Holiday billing** | Bill date falls on Sunday or Indian public holiday | Per claim |
| **Amount near policy limit** | Claimed amount is within 5% below a configured limit (classic split-bill avoidance) | Per claim |
| **Vendor frequency spike** | Same vendor appears in 4+ claims in a single batch (possible colluding vendor) | Within session |
| **Vendor-category mismatch** | OCR vendor name (e.g. "Swiggy") doesn't match claimed category (e.g. "Travel") — high-confidence only | Per claim |
| **Identical repeated claim** | Same employee, same amount, same category submitted 2+ times in past sessions | Cross-session |
| **Repeated near-limit pattern** | Employee has submitted amounts just below a policy limit 2+ times across sessions — flags systematic avoidance | Cross-session |

Flags are shown as orange **⚠ N anomalies** badges directly on the row. Expanding the row shows the full list. Anomaly count is aggregated in the Executive Overview dashboard.

### Vendor Master Database

A curated database of 100+ common Indian vendors mapped to expense categories.

| Vendor Type | Examples | Auto-suggested Category |
|---|---|---|
| Cab & Ride | Uber, Ola, Meru | Travel & Transport |
| Bike Taxi | Rapido, Yulu | Conveyance |
| Flight/Train | IndiGo, IRCTC, MakeMyTrip, Cleartrip | Travel & Transport |
| Food Delivery | Swiggy, Zomato, Box8, Faasos | Staff Welfare |
| Restaurants | Dominos, KFC, Subway, Starbucks, CCD | Staff Welfare |
| Hotels | OYO, Treebo, Lemon Tree, Airbnb | Accommodation |
| SaaS/AI | OpenAI, GitHub, Figma, Notion, Adobe, AWS | Subscription |
| E-Learning | Udemy, Coursera, Simplilearn, UpGrad | Training & Development |
| Fuel | Indian Oil, BPCL, HP Petrol, Nayara | Fuel & Vehicle |
| Telecom | Airtel, Jio, Vodafone, BSNL | Internet & Communication |
| Pharmacy | Apollo, MedPlus, 1mg, PharmEasy | Medical & Health |

When the OCR vendor name matches a known vendor, the system:
1. Sets `suggested_category` on the row (shown as a violet 🏷 badge)
2. Flags a mismatch if the claimed category differs significantly from the vendor's known category

### Smart Category Auto-Suggestion

After OCR extracts the vendor name from the bill, the Vendor Master is queried to suggest the most appropriate expense category.

- **High confidence**: Exact vendor name match → shown as `🏷 Suggested: Staff Welfare (high)` badge
- **Medium confidence**: Partial/substring match → shown with confidence label
- If suggested category differs from what the employee claimed → orange mismatch warning shown in expanded row
- Never auto-overrides the claimed category — always a suggestion for human review

### Keka Integration

| Feature | Description |
|---|---|
| Direct report download | Browser automation pulls expense data from Keka |
| Per-row approve/reject | Single claim Keka action from the table |
| Bulk approve/reject | Multi-select and approve/reject dozens at once |
| Rejection reason + email | Keka emails employee with reason on rejection |
| Actioned status tracking | Approved/rejected status tracked per claim |

### Zoho Books Integration

| Feature | Description |
|---|---|
| Smart account auto-detection | Maps expense category to correct Zoho account |
| Per-row account override | Admin can change the account before pushing |
| Draft bill creation | Bills pushed as drafts (admin reviews in Zoho before approving) |
| Bill attachment upload | Original scanned bill attached to Zoho bill |
| Post-push AI verification | Re-fetches bill from Zoho and checks correctness |
| Fix vendor numbers | Replaces auto-generated Zoho vendor codes with employee codes |
| Live status sync | Fetches PAID/OPEN/PENDING status per bill from Zoho API |
| Zoho status badge per row | Color-coded status shown inline in expense table |

### Analytics

| Chart / Metric | What It Shows |
|---|---|
| Category breakdown | Spend by category (Travel, Food, Subscription, etc.) |
| Top claimants | Top 5 employees by total claim amount |
| Monthly trend | 6-month bar chart of total vs. approved spend |
| Approval rate | % of claims approved across all batches |
| Total approved (all time) | Cumulative approved spend |
| Booked in Zoho | Total approved amount already in Zoho Books |
| Pending reimbursement | Approved but not yet in Zoho |
| Policy violations | Count of claims exceeding policy limits |

### Admin Panel

| Feature | Description |
|---|---|
| User management | Create/edit/deactivate users |
| Role assignment | Admin vs. Reviewer |
| Policy rule config | Toggle and set per-category spend limits |
| Global search | Search claims across all sessions by employee, amount, status |
| Activity logs | Full audit log of all platform actions |
| Session lock/unlock | Lock a session to prevent any further edits |

---

## 7. Integrations

### Keka HR (keka.com)
- **Method:** Browser automation (Playwright) + REST API
- **What:** Download expense reports + bill ZIPs; approve/reject claims
- **Auth:** Keka session login (stored securely per session)
- **Scope:** Read expense claims, approve, reject with reason

### Zoho Books India (zoho.in)
- **Method:** Zoho Books REST API v3 (India region)
- **What:** Create vendors, create vendor bills, upload attachments, fetch bill status
- **Auth:** OAuth 2.0 with refresh token (auto-refreshes before expiry)
- **Org:** Single org (Wiom's Zoho org ID)

### Google Sheets (Optional)
- **Method:** Google Sheets API via service account
- **What:** Push validation results to a new Google Sheet
- **Auth:** GCP service account JSON key

### Exchange Rate API
- **Method:** Live rate fetch (cached daily to disk)
- **What:** USD → INR conversion for SaaS bills
- **Fallback:** ₹93/USD if API unavailable

---

## 8. Security & Access Control

### Authentication
- JWT-based session tokens (24-hour TTL)
- Username + password login
- All tokens verified on every API call

### Role-Based Access (RBAC)

| Action | Admin | Reviewer |
|---|---|---|
| View validation results | ✅ | ✅ |
| Download Excel / PDF report | ✅ | ✅ |
| Edit row (status, amount, note) | ✅ | ❌ |
| Re-validate session | ✅ | ❌ |
| Push to Zoho Books | ✅ | ❌ |
| Push to Google Sheets | ✅ | ❌ |
| Fix vendor numbers | ✅ | ❌ |
| Keka approve / reject | ✅ | ❌ |
| Delete session | ✅ | ❌ |
| User management | ✅ | ❌ |
| View admin panel / logs | ✅ | ❌ |

### Backend Enforcement
- Every write endpoint requires `_require_admin()` check at the server level
- Frontend UI hides write actions for non-admins (defense-in-depth)
- Non-admin users see a 🔒 read-only notice on every session

### Audit Trail
- Every action logged: actor, timestamp, session, action type, IP address
- Login attempts (success + failure) logged
- Logs accessible only to admins

---

## 9. Technical Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    FRONTEND (React + Vite)                   │
│                                                              │
│  Pages: Login · Upload · Dashboard · Session History         │
│         Overview · Keka · Admin · Config · Logs · Search    │
│                                                              │
│  Components: ExpenseTable · ExportPanel · SummaryCards       │
│             AnalyticsTab · ZohoStatusTab · KekaActionsBar    │
│             PdfReport · Navbar                               │
│                                                              │
│  Styling: Tailwind CSS · Dark Mode · Responsive              │
└──────────────────────────┬─────────────────────────────────┘
                           │ REST API (Axios)
                           │ Bearer Token Auth
┌──────────────────────────▼─────────────────────────────────┐
│                   BACKEND (FastAPI / Python)                  │
│                                                              │
│  API Endpoints:                                              │
│  POST /upload                  → Start validation session    │
│  GET  /session/{id}/status     → Poll processing progress   │
│  GET  /session/{id}/results    → Fetch validated rows        │
│  PUT  /session/{id}/row/{i}    → Manual row edit (admin)    │
│  POST /session/{id}/revalidate → Re-run OCR + validation    │
│  POST /session/{id}/zoho-push  → Push to Zoho Books        │
│  POST /session/{id}/zoho-sync  → Fetch live Zoho status    │
│  POST /session/{id}/keka       → Keka approve/reject        │
│  GET  /session/{id}/export     → Download Excel report      │
│  POST /session/{id}/sheets     → Push to Google Sheets      │
│  GET  /overview/stats          → Aggregate KPI data         │
│  POST /auth/login              → Issue JWT token            │
│  GET  /history                 → All sessions with stats    │
│                                                              │
│  Services:                                                   │
│  ocr.py         → Tesseract + RapidOCR; parallel; cached    │
│  matcher.py     → 3-strategy bill matching + fallback       │
│  validator.py   → 6-check validation; policy rules; FX      │
│  zoho.py        → Zoho Books API; push, verify, sync        │
│  keka.py        → Keka API: approve, reject, bulk           │
│  keka_browser.py → Playwright: login, download, extract     │
│  sheets.py      → Google Sheets push via service account    │
│  exporter.py    → Color-coded Excel generation              │
│  auth.py        → JWT issue + verify; user management       │
│  db.py          → SQLite: sessions, users, activity log     │
│                                                              │
└──────────────────────────┬─────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ┌──────────┐      ┌────────────┐     ┌──────────────┐
  │  SQLite  │      │ File Store │     │  OCR Cache   │
  │  (app.db)│      │ (session   │     │ (disk JSON)  │
  │ sessions │      │  uploads,  │     │ avoids re-   │
  │ users    │      │  bills,    │     │ scanning     │
  │ logs     │      │  result.   │     │ same bills)  │
  └──────────┘      │  json,     │     └──────────────┘
                    │  zoho_push.│
                    │  json)     │
                    └────────────┘

External APIs:
  ├── Zoho Books India API (OAuth 2.0)
  ├── Keka HR Portal (Session Auth)
  ├── Google Sheets API (Service Account)
  └── Exchange Rate API (Live FX)
```

### Processing Pipeline (per batch)

```
Upload Excel + ZIP
  → [1] Parse Excel rows (auto-detect column names)
  → [2] Extract ZIP (flat + folder structure support)
  → [3] Match bills to rows (exact → fuzzy → amount fallback)
  → [4] OCR all bills in parallel (up to 32 threads, cached)
  → [5] Prefetch USD/INR rates for flagged USD bills
  → [6] Validate each row (6 checks + policy rules)
  → [7] Compute summary stats (approved/rejected/flagged)
  → [8] Persist to result.json + SQLite
  → [9] Return results to frontend
```

**Average time for 50-claim batch: 45–90 seconds** (depending on bill quality and OCR engine)

---

## 10. Metrics & Business Impact

### Time Saved

| Task | Before (Manual) | After (Automated) | Saving |
|---|---|---|---|
| Bill verification (50 claims) | 2–3 hours | ~90 seconds | **~99%** |
| Keka bulk approve/reject | 30–45 min | ~2 min | **~95%** |
| Zoho Books data entry | 30–45 min | ~1 min | **~97%** |
| Status reporting to management | 15–20 min | Instant (dashboard) | **100%** |
| **Total per batch** | **~4–5 hours** | **~10 min** | **~97%** |

### Error Reduction
- Duplicate bill detection eliminates double-payment risk
- Amount cross-verification catches overclaiming
- Vendor fuzzy match catches wrong bill attachments
- Policy rules prevent limit violations from slipping through

### Audit & Compliance
- Every action logged with actor + timestamp
- Full history of every edit, approval, push
- Zoho bill links provide accounting trail
- PDF report for board/management review

### Financial Visibility
- Real-time view of pending reimbursement vs. already-booked in Zoho
- Category-wise spend breakdown (Travel vs. Food vs. Subscription, etc.)
- Month-over-month trend of expense volume
- Top claimants by amount — identifies outliers

---

## 11. Roadmap

### Phase 1 — Complete ✅ (Current State)

- [x] Anomaly Detection Engine (6 checks: Sunday/holiday, near-limit, vendor frequency, category mismatch, cross-session patterns)
- [x] Vendor Master Database (100+ Indian vendors → auto category)
- [x] Smart Category Auto-Suggestion (OCR vendor → suggested category badge)
- [x] Upload + OCR pipeline
- [x] Multi-strategy bill matching
- [x] 6-check validation engine
- [x] Manual override by admin
- [x] Duplicate detection
- [x] Excel + Google Sheets export
- [x] PDF report
- [x] Zoho Books push + verification
- [x] Zoho live status sync (PAID/OPEN/PENDING)
- [x] Keka direct download (browser automation)
- [x] Keka bulk approve/reject (API)
- [x] Role-based access (Admin vs. Reviewer)
- [x] JWT authentication
- [x] Session history with stats
- [x] Executive overview dashboard
- [x] Analytics tab (charts, trends, claimants)
- [x] Activity audit logs
- [x] Policy rule engine (configurable limits)
- [x] USD auto-detect + live FX conversion
- [x] OCR result caching
- [x] Dark mode
- [x] Global search across all sessions
- [x] Admin user management

### Phase 2 — Planned

- [ ] **Email notifications** — Auto-notify employees when claim is approved/rejected with amount
- [ ] **Mobile app** — Employee-facing app to submit bills directly (no Excel needed)
- [ ] **Multi-company support** — Multiple Zoho orgs / Keka tenants
- [ ] **Custom report templates** — CFO/CEO/Dept-head report variants
- [ ] **Recurring expenses detection** — Flag employees who submit identical amounts repeatedly
- [ ] **Receipt AI (Vision model)** — Replace Tesseract with LLM-based bill reading for higher accuracy on handwritten/damaged bills
- [ ] **Slack/WhatsApp integration** — Finance team gets approval summary via Slack message
- [ ] **Auto-approval rules** — Claims below ₹X from trusted employees auto-approved without manual review
- [ ] **Multi-currency support** — AED, EUR, GBP in addition to USD
- [ ] **Cloud deployment** — Move from local Windows server to cloud (Render/Railway) for 24x7 uptime

### Phase 3 — Vision

- [ ] **Employee self-service portal** — Submit claims, track status, see payment dates
- [ ] **Predictive analytics** — Forecast monthly expense budget based on trends
- [ ] **ERP integration** — Direct sync with SAP / Tally for companies using on-premise ERP
- [ ] **Compliance module** — GST input credit identification from GSTIN on bills
- [ ] **Approval workflows** — Multi-level approval (Manager → Finance → CFO) based on amount thresholds

---

## Appendix — Validation Rules Reference

| Check | Threshold | Configurable? |
|---|---|---|
| Amount tolerance | ±₹5 (INR bills) | Yes |
| Date tolerance | ±2 days | Yes |
| Vendor fuzzy match | ≥70% similarity | Yes |
| OCR confidence minimum | ≥30% | Yes |
| USD detection | Keyword-based (OpenAI, GitHub, etc.) | No |
| Duplicate detection | Same file → multiple rows | No |

## Appendix — Expense Categories Supported

Travel & Transport · Staff Welfare · Conveyance · Subscription · Accommodation · Office Supplies · Medical & Health · Internet & Communication · Training & Development · Fuel & Vehicle · Miscellaneous

## Appendix — Zoho Bill Status Meanings

| Status | Meaning |
|---|---|
| `DRAFT` | Bill created; not yet submitted for approval |
| `OPEN` | Bill approved in Zoho; pending payment |
| `PENDING APPROVAL` | Bill awaiting Zoho approval |
| `PAID` | Bill fully paid — employee reimbursed |
| `VOID` | Bill cancelled/voided |
| `PARTIALLY PAID` | Partial payment made |

---

*Document maintained by Wiom Engineering. Last updated: May 2026.*
