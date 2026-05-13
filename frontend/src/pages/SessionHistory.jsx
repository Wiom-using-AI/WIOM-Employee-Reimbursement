import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getSessionsHistory, getAuthToken, getAuthRole, lockSession, unlockSession, deleteSession, zohoSyncSession, zohoSyncAll } from "../services/api";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(n) {
  if (!n || isNaN(n)) return "₹0";
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.toLocaleString("en-IN", { month: "long" })} ${d.getFullYear()}`;
}
function monthVal(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const PIE_COLORS = ["#10b981", "#f59e0b", "#ef4444"];

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ status }) {
  const colors = {
    completed:  "#10b981",
    processing: "#f59e0b",
    error:      "#ef4444",
  };
  return (
    <span
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        flexShrink: 0,
        background: colors[status] || "#64748b",
        boxShadow: `0 0 6px ${colors[status] || "#64748b"}99`,
      }}
    />
  );
}

// ── Source badge ──────────────────────────────────────────────────────────────
function SourceBadge({ source }) {
  if (source === "keka")
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700,
        background: "rgba(124,58,237,0.12)", color: "#a78bfa",
        border: "1px solid rgba(124,58,237,0.25)",
      }}>
        🔗 Keka Sync
      </span>
    );
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700,
      background: "var(--bg-card2)", color: "var(--text-muted)",
      border: "1px solid var(--border)",
    }}>
      📁 Upload
    </span>
  );
}

// ── Pill ──────────────────────────────────────────────────────────────────────
function Pill({ count, color }) {
  const styles = {
    green: { background: "rgba(16,185,129,0.12)", color: "#10b981", border: "1px solid rgba(16,185,129,0.25)" },
    red:   { background: "rgba(239,68,68,0.12)",  color: "#ef4444", border: "1px solid rgba(239,68,68,0.25)" },
    amber: { background: "rgba(245,158,11,0.12)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.25)" },
  };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 800,
      ...styles[color],
    }}>
      {count}
    </span>
  );
}

// ── Stat bar ──────────────────────────────────────────────────────────────────
function StatBar({ approved, rejected, flagged, total }) {
  if (!total) return null;
  return (
    <div style={{
      width: "100%", height: 4, borderRadius: 999,
      background: "var(--bg-card2)", overflow: "hidden",
      display: "flex", marginTop: 14,
    }}>
      <div style={{ height: "100%", background: "#10b981", width: `${(approved / total) * 100}%`, transition: "width 0.4s" }} />
      <div style={{ height: "100%", background: "#f59e0b", width: `${(flagged  / total) * 100}%`, transition: "width 0.4s" }} />
      <div style={{ height: "100%", background: "#ef4444", width: `${(rejected / total) * 100}%`, transition: "width 0.4s" }} />
    </div>
  );
}

// ── Top stat card ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, accentColor, icon }) {
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "18px 20px",
      transition: "box-shadow 0.2s, border-color 0.2s",
    }}>
      {icon && <div style={{ fontSize: 18, marginBottom: 6 }}>{icon}</div>}
      <p style={{
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4,
      }}>
        {label}
      </p>
      <p style={{ fontSize: 26, fontWeight: 900, color: accentColor || "var(--text-main)", lineHeight: 1.1 }}>
        {value}
      </p>
      {sub && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{sub}</p>
      )}
    </div>
  );
}

// ── Zoho status badge ─────────────────────────────────────────────────────────
function ZohoStatusBadge({ status }) {
  const map = {
    paid:             { label: "PAID",             bg: "rgba(16,185,129,0.15)",  color: "#10b981" },
    pending_approval: { label: "PENDING APPROVAL", bg: "rgba(245,158,11,0.15)", color: "#f59e0b" },
    open:             { label: "OPEN",             bg: "rgba(59,130,246,0.15)",  color: "#60a5fa" },
    draft:            { label: "DRAFT",            bg: "var(--bg-card2)",         color: "var(--text-muted)" },
    void:             { label: "VOID",             bg: "rgba(239,68,68,0.15)",   color: "#ef4444" },
    overdue:          { label: "OVERDUE",          bg: "rgba(249,115,22,0.15)",  color: "#fb923c" },
    partially_paid:   { label: "PARTIAL",          bg: "rgba(6,182,212,0.15)",   color: "#22d3ee" },
  };
  const s = map[status] || { label: (status || "UNKNOWN").toUpperCase(), bg: "var(--bg-card2)", color: "var(--text-muted)" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 800,
      letterSpacing: "0.06em", background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  );
}

// ── Session card ──────────────────────────────────────────────────────────────
function SessionCard({ session, isAdmin, onToggleLock, onDelete }) {
  const total        = session.total_claims || 1;
  const kekaApproved = session.keka_approved_count || 0;
  const zohoPushed   = session.zoho_pushed_count   || 0;
  const locked       = session.locked;
  const [toggling,    setToggling]    = useState(false);
  const [deleting,    setDeleting]    = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const [syncing,     setSyncing]     = useState(false);
  const [syncResult,  setSyncResult]  = useState(null);
  const [showSync,    setShowSync]    = useState(false);
  const [hovered,     setHovered]     = useState(false);

  async function handleLockToggle(e) {
    e.preventDefault();
    e.stopPropagation();
    setToggling(true);
    try {
      await onToggleLock(session.session_id, locked);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDel) { setConfirmDel(true); return; }
    setDeleting(true);
    try {
      await onDelete(session.session_id);
    } catch (err) {
      alert(err?.response?.data?.detail || "Delete failed");
      setDeleting(false);
      setConfirmDel(false);
    }
  }

  function handleCancelDel(e) {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDel(false);
  }

  async function handleZohoSync(e) {
    e.preventDefault();
    e.stopPropagation();
    if (showSync && syncResult) { setShowSync(false); return; }
    setSyncing(true);
    setShowSync(true);
    setSyncResult(null);
    try {
      const res = await zohoSyncSession(session.session_id);
      setSyncResult(res);
    } catch (err) {
      setSyncResult({ error: err?.response?.data?.detail || err?.message || "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  const cardBorder = locked
    ? "1px solid rgba(100,116,139,0.5)"
    : hovered
      ? "1px solid rgba(229,0,125,0.4)"
      : "1px solid var(--border)";

  const cardShadow = hovered
    ? locked
      ? "0 4px 20px rgba(0,0,0,0.15)"
      : "0 4px 24px rgba(229,0,125,0.12)"
    : "none";

  const iconBtnBase = {
    padding: "6px 8px", borderRadius: 8, fontSize: 13, cursor: "pointer",
    transition: "all 0.15s", border: "1px solid var(--border)",
    background: "transparent", color: "var(--text-muted)",
  };

  return (
    <Link to={`/dashboard/${session.session_id}`} style={{ display: "block", textDecoration: "none" }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: "var(--bg-card)", border: cardBorder, borderRadius: 8,
          padding: "18px 20px", transition: "box-shadow 0.2s, border-color 0.2s",
          boxShadow: cardShadow,
        }}
      >
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <StatusDot status={session.processing_status} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <p style={{
                  fontSize: 13, fontFamily: "monospace", fontWeight: 700,
                  color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {session.session_id.slice(0, 8)}
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>…{session.session_id.slice(-4)}</span>
                </p>
                {locked && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "2px 7px", borderRadius: 6, fontSize: 10, fontWeight: 700,
                    background: "var(--bg-card2)", color: "var(--text-sub)",
                    border: "1px solid var(--border)", flexShrink: 0,
                  }}>
                    🔒 Locked
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{fmtDate(session.created_at)}</span>
                <SourceBadge source={session.source} />
                {locked && session.locked_by && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>by {session.locked_by}</span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 6, flexShrink: 0 }}>
            {/* Zoho Sync button */}
            {zohoPushed > 0 && (
              <button
                onClick={handleZohoSync}
                disabled={syncing}
                title={showSync && syncResult ? "Hide Zoho status" : "Fetch live Zoho bill statuses"}
                style={{
                  ...iconBtnBase,
                  ...(showSync && syncResult
                    ? { borderColor: "rgba(59,130,246,0.5)", color: "#60a5fa", background: "rgba(59,130,246,0.08)" }
                    : {}),
                  opacity: syncing ? 0.6 : 1,
                  cursor: syncing ? "wait" : "pointer",
                }}
              >
                {syncing ? "⏳" : "🔄"}
              </button>
            )}

            {/* Admin lock/unlock button */}
            {isAdmin && (
              <button
                onClick={handleLockToggle}
                disabled={toggling || deleting}
                title={locked ? "Unlock session" : "Lock session"}
                style={{
                  ...iconBtnBase,
                  ...(locked
                    ? { borderColor: "rgba(16,185,129,0.4)", color: "#10b981", background: "rgba(16,185,129,0.08)" }
                    : {}),
                  opacity: toggling ? 0.5 : 1,
                  cursor: toggling ? "wait" : "pointer",
                }}
              >
                {toggling ? "⏳" : locked ? "🔓" : "🔒"}
              </button>
            )}

            {/* Admin delete button — two-click confirmation */}
            {isAdmin && (
              confirmDel ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }} onClick={e => e.preventDefault()}>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    style={{
                      padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                      background: "#ef4444", color: "#fff", border: "1px solid #ef4444",
                      cursor: deleting ? "wait" : "pointer", opacity: deleting ? 0.5 : 1, transition: "all 0.15s",
                    }}
                  >
                    {deleting ? "…" : "Confirm"}
                  </button>
                  <button
                    onClick={handleCancelDel}
                    style={{
                      padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600,
                      background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border)",
                      cursor: "pointer", transition: "all 0.15s",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  title="Delete session"
                  style={{
                    ...iconBtnBase,
                    opacity: deleting ? 0.5 : 1,
                  }}
                >
                  🗑️
                </button>
              )
            )}

            <div style={{ textAlign: "right" }}>
              <p style={{ fontSize: 15, fontWeight: 800, color: "var(--text-main)" }}>{fmtAmt(session.total_amount)}</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {session.total_claims} claim{session.total_claims !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
        </div>

        {/* Middle row — status pills */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 600 }}>✓</span>
          <Pill count={session.approved} color="green" />
          <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 600, marginLeft: 4 }}>✗</span>
          <Pill count={session.rejected} color="red" />
          <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 600, marginLeft: 4 }}>⚑</span>
          <Pill count={session.flagged} color="amber" />
          {session.approved_amount > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#10b981", fontWeight: 700 }}>
              {fmtAmt(session.approved_amount)} approved
            </span>
          )}
        </div>

        {/* Keka + Zoho row */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 8 }}>
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: kekaApproved > 0 ? "#a78bfa" : "var(--text-muted)",
          }}>
            🔗 Keka: {kekaApproved} approved
          </span>
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: zohoPushed > 0 ? "#60a5fa" : "var(--text-muted)",
          }}>
            📦 Zoho: {zohoPushed} pushed
          </span>
        </div>

        <StatBar approved={session.approved} rejected={session.rejected} flagged={session.flagged} total={total} />

        {/* Zoho sync result panel */}
        {showSync && (
          <div
            style={{
              marginTop: 12, borderRadius: 12, padding: 12,
              background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)",
            }}
            onClick={e => { e.preventDefault(); e.stopPropagation(); }}
          >
            {syncing && (
              <p style={{ fontSize: 11, color: "#60a5fa", display: "flex", alignItems: "center", gap: 6 }}>
                <svg style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} fill="none" viewBox="0 0 24 24">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Fetching Zoho bill statuses…
              </p>
            )}

            {!syncing && syncResult && syncResult.error && (
              <p style={{ fontSize: 11, color: "#ef4444" }}>❌ {syncResult.error}</p>
            )}

            {!syncing && syncResult && !syncResult.error && (
              <>
                {/* Summary row */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
                  paddingBottom: 8, borderBottom: "1px solid rgba(59,130,246,0.15)", flexWrap: "wrap",
                }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#60a5fa" }}>📦 Zoho Match</span>
                  <span style={{ fontSize: 10, color: "#10b981", fontWeight: 700 }}>
                    ✅ {syncResult.matched?.length || 0} matched
                  </span>
                  {(syncResult.unmatched?.length > 0) && (
                    <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700 }}>
                      ⚠️ {syncResult.unmatched.length} unmatched
                    </span>
                  )}
                  {(syncResult.errors?.length > 0) && (
                    <span style={{ fontSize: 10, color: "#ef4444", fontWeight: 700 }}>
                      ❌ {syncResult.errors.length} error{syncResult.errors.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
                    of {syncResult.total} pushed bills
                  </span>
                </div>

                {/* Matched bills */}
                {syncResult.matched?.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                    {syncResult.matched.map((m) => (
                      <div key={m.row_index} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: "var(--text-sub)", fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {m.employee}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0 }}>
                          #{m.bill_number}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                          ₹{(m.amount || 0).toLocaleString("en-IN")}
                        </span>
                        <ZohoStatusBadge status={m.zoho_status} />
                        {m.zoho_url && (
                          <a href={m.zoho_url} target="_blank" rel="noreferrer"
                            style={{ fontSize: 9, color: "#60a5fa", textDecoration: "none", flexShrink: 0 }}
                            onClick={e => e.stopPropagation()}>
                            ↗
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Unmatched bills */}
                {syncResult.unmatched?.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 4, marginBottom: 8,
                    borderTop: "1px solid rgba(245,158,11,0.2)", paddingTop: 8,
                  }}>
                    <p style={{ fontSize: 9, fontWeight: 800, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                      ⚠️ Vendor / Bill# Mismatch
                    </p>
                    {syncResult.unmatched.map((u, i) => (
                      <div key={i} style={{ fontSize: 10, color: "#f59e0b" }}>
                        {u.employee} — Expected Bill#{u.expected_bill_number}, got #{u.bill_number};
                        vendor: "{u.got_vendor}"
                        <ZohoStatusBadge status={u.zoho_status} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Errors */}
                {syncResult.errors?.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 2,
                    borderTop: "1px solid rgba(239,68,68,0.2)", paddingTop: 8,
                  }}>
                    <p style={{ fontSize: 9, fontWeight: 800, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                      ❌ Errors
                    </p>
                    {syncResult.errors.map((err, i) => (
                      <p key={i} style={{ fontSize: 10, color: "#ef4444" }}>
                        {err.employee || `Row ${err.row_index}`}: {err.error}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {session.error && (
          <p style={{ marginTop: 8, fontSize: 11, color: "#ef4444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.error}
          </p>
        )}
      </div>
    </Link>
  );
}

// ── Custom tooltips ───────────────────────────────────────────────────────────
function BarTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "8px 12px", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    }}>
      <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{label}</p>
      <p style={{ color: "#e5007d" }}>Approved: {fmtAmt(d?.approved ?? 0)}</p>
      <p style={{ color: "var(--text-muted)" }}>{d?.batches ?? 0} batch{d?.batches !== 1 ? "es" : ""} · {d?.claims ?? 0} claims</p>
    </div>
  );
}
function LineTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "8px 12px", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    }}>
      <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SessionHistory() {
  const [sessions,      setSessions]      = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState("");
  const [search,        setSearch]        = useState("");
  const [filter,        setFilter]        = useState("all");
  const [showAnalytics, setShowAnalytics] = useState(false);
  const isAdmin = getAuthRole() === "admin";

  // Export state
  const [exportMonth,   setExportMonth]   = useState("");
  const [exportStatus,  setExportStatus]  = useState("");
  const [exportSource,  setExportSource]  = useState("");
  const [exporting,     setExporting]     = useState(false);

  // Global Zoho sync state
  const [syncingAll,    setSyncingAll]    = useState(false);
  const [syncAllResult, setSyncAllResult] = useState(null); // null | result object

  useEffect(() => {
    getSessionsHistory()
      .then((d) => setSessions(d.sessions || []))
      .catch((e) => setError(e?.response?.data?.detail || "Failed to load session history"))
      .finally(() => setLoading(false));
  }, []);

  // ── Lock / Unlock handler ───────────────────────────────────────────────────
  async function handleToggleLock(sessionId, currentlyLocked) {
    try {
      if (currentlyLocked) {
        await unlockSession(sessionId);
      } else {
        await lockSession(sessionId);
      }
      setSessions(prev => prev.map(s =>
        s.session_id === sessionId ? { ...s, locked: !currentlyLocked } : s
      ));
    } catch (e) {
      alert(e?.response?.data?.detail || "Failed to toggle lock");
    }
  }

  // ── Delete handler ──────────────────────────────────────────────────────────
  async function handleDeleteSession(sessionId) {
    await deleteSession(sessionId);
    setSessions(prev => prev.filter(s => s.session_id !== sessionId));
  }

  // ── Global Zoho sync handler ────────────────────────────────────────────────
  async function handleSyncAll() {
    setSyncingAll(true);
    setSyncAllResult(null);
    try {
      const result = await zohoSyncAll();
      setSyncAllResult(result);
      // Reload sessions so zoho statuses reflect in the list
      const d = await getSessionsHistory();
      setSessions(d.sessions || []);
    } catch (e) {
      setSyncAllResult({ error: e?.response?.data?.detail || e.message || "Sync failed" });
    } finally {
      setSyncingAll(false);
    }
  }

  // ── Export handler ──────────────────────────────────────────────────────────
  async function handleExport(statusOverride) {
    setExporting(true);
    try {
      const BASE  = import.meta.env.VITE_API_URL ?? "/api";
      const token = getAuthToken();
      const params = new URLSearchParams();
      if (exportMonth)                 params.set("month",  exportMonth);
      if (statusOverride || exportStatus) params.set("status", statusOverride || exportStatus);
      if (exportSource)                params.set("source", exportSource);
      const res = await fetch(`${BASE}/report/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      const suffix = statusOverride ? `_${statusOverride}` : (exportStatus ? `_${exportStatus}` : "");
      a.download = `Wiom_Claims${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Export failed: " + e.message);
    } finally {
      setExporting(false);
    }
  }

  // ── Filtered list ───────────────────────────────────────────────────────────
  const filtered = sessions.filter((s) => {
    const q = search.toLowerCase();
    const matchSearch = !search || s.session_id.toLowerCase().includes(q) || (s.source || "").toLowerCase().includes(q);
    const matchFilter =
      filter === "all"    ||
      (filter === "keka"   && s.source === "keka")   ||
      (filter === "upload" && s.source === "upload") ||
      (filter === "zoho"   && s.zoho_pushed_count > 0) ||
      (filter === "keka_approved" && s.keka_approved_count > 0);
    return matchSearch && matchFilter;
  });

  // ── Month grouping ──────────────────────────────────────────────────────────
  const grouped = [];
  const monthMap = new Map();
  for (const s of filtered) {
    const mk = monthKey(s.created_at);
    if (!monthMap.has(mk)) { const e = { month: mk, sessions: [] }; monthMap.set(mk, e); grouped.push(e); }
    monthMap.get(mk).sessions.push(s);
  }

  // ── Top-level stats (all sessions) ─────────────────────────────────────────
  const totalBatches     = sessions.length;
  const totalClaims      = sessions.reduce((a, s) => a + (s.total_claims        || 0), 0);
  const totalAmt         = sessions.reduce((a, s) => a + (s.total_amount        || 0), 0);
  const totalApprovedAmt = sessions.reduce((a, s) => a + (s.approved_amount     || 0), 0);
  const totalApproved    = sessions.reduce((a, s) => a + (s.approved            || 0), 0);
  const totalRejected    = sessions.reduce((a, s) => a + (s.rejected            || 0), 0);
  const totalFlagged     = sessions.reduce((a, s) => a + (s.flagged             || 0), 0);
  const totalKekaApp     = sessions.reduce((a, s) => a + (s.keka_approved_count || 0), 0);
  const totalZohoPushed  = sessions.reduce((a, s) => a + (s.zoho_pushed_count   || 0), 0);
  const approvalRate     = totalClaims > 0 ? Math.round((totalApproved / totalClaims) * 100) : 0;

  // ── Chart data ──────────────────────────────────────────────────────────────
  const monthChartMap = {};
  for (const s of sessions) {
    const mv = monthVal(s.created_at);
    if (!monthChartMap[mv]) {
      monthChartMap[mv] = {
        month:      mv,
        shortMonth: new Date(s.created_at).toLocaleString("en-IN", { month: "short" }),
        approved:   0,
        total:      0,
        keka:       0,
        zoho:       0,
        batches:    0,
        claims:     0,
        approvedN:  0,
        rejectedN:  0,
        flaggedN:   0,
      };
    }
    const m = monthChartMap[mv];
    m.approved   += s.approved_amount        || 0;
    m.total      += s.total_amount           || 0;
    m.keka       += s.keka_approved_count    || 0;
    m.zoho       += s.zoho_pushed_count      || 0;
    m.batches    += 1;
    m.claims     += s.total_claims           || 0;
    m.approvedN  += s.approved               || 0;
    m.rejectedN  += s.rejected               || 0;
    m.flaggedN   += s.flagged                || 0;
  }
  const chartData = Object.values(monthChartMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  // Pie: overall status breakdown
  const pieData = [
    { name: "Approved", value: totalApproved },
    { name: "Flagged",  value: totalFlagged },
    { name: "Rejected", value: totalRejected },
  ].filter(d => d.value > 0);

  const filterBtns = [
    { key: "all",          label: "All" },
    { key: "upload",       label: "Upload" },
    { key: "keka",         label: "Keka Sync" },
    { key: "keka_approved",label: "Keka ✓" },
    { key: "zoho",         label: "Zoho Pushed" },
  ];

  // ── Select / input shared styles ────────────────────────────────────────────
  const selectStyle = {
    fontSize: 12, padding: "7px 12px", borderRadius: 10,
    border: "1px solid var(--border)", background: "var(--bg-card2)",
    color: "var(--text-sub)", outline: "none", cursor: "pointer",
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center",
        justifyContent: "center", background: "var(--bg-base)",
      }}>
        <svg style={{ width: 32, height: 32, color: "#e5007d", animation: "spin 1s linear infinite" }} fill="none" viewBox="0 0 24 24">
          <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-base)", paddingBottom: 64 }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 20px 0" }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <h1 style={{
                fontSize: 26, fontWeight: 900, color: "var(--text-main)",
                letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 10,
              }}>
                <span style={{
                  background: "linear-gradient(135deg,#ff4db8,#e5007d)",
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                }}>
                  Session History
                </span>
              </h1>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
                All validation batches — approved claims, Keka actions &amp; Zoho pushes
              </p>
            </div>

            {/* Global Zoho Sync button — admin only */}
            {isAdmin && (
              <button
                onClick={handleSyncAll}
                disabled={syncingAll}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "10px 18px", borderRadius: 12, fontSize: 13, fontWeight: 700,
                  background: syncingAll ? "var(--bg-card2)" : "linear-gradient(135deg,#7c3aed,#6d28d9)",
                  color: syncingAll ? "var(--text-muted)" : "#fff",
                  border: "none", cursor: syncingAll ? "not-allowed" : "pointer",
                  boxShadow: syncingAll ? "none" : "0 4px 14px rgba(124,58,237,0.35)",
                  transition: "all 0.15s",
                  opacity: syncingAll ? 0.7 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {syncingAll ? (
                  <svg style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} fill="none" viewBox="0 0 24 24">
                    <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : (
                  <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                )}
                {syncingAll ? "Syncing Zoho…" : "Fetch Live Zoho Status"}
              </button>
            )}
          </div>

          {/* Sync result panel */}
          {syncAllResult && (
            <div style={{
              marginTop: 14, padding: "14px 18px", borderRadius: 12,
              background: syncAllResult.error ? "rgba(239,68,68,0.07)" : "rgba(124,58,237,0.07)",
              border: `1px solid ${syncAllResult.error ? "rgba(239,68,68,0.25)" : "rgba(124,58,237,0.25)"}`,
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16,
            }}>
              {syncAllResult.error ? (
                <span style={{ fontSize: 13, color: "#ef4444", fontWeight: 600 }}>
                  ⚠️ {syncAllResult.error}
                </span>
              ) : (
                <>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>✓ Zoho Sync Complete</span>
                  {[
                    { label: "Updated",      val: syncAllResult.updated,      color: "#10b981" },
                    { label: "No Change",    val: syncAllResult.no_change,    color: "#64748b" },
                    { label: "Already Paid", val: syncAllResult.already_paid, color: "#0ea5e9" },
                    { label: "Errors",       val: syncAllResult.errors,       color: "#ef4444" },
                    { label: "Sessions",     val: syncAllResult.sessions_touched, color: "#7c3aed" },
                  ].map(({ label, val, color }) => (
                    <span key={label} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{
                        fontWeight: 900, fontSize: 16, color,
                        lineHeight: 1,
                      }}>{val}</span>
                      <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{label}</span>
                    </span>
                  ))}
                  {syncAllResult.details?.updated?.length > 0 && (
                    <details style={{ width: "100%", marginTop: 4 }}>
                      <summary style={{ fontSize: 11, color: "#7c3aed", cursor: "pointer", fontWeight: 600 }}>
                        View {syncAllResult.updated} updated bills ▼
                      </summary>
                      <div style={{
                        marginTop: 8, display: "flex", flexDirection: "column", gap: 4,
                        maxHeight: 200, overflowY: "auto",
                      }}>
                        {syncAllResult.details.updated.map((u, i) => (
                          <div key={i} style={{
                            fontSize: 11, display: "flex", gap: 10, alignItems: "center",
                            padding: "4px 8px", borderRadius: 6, background: "var(--bg-card2)",
                          }}>
                            <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>#{u.session_id}</span>
                            <span style={{ color: "var(--text-main)", flex: 1 }}>{u.employee}</span>
                            <span style={{ color: "#ef4444", textDecoration: "line-through" }}>{u.old_status}</span>
                            <span style={{ color: "var(--text-muted)" }}>→</span>
                            <span style={{ color: "#10b981", fontWeight: 700 }}>{u.new_status}</span>
                            {u.amount && <span style={{ color: "var(--text-muted)" }}>₹{Number(u.amount).toLocaleString("en-IN")}</span>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              )}
              <button
                onClick={() => setSyncAllResult(null)}
                style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
              >
                ✕ dismiss
              </button>
            </div>
          )}
        </div>

        {error && (
          <div style={{
            marginBottom: 24, background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.3)", borderRadius: 14,
            padding: "14px 18px", fontSize: 13, color: "#ef4444",
          }}>
            {error}
          </div>
        )}

        {/* ── 6 stat cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
          <StatCard label="Total Batches"  value={totalBatches.toLocaleString("en-IN")} sub="all time" icon="📂" />
          <StatCard label="Total Claims"   value={totalClaims.toLocaleString("en-IN")}  sub="across all sessions" icon="🧾" />
          <StatCard label="Approval Rate"  value={`${approvalRate}%`} sub={`${totalApproved} approved`} accentColor="#10b981" icon="✅" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 28 }}>
          <StatCard label="Approved Amount" value={fmtAmt(totalApprovedAmt)} sub={`of ${fmtAmt(totalAmt)} total`} accentColor="#10b981" icon="💰" />
          <StatCard label="Keka Approved"   value={totalKekaApp.toLocaleString("en-IN")} sub="actions recorded" accentColor="#a78bfa" icon="🔗" />
          <StatCard label="Zoho Pushed"     value={totalZohoPushed.toLocaleString("en-IN")} sub="entries synced" accentColor="#60a5fa" icon="📦" />
        </div>

        {/* ── Analytics toggle ── */}
        <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => setShowAnalytics((v) => !v)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "9px 18px", borderRadius: 12, fontSize: 13, fontWeight: 700,
              color: "#fff", border: "none", cursor: "pointer",
              background: "linear-gradient(135deg,#ff4db8,#e5007d)",
              boxShadow: "0 2px 12px rgba(229,0,125,0.3)",
              transition: "opacity 0.15s",
            }}
          >
            📊 {showAnalytics ? "Hide Analytics" : "Show Analytics"}
          </button>
        </div>

        {/* ── Analytics section ── */}
        {showAnalytics && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 32 }}>

            {/* Row 1: Bar + Line */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* Monthly Approved Amount */}
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 20,
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>
                  Monthly Approved Amount
                </p>
                {chartData.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "40px 0" }}>No data</p>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="pinkGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#ff4db8" stopOpacity={1} />
                          <stop offset="100%" stopColor="#e5007d" stopOpacity={0.8} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="shortMonth" tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} tickFormatter={fmtAmt} width={52} />
                      <Tooltip content={<BarTip />} />
                      <Bar dataKey="approved" fill="url(#pinkGrad)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Claims Flow Line */}
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 20,
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>
                  Claims Flow
                </p>
                {chartData.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "40px 0" }}>No data</p>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="shortMonth" tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip content={<LineTip />} />
                      <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-muted)" }} />
                      <Line type="monotone" dataKey="approvedN" name="Approved" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="rejectedN" name="Rejected" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="flaggedN"  name="Flagged"  stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Row 2: Keka+Zoho Area + Pie */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* Keka vs Zoho Area chart */}
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 20,
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>
                  Keka Approvals vs Zoho Pushes
                </p>
                {chartData.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "40px 0" }}>No data</p>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="kekaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#7c3aed" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="zohoGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="shortMonth" tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip content={<LineTip />} />
                      <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-muted)" }} />
                      <Area type="monotone" dataKey="keka" name="Keka Approved" stroke="#7c3aed" fill="url(#kekaGrad)" strokeWidth={2} dot={{ r: 3 }} />
                      <Area type="monotone" dataKey="zoho" name="Zoho Pushed"   stroke="#3b82f6" fill="url(#zohoGrad)"  strokeWidth={2} dot={{ r: 3 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Overall Status Pie */}
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 20,
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>
                  Overall Status Breakdown
                </p>
                {pieData.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "40px 0" }}>No data</p>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <ResponsiveContainer width="60%" height={200}>
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                          {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                        </Pie>
                        <Tooltip
                          formatter={(v, n) => [v, n]}
                          contentStyle={{
                            background: "var(--bg-card)", border: "1px solid var(--border)",
                            borderRadius: 10, fontSize: 12, color: "var(--text-main)",
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                      {pieData.map((d, i) => (
                        <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: "50%", background: PIE_COLORS[i], flexShrink: 0 }} />
                          <span style={{ color: "var(--text-sub)" }}>{d.name}</span>
                          <span style={{ fontWeight: 800, color: "var(--text-main)", marginLeft: "auto", paddingLeft: 12 }}>{d.value}</span>
                        </div>
                      ))}
                      <div style={{
                        marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)",
                        fontSize: 11, color: "var(--text-muted)",
                      }}>
                        Approval rate:{" "}
                        <span style={{ fontWeight: 800, color: "#10b981" }}>{approvalRate}%</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Export panel ── */}
        <div style={{
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 8, padding: 20, marginBottom: 24,
        }}>
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>📥 Export Claims Report</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
              Download CSV — includes validation status, Keka action, Zoho push status
            </p>
          </div>

          {/* Filters row */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <select value={exportMonth} onChange={(e) => setExportMonth(e.target.value)} style={selectStyle}>
              <option value="">All Months</option>
              {Array.from({ length: 12 }, (_, i) => {
                const d = new Date(); d.setMonth(d.getMonth() - i);
                const val   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                const label = d.toLocaleString("en-IN", { month: "long", year: "numeric" });
                return <option key={val} value={val}>{label}</option>;
              })}
            </select>

            <select value={exportStatus} onChange={(e) => setExportStatus(e.target.value)} style={selectStyle}>
              <option value="">All Statuses</option>
              <option value="Approved">Approved Only</option>
              <option value="Rejected">Rejected Only</option>
              <option value="Flagged">Flagged Only</option>
            </select>

            <select value={exportSource} onChange={(e) => setExportSource(e.target.value)} style={selectStyle}>
              <option value="">All Sources</option>
              <option value="keka">Keka Sync Only</option>
              <option value="upload">Upload Only</option>
            </select>

            <button
              onClick={() => handleExport()}
              disabled={exporting}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 700,
                color: "#fff", border: "none", cursor: exporting ? "not-allowed" : "pointer",
                background: "linear-gradient(135deg,#ff4db8,#e5007d)",
                opacity: exporting ? 0.6 : 1, transition: "opacity 0.15s",
              }}
            >
              {exporting ? "Generating…" : "⬇️ Download CSV"}
            </button>
          </div>

          {/* Quick export buttons */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <p style={{
              fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10,
            }}>
              Quick Export
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                onClick={() => handleExport("Approved")}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid rgba(16,185,129,0.3)", color: "#10b981",
                  background: "rgba(16,185,129,0.06)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                ✅ Approved Claims Only
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "rgba(16,185,129,0.15)", color: "#10b981",
                }}>
                  {totalApproved}
                </span>
              </button>

              <button
                onClick={() => handleExport("Rejected")}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444",
                  background: "rgba(239,68,68,0.06)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                ❌ Rejected Claims Only
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "rgba(239,68,68,0.15)", color: "#ef4444",
                }}>
                  {totalRejected}
                </span>
              </button>

              <button
                onClick={() => handleExport("Flagged")}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b",
                  background: "rgba(245,158,11,0.06)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                ⚑ Flagged Only
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "rgba(245,158,11,0.15)", color: "#f59e0b",
                }}>
                  {totalFlagged}
                </span>
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              <button
                onClick={() => { setExportSource("keka"); handleExport(); }}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid rgba(124,58,237,0.3)", color: "#a78bfa",
                  background: "rgba(124,58,237,0.06)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                🔗 Keka Approved Claims
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "rgba(124,58,237,0.15)", color: "#a78bfa",
                }}>
                  {totalKekaApp}
                </span>
              </button>

              <button
                onClick={() => { setExportSource(""); setExportStatus("Approved"); setTimeout(() => handleExport(), 50); }}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa",
                  background: "rgba(59,130,246,0.06)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                📦 Zoho-Pushed Report
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "rgba(59,130,246,0.15)", color: "#60a5fa",
                }}>
                  {totalZohoPushed}
                </span>
              </button>

              <button
                onClick={() => handleExport()}
                disabled={exporting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "7px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  border: "1px solid var(--border)", color: "var(--text-sub)",
                  background: "var(--bg-card2)", cursor: exporting ? "not-allowed" : "pointer",
                  opacity: exporting ? 0.6 : 1, transition: "all 0.15s",
                }}
              >
                📋 Full Report (All)
                <span style={{
                  padding: "1px 7px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                  background: "var(--bg-base)", color: "var(--text-sub)",
                }}>
                  {totalClaims}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* ── Search + filter bar ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
            <svg
              style={{
                position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)",
                width: 15, height: 15, color: "var(--text-muted)", pointerEvents: "none",
              }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z" />
            </svg>
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by session ID or source…"
              style={{
                width: "100%", paddingLeft: 34, paddingRight: 14, paddingTop: 9, paddingBottom: 9,
                borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-card)",
                fontSize: 13, color: "var(--text-main)", outline: "none",
                boxSizing: "border-box", transition: "border-color 0.15s",
              }}
            />
          </div>

          <div style={{
            display: "flex", alignItems: "center", gap: 4,
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 12, padding: 4, flexShrink: 0, flexWrap: "wrap",
          }}>
            {filterBtns.map((btn) => (
              <button
                key={btn.key}
                onClick={() => setFilter(btn.key)}
                style={{
                  padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 600,
                  border: "none", cursor: "pointer", transition: "all 0.15s",
                  ...(filter === btn.key
                    ? { background: "linear-gradient(135deg,#ff4db8,#e5007d)", color: "#fff" }
                    : { background: "transparent", color: "var(--text-muted)" }),
                }}
              >
                {btn.label}
              </button>
            ))}
          </div>

          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {filtered.length} session{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* ── Empty state ── */}
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "var(--text-muted)" }}>
            <svg style={{ width: 48, height: 48, margin: "0 auto 16px", opacity: 0.25 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
            </svg>
            <p style={{ fontWeight: 600, fontSize: 14 }}>No sessions found</p>
            {(search || filter !== "all") && (
              <button
                onClick={() => { setSearch(""); setFilter("all"); }}
                style={{
                  marginTop: 8, fontSize: 13, color: "#e5007d",
                  background: "none", border: "none", cursor: "pointer",
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* ── Month groups ── */}
        {grouped.map(({ month, sessions: mSessions }) => {
          const mTotal    = mSessions.reduce((a, s) => a + (s.total_amount        || 0), 0);
          const mApproved = mSessions.reduce((a, s) => a + (s.approved_amount     || 0), 0);
          const mClaims   = mSessions.reduce((a, s) => a + (s.total_claims        || 0), 0);
          const mApprN    = mSessions.reduce((a, s) => a + (s.approved            || 0), 0);
          const mKeka     = mSessions.reduce((a, s) => a + (s.keka_approved_count || 0), 0);
          const mZoho     = mSessions.reduce((a, s) => a + (s.zoho_pushed_count   || 0), 0);
          const mRate     = mClaims > 0 ? Math.round((mApprN / mClaims) * 100) : 0;

          return (
            <div key={month} style={{ marginBottom: 32 }}>
              {/* Month header */}
              <div style={{
                display: "flex", flexWrap: "wrap", alignItems: "flex-start",
                gap: "6px 12px", marginBottom: 12,
                paddingLeft: 14,
                borderLeft: "3px solid #e5007d",
              }}>
                <div>
                  <h2 style={{
                    fontSize: 12, fontWeight: 800, color: "var(--text-main)",
                    textTransform: "uppercase", letterSpacing: "0.07em",
                  }}>
                    {month}
                  </h2>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 4, fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)" }}>
                      {mSessions.length} batch{mSessions.length !== 1 ? "es" : ""}
                    </span>
                    <span style={{ color: "var(--border)" }}>•</span>
                    <span style={{ color: "var(--text-muted)" }}>{fmtAmt(mTotal)} total</span>
                    <span style={{ color: "var(--border)" }}>•</span>
                    <span style={{ color: "#10b981", fontWeight: 600 }}>✓ {fmtAmt(mApproved)} approved</span>
                    <span style={{ color: "var(--border)" }}>•</span>
                    <span style={{ color: "#10b981", fontWeight: 600 }}>{mRate}% approval rate</span>
                    {mKeka > 0 && (
                      <>
                        <span style={{ color: "var(--border)" }}>•</span>
                        <span style={{ color: "#a78bfa", fontWeight: 600 }}>🔗 {mKeka} Keka</span>
                      </>
                    )}
                    {mZoho > 0 && (
                      <>
                        <span style={{ color: "var(--border)" }}>•</span>
                        <span style={{ color: "#60a5fa", fontWeight: 600 }}>📦 {mZoho} Zoho</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {mSessions.map((s) => (
                  <SessionCard
                    key={s.session_id}
                    session={s}
                    isAdmin={isAdmin}
                    onToggleLock={handleToggleLock}
                    onDelete={handleDeleteSession}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
