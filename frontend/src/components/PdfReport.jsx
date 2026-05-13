import { useRef, useState } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtINR(n) {
  return Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDateShort(str) {
  if (!str) return "";
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function PdfReport({ rows = [], sessionId = "" }) {
  const reportRef = useRef(null);
  const [loading, setLoading] = useState(false);

  // ── Data computations ────────────────────────────────────────────────────
  const totalClaims  = rows.length;
  const totalClaimed = rows.reduce((s, r) => s + (r.claimed_amount || 0), 0);
  const approved     = rows.filter((r) => r.status === "Approved");
  const rejected     = rows.filter((r) => r.status === "Rejected");
  const flagged      = rows.filter((r) => r.status === "Flagged");
  const totalApproved = approved.reduce((s, r) => s + (r.bill_amount || r.claimed_amount || 0), 0);
  const approvalRate  = totalClaims > 0 ? ((approved.length / totalClaims) * 100).toFixed(1) : 0;
  const today         = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  // ── Date range from expense dates ────────────────────────────────────────
  const expDates = rows.map(r => r.expense_date).filter(Boolean).sort();
  const periodFrom = expDates[0]  ? fmtDateShort(expDates[0])                    : "";
  const periodTo   = expDates[expDates.length - 1] ? fmtDateShort(expDates[expDates.length - 1]) : "";

  // ── Category breakdown ───────────────────────────────────────────────────
  const catMap = {};
  rows.forEach((r) => {
    const cat = r.expense_nature || r.expense_category || "Other";
    if (!catMap[cat]) catMap[cat] = { total: 0, approved: 0, count: 0 };
    catMap[cat].total   += r.claimed_amount || 0;
    catMap[cat].count   += 1;
    if (r.status === "Approved") catMap[cat].approved += r.bill_amount || r.claimed_amount || 0;
  });
  const topCategories = Object.entries(catMap)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);
  const maxCatAmount = topCategories[0]?.[1]?.total || 1;

  // ── Department breakdown ─────────────────────────────────────────────────
  const deptMap = {};
  rows.forEach((r) => {
    const dept = r.department || "Unassigned";
    if (!deptMap[dept]) deptMap[dept] = { claims: 0, claimed: 0, approved: 0, employees: new Set() };
    deptMap[dept].claims   += 1;
    deptMap[dept].claimed  += r.claimed_amount || 0;
    if (r.status === "Approved") deptMap[dept].approved += r.bill_amount || r.claimed_amount || 0;
    if (r.employee_name) deptMap[dept].employees.add(r.employee_name);
  });
  const departments = Object.entries(deptMap)
    .sort((a, b) => b[1].claimed - a[1].claimed)
    .map(([name, d]) => ({ name, ...d, empCount: d.employees.size }));

  // ── Employee summary (top 10) ────────────────────────────────────────────
  const empMap = {};
  rows.forEach((r) => {
    const name = r.employee_name || r.employee_id || "Unknown";
    if (!empMap[name]) empMap[name] = { name, dept: r.department || "", claims: 0, amount: 0, approved: 0 };
    empMap[name].claims  += 1;
    empMap[name].amount  += r.claimed_amount || 0;
    if (r.status === "Approved") empMap[name].approved += r.bill_amount || r.claimed_amount || 0;
  });
  const topEmployees = Object.values(empMap)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12);

  // ── Generate PDF ─────────────────────────────────────────────────────────
  async function generatePDF() {
    setLoading(true);
    try {
      const el = reportRef.current;
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
        windowWidth: 794,
      });
      const imgData    = canvas.toDataURL("image/png");
      const pdf        = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pdfWidth   = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const pdfHeight  = (canvas.height * pdfWidth) / canvas.width;

      if (pdfHeight <= pageHeight) {
        pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      } else {
        let yOffset   = 0;
        let remaining = pdfHeight;
        while (remaining > 0) {
          pdf.addImage(imgData, "PNG", 0, -yOffset, pdfWidth, pdfHeight);
          remaining -= pageHeight;
          yOffset   += pageHeight;
          if (remaining > 0) pdf.addPage();
        }
      }
      pdf.save(
        `Wiom_Expense_Report_${sessionId?.slice(0, 8) || "export"}_${new Date().toISOString().slice(0, 10)}.pdf`
      );
    } finally {
      setLoading(false);
    }
  }

  // ── Section heading ──────────────────────────────────────────────────────
  const sectionHead = {
    fontSize: "10px", fontWeight: 700, color: "#e5007d",
    textTransform: "uppercase", letterSpacing: "1.5px",
    marginBottom: "12px", paddingBottom: "6px",
    borderBottom: "1.5px solid #fce7f3",
  };

  // ── KPI Tile ─────────────────────────────────────────────────────────────
  function KpiTile({ label, value, sub, accent, iconText }) {
    return (
      <div style={{
        background: accent + "0d",
        border: `1.5px solid ${accent}33`,
        borderRadius: "10px",
        padding: "14px 12px",
        display: "flex", flexDirection: "column", gap: "3px",
      }}>
        <div style={{ fontSize: "10px", color: accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.8px" }}>
          {iconText} {label}
        </div>
        <div style={{ fontSize: "20px", fontWeight: 900, color: "#1e293b", letterSpacing: "-0.5px", marginTop: "2px" }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: "10px", color: "#94a3b8" }}>{sub}</div>}
      </div>
    );
  }

  // ── Progress bar (for validation detail) ────────────────────────────────
  function ProgressBar({ count, color, label, icon }) {
    const pct = totalClaims > 0 ? (count / totalClaims) * 100 : 0;
    return (
      <div style={{ marginBottom: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
          <span style={{ fontSize: "12px", color: "#475569" }}>
            <span style={{ fontSize: "13px", marginRight: "5px" }}>{icon}</span>{label}
          </span>
          <span style={{ fontSize: "12px", fontWeight: 700, color }}>
            {count} claims ({pct.toFixed(1)}%)
          </span>
        </div>
        <div style={{ background: "#f1f5f9", borderRadius: "4px", height: "8px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "4px" }} />
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Trigger button */}
      <button
        onClick={generatePDF}
        disabled={loading}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-60"
        style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}
      >
        {loading ? "Generating…" : "📄 CEO PDF Report"}
      </button>

      {/* ── Hidden report div captured by html2canvas ────────────────────── */}
      <div
        ref={reportRef}
        style={{
          width: "794px",
          background: "white",
          padding: "44px 48px",
          fontFamily: "'Segoe UI', Arial, sans-serif",
          color: "#1e293b",
          position: "fixed",
          left: "-9999px",
          top: 0,
          zIndex: -1,
          boxSizing: "border-box",
        }}
      >

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: "28px", paddingBottom: "18px",
          borderBottom: "3px solid #e5007d",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            {/* Wiom lemniscate logo */}
            <svg viewBox="4 4 74 44" style={{ height: "44px", width: "auto" }}>
              <path d="M37 22C37 22 28 6 20 4C13 2 7 7 5 14C3 21 6 30 13 34C20 38 28 35 33 30C38 25 37 22 37 22Z"
                stroke="#e5007d" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M37 22C37 22 46 38 54 40C61 42 67 37 69 30C71 23 68 14 61 10C54 6 46 9 41 14C36 19 37 22 37 22Z"
                stroke="#e5007d" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="7" r="3" fill="#e5007d" />
            </svg>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 900, color: "#e5007d", letterSpacing: "-0.5px" }}>
                Wiom Finance
              </div>
              <div style={{ fontSize: "10px", color: "#94a3b8", letterSpacing: "2px", textTransform: "uppercase" }}>
                Employee Expense Reimbursement Report
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {periodFrom && periodTo && (
              <div style={{
                display: "inline-block",
                background: "#fdf2f8", border: "1.5px solid #fbcfe8",
                borderRadius: "8px", padding: "6px 12px",
                marginBottom: "6px",
              }}>
                <div style={{ fontSize: "10px", color: "#9d174d", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.8px" }}>
                  Submission Period
                </div>
                <div style={{ fontSize: "13px", fontWeight: 800, color: "#1e293b", marginTop: "2px" }}>
                  {periodFrom} → {periodTo}
                </div>
              </div>
            )}
            <div style={{ fontSize: "10px", color: "#64748b" }}>Generated: {today}</div>
            {sessionId && (
              <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>
                Ref: {sessionId.slice(0, 8)}
              </div>
            )}
          </div>
        </div>

        {/* ── Executive Summary KPIs ───────────────────────────────────────── */}
        <div style={{ marginBottom: "24px" }}>
          <div style={sectionHead}>Executive Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "12px" }}>
            <KpiTile
              label="Total Submitted"
              value={`₹${fmtINR(totalClaimed)}`}
              sub={`${totalClaims} claims`}
              accent="#64748b"
              iconText="📋"
            />
            <KpiTile
              label="Total Approved"
              value={`₹${fmtINR(totalApproved)}`}
              sub={`${approved.length} claims cleared`}
              accent="#10b981"
              iconText="✓"
            />
            <KpiTile
              label="Approval Rate"
              value={`${approvalRate}%`}
              sub="of submitted claims"
              accent="#7c3aed"
              iconText="📊"
            />
            <KpiTile
              label="Employees"
              value={Object.keys(empMap).length}
              sub={`across ${departments.length} dept${departments.length !== 1 ? "s" : ""}`}
              accent="#0ea5e9"
              iconText="👥"
            />
          </div>
        </div>

        {/* ── Department-wise Breakdown ────────────────────────────────────── */}
        {departments.length > 0 && (
          <div style={{ marginBottom: "24px" }}>
            <div style={sectionHead}>Department-wise Breakdown</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
                  {["Department", "Employees", "Claims", "Submitted (₹)", "Approved (₹)", "Approval %"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i < 2 ? "left" : "right",
                      padding: "7px 10px",
                      color: "#475569", fontWeight: 700, fontSize: "10px",
                      textTransform: "uppercase", letterSpacing: "0.5px",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {departments.map((d, idx) => {
                  const deptApprovalPct = d.claimed > 0 ? ((d.approved / d.claimed) * 100).toFixed(0) : 0;
                  const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
                  return (
                    <tr key={d.name} style={{ background: bg, borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "7px 10px", fontWeight: 700, color: "#1e293b" }}>{d.name}</td>
                      <td style={{ padding: "7px 10px", color: "#64748b", textAlign: "right" }}>{d.empCount}</td>
                      <td style={{ padding: "7px 10px", color: "#334155", textAlign: "right" }}>{d.claims}</td>
                      <td style={{ padding: "7px 10px", color: "#334155", textAlign: "right" }}>₹{fmtINR(d.claimed)}</td>
                      <td style={{ padding: "7px 10px", color: "#10b981", fontWeight: 700, textAlign: "right" }}>₹{fmtINR(d.approved)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>
                        <span style={{
                          display: "inline-block",
                          background: Number(deptApprovalPct) >= 80 ? "#dcfce7" : Number(deptApprovalPct) >= 50 ? "#fef9c3" : "#fee2e2",
                          color:      Number(deptApprovalPct) >= 80 ? "#15803d" : Number(deptApprovalPct) >= 50 ? "#854d0e" : "#dc2626",
                          borderRadius: "5px", padding: "1px 7px", fontSize: "10px", fontWeight: 700,
                        }}>{deptApprovalPct}%</span>
                      </td>
                    </tr>
                  );
                })}
                {/* Total row */}
                <tr style={{ background: "#f0fdf4", borderTop: "2px solid #bbf7d0" }}>
                  <td style={{ padding: "7px 10px", fontWeight: 800, color: "#1e293b" }}>Total</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: "#1e293b" }}>
                    {Object.keys(empMap).length}
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: "#1e293b" }}>{totalClaims}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: "#1e293b" }}>₹{fmtINR(totalClaimed)}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 800, color: "#10b981" }}>₹{fmtINR(totalApproved)}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: "#1e293b" }}>{approvalRate}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* ── Category Breakdown ──────────────────────────────────────────── */}
        {topCategories.length > 0 && (
          <div style={{ marginBottom: "24px" }}>
            <div style={sectionHead}>Expense Category Breakdown</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {topCategories.map(([cat, data], i) => {
                const barPct   = (data.total / maxCatAmount) * 100;
                const barColors = ["#e5007d", "#7c3aed", "#10b981", "#f59e0b", "#3b82f6", "#ef4444", "#0ea5e9", "#64748b"];
                const color     = barColors[i % barColors.length];
                const approvedPct = data.total > 0 ? ((data.approved / data.total) * 100).toFixed(0) : 0;
                return (
                  <div key={cat}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                      <span style={{ fontSize: "12px", color: "#334155", fontWeight: 600 }}>{cat}</span>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        {data.count} claim{data.count !== 1 ? "s" : ""}
                        &nbsp;·&nbsp;₹{fmtINR(data.total)}
                        &nbsp;·&nbsp;<span style={{ color: "#10b981", fontWeight: 700 }}>{approvedPct}% approved</span>
                      </span>
                    </div>
                    <div style={{ background: "#f1f5f9", borderRadius: "4px", height: "10px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${barPct}%`, background: color, borderRadius: "4px" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Employee-wise Summary ────────────────────────────────────────── */}
        {topEmployees.length > 0 && (
          <div style={{ marginBottom: "24px" }}>
            <div style={sectionHead}>Employee-wise Summary</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
                  {["#", "Employee", "Department", "Claims", "Submitted (₹)", "Approved (₹)", "Rate"].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i < 3 ? "left" : "right",
                      padding: "6px 8px",
                      color: "#475569", fontWeight: 700, fontSize: "10px",
                      textTransform: "uppercase", letterSpacing: "0.5px",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topEmployees.map((emp, idx) => {
                  const rate = emp.amount > 0 ? ((emp.approved / emp.amount) * 100).toFixed(0) : 0;
                  const bg   = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
                  return (
                    <tr key={emp.name} style={{ background: bg, borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "6px 8px", color: "#94a3b8", fontWeight: 600 }}>{idx + 1}</td>
                      <td style={{ padding: "6px 8px", color: "#1e293b", fontWeight: 600 }}>{emp.name}</td>
                      <td style={{ padding: "6px 8px", color: "#64748b", fontSize: "10px" }}>{emp.dept || "—"}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "#334155" }}>{emp.claims}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "#334155" }}>₹{fmtINR(emp.amount)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "#10b981", fontWeight: 600 }}>₹{fmtINR(emp.approved)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>
                        <span style={{
                          display: "inline-block",
                          background: Number(rate) >= 80 ? "#dcfce7" : Number(rate) >= 50 ? "#fef9c3" : "#fee2e2",
                          color:      Number(rate) >= 80 ? "#15803d" : Number(rate) >= 50 ? "#854d0e" : "#dc2626",
                          borderRadius: "5px", padding: "1px 6px", fontSize: "10px", fontWeight: 700,
                        }}>{rate}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Validation Status ────────────────────────────────────────────── */}
        {(rejected.length > 0 || flagged.length > 0 || approved.length > 0) && (
          <div style={{ marginBottom: "24px" }}>
            <div style={sectionHead}>Validation Status</div>
            <ProgressBar count={approved.length} color="#10b981" label="Approved" icon="✓" />
            {rejected.length > 0 && (
              <ProgressBar count={rejected.length} color="#ef4444" label="Rejected" icon="✗" />
            )}
            {flagged.length > 0 && (
              <ProgressBar count={flagged.length} color="#f59e0b" label="Flagged" icon="⚑" />
            )}
          </div>
        )}

        {/* ── Compliance note ─────────────────────────────────────────────── */}
        <div style={{
          background: "#fffbeb", border: "1.5px solid #fde68a",
          borderRadius: "10px", padding: "12px 16px",
          marginBottom: "24px",
          display: "flex", alignItems: "flex-start", gap: "10px",
        }}>
          <span style={{ fontSize: "15px" }}>📋</span>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#92400e", marginBottom: "3px" }}>
              Compliance Note
            </div>
            <div style={{ fontSize: "11px", color: "#78350f", lineHeight: "1.7" }}>
              All claims in this report were validated using the Wiom Expense Validation system — each bill was
              cross-verified against the submitted expense entry using OCR and policy rules.
              {rejected.length > 0 || flagged.length > 0
                ? " Rejected and flagged claims require finance team review before any disbursement."
                : " All submitted claims have been approved and are cleared for reimbursement disbursement."}
            </div>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div style={{
          paddingTop: "14px", borderTop: "2px solid #e2e8f0",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <div style={{ fontSize: "10px", color: "#94a3b8" }}>
              Generated by Wiom Finance AI &bull; Powered by Claude (Anthropic)
            </div>
            <div style={{ fontSize: "10px", color: "#cbd5e1", marginTop: "2px" }}>
              {today} &bull; Ref {sessionId?.slice(0, 8) || "—"}
              {periodFrom && periodTo ? ` · Period: ${periodFrom} – ${periodTo}` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.8px" }}>
              CONFIDENTIAL
            </div>
            <div style={{ fontSize: "10px", color: "#cbd5e1", marginTop: "2px" }}>
              Internal Finance — Do Not Distribute
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
