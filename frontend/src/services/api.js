import axios from "axios";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

const client = axios.create({ baseURL: BASE, timeout: 600_000 });

// ── Auth: attach Bearer token to every request ───────────────────────────────
const TOKEN_KEY = "wiom_app_token";

export function getAuthToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
export function clearAuthToken() { setAuthToken(""); }

client.interceptors.request.use((config) => {
  const t = getAuthToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// On 401, clear token + redirect to /login (caught by AuthGate)
client.interceptors.response.use(
  (resp) => resp,
  (err) => {
    if (err.response?.status === 401 && !err.config?.url?.includes("/auth/")) {
      clearAuthToken();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  },
);

const ROLE_KEY = "wiom_app_role";
const USER_KEY = "wiom_app_user";

export function getAuthRole()  { try { return localStorage.getItem(ROLE_KEY) || "reviewer"; } catch { return "reviewer"; } }
export function getAuthUser()  { try { return localStorage.getItem(USER_KEY) || ""; }        catch { return ""; } }
function setAuthMeta(username, role) {
  // Only preserve stored role for the same user when server omits it (old tokens).
  // Never carry over a previous user's role.
  try {
    const storedUser = localStorage.getItem(USER_KEY) || "";
    const storedRole = localStorage.getItem(ROLE_KEY) || "";
    const sameUser   = storedUser === (username || "");
    const resolved   = role
      ? role                             // server gave a role → always trust it
      : (sameUser && storedRole)         // same user, no role in token → keep stored
        ? storedRole
        : "reviewer";                   // different user or nothing → default
    localStorage.setItem(ROLE_KEY, resolved);
    localStorage.setItem(USER_KEY, username || "");
  } catch {}
}
function clearAuthMeta() {
  try { localStorage.removeItem(ROLE_KEY); localStorage.removeItem(USER_KEY); } catch {}
}

export async function authLogin(username, password) {
  const { data } = await client.post("/auth/login", { username, password });
  setAuthToken(data.token);
  // On fresh login: always write the exact role the server returns, never preserve old session's role.
  try {
    localStorage.setItem(ROLE_KEY, data.role || "reviewer");
    localStorage.setItem(USER_KEY, data.username || "");
  } catch {}
  return data;   // { token, username, role, expires_in }
}

export async function authMe() {
  const { data } = await client.get("/auth/me");
  setAuthMeta(data.username, data.role);
  return data;   // { username, role, expires_at }
}

export async function authLogout() {
  try { await client.post("/auth/logout"); } catch {}
  clearAuthToken();
  clearAuthMeta();
}

// ── Admin — Users ────────────────────────────────────────────────────────────
export async function adminListUsers() {
  const { data } = await client.get("/admin/users");
  return data; // { users: [] }
}
export async function adminCreateUser(payload) {
  const { data } = await client.post("/admin/users", payload);
  return data;
}
export async function adminUpdateUser(id, payload) {
  const { data } = await client.put(`/admin/users/${id}`, payload);
  return data;
}
export async function adminDeleteUser(id) {
  const { data } = await client.delete(`/admin/users/${id}`);
  return data;
}

// ── Admin — Logs ─────────────────────────────────────────────────────────────
export async function adminGetLogs({ limit = 100, offset = 0, username, action } = {}) {
  const params = { limit, offset };
  if (username) params.username = username;
  if (action)   params.action   = action;
  const { data } = await client.get("/admin/logs", { params });
  return data; // { logs: [], stats: {} }
}

// ── Admin — Sessions ──────────────────────────────────────────────────────────
export async function adminGetSessions({ limit = 100, offset = 0 } = {}) {
  const { data } = await client.get("/admin/sessions", { params: { limit, offset } });
  return data; // { sessions: [], stats: {} }
}

export async function checkDuplicates(excelFile) {
  const form = new FormData();
  form.append("excel_file", excelFile);
  const { data } = await client.post("/upload/check-duplicates", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data; // { total, duplicate_count, new_count, duplicates, skip_row_indices }
}

export async function uploadFiles(excelFile, zipFile, onProgress, skipRowIndices = null) {
  const form = new FormData();
  form.append("excel_file", excelFile);
  form.append("zip_file", zipFile);
  if (skipRowIndices && skipRowIndices.length > 0) {
    form.append("skip_row_indices", JSON.stringify(skipRowIndices));
  }

  const { data } = await client.post("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
    },
  });
  return data; // { session_id, status }
}

export async function pollStatus(sessionId) {
  const { data } = await client.get(`/status/${sessionId}`);
  return data;
}

export async function getResults(sessionId) {
  const { data } = await client.get(`/results/${sessionId}`);
  return data;
}

export function excelDownloadUrl(sessionId) {
  return `${BASE}/export/excel/${sessionId}`;
}

export async function exportToSheets(sessionId, sheetTitle) {
  const { data } = await client.post(`/export/sheets/${sessionId}`, {
    sheet_title: sheetTitle,
  });
  return data; // { spreadsheet_url, ... }
}

export async function deleteSession(sessionId) {
  await client.delete(`/session/${sessionId}`);
}

export async function lockSession(sessionId) {
  const { data } = await client.post(`/session/${sessionId}/lock`);
  return data; // { locked: true, session_id }
}

export async function unlockSession(sessionId) {
  const { data } = await client.post(`/session/${sessionId}/unlock`);
  return data; // { locked: false, session_id }
}

export async function editRow(sessionId, rowIndex, edits) {
  const { data } = await client.patch(`/session/${sessionId}/row/${rowIndex}`, edits);
  return data;
}

export async function getZohoAccounts(sessionId) {
  const { data } = await client.get(`/zoho/accounts/${sessionId}`);
  return data; // { accounts: [string] }
}

export async function exportToZoho(sessionId, rowOverrides) {
  const { data } = await client.post(`/export/zoho/${sessionId}`, {
    row_overrides: rowOverrides || null,
  });
  return data; // { pushed: [...], errors: [...], total, accounts }
}

export async function getZohoStatus(sessionId) {
  const { data } = await client.get(`/zoho/status/${sessionId}`);
  return data; // { metrics, vendors, bills, last_push }
}

export async function fixZohoVendorNumbers(sessionId) {
  const { data } = await client.post(`/zoho/fix-vendor-numbers/${sessionId}`);
  return data; // { updated: [...], skipped: [...], errors: [...] }
}

export async function zohoSyncSession(sessionId) {
  const { data } = await client.post(`/session/${sessionId}/zoho-sync`);
  return data; // { matched: [...], unmatched: [...], errors: [...], total: N }
}

export async function zohoSyncAll() {
  const { data } = await client.post("/zoho/sync-all");
  return data; // { updated, already_paid, no_change, errors, sessions_touched, details }
}

export async function revalidateSession(sessionId) {
  const { data } = await client.post(`/revalidate/${sessionId}`);
  return data; // { session_id, status: "reprocessing" }
}

// ── Keka Integration ─────────────────────────────────────────────────────────

export async function kekaSync(params) {
  const { data } = await client.post("/keka/sync", params);
  return data; // { session_id, status: "processing" }
}

export async function kekaConfig() {
  const { data } = await client.get("/keka/config");
  return data; // { configured, company, client_id_set, client_secret_set }
}

export async function kekaAction(sessionId, action, claimIds, reason, extras = {}) {
  const { data } = await client.post(`/keka/action/${sessionId}`, {
    action,
    claim_ids: claimIds,
    reason: reason || undefined,
    ...extras,         // { payment_mode, payment_date, reference_no } for mark_paid
  });
  return data; // { actioned, errors, action }
}

export async function kekaLoginStart() {
  const { data } = await client.post("/keka/login/start");
  return data; // { status: "ok" | "2fa_required" | "error", token?, message? }
}

export async function kekaLoginVerify(token, otp) {
  const { data } = await client.post("/keka/login/verify", { token, otp });
  return data; // { status: "ok" | "error", message? }
}

export async function kekaLoginCaptcha(token, captchaText) {
  const { data } = await client.post("/keka/login/captcha", { token, captcha_text: captchaText });
  return data; // { status: "2fa_required" | "captcha_required" | "ok" | "error", token?, captcha_b64?, message? }
}

export async function kekaLoginLogout() {
  const { data } = await client.post("/keka/login/logout");
  return data;
}

export async function kekaClearApproveEndpoint() {
  const { data } = await client.post("/keka/approve-endpoint/clear");
  return data;
}

// ── Postman-style direct fetch (Excel + Bulk Receipt download) ──────────────

export async function kekaPostmanInteractive(fromDate, toDate) {
  const { data } = await client.post("/keka/postman/interactive-download", {
    from_date: fromDate,
    to_date:   toDate,
  });
  return data; // { session_id, stage }
}

export async function kekaPostmanStatus(sessionId) {
  const { data } = await client.get(`/keka/postman/status/${sessionId}`);
  return data;
}

export async function kekaPostmanProcess(sessionId) {
  const { data } = await client.post(`/keka/postman/process/${sessionId}`);
  return data;
}

export function kekaPostmanDownloadUrl(sessionId, folderType) {
  return `${BASE}/keka/postman/download/${sessionId}/${folderType}`;
}

// ── Executive Overview ────────────────────────────────────────────────────────
export async function getOverviewStats() {
  const { data } = await client.get("/overview/stats");
  return data;
}

// ── Policy Rules ──────────────────────────────────────────────────────────────
export async function getPolicyRules() {
  const { data } = await client.get("/policy/rules");
  return data; // { rules: { category: { enabled, limit }, ... } }
}

export async function savePolicyRules(rules) {
  const { data } = await client.post("/policy/rules", { rules });
  return data;
}

// ── Session History ───────────────────────────────────────────────────────────
export async function getSessionsHistory() {
  const { data } = await client.get("/sessions/history");
  return data; // { sessions: [] }
}

// ── Global Search ─────────────────────────────────────────────────────────────
export async function searchClaims({ q, status, category, minAmount, maxAmount, fromDate, toDate, kekaOnly, zohoOnly, limit } = {}) {
  const params = {};
  if (q)          params.q          = q;
  if (status)     params.status     = status;
  if (category)   params.category   = category;
  if (minAmount)  params.min_amount = minAmount;
  if (maxAmount)  params.max_amount = maxAmount;
  if (fromDate)   params.from_date  = fromDate;
  if (toDate)     params.to_date    = toDate;
  if (kekaOnly)   params.keka_only  = true;
  if (zohoOnly)   params.zoho_only  = true;
  if (limit)      params.limit      = limit;
  const { data } = await client.get("/search/claims", { params });
  return data; // { results: [], total: N }
}

// ── Full-portfolio export (all batches) ──────────────────────────────────────
export async function exportAllExcel() {
  const token = getAuthToken();
  const BASE  = import.meta.env.VITE_API_URL ?? "/api";
  const resp  = await fetch(`${BASE}/report/export-all?fmt=excel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error("Export failed");
  const blob = await resp.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `expense_report_${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportAllPdf() {
  const token = getAuthToken();
  const BASE  = import.meta.env.VITE_API_URL ?? "/api";
  const resp  = await fetch(`${BASE}/report/export-all?fmt=pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error("Export failed");
  const html = await resp.text();
  const win  = window.open("", "_blank");
  if (win) { win.document.write(html); win.document.close(); }
}

export function reportExportUrl(month, status, source) {
  const BASE = import.meta.env.VITE_API_URL ?? "/api";
  const params = new URLSearchParams();
  if (month)  params.set("month",  month);
  if (status) params.set("status", status);
  if (source) params.set("source", source);
  return `${BASE}/report/export?${params}`;
}
