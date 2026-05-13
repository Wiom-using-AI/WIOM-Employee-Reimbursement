import { useState, useMemo, useEffect } from "react";
import { kekaAction, kekaConfig, kekaClearApproveEndpoint } from "../services/api";

export default function KekaActionsBar({ sessionId, rows, onUpdated }) {
  const [selected,        setSelected]        = useState(new Set());
  const [loading,         setLoading]         = useState(false);
  const [bulkLoading,     setBulkLoading]     = useState(false); // for Approve All / Reject All
  const [actionResult,    setActionResult]    = useState(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showBulkReject,  setShowBulkReject]  = useState(false);
  const [showPaidModal,   setShowPaidModal]   = useState(false);
  const [rejectReason,    setRejectReason]    = useState("");
  const [bulkReason,      setBulkReason]      = useState("");
  const [paymentMode,     setPaymentMode]     = useState("BankTransfer");
  const [paymentDate,     setPaymentDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [referenceNo,     setReferenceNo]     = useState("");
  const [kekaCompany,       setKekaCompany]       = useState("");
  const [sessionActive,     setSessionActive]     = useState(null);
  const [endpointCached,    setEndpointCached]    = useState(false);
  const [clearingEndpoint,  setClearingEndpoint]  = useState(false);

  useEffect(() => {
    kekaConfig()
      .then(cfg => {
        setKekaCompany(cfg.company || "");
        setSessionActive(!!cfg.session_active);
        setEndpointCached(!!cfg.approve_endpoint_cached);
      })
      .catch(() => setSessionActive(false));
  }, []);

  async function handleClearEndpoint() {
    setClearingEndpoint(true);
    try {
      await kekaClearApproveEndpoint();
      setEndpointCached(false);
      setActionResult({ type: "info", message: "API cache cleared — next approve/reject will re-discover the Keka endpoint via browser UI click." });
    } catch (e) {
      setActionResult({ type: "info", message: "Cache clear failed: " + e.message });
    }
    setClearingEndpoint(false);
  }

  const claimGroups = useMemo(() => {
    const groups = {};
    for (const r of rows || []) {
      if (!r.keka_claim_id) continue;
      const cid = r.keka_claim_id;
      if (!groups[cid]) {
        groups[cid] = {
          claimId:     cid,
          claimNum:    r.keka_claim_number || cid.slice(0, 8),
          employee:    r.employee_name,
          actioned:    r.keka_actioned || null,
          status:      "Approved",
          totalAmount: 0,
          rows:        [],
        };
      }
      groups[cid].rows.push(r);
      groups[cid].totalAmount += r.claimed_amount || 0;
      if (r.status === "Rejected") groups[cid].status = "Rejected";
      else if (r.status === "Flagged" && groups[cid].status !== "Rejected") groups[cid].status = "Flagged";
    }
    return Object.values(groups);
  }, [rows]);

  // Compact banner when no Keka rows
  if (claimGroups.length === 0) {
    if (sessionActive === null) return null;
    if (!kekaCompany) return null;
    return (
      <div className="card p-3 mb-5 border-l-4 border-l-purple-400 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">⚡ Keka Actions</span>
          {sessionActive
            ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-medium">Session Active</span>
            : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium">Not Logged In</span>
          }
          <span className="text-xs text-slate-400 dark:text-gray-500 hidden sm:inline">
            · Use Keka Sync to enable one-click approve / reject
          </span>
        </div>
        <button onClick={openClaimsInKeka}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          Open in Keka
        </button>
      </div>
    );
  }

  const pendingGroups  = claimGroups.filter(g => !g.actioned);
  const selectableIds  = pendingGroups.map(g => g.claimId);
  const allSelected    = selected.size === selectableIds.length && selectableIds.length > 0;

  function toggle(cid) {
    setSelected(prev => { const n = new Set(prev); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  function openClaimsInKeka() {
    const co = kekaCompany || "omniainformation";
    window.open(`https://${co}.keka.com/#/org/expenses/expenseclaims`, "_blank", "noopener,noreferrer");
  }

  // Build { claimId → employeeName } for all supplied ids (used for Keka name verification)
  function _empNamesFor(ids) {
    const map = {};
    for (const g of claimGroups) {
      if ([...ids].includes(g.claimId) && g.employee) map[g.claimId] = g.employee;
    }
    return map;
  }

  async function _callAction(action, ids, extras = {}, reason = null) {
    const res = await kekaAction(sessionId, action, [...ids], reason, {
      employee_names: _empNamesFor(ids),
      ...extras,
    });
    const actionedCount = (res.actioned || []).length;
    const errorCount    = (res.errors   || []).length;
    if (actionedCount === 0 && errorCount > 0) {
      const firstErr = res.errors[0]?.error || "All actions failed";
      const isBlock  = /not found|Invalid request|action.*failed|404|405|400|SPA action|session required|no active keka session/i.test(firstErr);
      return { ok: false, error: firstErr, api_blocked: isBlock, res };
    }
    onUpdated?.({ action, claimIds: res.actioned || [] });
    return { ok: true, res };
  }

  // Granular selection action
  async function runSelected(action, extras = {}, reason = null) {
    if (!selected.size) return;
    setLoading(true);
    setActionResult(null);
    try {
      const { ok, error, api_blocked, res } = await _callAction(action, selected, extras, reason);
      if (ok) {
        setActionResult({ ...res, type: action });
        setSelected(new Set());
      } else {
        setActionResult({ type: "error", error, api_blocked, selectedClaims: [...selected] });
      }
    } catch (err) {
      const errMsg = err.response?.data?.detail || err.message || "Action failed";
      setActionResult({ type: "error", error: errMsg, api_blocked: false });
    }
    setLoading(false);
  }

  // Approve ALL pending in one click
  async function approveAll() {
    if (!pendingGroups.length) return;
    setBulkLoading(true);
    setActionResult(null);
    try {
      const ids = pendingGroups.map(g => g.claimId);
      const { ok, error, api_blocked, res } = await _callAction("approve", ids);
      if (ok) {
        setActionResult({ ...res, type: "approve", isBulk: true });
      } else {
        setActionResult({ type: "error", error, api_blocked, isBulk: true });
      }
    } catch (err) {
      setActionResult({ type: "error", error: err.response?.data?.detail || err.message || "Action failed" });
    }
    setBulkLoading(false);
  }

  // Reject ALL pending (after reason modal)
  async function rejectAll(reason) {
    setBulkLoading(true);
    setActionResult(null);
    try {
      const ids = pendingGroups.map(g => g.claimId);
      const { ok, error, api_blocked, res } = await _callAction("reject", ids, {}, reason);
      if (ok) {
        setActionResult({ ...res, type: "reject", isBulk: true });
      } else {
        setActionResult({ type: "error", error, api_blocked, isBulk: true });
      }
    } catch (err) {
      setActionResult({ type: "error", error: err.response?.data?.detail || err.message || "Action failed" });
    }
    setBulkLoading(false);
  }

  const anyLoading = loading || bulkLoading;

  return (
    <div className="card p-4 mb-5 border-l-4 border-l-purple-500">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">⚡ Keka Quick Actions</h3>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
            {claimGroups.length} claims
          </span>
          {sessionActive === true && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              Session Active
            </span>
          )}
        </div>
        <button onClick={openClaimsInKeka}
          className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:underline">
          Open in Keka ↗
        </button>
      </div>

      {/* Session warning */}
      {sessionActive === false && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            <strong>Keka session not active.</strong>{" "}
            <a href="/keka" className="underline font-semibold">Log in on the Keka Sync page</a> first.
          </span>
        </div>
      )}

      {/* ── ONE-CLICK BULK ACTIONS ── */}
      {pendingGroups.length > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-gradient-to-r from-slate-50 to-purple-50/40 dark:from-gray-800/60 dark:to-purple-900/10 border border-slate-100 dark:border-gray-700">
          <p className="text-xs text-slate-500 dark:text-gray-400 mb-2.5 font-medium">
            One-click bulk action — all {pendingGroups.length} pending claim{pendingGroups.length > 1 ? "s" : ""}
          </p>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={approveAll}
              disabled={anyLoading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              {bulkLoading
                ? <><Spinner /> Processing {pendingGroups.length} claim{pendingGroups.length > 1 ? "s" : ""}…</>
                : <><span className="text-base leading-none">✓</span> Approve All ({pendingGroups.length})</>
              }
            </button>

            <button
              onClick={() => { setShowBulkReject(true); setBulkReason(""); }}
              disabled={anyLoading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-700 active:scale-95 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <span className="text-base leading-none">✕</span> Reject All ({pendingGroups.length})
            </button>

            <button
              onClick={() => setShowPaidModal(true)}
              disabled={anyLoading || !selected.size}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg bg-blue-600 hover:bg-blue-700 active:scale-95 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
              title="Select approved claims below, then click"
            >
              💳 Mark as Paid
            </button>
          </div>
        </div>
      )}

      {/* ── GRANULAR SELECTION ── */}
      <details className="group">
        <summary className="cursor-pointer text-xs font-semibold text-slate-500 dark:text-gray-400 select-none flex items-center gap-1.5 mb-2 hover:text-slate-700 dark:hover:text-slate-300">
          <svg className="w-3.5 h-3.5 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Select specific claims
          {selected.size > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] font-bold">
              {selected.size} selected
            </span>
          )}
        </summary>

        <div className="flex justify-between items-center mb-2">
          <button onClick={toggleAll} className="btn-secondary text-xs">
            {allSelected ? "Deselect All" : "Select All Pending"}
          </button>
        </div>

        {/* Claim chips */}
        <div className="flex flex-wrap gap-2 mb-3 max-h-36 overflow-y-auto p-2 rounded-lg bg-slate-50 dark:bg-gray-800/40">
          {claimGroups.map(g => {
            const isSelected = selected.has(g.claimId);
            const isActioned = !!g.actioned;
            const baseStyle  = isActioned
              ? "opacity-50 cursor-not-allowed"
              : isSelected
                ? "ring-2 ring-purple-500 bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-200"
                : "bg-white dark:bg-gray-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-gray-700";
            return (
              <button
                key={g.claimId}
                onClick={() => !isActioned && toggle(g.claimId)}
                disabled={isActioned}
                className={`text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-gray-700 transition-all ${baseStyle}`}
                title={`${g.employee} · ₹${g.totalAmount.toFixed(0)} · ${g.status}`}
              >
                <span className="font-mono font-bold">#{g.claimNum}</span>
                <span className="ml-1 text-slate-400 dark:text-gray-500">{g.employee?.split(" ")[0]}</span>
                <span className={`ml-1.5 text-[10px] font-bold ${
                  g.status === "Approved" ? "text-emerald-600 dark:text-emerald-400" :
                  g.status === "Rejected" ? "text-red-600 dark:text-red-400" :
                  "text-amber-600 dark:text-amber-400"
                }`}>₹{g.totalAmount.toFixed(0)}</span>
                {isActioned && (
                  <span className="ml-1 text-[10px] uppercase font-bold text-slate-400">· {g.actioned}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Selected action buttons */}
        {selected.size > 0 && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => runSelected("approve")}
              disabled={anyLoading}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              {loading ? <Spinner /> : "✓"} Approve Selected ({selected.size})
            </button>
            <button
              onClick={() => setShowRejectModal(true)}
              disabled={anyLoading}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              ✕ Reject Selected ({selected.size})
            </button>
            <button
              onClick={() => setShowPaidModal(true)}
              disabled={anyLoading}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              💳 Mark Paid ({selected.size})
            </button>
          </div>
        )}
      </details>

      {/* Endpoint cache status */}
      {endpointCached && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 text-xs text-blue-700 dark:text-blue-300 flex items-center justify-between gap-2">
          <span>⚡ Keka approve API cached — instant single-request batch actions</span>
          <button
            onClick={handleClearEndpoint}
            disabled={clearingEndpoint}
            className="px-2 py-1 text-[10px] font-medium rounded bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors disabled:opacity-50"
            title="Clear cache to force re-discovery via browser UI click"
          >
            {clearingEndpoint ? "Clearing…" : "Reset cache"}
          </button>
        </div>
      )}

      {/* Result banner */}
      {actionResult && (
        <div className={`mt-3 p-3 rounded-lg text-sm flex items-start gap-2 ${
          actionResult.type === "error"
            ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
            : actionResult.type === "info"
            ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
            : "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
        }`}>
          {actionResult.type === "error" ? (
            <div className="flex-1">
              <p className="flex items-start gap-1.5 font-medium">
                <span>❌</span>
                <span>{actionResult.error}</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={openClaimsInKeka}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-colors">
                  Open in Keka manually ↗
                </button>
                {endpointCached && (
                  <button onClick={handleClearEndpoint}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-600 hover:bg-slate-700 text-white transition-colors">
                    🔄 Reset API cache & retry
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs opacity-60">
                💡 App opens Keka browser → navigates to approval page → clicks button → captures real API. Check backend logs for details.
              </p>
            </div>
          ) : actionResult.type === "info" ? (
            <span className="flex-1">ℹ️ {actionResult.message}</span>
          ) : (
            <span className="flex-1">
              ✅ <strong>{actionResult.actioned?.length || 0}</strong> claim(s){" "}
              {actionResult.type === "approve"   ? "approved" :
               actionResult.type === "reject"    ? "rejected (email sent)" :
               actionResult.type === "mark_paid" ? "marked as paid" : "actioned"}{" "}
              in Keka{actionResult.isBulk ? " (bulk)" : ""}.
              {actionResult.errors?.length > 0 && (
                <span className="block mt-1 text-amber-600 dark:text-amber-400">
                  ⚠️ {actionResult.errors.length} failed:{" "}
                  {actionResult.errors.slice(0, 3).map(e => e.claim_id?.slice(0, 8)).join(", ")}
                  {actionResult.errors.length > 3 ? "…" : ""}
                </span>
              )}
            </span>
          )}
          <button onClick={() => setActionResult(null)} className="opacity-60 hover:opacity-100 self-start">✕</button>
        </div>
      )}

      {/* Bulk Reject Modal */}
      {showBulkReject && (
        <Modal
          title={`Reject All ${pendingGroups.length} Pending Claims`}
          subtitle="Keka will email each employee with this reason."
          onClose={() => setShowBulkReject(false)}
        >
          <textarea
            rows={3}
            value={bulkReason}
            onChange={e => setBulkReason(e.target.value)}
            placeholder="Enter rejection reason…"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-red-500 outline-none resize-none mb-4"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowBulkReject(false)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={() => { setShowBulkReject(false); rejectAll(bulkReason.trim()); setBulkReason(""); }}
              disabled={!bulkReason.trim()}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors"
            >
              ✕ Reject All &amp; Notify
            </button>
          </div>
        </Modal>
      )}

      {/* Individual Reject Modal */}
      {showRejectModal && (
        <Modal
          title={`Reject ${selected.size} Selected Claim(s)`}
          subtitle="Keka will email the employee(s) with this reason."
          onClose={() => setShowRejectModal(false)}
        >
          <textarea
            rows={3}
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="Enter rejection reason…"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-red-500 outline-none resize-none mb-4"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowRejectModal(false)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={() => { setShowRejectModal(false); runSelected("reject", {}, rejectReason.trim()); setRejectReason(""); }}
              disabled={!rejectReason.trim()}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors"
            >
              Reject &amp; Notify
            </button>
          </div>
        </Modal>
      )}

      {/* Mark as Paid Modal */}
      {showPaidModal && (
        <Modal
          title={`Mark ${selected.size || pendingGroups.length} Claim(s) as Paid`}
          subtitle="Records the payment in Keka. Only works for already-approved claims."
          onClose={() => setShowPaidModal(false)}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase">Payment Mode</label>
              <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500">
                <option value="BankTransfer">Bank Transfer</option>
                <option value="Cash">Cash</option>
                <option value="Cheque">Cheque</option>
                <option value="DigitalWallet">Digital Wallet (UPI)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase">Payment Date</label>
              <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase">
                Reference Number <span className="text-slate-400 normal-case">(optional)</span>
              </label>
              <input type="text" value={referenceNo} onChange={e => setReferenceNo(e.target.value)}
                placeholder="Transaction ID / cheque number"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowPaidModal(false)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={() => {
                const ids = selected.size > 0 ? selected : new Set(pendingGroups.map(g => g.claimId));
                setShowPaidModal(false);
                runSelected("mark_paid", { payment_mode: paymentMode, payment_date: paymentDate, reference_no: referenceNo });
              }}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              💳 Confirm Payment
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}

function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{title}</h3>
            {subtitle && <p className="text-sm text-slate-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
