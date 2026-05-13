import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { kekaAction } from "../services/api";

const STATUS_BADGE = {
  Approved: "badge-approved",
  Rejected:  "badge-rejected",
  Flagged:   "badge-flagged",
};

const STATUS_ROW_BG = {
  Approved: "bg-emerald-50/40 dark:bg-emerald-950/20",
  Rejected:  "bg-red-50/40 dark:bg-red-950/20",
  Flagged:   "bg-amber-50/40 dark:bg-amber-950/20",
};

export default function ExpenseTable({ rows, sessionId, onRowEdit, onClaimAction, onBulkAction }) {
  const [filterStatus,   setFilterStatus]   = useState("All");
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [expanded,       setExpanded]       = useState(null);
  const [sortKey,        setSortKey]        = useState("row_index");
  const [sortDir,        setSortDir]        = useState("asc");

  // ── Bulk selection ───────────────────────────────────────────────────────
  const [selected,       setSelected]       = useState(new Set()); // Set of keka_claim_id strings
  const [bulkLoading,    setBulkLoading]    = useState(false);
  const [bulkResult,     setBulkResult]     = useState(null);
  const [showBulkReject, setShowBulkReject] = useState(false);
  const [bulkReason,     setBulkReason]     = useState("");
  const selectAllRef = useRef(null);

  const employees = useMemo(() => {
    const set = new Set(rows.map((r) => r.employee_name).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [rows]);

  const categories = useMemo(() => {
    const set = new Set(rows.map((r) => r.expense_nature || r.expense_category).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (filterStatus !== "All") out = out.filter((r) => r.status === filterStatus);
    if (filterEmployee && filterEmployee !== "All")
      out = out.filter((r) => r.employee_name === filterEmployee);
    if (filterCategory !== "All") out = out.filter((r) => (r.expense_nature || r.expense_category) === filterCategory);
    return [...out].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, filterStatus, filterEmployee, filterCategory, sortKey, sortDir]);

  // Claim IDs that CAN be bulk-actioned (have a Keka ID, not already actioned in Keka)
  const selectableIds = useMemo(() => {
    const ids = new Set();
    for (const r of filtered) {
      const cid = r.keka_claim_id || r.keka_claim_number || r.claim_number;
      if (cid && !r.keka_actioned) ids.add(String(cid));
    }
    return ids;
  }, [filtered]);

  const allSelected  = selectableIds.size > 0 && [...selectableIds].every(id => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  // Keep the indeterminate state of the "select all" checkbox in sync
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectableIds));
  };

  const toggleRow = (cid) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  };

  // Build { claimId → employeeName } for selected rows (sent to backend for verification)
  function buildEmployeeNamesMap(ids) {
    const map = {};
    for (const row of rows) {
      const cid = String(row.keka_claim_id || row.keka_claim_number || row.claim_number || "");
      if (cid && ids.has(cid) && row.employee_name) map[cid] = row.employee_name;
    }
    return map;
  }

  async function handleBulkApprove() {
    if (!selected.size) return;
    setBulkLoading(true);
    setBulkResult(null);
    try {
      const ids = [...selected];
      const res = await kekaAction(sessionId, "approve", ids, null, {
        employee_names: buildEmployeeNamesMap(selected),
      });
      const ok = res.actioned || [];
      setBulkResult({ type: "approve", actioned: ok.length, errors: (res.errors || []).length });
      if (ok.length > 0) { onBulkAction?.("approve", ok); setSelected(new Set()); }
    } catch (e) {
      setBulkResult({ type: "error", error: e.response?.data?.detail || e.message || "Action failed" });
    }
    setBulkLoading(false);
  }

  async function handleBulkReject(reason) {
    if (!selected.size || !reason.trim()) return;
    setBulkLoading(true);
    setBulkResult(null);
    try {
      const ids = [...selected];
      const res = await kekaAction(sessionId, "reject", ids, reason.trim(), {
        employee_names: buildEmployeeNamesMap(selected),
      });
      const ok = res.actioned || [];
      setBulkResult({ type: "reject", actioned: ok.length, errors: (res.errors || []).length });
      if (ok.length > 0) { onBulkAction?.("reject", ok); setSelected(new Set()); }
    } catch (e) {
      setBulkResult({ type: "error", error: e.response?.data?.detail || e.message || "Action failed" });
    }
    setBulkLoading(false);
    setShowBulkReject(false);
    setBulkReason("");
  }

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const billUrl = (matchedFile) =>
    matchedFile ? `/bill/${sessionId}/${matchedFile}` : null;

  // Only show Keka selection UI if the caller allows bulk actions (admin/write mode)
  const hasKeka = (onBulkAction != null) && (selectableIds.size > 0 || rows.some(r => r.keka_claim_id || r.keka_claim_number));

  return (
    <div className="card overflow-hidden">

      {/* ── Bulk action toolbar (shown when rows are selected) ── */}
      {hasKeka && selected.size > 0 && (
        <div className="px-5 py-3 bg-purple-50 dark:bg-purple-950/30 border-b border-purple-200 dark:border-purple-800 flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-purple-700 dark:text-purple-300">
            {selected.size} claim{selected.size > 1 ? "s" : ""} selected
          </span>

          <button
            onClick={handleBulkApprove}
            disabled={bulkLoading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors shadow-sm"
          >
            {bulkLoading
              ? <><Spinner /> Processing…</>
              : <><span className="text-base leading-none">✓</span> Approve ({selected.size})</>
            }
          </button>

          <button
            onClick={() => { setShowBulkReject(true); setBulkReason(""); setBulkResult(null); }}
            disabled={bulkLoading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 transition-colors shadow-sm"
          >
            <span className="text-base leading-none">✕</span> Reject ({selected.size})
          </button>

          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-purple-600 dark:text-purple-400 hover:underline ml-auto"
          >
            Deselect All
          </button>

          {/* Result message */}
          {bulkResult && (
            <span className={`text-xs font-semibold ${
              bulkResult.type === "error"
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-700 dark:text-emerald-400"
            }`}>
              {bulkResult.type === "error"
                ? `❌ ${bulkResult.error}`
                : `✅ ${bulkResult.actioned} ${bulkResult.type === "approve" ? "approved" : "rejected"}${bulkResult.errors > 0 ? ` · ${bulkResult.errors} failed` : ""}`
              }
            </span>
          )}
        </div>
      )}

      {/* ── Filter bar ── */}
      <div className="px-5 py-4 border-b border-slate-100 dark:border-gray-800 flex flex-wrap gap-3 items-center">

        {/* Select-all checkbox (only when there are selectable Keka rows) */}
        {hasKeka && (
          <label className="flex items-center gap-2 cursor-pointer select-none" title="Select all pending Keka claims">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="w-4 h-4 rounded border-slate-300 dark:border-gray-600 text-purple-600 focus:ring-purple-500 cursor-pointer"
            />
            <span className="text-xs text-slate-500 dark:text-gray-400">Select All</span>
          </label>
        )}

        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          {filtered.length} of {rows.length} records
        </span>
        <div className="flex-1" />

        <FilterSelect label="Status" value={filterStatus} onChange={setFilterStatus}
          options={["All", "Approved", "Rejected", "Flagged"]} />

        <FilterSelect label="Category" value={filterCategory} onChange={setFilterCategory}
          options={categories} />

        <div className="relative">
          <input
            type="text"
            placeholder="Search employee…"
            value={filterEmployee === "All" ? "" : filterEmployee}
            onChange={(e) => setFilterEmployee(e.target.value || "All")}
            className="pl-3 pr-3 py-1.5 rounded-lg border border-slate-200 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-300 w-44
                       dark:bg-gray-800 dark:border-gray-700 dark:text-slate-200 dark:placeholder-gray-500"
          />
        </div>

        {(filterStatus !== "All" || (filterEmployee && filterEmployee !== "All") || filterCategory !== "All") && (
          <button
            onClick={() => { setFilterStatus("All"); setFilterEmployee("All"); setFilterCategory("All"); }}
            className="text-xs text-blue-600 hover:underline font-medium dark:text-blue-400"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100 dark:bg-gray-800/60 dark:border-gray-800">

              {/* Checkbox column header */}
              {hasKeka && (
                <th className="px-3 py-3 w-8">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-slate-300 dark:border-gray-600 text-purple-600 focus:ring-purple-500 cursor-pointer"
                    title="Select all pending claims"
                  />
                </th>
              )}

              {[
                { key: "row_index",        label: "#",           w: "w-10" },
                { key: "employee_name",    label: "Employee",    w: "w-36" },
                { key: "keka_claim_number",label: "Claim #",     w: "w-24" },
                { key: "expense_date",     label: "Date",        w: "w-24" },
                { key: "expense_nature",   label: "Nature",      w: "w-36" },
                { key: "description",      label: "Description", w: "w-44" },
                { key: "claimed_amount",   label: "Claimed ₹",   w: "w-24" },
                { key: "bill_amount",      label: "Bill ₹",      w: "w-24" },
                { key: "amount_diff",      label: "Diff ₹",      w: "w-24" },
                { key: "status",           label: "Status",      w: "w-28" },
                { key: null,               label: "Remarks",     w: "flex-1" },
              ].map(({ key, label, w }) => (
                <th
                  key={label}
                  onClick={() => key && toggleSort(key)}
                  className={`px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider
                    dark:text-gray-400
                    ${key ? "cursor-pointer hover:text-slate-700 dark:hover:text-slate-200 select-none" : ""} ${w}`}
                >
                  {label}
                  {key && sortKey === key && (
                    <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-gray-800/60">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={hasKeka ? 12 : 11} className="px-4 py-10 text-center text-sm text-slate-400 dark:text-gray-500">
                  No records match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((row, idx) => {
                const cid        = row.keka_claim_id || row.keka_claim_number || row.claim_number;
                const cidStr     = cid ? String(cid) : null;
                const isSelected = cidStr ? selected.has(cidStr) : false;
                const canSelect  = cidStr && !row.keka_actioned;

                return (
                  <Fragment key={row.row_index}>
                    <tr
                      onClick={() => setExpanded(expanded === row.row_index ? null : row.row_index)}
                      className={`cursor-pointer hover:brightness-95 transition-all ${
                        isSelected
                          ? "bg-purple-50/60 dark:bg-purple-950/20"
                          : STATUS_ROW_BG[row.status] || ""
                      }`}
                    >
                      {/* Row checkbox */}
                      {hasKeka && (
                        <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                          {canSelect ? (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleRow(cidStr)}
                              className="w-4 h-4 rounded border-slate-300 dark:border-gray-600 text-purple-600 focus:ring-purple-500 cursor-pointer"
                            />
                          ) : (
                            <span className="w-4 h-4 block" />
                          )}
                        </td>
                      )}

                      <td className="px-4 py-3 text-xs text-slate-400 dark:text-gray-500">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800 truncate max-w-[9rem] dark:text-slate-200">{row.employee_name}</div>
                        <div className="text-xs text-slate-400 dark:text-gray-500">{row.employee_id}</div>
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <ClaimCell
                          sessionId={sessionId}
                          row={row}
                          onActioned={(rowIndex, action) => onClaimAction?.(rowIndex, action)}
                        />
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs whitespace-nowrap dark:text-gray-400">{row.expense_date || "—"}</td>
                      <td className="px-4 py-3">
                        <NatureBadge nature={row.expense_nature || row.expense_category} />
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs dark:text-gray-400">
                        <div className="truncate max-w-[11rem]" title={row.description}>{row.description || "—"}</div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-800 text-xs dark:text-slate-200">
                        ₹{Number(row.claimed_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs dark:text-gray-400">
                        {row.bill_amount != null
                          ? `₹${Number(row.bill_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
                          : <span className="text-slate-300 dark:text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold">
                        <AmountDiff diff={row.amount_diff} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={STATUS_BADGE[row.status] || "badge-flagged"}>
                              {row.status}
                            </span>
                            {row.matched_file && sessionId && (
                              <a
                                href={billUrl(row.matched_file)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title="View Bill"
                                className="ml-0.5 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                              </a>
                            )}
                            {/* Zoho bill status badge */}
                            {row.zoho_bill_status && (() => {
                              const zs = row.zoho_bill_status.toLowerCase();
                              const zsMap = {
                                paid:             { label: "Zoho: PAID",    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
                                pending_approval: { label: "Zoho: PENDING", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
                                open:             { label: "Zoho: OPEN",    cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
                                draft:            { label: "Zoho: DRAFT",   cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
                                void:             { label: "Zoho: VOID",    cls: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400" },
                              };
                              const { label, cls } = zsMap[zs] || { label: `Zoho: ${row.zoho_bill_status.toUpperCase()}`, cls: "bg-slate-100 text-slate-500" };
                              return (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide ${cls}`}>
                                  📦 {label}
                                </span>
                              );
                            })()}
                          </div>
                          {row.is_duplicate && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 w-fit">
                              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                              Duplicate Bill
                            </span>
                          )}
                          {/* Anomaly flags */}
                          {row.anomaly_flags?.length > 0 && (
                            <span
                              title={row.anomaly_flags.join("\n")}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 w-fit cursor-help"
                            >
                              ⚠ {row.anomaly_flags.length} anomal{row.anomaly_flags.length > 1 ? "ies" : "y"}
                            </span>
                          )}
                          {/* Smart category suggestion */}
                          {row.suggested_category && row.suggested_category !== (row.expense_nature || row.expense_category) && (
                            <span
                              title={`Vendor master suggests: ${row.suggested_category} (${row.suggested_category_confidence} confidence)`}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 w-fit cursor-help"
                            >
                              🏷 {row.suggested_category}?
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400">
                        {row.remarks?.length > 0 ? (() => {
                          const first = row.remarks[0];
                          const isDup = /duplicate/i.test(first);
                          const isMis = /mismatch|overclaim|underclaim/i.test(first);
                          const cls   = isDup ? "text-red-600 dark:text-red-400 font-medium"
                                      : isMis ? "text-amber-600 dark:text-amber-400"
                                      : "";
                          return <span className={`truncate max-w-xs block ${cls}`}>{first}</span>;
                        })() : <span className="text-slate-300 dark:text-gray-600">—</span>}
                        {row.remarks?.length > 1 && (
                          <span className="text-blue-500 cursor-pointer dark:text-blue-400">+{row.remarks.length - 1} more</span>
                        )}
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {expanded === row.row_index && (
                      <tr key={`exp-${row.row_index}`} className="bg-white dark:bg-gray-900/80">
                        <td colSpan={hasKeka ? 12 : 11} className="px-6 py-4 border-l-4 border-blue-400">
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
                            <Detail label="Claim Number"    value={row.claim_number || "—"} />
                            <Detail label="Attachment Name" value={row.attachment_name || "None"} />
                            <Detail label="Matched File"    value={row.matched_file || "Not matched"} />
                            {row.is_duplicate ? (
                              <div>
                                <span className="font-semibold text-slate-400 block dark:text-gray-500">Duplicate</span>
                                <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                  Yes — same bill used in multiple rows
                                </span>
                              </div>
                            ) : (
                              <Detail label="Duplicate" value="No" />
                            )}
                            {sessionId && (row.matched_files?.length > 0 || row.matched_file) && (
                              <div className="col-span-2 md:col-span-3">
                                <span className="font-semibold text-slate-400 block mb-1.5 dark:text-gray-500">
                                  Bills ({(row.matched_files?.length || 1)})
                                </span>
                                <div className="flex flex-wrap gap-2">
                                  {(row.matched_files?.length > 0 ? row.matched_files : [row.matched_file]).map((f, i) => (
                                    <a
                                      key={f}
                                      href={billUrl(f)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 font-semibold text-xs hover:bg-blue-100 transition-colors dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50"
                                    >
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                      </svg>
                                      Bill {i + 1}: {f.split("/").pop()}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                            {row.ocr_result && (
                              <>
                                <Detail label="OCR Vendor"     value={row.ocr_result.vendor_name || "—"} />
                                <Detail label="OCR Date"       value={row.ocr_result.bill_date || "—"} />
                                <Detail label="OCR Amount"     value={row.ocr_result.total_amount != null ? `₹${row.ocr_result.total_amount}` : "—"} />
                                <Detail label="GSTIN"          value={row.ocr_result.gstin || "—"} />
                                <Detail label="OCR Confidence" value={`${Math.round(row.ocr_result.confidence * 100)}%`} />
                              </>
                            )}

                            {/* Vendor Master Suggestion */}
                            {row.suggested_category && (
                              <div className="col-span-2 md:col-span-3">
                                <span className="font-semibold text-slate-500 block mb-1.5 dark:text-gray-400">🏷 Vendor Intelligence</span>
                                <div className="flex flex-wrap gap-2 items-center">
                                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${
                                    row.suggested_category_confidence === "high"
                                      ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                                      : "bg-slate-100 text-slate-600 dark:bg-gray-800 dark:text-gray-300"
                                  }`}>
                                    Suggested: <strong>{row.suggested_category}</strong>
                                    <span className="opacity-60">({row.suggested_category_confidence})</span>
                                  </span>
                                  {row.suggested_vendor_type && (
                                    <span className="text-xs text-slate-400 dark:text-gray-500">
                                      Type: {row.suggested_vendor_type.replace(/_/g, " ")}
                                    </span>
                                  )}
                                  {row.suggested_category !== (row.expense_nature || row.expense_category) && (
                                    <span className="text-xs text-orange-600 dark:text-orange-400 font-semibold">
                                      ⚠ Claimed as "{row.expense_nature || row.expense_category}"
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Anomaly Flags */}
                            {row.anomaly_flags?.length > 0 && (
                              <div className="col-span-2 md:col-span-3">
                                <span className="font-semibold text-slate-500 block mb-1.5 dark:text-gray-400">⚠ Anomaly Flags</span>
                                <ul className="space-y-1">
                                  {row.anomaly_flags.map((flag, i) => (
                                    <li key={i} className="flex items-start gap-1.5 text-orange-700 dark:text-orange-300">
                                      <span className="shrink-0 mt-0.5">›</span>
                                      <span>{flag}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            <div className="col-span-2 md:col-span-3">
                              <span className="font-semibold text-slate-500 block mb-1 dark:text-gray-400">All Remarks</span>
                              {row.remarks?.length > 0
                                ? <ul className="space-y-0.5">{row.remarks.map((r, i) => {
                                    const isDupRemark = /duplicate/i.test(r);
                                    const isMismatch  = /mismatch|overclaim|underclaim/i.test(r);
                                    const cls = isDupRemark
                                      ? "text-red-600 dark:text-red-400"
                                      : isMismatch
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-slate-600 dark:text-gray-400";
                                    return (
                                      <li key={i} className={`flex items-start gap-1.5 ${cls}`}>
                                        <span className="mt-0.5 opacity-50">•</span>{r}
                                      </li>
                                    );
                                  })}</ul>
                                : <span className="text-slate-400 dark:text-gray-500">No remarks</span>}
                            </div>

                            {onRowEdit && (
                              <div className="col-span-2 md:col-span-3">
                                <EditPanel row={row} onSave={(edits) => onRowEdit(row.row_index, edits)} />
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Bulk Reject Modal ── */}
      {showBulkReject && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
             onClick={() => setShowBulkReject(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 w-full max-w-md"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                  Reject {selected.size} Claim{selected.size > 1 ? "s" : ""}
                </h3>
                <p className="text-xs text-slate-500 dark:text-gray-400 mt-0.5">
                  Keka will email each employee with this reason.
                </p>
              </div>
              <button onClick={() => setShowBulkReject(false)} className="text-slate-400 hover:text-slate-600 dark:text-gray-500">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <textarea
              rows={3}
              autoFocus
              value={bulkReason}
              onChange={e => setBulkReason(e.target.value)}
              placeholder="Enter rejection reason…"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600
                         bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100
                         focus:ring-2 focus:ring-red-500 outline-none resize-none mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowBulkReject(false); setBulkReason(""); }}
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-400 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={!bulkReason.trim() || bulkLoading}
                onClick={() => handleBulkReject(bulkReason.trim())}
                className="px-4 py-2 text-sm font-bold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                {bulkLoading ? <><Spinner /> Rejecting…</> : `✕ Reject ${selected.size} & Notify`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="pl-3 pr-7 py-1.5 rounded-lg border border-slate-200 text-sm bg-white
                 focus:outline-none focus:ring-2 focus:ring-blue-300 appearance-none cursor-pointer
                 dark:bg-gray-800 dark:border-gray-700 dark:text-slate-200"
    >
      {options.map((o) => <option key={o} value={o}>{o === "All" ? `${label}: All` : o}</option>)}
    </select>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <span className="font-semibold text-slate-400 block dark:text-gray-500">{label}</span>
      <span className="text-slate-700 mt-0.5 block break-all dark:text-slate-300">{value}</span>
    </div>
  );
}

function AmountDiff({ diff }) {
  if (diff == null) return <span className="text-slate-300 dark:text-gray-600">—</span>;
  if (Math.abs(diff) < 0.01) return <span className="text-emerald-600 dark:text-emerald-400">₹0.00</span>;
  const over  = diff > 0;
  const label = over ? `+₹${diff.toFixed(2)}` : `-₹${Math.abs(diff).toFixed(2)}`;
  return (
    <span className={over ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}>
      {label}
      <span className="ml-1 text-xs opacity-70">{over ? "over" : "under"}</span>
    </span>
  );
}

const NATURE_COLORS = {
  "Travel & Transport":       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "Staff Welfare":            "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "Conveyance":               "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  "Subscription":             "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "Accommodation":            "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "Office Supplies":          "bg-slate-100 text-slate-600 dark:bg-gray-800 dark:text-gray-300",
  "Medical & Health":         "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  "Internet & Communication": "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  "Training & Development":   "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  "Fuel & Vehicle":           "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  "Miscellaneous":            "bg-slate-100 text-slate-500 dark:bg-gray-800 dark:text-gray-400",
};

function EditPanel({ row, onSave }) {
  const [open,       setOpen]       = useState(false);
  const [status,     setStatus]     = useState(row.status);
  const [note,       setNote]       = useState("");
  const [billAmount, setBillAmount] = useState(row.bill_amount ?? "");
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const edits = {};
      if (status !== row.status) edits.status = status;
      if (note.trim()) edits.note = note.trim();
      const ba = parseFloat(billAmount);
      if (!isNaN(ba) && ba !== row.bill_amount) edits.bill_amount = ba;
      if (Object.keys(edits).length === 0) { setOpen(false); return; }
      await onSave(edits);
      setNote("");
      setSaved(true);
      setTimeout(() => { setSaved(false); setOpen(false); }, 1200);
    } catch (e) {
      // keep panel open on error
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 transition-colors dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        Manual Edit
      </button>
    );
  }

  return (
    <div className="mt-1 p-4 rounded-xl border border-blue-200 bg-blue-50/60 dark:bg-blue-950/20 dark:border-blue-900/50 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-blue-700 dark:text-blue-400">Manual Override</span>
        <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:text-gray-500">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-gray-400">Change Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300
                       dark:bg-gray-800 dark:border-gray-700 dark:text-slate-200"
          >
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
            <option value="Flagged">Flagged</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-gray-400">Bill Amount (₹)</label>
          <input
            type="number" step="0.01" value={billAmount}
            onChange={(e) => setBillAmount(e.target.value)}
            placeholder={row.bill_amount ?? "Enter amount"}
            className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300
                       dark:bg-gray-800 dark:border-gray-700 dark:text-slate-200 dark:placeholder-gray-600"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-gray-400">Add Note</label>
          <input
            type="text" value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason for override…"
            className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300
                       dark:bg-gray-800 dark:border-gray-700 dark:text-slate-200 dark:placeholder-gray-600"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          ) : saved ? "Saved!" : "Save Changes"}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:text-slate-700 dark:text-gray-500 dark:hover:text-gray-300">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ClaimCell({ sessionId, row, onActioned }) {
  const claimId = row.keka_claim_id || row.keka_claim_number || row.claim_number;
  const [loading,     setLoading]     = useState(false);
  const [localAction, setLocalAction] = useState(null);
  const [showReject,  setShowReject]  = useState(false);
  const [reason,      setReason]      = useState("");
  const [errMsg,      setErrMsg]      = useState("");

  if (!claimId) return <span className="text-slate-300 dark:text-gray-600 text-xs">—</span>;

  const actioned = row.keka_actioned || localAction;

  async function doAction(action, rejReason) {
    setLoading(true);
    setErrMsg("");
    try {
      const empNames = row.employee_name ? { [String(claimId)]: row.employee_name } : {};
      const res = await kekaAction(sessionId, action, [String(claimId)], rejReason || null, {
        employee_names: empNames,
      });
      if ((res.actioned || []).length > 0) {
        setLocalAction(action);
        onActioned?.(row.row_index, action);
        setShowReject(false);
        setReason("");
      } else {
        const firstErr = (res.errors || [])[0]?.error || "Action failed in Keka — check session";
        setErrMsg(firstErr.length > 100 ? firstErr.slice(0, 100) + "…" : firstErr);
      }
    } catch (e) {
      const msg = e.response?.data?.detail || e.message || "Action failed";
      setErrMsg(msg.length > 100 ? msg.slice(0, 100) + "…" : msg);
    }
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-1 items-start min-w-[5.5rem]">
      <span className="font-mono text-xs text-purple-700 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 px-1.5 py-0.5 rounded">
        #{claimId}
      </span>

      {actioned ? (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
          actioned === "approve" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
          actioned === "reject"  ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        }`}>
          {actioned === "approve" ? "✓ Approved" : actioned === "reject" ? "✕ Rejected" : actioned}
        </span>
      ) : onActioned ? (
        <div className="flex gap-1">
          <button
            disabled={loading}
            onClick={() => doAction("approve")}
            title="Approve in Keka"
            className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/50 disabled:opacity-40 transition-colors"
          >
            {loading ? "…" : "✓"}
          </button>
          <button
            disabled={loading}
            onClick={() => { setShowReject(true); setErrMsg(""); }}
            title="Reject in Keka"
            className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-100 hover:bg-red-200 text-red-700 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 disabled:opacity-40 transition-colors"
          >
            ✕
          </button>
        </div>
      ) : null}

      {errMsg && (
        <span className="text-[10px] text-red-600 dark:text-red-400 break-all max-w-[8rem]" title={errMsg}>
          ⚠ {errMsg}
        </span>
      )}

      {showReject && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
             onClick={() => setShowReject(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-5 w-80"
               onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1">
              Reject Claim #{claimId}
            </h3>
            <p className="text-xs text-slate-500 dark:text-gray-400 mb-3">
              Keka will email the employee with this reason.
            </p>
            <textarea
              rows={3} autoFocus value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Enter rejection reason…"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600
                         bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100
                         focus:ring-2 focus:ring-red-500 outline-none resize-none mb-3"
            />
            {errMsg && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{errMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowReject(false); setErrMsg(""); }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-400 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors">
                Cancel
              </button>
              <button
                disabled={!reason.trim() || loading}
                onClick={() => doAction("reject", reason.trim())}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors"
              >
                {loading ? "Rejecting…" : "Reject & Notify"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NatureBadge({ nature }) {
  const cls = NATURE_COLORS[nature] || "bg-slate-100 text-slate-600 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-md font-medium ${cls}`}>
      {nature || "—"}
    </span>
  );
}
