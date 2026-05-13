import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getResults, editRow, revalidateSession, pollStatus, getAuthRole } from "../services/api";
import SummaryCards from "../components/SummaryCards";
import ExpenseTable from "../components/ExpenseTable";
import ExportPanel from "../components/ExportPanel";
import AnalyticsTab from "../components/AnalyticsTab";
import ZohoStatusTab from "../components/ZohoStatusTab";
import KekaActionsBar from "../components/KekaActionsBar";

const TABS = [
  { id: "validation", label: "Validation Results" },
  { id: "analytics",  label: "Analytics" },
  { id: "zoho",       label: "Zoho Status" },
];

export default function Dashboard() {
  const { sessionId } = useParams();
  const isAdmin = getAuthRole() === "admin";
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [activeTab, setActiveTab] = useState("validation");
  const [revalidating, setRevalidating] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    getResults(sessionId)
      .then(setData)
      .catch((err) => setError(err.response?.data?.detail || err.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const handleRevalidate = useCallback(async () => {
    setRevalidating(true);
    setError("");
    try {
      await revalidateSession(sessionId);
      // Poll until reprocessing is done
      pollRef.current = setInterval(async () => {
        try {
          const s = await pollStatus(sessionId);
          if (s.processing_status === "completed") {
            clearInterval(pollRef.current);
            const fresh = await getResults(sessionId);
            setData(fresh);
            setRevalidating(false);
          } else if (s.processing_status === "error") {
            clearInterval(pollRef.current);
            setError(s.error || "Revalidation failed");
            setRevalidating(false);
          }
        } catch {
          clearInterval(pollRef.current);
          setRevalidating(false);
        }
      }, 600);
    } catch (err) {
      setError(err.response?.data?.detail || "Revalidation failed");
      setRevalidating(false);
    }
  }, [sessionId]);

  const handleRowEdit = useCallback(async (rowIndex, edits) => {
    const updated = await editRow(sessionId, rowIndex, edits);
    setData((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => r.row_index === rowIndex ? updated : r),
      approved: prev.rows.filter((r) => (r.row_index === rowIndex ? updated : r).status === "Approved").length,
      rejected: prev.rows.filter((r) => (r.row_index === rowIndex ? updated : r).status === "Rejected").length,
      flagged:  prev.rows.filter((r) => (r.row_index === rowIndex ? updated : r).status === "Flagged").length,
    }));
  }, [sessionId]);

  if (loading) return <PageShell><Loading /></PageShell>;
  if (error)   return <PageShell><ErrorBanner msg={error} /></PageShell>;
  if (!data)   return null;

  return (
    <PageShell>
      {/* Header */}
      <div className="card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4 mb-6 animate-slide-up">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-2xl font-black tracking-tight" style={{ color: "var(--text-main)" }}>Validation Results</h2>
            {isAdmin
              ? <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: "rgba(229,0,125,0.1)", color: "#e5007d", border: "1px solid rgba(229,0,125,0.2)" }}>Admin</span>
              : <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)" }}>Reviewer</span>
            }
          </div>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Session&nbsp;
            <code className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--bg-card2)", color: "#e5007d", border: "1px solid var(--border)" }}>
              {sessionId.slice(0, 8)}
            </code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <button
              onClick={handleRevalidate}
              disabled={revalidating}
              className="btn-secondary text-xs"
              title="Re-run validation with latest OCR + vision logic on all bills"
            >
              {revalidating ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Re-validating…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Re-validate All
                </>
              )}
            </button>
          )}
          <Link to="/" className="btn-secondary text-xs">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Batch
          </Link>
        </div>
      </div>

      {/* Read-only notice for non-admin users */}
      {!isAdmin && (
        <div className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl"
             style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <span className="text-lg">🔒</span>
          <p className="text-sm font-medium" style={{ color: "#d97706" }}>
            Read-only view. You can view all data but only an Admin can make changes.
          </p>
        </div>
      )}

      {/* Summary cards */}
      <SummaryCards
        total={data.rows?.length ?? data.total_claims}
        approved={data.rows?.filter(r => r.status === "Approved").length ?? data.approved}
        rejected={data.rows?.filter(r => r.status === "Rejected").length ?? data.rejected}
        flagged={data.rows?.filter(r => r.status === "Flagged").length ?? data.flagged}
        unmapped={data.unmapped_bills?.length || 0}
      />

      {/* Tab navigation */}
      <div className="mt-6 card p-1.5">
        <nav className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2.5 text-sm font-semibold rounded-lg transition-all duration-150 whitespace-nowrap"
              style={activeTab === tab.id ? {
                background: "linear-gradient(135deg,rgba(255,95,186,0.15),rgba(229,0,125,0.11))",
                color: "#e5007d",
                boxShadow: "0 6px 16px rgba(229,0,125,0.08)",
              } : {
                background: "transparent",
                color: "var(--text-muted)",
              }}
            >
              {tab.label}
              {tab.id === "zoho" && (
                <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: "rgba(124,58,237,0.1)", color: "#7c3aed", border: "1px solid rgba(124,58,237,0.2)" }}>
                  Live
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-5">
        {activeTab === "validation" && (
          <>
            {data.unmapped_bills?.length > 0 && (
              <details className="card p-4 mb-5">
                <summary className="cursor-pointer text-sm font-semibold text-violet-700 select-none dark:text-violet-400">
                  Unmapped Bills ({data.unmapped_bills.length}) — in ZIP but not in Excel
                </summary>
                <ul className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-1">
                  {data.unmapped_bills.map((f) => (
                    <li key={f} className="text-xs text-slate-500 font-mono bg-slate-50 px-2 py-1 rounded truncate dark:bg-gray-800 dark:text-gray-400">{f}</li>
                  ))}
                </ul>
              </details>
            )}

            {isAdmin && (
              <KekaActionsBar
                sessionId={sessionId}
                rows={data.rows || []}
                onUpdated={({ action, claimIds }) => {
                  // Optimistically update keka_actioned on affected rows
                  setData(prev => ({
                    ...prev,
                    rows: prev.rows.map(r =>
                      claimIds.includes(r.keka_claim_id) ? { ...r, keka_actioned: action } : r
                    ),
                  }));
                }}
              />
            )}

            <ExportPanel sessionId={sessionId} rows={data.rows || []} isAdmin={isAdmin} />

            <div className="mt-5">
              <ExpenseTable
                rows={data.rows || []}
                sessionId={sessionId}
                onRowEdit={isAdmin ? handleRowEdit : null}
                onClaimAction={isAdmin ? (rowIndex, action) => {
                  const statusMap = { approve: "Approved", reject: "Rejected", mark_paid: "Approved" };
                  setData(prev => ({
                    ...prev,
                    rows: prev.rows.map(r =>
                      r.row_index === rowIndex
                        ? { ...r, keka_actioned: action, status: statusMap[action] || r.status }
                        : r
                    ),
                  }));
                } : null}
                onBulkAction={isAdmin ? (action, claimIds) => {
                  const statusMap = { approve: "Approved", reject: "Rejected", mark_paid: "Approved" };
                  setData(prev => ({
                    ...prev,
                    rows: prev.rows.map(r => {
                      const cid = String(r.keka_claim_id || r.keka_claim_number || r.claim_number || "");
                      return claimIds.includes(cid)
                        ? { ...r, keka_actioned: action, status: statusMap[action] || r.status }
                        : r;
                    }),
                  }));
                } : null}
              />
            </div>
          </>
        )}

        {activeTab === "analytics" && (
          <AnalyticsTab rows={data.rows || []} />
        )}

        {activeTab === "zoho" && (
          <ZohoStatusTab sessionId={sessionId} />
        )}
      </div>
    </PageShell>
  );
}

function PageShell({ children }) {
  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4">
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full opacity-20 blur-lg" style={{ background: "#e5007d" }} />
        <svg className="w-12 h-12 animate-spin relative" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="#e5007d" strokeWidth="3" />
          <path fill="#e5007d" className="opacity-80" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
      <p className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>Loading results…</p>
    </div>
  );
}

function ErrorBanner({ msg }) {
  return (
    <div className="max-w-md mx-auto mt-20 card p-8 text-center">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
           style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ color: "#ef4444" }}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h3 className="text-lg font-bold mb-2" style={{ color: "var(--text-main)" }}>Could not load results</h3>
      <p className="text-sm mb-6" style={{ color: "var(--text-sub)" }}>{msg}</p>
      <Link to="/" className="btn-primary justify-center">Try again</Link>
    </div>
  );
}
