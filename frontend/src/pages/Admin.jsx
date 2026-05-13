import { useState, useEffect, useCallback } from "react";
import {
  adminListUsers, adminCreateUser, adminUpdateUser, adminDeleteUser,
  adminGetLogs, adminGetSessions, getAuthUser,
} from "../services/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function RoleBadge({ role }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${
      role === "admin"
        ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
        : "bg-slate-100 text-slate-600 dark:bg-gray-700 dark:text-gray-300"
    }`}>
      {role}
    </span>
  );
}

function ActionBadge({ action }) {
  const map = {
    login:          "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    login_failed:   "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    logout:         "bg-slate-100 text-slate-600 dark:bg-gray-700 dark:text-slate-300",
    create_user:    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    update_user:    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    delete_user:    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    keka_approve:   "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    keka_reject:    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    keka_mark_paid: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    upload:         "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
    keka_sync:      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    export_excel:   "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
    export_sheets:  "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    export_zoho:    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    row_edit:       "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    revalidate:     "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[action] || "bg-slate-100 text-slate-500 dark:bg-gray-700 dark:text-gray-400"}`}>
      {action.replace(/_/g, " ")}
    </span>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editUser,   setEditUser]   = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const currentUser = getAuthUser();

  const load = useCallback(async () => {
    try {
      setError("");
      const data = await adminListUsers();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load users");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(user) {
    try {
      await adminDeleteUser(user.id);
      setConfirmDel(null);
      load();
    } catch (e) {
      setError(e.response?.data?.detail || "Delete failed");
    }
  }

  if (loading) return <div className="py-16 text-center text-slate-400">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500 dark:text-gray-400">{users.length} user{users.length !== 1 ? "s" : ""}</p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white shadow-sm transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
          </svg>
          Add User
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 dark:bg-gray-800/60 text-left">
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">User</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Role</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden md:table-cell">Created</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden md:table-cell">Last Login</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {(u.full_name || u.username).charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                        {u.username}
                        {u.username === currentUser && (
                          <span className="text-[10px] text-purple-500 font-normal">(you)</span>
                        )}
                      </p>
                      {u.full_name && <p className="text-xs text-slate-400 dark:text-gray-500">{u.full_name}</p>}
                      {u.email    && <p className="text-xs text-slate-400 dark:text-gray-500">{u.email}</p>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3"><RoleBadge role={u.role}/></td>
                <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400 hidden md:table-cell">{fmtDate(u.created_at)}</td>
                <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400 hidden md:table-cell">{fmtDate(u.last_login)}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                    u.is_active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                : "bg-slate-100 text-slate-500 dark:bg-gray-700 dark:text-slate-400"
                  }`}>
                    {u.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      onClick={() => setEditUser(u)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
                      title="Edit"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                      </svg>
                    </button>
                    {u.username !== currentUser && (
                      <button
                        onClick={() => setConfirmDel(u)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title="Delete"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <UserFormModal
          title="Create New User"
          onClose={() => setShowCreate(false)}
          onSave={async (data) => { await adminCreateUser(data); setShowCreate(false); load(); }}
        />
      )}
      {editUser && (
        <UserFormModal
          title={`Edit — ${editUser.username}`}
          initial={editUser}
          onClose={() => setEditUser(null)}
          onSave={async (data) => { await adminUpdateUser(editUser.id, data); setEditUser(null); load(); }}
        />
      )}
      {confirmDel && (
        <Modal title="Delete User" onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
            Are you sure you want to delete <strong>{confirmDel.username}</strong>? This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setConfirmDel(null)} className="btn-secondary text-sm">Cancel</button>
            <button
              onClick={() => handleDelete(confirmDel)}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserFormModal({ title, initial, onClose, onSave }) {
  const [form, setForm]     = useState({
    username:  initial?.username  || "",
    password:  "",
    role:      initial?.role      || "reviewer",
    full_name: initial?.full_name || "",
    email:     initial?.email     || "",
    is_active: initial?.is_active ?? true,
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  function set(k, v) { setForm(p => ({ ...p, [k]: v })); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!initial && !form.username.trim()) { setError("Username is required"); return; }
    if (!initial && !form.password)        { setError("Password is required"); return; }
    setLoading(true); setError("");
    try {
      const payload = { ...form };
      if (!payload.password) delete payload.password;
      if (initial) delete payload.username;
      await onSave(payload);
    } catch (e) {
      setError(e.response?.data?.detail || "Save failed");
    }
    setLoading(false);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>
        )}

        {!initial && (
          <Field label="Username">
            <input value={form.username} onChange={e => set("username", e.target.value)} placeholder="john_doe" className="input-field" required/>
          </Field>
        )}

        <Field label={initial ? "New Password (leave blank to keep)" : "Password"}>
          <input type="password" value={form.password} onChange={e => set("password", e.target.value)}
            placeholder={initial ? "Leave blank to keep current" : "Min 6 characters"}
            className="input-field" required={!initial}/>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Full Name">
            <input value={form.full_name} onChange={e => set("full_name", e.target.value)} placeholder="John Doe" className="input-field"/>
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="john@example.com" className="input-field"/>
          </Field>
        </div>

        <Field label="Role">
          <select value={form.role} onChange={e => set("role", e.target.value)} className="input-field">
            <option value="reviewer">Reviewer</option>
            <option value="admin">Admin</option>
          </select>
        </Field>

        {initial && (
          <Field label="Status">
            <select value={form.is_active ? "1" : "0"} onChange={e => set("is_active", e.target.value === "1")} className="input-field">
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </select>
          </Field>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={loading}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white disabled:opacity-40 transition-all">
            {loading ? "Saving…" : initial ? "Save Changes" : "Create User"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

// ── Sessions Tab ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    completed:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    processing: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    error:      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[status] || "bg-slate-100 text-slate-500 dark:bg-gray-700 dark:text-gray-400"}`}>
      {status}
    </span>
  );
}

function SourceBadge({ source }) {
  const map = {
    upload:    "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
    keka_sync: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[source] || "bg-slate-100 text-slate-500"}`}>
      {source === "keka_sync" ? "Keka Sync" : "Upload"}
    </span>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState([]);
  const [stats,    setStats]    = useState({});
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [page,     setPage]     = useState(0);
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await adminGetSessions({ limit: PAGE, offset: page * PAGE });
      setSessions(res.sessions || []);
      setStats(res.stats || {});
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load sessions");
    } finally { setLoading(false); }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: "Total Sessions",  value: stats.total ?? "—" },
          { label: "Completed",       value: stats.completed ?? "—" },
          { label: "Last 24 Hours",   value: stats.last_24h ?? "—" },
        ].map(s => (
          <div key={s.label} className="card p-4 text-center">
            <p className="text-2xl font-black text-slate-800 dark:text-slate-100">{s.value}</p>
            <p className="text-xs text-slate-500 dark:text-gray-400 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex justify-end mb-3">
        <button onClick={load} className="btn-secondary text-sm px-3">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}

      {loading ? (
        <div className="py-16 text-center text-slate-400">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-gray-800/60 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Session</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">User</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Source</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden md:table-cell">Claims</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden lg:table-cell">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
              {sessions.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400 dark:text-gray-500">No sessions found</td></tr>
              ) : sessions.map(s => (
                <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs text-slate-500 dark:text-gray-400">{s.id.slice(0, 8)}…</p>
                    <p className="text-xs text-slate-400 dark:text-gray-500 truncate max-w-[160px]" title={s.filename}>{s.filename}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                        {(s.username || "?").charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-slate-700 dark:text-slate-200">{s.username || "anonymous"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><SourceBadge source={s.source}/></td>
                  <td className="px-4 py-3"><StatusBadge status={s.status}/></td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {s.total_claims > 0 ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-700 dark:text-slate-200 font-semibold">{s.total_claims}</span>
                        <span className="text-emerald-600 dark:text-emerald-400">✓{s.approved}</span>
                        <span className="text-red-500 dark:text-red-400">✗{s.rejected}</span>
                        <span className="text-amber-500 dark:text-amber-400">⚑{s.flagged}</span>
                      </div>
                    ) : <span className="text-slate-300 dark:text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400 font-mono hidden lg:table-cell">{fmtDate(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-slate-400">{sessions.length} entries (page {page + 1})</p>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="btn-secondary text-xs disabled:opacity-30">← Prev</button>
          <button onClick={() => setPage(p => p + 1)} disabled={sessions.length < PAGE} className="btn-secondary text-xs disabled:opacity-30">Next →</button>
        </div>
      </div>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

const ACTION_OPTIONS = [
  "login", "login_failed", "logout",
  "create_user", "update_user", "delete_user",
  "upload", "keka_sync", "revalidate",
  "export_excel", "export_sheets", "export_zoho",
  "row_edit",
  "keka_approve", "keka_reject", "keka_mark_paid",
];

function LogsTab() {
  const [logs,    setLogs]    = useState([]);
  const [stats,   setStats]   = useState({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [filter,  setFilter]  = useState({ username: "", action: "" });
  const [page,    setPage]    = useState(0);
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await adminGetLogs({
        limit: PAGE, offset: page * PAGE,
        username: filter.username || undefined,
        action:   filter.action   || undefined,
      });
      setLogs(res.logs);
      setStats(res.stats || {});
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load logs");
    } finally { setLoading(false); }
  }, [page, filter]);

  useEffect(() => { load(); }, [load]);

  function applyFilter(f) { setFilter(f); setPage(0); }

  return (
    <div>
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: "Total Actions", value: stats.total ?? "—" },
          { label: "Unique Users",  value: stats.unique_users ?? "—" },
          { label: "Last 24 Hours", value: stats.last_24h ?? "—" },
        ].map(s => (
          <div key={s.label} className="card p-4 text-center">
            <p className="text-2xl font-black text-slate-800 dark:text-slate-100">{s.value}</p>
            <p className="text-xs text-slate-500 dark:text-gray-400 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          value={filter.username}
          onChange={e => applyFilter({ ...filter, username: e.target.value })}
          placeholder="Filter by username…"
          className="input-field flex-1 min-w-[160px] max-w-xs"
        />
        <select
          value={filter.action}
          onChange={e => applyFilter({ ...filter, action: e.target.value })}
          className="input-field min-w-[180px]"
        >
          <option value="">All Actions</option>
          {ACTION_OPTIONS.map(a => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
        </select>
        <button onClick={load} className="btn-secondary text-sm px-3">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}

      {loading ? (
        <div className="py-16 text-center text-slate-400">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-gray-800/60 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Time</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">User</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">Action</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden md:table-cell">Entity</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden lg:table-cell">Details</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide hidden lg:table-cell">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-400 dark:text-gray-500">No activity logs found</td>
                </tr>
              ) : logs.map(log => (
                <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400 whitespace-nowrap font-mono">{fmtDate(log.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                        {log.username.charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-slate-700 dark:text-slate-200">{log.username}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><ActionBadge action={log.action}/></td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-gray-400 hidden md:table-cell">
                    {log.entity_type && <span className="font-medium">{log.entity_type}: </span>}
                    <span className="font-mono">{log.entity_id || "—"}</span>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {log.details && Object.keys(log.details).length > 0 ? (
                      <code className="text-[11px] text-slate-500 dark:text-gray-400 bg-slate-50 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                        {JSON.stringify(log.details).slice(0, 60)}{JSON.stringify(log.details).length > 60 ? "…" : ""}
                      </code>
                    ) : <span className="text-slate-300 dark:text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 dark:text-gray-500 font-mono hidden lg:table-cell">{log.ip_address || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-slate-400">{logs.length} entries (page {page + 1})</p>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="btn-secondary text-xs disabled:opacity-30">← Prev</button>
          <button onClick={() => setPage(p => p + 1)} disabled={logs.length < PAGE}
            className="btn-secondary text-xs disabled:opacity-30">Next →</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin Page ───────────────────────────────────────────────────────────

const TABS = [
  { id: "users",    label: "👥 Users"         },
  { id: "sessions", label: "📁 Sessions"      },
  { id: "logs",     label: "📋 Activity Logs" },
];

export default function AdminPage() {
  const [tab, setTab] = useState("users");

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <span className="text-2xl">🛡️</span> Admin Panel
        </h2>
        <p className="text-sm text-slate-400 dark:text-gray-500 mt-0.5">
          Manage users, roles, and view activity logs
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 dark:border-gray-700 mb-6">
        <nav className="-mb-px flex gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                tab === t.id
                  ? "border-purple-500 text-purple-600 dark:text-purple-300 dark:border-purple-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300 dark:text-gray-400 dark:hover:text-slate-200"
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="card p-5">
        {tab === "users"    && <UsersTab/>}
        {tab === "sessions" && <SessionsTab/>}
        {tab === "logs"     && <LogsTab/>}
      </div>
    </div>
  );
}
