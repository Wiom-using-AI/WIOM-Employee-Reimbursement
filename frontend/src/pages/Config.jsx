import { useState, useEffect } from "react";
import { kekaConfig, getPolicyRules, savePolicyRules } from "../services/api";

// ── Primitives ────────────────────────────────────────────────────────────────
function Section({ icon, title, subtitle, children }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-slate-100 dark:border-gray-800"
           style={{ background: "linear-gradient(90deg,#fff0f8 0%,#fff 100%)" }}>
        <div className="flex items-center gap-3">
          <span className="text-xl">{icon}</span>
          <div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 tracking-tight">{title}</h2>
            {subtitle && <p className="text-[11px] text-slate-400 dark:text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}

function Badge({ ok, yes = "Configured", no = "Not Set" }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-0.5 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800">✓ {yes}</span>
    : <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-red-50 text-red-600 border border-red-200 rounded-full px-2.5 py-0.5 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800">✗ {no}</span>;
}

function CfgRow({ label, value, badge }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-50 dark:border-gray-800/60 last:border-0">
      <span className="text-xs text-slate-500 dark:text-gray-400 font-medium">{label}</span>
      {badge !== undefined
        ? <Badge ok={badge} />
        : <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{value ?? "—"}</span>}
    </div>
  );
}

function Tag({ color = "slate", children }) {
  const colors = {
    pink:   "bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950/30 dark:text-pink-300 dark:border-pink-800",
    violet: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800",
    emerald:"bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
    amber:  "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
    blue:   "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800",
    red:    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800",
    slate:  "bg-slate-100 text-slate-600 border-slate-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
  };
  return <span className={`inline-block text-[11px] font-semibold border rounded-full px-2.5 py-0.5 ${colors[color]}`}>{children}</span>;
}

function Code({ children }) {
  return <code className="bg-slate-100 dark:bg-gray-800 text-pink-600 dark:text-pink-400 px-1.5 py-0.5 rounded text-[11px] font-mono">{children}</code>;
}

function FeatureCard({ icon, title, tags = [], children }) {
  return (
    <div className="rounded-xl border border-slate-100 dark:border-gray-800 bg-slate-50 dark:bg-gray-800/50 p-4 mb-4">
      <div className="flex items-start gap-3 mb-2">
        <span className="text-lg mt-0.5">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-1">{title}</p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map(([t, c]) => <Tag key={t} color={c}>{t}</Tag>)}
            </div>
          )}
          <div className="text-xs text-slate-500 dark:text-gray-400 leading-relaxed space-y-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Li({ children }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-pink-400 shrink-0 mt-0.5">›</span>
      <span>{children}</span>
    </div>
  );
}

// ── Policy Rules Editor ───────────────────────────────────────────────────────
const POLICY_LABELS = {
  food_meals:        { label: "Food & Meals",             icon: "🍽️", example: "Swiggy, Zomato, restaurant" },
  travel_conveyance: { label: "Travel & Conveyance",      icon: "🚗", example: "Taxi, auto, fuel, cab" },
  accommodation:     { label: "Accommodation",             icon: "🏨", example: "Hotel, guest house, stays" },
  subscription:      { label: "Subscriptions",             icon: "📦", example: "SaaS tools, apps, software" },
  office_supplies:   { label: "Office Supplies",           icon: "🖊️", example: "Stationery, printer, accessories" },
  communication:     { label: "Communication",             icon: "📞", example: "Mobile recharge, internet" },
  medical:           { label: "Medical / Wellness",        icon: "🏥", example: "Doctor, medicines, wellness" },
  training:          { label: "Training & Conferences",    icon: "🎓", example: "Courses, events, certifications" },
  miscellaneous:     { label: "Miscellaneous",             icon: "📌", example: "Anything not in above categories" },
};

function PolicyRulesEditor() {
  const [rules, setRules]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState("");
  const [err, setErr]       = useState("");

  useEffect(() => {
    getPolicyRules()
      .then(d => {
        const raw = d?.rules ?? d ?? {};
        const normalised = {};
        Object.keys(POLICY_LABELS).forEach(cat => {
          normalised[cat] = {
            enabled: raw[cat]?.enabled ?? false,
            limit:   raw[cat]?.limit   ?? 0,
          };
        });
        setRules(normalised);
      })
      .catch(() => setErr("Could not load policy rules"));
  }, []);

  function toggle(cat) {
    setRules(r => {
      const cur = r?.[cat] ?? { enabled: false, limit: 0 };
      return { ...r, [cat]: { ...cur, enabled: !cur.enabled } };
    });
    setMsg(""); setErr("");
  }

  function setLimit(cat, val) {
    setRules(r => {
      const cur = r?.[cat] ?? { enabled: false, limit: 0 };
      return { ...r, [cat]: { ...cur, limit: Number(val) || 0 } };
    });
    setMsg(""); setErr("");
  }

  async function handleSave() {
    setSaving(true); setMsg(""); setErr("");
    try {
      await savePolicyRules(rules);
      setMsg("✓ Policy rules saved successfully.");
    } catch (e) {
      setErr(e.response?.data?.detail || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (err && !rules) return (
    <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-4 text-xs text-red-600 dark:text-red-400">{err}</div>
  );
  if (!rules) return (
    <div className="flex items-center gap-2 text-xs text-slate-400 py-6">
      <svg className="w-4 h-4 animate-spin text-pink-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>Loading…
    </div>
  );

  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
        Enable a category limit to flag any claim that exceeds the set amount. Flagged claims are <Tag color="amber">FLAGGED</Tag> for
        human review — not auto-rejected. Leave a category disabled to skip the limit check.
      </p>
      <div className="space-y-2">
        {Object.entries(POLICY_LABELS).map(([cat, meta]) => {
          const rule = rules[cat] || { enabled: false, limit: 0 };
          return (
            <div key={cat}
                 className={`rounded-xl border p-3 flex items-center gap-3 transition-all ${
                   rule.enabled
                     ? "bg-pink-50 dark:bg-pink-950/20 border-pink-200 dark:border-pink-900/40"
                     : "bg-slate-50 dark:bg-gray-800/50 border-slate-100 dark:border-gray-800"
                 }`}>
              <button
                onClick={() => toggle(cat)}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors focus:outline-none ${
                  rule.enabled ? "bg-pink-500" : "bg-slate-300 dark:bg-gray-600"
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  rule.enabled ? "translate-x-4" : "translate-x-0"
                }`} />
              </button>
              <span className="text-base shrink-0">{meta.icon}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-semibold ${rule.enabled ? "text-pink-800 dark:text-pink-300" : "text-slate-600 dark:text-gray-300"}`}>
                  {meta.label}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-gray-500 truncate">{meta.example}</p>
              </div>
              <div className={`flex items-center gap-1.5 shrink-0 transition-opacity ${rule.enabled ? "opacity-100" : "opacity-30 pointer-events-none"}`}>
                <span className="text-xs text-slate-500 dark:text-gray-400 font-medium">₹</span>
                <input
                  type="number" min="0" value={rule.limit}
                  onChange={e => setLimit(cat, e.target.value)}
                  className="w-24 text-xs font-semibold border border-slate-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-900 text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-pink-300 dark:focus:ring-pink-700 focus:outline-none"
                  placeholder="0"
                />
                <span className="text-[10px] text-slate-400 dark:text-gray-500">per claim</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-5">
        <button
          onClick={handleSave} disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-60"
          style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}
        >
          {saving
            ? <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Saving…</>
            : "💾 Save Policy Rules"
          }
        </button>
        {msg && <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">{msg}</p>}
        {err && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ConfigPage() {
  const [keka, setKeka] = useState(null);
  useEffect(() => { kekaConfig().then(setKeka).catch(() => {}); }, []);

  return (
    <div className="max-w-4xl mx-auto px-5 sm:px-8 py-8">

      {/* Hero */}
      <div className="mb-8 pb-6 border-b border-slate-100 dark:border-gray-800">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
               style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}>
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">Wiom Expense Validator</h1>
            <p className="text-xs text-slate-400 dark:text-gray-500 mt-0.5">Configuration &amp; Product Documentation — v1.0 · May 2026</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <Tag color="pink">AI-Powered Validation</Tag>
          <Tag color="violet">Keka HR Integrated</Tag>
          <Tag color="emerald">Zoho Books</Tag>
          <Tag color="blue">OCR + Bill Matching</Tag>
          <Tag color="amber">Browser Automation</Tag>
          <Tag color="slate">Role-Based Access</Tag>
        </div>
      </div>

      {/* ── 1. Executive Summary ── */}
      <Section icon="📋" title="What is this App?"
        subtitle="Purpose, problem it solves, and who uses it">
        <p className="text-sm text-slate-600 dark:text-gray-300 leading-relaxed mb-4">
          <strong className="text-slate-900 dark:text-white">Wiom Expense Validator</strong> is an internal finance automation platform
          that eliminates manual expense verification. Before this tool, the finance team manually opened each bill PDF,
          cross-checked amounts with the Excel claim, logged into Keka to approve/reject one-by-one,
          and separately created entries in Zoho Books — all done row by row, taking 2–3 hours per batch.
        </p>
        <p className="text-sm text-slate-600 dark:text-gray-300 leading-relaxed mb-5">
          This platform does all of that automatically: reads the Excel claim file, matches every row to its bill PDF,
          runs OCR to verify amounts, validates 6 checks per claim, then lets the admin approve in Keka
          and push to Zoho Books — all from one screen.
        </p>

        {/* Impact cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          {[
            { icon: "⏱️", title: "Before", desc: "2–3 hours of manual checking per batch — open PDF, check Excel, login Keka, create Zoho entry — row by row." },
            { icon: "⚡", title: "After",  desc: "Upload 2 files → validated in ~90 seconds → 1-click bulk approve → Zoho entries auto-created. Total: ~10 min." },
            { icon: "📉", title: "Saving", desc: "~97% time reduction per batch. Duplicate detection prevents double-payment. Policy rules stop limit violations." },
          ].map(c => (
            <div key={c.title} className="rounded-xl bg-white dark:bg-gray-900 border border-slate-100 dark:border-gray-700 p-4">
              <div className="text-2xl mb-2">{c.icon}</div>
              <p className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-1">{c.title}</p>
              <p className="text-xs text-slate-500 dark:text-gray-400 leading-relaxed">{c.desc}</p>
            </div>
          ))}
        </div>

        {/* Time savings table */}
        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Time Savings Per Batch (50 Claims)</p>
        <div className="rounded-xl overflow-hidden border border-slate-100 dark:border-gray-800 text-xs">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-gray-800">
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Task</th>
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Before</th>
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">After</th>
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Saving</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-gray-800">
              {[
                ["Bill verification (50 claims)", "2–3 hours", "~90 seconds", "~99%"],
                ["Keka bulk approve/reject",      "30–45 min", "~2 min",       "~95%"],
                ["Zoho Books data entry",         "30–45 min", "~1 min",       "~97%"],
                ["Status report to management",   "15–20 min", "Instant (dashboard)", "100%"],
                ["Total per batch",               "~4–5 hours","~10 min",       "~97%"],
              ].map(([task, before, after, saving]) => (
                <tr key={task} className={task.startsWith("Total") ? "bg-emerald-50 dark:bg-emerald-950/20 font-bold" : ""}>
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">{task}</td>
                  <td className="px-4 py-2.5 text-red-600 dark:text-red-400">{before}</td>
                  <td className="px-4 py-2.5 text-emerald-600 dark:text-emerald-400">{after}</td>
                  <td className="px-4 py-2.5 text-emerald-700 dark:text-emerald-300 font-bold">{saving}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 2. End-to-End Flow ── */}
      <Section icon="🔄" title="End-to-End Flow"
        subtitle="Complete journey from file upload to payment confirmation — 10 steps">
        <div className="space-y-0">
          {[
            {
              num: "1", title: "Data Ingestion — Two Sources",
              desc: "Finance team provides expense data via one of two methods:",
              sub: [
                "Manual Upload: Excel report (employee, date, amount, category, attachment filename) + ZIP of all bill PDFs/images.",
                "Keka Direct Pull: Set a date range in the Keka tab → system logs into Keka via browser automation, downloads the Excel report and bill ZIP automatically. Zero manual steps.",
                "Column names are auto-detected — accepts variations like 'Emp Code', 'Staff ID', 'Employee Number', etc.",
              ]
            },
            {
              num: "2", title: "Bill Matching — 3 Strategies",
              desc: "Each Excel row is matched to its physical bill file using three strategies in priority order:",
              sub: [
                "Strategy 1 — Exact match: attachment filename in Excel matches bill filename in ZIP (case-insensitive).",
                "Strategy 2 — Fuzzy match: handles typos and partial names using similarity scoring.",
                "Strategy 3 — Amount fallback: if filename doesn't match, OCR the bill and match by amount.",
                "Bills in employee-ID subfolders are searched first; flat ZIPs also supported.",
                "Unmapped bills (in ZIP but not in any Excel row) are listed separately on the dashboard.",
              ]
            },
            {
              num: "3", title: "OCR Scanning — Parallel",
              desc: "Every matched bill is scanned to extract: amount, date, vendor name, GSTIN, confidence score.",
              sub: [
                "OCR runs concurrently on all bills (up to 32 threads) — a 50-bill batch scans in seconds.",
                "Supports Tesseract and RapidOCR engines; results are cached on disk to avoid re-scanning same bills.",
                "USD bills (SaaS: OpenAI, GitHub, Figma, Zoom, etc.) are auto-detected and converted to INR using live exchange rates (cached daily, ₹93 fallback).",
              ]
            },
            {
              num: "4", title: "Validation Engine — 6 Checks",
              desc: "Each claim is run through a 6-check pipeline:",
              sub: [
                "Bill Present — attachment found and matched in ZIP. Fail → Rejected.",
                "Amount Match — |Claimed − OCR Amount| ≤ ₹5. Fail → Rejected.",
                "Date Match — |Claimed Date − Bill Date| ≤ 2 days. Fail → Rejected.",
                "Vendor Match — fuzzy string similarity ≥ 70%. Fail → Rejected.",
                "Duplicate Detection — same bill file used by multiple rows. Fail → Flagged.",
                "OCR Quality — confidence score ≥ 30%. Fail → Flagged.",
                "Policy Rules — claim exceeds category limit (if configured). Fail → Flagged.",
              ]
            },
            {
              num: "5", title: "Results Dashboard",
              desc: "Full dashboard with tabs — Validation Results, Analytics, Zoho Status:",
              sub: [
                "Filterable, sortable table: employee, claim #, date, category, claimed ₹, bill ₹, diff ₹, status, remarks.",
                "Click any row to expand — shows OCR data, matched bill images, GSTIN, confidence score.",
                "Admin: manual override (change status, edit bill amount, add note), Keka approve/reject per row.",
                "Analytics tab: category breakdown charts, spend trends, top claimants, approval rate.",
                "Zoho Status tab: live status of all pushed bills from Zoho API.",
              ]
            },
            {
              num: "6", title: "Keka Actions — Approve / Reject",
              desc: "Select claims and action them directly in Keka from the dashboard:",
              sub: [
                "Bulk select with checkboxes → click Approve (N) or Reject (N).",
                "For reject: enter a rejection reason (mandatory) — Keka emails the employee automatically.",
                "Backend calls Keka's bulk API. If API fails, Playwright browser automation takes over.",
                "Browser path: opens Keka, finds the row by claim number, clicks action button, fills modal (payment mode: Outside Payroll, date: today), submits.",
                "Dashboard status updates immediately after action completes.",
              ]
            },
            {
              num: "7", title: "Zoho Books Push",
              desc: "Push approved claims to Zoho Books as vendor bills:",
              sub: [
                "Configure dialog: shows all approved claims with auto-detected expense accounts per category.",
                "Admin can override account per row or deselect specific rows before pushing.",
                "Creates vendor (employee) if not exists — sets vendor number to employee code (e.g. WI0047) instead of Zoho's VND-XXXXX.",
                "Creates draft vendor bill with line item, amount, date, category account, and bill attachment.",
                "Fix Vendor Numbers: updates existing VND-XXXXX vendors to employee codes in bulk.",
                "Post-push AI verification: re-fetches bill from Zoho and checks amount + vendor correctness.",
              ]
            },
            {
              num: "8", title: "Zoho Sync — Live Status Tracking",
              desc: "Fetch real-time bill status from Zoho after bills are created:",
              sub: [
                "Click 🔄 Sync in Session History → system fetches live status per bill via Zoho API.",
                "Statuses: PAID · OPEN · PENDING APPROVAL · DRAFT · VOID · PARTIALLY PAID.",
                "Each row in the dashboard shows a color-coded 'Zoho: PAID' badge after sync.",
                "Stale statuses from wrong rows are automatically cleared during sync.",
                "Overview dashboard shows total amount 'Booked in Zoho' as a KPI.",
              ]
            },
            {
              num: "9", title: "Export",
              desc: "Results available in multiple formats for different audiences:",
              sub: [
                "Excel Report (everyone) — color-coded XLSX: green/red/amber rows, all columns, OCR diff, Keka/Zoho status.",
                "Google Sheets (admin only) — pushes to a new Google Sheet with a shareable link for team review.",
                "PDF Report (everyone) — executive summary: KPIs, category charts, top claimants, approval rate.",
              ]
            },
            {
              num: "10", title: "Audit Trail & History",
              desc: "Full history and logging across all sessions:",
              sub: [
                "Session History: all validation sessions with stats, approval rate, Keka/Zoho progress bars.",
                "Re-validate: re-run full OCR + validation on any session with latest logic.",
                "Activity Logs: every action logged — login, upload, edit, export, Keka action, Zoho push — with actor + timestamp.",
                "Executive Overview: aggregate KPIs — total approved all time, booked in Zoho, approval rate, policy violations, monthly trend.",
                "Global Search: search claims across all sessions by employee name, amount, status.",
              ]
            },
          ].map(s => (
            <div key={s.num} className="flex gap-4 pb-5">
              <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-black text-white mt-0.5"
                   style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}>{s.num}</div>
              <div className="flex-1 pb-5 border-b border-dashed border-slate-100 dark:border-gray-800 last:border-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-0.5">{s.title}</p>
                <p className="text-xs text-slate-500 dark:text-gray-400 leading-relaxed mb-2">{s.desc}</p>
                <ul className="space-y-1">
                  {s.sub.map((b, i) => (
                    <li key={i} className="text-xs text-slate-500 dark:text-gray-400 flex items-start gap-1.5">
                      <span className="text-pink-400 shrink-0 mt-0.5">›</span>{b}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 3. Features Built ── */}
      <Section icon="🏗️" title="Features Built — Detailed"
        subtitle="Every specific capability implemented in this platform">

        <FeatureCard icon="🔗" title="Keka Approve from App UI"
          tags={[["Playwright", "violet"], ["Browser Automation", "blue"], ["Keka HR", "pink"]]}>
          <Li>Select a claim and click <strong>Approve</strong> — it automatically approves it in Keka.</Li>
          <Li><strong>Phase 1 — Cached API:</strong> After first successful approval, the Keka API endpoint and payload are cached in <Code>.keka_approve_endpoint.json</Code>. Next approvals use this directly (fast, no browser needed).</Li>
          <Li><strong>Phase 2 — Browser UI:</strong> If API fails, Playwright opens a headless browser, logs into Keka, navigates to the pending claims grid, finds the row by claim number, and clicks the approve button.</Li>
          <Li><strong>Modal handling:</strong> Selects Payment Mode: Outside Payroll, sets date to today via the date picker, clicks Approve.</Li>
          <Li><strong>JS Fallback:</strong> If row is not visible in grid, browser-side JS fetches the claim ID from Keka's SPA endpoint and calls the bulk API directly.</Li>
        </FeatureCard>

        <FeatureCard icon="❌" title="Keka Reject from App UI"
          tags={[["Playwright", "violet"], ["Reject Flow", "red"], ["Keka HR", "pink"]]}>
          <Li>Same flow as Approve — select claim(s), click <strong>Reject Selected</strong>, enter a rejection reason (mandatory).</Li>
          <Li>Rejection reason sent to Keka → Keka automatically emails the employee with the reason.</Li>
          <Li>After successful reject, the row's status in the app updates to <strong>Rejected</strong> immediately.</Li>
          <Li>Separate cache file for reject: <Code>.keka_reject_endpoint.json</Code> — doesn't overwrite approve cache.</Li>
        </FeatureCard>

        <FeatureCard icon="🏪" title="Zoho Vendor Number = Employee Code"
          tags={[["Zoho Books", "emerald"], ["Vendor Creation", "amber"]]}>
          <Li>When a new vendor is created in Zoho, the <Code>contact_number</Code> is set to the employee code (e.g. <Code>WI0047</Code>) instead of Zoho's auto-generated <Code>VND-00123</Code>.</Li>
          <Li>Search priority: first by employee code, then by name — prevents duplicate vendor creation.</Li>
          <Li><strong>Fix Vendor Numbers</strong> button: loops through all employees, finds vendors with <Code>VND-XXXXX</Code> pattern, updates them to employee codes via <Code>PUT /contacts/{"{id}"}</Code> API. Shows updated / skipped / error per vendor.</Li>
        </FeatureCard>

        <FeatureCard icon="🔄" title="Zoho Live Status Sync"
          tags={[["Zoho API", "emerald"], ["Live Status", "blue"], ["Bug-Fixed", "red"]]}>
          <Li>Fetches real-time bill status for all pushed bills in a session via Zoho API.</Li>
          <Li>Matches by bill_id (unique key from zoho_push.json) — no ambiguity.</Li>
          <Li>Vendor name verified as secondary check. Status written per row: PAID / OPEN / PENDING / DRAFT / VOID.</Li>
          <Li><strong>Critical bug fixed:</strong> Was using list position [i] instead of row_index lookup — caused statuses to be written to wrong rows. Fixed to: <Code>next(r for r in result.rows if r.row_index == row_index)</Code>.</Li>
          <Li>Cleanup pass: rows not in zoho_push.json have stale zoho_bill_status cleared automatically.</Li>
        </FeatureCard>

        <FeatureCard icon="🔒" title="Role-Based Access Control — Complete Read-Only for Non-Admins"
          tags={[["Security", "red"], ["RBAC", "violet"], ["Admin Only", "pink"]]}>
          <Li>All write endpoints protected by <Code>_require_admin()</Code> at backend level — returns 401/403 for non-admins.</Li>
          <Li>Frontend hides all write actions for Reviewer role (edit, Keka actions, Zoho push, re-validate, export to Sheets).</Li>
          <Li>Non-admin users see a 🔒 read-only notice on every session. They can view all data and download Excel/PDF.</Li>
          <Li>Replaced scattered per-endpoint lock checks with single centralized helper — consistent enforcement across all endpoints.</Li>
        </FeatureCard>

        <FeatureCard icon="📊" title="Executive Overview Dashboard"
          tags={[["Analytics", "violet"], ["KPIs", "blue"]]}>
          <Li>Aggregate KPIs across all sessions: Total Approved (all time), Booked in Zoho, Approval Rate, Policy Violations.</Li>
          <Li>Monthly trend bars (6 months): total spend vs. approved spend per month.</Li>
          <Li>Category breakdown chart: Travel, Food, Subscription, etc. sorted by amount.</Li>
          <Li>Top claimants: top 5 employees by total claim amount.</Li>
          <Li><strong>Booked in Zoho KPI:</strong> Shows total approved amount that IS in Zoho Books (not pending). Fixed with correct row_index lookup — was previously using loop counter which caused wrong amounts.</Li>
        </FeatureCard>

        <FeatureCard icon="🤖" title="Keka AG-Grid Row Detection + Browser Automation"
          tags={[["Playwright", "violet"], ["AG Grid", "blue"], ["Browser Automation", "blue"]]}>
          <Li>Keka uses AG-Grid — action buttons are in a pinned-right column, not part of the row's DOM.</Li>
          <Li>Solution: hover over the row to make buttons visible, then use <Code>page.mouse.click(x, y)</Code> with absolute coordinates.</Li>
          <Li>Y coordinate from row bounding box: <Code>box.y + box.height / 2</Code>. Approve at x≈1745, Reject at x≈1777 (1920×1080 viewport).</Li>
          <Li>Date filter and Status filter use 3-pass detection: CSS selector → Playwright has-text() → JavaScript DOM scan. Never times out.</Li>
        </FeatureCard>

        <FeatureCard icon="🧾" title="Zoho Post-Push AI Verification"
          tags={[["Claude AI", "pink"], ["Zoho Books", "emerald"], ["Audit", "amber"]]}>
          <Li>After pushing entries to Zoho, each bill is AI-verified: reads OCR text, checks amount/account/vendor correctness.</Li>
          <Li>Pre-checks: duplicate attachment detection, cross-session duplicate bill number check via Zoho API.</Li>
          <Li>Results shown inline — green ✓ verified, amber ⚠ with specific issue description.</Li>
        </FeatureCard>

        <FeatureCard icon="💾" title="Keka Session Persistence + Stale Detection"
          tags={[["Auth", "pink"], ["Session", "violet"]]}>
          <Li>After logging into Keka once, browser session (cookies + localStorage) saved to disk — reused for all future syncs and approvals.</Li>
          <Li>If session expired: redirect to login page detected, stale cache cleared, clear message shown: "Session expired — re-authenticate."</Li>
          <Li>Login supports OTP/2FA — dialog appears to enter the OTP when required.</Li>
        </FeatureCard>

        <FeatureCard icon="📂" title="Auto-Column Detection + Multi-Bill per Claim"
          tags={[["File Parsing", "amber"], ["Matching", "slate"]]}>
          <Li>Excel column names auto-detected — accepts "Emp Code", "Staff ID", "Employee Number", "claimed amount", "bill name", etc.</Li>
          <Li>One claim can have multiple physical bills — all matched, all OCR-scanned, all attached to Zoho entry.</Li>
          <Li>OCR cache: results saved to disk — re-validation skips re-scanning same bill files.</Li>
          <Li>USD auto-detection: keywords (OpenAI, GitHub, Figma, Zoom, AWS…) trigger live FX conversion.</Li>
        </FeatureCard>
      </Section>

      {/* ── 4. File Format ── */}
      <Section icon="📁" title="Required File Format">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">Excel / CSV — Accepted Column Names</p>
            <p className="text-xs text-slate-400 dark:text-gray-500 mb-3">Auto-detected — exact name doesn't matter.</p>
            <div className="space-y-1.5">
              {[
                ["Employee Name",   "employee name, name, staff name",                                      "emerald"],
                ["Employee Code",   "employee code, emp code, staff id, employee number, emp id",           "amber"],
                ["Amount",          "amount, claimed amount, expense amount, total",                         "emerald"],
                ["Date",            "date, expense date, claim date, submitted on",                          "emerald"],
                ["Category",        "category, expense type, nature, head",                                  "emerald"],
                ["Description",     "description, narration, remarks, details",                              "slate"],
                ["Bill Filename",   "bill, attachment, receipt, filename, document",                         "emerald"],
                ["Claim Number",    "claim no, claim number, keka claim, claim id",                          "slate"],
              ].map(([col, aliases, color]) => (
                <div key={col} className="text-xs py-2 border-b border-slate-50 dark:border-gray-800/60 last:border-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">{col}</span>
                    <Tag color={color}>{color === "emerald" ? "Required" : "Optional"}</Tag>
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-gray-500 font-mono">{aliases}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">ZIP File</p>
            <p className="text-xs text-slate-400 dark:text-gray-500 mb-3">Bills can be in any subfolder. Matching is by filename (partial, case-insensitive).</p>
            <div className="rounded-lg bg-slate-800 dark:bg-gray-950 p-3 font-mono text-[11px] text-slate-300 leading-relaxed mb-4">
              <p className="text-slate-500">📦 bills.zip</p>
              <p className="ml-4">📄 pankaj_bill.pdf</p>
              <p className="ml-4">📄 WI0047_hotel.pdf</p>
              <p className="ml-4">📁 april_2026/</p>
              <p className="ml-8">📄 taxi_invoice.jpg</p>
              <p className="ml-8">📄 raj_swiggy.png</p>
            </div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Supported Bill Formats</p>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {["PDF", "JPG", "JPEG", "PNG", "WEBP"].map(f => <Tag key={f} color="slate">{f}</Tag>)}
            </div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Validation Status</p>
            {[
              ["Approved ✓", "emerald", "Bill found, OCR amount matches claim (±₹5), all checks pass."],
              ["Flagged ⚑",  "amber",  "Minor issue or policy violation — needs manual review."],
              ["Rejected ✗", "red",    "Bill missing, large mismatch, duplicate, or clear problem."],
            ].map(([s, c, d]) => (
              <div key={s} className="flex items-start gap-2 mb-2">
                <Tag color={c}>{s}</Tag>
                <p className="text-xs text-slate-500 dark:text-gray-400 leading-relaxed">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── 5. Roles ── */}
      <Section icon="👥" title="User Roles & Permissions"
        subtitle="Admin = full access. Reviewer = read-only view only.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Admin */}
          <div className="rounded-xl border bg-pink-50 border-pink-100 dark:bg-pink-950/20 dark:border-pink-900/40 p-4">
            <p className="text-xs font-bold text-pink-700 dark:text-pink-300 mb-3">🛡️ Admin — Full Access</p>
            <ul className="space-y-1.5">
              {[
                "View all validation results",
                "Download Excel / PDF reports",
                "Edit row (status, amount, note)",
                "Re-validate a session (re-run OCR)",
                "Keka — approve or reject claims (single + bulk)",
                "Push approved claims to Zoho Books",
                "Push to Google Sheets",
                "Fix Vendor Numbers in Zoho",
                "Sync Zoho live status per session",
                "Delete / manage sessions",
                "Manage users (Admin panel)",
                "View full audit logs",
                "Configure policy rules",
              ].map(p => (
                <li key={p} className="text-xs text-slate-600 dark:text-gray-300 flex items-start gap-1.5">
                  <span className="text-pink-400 shrink-0">✓</span>{p}
                </li>
              ))}
            </ul>
          </div>

          {/* Reviewer */}
          <div className="rounded-xl border bg-slate-50 border-slate-200 dark:bg-gray-800/40 dark:border-gray-700 p-4">
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">👁️ Reviewer — Read-Only</p>
            <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium mb-3 flex items-center gap-1">
              🔒 Can view everything — cannot make any changes
            </p>
            <ul className="space-y-1.5 mb-4">
              {[
                "View all validation results & session history",
                "Download Excel report",
                "Generate & download PDF report",
                "View Analytics tab",
                "View Zoho Status tab",
                "View Executive Overview dashboard",
              ].map(p => (
                <li key={p} className="text-xs text-slate-600 dark:text-gray-300 flex items-start gap-1.5">
                  <span className="text-emerald-500 shrink-0">✓</span>{p}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-400 dark:text-gray-500 font-semibold uppercase tracking-wide mb-2">Cannot do:</p>
            <ul className="space-y-1.5">
              {[
                "Edit any row or status",
                "Approve / Reject in Keka",
                "Push to Zoho Books",
                "Push to Google Sheets",
                "Fix Vendor Numbers",
                "Re-validate sessions",
                "Delete sessions",
                "Access Admin panel",
              ].map(p => (
                <li key={p} className="text-xs text-slate-400 dark:text-gray-500 flex items-start gap-1.5">
                  <span className="text-red-400 shrink-0">✗</span>{p}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* RBAC enforcement note */}
        <div className="mt-4 flex items-start gap-3 px-4 py-3 rounded-xl bg-slate-50 dark:bg-gray-800/50 border border-slate-100 dark:border-gray-800">
          <span className="text-lg shrink-0">🔐</span>
          <div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-0.5">Enforced at Backend Level</p>
            <p className="text-xs text-slate-500 dark:text-gray-400 leading-relaxed">
              All write endpoints call <Code>_require_admin()</Code> which verifies the JWT role before any action.
              Frontend hides write actions for Reviewers, but even if bypassed, the backend returns <strong>403 Forbidden</strong>.
              JWT tokens expire after 24 hours.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 6. System Config ── */}
      <Section icon="🔧" title="System Configuration"
        subtitle="Environment variables and integration status">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-3">Keka HR</p>
            <CfgRow label="Company"       value={keka?.company || "—"} />
            <CfgRow label="Client ID"     badge={keka?.client_id_set} />
            <CfgRow label="Client Secret" badge={keka?.client_secret_set} />
            <CfgRow label="Status"        badge={keka?.configured} yes="Ready" no="Not configured" />
            <div className="mt-3 space-y-1">
              {["KEKA_COMPANY_NAME", "KEKA_CLIENT_ID", "KEKA_CLIENT_SECRET"].map(k =>
                <div key={k}><Code>{k}</Code></div>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-3">Zoho Books</p>
            <CfgRow label="Region"      value="India — zohoapis.in" />
            <CfgRow label="API Version" value="v3" />
            <CfgRow label="Auth Method" value="OAuth2 Refresh Token" />
            <CfgRow label="Vendor No."  value="Employee Code (e.g. WI0047)" />
            <div className="mt-3 space-y-1">
              {["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"].map(k =>
                <div key={k}><Code>{k}</Code></div>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-3">OCR + Browser</p>
            <CfgRow label="Primary OCR"  value="RapidOCR (preferred)" />
            <CfgRow label="Fallback OCR" value="Tesseract (pytesseract)" />
            <CfgRow label="PDF→Image"    value="pdf2image + poppler" />
            <CfgRow label="Browser"      value="Playwright + Chromium" />
            <p className="text-[11px] text-slate-400 dark:text-gray-500 mt-3">Tesseract and Poppler must be installed on the server machine.</p>
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 dark:text-gray-400 uppercase tracking-wider mb-3">Google Sheets (Optional)</p>
            <CfgRow label="Auth Method" value="GCP Service Account JSON" />
            <CfgRow label="APIs needed" value="Sheets API + Drive API" />
            <div className="mt-3"><Code>GOOGLE_SERVICE_ACCOUNT_JSON</Code></div>
            <p className="text-[11px] text-slate-400 dark:text-gray-500 mt-2">If not set, Google Sheets export is disabled. All other features work normally.</p>
          </div>
        </div>
      </Section>

      {/* ── 7. Tech Stack ── */}
      <Section icon="🛠️" title="Tech Stack">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { layer: "Frontend",    tech: "React + Vite",         detail: "Tailwind CSS, React Router v6, dark mode" },
            { layer: "Backend",     tech: "FastAPI (Python)",      detail: "uvicorn, pydantic v2, port 8003" },
            { layer: "Automation",  tech: "Playwright",            detail: "Chromium headless, session reuse" },
            { layer: "Database",    tech: "SQLite",                detail: "Sessions, users, audit log" },
            { layer: "OCR",         tech: "RapidOCR + Tesseract",  detail: "Bill text, amount extraction, parallel" },
            { layer: "Matching",    tech: "TheFuzz (fuzzy)",       detail: "Bill filename + vendor name matching" },
            { layer: "Zoho API",    tech: "Zoho Books v3 India",   detail: "OAuth2, vendors, bills, status sync" },
            { layer: "Keka API",    tech: "Keka OAuth2 + UI",      detail: "REST bulk + Playwright fallback" },
          ].map(t => (
            <div key={t.layer} className="rounded-xl bg-slate-50 dark:bg-gray-800 border border-slate-100 dark:border-gray-700 p-3">
              <p className="text-[10px] font-bold text-pink-500 uppercase tracking-wider mb-1">{t.layer}</p>
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{t.tech}</p>
              <p className="text-[11px] text-slate-400 dark:text-gray-500 mt-0.5">{t.detail}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 8. Validation Rules ── */}
      <Section icon="✅" title="Validation Rules Reference">
        <div className="rounded-xl overflow-hidden border border-slate-100 dark:border-gray-800 text-xs mb-4">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-gray-800">
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Check</th>
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Pass Condition</th>
                <th className="text-left px-4 py-2.5 text-slate-500 dark:text-gray-400 font-semibold">Fail Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-gray-800">
              {[
                ["Bill Present",      "Attachment found and matched in ZIP",          "Rejected"],
                ["Amount Match",      "|Claimed − OCR Amount| ≤ ₹5",                 "Rejected"],
                ["Date Match",        "|Claimed Date − Bill Date| ≤ 2 days",          "Rejected"],
                ["Vendor Match",      "Fuzzy string similarity ≥ 70%",               "Rejected"],
                ["Duplicate",         "Same bill file not used by multiple rows",     "Flagged"],
                ["OCR Quality",       "Confidence score ≥ 30%",                       "Flagged"],
                ["Policy Limit",      "Claim ≤ configured per-category limit",        "Flagged"],
              ].map(([check, cond, result]) => (
                <tr key={check}>
                  <td className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">{check}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-gray-400 font-mono text-[11px]">{cond}</td>
                  <td className="px-4 py-2.5">
                    <Tag color={result === "Rejected" ? "red" : "amber"}>{result}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-gray-500 leading-relaxed">
          <strong>Status logic:</strong> Any Rejected check → row is <Tag color="red">Rejected</Tag>. Only Flagged checks (no Rejected) → row is <Tag color="amber">Flagged</Tag>. All pass → <Tag color="emerald">Approved</Tag>.
          Admin can manually override any status from the dashboard.
        </p>
      </Section>

      {/* ── 9. Policy Rules ── */}
      <Section icon="📏" title="Policy Rules Engine"
        subtitle="Set per-category claim limits — exceeding limits gets flagged for review">
        <PolicyRulesEditor />
      </Section>

      <p className="text-center text-xs text-slate-300 dark:text-gray-600 mt-2 pb-6">
        Wiom Finance — Internal Tool — Built with Claude Agent SDK &amp; Anthropic API · v1.0 · May 2026
      </p>
    </div>
  );
}
