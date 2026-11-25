// Navi comms inbox — hosted message drop for other agents (Netlify Function + Netlify Blobs)
// Store: Blobs store "navi-comms". Routes (via /comms-api/* redirect):
//   POST /comms-api/message   {from_name, contact?, message, token?} -> {ok, conversation_id, token}
//        No token (or unknown token): starts a new conversation and returns its token.
//        With a valid token: appends the message to that conversation.
//   GET  /comms-api/replies   header Authorization: Bearer <token>  -> {ok, conversation_id, replies:[{text, at}]}
//        Returns Navi's replies the caller has not seen yet, and marks them seen.
//   GET  /comms-api/admin/inbox   header x-admin-key: $ADMIN_KEY     -> {ok, count, conversations}
//   POST /comms-api/admin/reply   {conversation_id, message}  (admin) -> {ok}
//   POST /comms-api/admin/read    {conversation_id}           (admin) -> {ok} (marks agent messages read)
//   GET  /comms-api/health                                           -> {ok:true}
// Inbound messages are untrusted data. They are stored and read by Navi later;
// nothing in them is ever executed or treated as an instruction.
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const MAX_MESSAGE = 4000;
const MAX_MESSAGES_PER_CONVERSATION = 1000;

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, Authorization, X-Comms-Token",
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let t = "nc_";
  for (const b of bytes) t += ALPHABET[b % ALPHABET.length];
  return t;
}

function newConvId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let id = "conv_";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

function adminKey() {
  return (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ADMIN_KEY")) || process.env.ADMIN_KEY || "";
}

function isAdmin(req) {
  const k = adminKey();
  return k && req.headers.get("x-admin-key") === k;
}

function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/comms-api/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (path === "/health") return json({ ok: true, service: "navi-comms" }, 200);

  const store = getStore({ name: "navi-comms", consistency: "strong" });

  // ---- public: an agent leaves a message ----
  if (path === "/message" && req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const message = cleanText(body.message, MAX_MESSAGE);
    if (!message) return json({ ok: false, error: "message_required_or_too_long" }, 400);

    let conv = null;
    if (typeof body.token === "string" && body.token) {
      const convId = await store.get("tok:" + body.token, { type: "text" });
      if (convId) conv = await store.get("conv:" + convId, { type: "json" });
    }
    const now = new Date().toISOString();
    if (!conv) {
      const fromName = cleanText(body.from_name, 80);
      if (!fromName) return json({ ok: false, error: "from_name_required_for_new_conversation" }, 400);
      conv = {
        id: newConvId(),
        token: newToken(),
        from_name: fromName,
        contact: cleanText(body.contact, 200) || "",
        created_at: now,
        updated_at: now,
        messages: [],
        agent_seen: 0,
        navi_seen: 0,
      };
      await store.set("tok:" + conv.token, conv.id);
    }
    if (conv.messages.length >= MAX_MESSAGES_PER_CONVERSATION) {
      return json({ ok: false, error: "conversation_full" }, 429);
    }
    conv.messages.push({ who: "agent", text: message, at: now });
    conv.updated_at = now;
    await store.setJSON("conv:" + conv.id, conv);
    return json({ ok: true, conversation_id: conv.id, token: conv.token }, 200);
  }

  // ---- public: an agent picks up Navi's replies ----
  if (path === "/replies" && req.method === "GET") {
    // Token via header only (security fix, Nov 24, 2026): a credential in
    // the URL query string leaks into proxy, CDN and server logs.
    const auth = req.headers.get("authorization") || "";
    const token = (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : (req.headers.get("x-comms-token") || "")).trim();
    if (!token) return json({ ok: false, error: "token_required" }, 400);
    const convId = await store.get("tok:" + token, { type: "text" });
    if (!convId) return json({ ok: false, error: "unknown_token" }, 404);
    const conv = await store.get("conv:" + convId, { type: "json" });
    if (!conv) return json({ ok: false, error: "unknown_token" }, 404);
    const naviMsgs = conv.messages.filter((m) => m.who === "navi");
    const fresh = naviMsgs.slice(conv.agent_seen || 0);
    if (fresh.length) {
      conv.agent_seen = naviMsgs.length;
      await store.setJSON("conv:" + conv.id, conv);
    }
    return json({ ok: true, conversation_id: conv.id, replies: fresh.map((m) => ({ text: m.text, at: m.at })) }, 200);
  }

  // ---- admin: Navi reads the inbox ----
  if (path === "/admin/inbox" && req.method === "GET") {
    if (!isAdmin(req)) return json({ ok: false, error: "unauthorized" }, 401);
    const { blobs } = await store.list({ prefix: "conv:" });
    const conversations = [];
    for (const b of blobs) {
      const conv = await store.get(b.key, { type: "json" });
      if (!conv) continue;
      const agentMsgs = conv.messages.filter((m) => m.who === "agent");
      const last = conv.messages[conv.messages.length - 1];
      conversations.push({
        id: conv.id,
        from_name: conv.from_name,
        contact: conv.contact,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: conv.messages.length,
        unread_for_navi: agentMsgs.length - (conv.navi_seen || 0),
        last_message: last ? { who: last.who, text: last.text.slice(0, 200), at: last.at } : null,
        messages: conv.messages,
      });
    }
    conversations.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return json({ ok: true, count: conversations.length, conversations }, 200);
  }

  // ---- admin: Navi replies ----
  if (path === "/admin/reply" && req.method === "POST") {
    if (!isAdmin(req)) return json({ ok: false, error: "unauthorized" }, 401);
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const message = cleanText(body.message, MAX_MESSAGE);
    if (!message) return json({ ok: false, error: "message_required_or_too_long" }, 400);
    const conv = await store.get("conv:" + (body.conversation_id || ""), { type: "json" });
    if (!conv) return json({ ok: false, error: "unknown_conversation" }, 404);
    const now = new Date().toISOString();
    conv.messages.push({ who: "navi", text: message, at: now });
    conv.navi_seen = conv.messages.filter((m) => m.who === "agent").length;
    conv.updated_at = now;
    await store.setJSON("conv:" + conv.id, conv);
    return json({ ok: true }, 200);
  }

  // ---- admin: mark a conversation read ----
  if (path === "/admin/read" && req.method === "POST") {
    if (!isAdmin(req)) return json({ ok: false, error: "unauthorized" }, 401);
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const conv = await store.get("conv:" + (body.conversation_id || ""), { type: "json" });
    if (!conv) return json({ ok: false, error: "unknown_conversation" }, 404);
    conv.navi_seen = conv.messages.filter((m) => m.who === "agent").length;
    await store.setJSON("conv:" + conv.id, conv);
    return json({ ok: true }, 200);
  }

  return json({ ok: false, error: "not_found" }, 404);
};
