import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const {
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  ALLOWED_ORIGINS = "",
  N8N_WEBHOOK_URL = "",
  FRONTEND_URL = ""
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false }
});

const app = express();

// ---- CORS ----
const origins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origins.length === 0 || origins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: false
}));
app.use(express.json());

// ---- helpers ----
const norm = (h) => (h || "").replace(/^@/, "").trim().toLowerCase();

async function ensureProfile(handle, { wallet, profile_image } = {}) {
  handle = norm(handle);

  const { data: profiles, error: pErr } = await supabase
    .from("profiles")
    .upsert(
      { handle, wallet: wallet || null, profile_image: profile_image || null },
      { onConflict: "handle" }
    )
    .select("*");

  if (pErr) throw pErr;
  const p = Array.isArray(profiles) ? profiles[0] : profiles;

  const { data: balances, error: bErr } = await supabase
    .from("balances")
    .upsert({ handle, balance_usdc: 0 }, { onConflict: "handle" })
    .select("*");

  if (bErr && bErr.code !== "23505") throw bErr;

  return p;
}

async function getBalance(handle) {
  handle = norm(handle);
  const { data, error } = await supabase
    .from("balances")
    .select("*")
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.balance_usdc) : 0;
}

async function setBalance(handle, value) {
  handle = norm(handle);
  const { error } = await supabase
    .from("balances")
    .upsert({ handle, balance_usdc: Number(value) }, { onConflict: "handle" });
  if (error) throw error;
}

async function addLedger(row) {
  const { data, error } = await supabase.from("ledger").insert(row).select("*");
  if (error) throw error;

  const d = Array.isArray(data) ? data[0] : data;

  if (N8N_WEBHOOK_URL) {
    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(d)
      });
    } catch (e) {
      console.warn("n8n notify failed:", e.message);
    }
  }
  return d;
}

// ---- routes ----

app.get("/", (_, res) => {
  res.send(`🟢 WASSY API up. Frontend: ${FRONTEND_URL || "n/a"}`);
});

app.get("/api/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// register or ensure user
app.post("/api/register", async (req, res) => {
  try {
    const { handle, wallet, profile_image } = req.body || {};
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });
    const p = await ensureProfile(handle, { wallet, profile_image });
    res.json({ success: true, profile: p });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "register failed", error: e.message });
  }
});

// get profile + balance
app.get("/api/profile", async (req, res) => {
  try {
    const handle = norm(req.query.handle);
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });

    const { data: p, error } = await supabase.from("profiles").select("*").eq("handle", handle).maybeSingle();
    if (error) throw error;
    if (!p) return res.json({ success: false, message: "not found" });

    const bal = await getBalance(handle);
    res.json({ success: true, profile: p, balance: bal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "profile failed", error: e.message });
  }
});

// deposit (mock)
app.post("/api/deposit", async (req, res) => {
  try {
    let { handle, amount } = req.body || {};
    if (!handle || !amount) return res.status(400).json({ success: false, message: "handle and amount required" });

    handle = norm(handle);
    amount = Number(amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "amount must be > 0" });

    await ensureProfile(handle);
    const bal = await getBalance(handle);
    await setBalance(handle, bal + amount);

    const row = await addLedger({ kind: "deposit", from_handle: null, to_handle: handle, amount, meta: {} });
    res.json({ success: true, new_balance: bal + amount, ledger: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "deposit failed", error: e.message });
  }
});

// payment
app.post("/api/payment", async (req, res) => {
  try {
    let { from, to, amount } = req.body || {};
    if (!from || !to || !amount) return res.status(400).json({ success: false, message: "from, to, amount required" });

    from = norm(from);
    to = norm(to);
    amount = Number(amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "amount must be > 0" });
    if (from === to) return res.status(400).json({ success: false, message: "cannot send to self" });

    await ensureProfile(from);
    await ensureProfile(to);

    const balFrom = await getBalance(from);
    if (balFrom < amount) return res.status(402).json({ success: false, message: "insufficient funds" });

    const balTo = await getBalance(to);

    await setBalance(from, balFrom - amount);
    await setBalance(to, balTo + amount);

    const row = await addLedger({ kind: "send", from_handle: from, to_handle: to, amount, meta: {} });
    res.json({ success: true, ledger: row, balances: { [from]: balFrom - amount, [to]: balTo + amount } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "payment failed", error: e.message });
  }
});

// list payments
app.get("/api/payments", async (req, res) => {
  try {
    const handle = norm(req.query.handle);
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });

    const { data, error } = await supabase
      .from("ledger")
      .select("*")
      .or(`from_handle.eq.${handle},to_handle.eq.${handle}`)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    const bal = await getBalance(handle);
    res.json({ success: true, balance: bal, items: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "list failed", error: e.message });
  }
});

// X webhook parser
app.post("/api/handleTweet", async (req, res) => {
  try {
    const { tweet_id, text, sender_handle } = req.body || {};
    if (!tweet_id || !text || !sender_handle)
      return res.status(400).json({ success: false, message: "tweet_id, text, sender_handle required" });

    const m = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
    if (!m) return res.json({ success: false, message: "no command" });

    const to = norm(m[1]);
    const amount = Number(m[2]);
    const from = norm(sender_handle);

    const resp = await fetch(`${req.protocol}://${req.get("host")}/api/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to, amount })
    });

    const payload = await resp.json();
    res.json({ success: true, relayed: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "relay failed", error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WASSY API listening on :${PORT}`);
});
