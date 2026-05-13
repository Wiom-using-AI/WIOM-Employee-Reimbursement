import { useState, useEffect } from "react";
import { excelDownloadUrl, exportToSheets, exportToZoho, getZohoAccounts, fixZohoVendorNumbers } from "../services/api";
import PdfReport from "./PdfReport";

export default function ExportPanel({ sessionId, rows = [], isAdmin = false }) {
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsResult, setSheetsResult]   = useState(null);
  const [sheetsError, setSheetsError]     = useState("");

  const [zohoLoading, setZohoLoading]   = useState(false);
  const [zohoResult, setZohoResult]     = useState(null);
  const [zohoError, setZohoError]       = useState("");

  const [fixVendorLoading, setFixVendorLoading] = useState(false);
  const [fixVendorResult, setFixVendorResult]   = useState(null);
  const [fixVendorError, setFixVendorError]     = useState("");

  // Zoho config dialog state
  const [showZohoConfig, setShowZohoConfig] = useState(false);
  const [zohoAccounts, setZohoAccounts]     = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [rowConfig, setRowConfig]           = useState({});   // row_index → {selected, account}

  const approvedRows = rows.filter((r) => r.status === "Approved");

  // Open Zoho config: load accounts + init row config with auto-detected accounts
  const openZohoConfig = async () => {
    setShowZohoConfig(true);
    setZohoError("");
    setAccountsLoading(true);
    try {
      const res = await getZohoAccounts(sessionId);
      const accounts = res.accounts || [];
      const detected = res.detected || {};
      setZohoAccounts(accounts);
      // Set detected account as default; keep any existing manual override
      const init = {};
      approvedRows.forEach((r) => {
        init[r.row_index] = {
          selected: rowConfig[r.row_index]?.selected ?? true,
          account: rowConfig[r.row_index]?.account || detected[r.row_index] || "",
        };
      });
      setRowConfig(init);
    } catch {
      // Fallback: show text inputs
      const init = {};
      approvedRows.forEach((r) => {
        init[r.row_index] = { selected: true, account: rowConfig[r.row_index]?.account || "" };
      });
      setRowConfig(init);
    } finally {
      setAccountsLoading(false);
    }
  };

  const handleZohoExport = async () => {
    setShowZohoConfig(false);
    setZohoLoading(true);
    setZohoError("");
    setZohoResult(null);
    try {
      const overrides = {};
      Object.entries(rowConfig).forEach(([idx, cfg]) => {
        overrides[idx] = { selected: cfg.selected, account: cfg.account || undefined };
      });
      const result = await exportToZoho(sessionId, overrides);
      setZohoResult(result);
      // Update account list from response if available
      if (result.accounts?.length) setZohoAccounts(result.accounts);
    } catch (err) {
      setZohoError(err.response?.data?.detail || "Zoho Books export failed.");
    } finally {
      setZohoLoading(false);
    }
  };

  const handleFixVendorNumbers = async () => {
    setFixVendorLoading(true);
    setFixVendorError("");
    setFixVendorResult(null);
    try {
      const result = await fixZohoVendorNumbers(sessionId);
      setFixVendorResult(result);
    } catch (err) {
      setFixVendorError(err.response?.data?.detail || "Vendor number update failed.");
    } finally {
      setFixVendorLoading(false);
    }
  };

  const handleSheetsExport = async () => {
    setSheetsLoading(true);
    setSheetsError("");
    setSheetsResult(null);
    try {
      const result = await exportToSheets(sessionId, "Expense Validation Report");
      setSheetsResult(result);
    } catch (err) {
      setSheetsError(err.response?.data?.detail || "Google Sheets export failed. Check GOOGLE_SERVICE_ACCOUNT_JSON env var.");
    } finally {
      setSheetsLoading(false);
    }
  };

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-700 mb-4 dark:text-slate-300">Export Results</h3>
      <div className="flex flex-wrap gap-3">

        {/* Excel download */}
        <a href={excelDownloadUrl(sessionId)} download className="btn-primary">
          <ExcelIcon />
          Download Excel Report
        </a>

        {/* Google Sheets — admin only */}
        {isAdmin && (
          sheetsResult ? (
            <a href={sheetsResult.spreadsheet_url} target="_blank" rel="noopener noreferrer"
              className="btn-secondary text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100">
              <SheetsIcon />Open in Google Sheets
            </a>
          ) : (
            <button onClick={handleSheetsExport} disabled={sheetsLoading} className="btn-secondary">
              {sheetsLoading ? <><Spinner />Pushing to Sheets…</> : <><SheetsIcon />Push to Google Sheets</>}
            </button>
          )
        )}

        {/* Zoho Books — admin only */}
        {isAdmin && (
          <button
            onClick={openZohoConfig}
            disabled={zohoLoading || approvedRows.length === 0}
            className="btn-secondary"
            title={approvedRows.length === 0 ? "No approved rows" : ""}
          >
            {zohoLoading ? <><Spinner />Pushing to Zoho…</> : <><ZohoIcon />Push to Zoho Books</>}
          </button>
        )}

        {/* Fix vendor numbers — admin only */}
        {isAdmin && (
          <button
            onClick={handleFixVendorNumbers}
            disabled={fixVendorLoading}
            className="btn-secondary text-violet-700 border-violet-200 bg-violet-50 hover:bg-violet-100 dark:text-violet-300 dark:border-violet-800 dark:bg-violet-950/30"
            title="Update already-created Zoho vendors: replace auto-generated VND-XXXXX number with employee code"
          >
            {fixVendorLoading ? <><Spinner />Updating vendor codes…</> : <>🔧 Fix Vendor Numbers</>}
          </button>
        )}

        {/* CEO PDF Report — visible to all */}
        <PdfReport rows={rows} sessionId={sessionId} />
      </div>

      {/* Sheets error */}
      {sheetsError && (
        <div className="mt-3 text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:border-red-900/50">
          <p className="text-red-600 dark:text-red-400 font-semibold">Google Sheets export failed</p>
          <p className="text-red-500 mt-0.5">{sheetsError}</p>
        </div>
      )}

      {sheetsResult && (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
          Sheet created: <strong>{sheetsResult.sheet_name}</strong> —
          <a href={sheetsResult.spreadsheet_url} target="_blank" rel="noopener noreferrer"
            className="ml-1 underline hover:text-emerald-900 dark:hover:text-emerald-300">
            View shareable link
          </a>
        </p>
      )}

      {/* Zoho error */}
      {zohoError && (
        <div className="mt-3 text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:border-red-900/50">
          <p className="text-red-600 dark:text-red-400 font-semibold">Zoho Books export failed</p>
          <p className="text-red-500 mt-0.5">{zohoError}</p>
        </div>
      )}

      {/* Fix vendor numbers error */}
      {fixVendorError && (
        <div className="mt-3 text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2 dark:bg-red-950/30 dark:border-red-900/50">
          <p className="text-red-600 dark:text-red-400 font-semibold">Vendor number update failed</p>
          <p className="text-red-500 mt-0.5">{fixVendorError}</p>
        </div>
      )}

      {/* Fix vendor numbers result */}
      {fixVendorResult && (
        <div className="mt-3 p-3 rounded-lg bg-violet-50 border border-violet-100 dark:bg-violet-950/30 dark:border-violet-900/50">
          <p className="text-xs font-semibold text-violet-700 dark:text-violet-300 mb-1.5">
            Vendor Number Update — {fixVendorResult.updated?.length || 0} updated,{" "}
            {fixVendorResult.skipped?.length || 0} skipped
          </p>
          {fixVendorResult.updated?.length > 0 && (
            <ul className="space-y-0.5 mb-1.5">
              {fixVendorResult.updated.map((u, i) => (
                <li key={i} className="text-xs text-violet-700 dark:text-violet-300">
                  ✓ <strong>{u.employee}</strong>: {u.old_number} → <strong>{u.new_number}</strong>
                </li>
              ))}
            </ul>
          )}
          {fixVendorResult.skipped?.length > 0 && (
            <ul className="space-y-0.5 mb-1.5">
              {fixVendorResult.skipped.map((s, i) => (
                <li key={i} className="text-xs text-slate-500 dark:text-slate-400">
                  – {s.employee}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          {fixVendorResult.errors?.length > 0 && (
            <ul className="space-y-0.5">
              {fixVendorResult.errors.map((e, i) => (
                <li key={i} className="text-xs text-red-600 dark:text-red-400">⚠ {e.employee}: {e.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Zoho result */}
      {zohoResult && (
        <div className="mt-3 p-3 rounded-lg bg-emerald-50 border border-emerald-100 dark:bg-emerald-950/30 dark:border-emerald-900/50">
          <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            Zoho Books — {zohoResult.pushed?.length || 0} of {zohoResult.total} pushed as drafts
          </p>
          {zohoResult.pushed?.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {zohoResult.pushed.map((p) => {
                const v = zohoResult.verification?.find(x => x.row_index === p.row_index);
                return (
                  <li key={p.bill_id || p.expense_id} className="text-xs flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={v?.ok === false ? "text-amber-500" : "text-emerald-500"}>
                        {v?.ok === false ? "⚠" : "✓"}
                      </span>
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">{p.employee}</span>
                      <span className="text-slate-500">₹{Number(p.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      <span className="text-slate-400 text-xs bg-slate-100 dark:bg-gray-800 px-1 rounded">{p.account}</span>
                      {p.zoho_url && (
                        <a href={p.zoho_url} target="_blank" rel="noopener noreferrer"
                          className="underline text-blue-600 dark:text-blue-400 ml-auto">view draft</a>
                      )}
                    </div>
                    {v && (
                      <p className={`ml-4 text-xs ${v.ok ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-400"}`}>
                        {v.ok ? "AI verified ✓ — " : "AI flag — "}{v.summary}
                        {v.issues?.length > 0 && !v.ok && (
                          <span className="block text-red-500">{v.issues.join("; ")}</span>
                        )}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {zohoResult.errors?.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {zohoResult.errors.map((e, i) => (
                <li key={i} className="text-xs text-red-600 dark:text-red-400">⚠ {e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Zoho Config Modal */}
      {showZohoConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-gray-700">
              <h3 className="font-semibold text-slate-800 dark:text-slate-200">Configure Zoho Books Push</h3>
              <button onClick={() => setShowZohoConfig(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-3">
              {accountsLoading && (
                <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5"><Spinner />Loading Zoho accounts…</p>
              )}
              <p className="text-xs text-slate-500 dark:text-gray-400 mb-3">
                Select which approved claims to push and optionally override the expense account.
                All entries are created as <strong>drafts</strong>.
              </p>

              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-gray-700">
                    <th className="pb-2 text-left w-8">
                      <input type="checkbox"
                        checked={Object.values(rowConfig).every(c => c.selected)}
                        onChange={(e) => setRowConfig(prev => {
                          const next = {...prev};
                          Object.keys(next).forEach(k => next[k] = {...next[k], selected: e.target.checked});
                          return next;
                        })}
                        className="rounded"
                      />
                    </th>
                    <th className="pb-2 text-left text-slate-600 dark:text-slate-300 font-medium">Employee</th>
                    <th className="pb-2 text-left text-slate-600 dark:text-slate-300 font-medium">Amount</th>
                    <th className="pb-2 text-left text-slate-600 dark:text-slate-300 font-medium">Category</th>
                    <th className="pb-2 text-left text-slate-600 dark:text-slate-300 font-medium">Expense Account</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                  {approvedRows.map((row) => {
                    const cfg = rowConfig[row.row_index] || { selected: true, account: "" };
                    return (
                      <tr key={row.row_index} className={cfg.selected ? "" : "opacity-40"}>
                        <td className="py-2">
                          <input type="checkbox" checked={cfg.selected}
                            onChange={(e) => setRowConfig(prev => ({
                              ...prev,
                              [row.row_index]: {...(prev[row.row_index]||{}), selected: e.target.checked}
                            }))}
                            className="rounded"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <div className="font-medium text-slate-800 dark:text-slate-200">{row.employee_name}</div>
                          <div className="text-slate-400">{row.employee_id}</div>
                        </td>
                        <td className="py-2 pr-3 text-slate-700 dark:text-slate-300">
                          ₹{Number(row.bill_amount ?? row.claimed_amount).toLocaleString("en-IN", {minimumFractionDigits: 2})}
                        </td>
                        <td className="py-2 pr-3 text-slate-500 dark:text-gray-400">
                          {row.expense_category}
                        </td>
                        <td className="py-2">
                          {zohoAccounts.length > 0 ? (
                            <select
                              value={cfg.account}
                              onChange={(e) => setRowConfig(prev => ({
                                ...prev,
                                [row.row_index]: {...(prev[row.row_index]||{}), account: e.target.value}
                              }))}
                              className="w-full text-xs border border-slate-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800 text-slate-700 dark:text-slate-200"
                            >
                              <option value="">Auto-detect</option>
                              {zohoAccounts.map(a => (
                                <option key={a} value={a}>{a}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              placeholder="Auto-detect"
                              value={cfg.account}
                              onChange={(e) => setRowConfig(prev => ({
                                ...prev,
                                [row.row_index]: {...(prev[row.row_index]||{}), account: e.target.value}
                              }))}
                              className="w-full text-xs border border-slate-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800 text-slate-700 dark:text-slate-200"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-200 dark:border-gray-700">
              <button onClick={() => setShowZohoConfig(false)}
                className="btn-secondary text-sm">Cancel</button>
              <button
                onClick={handleZohoExport}
                disabled={!Object.values(rowConfig).some(c => c.selected)}
                className="btn-primary text-sm"
              >
                Push {Object.values(rowConfig).filter(c => c.selected).length} to Zoho Books
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function ExcelIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function SheetsIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3h5v2h-5V6zm0 4h5v2h-5v-2zm0 4h5v2h-5v-2zM7 6h3v2H7V6zm0 4h3v2H7v-2zm0 4h3v2H7v-2z" />
    </svg>
  );
}

function ZohoIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
    </svg>
  );
}
