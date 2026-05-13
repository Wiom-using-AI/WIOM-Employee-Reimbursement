import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authLogout } from "../services/api";

export default function Navbar({ dark, onToggleDark, username, role }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin  = role === "admin";
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleLogout() {
    await authLogout();
    navigate("/login", { replace: true });
  }

  const path = location.pathname;

  const navItems = [
    { to: "/overview", label: "Overview",  icon: <ChartIcon />,   always: true },
    { to: "/search",   label: "Search",    icon: <SearchIcon />,  always: true },
    { to: "/history",  label: "History",   icon: <HistoryIcon />, always: true },
    { to: "/keka",     label: "Keka",      icon: <LinkIcon />,    always: true },
    { to: "/logs",     label: "Logs",      icon: <LogIcon />,     admin: true  },
    { to: "/config",   label: "Config",    icon: <ConfigIcon />,  admin: true  },
    { to: "/admin",    label: "Admin",     icon: <ShieldIcon />,  admin: true  },
  ].filter(item => item.always || (item.admin && isAdmin));

  function isActive(to) {
    if (to === "/overview") return path === "/overview";
    if (to === "/")         return path === "/" || path === "";
    return path.startsWith(to);
  }

  return (
    <>
      <header
        className="sticky top-0 z-40 w-full backdrop-blur-xl"
        style={{
          background: "color-mix(in srgb, var(--bg-card) 88%, transparent)",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
          boxShadow: "0 1px 0 rgba(255,255,255,0.45), 0 10px 32px rgba(15,23,42,0.08)",
        }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-[68px] flex items-center gap-4">

          {/* ── Logo ── */}
          <Link to="/" className="flex items-center gap-3 shrink-0 group mr-2">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center transition-all group-hover:scale-105"
                 style={{ background: "linear-gradient(135deg,#ff72c2,#e5007d 52%,#a9005a)", boxShadow: "0 12px 28px rgba(229,0,125,0.28), inset 0 1px 0 rgba(255,255,255,0.26)" }}>
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
              </svg>
            </div>
            <div className="hidden sm:block">
              <p className="text-[15px] font-black leading-none" style={{ color: "var(--text-main)" }}>Expense Validator</p>
              <p className="text-[10px] font-bold tracking-[0.2em] uppercase leading-none mt-1" style={{ color: "#e5007d" }}>Wiom Finance</p>
            </div>
          </Link>

          {/* ── Divider ── */}
          <div className="hidden md:block w-px h-5 shrink-0" style={{ background: "var(--border)" }} />

          {/* ── Nav items (desktop) ── */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            {/* Upload/New — always first */}
            <NavItem to="/" label="New Batch" icon={<UploadIcon />} active={path === "/"} />

            {navItems.map(item => (
              <NavItem key={item.to} to={item.to} label={item.label} icon={item.icon} active={isActive(item.to)} />
            ))}
          </nav>

          {/* ── Right side ── */}
          <div className="flex items-center gap-2 ml-auto">

            {/* User badge */}
            {username && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold"
                   style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", color: "var(--text-sub)" }}>
                <span className={`w-2 h-2 rounded-full ${isAdmin ? "bg-pink-500" : "bg-emerald-500"}`}
                      style={{ boxShadow: isAdmin ? "0 0 6px #e5007d" : "0 0 6px #10b981" }} />
                <span style={{ color: "var(--text-main)" }}>{username}</span>
                {isAdmin && (
                  <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                        style={{ background: "rgba(229,0,125,0.1)", color: "#e5007d" }}>Admin</span>
                )}
              </div>
            )}

            {/* Dark mode toggle */}
            <button
              onClick={onToggleDark}
              aria-label="Toggle dark mode"
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all hover:scale-105"
              style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
            >
              {dark ? (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" style={{ color: "#fbbf24" }}>
                  <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              )}
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              title="Sign out"
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)", background: "var(--bg-card)" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.color="var(--text-muted)"; }}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span className="hidden lg:inline">Logout</span>
            </button>

            {/* Mobile menu button */}
            <button
              onClick={() => setMobileOpen(v => !v)}
              className="md:hidden w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", color: "var(--text-sub)" }}
            >
              {mobileOpen ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile nav drawer ── */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-30 flex"
             onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }} />
          <div className="relative ml-auto w-72 h-full flex flex-col py-6 px-4 animate-slide-up"
               style={{ background: "var(--bg-card)", borderLeft: "1px solid var(--border)" }}
               onClick={e => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-widest mb-4 px-2" style={{ color: "var(--text-muted)" }}>Navigation</p>
            <div className="space-y-1">
              <MobileNavItem to="/" label="New Batch" icon={<UploadIcon />} active={path === "/"} onClick={() => setMobileOpen(false)} />
              {navItems.map(item => (
                <MobileNavItem key={item.to} to={item.to} label={item.label} icon={item.icon}
                  active={isActive(item.to)} onClick={() => setMobileOpen(false)} />
              ))}
            </div>
            <div className="mt-auto pt-4 border-t" style={{ borderColor: "var(--border)" }}>
              {username && (
                <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-xl text-sm"
                     style={{ background: "var(--bg-card2)", border: "1px solid var(--border)" }}>
                  <span className={`w-2 h-2 rounded-full ${isAdmin ? "bg-pink-500" : "bg-emerald-500"}`} />
                  <span style={{ color: "var(--text-main)" }}>{username}</span>
                  {isAdmin && <span className="text-xs font-bold" style={{ color: "#e5007d" }}>· Admin</span>}
                </div>
              )}
              <button onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                style={{ color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.05)" }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function NavItem({ to, label, icon, active }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150"
      style={active ? {
        background: "linear-gradient(135deg,rgba(255,95,186,0.16),rgba(229,0,125,0.12))",
        color: "#e5007d",
        border: "1px solid rgba(229,0,125,0.24)",
        boxShadow: "0 6px 18px rgba(229,0,125,0.08)",
      } : {
        color: "var(--text-sub)",
        border: "1px solid transparent",
      }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.color="#e5007d"; e.currentTarget.style.background="rgba(229,0,125,0.06)"; e.currentTarget.style.borderColor="rgba(229,0,125,0.14)"; }}}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.color="var(--text-sub)"; e.currentTarget.style.background="transparent"; e.currentTarget.style.borderColor="transparent"; }}}
    >
      <span className="w-3.5 h-3.5 shrink-0">{icon}</span>
      {label}
    </Link>
  );
}

function MobileNavItem({ to, label, icon, active, onClick }) {
  return (
    <Link to={to} onClick={onClick}
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
      style={active ? {
        background: "linear-gradient(135deg,rgba(255,77,184,0.12),rgba(229,0,125,0.12))",
        color: "#e5007d",
        border: "1px solid rgba(229,0,125,0.2)",
      } : {
        color: "var(--text-sub)",
        border: "1px solid transparent",
      }}>
      <span className="w-4 h-4 shrink-0">{icon}</span>
      {label}
    </Link>
  );
}

/* ── Icons ── */
function UploadIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
  </svg>;
}
function ChartIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
  </svg>;
}
function SearchIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
  </svg>;
}
function HistoryIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>;
}
function LinkIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
  </svg>;
}
function LogIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/>
  </svg>;
}
function ConfigIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
  </svg>;
}
function ShieldIcon() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
  </svg>;
}
