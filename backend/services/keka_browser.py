"""
Keka attachment downloader via browser session.

Login flow:
  1. Navigate to omniainformation.keka.com → redirects to app.keka.com/Account/Login
  2. Click "Continue with Password"
  3. Solve image captcha using RapidOCR (retries up to 3 times)
  4. Submit email + password + captcha
  5. 2FA page: click "Send code to email"
  6. Store the 2FA session state (cookies) and return it
  7. Caller supplies the OTP from email
  8. Submit OTP → authenticated session cookies captured

Uses playwright.sync_api to avoid asyncio event-loop conflicts on Windows.

Env vars (in .env):
    KEKA_EMAIL        - Login email (e.g. Tushar.gupta@wiom.in)
    KEKA_PASSWORD     - Login password
    KEKA_COMPANY_NAME - Keka subdomain (default: omniainformation)
"""

import os
import sys
import json
import time
import asyncio
import logging
import secrets
from typing import Optional

log = logging.getLogger(__name__)

# ── Windows fix: Playwright's sync API launches the browser as a subprocess.
# On Windows, FastAPI sync-endpoint threads already have a SelectorEventLoop
# assigned, which does NOT support subprocess creation.  Setting the global
# policy here doesn't help those existing threads.
# Instead we call _ensure_proactor_loop() inside each Playwright function to
# replace the thread's loop with a ProactorEventLoop right before Playwright runs.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())


def _ensure_proactor_loop():
    """
    Guarantee the calling thread uses WindowsProactorEventLoopPolicy + ProactorEventLoop.

    Uvicorn sets WindowsSelectorEventLoopPolicy globally on Windows, which means
    asyncio.new_event_loop() (called inside Playwright's sync_playwright().__enter__)
    also returns a SelectorEventLoop — causing Playwright's PipeTransport subprocess
    launch to fail with the cryptic '_playwright' AttributeError.

    Fixing the policy in this thread (before sync_playwright() is called) ensures
    Playwright's internal new_event_loop() returns a ProactorEventLoop.
    """
    if sys.platform != "win32":
        return
    try:
        # Reset policy so Playwright's internal asyncio.new_event_loop() returns ProactorEventLoop
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        try:
            loop = asyncio.get_event_loop()
            if isinstance(loop, asyncio.ProactorEventLoop):
                return
        except RuntimeError:
            pass
        loop = asyncio.ProactorEventLoop()
        asyncio.set_event_loop(loop)
        log.debug("_ensure_proactor_loop: set ProactorEventLoop in thread %s",
                  __import__("threading").current_thread().name)
    except Exception as exc:
        log.warning("_ensure_proactor_loop: could not set ProactorEventLoop: %s", exc)

KEKA_EMAIL        = os.environ.get("KEKA_EMAIL", "")
KEKA_PASSWORD     = os.environ.get("KEKA_PASSWORD", "")
KEKA_COMPANY_NAME = os.environ.get("KEKA_COMPANY_NAME", "omniainformation")

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Browser launch args to bypass bot detection (urlaccessvalidator.js etc.)
# Memory-saving flags for Railway Trial (512MB RAM) to prevent OOM kills
_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--disable-setuid-sandbox",
    "--disable-accelerated-2d-canvas",
    "--renderer-process-limit=1",
    "--disable-extensions",
    "--disable-plugins",
    "--disable-software-rasterizer",
    "--single-process",
]

# Init script injected into every page to hide Playwright automation signals
_STEALTH_SCRIPT = """
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
    window.chrome = {runtime: {}, loadTimes: () => {}, csi: () => {}, app: {}};
    Object.defineProperty(navigator, 'permissions', {
        get: () => ({query: () => Promise.resolve({state: 'granted'})})
    });
"""

# Session TTL: 24 hours
_SESSION_TTL = 24 * 3600

# File path to persist session across restarts
_SESSION_FILE = os.path.join(os.path.dirname(__file__), "..", ".keka_session.json")

# In-memory cache (loaded from disk on first access)
_session_cache: dict = {}
_session_loaded = False

# Holds pending 2FA state waiting for OTP { token → {"cookies": [...], "expires_at": float, "company": str} }
_pending_2fa: dict = {}

# Holds pending captcha state: auto-OCR failed, waiting for user to solve manually
_pending_captcha: dict = {}  # token → {email, pwd, company, captcha_b64, expires_at}


def _load_session_from_disk():
    """Load persisted session from disk into memory (called once at startup)."""
    global _session_loaded
    if _session_loaded:
        return
    _session_loaded = True
    try:
        path = os.path.abspath(_SESSION_FILE)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            now = time.time()
            for co, entry in data.items():
                if entry.get("expires_at", 0) > now:
                    _session_cache[co] = entry
                    log.info("Keka session loaded from disk for %s (expires in %.1fh)",
                             co, (entry["expires_at"] - now) / 3600)
    except Exception as e:
        log.warning("Could not load Keka session from disk: %s", e)


def _save_session_to_disk():
    """Persist current in-memory session cache to disk."""
    try:
        path = os.path.abspath(_SESSION_FILE)
        # Only save non-expired entries
        now = time.time()
        data = {co: entry for co, entry in _session_cache.items()
                if entry.get("expires_at", 0) > now}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning("Could not save Keka session to disk: %s", e)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _solve_captcha(b64: str) -> str:
    """
    Try multiple preprocessing + Tesseract strategies.
    Returns best candidate (5-8 alphanumeric chars) or "" if all fail.
    """
    import base64, io
    from PIL import Image, ImageFilter, ImageOps, ImageEnhance
    try:
        import pytesseract
    except ImportError:
        log.warning("pytesseract not available")
        return ""

    WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

    try:
        img_bytes = base64.b64decode(b64)
        original = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        log.warning("Captcha decode failed: %s", e)
        return ""

    def _ocr(img, psm):
        try:
            text = pytesseract.image_to_string(
                img,
                config=f"--psm {psm} -c tessedit_char_whitelist={WHITELIST}",
            ).strip().replace(" ", "").replace("\n", "")
            return "".join(c for c in text if c.isalnum())
        except Exception:
            return ""

    candidates = []
    for scale in (3, 4, 2):
        w, h = original.size
        big  = original.resize((w * scale, h * scale), Image.LANCZOS)
        gray = big.convert("L")

        for psm in (8, 6, 7, 13):
            for img in (big, gray):
                t = _ocr(img, psm)
                if 4 <= len(t) <= 8:
                    candidates.append(t)

            # Binarize with mean threshold
            try:
                threshold = sum(gray.getdata()) // len(gray.getdata())
                binary = gray.point(lambda x: 255 if x > threshold else 0, "1")
                t = _ocr(binary, psm)
                if 4 <= len(t) <= 8:
                    candidates.append(t)
            except Exception:
                pass

            # Sharpen + OCR
            sharp = big.filter(ImageFilter.SHARPEN).filter(ImageFilter.SHARPEN)
            t = _ocr(sharp, psm)
            if 4 <= len(t) <= 8:
                candidates.append(t)

            # Boost contrast + OCR
            enhanced = ImageEnhance.Contrast(big).enhance(2.5)
            t = _ocr(enhanced, psm)
            if 4 <= len(t) <= 8:
                candidates.append(t)

    if candidates:
        from collections import Counter
        best, votes = Counter(candidates).most_common(1)[0]
        log.info("Captcha solved (%d candidates, top=%d votes): %s", len(candidates), votes, best)
        return best

    log.warning("All OCR strategies failed for captcha")
    return ""


def _do_captcha_login(page, email: str, pwd: str):
    """
    Fill and submit the KekaLogin form (email + password + captcha).
    Returns (True, None) if 2FA page was reached.
    Returns (False, last_captcha_b64) if all 3 OCR attempts failed — caller
    can return this captcha image to the user for manual solving.
    """
    last_captcha_b64 = None

    for attempt in range(1, 4):
        # Grab captcha image base64
        captcha_b64 = None
        for img in page.query_selector_all("img"):
            src = img.get_attribute("src") or ""
            if src.startswith("data:image/png;base64,"):
                captcha_b64 = src.split(",", 1)[1]
                break

        if not captcha_b64:
            log.warning("Captcha image not found on attempt %d", attempt)
            page.wait_for_timeout(1000)
            continue

        last_captcha_b64 = captcha_b64  # keep last seen captcha for fallback

        captcha_text = _solve_captcha(captcha_b64)
        if not captcha_text:
            log.warning("OCR returned empty captcha on attempt %d", attempt)
            page.wait_for_timeout(1000)
            try:
                for img in page.query_selector_all("img"):
                    src = img.get_attribute("src") or ""
                    if src.startswith("data:image/png;base64,"):
                        img.click()
                        page.wait_for_timeout(1000)
                        break
            except Exception:
                pass
            continue

        try:
            email_el = page.query_selector('input[name="Email"]')
            if email_el:
                if email_el.is_visible():
                    email_el.fill(email)
                else:
                    page.evaluate(
                        "(v) => { const el = document.querySelector('input[name=\"Email\"]'); if(el) el.value = v; }",
                        email,
                    )

            pwd_el = page.query_selector('input[name="Password"]')
            if pwd_el:
                if pwd_el.is_visible():
                    pwd_el.fill(pwd)
                else:
                    page.evaluate(
                        "(v) => { const el = document.querySelector('input[name=\"Password\"]'); if(el) el.value = v; }",
                        pwd,
                    )

            log.info("Filling captcha (attempt %d): '%s'", attempt, captcha_text)
            page.fill('input[name="captcha"]', captcha_text, timeout=5000)
        except Exception as e:
            log.warning("Form fill error on attempt %d: %s", attempt, e)
            continue

        try:
            page.click('button:has-text("Login"), input[type="submit"][value="Login"]')
        except Exception as e:
            log.warning("Submit click failed on attempt %d: %s", attempt, e)
            continue

        page.wait_for_timeout(3000)
        cur_url = page.url
        log.info("After login submit (attempt %d): %s", attempt, cur_url[:80])

        if "SendCode" in cur_url or "VerifyCode" in cur_url:
            log.info("Reached 2FA page on attempt %d", attempt)
            return True, None

        if "KekaLogin" in cur_url:
            log.warning("Still on login page after attempt %d — retrying captcha", attempt)
            # Grab fresh captcha after wrong submit
            try:
                for img in page.query_selector_all("img"):
                    src = img.get_attribute("src") or ""
                    if src.startswith("data:image/png;base64,"):
                        last_captcha_b64 = src.split(",", 1)[1]
                        img.click()
                        page.wait_for_timeout(800)
                        break
            except Exception:
                pass
            continue

        log.info("Unexpected redirect to %s — treating as success", cur_url[:80])
        return True, None

    log.error("Login failed after 3 captcha attempts — returning captcha for manual solve")
    return False, last_captcha_b64


def _login_and_get_session_internal(
    company: str,
    email: str,
    pwd: str,
    otp: Optional[str] = None,
    pending_cookies: Optional[list] = None,
    verify_url: Optional[str] = None,
) -> dict:
    """
    Core login using playwright.sync_api (safe in any thread on Windows).

    Returns:
      {"status": "ok",           "cookies": [...]}
      {"status": "2fa_required", "pending_cookies": [...], "verify_url": str, "message": str}
      {"status": "error",        "message": str}
    """
    _ensure_proactor_loop()          # must be before any sync_playwright() call
    from playwright.sync_api import sync_playwright

    base_url = f"https://{company}.keka.com"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=_LAUNCH_ARGS)
        ctx = browser.new_context(user_agent=_UA)
        ctx.add_init_script(_STEALTH_SCRIPT)
        page = ctx.new_page()

        # ── RESUME PATH: inject saved 2FA cookies and submit OTP ──
        if otp and pending_cookies:
            log.info("Keka login: resuming 2FA OTP verification")
            ctx.add_cookies(pending_cookies)

            # ── Intercept network requests to capture the SPA Bearer token ──────
            # The Angular SPA calls Keka APIs with Authorization: Bearer <token>.
            # We capture the first one so we can store it alongside the cookies.
            _captured_bearer: list[str] = []
            def _on_login_request(req):
                auth = req.headers.get("authorization", "")
                if auth.lower().startswith("bearer ") and len(auth) > 50:
                    tok = auth.split(" ", 1)[1]
                    if tok not in _captured_bearer:
                        _captured_bearer.append(tok)
                        log.info("Login: captured SPA Bearer token (%d chars) from %s",
                                 len(tok), req.url[:60])
            ctx.on("request", _on_login_request)

            target_url = verify_url or "https://app.keka.com/Account/VerifyCode"
            try:
                page.goto(target_url, wait_until="networkidle", timeout=20000)
            except Exception as e:
                log.warning("Goto verify_url failed: %s", e)
            page.wait_for_timeout(1000)
            log.info("OTP verify page URL: %s", page.url[:80])

            otp_filled = False
            for sel in [
                'input[name="Code"]',
                'input[name="code"]',
                'input[placeholder*="code" i]',
                'input[placeholder*="OTP" i]',
                'input[type="text"]',
                'input[type="number"]',
            ]:
                try:
                    inp = page.query_selector(sel)
                    if inp and inp.is_visible():
                        inp.fill(otp)
                        otp_filled = True
                        log.info("Filled OTP into selector: %s", sel)
                        break
                except Exception:
                    pass

            if not otp_filled:
                log.warning("Could not find OTP input — body: %s", page.inner_text("body")[:300])
                browser.close()
                return {"status": "error", "message": "OTP input field not found on verify page"}

            try:
                page.click(
                    'button[type="submit"], input[type="submit"], button:has-text("Verify")',
                    timeout=6000,
                )
            except Exception as e:
                log.warning("OTP submit click failed: %s", e)

            page.wait_for_timeout(4000)
            log.info("After OTP submit: %s", page.url[:80])

            body_text = page.inner_text("body")
            if any(x in body_text.lower() for x in ("invalid", "expired", "incorrect", "wrong")):
                browser.close()
                return {"status": "error", "message": f"OTP rejected: {body_text[:150]}"}

            try:
                page.wait_for_url(f"https://{company}.keka.com/**", timeout=25000)
            except Exception:
                pass

            # Wait for Angular SPA to fully initialize
            # networkidle = no requests for 500ms → Angular has made all init API calls
            try:
                page.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(4000)
            log.info("After OTP + Angular init: %s", page.url[:80])

            # ── Navigate to the expense section to trigger all Angular API calls ──
            # This forces the SPA to exchange tokens and store them, giving us a
            # chance to capture the Bearer token via our request interceptor.
            try:
                page.goto(
                    f"https://{company}.keka.com/#/org/expense/approveclaims",
                    wait_until="networkidle", timeout=25000,
                )
            except Exception as nav_e:
                log.debug("Expense navigation error (non-fatal): %s", nav_e)
            page.wait_for_timeout(4000)
            log.info("After expense navigation: %s — captured %d Bearer tokens so far",
                     page.url[:80], len(_captured_bearer))

            # ── Also check sessionStorage (Angular IDX sometimes stores token there) ──
            session_storage_items: dict = {}
            try:
                session_storage_items = page.evaluate("""() => {
                    const out = {};
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const k = sessionStorage.key(i);
                        out[k] = sessionStorage.getItem(k);
                    }
                    return out;
                }""") or {}
                if session_storage_items:
                    log.info("sessionStorage keys after login: %s",
                             list(session_storage_items.keys()))
            except Exception as sse:
                log.debug("Could not read sessionStorage: %s", sse)

            # ── Capture full storage state: cookies + localStorage ────────────────
            storage = ctx.storage_state()

            # ── Merge sessionStorage + captured Bearer tokens into storage_state ──
            # This ensures get_spa_access_token() finds the token even if Keka stores
            # it in sessionStorage or only as a Bearer token on the wire.
            extra_ls: dict = {}
            for k, v in session_storage_items.items():
                if v and isinstance(v, str) and len(v) > 20:
                    extra_ls[k] = v
            if _captured_bearer:
                extra_ls.setdefault("access_token", _captured_bearer[-1])
                log.info("Storing captured Bearer token (%d chars) as access_token in localStorage",
                         len(_captured_bearer[-1]))

            if extra_ls:
                target_origin = f"https://{company}.keka.com"
                # Try to update the existing origin entry first
                origin_updated = False
                for orig in (storage.get("origins") or []):
                    if target_origin in orig.get("origin", ""):
                        existing = {i["name"]: i["value"]
                                    for i in (orig.get("localStorage") or [])}
                        existing.update(extra_ls)
                        orig["localStorage"] = [{"name": k, "value": v}
                                                for k, v in existing.items()]
                        origin_updated = True
                        break
                if not origin_updated:
                    storage.setdefault("origins", []).append({
                        "origin":       target_origin,
                        "localStorage": [{"name": k, "value": v}
                                         for k, v in extra_ls.items()],
                    })
                log.info("Merged %d extra items into storage_state for %s",
                         len(extra_ls), target_origin)

            browser.close()

            keka_cookies = [
                c for c in storage.get("cookies", [])
                if company in c.get("domain", "") or "keka.com" in c.get("domain", "")
            ]
            if not keka_cookies and not storage.get("origins"):
                return {"status": "error", "message": "No Keka session data after OTP — login may have failed"}

            log.info("Keka OTP verified: %d cookies, %d origins, Bearer token=%s",
                     len(keka_cookies), len(storage.get("origins", [])),
                     "captured" if _captured_bearer else "NOT captured")
            return {"status": "ok", "cookies": keka_cookies, "storage_state": storage}

        # ── FRESH PATH: start from scratch ──
        log.info("Keka login: starting fresh login for %s.keka.com", company)
        try:
            page.goto(base_url + "/", wait_until="networkidle", timeout=30000)
        except Exception as e:
            log.warning("Initial navigation error: %s", e)
        page.wait_for_timeout(1000)

        if "KekaLogin" not in page.url:
            try:
                btn = page.wait_for_selector(
                    'button:has-text("Continue with Password"), a:has-text("Continue with Password")',
                    timeout=8000,
                )
                btn.click()
                page.wait_for_timeout(2000)
            except Exception as e:
                log.warning("Method selector not found (%s) — navigating directly to KekaLogin", e)
                try:
                    page.goto(
                        "https://app.keka.com/Account/KekaLogin?returnUrl=%2F",
                        wait_until="networkidle",
                        timeout=15000,
                    )
                except Exception:
                    pass
                page.wait_for_timeout(1000)

        log.info("On KekaLogin page: %s", page.url[:80])

        reached_2fa, captcha_b64 = _do_captcha_login(page, email, pwd)
        if not reached_2fa:
            browser.close()
            if captcha_b64:
                return {"status": "captcha_required", "captcha_b64": captcha_b64}
            return {
                "status": "error",
                "message": "Login failed after 3 captcha attempts. Check KEKA_EMAIL and KEKA_PASSWORD in .env.",
            }

        cookies_at_2fa = ctx.cookies()
        two_factor_cookie = next((c for c in cookies_at_2fa if "TwoFactor" in c["name"]), None)

        if not two_factor_cookie:
            if company in page.url or "/home" in page.url:
                keka_cookies = [c for c in cookies_at_2fa if "keka.com" in c.get("domain", "")]
                browser.close()
                log.info("Login succeeded without 2FA — %d cookies", len(keka_cookies))
                return {"status": "ok", "cookies": keka_cookies}
            browser.close()
            return {"status": "error", "message": "2FA page reached but no TwoFactorUserId cookie found"}

        log.info("2FA page reached — sending OTP to email")
        otp_verify_url = None
        try:
            page.click('button:has-text("Send code to email")', timeout=8000)
            page.wait_for_timeout(3000)
            otp_verify_url = page.url
            log.info("OTP sent to email. VerifyCode URL: %s", otp_verify_url[:100])
        except Exception as e:
            log.warning("Could not click 'Send code to email': %s — trying mobile", e)
            try:
                page.click('button:has-text("Send code to mobile")', timeout=5000)
                page.wait_for_timeout(3000)
                otp_verify_url = page.url
                log.info("OTP sent to mobile. VerifyCode URL: %s", otp_verify_url[:100])
            except Exception:
                pass

        pending = ctx.cookies()
        browser.close()

        return {
            "status": "2fa_required",
            "pending_cookies": pending,
            "verify_url": otp_verify_url,
            "message": "OTP sent to email. Enter the code to complete login.",
        }


# ---------------------------------------------------------------------------
# Public session management  (all sync — safe to call from ThreadPoolExecutor)
# ---------------------------------------------------------------------------

def _make_captcha_token(company: str, captcha_b64: str) -> dict:
    token = secrets.token_urlsafe(16)
    _pending_captcha[token] = {
        "email":       KEKA_EMAIL,
        "pwd":         KEKA_PASSWORD,
        "company":     company,
        "captcha_b64": captcha_b64,
        "expires_at":  time.time() + 300,  # 5-minute window
    }
    return {
        "status":      "captcha_required",
        "captcha_b64": captcha_b64,
        "token":       token,
        "message":     "Auto-solve failed. Please type the captcha text shown in the image.",
    }


def _submit_manual_captcha_internal(token: str, captcha_text: str) -> dict:
    """
    User has read the captcha image and provided the text.
    Opens a fresh browser, navigates to KekaLogin, and submits with the user-provided text.
    Returns 2fa_required on correct captcha, captcha_required (with new image) on wrong captcha.
    """
    pending = _pending_captcha.get(token)
    if not pending:
        return {"status": "error", "message": "Captcha session expired. Please start login again."}
    if pending["expires_at"] < time.time():
        _pending_captcha.pop(token, None)
        return {"status": "error", "message": "Captcha session expired (5-min window). Please start login again."}

    co    = pending["company"]
    email = pending["email"]
    pwd   = pending["pwd"]

    _ensure_proactor_loop()
    from playwright.sync_api import sync_playwright

    base_url = f"https://{co}.keka.com"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=_LAUNCH_ARGS)
        ctx     = browser.new_context(user_agent=_UA)
        ctx.add_init_script(_STEALTH_SCRIPT)
        page    = ctx.new_page()

        try:
            page.goto(base_url + "/", wait_until="networkidle", timeout=30000)
        except Exception as e:
            log.warning("Navigation error (manual captcha): %s", e)
        page.wait_for_timeout(1000)

        if "KekaLogin" not in page.url:
            try:
                btn = page.wait_for_selector(
                    'button:has-text("Continue with Password"), a:has-text("Continue with Password")',
                    timeout=8000,
                )
                btn.click()
                page.wait_for_timeout(2000)
            except Exception:
                try:
                    page.goto(
                        "https://app.keka.com/Account/KekaLogin?returnUrl=%2F",
                        wait_until="networkidle", timeout=15000,
                    )
                except Exception:
                    pass
                page.wait_for_timeout(1000)

        log.info("Manual captcha: on page %s", page.url[:80])

        # Fill the form with user-provided captcha text
        try:
            email_el = page.query_selector('input[name="Email"]')
            if email_el:
                if email_el.is_visible():
                    email_el.fill(email)
                else:
                    page.evaluate(
                        "(v) => { const el = document.querySelector('input[name=\"Email\"]'); if(el) el.value = v; }",
                        email,
                    )
            pwd_el = page.query_selector('input[name="Password"]')
            if pwd_el:
                if pwd_el.is_visible():
                    pwd_el.fill(pwd)
                else:
                    page.evaluate(
                        "(v) => { const el = document.querySelector('input[name=\"Password\"]'); if(el) el.value = v; }",
                        pwd,
                    )
            log.info("Manual captcha submit: '%s'", captcha_text)
            page.fill('input[name="captcha"]', captcha_text, timeout=5000)
        except Exception as e:
            browser.close()
            return {"status": "error", "message": f"Form fill failed: {e}"}

        try:
            page.click('button:has-text("Login"), input[type="submit"][value="Login"]')
        except Exception as e:
            browser.close()
            return {"status": "error", "message": f"Submit failed: {e}"}

        page.wait_for_timeout(3000)
        cur_url = page.url
        log.info("After manual captcha submit: %s", cur_url[:80])

        # Still on login page → wrong captcha → grab fresh captcha image and ask again
        if "KekaLogin" in cur_url:
            new_b64 = None
            for img in page.query_selector_all("img"):
                src = img.get_attribute("src") or ""
                if src.startswith("data:image/png;base64,"):
                    new_b64 = src.split(",", 1)[1]
                    break
            browser.close()
            _pending_captcha.pop(token, None)
            if new_b64:
                return {"status": "captcha_required", "captcha_b64": new_b64}
            return {"status": "error", "message": "Wrong captcha. Could not reload captcha image."}

        # Reached 2FA
        if "SendCode" in cur_url or "VerifyCode" in cur_url:
            log.info("Manual captcha success — 2FA page reached")
            _pending_captcha.pop(token, None)
            otp_verify_url = cur_url
            try:
                page.click('button:has-text("Send code to email")', timeout=8000)
                page.wait_for_timeout(3000)
                otp_verify_url = page.url
            except Exception as e:
                log.warning("Could not click 'Send code to email': %s", e)
            pending_cookies = ctx.cookies()
            browser.close()
            return {
                "status":          "2fa_required",
                "pending_cookies": pending_cookies,
                "verify_url":      otp_verify_url,
                "message":         "OTP sent to email. Enter the code to complete login.",
            }

        # Unexpected redirect — treat as logged in without 2FA
        log.info("Manual captcha: unexpected redirect %s — treating as ok", cur_url[:80])
        _pending_captcha.pop(token, None)
        keka_cookies = [c for c in ctx.cookies() if "keka.com" in c.get("domain", "")]
        browser.close()
        return {"status": "ok", "cookies": keka_cookies}


def _make_pending_token(result: dict, co: str) -> dict:
    token = secrets.token_urlsafe(16)
    _pending_2fa[token] = {
        "cookies":    result["pending_cookies"],
        "verify_url": result.get("verify_url"),
        "expires_at": time.time() + 600,
        "company":    co,
    }
    return {
        "status":  "2fa_required",
        "token":   token,
        "message": result.get("message", "OTP sent to email"),
    }


def initiate_login(company: str = None) -> dict:
    """
    Start the Keka login flow (sync, thread-safe).
    Call from ThreadPoolExecutor to avoid blocking the uvicorn event loop.
    """
    _load_session_from_disk()
    co    = company or KEKA_COMPANY_NAME
    email = KEKA_EMAIL
    pwd   = KEKA_PASSWORD

    if not email or not pwd:
        return {"status": "error", "message": "KEKA_EMAIL and KEKA_PASSWORD not set in .env"}

    cached = _session_cache.get(co)
    if cached and cached["expires_at"] > time.time():
        log.info("Keka session already active for %s (%.1fh left)",
                 co, (cached["expires_at"] - time.time()) / 3600)
        return {"status": "ok"}

    result = _login_and_get_session_internal(co, email, pwd)

    if result["status"] == "ok":
        _session_cache[co] = {
            "cookies":       result["cookies"],
            "storage_state": result.get("storage_state"),
            "expires_at":    time.time() + _SESSION_TTL,
        }
        _save_session_to_disk()
        return {"status": "ok"}
    if result["status"] == "2fa_required":
        return _make_pending_token(result, co)
    if result["status"] == "captcha_required":
        return _make_captcha_token(co, result["captcha_b64"])
    return result


def verify_otp(otp: str, token: str, company: str = None) -> dict:
    """Submit OTP to complete 2FA (sync, thread-safe)."""
    co      = company or KEKA_COMPANY_NAME
    pending = _pending_2fa.get(token)

    if not pending:
        return {"status": "error", "message": "Invalid or expired 2FA token. Please start login again."}
    if pending["expires_at"] < time.time():
        _pending_2fa.pop(token, None)
        return {"status": "error", "message": "2FA token expired (10-minute window). Please start login again."}

    result = _login_and_get_session_internal(
        co, KEKA_EMAIL, KEKA_PASSWORD,
        otp=otp,
        pending_cookies=pending["cookies"],
        verify_url=pending.get("verify_url"),
    )

    if result["status"] == "ok":
        _pending_2fa.pop(token, None)
        _session_cache[co] = {
            "cookies":       result["cookies"],
            "storage_state": result.get("storage_state"),
            "expires_at":    time.time() + _SESSION_TTL,
        }
        _save_session_to_disk()
        log.info("Keka OTP verification success for %s — session saved for 24h", co)
        return {"status": "ok"}
    return result


def submit_captcha_and_login(token: str, captcha_text: str, company: str = None) -> dict:
    """
    Public API: user manually read the captcha image and provided the text.
    Completes the login flow and returns 2fa_required, captcha_required, or ok.
    """
    co     = company or KEKA_COMPANY_NAME
    result = _submit_manual_captcha_internal(token, captcha_text)

    if result["status"] == "2fa_required":
        return _make_pending_token(result, co)
    if result["status"] == "ok":
        _session_cache[co] = {
            "cookies":    result.get("cookies", []),
            "expires_at": time.time() + _SESSION_TTL,
        }
        _save_session_to_disk()
        return {"status": "ok"}
    if result["status"] == "captcha_required":
        # Wrong captcha → make a new token for the fresh captcha image
        return _make_captcha_token(co, result["captcha_b64"])
    return result


# Async shims so existing code that awaits these still works
async def initiate_login_async(company: str = None) -> dict:
    import asyncio
    return await asyncio.to_thread(initiate_login, company)


async def verify_otp_async(otp: str, token: str, company: str = None) -> dict:
    import asyncio
    return await asyncio.to_thread(verify_otp, otp, token, company)


def _get_session_cookies(company: str = None) -> list[dict]:
    _load_session_from_disk()
    co = company or KEKA_COMPANY_NAME
    cached = _session_cache.get(co)
    if cached and cached["expires_at"] > time.time():
        return cached["cookies"]
    raise RuntimeError(
        "No active Keka session. Use /keka/login/start and /keka/login/verify "
        "to authenticate before downloading attachments."
    )


def _get_storage_state(company: str = None) -> Optional[dict]:
    """Return full browser storage state (cookies + localStorage) if available."""
    _load_session_from_disk()
    co = company or KEKA_COMPANY_NAME
    cached = _session_cache.get(co)
    if cached and cached["expires_at"] > time.time():
        return cached.get("storage_state")
    return None


def get_spa_access_token(company: str = None) -> Optional[str]:
    """Return the Angular SPA access_token (JWT) from saved localStorage."""
    storage = _get_storage_state(company)
    if not storage:
        return None
    for origin in storage.get("origins", []):
        ls = origin.get("localStorage", [])
        for item in ls:
            if item.get("name") == "access_token":
                return item.get("value")
    return None


def get_spa_sas_details(company: str = None) -> Optional[dict]:
    """Return sasTokenDetails dict from localStorage (Azure SAS for blob storage)."""
    storage = _get_storage_state(company)
    if not storage:
        return None
    for origin in storage.get("origins", []):
        ls = origin.get("localStorage", [])
        for item in ls:
            if item.get("name") == "sasTokenDetails":
                try:
                    return json.loads(item.get("value", "{}"))
                except Exception:
                    return None
    return None


def _new_authenticated_context(p, company: str = None):
    """Create a Playwright browser context pre-loaded with the saved session."""
    browser = p.chromium.launch(headless=True, args=_LAUNCH_ARGS)
    storage = _get_storage_state(company)
    if storage:
        ctx = browser.new_context(user_agent=_UA, storage_state=storage)
    else:
        ctx = browser.new_context(user_agent=_UA)
        cookies = _get_session_cookies(company)
        ctx.add_cookies(cookies)
    ctx.add_init_script(_STEALTH_SCRIPT)
    return browser, ctx


def clear_session_cache(company: str = None):
    _load_session_from_disk()
    co = company or KEKA_COMPANY_NAME
    _session_cache.pop(co, None)
    _save_session_to_disk()


def is_authenticated(company: str = None) -> bool:
    _load_session_from_disk()
    co = company or KEKA_COMPANY_NAME
    cached = _session_cache.get(co)
    return bool(cached and cached["expires_at"] > time.time())


def _cookies_to_header(cookies: list[dict]) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


# ---------------------------------------------------------------------------
# Keka claim approval — discover real API by intercepting browser requests
# ---------------------------------------------------------------------------

# Cache files — one per action so approve and reject don't overwrite each other
def _endpoint_cache_path(action: str) -> str:
    name = f".keka_{action}_endpoint.json"
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", name))


def _load_approve_endpoint(action: str = "approve") -> dict | None:
    """Load cached Keka endpoint for the given action (approve / reject)."""
    try:
        p = _endpoint_cache_path(action)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                ep = json.load(f)
            if ep.get("url") and ep.get("method"):
                log.info("Loaded cached %s endpoint: %s %s",
                         action, ep["method"], ep["url"])
                return ep
    except Exception as e:
        log.debug("Could not load %s endpoint cache: %s", action, e)
    return None


def _save_approve_endpoint(ep: dict):
    """Save discovered Keka endpoint to action-specific cache file."""
    action = ep.get("action", "approve")
    try:
        with open(_endpoint_cache_path(action), "w", encoding="utf-8") as f:
            json.dump(ep, f, indent=2)
        log.info("Saved %s endpoint cache: %s %s",
                 action, ep["method"], ep["url"])
    except Exception as e:
        log.debug("Could not save %s endpoint cache: %s", action, e)


def approve_claim_js(
    numeric_id,
    action: str = "approve",
    reason: str = "",
    company: str = None,
) -> dict:
    """
    Try the CACHED discovered Keka endpoint first (fast, 1 request).
    If no cache exists, skip the blind-guess loop — let batch_approve_claims_via_browser_ui
    do the UI-click discovery instead.

    Returns {"success": bool, "url": str|None, "method": str|None, "error": str|None}
    """
    _ensure_proactor_loop()          # must be before any sync_playwright() call
    from playwright.sync_api import sync_playwright

    co  = company or KEKA_COMPANY_NAME
    r   = reason or ""
    nid = numeric_id
    action_word = {"approve": "approve", "reject": "reject",
                   "mark_paid": "markaspaid"}.get(action, action)

    # ── Try cached endpoint (discovered by a previous UI click) ──────────────
    # Requires a valid integer numeric_id — if we only have a UUID, skip and let
    # batch_approve_claims_via_browser_ui handle it (browser JS can resolve).
    try:
        nid_int = int(nid) if nid is not None else None
    except (ValueError, TypeError):
        nid_int = None

    if nid_int is None:
        return {"success": False, "url": None, "method": None,
                "error": "No integer numeric_id — will use browser UI to resolve and approve"}

    cached_ep = _load_approve_endpoint(action)
    if cached_ep and cached_ep.get("action") == action:
        try:
            with sync_playwright() as p:
                browser, ctx = _new_authenticated_context(p, co)
                ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
                    status=200, content_type="application/javascript",
                    body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};",
                ))
                page = ctx.new_page()
                page.goto(f"https://{co}.keka.com/#/home/dashboard",
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)

                if "Account/Login" in page.url:
                    browser.close()
                    return {"success": False, "url": None, "method": None,
                            "error": "Session expired — please re-login"}

                payload = _build_payload(
                    cached_ep.get("body_template", {}), nid_int, r, action_word
                )
                js_fn = """
                async (args) => {
                    const {url, method, payload} = args;
                    const token = localStorage.getItem('access_token') ||
                                  localStorage.getItem('accessToken') || '';
                    try {
                        const r = await fetch(url, {
                            method,
                            headers: {
                                'Authorization': token ? 'Bearer ' + token : '',
                                'Content-Type': 'application/json',
                                'Accept': 'application/json, */*',
                                'X-Requested-With': 'XMLHttpRequest',
                            },
                            body: JSON.stringify(payload),
                            credentials: 'include',
                        });
                        const body = await r.text();
                        return {status: r.status, body: body.slice(0, 300)};
                    } catch(e) { return {error: e.toString()}; }
                }
                """
                res = page.evaluate(js_fn, {
                    "url": cached_ep["url"], "method": cached_ep["method"],
                    "payload": payload
                })
                browser.close()
                status = res.get("status", 0) if isinstance(res, dict) else 0
                if status in (200, 201, 204):
                    log.info("✓ approve_claim_js cached EP → %s (nid=%s)", status, nid)
                    return {"success": True, "url": cached_ep["url"],
                            "method": cached_ep["method"], "error": None}
                log.warning("approve_claim_js cached EP → %s %s",
                            status, str(res.get("body", ""))[:80])
        except Exception as e:
            log.warning("approve_claim_js cached EP error: %s", e)

    # No cached endpoint and blind guesses are unreliable → signal failure so
    # the caller escalates to batch_approve_claims_via_browser_ui (UI click discovery).
    return {"success": False, "url": None, "method": None,
            "error": "No cached endpoint — will use browser UI click discovery"}


def _handle_approve_modal(page, claim_number, shot_fn=None,
                          action: str = "approve", reason: str = ""):
    """
    After clicking the Approve / Reject button in Keka's claims list, a
    confirmation modal appears.  This function handles both:

    APPROVE modal:
      1. Selects "Outside Payroll" as the payment mode.
      2. Sets today's date in the payment date picker.
      3. Clicks the Approve button.

    REJECT modal:
      1. Fills the rejection reason textarea.
      2. Clicks the Reject / Confirm button.

    Keka uses an ng-select dropdown (formcontrolname="paymentMode") and a
    bsdatepicker (#PaymentDate) that is readonly — must be opened via click.
    """
    page.wait_for_timeout(800)   # let the modal animate in

    # ── Detect modal ───────────────────────────────────────────────────────
    modal_visible = False
    for sel in [
        "[class*='modal-content']",
        "[role='dialog']",
        "[class*='modal']",
        "[class*='dialog']",
        "app-expense-approve-modal",
        "[class*='approval']",
        "[class*='side-panel']",
        "kendo-dialog",
    ]:
        try:
            if page.locator(sel).first.is_visible():
                modal_visible = True
                log.info("Approve modal detected via '%s' for claim %s", sel, claim_number)
                break
        except Exception:
            pass

    if not modal_visible:
        log.info("No %s modal for claim %s — assuming direct action", action, claim_number)
        return

    # ════════════════════════════════════════════════════════════════════════
    # REJECT modal — just fill reason + click Reject button
    # ════════════════════════════════════════════════════════════════════════
    if action == "reject":
        reason_str = (reason or "").strip()
        if reason_str:
            # Fill rejection reason textarea (Keka shows a single textarea)
            for ta_sel in [
                "textarea[formcontrolname*='reason' i]",
                "textarea[formcontrolname*='comment' i]",
                "textarea[formcontrolname*='remark' i]",
                "textarea[placeholder*='reason' i]",
                "textarea[placeholder*='Reason' i]",
                "textarea[placeholder*='comment' i]",
                "[role='dialog'] textarea",
                ".modal textarea",
                "textarea",
            ]:
                try:
                    ta = page.locator(ta_sel).first
                    if ta.is_visible():
                        ta.fill(reason_str)
                        log.info("Filled rejection reason via '%s' for claim %s",
                                 ta_sel, claim_number)
                        break
                except Exception:
                    pass

        if shot_fn:
            shot_fn(f"03b_reject_reason_{claim_number}")

        # Click Reject / Confirm button
        page.wait_for_timeout(300)
        for sel in [
            "button.btn-danger:has-text('Reject')",
            "button:has-text('Reject')",
            "button.btn-primary:has-text('Confirm')",
            "button:has-text('Confirm')",
            "button:has-text('Submit')",
            "[role='dialog'] button[type='submit']",
            ".modal button[type='submit']",
            "[role='dialog'] button:not(:has-text('Cancel')):not(:has-text('No')):not(:has-text('Close')):not(:has-text('×'))",
        ]:
            try:
                btn = page.locator(sel).last
                if btn.is_visible():
                    btn.click()
                    log.info("Reject modal confirmed via '%s' for claim %s", sel, claim_number)
                    break
            except Exception:
                pass

        page.wait_for_timeout(3000)
        return

    # ════════════════════════════════════════════════════════════════════════
    # APPROVE modal — Outside Payroll + Today date + Approve button
    # ════════════════════════════════════════════════════════════════════════

    # ── Method 1 (primary): Keka ng-select dropdown ───────────────────────
    # Keka's approve modal has: ng-select[formcontrolname="paymentMode"]
    # Options: "Payroll" (value 1), "Outside Payroll" (value 2)
    payment_set = False
    try:
        ng_sel = page.locator('ng-select[formcontrolname="paymentMode"]').first
        if ng_sel.is_visible():
            ng_sel.click()
            page.wait_for_timeout(800)
            # Find "Outside Payroll" option in the open dropdown
            outside_opt = page.locator('.ng-option').filter(has_text='Outside Payroll').first
            if outside_opt.is_visible():
                outside_opt.click()
                payment_set = True
                log.info("ng-select → 'Outside Payroll' for claim %s", claim_number)
            else:
                # Try all visible options
                all_opts = page.locator('.ng-option').all()
                for opt in all_opts:
                    txt = opt.inner_text().strip()
                    if 'outside' in txt.lower() or 'Outside' in txt:
                        opt.click()
                        payment_set = True
                        log.info("ng-select (scan) → '%s' for claim %s", txt, claim_number)
                        break
                if not payment_set:
                    page.keyboard.press("Escape")
    except Exception as e:
        log.debug("ng-select payment mode failed for claim %s: %s", claim_number, e)

    # ── Method 2 fallback: native <select> ───────────────────────────────
    if not payment_set:
        OUTSIDE_LABELS = [
            "Outside Payroll", "OutsidePayroll", "Outside payroll",
            "OUTSIDE_PAYROLL", "Out of Payroll",
        ]
        for sel in [
            "select[formcontrolname*='paymentMode' i]",
            "select[formcontrolname*='payment' i]",
            "[role='dialog'] select", ".modal select", "select",
        ]:
            try:
                dd = page.locator(sel).first
                if dd.is_visible():
                    for lbl in OUTSIDE_LABELS:
                        try:
                            dd.select_option(label=lbl)
                            payment_set = True
                            log.info("Native <select> → '%s' for claim %s", lbl, claim_number)
                            break
                        except Exception:
                            pass
                    if payment_set:
                        break
            except Exception:
                pass

    # ── Method 3 fallback: mat-select / radio / list ──────────────────────
    if not payment_set:
        OUTSIDE_LABELS = [
            "Outside Payroll", "OutsidePayroll", "Outside payroll",
        ]
        for lbl in OUTSIDE_LABELS:
            for sel in [
                f"mat-select[formcontrolname*='paymentMode' i]",
                f"label:has-text('{lbl}')",
                f"[class*='radio']:has-text('{lbl}')",
                f"li:has-text('{lbl}')",
                f"[class*='option']:has-text('{lbl}')",
            ]:
                try:
                    el = page.locator(sel).first
                    if el.is_visible():
                        el.click()
                        payment_set = True
                        log.info("Fallback → '%s' for claim %s", lbl, claim_number)
                        break
                except Exception:
                    pass
            if payment_set:
                break

    if not payment_set:
        log.warning("Could not select 'Outside Payroll' for claim %s — using default", claim_number)

    if shot_fn:
        shot_fn(f"03b_payment_mode_{claim_number}")

    # ── Set payment date (today) via bsdatepicker ─────────────────────────
    # The date input (#PaymentDate) is readonly — must click to open calendar
    page.wait_for_timeout(300)
    date_set = False
    try:
        date_field = page.locator('#PaymentDate').first
        if date_field.is_visible():
            date_field.click()
            page.wait_for_timeout(800)
            # Try "Today" button first
            for today_sel in [
                'button:has-text("Today")',
                'span:has-text("Today")',
                '[class*="today"]',
                'td[class*="today"]',
                '.bs-datepicker-body td span[class*="today"]',
            ]:
                try:
                    el = page.locator(today_sel).first
                    if el.is_visible():
                        el.click()
                        date_set = True
                        log.info("Date picker 'Today' clicked via '%s' for claim %s",
                                 today_sel, claim_number)
                        break
                except Exception:
                    pass
            if not date_set:
                # Click the day number matching today
                from datetime import date as _dt
                today_day = str(_dt.today().day)
                for day_sel in [
                    f'td[class*="today"]',
                    f'.bs-datepicker-body td span:has-text("{today_day}")',
                    f'td:has-text("{today_day}")',
                ]:
                    try:
                        el = page.locator(day_sel).first
                        if el.is_visible():
                            el.click()
                            date_set = True
                            log.info("Date picker day %s clicked for claim %s",
                                     today_day, claim_number)
                            break
                    except Exception:
                        pass
            page.wait_for_timeout(400)
        else:
            # Try other date input selectors
            for dsel in [
                'kendo-datepicker input', 'input[type="date"]',
                '[placeholder*="date" i]', '[placeholder*="Date" i]',
            ]:
                try:
                    di = page.locator(dsel).first
                    if di.is_visible():
                        from datetime import date as _dt
                        di.fill(_dt.today().strftime('%Y-%m-%d'))
                        date_set = True
                        break
                except Exception:
                    pass
    except Exception as de:
        log.debug("Date picker failed for claim %s: %s", claim_number, de)

    if not date_set:
        log.debug("Could not set payment date for claim %s — continuing", claim_number)

    if shot_fn:
        shot_fn(f"03c_date_set_{claim_number}")

    # ── Click the Approve button in the modal ─────────────────────────────
    page.wait_for_timeout(300)
    confirmed = False
    for sel in [
        "button.btn-primary:has-text('Approve')",
        "button:has-text('Approve')",
        "button:has-text('Confirm')",
        "button:has-text('Submit')",
        "button:has-text('Save')",
        "[role='dialog'] button[type='submit']",
        ".modal button[type='submit']",
        "kendo-dialog button:has-text('OK')",
        # Last resort: any visible primary button in the modal that isn't Cancel/Close
        "[role='dialog'] button:not(:has-text('Cancel')):not(:has-text('No')):not(:has-text('Close')):not(:has-text('×'))",
    ]:
        try:
            btn = page.locator(sel).last
            if btn.is_visible():
                btn.click()
                confirmed = True
                log.info("Approve modal confirmed via '%s' for claim %s", sel, claim_number)
                break
        except Exception:
            pass

    if not confirmed:
        log.warning("Could not click confirm in approve modal for claim %s", claim_number)

    page.wait_for_timeout(3000)   # wait for the real API call to fire and complete


def batch_approve_claims_via_browser_ui(
    claim_numbers: list[str],
    action: str = "approve",
    reason: str = "",
    company: str = None,
    numeric_ids: dict = None,      # {display_number: numeric_id}
    employee_names: dict = None,   # {display_number: expected_employee_name}
) -> dict:
    """
    Approve/reject Keka expense claims by automating the
    "Pending Expense Claims Approvals" page (Org → Expenses → Approve Claims).

    Flow:
      1. If cached API endpoint exists → JS fetch per claim (instant, no UI)
      2. Otherwise open browser → navigate to Keka approval page →
         search for each claim → click ✓/✗ button →
         intercept the real API call → save it for future runs
      3. Once API is discovered, use JS fetch for remaining claims in the
         same browser session (one round-trip per claim)

    Returns {"actioned": [...], "errors": {...}, "discovered_api": {...}|None}
    """
    _ensure_proactor_loop()          # must be before any sync_playwright() call
    from playwright.sync_api import sync_playwright

    co           = company or KEKA_COMPANY_NAME
    action_label = "Approve" if action == "approve" else "Reject"
    action_word  = {"approve": "approve", "reject": "reject",
                    "mark_paid": "markaspaid"}.get(action, action)
    nids         = numeric_ids or {}
    enames       = employee_names or {}
    r            = reason or ""
    actioned: list[str]    = []
    errors: dict[str, str] = {}
    discovered: dict | None = None
    action_word  = {"approve": "approve", "reject": "reject",
                    "mark_paid": "markaspaid"}.get(action, action)

    # Keka's "Pending Expense Claims Approvals" page URLs (confirmed working)
    APPROVAL_PAGE_URLS = [
        f"https://{co}.keka.com/#/org/expenses/expenseclaims/pending",   # CONFIRMED WORKING
        f"https://{co}.keka.com/#/org/expenses/expenseclaims",
        f"https://{co}.keka.com/#/org/expense/approveclaims",
        f"https://{co}.keka.com/#/org/expenses/approveclaims",
        f"https://{co}.keka.com/#/mytime/expense/approveclaims",
    ]

    _js_fetch = """
    async (args) => {
        const {url, method, payload} = args;
        const token = localStorage.getItem('access_token') ||
                      localStorage.getItem('accessToken') || '';
        try {
            const r = await fetch(url, {
                method,
                headers: {
                    'Authorization': token ? 'Bearer ' + token : '',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, */*',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify(payload),
                credentials: 'include',
            });
            const body = await r.text();
            return {status: r.status, body: body.slice(0, 400)};
        } catch(e) {
            return {error: e.toString()};
        }
    }
    """

    # ── Phase 1: try cached discovered endpoint (fast path) ──────────────────
    cached_ep = _load_approve_endpoint(action)
    if cached_ep and cached_ep.get("action") == action:
        log.info("Phase 1: trying cached endpoint %s %s for %d claim(s)",
                 cached_ep["method"], cached_ep["url"], len(claim_numbers))
        try:
            with sync_playwright() as p:
                browser, ctx = _new_authenticated_context(p, co)
                ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
                    status=200, content_type="application/javascript",
                    body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};",
                ))
                page = ctx.new_page()
                page.goto(f"https://{co}.keka.com/#/home/dashboard",
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)

                if "Account/Login" in page.url:
                    browser.close()
                    err = "Keka session expired — please re-login"
                    return {"actioned": [], "errors": {cn: err for cn in claim_numbers},
                            "discovered_api": None}

                ep_url    = cached_ep["url"]
                ep_method = cached_ep["method"]
                ep_tmpl   = cached_ep.get("body_template", {})

                cache_ok = True
                for cn in list(claim_numbers):
                    raw_nid = nids.get(str(cn))
                    # Phase 1 REQUIRES an integer numeric_id — the bulk endpoint needs
                    # expenseClaimIds:[integer].  UUID strings or None → fall to Phase 2.
                    try:
                        nid = int(raw_nid) if raw_nid is not None else None
                    except (ValueError, TypeError):
                        nid = None

                    if nid is None:
                        log.info("Phase 1 skip claim %s (nid=%r not integer) → Phase 2",
                                 cn, raw_nid)
                        cache_ok = False
                        errors[str(cn)] = "__needs_phase2__"
                        continue

                    payload = _build_payload(ep_tmpl, nid, r, action_word)
                    try:
                        res = page.evaluate(_js_fetch, {
                            "url": ep_url, "method": ep_method, "payload": payload
                        })
                        status = res.get("status", 0) if isinstance(res, dict) else 0
                        if status in (200, 201, 204):
                            log.info("✓ Cached EP claim %s → %s", cn, status)
                            actioned.append(str(cn))
                        else:
                            log.warning("Cached EP claim %s → %s %s",
                                        cn, status, str(res.get("body", ""))[:80])
                            cache_ok = False
                            errors[str(cn)] = f"Cached endpoint returned {status}"
                    except Exception as e:
                        cache_ok = False
                        errors[str(cn)] = str(e)[:120]

                browser.close()
                if all(str(cn) in actioned for cn in claim_numbers):
                    return {"actioned": actioned, "errors": errors, "discovered_api": cached_ep}

                # Some failed — fall through with only the failures
                failed_cns = [cn for cn in claim_numbers if str(cn) not in actioned]
                for cn in failed_cns:
                    errors.pop(str(cn), None)
                claim_numbers = failed_cns

        except Exception as e:
            log.warning("Phase 1 (cached EP) failed: %s", e)

    # ── Phase 2: Open Keka browser, navigate to approval page, click ─────────
    log.info("Phase 2: Browser UI — opening Keka for claims: %s", claim_numbers)

    with sync_playwright() as p:
        browser, ctx = _new_authenticated_context(p, co)
        ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
            status=200, content_type="application/javascript",
            body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};",
        ))

        # ── Dual interception: capture Bearer token + discover approve API ──────
        captures_list: list = []          # API calls fired by UI clicks
        _captured_spa_tokens: list = []   # Bearer tokens seen on the wire

        def _on_request(req):
            # Capture Bearer token from any authenticated API request
            auth = req.headers.get("authorization", "")
            if auth.lower().startswith("bearer ") and len(auth) > 50:
                tok = auth.split(" ", 1)[1]
                if tok not in _captured_spa_tokens:
                    _captured_spa_tokens.append(tok)
                    log.info("Captured SPA Bearer token (%d chars) from %s",
                             len(tok), req.url[:70])

            # Also capture approve/reject API calls fired by UI clicks
            method = req.method.upper()
            if method not in ("POST", "PUT", "PATCH"):
                return
            url   = req.url
            lower = url.lower()
            if any(k in lower for k in ("approv", "reject", "claim", "expense", "action")):
                try:
                    body_data = req.post_data or ""
                except Exception:
                    body_data = ""
                if len(body_data) > 2:
                    captures_list.append({
                        "method":    method,
                        "url":       url,
                        "post_data": body_data,
                    })
                    log.info("Captured API call #%d: %s %s (body=%d bytes)",
                             len(captures_list), method, url, len(body_data))

        ctx.on("request", _on_request)
        page = ctx.new_page()
        page.set_viewport_size({"width": 1920, "height": 1080})

        # Debug screenshots
        _dbg = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "debug_screenshots"))
        os.makedirs(_dbg, exist_ok=True)
        def _shot(name):
            try:
                page.screenshot(path=os.path.join(_dbg, f"{name}.png"))
            except Exception:
                pass

        try:
            # ── 2a. Load dashboard (triggers Angular init + token exchange) ──────
            page.goto(f"https://{co}.keka.com/#/home/dashboard",
                      wait_until="networkidle", timeout=35000)
            # Wait for Angular to fully load (poll for actual content)
            for _wait_i in range(15):
                page.wait_for_timeout(1000)
                _body_preview = page.inner_text("body") or ""
                if len(_body_preview.strip()) > 500:
                    log.info("Dashboard content ready after %ds", _wait_i + 1)
                    break

            if "Account/Login" in page.url:
                browser.close()
                err = ("Keka session expired — please re-login first:\n"
                       "Go to the 'Keka Sync' page and click 'Login to Keka'.")
                return {"actioned": actioned,
                        "errors": {**errors, **{cn: err for cn in claim_numbers}},
                        "discovered_api": None}

            _shot("01_dashboard")
            log.info("Dashboard loaded. Bearer tokens captured so far: %d. URL: %s",
                     len(_captured_spa_tokens), page.url[:80])

            # ── 2b. Navigate to the Keka "Approve Claims" page ──────────────────
            # Try multiple URL variants. For each, wait up to 10s for Angular to
            # render actual content (not a blank white page).
            approval_page_url = None
            for apurl in APPROVAL_PAGE_URLS:
                try:
                    page.goto(apurl, wait_until="domcontentloaded", timeout=20000)
                    # Wait for Angular to finish rendering (poll for real content)
                    for _ in range(10):
                        page.wait_for_timeout(1000)
                        body_len  = len((page.inner_text("body") or "").strip())
                        if body_len > 400:
                            break
                    body_text = (page.inner_text("body") or "").strip()
                    has_table = any(kw in body_text for kw in
                                   ("Expense", "Claim", "Approve", "Employee", "Amount", "₹"))
                    log.info("Approval URL %s → body=%d chars, has_table=%s",
                             apurl, len(body_text), has_table)
                    if has_table and len(body_text) > 300:
                        approval_page_url = apurl
                        break
                except Exception as ge:
                    log.debug("Approval URL %s failed: %s", apurl, ge)

            _shot("02_approval_page")

            if approval_page_url:
                log.info("✓ Approval page loaded: %s", approval_page_url)
                # ── 2c. For each claim: find row → hover → click action button ──
                # Keka uses AG Grid — rows are div.ag-row elements.
                # Action buttons are in a PINNED-RIGHT column, not inside the row's DOM,
                # so we hover the row then click by absolute x coordinate.
                # Approve = x≈1745, Reject = x≈1777 (1920px wide viewport)
                APPROVE_X = 1745
                REJECT_X  = 1777

                for claim_number in list(claim_numbers):
                    nid = nids.get(str(claim_number))
                    claim_str = str(claim_number)
                    claim_done = False
                    prev_captures = len(captures_list)

                    # ── Find the AG Grid row ──────────────────────────────
                    # Keka shows claim numbers as "#2297" in the grid
                    row_el = None
                    for row_sel, has_txt in [
                        ("div.ag-row", f"#{claim_str}"),   # primary: AG Grid + # prefix
                        ("div.ag-row", claim_str),          # AG Grid without #
                        (f'tr:has-text("#{claim_str}")', None),
                        (f'tr:has-text("{claim_str}")', None),
                        (f'[class*="row"]:has-text("#{claim_str}")', None),
                        (f'[class*="row"]:has-text("{claim_str}")', None),
                    ]:
                        try:
                            if has_txt:
                                loc = page.locator(row_sel).filter(has_text=has_txt).first
                            else:
                                loc = page.locator(row_sel).first
                            if loc.count() > 0 and loc.is_visible():
                                row_el = loc
                                log.info("Found claim %s row via '%s' has_text='%s'",
                                         claim_str, row_sel, has_txt or "")
                                break
                        except Exception:
                            pass

                    _shot(f"03_search_{claim_number}")

                    if row_el is None:
                        log.warning("Claim %s row not found in AG Grid — skipping UI click",
                                    claim_str)
                        errors[str(claim_number)] = "__NEEDS_JS_FETCH__"
                        continue

                    # ── Hover row to reveal action buttons ───────────────
                    try:
                        row_el.scroll_into_view_if_needed()
                        row_el.hover()
                        page.wait_for_timeout(1000)

                        box = row_el.bounding_box()
                        if box:
                            click_x = APPROVE_X if action == "approve" else REJECT_X
                            click_y = box["y"] + box["height"] / 2
                            log.info("Clicking %s button at (%.0f, %.0f) for claim %s",
                                     action_label, click_x, click_y, claim_str)
                            page.mouse.click(click_x, click_y)
                            page.wait_for_timeout(2000)

                            # ── Handle the approval / rejection modal ────
                            _handle_approve_modal(page, claim_str, _shot,
                                                  action=action, reason=r)
                            page.wait_for_timeout(2000)
                            _shot(f"04_after_click_{claim_number}")

                            # ── Check if API call was captured ────────────
                            new_captures = captures_list[prev_captures:]
                            if new_captures:
                                log.info("✓ UI click → captured %d API call(s) for claim %s",
                                         len(new_captures), claim_str)
                                last_cap = new_captures[-1]
                                if not discovered:
                                    try:
                                        pl = json.loads(last_cap["post_data"])
                                        tmpl = pl[0] if isinstance(pl, list) and pl else pl
                                        discovered = {
                                            "action":        action,
                                            "method":        last_cap["method"],
                                            "url":           last_cap["url"],
                                            "body_template": tmpl,
                                            "post_data":     last_cap["post_data"],
                                        }
                                        _save_approve_endpoint(discovered)
                                        log.info("✓ Endpoint cached from UI click: %s %s",
                                                 last_cap["method"], last_cap["url"])
                                    except Exception as ce:
                                        log.debug("Could not cache endpoint: %s", ce)

                                actioned.append(claim_str)
                                claim_done = True
                            else:
                                # No API call captured — check if modal closed (still success)
                                modal_gone = not page.locator('[class*="modal-content"]').first.is_visible()
                                if modal_gone:
                                    log.info("✓ Modal closed for claim %s (no API captured but likely success)",
                                             claim_str)
                                    actioned.append(claim_str)
                                    claim_done = True
                                else:
                                    log.warning("No API captured and modal still open for claim %s",
                                                claim_str)
                        else:
                            log.warning("Could not get bounding box for claim %s row", claim_str)
                    except Exception as click_err:
                        log.warning("Row click error for claim %s: %s", claim_str, click_err)

                    if not claim_done:
                        _shot(f"04_ui_failed_{claim_number}")
                        log.warning("UI click failed for claim %s — falling back to JS fetch",
                                    claim_str)
                        # Fall through to JS fetch below
                        errors[str(claim_number)] = "__NEEDS_JS_FETCH__"

            else:
                # Approval page rendered blank → queue ALL for JS fetch fallback
                log.warning("Approval page is blank — falling back to JS fetch for all claims")
                for cn in claim_numbers:
                    errors[str(cn)] = "__NEEDS_JS_FETCH__"

            # ── 2d. JS fetch fallback for claims that the UI approach missed ─────
            # Uses Bearer token captured from network requests.
            # Navigates to dashboard (same-origin) for the fetch context.
            js_needed = [cn for cn in claim_numbers
                         if errors.get(str(cn)) == "__NEEDS_JS_FETCH__"]
            if js_needed:
                errors = {k: v for k, v in errors.items()
                          if v != "__NEEDS_JS_FETCH__"}  # clear placeholder

                # Navigate back to dashboard for the JS fetch context
                try:
                    page.goto(f"https://{co}.keka.com/#/home/dashboard",
                              wait_until="domcontentloaded", timeout=20000)
                    page.wait_for_timeout(3000)
                except Exception:
                    pass

                # Get the best Bearer token we captured
                _spa_token = (_captured_spa_tokens[-1] if _captured_spa_tokens
                              else get_spa_access_token(co) or "")
                log.info("JS fetch fallback for %d claims. spa_token=%s",
                         len(js_needed), "captured" if _spa_token else "NONE")

                # ── JavaScript that tries the approve/reject API directly ────────
                # Uses captured Bearer token + browser cookies (credentials:include).
                # Tries many URL/method/payload combinations and returns the best result.
                _JS_ACTION = r"""
                async (args) => {
                    const {claim_number, numeric_id, reason, action_word, spa_token} = args;
                    const base = window.location.origin;

                    // Use captured Bearer token (most reliable) or localStorage fallback
                    const token = spa_token
                               || localStorage.getItem('access_token')
                               || localStorage.getItem('accessToken')
                               || localStorage.getItem('token')
                               || sessionStorage.getItem('access_token')
                               || '';

                    function getCookie(name) {
                        const m = document.cookie.match('(?:^|;)\\s*'+name+'=([^;]*)');
                        return m ? decodeURIComponent(m[1]) : '';
                    }
                    const xsrf = getCookie('XSRF-TOKEN') || getCookie('csrf-token')
                              || getCookie('_csrf') || getCookie('csrftoken') || '';
                    const lsKeys = Object.keys(localStorage).join(',');
                    const ssKeys = Object.keys(sessionStorage).join(',');
                    const c_str = String(reason || '');

                    function makeHdrs(withToken) {
                        const h = {
                            'Content-Type':     'application/json',
                            'Accept':           'application/json, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                        };
                        if (xsrf)              h['X-XSRF-TOKEN']   = xsrf;
                        if (withToken && token) h['Authorization'] = 'Bearer ' + token;
                        return h;
                    }

                    // ── Step 1: resolve numeric claim id ──────────────────────
                    let nid = numeric_id;
                    const resolve_errors = [];
                    if (!nid) {
                        const list_eps = [
                            '/k/default/api/expense/claims/pending?pageNumber=1&pageSize=500',
                            '/k/default/api/expense/claims/underprogress?pageNumber=1&pageSize=500',
                            '/k/default/api/expense/claims?pageNumber=1&pageSize=500',
                            '/k/default/api/expense/claims?pageNumber=1&pageSize=500&claimStatus=1',
                            '/k/default/api/expense/claims?pageNumber=1&pageSize=500&claimStatus=2',
                        ];
                        const cn_s = String(claim_number);
                        for (const ep of list_eps) {
                            try {
                                const r = await fetch(base + ep, {
                                    headers: makeHdrs(true), credentials: 'include'});
                                if (!r.ok) { resolve_errors.push(ep+':'+r.status); continue; }
                                const d = await r.json();
                                const items = d.data || (Array.isArray(d) ? d : []);
                                const found = items.find(c =>
                                    String(c.claimNumber)   === cn_s ||
                                    String(c.claimNo)       === cn_s ||
                                    String(c.displayNumber) === cn_s ||
                                    String(c.claimId)       === cn_s ||
                                    String(c.id)            === cn_s
                                );
                                if (found && found.id) { nid = found.id; break; }
                            } catch(e) { resolve_errors.push(ep+':'+e.message); }
                        }
                    }
                    if (!nid) {
                        return {
                            success: false, stage: 'resolve',
                            error: 'Numeric ID not found for claim #'+claim_number
                                  +'. Errors: '+resolve_errors.join(' | ')
                                  +'. LS: '+lsKeys.slice(0,200)
                                  +'. SS: '+ssKeys.slice(0,200)
                                  +'. token='+(token?'present':'MISSING')
                        };
                    }

                    // ── Step 2: try URL / method / payload combos ─────────────
                    // Primary endpoint (confirmed from real UI capture):
                    //   PUT /k/bulk/api/expense/claims/approve
                    //   Body: {"expenseClaimIds":[nid], "paymentMode":2,
                    //          "paymentStatus":1, "paymentDate":"YYYY-MM-DD",
                    //          "comment":"", "paymentNote":null}
                    const today_iso = new Date().toISOString().slice(0,10);
                    const urls_approve = [
                        base+'/k/bulk/api/expense/claims/approve',       // CONFIRMED WORKING
                        base+'/k/default/api/expense/claims/approve',
                        base+'/k/default/api/expense/claims/'+nid+'/approve',
                        base+'/k/default/api/expense/approvals/claims/approve',
                        base+'/k/default/api/expense/approvals/approve',
                        base+'/k/default/api/expense/expenseclaims/'+nid+'/approve',
                    ];
                    const urls_reject = [
                        base+'/k/bulk/api/expense/claims/reject',
                        base+'/k/default/api/expense/claims/reject',
                        base+'/k/default/api/expense/claims/'+nid+'/reject',
                        base+'/k/default/api/expense/approvals/claims/reject',
                    ];
                    const urls = action_word === 'approve' ? urls_approve : urls_reject;

                    // paymentMode: 1=WithPayroll(Payroll), 2=OutsidePayroll
                    // paymentStatus: 1=YetToBePaid, 2=PastAlreadyPaid
                    const is_reject = (action_word === 'reject');
                    const payloads = is_reject ? [
                        // ── Reject payloads (no paymentMode / paymentStatus) ──
                        {expenseClaimIds:[nid], comment:c_str, approverComment:c_str},
                        {expenseClaimIds:[nid], comment:c_str},
                        {expenseClaimIds:[nid], approverComment:c_str},
                        {expenseClaimIds:[nid], remarks:c_str},
                        {expenseClaimIds:[nid]},
                        [{id:nid, approverComment:c_str, comment:c_str}],
                        [{id:nid, comment:c_str}],
                        [{id:nid, remarks:c_str}],
                        [{id:nid}],
                        [{claimId:nid, comment:c_str}],
                        [{claimId:nid}],
                        {claimIds:[nid], comment:c_str},
                        {claimIds:[nid]},
                        {ids:[nid], comment:c_str},
                        {ids:[nid]},
                        {id:nid, comment:c_str},
                        [nid],
                    ] : [
                        // ── Confirmed working format (bulk approve endpoint) ──
                        {expenseClaimIds:[nid], paymentMode:2, paymentStatus:1,
                         paymentDate:today_iso, comment:c_str, paymentNote:null},
                        {expenseClaimIds:[nid], paymentMode:2, paymentStatus:1,
                         paymentDate:today_iso, comment:'', paymentNote:null},
                        {expenseClaimIds:[nid], paymentMode:2, paymentStatus:1,
                         paymentDate:today_iso},
                        {expenseClaimIds:[nid], paymentMode:1, paymentStatus:1,
                         paymentDate:today_iso, comment:c_str, paymentNote:null},
                        {expenseClaimIds:[nid], paymentMode:2},
                        {expenseClaimIds:[nid]},
                        // ── Legacy single-claim formats ───────────────────────
                        [{id:nid, paymentMode:2, approverComment:c_str}],
                        [{id:nid, paymentMode:2, comment:c_str}],
                        [{id:nid, paymentMode:2}],
                        [{id:nid, approverComment:c_str}],
                        [{id:nid, comment:c_str}],
                        [{id:nid}],
                        [{claimId:nid, paymentMode:2, approverComment:c_str}],
                        [{claimId:nid, comment:c_str}],
                        [{claimId:nid}],
                        // ── Wrapper objects ───────────────────────────────────
                        {claimIds:[nid], comment:c_str, paymentMode:2},
                        {claimIds:[nid], comment:c_str},
                        {claimIds:[nid]},
                        {ids:[nid], comment:c_str},
                        {ids:[nid]},
                        {id:nid, paymentMode:2, approverComment:c_str},
                        {id:nid, comment:c_str},
                        // ── Bare ID arrays ────────────────────────────────────
                        [nid],
                        [String(nid)],
                    ];

                    let best = null;
                    const status_counts = {};

                    for (const withTok of [true, false]) {
                        const hdrs = makeHdrs(withTok);
                        for (const url of urls) {
                            for (const method of ['PUT','POST','PATCH']) {
                                for (const payload of payloads) {
                                    try {
                                        const r = await fetch(url, {
                                            method, headers: hdrs,
                                            body: JSON.stringify(payload),
                                            credentials: 'include',
                                        });
                                        const s = r.status;
                                        status_counts[s] = (status_counts[s]||0)+1;

                                        if (s===200||s===201||s===204) {
                                            const bod = (await r.text()).slice(0,300);
                                            return {success:true, url, method,
                                                    numeric_id:nid, status:s,
                                                    payload_str:JSON.stringify(payload),
                                                    body:bod, withTok};
                                        }
                                        if (s===400||s===422||s===500||s===403) {
                                            const bod = (await r.text()).slice(0,500);
                                            const prio = {400:1,422:1,403:2,500:3}[s]||9;
                                            const cp   = best ? ({400:1,422:1,403:2,500:3}[best.status]||9) : 99;
                                            if (prio <= cp) {
                                                best = {url,method,status:s,body:bod,
                                                        payload_str:JSON.stringify(payload),
                                                        withTok};
                                            }
                                        }
                                    } catch(e) {}
                                }
                            }
                        }
                    }

                    const total = Object.values(status_counts).reduce((a,b)=>a+b,0);
                    const sc_str = Object.entries(status_counts).map(([k,v])=>k+'×'+v).join(', ');
                    const best_info = best
                        ? ' | Best('+best.status+'): '+best.url+' '+best.method
                          +' payload='+best.payload_str.slice(0,100)
                          +' → body='+best.body.slice(0,200)
                        : ' | No 400/422/500 captured';
                    return {
                        success: false, stage: 'action', numeric_id: nid,
                        error: 'All '+total+' combos failed. Statuses: '+sc_str+best_info
                               +' | token='+(token?'present':'MISSING')
                               +' | xsrf='+(xsrf?'present':'none'),
                        best_attempt: best,
                    };
                }
                """

                for claim_number in js_needed:
                    raw_nid = nids.get(str(claim_number)) or None
                    # Only pass integer numeric_id to JS — UUID strings cause wrong-claim
                    # approval.  None → JS will resolve from the Keka SPA pending list.
                    try:
                        nid = int(raw_nid) if raw_nid is not None else None
                    except (ValueError, TypeError):
                        nid = None  # Let the browser JS resolve it from SPA endpoints
                    log.info("JS-fetch for claim %s (nid=%s, token=%s)",
                             claim_number, nid, "ok" if _spa_token else "NONE")
                    try:
                        res = page.evaluate(_JS_ACTION, {
                            "claim_number": str(claim_number),
                            "numeric_id":   nid,
                            "reason":       r,
                            "action_word":  action_word,
                            "spa_token":    _spa_token,
                        })
                    except Exception as je:
                        _shot(f"05_jsfail_{claim_number}")
                        errors[str(claim_number)] = f"Browser JS error: {str(je)[:200]}"
                        log.warning("JS eval error for claim %s: %s", claim_number, je)
                        continue

                    _shot(f"05_after_jsfetch_{claim_number}")

                    if res.get("success"):
                        actioned.append(str(claim_number))
                        log.info("✓ JS-fetch %s claim %s (url=%s method=%s status=%s)",
                                 action_label, claim_number,
                                 res.get("url"), res.get("method"), res.get("status"))
                        if not discovered:
                            try:
                                pl = json.loads(res.get("payload_str", "{}"))
                                if isinstance(pl, list) and pl:
                                    pl = pl[0]
                                discovered = {
                                    "action":        action,
                                    "method":        res["method"],
                                    "url":           res["url"],
                                    "body_template": pl,
                                    "post_data":     res.get("payload_str", ""),
                                }
                                _save_approve_endpoint(discovered)
                                log.info("✓ JS endpoint cached: %s %s",
                                         discovered["method"], discovered["url"])
                            except Exception as ce:
                                log.debug("Could not cache JS endpoint: %s", ce)
                    else:
                        _shot(f"05_jsfail_{claim_number}")
                        err_detail = res.get("error", "JS action failed (no detail)")
                        errors[str(claim_number)] = err_detail
                        log.warning("JS-fetch failed for claim %s: %s",
                                    claim_number, err_detail[:300])

            # Catch-all for anything still unresolved
            for cn in claim_numbers:
                if str(cn) not in actioned and str(cn) not in errors:
                    errors[str(cn)] = "Could not complete action — check debug_screenshots/"

        except Exception as e:
            import traceback as _tb
            log.error("batch_approve_claims outer error: %s\n%s", e, _tb.format_exc())
            for cn in claim_numbers:
                if str(cn) not in actioned and str(cn) not in errors:
                    errors[str(cn)] = str(e)[:200]
        finally:
            try:
                browser.close()
            except Exception:
                pass

    return {"actioned": actioned, "errors": errors, "discovered_api": discovered}


def _name_matches(expected: str, row_text: str) -> bool:
    """
    Fuzzy employee-name check.
    Returns True if the expected name is recognisably present in the Keka row text.

    Rules:
      • Normalise both sides to lowercase, keep only letters + spaces.
      • Require that at least 60 % of the significant words (len > 2) from the
        expected name appear somewhere in the row text.
      • If the expected name has no significant words (e.g. very short names),
        fall back to a simple substring check.
    """
    import re

    def _tokens(s: str) -> list[str]:
        return [w for w in re.sub(r"[^a-z ]", "", s.lower()).split() if len(w) > 2]

    exp_words = _tokens(expected)
    if not exp_words:
        # last-resort: plain substring (case-insensitive)
        return expected.lower().strip() in row_text.lower()

    row_words = set(_tokens(row_text))
    matched   = sum(1 for w in exp_words if w in row_words)
    ratio     = matched / len(exp_words)
    log.debug("Name check '%s': %d/%d words matched (%.0f%%)",
              expected, matched, len(exp_words), ratio * 100)
    return ratio >= 0.60


def _build_payload(template: dict | list, nid, reason: str, action_word: str):
    """
    Build an approve/reject payload by cloning the cached template and
    substituting the real numeric_id + reason + today's date.

    Handles the Keka bulk endpoint format:
      {"expenseClaimIds": [2482823], "paymentMode": 2, "paymentStatus": 1,
       "paymentDate": "2026-05-12", "comment": "", "paymentNote": null}
    """
    import re as _re
    from datetime import date as _date
    _today = _date.today().isoformat()   # "YYYY-MM-DD"
    _date_re = _re.compile(r'^\d{4}-\d{2}-\d{2}$')

    def _is_numeric_id(v):
        return isinstance(v, (int, float)) and v > 1_000_000

    def _subst(obj, key=""):
        if isinstance(obj, list):
            # If it's a list of one or more numeric IDs → replace all with nid
            if obj and all(_is_numeric_id(i) for i in obj):
                return [int(nid)] if nid else obj
            return [_subst(i) for i in obj]
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                k_lo = k.lower()
                if _is_numeric_id(v):
                    # Direct numeric ID field
                    out[k] = int(nid) if nid else v
                elif isinstance(v, str) and _date_re.match(v):
                    # ISO date string — update to today
                    out[k] = _today
                elif isinstance(v, str) and v in ("", "string"):
                    # Comment / reason placeholder
                    out[k] = reason
                elif isinstance(v, list) and v and all(_is_numeric_id(i) for i in v):
                    # List of numeric IDs (e.g. expenseClaimIds)
                    out[k] = [int(nid)] if nid else v
                else:
                    out[k] = _subst(v, k)
            return out
        return obj

    if template:
        try:
            result = _subst(template)
            # Extra safety: ensure paymentDate is always today
            if isinstance(result, dict) and "paymentDate" in result:
                result["paymentDate"] = _today
            return result
        except Exception:
            pass

    # Generic fallback payload (covers most Keka API patterns)
    base = {"id": nid, "approverComment": reason, "approvalActionReason": reason,
            "comment": reason, "remark": reason}
    return [base] if action_word in ("approve", "reject") else base


# ---------------------------------------------------------------------------
# Attachment download
# ---------------------------------------------------------------------------

def bulk_download_claims_attachments(
    claim_ids: list[str],
    out_dir: str,
    company: str = None,
    on_progress=None,
) -> dict:
    """
    Bulk download attachments for ALL claims at once.

    Strategy:
      1. Use one browser session to navigate each claim page and intercept
         all Azure Blob SAS URLs (fast — reuses the same browser context).
      2. Download all captured files in parallel using requests.

    Returns {claim_id: [saved_file_paths]}
    """
    _ensure_proactor_loop()
    import requests as _req
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from playwright.sync_api import sync_playwright

    co = company or KEKA_COMPANY_NAME
    os.makedirs(out_dir, exist_ok=True)

    try:
        cookies = _get_session_cookies(co)
    except RuntimeError as e:
        log.warning("No session for bulk download: %s", e)
        return {}

    def _is_file_url(url: str) -> bool:
        return (
            ".blob.core.windows.net" in url
            or "keka.com/files/" in url
        )

    # ── Phase 1: Collect all SAS URLs via a SINGLE browser session ──
    # claim_id → [{url, filename}]
    collected: dict[str, list[dict]] = {cid: [] for cid in claim_ids}

    with sync_playwright() as p:
        browser, ctx = _new_authenticated_context(p, company)

        # Block bot-detection script so Angular initializes
        ctx.route("**/urlaccessvalidator.js", lambda route: route.fulfill(
            status=200, content_type="application/javascript",
            body="window.urlAccessValidator={validate:()=>Promise.resolve(true)};"
        ))

        for idx, cid in enumerate(claim_ids):
            if on_progress:
                on_progress(idx + 1, len(claim_ids))

            page = ctx.new_page()
            page_files: list[dict] = []

            def on_response(resp, _cid=cid, _pf=page_files):
                if resp.status == 200 and _is_file_url(resp.url):
                    ct = resp.headers.get("content-type", "")
                    if any(x in ct for x in ("pdf", "image", "octet-stream", "jpeg", "png")):
                        fname = resp.url.split("?")[0].split("/")[-1] or f"bill_{len(_pf)}.pdf"
                        _pf.append({"url": resp.url, "filename": fname})

            page.on("response", on_response)

            try:
                page.goto(
                    f"https://{co}.keka.com/home/expense/claim/{cid}",
                    wait_until="networkidle",
                    timeout=25000,
                )
                page.wait_for_timeout(2000)
            except Exception as e:
                log.warning("Navigation error claim %s: %s", cid, e)

            # JS API calls from within the page, using SPA access_token from localStorage
            if not page_files:
                js_script = f"""
                async () => {{
                    const token = localStorage.getItem('access_token') || '';
                    const hdrs = {{
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    }};
                    if (token) hdrs['Authorization'] = 'Bearer ' + token;

                    const paths = [
                        '/api/v1/expense/claims/{cid}',
                        '/api/v1/expense/claims/{cid}/attachments',
                        '/api/v1/expense/claims/{cid}/receipts',
                        '/api/v2/expense/claims/{cid}',
                        '/api/v2/expense/claims/{cid}/attachments',
                    ];

                    const results = {{}};
                    for (const p of paths) {{
                        try {{
                            const r = await fetch(p, {{credentials:'include', headers: hdrs}});
                            results[p] = {{status: r.status, body: await r.text()}};
                        }} catch(e) {{
                            results[p] = {{error: e.toString()}};
                        }}
                    }}
                    return results;
                }}
                """
                try:
                    js_results = page.evaluate(js_script)
                    for api_path, res in (js_results or {}).items():
                        if not isinstance(res, dict) or res.get("status", 0) != 200:
                            log.debug("JS fetch %s: status=%s body=%s",
                                      api_path, res.get("status"), str(res.get("body",""))[:100])
                            continue
                        try:
                            data = json.loads(res["body"])
                        except Exception:
                            continue

                        def _extract_files(obj, depth=0):
                            if depth > 4 or page_files:
                                return
                            if isinstance(obj, list):
                                for item in obj:
                                    _extract_files(item, depth + 1)
                            elif isinstance(obj, dict):
                                url = (obj.get("downloadUrl") or obj.get("url") or
                                       obj.get("fileUrl") or obj.get("blobUrl") or
                                       obj.get("attachmentUrl") or obj.get("receiptUrl") or "")
                                if url and ("blob.core" in url or "keka.com" in url or url.startswith("http")):
                                    fname = (obj.get("fileName") or obj.get("name") or
                                             obj.get("originalName") or f"bill_{len(page_files)}.pdf")
                                    page_files.append({"url": url, "filename": fname})
                                # Recurse into nested objects
                                for key in ("attachments", "receipts", "documents", "files", "data",
                                            "expenses", "expenseItems", "items"):
                                    if key in obj:
                                        _extract_files(obj[key], depth + 1)

                        _extract_files(data)
                        if page_files:
                            log.info("Claim %s: found %d files via JS API %s", cid, len(page_files), api_path)
                            break
                except Exception as e:
                    log.debug("JS API batch failed for %s: %s", cid, e)

            collected[cid] = page_files
            log.info("Claim %s: found %d file URLs", cid, len(page_files))
            page.close()

        browser.close()

    # ── Phase 2: Download all files in parallel ──
    cookie_str = _cookies_to_header(cookies)
    hdrs = {"Cookie": cookie_str, "User-Agent": _UA, "Accept": "*/*"}

    def _download(cid: str, url: str, filename: str) -> tuple[str, Optional[str]]:
        if not any(filename.lower().endswith(ext) for ext in (".pdf", ".jpg", ".jpeg", ".png", ".gif")):
            filename += ".pdf"
        claim_dir = os.path.join(out_dir, cid)
        os.makedirs(claim_dir, exist_ok=True)
        fpath = os.path.join(claim_dir, filename)
        try:
            resp = _req.get(url, headers=hdrs, timeout=60, allow_redirects=True)
            if resp.status_code == 200 and resp.content:
                ct = resp.headers.get("Content-Type", "")
                if "html" not in ct:
                    with open(fpath, "wb") as f:
                        f.write(resp.content)
                    log.info("Saved %s/%s (%d bytes)", cid, filename, len(resp.content))
                    return cid, fpath
        except Exception as e:
            log.warning("Download failed %s: %s", url[:80], e)
        return cid, None

    all_tasks = []
    seen_urls: set[str] = set()
    for cid, files in collected.items():
        for item in files:
            url = item["url"]
            if url not in seen_urls:
                seen_urls.add(url)
                all_tasks.append((cid, url, item["filename"]))

    results: dict[str, list[str]] = {}
    if all_tasks:
        log.info("Downloading %d files in parallel…", len(all_tasks))
        with ThreadPoolExecutor(max_workers=min(20, len(all_tasks))) as pool:
            futures = {pool.submit(_download, cid, url, fname): cid
                       for cid, url, fname in all_tasks}
            for future in as_completed(futures):
                cid, fpath = future.result()
                if fpath:
                    results.setdefault(cid, []).append(fpath)

    total = sum(len(v) for v in results.values())
    log.info("Bulk download complete: %d files across %d claims", total, len(results))
    return results


def _intercept_attachment_url(
    claim_id: str,
    att_id: str,
    cookies: list[dict],
    company: str = None,
) -> Optional[str]:
    """
    Navigate to the expense claim using saved cookies and intercept
    the SAS-signed Azure Blob URL for the attachment.
    Uses sync_playwright so it is safe to call from any thread.
    """
    _ensure_proactor_loop()
    from playwright.sync_api import sync_playwright

    co = company or KEKA_COMPANY_NAME
    captured: list[str] = []

    def _is_file_url(url: str) -> bool:
        return (
            ".blob.core.windows.net" in url
            or (".keka.com/files/" in url)
            or (att_id in url and "?" in url)
            or ("download" in url.lower() and att_id in url)
        )

    with sync_playwright() as p:
        browser, ctx = _new_authenticated_context(p, company)

        def on_request(req):
            if _is_file_url(req.url):
                captured.append(req.url)

        def on_response(resp):
            if resp.status == 200 and _is_file_url(resp.url):
                ct = resp.headers.get("content-type", "")
                if any(x in ct for x in ("pdf", "image", "octet-stream", "jpeg", "png")):
                    captured.append(resp.url)

        ctx.on("request",  on_request)
        ctx.on("response", on_response)

        page = ctx.new_page()
        try:
            page.goto(
                f"https://{co}.keka.com/home/expense/claim/{claim_id}",
                wait_until="networkidle",
                timeout=30000,
            )
        except Exception as e:
            log.warning("Intercept: navigation error: %s", e)

        page.wait_for_timeout(2000)

        for sel in [
            f'a[href*="{att_id}"]',
            'a[href*="documents"]',
            'a[download]',
            'button:has-text("Download")',
            'a:has-text("Download")',
            'a[href$=".pdf"]',
        ]:
            if captured:
                break
            try:
                for el in page.query_selector_all(sel)[:3]:
                    el.click(timeout=3000)
                    page.wait_for_timeout(1500)
                    if captured:
                        break
            except Exception:
                pass

        browser.close()

    for url in captured:
        if ".blob.core.windows.net" in url:
            return url
    return captured[0] if captured else None


def download_attachment_via_session(
    att_id: str,
    att_name: str = "",
    company: str = None,
) -> Optional[bytes]:
    """
    Try to download a Keka attachment using the browser session.
    NOTE: The Keka v1 OAuth API does not expose attachment download URLs,
    and the internal SPA's `/files/{tenant}/{path}` pattern requires the
    actual Azure Blob path (e.g. `expensereceipts/{hash}.jpg`) not the
    attachment UUID. Until that mapping is solved, this function will
    return None for most attachments.
    """
    import requests

    co = company or KEKA_COMPANY_NAME

    try:
        cookies = _get_session_cookies(co)
    except RuntimeError as e:
        log.warning("Session not available: %s", e)
        return None

    base = f"https://{co}.keka.com"
    cookie_str = _cookies_to_header(cookies)
    hdrs = {
        "User-Agent": _UA,
        "Accept":     "*/*",
        "Referer":    f"{base}/",
        "Cookie":     cookie_str,
    }

    # Try a few patterns; if any yields a binary response, return it.
    candidates = [
        f"{base}/files/{att_id}",
        f"{base}/files/original/{att_id}",
    ]
    for url in candidates:
        try:
            r = requests.get(url, headers=hdrs, timeout=60, allow_redirects=True)
            if r.status_code == 200 and len(r.content) > 100:
                ct = r.headers.get("Content-Type", "").lower()
                if not any(x in ct for x in ("html", "json", "xml", "text/plain")):
                    log.info("Downloaded att=%s (%d bytes)", att_id[:8], len(r.content))
                    return r.content
        except Exception as e:
            log.debug("URL %s: %s", url[:80], e)

    return None


def download_claim_attachments_direct(
    claim_id: str,
    expenses_with_attachments: list[dict],
    out_dir: str,
    company: str = None,
) -> list[str]:
    """
    Download all attachment files for a claim using the attachment IDs from
    the expense line items (as returned by the v1 list API).

    `expenses_with_attachments` — list of expense dicts, each containing
    an `attachments` list with `{id, name}` entries.

    Returns list of saved file paths.
    """
    os.makedirs(out_dir, exist_ok=True)
    saved: list[str] = []

    for exp in expenses_with_attachments:
        for att in exp.get("attachments", []):
            att_id   = str(att.get("id")   or "")
            att_name = str(att.get("name") or f"attachment_{att_id[:8]}.pdf")
            if not att_id:
                continue

            data = download_attachment_via_session(att_id, att_name, company)
            if data:
                # Ensure sensible extension
                if not any(att_name.lower().endswith(e) for e in (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp")):
                    att_name += ".pdf"
                fpath = os.path.join(out_dir, att_name)
                # Avoid overwriting if same name from different expenses
                if os.path.exists(fpath):
                    base_n, ext = os.path.splitext(att_name)
                    fpath = os.path.join(out_dir, f"{base_n}_{att_id[:8]}{ext}")
                with open(fpath, "wb") as f:
                    f.write(data)
                saved.append(fpath)
                log.info("Saved %s (%d bytes)", fpath, len(data))
            else:
                log.warning("Could not download att=%s name=%s", att_id[:8], att_name)

    return saved


def get_attachment_bytes_via_session(
    att_id: str,
    claim_id: str = "",
    expense_id: str = "",
    att_name: str = "",
    company: str = None,
) -> Optional[bytes]:
    """Legacy shim — delegates to download_attachment_via_session."""
    return download_attachment_via_session(att_id, att_name, company)
