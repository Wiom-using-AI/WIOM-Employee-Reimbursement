import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getOverviewStats, exportAllExcel, exportAllPdf } from "../services/api";

function fmt(n) {
  if (n >= 10_00_000) return `₹${(n / 10_00_000).toFixed(1)}L`;
  if (n >= 1_000)     return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

// ── Progress bar row ──────────────────────────────────────────────────────────
function ProgressRow({ label, value, total, color, amount }) {
  const p = pct(value, total);
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: "var(--text-sub)" }}>{label}</span>
        <span className="font-bold tabular-nums" style={{ color }}>
          {value} <span className="font-normal" style={{ color: "var(--text-muted)" }}>({p}%)</span>
          {amount != null && <span className="ml-1.5 font-semibold">{fmt(amount)}</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
        <div className="h-full rounded-full transition-all duration-700"
             style={{ width: `${Math.max(p, value > 0 ? 2 : 0)}%`, background: color }} />
      </div>
    </div>
  );
}

// ── Stat tile inside breakdown panel ─────────────────────────────────────────
function StatTile({ label, value, sub, color, icon }) {
  return (
    <div className="rounded-xl p-4"
         style={{ background: `${color}08`, border: `1px solid ${color}20` }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color }}>
          {label}
        </span>
      </div>
      <p className="text-2xl font-black" style={{ color: "var(--text-main)" }}>{value}</p>
      {sub && <p className="text-xs mt-0.5 font-medium" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  );
}

// ── Main KPI card ─────────────────────────────────────────────────────────────
function KpiCard({ icon, label, value, sub, accent = "#e5007d", onClick, isActive }) {
  return (
    <div
      onClick={onClick}
      className="card card-shine p-5 relative overflow-hidden transition-all duration-200"
      style={{
        cursor: onClick ? "pointer" : "default",
        borderColor: isActive ? accent : undefined,
        boxShadow: isActive ? `0 0 0 2px ${accent}30, 0 4px 20px ${accent}12` : undefined,
      }}
    >
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-5 blur-2xl"
           style={{ background: accent, transform: "translate(30%,-30%)" }} />
      <div className="relative z-10">
        <div className="flex items-start justify-between mb-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
               style={{ background: `${accent}15`, border: `1px solid ${accent}25` }}>
            {icon}
          </div>
          {onClick && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full transition-all"
                  style={{
                    background: isActive ? `${accent}18` : "var(--bg-card2)",
                    color: isActive ? accent : "var(--text-muted)",
                    border: `1px solid ${isActive ? accent + "40" : "var(--border)"}`,
                  }}>
              {isActive ? "▲ Close" : "▼ Details"}
            </span>
          )}
        </div>
        <p className="text-2xl font-black mb-1" style={{ color: "var(--text-main)" }}>{value}</p>
        <p className="text-xs font-semibold" style={{ color: "var(--text-sub)" }}>{label}</p>
        {sub && <p className="text-xs mt-1 font-medium" style={{ color: accent }}>{sub}</p>}
      </div>
    </div>
  );
}

// ── Approved Breakdown Panel ──────────────────────────────────────────────────
function ApprovedBreakdown({ s }) {
  const totalApproved = s.total_approved || 0;
  const zohoBooked    = s.zoho_booked_count  || 0;
  const zohoPaid      = s.zoho_paid_count    || 0;
  const kekaApproved  = s.keka_approved_count || 0;
  const notInZoho     = s.approved_not_zoho_count || 0;

  return (
    <div className="card p-6 animate-slide-up"
         style={{ borderColor: "rgba(16,185,129,0.25)", boxShadow: "0 0 0 1px rgba(16,185,129,0.08), 0 4px 24px rgba(16,185,129,0.06)" }}>

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
             style={{ background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.2)" }}>
          ✅
        </div>
        <div>
          <h3 className="text-sm font-black" style={{ color: "var(--text-main)" }}>
            Approved Claims — Detailed Breakdown
          </h3>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {totalApproved} approved claim{totalApproved !== 1 ? "s" : ""} — where they stand across systems
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-2xl font-black" style={{ color: "#10b981" }}>{fmt(s.total_approved_amount || 0)}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>total approved amount</p>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatTile
          icon="📒" label="Zoho Booked"
          value={zohoBooked}
          sub={zohoBooked > 0 ? fmt(s.total_zoho_booked || 0) : "Not yet pushed"}
          color="#7c3aed"
        />
        <StatTile
          icon="💸" label="Zoho Paid"
          value={zohoPaid}
          sub={zohoPaid > 0 ? fmt(s.zoho_paid_amount || 0) : "None marked paid"}
          color="#0ea5e9"
        />
        <StatTile
          icon="🔗" label="Keka Approved"
          value={kekaApproved}
          sub={kekaApproved > 0 ? `${pct(kekaApproved, totalApproved)}% of approved` : "None actioned"}
          color="#f59e0b"
        />
        <StatTile
          icon="⏳" label="Pending Zoho"
          value={notInZoho}
          sub={notInZoho > 0 ? fmt(s.total_pending_reimbursement || 0) : "All pushed"}
          color="#ef4444"
        />
      </div>

      {/* Progress bars */}
      <div className="space-y-3 p-4 rounded-xl" style={{ background: "var(--bg-card2)", border: "1px solid var(--border)" }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
          Pipeline Coverage
        </p>
        <ProgressRow
          label="Pushed to Zoho (booked)"
          value={zohoBooked} total={totalApproved}
          color="#7c3aed"
          amount={s.total_zoho_booked}
        />
        <ProgressRow
          label="Paid in Zoho"
          value={zohoPaid} total={totalApproved}
          color="#0ea5e9"
          amount={s.zoho_paid_amount}
        />
        <ProgressRow
          label="Keka approved"
          value={kekaApproved} total={totalApproved}
          color="#f59e0b"
        />
        <ProgressRow
          label="Still pending (not in Zoho)"
          value={notInZoho} total={totalApproved}
          color="#ef4444"
          amount={s.total_pending_reimbursement}
        />
      </div>
    </div>
  );
}

// ── Horizontal bar chart ───────────────────────────────────────────────────────
function BarChart({ data, maxVal, color = "#e5007d" }) {
  return (
    <div className="space-y-3">
      {data.map(({ label, value }) => (
        <div key={label}>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="font-medium truncate max-w-[60%]" style={{ color: "var(--text-main)" }}>{label}</span>
            <span className="font-mono font-semibold" style={{ color }}>{fmt(value)}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
            <div className="h-full rounded-full transition-all duration-700"
                 style={{ width: `${maxVal ? Math.max(3, (value / maxVal) * 100) : 0}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Monthly trend mini bars ───────────────────────────────────────────────────
function TrendBars({ data }) {
  const maxTotal = Math.max(...data.map(d => d.total), 1);
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full relative flex items-end" style={{ height: "60px" }}>
            <div className="absolute bottom-0 left-0 right-0 rounded-t"
                 style={{ height: `${Math.max(4, (d.total / maxTotal) * 60)}px`, background: "var(--border)" }} />
            <div className="absolute bottom-0 left-0 right-0 rounded-t"
                 style={{ height: `${Math.max(2, (d.approved / maxTotal) * 60)}px`,
                          background: "linear-gradient(180deg,#ff4db8,#e5007d)" }} />
          </div>
          <span className="text-[9px] text-center leading-tight" style={{ color: "var(--text-muted)" }}>
            {d.month.split(" ")[0]}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Overview() {
  const [stats,        setStats]        = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");
  const [showApproved, setShowApproved] = useState(false);
  const [exporting,    setExporting]    = useState(""); // "" | "excel" | "pdf"

  useEffect(() => {
    getOverviewStats()
      .then(setStats)
      .catch(e => setError(e.response?.data?.detail || "Failed to load overview"))
      .finally(() => setLoading(false));
  }, []);

  const handleExport = async (type) => {
    setExporting(type);
    try {
      if (type === "excel") await exportAllExcel();
      else                  await exportAllPdf();
    } catch (e) {
      alert("Export failed: " + e.message);
    } finally {
      setExporting("");
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <svg className="w-10 h-10 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-20" cx="12" cy="12" r="10" stroke="#e5007d" strokeWidth="3"/>
        <path fill="#e5007d" className="opacity-80" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      <p className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>Loading overview…</p>
    </div>
  );
  if (error) return (
    <div className="max-w-md mx-auto px-6 py-16 text-center">
      <p className="text-sm font-medium" style={{ color: "#ef4444" }}>{error}</p>
    </div>
  );
  if (!stats) return null;

  const s = stats;

  const catData = Object.entries(s.category_breakdown || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => ({ label, value }));
  const catMax       = catData[0]?.value || 1;
  const claimantMax  = s.top_claimants?.[0]?.amount || 1;
  const total        = s.total_claims_all_time || 0;
  const approved     = s.total_approved || 0;
  const rejected     = s.total_rejected || 0;
  const flagged      = s.total_flagged  || 0;

  return (
    <div className="max-w-screen-xl mx-auto px-5 sm:px-8 py-8">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6 animate-slide-up">
        <div>
          <h1 className="text-2xl font-black mb-0.5" style={{ color: "var(--text-main)" }}>Executive Overview</h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Expense reimbursement snapshot — all time · {s.total_sessions} batch{s.total_sessions !== 1 ? "es" : ""}
          </p>
        </div>

        {/* Export buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link to="/" className="btn-secondary text-sm">+ New Validation</Link>

          <button
            onClick={() => handleExport("excel")}
            disabled={!!exporting}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 disabled:opacity-60"
            style={{
              background: "linear-gradient(135deg,#10b981,#059669)",
              color: "#fff",
              boxShadow: "0 4px 14px rgba(16,185,129,0.30)",
            }}
          >
            {exporting === "excel" ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
              </svg>
            )}
            {exporting === "excel" ? "Exporting…" : "Export Excel"}
          </button>

          <button
            onClick={() => handleExport("pdf")}
            disabled={!!exporting}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 disabled:opacity-60"
            style={{
              background: "linear-gradient(135deg,#ef4444,#dc2626)",
              color: "#fff",
              boxShadow: "0 4px 14px rgba(239,68,68,0.30)",
            }}
          >
            {exporting === "pdf" ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
              </svg>
            )}
            {exporting === "pdf" ? "Generating…" : "Export PDF"}
          </button>
        </div>
      </div>

      {/* ── Claim status row (primary KPIs) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3 animate-slide-up">
        <KpiCard
          icon="🧾" label="Total Claims"
          value={total.toLocaleString("en-IN")}
          sub={`${s.total_sessions} batch${s.total_sessions !== 1 ? "es" : ""}`}
          accent="#64748b"
        />
        <KpiCard
          icon="✅" label="Approved"
          value={approved.toLocaleString("en-IN")}
          sub={`${pct(approved, total)}% approval rate`}
          accent="#10b981"
          onClick={() => setShowApproved(v => !v)}
          isActive={showApproved}
        />
        <KpiCard
          icon="❌" label="Rejected"
          value={rejected.toLocaleString("en-IN")}
          sub={rejected > 0 ? `${pct(rejected, total)}% of claims` : "None rejected"}
          accent="#ef4444"
        />
        <KpiCard
          icon="🚩" label="Flagged / Review"
          value={flagged.toLocaleString("en-IN")}
          sub={flagged > 0 ? `${pct(flagged, total)}% of claims` : "None flagged"}
          accent="#f59e0b"
        />
      </div>

      {/* Approved breakdown panel — slides in below the KPI row */}
      {showApproved && (
        <div className="mb-3">
          <ApprovedBreakdown s={s} />
        </div>
      )}

      {/* ── Secondary KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 animate-slide-up" style={{ animationDelay: "0.05s" }}>
        <KpiCard
          icon="💰" label="Total Approved Amount"
          value={fmt(s.total_approved_amount || 0)}
          sub={`${approved} approved claims`}
          accent="#10b981"
        />
        <KpiCard
          icon="📒" label="Booked in Zoho"
          value={fmt(s.total_zoho_booked || 0)}
          sub={`${s.zoho_booked_count || 0} claims pushed`}
          accent="#7c3aed"
        />
        <KpiCard
          icon="📈" label="Approval Rate"
          value={`${s.approval_rate}%`}
          sub="AI-validated claims"
          accent="#e5007d"
        />
        <KpiCard
          icon="⚠️" label="Policy Violations"
          value={s.policy_violations || 0}
          sub={s.policy_violations > 0 ? "Claims exceeding limits" : "All within policy"}
          accent={s.policy_violations > 0 ? "#ef4444" : "#10b981"}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">

        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: "var(--text-muted)" }}>
            Monthly Trend
          </p>
          <div className="flex items-center gap-3 text-[11px] mb-4" style={{ color: "var(--text-muted)" }}>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "#e5007d" }} /> approved
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "var(--border)" }} /> total
            </span>
          </div>
          {s.monthly_trend?.length > 0
            ? <TrendBars data={s.monthly_trend} />
            : <p className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>No data yet</p>}
        </div>

        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Category Breakdown
          </p>
          {catData.length > 0
            ? <BarChart data={catData} maxVal={catMax} color="#7c3aed" />
            : <p className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>No data yet</p>}
        </div>

        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Top Claimants
          </p>
          {s.top_claimants?.length > 0
            ? <BarChart data={s.top_claimants.map(c => ({ label: c.name, value: c.amount }))}
                        maxVal={claimantMax} color="#e5007d" />
            : <p className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>No data yet</p>}
        </div>
      </div>

      {/* Quick actions */}
      <div className="card p-5">
        <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
          Quick Actions
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/"       className="btn-primary text-sm">📤 New Batch Validation</Link>
          <Link to="/keka"   className="btn-secondary text-sm">🔗 Keka Sync</Link>
          <Link to="/config" className="btn-secondary text-sm">⚙️ Configuration</Link>
          <Link to="/admin"  className="btn-secondary text-sm">🛡️ Admin Panel</Link>
        </div>
      </div>
    </div>
  );
}
