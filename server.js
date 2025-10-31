// server.js — minimalist "tweet feed" backend
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_HANDLE = (process.env.BOT_HANDLE || "bot_wassy").toLowerCase();
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 min

let db;

// ===== DB SETUP =====
(async () => {
  db = await open({ filename: "./wassy.db", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT UNIQUE,
      sender TEXT,
      recipient TEXT,
      amount REAL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database initialized");

  // run initial scan + schedule repeats
  runScheduledTweetCheck();
  setInterval(runScheduledTweetCheck, SCAN_INTERVAL_MS);
})();

// ===== HELPERS =====
function normalizeHandle(h) {
  return (h || "").replace(/^@/, "").toLowerCase();
}

async function recordPayment(sender, recipient, amount, tweet_id) {
  try {
    await db.run(
      `INSERT OR IGNORE INTO payments (tweet_id, sender, recipient, amount)
       VALUES (?, ?, ?, ?)`,
      [tweet_id, String(sender).toLowerCase(), String(recipient).toLowerCase(), amount]
    );
  } catch (e) {
    console.error("recordPayment error:", e.message);
  }
}

// ===== ROUTES =====
app.get("/", (_, res) =>
  res.send("🟢 WASSY FEED — tracks @bot_wassy send mentions (30 min interval)")
);

// Return all or filtered payments
app.get("/api/payments", async (req, res) => {
  try {
    const { recipient, handle, tweet_id, id } = req.query;
    const filters = [];
    const args = [];

    if (recipient) { filters.push(`recipient=?`); args.push(normalizeHandle(recipient)); }
    if (handle)    { filters.push(`recipient=?`); args.push(normalizeHandle(handle)); }
    if (tweet_id)  { filters.push(`tweet_id=?`);  args.push(String(tweet_id)); }
    if (id)        { filters.push(`id=?`);        args.push(Number(id)); }

    const sql = `SELECT * FROM payments ${
      filters.length ? "WHERE " + filters.join(" AND ") : ""
    } ORDER BY created_at DESC`;

    const rows = await db.all(sql, args);
    res.json({ success: true, payments: rows });
  } catch (e) {
    console.error("/api/payments error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Return pending claims for a user (read-only)
app.get("/api/claims", async (req, res) => {
  try {
    const handle = normalizeHandle(req.query.handle);
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });

    const rows = await db.all(
      `SELECT * FROM payments WHERE recipient=? ORDER BY created_at DESC`,
      [handle]
    );

    res.json({ success: true, claims: rows });
  } catch (e) {
    console.error("/api/claims error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Manual insert (optional)
app.post("/api/record-transaction", async (req, res) => {
  try {
    const { sender, recipient, amount, tweet_id } = req.body;
    if (!sender || !recipient || !amount || !tweet_id)
      return res.status(400).json({ success: false, message: "missing fields" });

    await recordPayment(sender, recipient, amount, tweet_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== X API SCANNER =====
async function runScheduledTweetCheck() {
  if (!X_BEARER_TOKEN) {
    console.warn("⚠️ No X_BEARER_TOKEN set; skipping scan");
    return;
  }
  console.log(`🔍 Checking mentions for @${BOT_HANDLE}...`);

  try {
    const q = encodeURIComponent(`@${BOT_HANDLE} send`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${q}&tweet.fields=author_id,created_at,text`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` }
    });

    if (response.status === 429) {
      console.warn("⚠️ Rate limit reached (429). Skipping this cycle.");
      return;
    }
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`X API error: ${txt}`);
    }

    const data = await response.json();
    if (!data.data?.length) {
      console.log("No new mentions found.");
      return;
    }

    for (const tweet of data.data) {
      const text = tweet.text?.toLowerCase() || "";
      const match = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
      if (!match) continue;

      const recipient = match[1];
      const amount = parseFloat(match[2]);
      const sender = tweet.author_id || "unknown";
      await recordPayment(sender, recipient, amount, tweet.id);
      console.log(`💸 Recorded ${sender} → ${recipient} $${amount} (${tweet.id})`);
    }

    console.log(`✅ Scan complete (${data.data.length} tweets checked).`);
  } catch (e) {
    console.error("X scan error:", e.message);
  }
}

app.listen(PORT, () => console.log(`🚀 WASSY backend listening on ${PORT}`));
