// Dark Money — join + member registry API (Netlify Function + Netlify Blobs)
// Store: Blobs store "members". Routes (via /api/* redirect):
//   POST /api/join          {name, email, style, payout, terms} -> {ok, member_id, app_url}
//   POST /api/login         {email, member_id} or {email, password} -> {ok, member} (email + ID must match, or the member's password)
//   POST /api/set-password  {member_id, password}               -> {ok} (sets/replaces the member's login password; the member ID is the credential, same as every member route)
//   GET  /api/member?id=dm_xxx | ?email=a@b.c                   -> {ok, member} (public fields only)
//   GET  /api/admin/members  header x-admin-key: $ADMIN_KEY     -> {ok, count, members, totals}
//   POST /api/payout-request {member_id}                        -> {ok, requested_at} (queues a payout request; no money moves)
//   GET  /api/admin/payout-requests  header x-admin-key         -> {ok, count, requests}
//   POST /api/admin/payout-sent {member_id}  header x-admin-key -> {ok} (marks a request sent, clearing the queue entry)
//   POST /api/checkin       {member_id, date}                   -> {ok, streak, bonus_pct, share_pct} (daily loyalty check-in; date = member's local YYYY-MM-DD)
//   GET  /api/loyalty?id=dm_xxx[&date=YYYY-MM-DD]               -> {ok, streak, bonus_pct, share_pct, lapsed}
//   GET  /api/purchases?id=dm_xxx                               -> {ok, purchases, totals} (member's tracked purchases + balance totals)
//   POST /api/admin/purchases {member_id, purchases[]} header x-admin-key -> {ok, count} (replaces the member's purchase snapshot; fed by ledger reconciliation)
//   GET  /api/health                                            -> {ok:true}
// Loyalty (James's schedule, Nov 22, 2026): daily check-ins build a streak. Day 2 earns +0.1%
// commission share; each further full week of streak adds +0.1%, capped at +5% (share max 75%).
// Missing a day resets the streak and the bonus to zero.
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

function validEmail(e) {
  return typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
}

function publicMember(m) {
  return { member_id: m.member_id, name: m.name, joined_at: m.joined_at, style: m.style, has_password: !!m.pw };
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

  if (path === "/join" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const name = (data.name || "").toString().trim().slice(0, 120);
    const email = (data.email || "").toString().trim().toLowerCase().slice(0, 254);
    const style = data.style === "agent" ? "agent" : "self";
    const payout = ["paypal", "venmo", "cashapp", "later"].includes(data.payout) ? data.payout : "later";

    if (!name) return json({ ok: false, error: "name_required" }, 400, origin);
    if (!validEmail(email)) return json({ ok: false, error: "email_invalid" }, 400, origin);
    if (data.terms !== true) return json({ ok: false, error: "terms_required" }, 400, origin);

    const existing = await store.get("email:" + email);
    if (existing) {
      return json({ ok: true, member_id: existing, existing: true, app_url: APP_BASE + "#" + existing }, 200, origin);
    }

    let memberId = null;
    for (let i = 0; i < 5 && !memberId; i++) {
      const candidate = newMemberId();
      const taken = await store.get("id:" + candidate);
      if (!taken) memberId = candidate;
    }
    if (!memberId) return json({ ok: false, error: "id_failed" }, 500, origin);

    const member = {
      member_id: memberId, name, email, style, payout,
      terms_agreed: true, joined_at: new Date().toISOString(), source: "website",
    };
    await store.set("id:" + memberId, JSON.stringify(member));
    await store.set("email:" + email, memberId);

    return json({ ok: true, member_id: memberId, existing: false, app_url: APP_BASE + "#" + memberId }, 201, origin);
  }

  if (path === "/login" && req.method === "POST") {
    let data;
    try { data = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400, origin); }

    const email = (data.email || "").toString().trim().toLowerCase().slice(0, 254);
    const memberId = (data.member_id || "").toString().trim().slice(0, 40);
    const password = typeof data.password === "string" ? data.password : "";

    if (!validEmail(email)) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
    const byEmail = await store.get("email:" + email);

    // Password login: email + the password the member set in Account.
    if (password) {
      if (!byEmail) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
      const raw = await store.get("id:" + byEmail);
      if (!raw) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
      const m = JSON.parse(raw);
      if (!m.pw) return json({ ok: false, error: "no_password_set" }, 401, origin);
      if (!(await checkPassword(password, m.pw))) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
      return json({ ok: true, member: { ...publicMember(m), payout: m.payout } }, 200, origin);
    }

    // Member-ID login (the original path). One generic failure for both unknown
    // email and mismatched ID — never say which.
    if (!memberId) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
    if (!byEmail || byEmail !== memberId) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "invalid_credentials" }, 401, origin);
    const m = JSON.parse(raw);
    return json({ ok: true, member: { ...publicMember(m), payout: m.payout } }, 200, origin);
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
    let memberId = url.searchParams.get("id");
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    if (!memberId && email) memberId = await store.get("email:" + email);
    if (!memberId) return json({ ok: false, error: "not_found" }, 404, origin);
    const raw = await store.get("id:" + memberId);
    if (!raw) return json({ ok: false, error: "not_found" }, 404, origin);
    const m = JSON.parse(raw);
    return json({ ok: true, member: publicMember(m) }, 200, origin);
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
      delete m.pw; // password hashes never leave the server, not even to the owner view
      let rec = null;
      const recRaw = await store.get("loyalty:" + m.member_id);
      if (recRaw) { try { rec = JSON.parse(recRaw); } catch { rec = null; } }
      m.loyalty = loyaltyView(rec, null);
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

  return json({ ok: false, error: "route_not_found" }, 404, origin);
};
