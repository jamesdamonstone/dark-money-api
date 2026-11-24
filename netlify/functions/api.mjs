// Dark Money — join + member registry API (Netlify Function + Netlify Blobs)
// Store: Blobs store "members". Routes (via /api/* redirect):
//   POST /api/join          {name, email, style, payout, terms, ref?, password?} -> {ok, member_id, app_url}
//                           (an already-registered email gets 409 {error:"email_taken"} — never the existing ID;
//                           joins are throttled per IP; new members start email_verified:false with a verify_token)
//   POST /api/login         {email, member_id} or {email, password} -> {ok, member} (email + ID must match, or the member's password;
//                           ID login is refused with "password_required" once the member has a password; failed logins are throttled)
//   POST /api/set-password  {member_id, password}               -> {ok} (sets/replaces the member's login password; the member ID is the credential, same as every member route)
//   GET  /api/member?id=dm_xxx                                  -> {ok, member} (public fields only)
//   GET  /api/member?email=a@b.c                                -> {ok, existing} (existence ONLY — no name, no ID; audit P0-1)
//   GET  /api/verify?token=<verify_token>                       -> HTML page (marks the member's email verified; token is single-use)
//   GET  /api/admin/members  header x-admin-key: $ADMIN_KEY     -> {ok, count, members, totals} (unverified members carry verify_token + verify_url)
//   POST /api/admin/payout-code {member_id}  header x-admin-key -> {ok, code, expires} (6-digit payout identity code, 48h; audit P0-3)
//   POST /api/admin/payout-code-clear {member_id} header x-admin-key -> {ok} (clears the payout code after a payout completes)
//   POST /api/payout-request {member_id}                        -> {ok, requested_at} (queues a payout request; no money moves)
//   GET  /api/admin/payout-requests  header x-admin-key         -> {ok, count, requests}
//   POST /api/admin/payout-sent {member_id}  header x-admin-key -> {ok} (marks a request sent, clearing the queue entry)
//   POST /api/checkin       {member_id, date}                   -> {ok, streak, bonus_pct, share_pct} (daily loyalty check-in; date = member's local YYYY-MM-DD)
//   GET  /api/loyalty?id=dm_xxx[&date=YYYY-MM-DD]               -> {ok, streak, bonus_pct, share_pct, lapsed}
//   GET  /api/purchases?id=dm_xxx                               -> {ok, purchases, totals} (member's tracked purchases + balance totals)
//   POST /api/admin/purchases {member_id, purchases[]} header x-admin-key -> {ok, count} (replaces the member's purchase snapshot; fed by ledger reconciliation)
//   GET  /api/local/businesses                                  -> {ok, businesses} (active local businesses, public fields)
//   POST /api/local/claim  {member_id, business_id, amount, receipt} -> {ok, claim} (receipt = data URL photo; fingerprint blocks double-claims)
//   GET  /api/local/claims?id=dm_xxx                            -> {ok, claims, totals} (the member's local claims)
//   GET  /api/admin/local-businesses  header x-admin-key        -> {ok, businesses} (all, incl. inactive)
//   POST /api/admin/local-businesses {businesses[]} header x-admin-key -> {ok, count} (replaces the local registry)
//   GET  /api/admin/local-claims  header x-admin-key            -> {ok, count, claims} (all local claims, newest first)
//   GET  /api/admin/local-receipt?id=lc_xxx  header x-admin-key -> {ok, receipt} (the claim's receipt photo data URL)
//   POST /api/admin/local-claim-decide {claim_id, decision} header x-admin-key -> {ok, claim} (approve credits the member's purchases as confirmed)
//   GET  /api/health                                            -> {ok:true}
// Local (brick-and-mortar, James Nov 24, 2026): businesses pay a % on in-person
// member purchases, verified by the shop's register QR + a receipt photo.
// Same 70/30 split as online. Claims live in the "local" Blobs store; approval
// appends a confirmed purchase to the member's purchases snapshot.
// Loyalty (James's schedule, Nov 22, 2026): daily check-ins build a streak. Day 2 earns +0.1%
// commission share; each further full week of streak adds +0.1%, capped at +5% (share max 75%).
// Missing a day resets the streak and the bonus to zero.
// Referrals (Nov 23, 2026): join accepts an optional `ref` — originally the referring
// member's ID. It is validated against the registry and stored on the new record as
// `referred_by`. (Nov 24, 2026): every member now also has a public referral code
// (`ref_code`, "dmr_" + 8 chars) so invite links never expose the member ID, which
// doubles as a login credential. Join accepts a ref_code OR a legacy member ID and
// records `referred_by` as the referrer's member ID either way.
// Login, member and admin payloads report referral_count plus the referred members'
// first names. Plumbing only — no referral bonus or payout change rides on it yet.
// Member IDs: "dm_" + 10 chars (same format as the local link service).
// Balances are NOT stored here in v1 — the local ledger stays the money source of truth.
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const APP_BASE = "https://darkmoney.strangefawkes.com/app.html";
const ALLOWED_ORIGINS = ["https://darkmoney.strangefawkes.com", "https://strangefawkes.com", "https://jamesdamonstone.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

function newMemberId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let id = "dm_";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

// Referral codes: "dmr_" + 8 chars from the same unambiguous alphabet. Public —
// safe to print in invite links, unlike the member ID.
function newRefCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "dmr_";
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

// Make sure a member record carries a ref_code, generating and indexing one if
// not (records created before ref codes existed get theirs lazily, the first
// time a payload needs it). The "refcode:" index maps code -> member_id so
// join-time resolution never has to scan. Returns the code, or null if a
// unique one could not be minted (payloads then just omit it).
async function ensureRefCode(store, m) {
  if (m && typeof m.ref_code === "string" && /^dmr_[A-Za-z0-9]{8}$/.test(m.ref_code)) return m.ref_code;
  if (!m || !m.member_id) return null;
  for (let i = 0; i < 5; i++) {
    const candidate = newRefCode();
    if (await store.get("refcode:" + candidate)) continue;
    m.ref_code = candidate;
    await store.set("id:" + m.member_id, JSON.stringify(m));
    await store.set("refcode:" + candidate, m.member_id);
    return candidate;
  }
  return null;
}

// Resolve a join `ref` to the referrer's member ID. Accepts a ref_code
// (dmr_…) or a legacy member ID (dm_…) from older invite links; anything
// else — or a code that names nobody — resolves to null and is dropped.
async function resolveRef(store, ref) {
  if (/^dm_[A-Za-z0-9]{10}$/.test(ref)) {
    return (await store.get("id:" + ref)) ? ref : null;
  }
  if (/^dmr_[A-Za-z0-9]{8}$/.test(ref)) {
    const byIndex = await store.get("refcode:" + ref);
    if (byIndex) return byIndex;
    // Fall back to a scan in case an index entry is missing.
    const listing = await store.list({ prefix: "id:" });
    for (const blob of listing.blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        if (m.ref_code === ref) return m.member_id;
      } catch { /* skip corrupt record */ }
    }
  }
  return null;
}

function validEmail(e) {
  return typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
}

function publicMember(m) {
  return { member_id: m.member_id, name: m.name, joined_at: m.joined_at, style: m.style, has_password: !!m.pw, ref_code: m.ref_code || null, email_verified: !!m.email_verified };
}

// Email verification tokens: 24 chars from the same unambiguous alphabet,
// indexed under "vtoken:" -> member_id (same pattern as the refcode index).
// Joining stays instant — the token only marks the address as confirmed
// when its link is clicked; the API sends no mail itself, so the verify
// URL reaches the member through the owner (admin payload carries it).
function newVerifyToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const b of bytes) token += ALPHABET[b % ALPHABET.length];
  return token;
}

// Return the member's verify token, minting + indexing + persisting one if
// needed. Verified members (and token-less lookups that fail) return null.
async function ensureVerifyToken(store, m) {
  if (!m || !m.member_id || m.email_verified) return null;
  if (typeof m.verify_token === "string" && m.verify_token.length >= 24) return m.verify_token;
  for (let i = 0; i < 5; i++) {
    const candidate = newVerifyToken();
    if (await store.get("vtoken:" + candidate)) continue;
    m.verify_token = candidate;
    await store.set("id:" + m.member_id, JSON.stringify(m));
    await store.set("vtoken:" + candidate, m.member_id);
    return candidate;
  }
  return null;
}

// Referral view for one member: everyone whose record points back at them.
// First names only — that is all the member-facing payloads ever show.
async function referralInfo(store, memberId) {
  const listing = await store.list({ prefix: "id:" });
  const referrals = [];
  for (const blob of listing.blobs) {
    const raw = await store.get(blob.key);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw);
      if (m.referred_by === memberId) {
        referrals.push({ name: (m.name || "").trim().split(/\s+/)[0] || "", joined_at: m.joined_at || null });
      }
    } catch { /* skip corrupt record */ }
  }
  referrals.sort((a, b) => (a.joined_at || "").localeCompare(b.joined_at || ""));
  return { referral_count: referrals.length, referrals };
}

// Passwords: PBKDF2-SHA256 via WebCrypto. Only the derived hash + salt are stored
// (on the member record as m.pw); the hash never leaves the server.
const PW_ITERATIONS = 100000;

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hashPassword(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

async function makePasswordRecord(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await hashPassword(password, salt, PW_ITERATIONS);
  return { algo: "pbkdf2-sha256", iter: PW_ITERATIONS, salt: b64(salt), hash: b64(hash), set_at: new Date().toISOString() };
}

async function checkPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const hash = await hashPassword(password, unb64(rec.salt), rec.iter || PW_ITERATIONS);
  const expected = unb64(rec.hash);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

function validPassword(p) {
  return typeof p === "string" && p.length >= 8 && p.length <= 200;
}

// Login throttling: failed-attempt timestamps live in the "security" Blobs
// store, keyed per email and per client IP. After 5 failures for one email
// (or 20 from one IP) inside a rolling 15-minute window, /login answers 429
// until the window passes. A successful login clears the email's counter.
// Every helper swallows store errors — throttling must never break login.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_IP_LIMIT = 20;

function clientIp(req) {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf && nf.trim()) return nf.trim().slice(0, 64);
  const xff = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return xff ? xff.slice(0, 64) : "unknown";
}

async function loadFailList(secStore, key) {
  try {
    const raw = await secStore.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    return parsed.filter((t) => typeof t === "number" && t > cutoff);
  } catch { return []; }
}

async function loginThrottled(secStore, email, ip) {
  try {
    const byEmail = await loadFailList(secStore, "loginfail:email:" + email);
    if (byEmail.length >= LOGIN_EMAIL_LIMIT) return true;
    const byIp = await loadFailList(secStore, "loginfail:ip:" + ip);
    return byIp.length >= LOGIN_IP_LIMIT;
  } catch { return false; }
}

async function recordLoginFailure(secStore, email, ip) {
  try {
    const now = Date.now();
    for (const key of ["loginfail:email:" + email, "loginfail:ip:" + ip]) {
      const list = await loadFailList(secStore, key);
      list.push(now);
      await secStore.set(key, JSON.stringify(list));
    }
  } catch { /* never break login */ }
}

async function clearLoginFailures(secStore, email) {
  try { await secStore.delete("loginfail:email:" + email); } catch { /* never break login */ }
}

// Generic timestamp-list counters in the "security" store — the same
// pattern as the login throttle, with a caller-chosen window. Used for the
// per-IP join throttle and the failed-admin-key guard. Every helper
// swallows store errors: a counter failure must never break a request.
const JOIN_WINDOW_MS = 60 * 60 * 1000;
const JOIN_IP_LIMIT = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_IP_LIMIT = 20;

async function loadTsList(secStore, key, windowMs) {
  try {
    const raw = await secStore.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - windowMs;
    return parsed.filter((t) => typeof t === "number" && t > cutoff);
  } catch { return []; }
}

async function bumpTsList(secStore, key, windowMs) {
  try {
    const list = await loadTsList(secStore, key, windowMs);
    list.push(Date.now());
    await secStore.set(key, JSON.stringify(list));
  } catch { /* never break the request */ }
}

async function joinThrottled(secStore, ip) {
  try {
    const list = await loadTsList(secStore, "join:ip:" + ip, JOIN_WINDOW_MS);
    return list.length >= JOIN_IP_LIMIT;
  } catch { return false; }
}

async function adminThrottled(secStore, ip) {
  try {
    const list = await loadTsList(secStore, "adminfail:ip:" + ip, ADMIN_WINDOW_MS);
    return list.length > ADMIN_IP_LIMIT;
  } catch { return false; }
}

function validDay(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

function shiftDay(dateStr, delta) {
  const parts = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + delta * 86400000);
  return t.toISOString().slice(0, 10);
}

function loyaltyBonus(streak) {
  if (!streak || streak < 2) return 0;
  const b = 0.1 + 0.1 * Math.floor((streak - 2) / 7);
  return Math.round(Math.min(5, b) * 10) / 10;
}

function loyaltyView(rec, todayStr) {
  if (!rec) return { streak: 0, bonus_pct: 0, share_pct: 70, last_date: null, total_checkins: 0, lapsed: false };
  let streak = rec.streak || 0;
  let lapsed = false;
  if (todayStr && rec.last_date && rec.last_date < shiftDay(todayStr, -1)) {
    streak = 0;
    lapsed = true;
  }
  const bonus = loyaltyBonus(streak);
  return {
    streak, bonus_pct: bonus, share_pct: Math.round((70 + bonus) * 10) / 10,
    last_date: rec.last_date || null, total_checkins: rec.total_checkins || 0, lapsed,
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (path === "/health") return json({ ok: true, service: "dark-money-join" }, 200, origin);

  const store = getStore({ name: "members", consistency: "strong" });
  const secStore = getStore({ name: "security", consistency: "strong" });

  // Admin gate, centralized: every /admin/* route needs the admin key.
  // Failed key attempts are counted per IP in the security store; past 20
  // failures inside 15 minutes the IP gets 429s on admin routes until the
  // window passes. The per-route key checks below stay as a backstop.
  if (path.startsWith("/admin/")) {
    const gateIp = clientIp(req);
    if (await adminThrottled(secStore, gateIp)) {
      return json({ ok: false, error: "too_many_attempts" }, 429, origin);
    }
    const gateKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const gateGiven = req.headers.get("x-admin-key") || "";
    if (!gateKey || !gateGiven || gateGiven !== gateKey) {
      await bumpTsList(secStore, "adminfail:ip:" + gateIp, ADMIN_WINDOW_MS);
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
  }

  if (path === "/join" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    // Join throttle: more than 10 joins from one IP in an hour is a bot
    // pattern, not a signup rush. Every attempt counts toward the limit.
    const joinIp = clientIp(req);
    if (await joinThrottled(secStore, joinIp)) {
      return json({ ok: false, error: "too_many_attempts" }, 429, origin);
    }
    await bumpTsList(secStore, "join:ip:" + joinIp, JOIN_WINDOW_MS);

    const name = (data.name || "").toString().trim().slice(0, 120);
    const email = (data.email || "").toString().trim().toLowerCase().slice(0, 254);
    const style = data.style === "agent" ? "agent" : "self";
    const payout = ["paypal", "venmo", "cashapp", "later"].includes(data.payout) ? data.payout : "later";
    const ref = (data.ref || "").toString().trim().slice(0, 40);
    // Optional: a password chosen at join time, stored exactly like one set
    // later through /set-password. Absent/empty means no password yet.
    const joinPassword = typeof data.password === "string" ? data.password : "";

    if (!name) return json({ ok: false, error: "name_required" }, 400, origin);
    if (!validEmail(email)) return json({ ok: false, error: "email_invalid" }, 400, origin);
    if (data.terms !== true) return json({ ok: false, error: "terms_required" }, 400, origin);
    if (joinPassword && !validPassword(joinPassword)) return json({ ok: false, error: "password_too_short" }, 400, origin);

    const existing = await store.get("email:" + email);
    if (existing) {
      // Never hand the existing member's ID back to whoever posted the
      // email — with the ID doubling as a login credential, echoing it
      // was an account-takeover path (audit P0-2). The caller just learns
      // the email is taken; recovery happens out-of-band with the owner.
      return json({ ok: false, error: "email_taken" }, 409, origin);
    }

    let memberId = null;
    for (let i = 0; i < 5 && !memberId; i++) {
      const candidate = newMemberId();
      const taken = await store.get("id:" + candidate);
      if (!taken) memberId = candidate;
    }
    if (!memberId) return json({ ok: false, error: "id_failed" }, 500, origin);

    // Optional referral: keep it only if it names a member who already exists.
    // The ref may be the referrer's ref_code (current invite links) or their
    // member ID (legacy links); either way referred_by stores the member ID.
    // (An existing-email re-join returns above and never rewrites referred_by.)
    const referredBy = ref ? await resolveRef(store, ref) : null;

    // Every member gets a public referral code of their own, indexed for
    // join-time resolution. A mint failure is not fatal — ensureRefCode
    // will generate one lazily on the member's first login/lookup.
    let refCode = null;
    for (let i = 0; i < 5 && !refCode; i++) {
      const candidate = newRefCode();
      if (!(await store.get("refcode:" + candidate))) refCode = candidate;
    }

    // Email verification starts unverified with a single-use token. Joining
    // is still instant — nothing waits on the click; the token just lets
    // the member prove the address is theirs whenever they use the link.
    let verifyToken = null;
    for (let i = 0; i < 5 && !verifyToken; i++) {
      const candidate = newVerifyToken();
      if (!(await store.get("vtoken:" + candidate))) verifyToken = candidate;
    }

    const member = {
      member_id: memberId, name, email, style, payout,
      terms_agreed: true, joined_at: new Date().toISOString(), source: "website",
      email_verified: false,
      ...(verifyToken ? { verify_token: verifyToken } : {}),
      ...(refCode ? { ref_code: refCode } : {}),
      ...(referredBy ? { referred_by: referredBy } : {}),
      ...(joinPassword ? { pw: await makePasswordRecord(joinPassword) } : {}),
    };
    await store.set("id:" + memberId, JSON.stringify(member));
    await store.set("email:" + email, memberId);
    if (refCode) await store.set("refcode:" + refCode, memberId);
    if (verifyToken) await store.set("vtoken:" + verifyToken, memberId);

    return json({ ok: true, member_id: memberId, existing: false, app_url: APP_BASE + "#" + memberId }, 201, origin);
  }

  if (path === "/login" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const email = (data.email || "").toString().trim().toLowerCase().slice(0, 254);
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    const password = typeof data.password === "string" ? data.password : "";

    // Throttle: too many recent failures for this email or from this IP and
    // every further attempt waits out the window, right or wrong.
    const secStore = getStore({ name: "security", consistency: "strong" });
    const ip = clientIp(req);
    if (await loginThrottled(secStore, email, ip)) {
      return json({ ok: false, error: "too_many_attempts" }, 429, origin);
    }
    const fail = async (error, status) => {
      await recordLoginFailure(secStore, email, ip);
      return json({ ok: false, error }, status, origin);
    };

    if (!validEmail(email)) return fail("invalid_credentials", 401);
    const byEmail = await store.get("email:" + email);

    // Password login: email + the password the member set in Account.
    if (password) {
      if (!byEmail) return fail("invalid_credentials", 401);
      const raw = await store.get("id:" + byEmail);
      if (!raw) return fail("invalid_credentials", 401);
      const m = JSON.parse(raw);
      if (!m.pw) return json({ ok: false, error: "no_password_set" }, 401, origin);
      if (!(await checkPassword(password, m.pw))) return fail("invalid_credentials", 401);
      await clearLoginFailures(secStore, email);
      await ensureRefCode(store, m);
      return json({ ok: true, member: { ...publicMember(m), payout: m.payout, ...(await referralInfo(store, m.member_id)) } }, 200, origin);
    }

    // Member-ID login (the original path). One generic failure for both unknown
    // email and mismatched ID — never say which. Once the member has a password,
    // the ID alone no longer logs in: invite links used to print member IDs in
    // public, so the ID is not a secret worth trusting on its own anymore.
    if (!memberId) return fail("invalid_credentials", 401);
    if (!byEmail || byEmail !== memberId) return fail("invalid_credentials", 401);
    const raw = await store.get("id:" + memberId);
    if (!raw) return fail("invalid_credentials", 401);
    const m = JSON.parse(raw);
    if (m.pw) return json({ ok: false, error: "password_required" }, 401, origin);
    await clearLoginFailures(secStore, email);
    await ensureRefCode(store, m);
    return json({ ok: true, member: { ...publicMember(m), payout: m.payout, ...(await referralInfo(store, m.member_id)) } }, 200, origin);
  }

  if (path === "/set-password" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    if (!validPassword(data.password)) return json({ ok: false, error: "password_too_short" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    const m = JSON.parse(raw);
    m.pw = await makePasswordRecord(data.password);
    await store.set("id:" + memberId, JSON.stringify(m));
    return json({ ok: true, member_id: memberId, has_password: true }, 200, origin);
  }

  if (path === "/member" && req.method === "GET") {
    const memberId = url.searchParams.get("id");
    // The ?email= form is an existence check ONLY (audit P0-1): it used to
    // resolve an email to the member's name + ID with no auth, and the ID
    // is a login credential — an identity oracle. It now answers just
    // whether the address is registered, nothing else.
    if (!memberId && url.searchParams.get("email") !== null) {
      const email = (url.searchParams.get("email") || "").trim().toLowerCase();
      const found = email ? await store.get("email:" + email) : null;
      return json({ ok: true, existing: !!found }, 200, origin);
    }
    if (!memberId) return json({ ok: false, error: "not_found" }, 404, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    const m = JSON.parse(raw);
    await ensureRefCode(store, m);
    return json({ ok: true, member: { ...publicMember(m), ...(await referralInfo(store, m.member_id)) } }, 200, origin);
  }

  if (path === "/verify" && req.method === "GET") {
    const page = (status, title, message) => new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>" + title + " — Dark Money</title></head>" +
      "<body style=\"margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0e1420;color:#e8edf5\">" +
      "<main style=\"max-width:430px;margin:12vh auto 0;padding:28px 24px;text-align:center\">" +
      "<h1 style=\"font-size:1.5rem;margin:0 0 12px\">" + title + "</h1>" +
      "<p style=\"color:#aeb9c9;line-height:1.55;margin:0 0 22px\">" + message + "</p>" +
      "<a href=\"" + APP_BASE + "\" style=\"display:inline-block;padding:12px 22px;border-radius:10px;background:#c9a227;color:#14100a;font-weight:700;text-decoration:none\">Open Dark Money</a>" +
      "</main></body></html>",
      { status, headers: { "Content-Type": "text/html; charset=utf-8", ...cors(origin) } }
    );
    const token = (url.searchParams.get("token") || "").trim();
    let memberId = token ? await store.get("vtoken:" + token) : null;
    if (!memberId && token) {
      // Fall back to a scan in case an index entry is missing.
      const listing = await store.list({ prefix: "id:" });
      for (const blob of listing.blobs) {
        const rawRec = await store.get(blob.key);
        if (!rawRec) continue;
        try {
          const rec = JSON.parse(rawRec);
          if (rec.verify_token === token) { memberId = rec.member_id; break; }
        } catch { /* skip corrupt record */ }
      }
    }
    if (!memberId) {
      return page(404, "Link not recognized", "This verification link is invalid or has already been used. If you still need to verify your email, ask Dark Money to send you a fresh link.");
    }
    const raw = await store.get("id:" + memberId);
    if (!raw) {
      return page(404, "Link not recognized", "This verification link is invalid or has already been used. If you still need to verify your email, ask Dark Money to send you a fresh link.");
    }
    const m = JSON.parse(raw);
    m.email_verified = true;
    delete m.verify_token;
    await store.set("id:" + memberId, JSON.stringify(m));
    await store.delete("vtoken:" + token);
    return page(200, "Email verified — you're all set", "Thanks — your email address is confirmed for your Dark Money membership. You can head back to the app.");
  }

  if (path === "/admin/members" && req.method === "GET") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    const listing = await store.list({ prefix: "id:" });
    const members = [];
    for (const blob of listing.blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try { members.push(JSON.parse(raw)); } catch { /* skip corrupt record */ }
    }
    members.sort((a, b) => (b.joined_at || "").localeCompare(a.joined_at || ""));
    const totals = { by_style: {}, by_payout: {}, joined_today: 0 };
    // "Today" in the business's timezone (America/Chicago), not UTC.
    const chicagoDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
    const today = chicagoDay(new Date().toISOString());
    for (const m of members) {
      totals.by_style[m.style] = (totals.by_style[m.style] || 0) + 1;
      totals.by_payout[m.payout] = (totals.by_payout[m.payout] || 0) + 1;
      if (m.joined_at && chicagoDay(m.joined_at) === today) totals.joined_today += 1;
    }
    for (const m of members) {
      m.has_password = !!m.pw;
      m.email_verified = !!m.email_verified;
      if (!m.email_verified) {
        // Mint a verify token for members who don't have one yet (records
        // that predate verification, or a failed join-time mint) so the
        // owner can send the link manually. ensureVerifyToken persists the
        // FULL record, so it must run before pw is stripped just below.
        const tok = await ensureVerifyToken(store, m);
        if (tok) m.verify_url = "https://api.strangefawkes.com/api/verify?token=" + tok;
      } else {
        delete m.verify_token;
      }
      delete m.pw; // password hashes never leave the server, not even to the owner view
      let rec = null;
      const recRaw = await store.get("loyalty:" + m.member_id);
      if (recRaw) { try { rec = JSON.parse(recRaw); } catch { rec = null; } }
      m.loyalty = loyaltyView(rec, null);
    }
    // Referral counts in a single pass over the loaded records (referred_by is
    // already on each record; first names only, matching the member payloads).
    const byReferrer = {};
    for (const m of members) {
      if (m.referred_by) (byReferrer[m.referred_by] = byReferrer[m.referred_by] || []).push(m);
    }
    for (const m of members) {
      const list = byReferrer[m.member_id] || [];
      m.referral_count = list.length;
      m.referrals = list.map((r) => ({
        name: (r.name || "").trim().split(/\s+/)[0] || "", joined_at: r.joined_at || null,
      }));
    }
    return json({ ok: true, count: members.length, totals, members }, 200, origin);
  }

  if (path === "/payout-request" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    const m = JSON.parse(raw);

    // One open request per member — a second tap returns the existing request.
    const existingRaw = await store.get("payout:" + memberId);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw);
        if (existing.status === "requested") {
          return json({ ok: true, existing: true, requested_at: existing.requested_at }, 200, origin);
        }
      } catch { /* fall through and record a fresh request */ }
    }

    const record = {
      member_id: memberId, name: m.name, email: m.email, payout: m.payout,
      requested_at: new Date().toISOString(), status: "requested",
    };
    await store.set("payout:" + memberId, JSON.stringify(record));
    return json({ ok: true, existing: false, requested_at: record.requested_at }, 201, origin);
  }

  if (path === "/admin/payout-requests" && req.method === "GET") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    const listing = await store.list({ prefix: "payout:" });
    const requests = [];
    for (const blob of listing.blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try { requests.push(JSON.parse(raw)); } catch { /* skip corrupt record */ }
    }
    requests.sort((a, b) => (a.requested_at || "").localeCompare(b.requested_at || ""));
    return json({ ok: true, count: requests.length, requests }, 200, origin);
  }

  if (path === "/admin/payout-sent" && req.method === "POST") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    const raw = await store.get("payout:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    const record = JSON.parse(raw);
    record.status = "sent";
    record.sent_at = new Date().toISOString();
    await store.set("payout:" + memberId, JSON.stringify(record));
    return json({ ok: true, member_id: memberId, sent_at: record.sent_at }, 200, origin);
  }

  // Payout identity codes (audit P0-3): before paying, the owner generates
  // a one-off 6-digit code here and sends it to the member's stored email.
  // The member quotes it back from that address — proof the payout request
  // really comes from the account's owner. The code lives only on the
  // member record (admin-visible) and in this route's response; it never
  // appears in publicMember or any login payload.
  if (path === "/admin/payout-code" && req.method === "POST") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    const m = JSON.parse(raw);
    const code = String((crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000);
    m.payout_code = code;
    m.payout_code_expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    m.payout_code_used = false;
    await store.set("id:" + memberId, JSON.stringify(m));
    return json({ ok: true, code, expires: m.payout_code_expires }, 200, origin);
  }

  if (path === "/admin/payout-code-clear" && req.method === "POST") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    const m = JSON.parse(raw);
    delete m.payout_code;
    delete m.payout_code_expires;
    delete m.payout_code_used;
    await store.set("id:" + memberId, JSON.stringify(m));
    return json({ ok: true, member_id: memberId }, 200, origin);
  }

  if (path === "/checkin" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    const date = (data.date || "").toString().trim().slice(0, 10);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    if (!validDay(date)) return json({ ok: false, error: "invalid_date" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);

    let rec = null;
    const recRaw = await store.get("loyalty:" + memberId);
    if (recRaw) { try { rec = JSON.parse(recRaw); } catch { rec = null; } }
    if (!rec) rec = { streak: 0, last_date: null, total_checkins: 0 };

    let already = false;
    if (rec.last_date === date) {
      already = true;
    } else if (rec.last_date === shiftDay(date, -1)) {
      rec.streak = (rec.streak || 0) + 1;
      rec.last_date = date;
      rec.total_checkins = (rec.total_checkins || 0) + 1;
    } else {
      // First ever check-in, or a missed day — the streak (re)starts at 1.
      rec.streak = 1;
      rec.last_date = date;
      rec.total_checkins = (rec.total_checkins || 0) + 1;
    }
    await store.set("loyalty:" + memberId, JSON.stringify(rec));
    const view = loyaltyView(rec, date);
    return json({ ok: true, already_checked_in: already, ...view }, 200, origin);
  }

  if (path === "/loyalty" && req.method === "GET") {
    const memberId = (url.searchParams.get("id") || "").trim();
    const date = (url.searchParams.get("date") || "").trim().slice(0, 10);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    let rec = null;
    const recRaw = await store.get("loyalty:" + memberId);
    if (recRaw) { try { rec = JSON.parse(recRaw); } catch { rec = null; } }
    return json({ ok: true, member_id: memberId, ...loyaltyView(rec, validDay(date) ? date : null) }, 200, origin);
  }

  if (path === "/purchases" && req.method === "GET") {
    const memberId = (url.searchParams.get("id") || "").trim();
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    let purchases = [];
    const pRaw = await store.get("purchases:" + memberId);
    if (pRaw) { try { const parsed = JSON.parse(pRaw); if (Array.isArray(parsed)) purchases = parsed; } catch { purchases = []; } }
    const totals = { pending: 0, confirmed: 0, paid: 0 };
    for (const p of purchases) {
      if (totals[p.status] !== undefined) totals[p.status] = Math.round((totals[p.status] + (p.member_share || 0)) * 100) / 100;
    }
    return json({ ok: true, member_id: memberId, purchases, totals }, 200, origin);
  }

  if (path === "/admin/purchases" && req.method === "POST") {
    const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
    const given = req.headers.get("x-admin-key") || "";
    if (!adminKey || !given || given !== adminKey) {
      return json({ ok: false, error: "unauthorized" }, 401, origin);
    }
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    if (!Array.isArray(data.purchases) || data.purchases.length > 500) {
      return json({ ok: false, error: "invalid_purchases" }, 400, origin);
    }
    const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
    const clean = data.purchases.map((p, i) => ({
      id: (p && p.id ? String(p.id) : "purchase_" + (i + 1)).slice(0, 80),
      store: (p && p.store ? String(p.store) : "Store").slice(0, 120),
      date: validDay(p && p.date) ? p.date : null,
      sale_amount: money(p && p.sale_amount),
      commission: money(p && p.commission),
      member_share: money(p && p.member_share),
      status: ["pending", "confirmed", "paid", "reversed"].includes(p && p.status) ? p.status : "pending",
    }));
    await store.set("purchases:" + memberId, JSON.stringify(clean));
    return json({ ok: true, member_id: memberId, count: clean.length }, 200, origin);
  }

  // ---------------- Local (brick-and-mortar) ----------------
  const localStore = getStore({ name: "local", consistency: "strong" });
  const adminKey = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
  const isAdmin = () => {
    const given = req.headers.get("x-admin-key") || "";
    return !!adminKey && !!given && given === adminKey;
  };
  const money2 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };

  async function loadBusinesses() {
    const rawBiz = await localStore.get("businesses");
    if (!rawBiz) return [];
    try { const parsed = JSON.parse(rawBiz); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  function publicBusiness(b) {
    return {
      id: b.id, name: b.name, category: b.category || "", address: b.address || "",
      lat: b.lat, lng: b.lng, rate_pct: b.rate_pct,
      member_pct: Math.round(b.rate_pct * 0.7 * 100) / 100, blurb: b.blurb || "",
    };
  }
  async function loadClaims() {
    const listing = await localStore.list({ prefix: "claim:" });
    const claims = [];
    for (const blob of listing.blobs) {
      const rawClaim = await localStore.get(blob.key);
      if (!rawClaim) continue;
      try { claims.push(JSON.parse(rawClaim)); } catch { /* skip corrupt record */ }
    }
    claims.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return claims;
  }

  // Receipt photos are the privacy-sensitive part of a claim, so they are
  // only kept for 30 days after the claim is decided. The claim record
  // itself (amounts, status, receipt_hash) is kept forever — it is the
  // audit trail, and the hash is what blocks duplicate claims.
  const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  function receiptDeleteAfterMs(claim) {
    // When this decided claim's receipt photo becomes eligible for deletion.
    if (claim.receipt_delete_after) {
      const t = Date.parse(claim.receipt_delete_after);
      if (Number.isFinite(t)) return t;
    }
    // Claims decided before the retention stamp existed: decision + 30 days,
    // falling back to creation + 30 days when no decision time was recorded.
    const basis = claim.decided_at || claim.created_at;
    const t = basis ? Date.parse(basis) : NaN;
    return Number.isFinite(t) ? t + RECEIPT_RETENTION_MS : NaN;
  }
  async function sweepOldReceipts(store) {
    // Lazy retention sweep: delete receipt blobs for decided claims past
    // their 30-day window and mark the claim receipt_deleted. Pending
    // claims are never touched. Fully error-swallowing — a sweep failure
    // must never break the request that triggered it.
    try {
      const now = Date.now();
      const listing = await store.list({ prefix: "claim:" });
      for (const blob of listing.blobs) {
        try {
          const rawClaim = await store.get(blob.key);
          if (!rawClaim) continue;
          let claim;
          try { claim = JSON.parse(rawClaim); } catch { continue; }
          if (!claim || claim.status === "pending" || claim.receipt_deleted) continue;
          const due = receiptDeleteAfterMs(claim);
          if (!Number.isFinite(due) || now < due) continue;
          const id = claim.id || blob.key.slice("claim:".length);
          await store.delete("receipt:" + id);
          claim.receipt_deleted = true;
          if (!claim.receipt_delete_after) claim.receipt_delete_after = new Date(due).toISOString();
          await store.set(blob.key, JSON.stringify(claim));
        } catch { /* skip this claim; never break the sweep */ }
      }
    } catch { /* sweep is best-effort only */ }
  }

  if (path === "/local/businesses" && req.method === "GET") {
    const businesses = (await loadBusinesses()).filter((b) => b.active !== false).map(publicBusiness);
    return json({ ok: true, businesses }, 200, origin);
  }

  if (path === "/local/claim" && req.method === "POST") {
    await sweepOldReceipts(localStore);
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    const businessId = (data.business_id || "").toString().trim().slice(0, 60);
    const amount = money2(data.amount);
    const receipt = typeof data.receipt === "string" ? data.receipt : "";

    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const memberRaw = await store.get("id:" + memberId);
    if (!memberRaw) return json({ ok: false, error: "invalid_member" }, 404, origin);
    const member = JSON.parse(memberRaw);

    const business = (await loadBusinesses()).find((b) => b.id === businessId && b.active !== false);
    if (!business) return json({ ok: false, error: "business_not_found" }, 404, origin);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 10000) {
      return json({ ok: false, error: "invalid_amount" }, 400, origin);
    }
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(receipt) || receipt.length > 2000000) {
      return json({ ok: false, error: "receipt_required" }, 400, origin);
    }

    // One claim per receipt photo, ever: fingerprint the photo data and refuse
    // a second live claim carrying the same fingerprint.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt));
    const receiptHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const allClaims = await loadClaims();
    const dupe = allClaims.find((c) => c.receipt_hash === receiptHash && c.status !== "rejected");
    if (dupe) return json({ ok: false, error: "receipt_already_claimed" }, 409, origin);

    let claimId = null;
    for (let i = 0; i < 5 && !claimId; i++) {
      const candidate = "lc_" + newMemberId().slice(3);
      if (!(await localStore.get("claim:" + candidate))) claimId = candidate;
    }
    if (!claimId) return json({ ok: false, error: "id_failed" }, 500, origin);

    const commission = Math.round(amount * business.rate_pct) / 100;
    const claim = {
      id: claimId, member_id: memberId, member_name: member.name || "",
      business_id: business.id, business_name: business.name,
      amount, rate_pct: business.rate_pct,
      commission, member_share: Math.round(commission * 70) / 100,
      status: "pending", created_at: new Date().toISOString(), receipt_hash: receiptHash,
    };
    await localStore.set("receipt:" + claimId, receipt);
    await localStore.set("claim:" + claimId, JSON.stringify(claim));
    return json({ ok: true, claim }, 201, origin);
  }

  if (path === "/local/claims" && req.method === "GET") {
    const memberId = (url.searchParams.get("id") || "").trim();
    if (!/^dm_[A-Za-z0-9]{10}$/.test(memberId)) return json({ ok: false, error: "invalid_member" }, 400, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    const claims = (await loadClaims())
      .filter((c) => c.member_id === memberId)
      .map((c) => ({
        id: c.id, business_name: c.business_name, amount: c.amount, rate_pct: c.rate_pct,
        member_share: c.member_share, status: c.status, created_at: c.created_at,
      }));
    const totals = { pending: 0, approved: 0 };
    for (const c of claims) {
      if (c.status === "pending") totals.pending = Math.round((totals.pending + c.member_share) * 100) / 100;
      if (c.status === "approved") totals.approved = Math.round((totals.approved + c.member_share) * 100) / 100;
    }
    return json({ ok: true, member_id: memberId, claims, totals }, 200, origin);
  }

  if (path === "/admin/local-businesses" && req.method === "GET") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401, origin);
    return json({ ok: true, businesses: await loadBusinesses() }, 200, origin);
  }

  if (path === "/admin/local-businesses" && req.method === "POST") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401, origin);
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    if (!Array.isArray(data.businesses) || data.businesses.length > 200) {
      return json({ ok: false, error: "invalid_businesses" }, 400, origin);
    }
    const clean = [];
    for (const b of data.businesses) {
      const id = (b && b.id ? String(b.id) : "").trim().slice(0, 60);
      const name = (b && b.name ? String(b.name) : "").trim().slice(0, 120);
      const lat = Number(b && b.lat), lng = Number(b && b.lng), rate = Number(b && b.rate_pct);
      if (!/^lb_[a-z0-9][a-z0-9-]{1,50}$/.test(id) || !name) return json({ ok: false, error: "invalid_business" }, 400, origin);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return json({ ok: false, error: "invalid_business" }, 400, origin);
      }
      if (!Number.isFinite(rate) || rate <= 0 || rate > 50) return json({ ok: false, error: "invalid_business" }, 400, origin);
      clean.push({
        id, name, category: String(b.category || "").slice(0, 60), address: String(b.address || "").slice(0, 200),
        lat, lng, rate_pct: Math.round(rate * 100) / 100, blurb: String(b.blurb || "").slice(0, 300),
        active: b.active !== false,
      });
    }
    await localStore.set("businesses", JSON.stringify(clean));
    return json({ ok: true, count: clean.length }, 200, origin);
  }

  if (path === "/admin/local-claims" && req.method === "GET") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401, origin);
    await sweepOldReceipts(localStore);
    const claims = await loadClaims();
    return json({ ok: true, count: claims.length, claims }, 200, origin);
  }

  if (path === "/admin/local-receipt" && req.method === "GET") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401, origin);
    const claimId = (url.searchParams.get("id") || "").trim();
    if (!/^lc_[A-Za-z0-9]{10}$/.test(claimId)) return json({ ok: false, error: "invalid_claim" }, 400, origin);
    const receipt = await localStore.get("receipt:" + claimId);
    if (!receipt) return json({ ok: false, error: "not_found" }, 404, origin);
    return json({ ok: true, claim_id: claimId, receipt }, 200, origin);
  }

  if (path === "/admin/local-claim-decide" && req.method === "POST") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401, origin);
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }
    const claimId = (data.claim_id || "").toString().trim().slice(0, 40);
    const decision = data.decision === "approve" ? "approved" : data.decision === "reject" ? "rejected" : null;
    if (!/^lc_[A-Za-z0-9]{10}$/.test(claimId) || !decision) return json({ ok: false, error: "invalid_claim" }, 400, origin);
    const claimRaw = await localStore.get("claim:" + claimId);
    if (!claimRaw) return json({ ok: false, error: "not_found" }, 404, origin);
    const claim = JSON.parse(claimRaw);
    if (claim.status !== "pending") return json({ ok: true, claim, already_decided: true }, 200, origin);
    claim.status = decision;
    if (!claim.decided_at) claim.decided_at = new Date().toISOString();
    // The receipt photo is deleted 30 days after the decision (lazy sweep).
    claim.receipt_delete_after = new Date(new Date(claim.decided_at).getTime() + RECEIPT_RETENTION_MS).toISOString();
    await localStore.set("claim:" + claimId, JSON.stringify(claim));

    if (decision === "approved") {
      // Credit the member: append a confirmed purchase to their snapshot.
      // If the business never pays, reverse it through /admin/purchases —
      // the standard clawback path.
      let purchases = [];
      const pRaw = await store.get("purchases:" + claim.member_id);
      if (pRaw) { try { const parsed = JSON.parse(pRaw); if (Array.isArray(parsed)) purchases = parsed; } catch { purchases = []; } }
      if (!purchases.some((p) => p.id === claim.id)) {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(claim.created_at));
        purchases.push({
          id: claim.id, store: claim.business_name + " (Local)", date: day,
          sale_amount: claim.amount, commission: claim.commission,
          member_share: claim.member_share, status: "confirmed",
        });
        await store.set("purchases:" + claim.member_id, JSON.stringify(purchases));
      }
    }
    return json({ ok: true, claim }, 200, origin);
  }

  return json({ ok: false, error: "route_not_found" }, 404, origin);
};
