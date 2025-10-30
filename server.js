// server.js
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
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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
      status TEXT DEFAULT 'pending', -- pending | claim_pending | claimed
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  console.log("✅ Database initialized");

  // Kick one scan at boot (don’t spam if rate-limited)
  runScheduledTweetCheck();

  // Then schedule every 30 minutes
  setInterval(runScheduledTweetCheck, SCAN_INTERVAL_MS);
})();

// ===== HELPERS =====
async function upsertMeta(key, value) {
  await db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, String(value)]
  );
}
async function getMeta(key) {
  const row = await db.get(`SELECT value FROM meta WHERE key = ?`, [key]);
  return row?.value ?? null;
}

async function recordPayment(sender, recipient, amount, tweet_id) {
  try {
    await db.run(
      `INSERT OR IGNORE INTO payments (tweet_id, sender, recipient, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [tweet_id, String(sender).toLowerCase(), String(recipient).toLowerCase(), amount]
    );
  } catch (e) {
    console.error("recordPayment error:", e.message);
  }
}

function normalizeHandle(h) {
  if (!h) return "";
  return h.replace(/^@/, "").toLowerCase();
}

// ===== ROUTES =====

// Health
app.get("/", (_, res) =>
  res.send("🟢 WASSY API active — 30-min X mention scans + claim lifecycle online")
);

// List/search payments
// Supports:
//   /api/payments                -> returns raw array of rows
//   /api/payments?id=198...      -> returns {success, status, amount, recipient, from_user, payment, payments:[row]}
//   /api/payments?tweet_id=...   -> same as id
//   /api/payments?recipient=foo  -> array
//   /api/payments?handle=@foo    -> array (alias of recipient)
//   /api/payments?status=pending -> array
app.get("/api/payments", async (req, res) => {
  try {
    const { id, tweet_id, recipient, handle, status } = req.query;

    // Single fetch by id/tweet_id → return object with status to satisfy both FE & DevFun funcs
    const singleKey = id || tweet_id;
    if (singleKey) {
      const row = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [String(singleKey)]);
      if (!row) return res.json({ success: false, message: "not_found" });

      return res.json({
        success: true,
        status: row.status,
        amount: row.amount,
        recipient: row.recipient,
        from_user: row.sender,
        payment: row,
        payments: [row]
      });
    }

    // List with optional filters
    const where = [];
    const args = [];
    if (recipient) {
      where.push(`recipient = ?`);
      args.push(normalizeHandle(recipient));
    }
    if (handle) {
      where.push(`recipient = ?`);
      args.push(normalizeHandle(handle));
    }
    if (status) {
      where.push(`status = ?`);
      args.push(status);
    }

    const sql = `SELECT * FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    const rows = await db.all(sql, args);
    res.json(rows);
  } catch (e) {
    console.error("/api/payments error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Pending claims for a handle
// GET /api/claims?handle=@user
app.get("/api/claims", async (req, res) => {
  try {
    const handle = normalizeHandle(req.query.handle);
    if (!handle) {
      return res.status(400).json({ success: false, message: "handle required" });
    }
    const rows = await db.all(
      `SELECT * FROM payments
       WHERE recipient = ? AND status IN ('pending', 'claim_pending')
       ORDER BY created_at DESC`,
      [handle]
    );
    res.json({ success: true, claims: rows });
  } catch (e) {
    console.error("/api/claims error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Transition: mark claim as "claim_pending" (optional lock to prevent racing)
app.post("/api/mark-claim-pending", async (req, res) => {
  try {
    const { tweet_id, recipient } = req.body;
    if (!tweet_id) return res.status(400).json({ success: false, message: "tweet_id required" });

    const row = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [String(tweet_id)]);
    if (!row) return res.json({ success: false, message: "not_found" });
    if (recipient && normalizeHandle(recipient) !== row.recipient) {
      return res.json({ success: false, message: "recipient_mismatch" });
    }
    if (row.status === "claimed") {
      return res.json({ success: false, message: "already_claimed" });
    }

    if (row.status !== "claim_pending") {
      await db.run(`UPDATE payments SET status = 'claim_pending' WHERE id = ?`, [row.id]);
    }
    const updated = await db.get(`SELECT * FROM payments WHERE id = ?`, [row.id]);
    res.json({ success: true, payment: updated });
  } catch (e) {
    console.error("/api/mark-claim-pending error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Finalize: mark as claimed (ONLY after DevFun confirms success)
app.post("/api/mark-claimed", async (req, res) => {
  try {
    const { tweet_id, recipient } = req.body;
    if (!tweet_id) return res.status(400).json({ success: false, message: "tweet_id required" });

    const row = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [String(tweet_id)]);
    if (!row) return res.json({ success: false, message: "not_found" });
    if (recipient && normalizeHandle(recipient) !== row.recipient) {
      return res.json({ success: false, message: "recipient_mismatch" });
    }
    if (row.status === "claimed") {
      return res.json({ success: true, message: "already_claimed", payment: row });
    }

    await db.run(
      `UPDATE payments SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [row.id]
    );
    const updated = await db.get(`SELECT * FROM payments WHERE id = ?`, [row.id]);
    res.json({ success: true, payment: updated });
  } catch (e) {
    console.error("/api/mark-claimed error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// (Optional) manual record fallback
app.post("/api/record-transaction", async (req, res) => {
  try {
    const { sender, recipient, amount, tweet_id } = req.body;
    if (!sender || !recipient || !amount || !tweet_id) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }
    await recordPayment(sender, recipient, Number(amount), String(tweet_id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== X API SCANNER (every 30 mins) =====
async function runScheduledTweetCheck() {
  if (!X_BEARER_TOKEN) {
    console.warn("⚠️ No X_BEARER_TOKEN set; skipping scan");
    return;
  }

  console.log(`🔍 Checking mentions for @${BOT_HANDLE}...`);

  try {
    const lastSeen = await getMeta("last_seen_tweet_id"); // keep pagination simple
    const q = encodeURIComponent(`@${BOT_HANDLE} send`);
    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${q}&tweet.fields=author_id,created_at,text` +
      (lastSeen ? `&since_id=${lastSeen}` : "");

    const response = await fetch(url, { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } });

    if (response.status === 429) {
      console.warn("⚠️ Rate limit reached (429 Too Many Requests). Skipping this cycle.");
      return;
    }
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`X API error: ${txt}`);
    }

    const data = await response.json();
    if (!data.data || data.data.length === 0) {
      console.log("No mentions found.");
      return;
    }

    // Track the newest tweet id
    let newestId = lastSeen;
    for (const tweet of data.data) {
      const text = (tweet.text || "").toLowerCase();
      // Format: "... send @recipient $5"
      const match = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
      if (match) {
        const recipient = match[1];
        const amount = parseFloat(match[2]);
        const sender = tweet.author_id || "unknown";
        await recordPayment(sender, recipient, amount, tweet.id);
        console.log(`💸 Recorded ${sender} → ${recipient} $${amount} (tweet ${tweet.id})`);
      }
      if (!newestId || BigInt(tweet.id) > BigInt(newestId)) {
        newestId = tweet.id;
      }
    }
    if (newestId) await upsertMeta("last_seen_tweet_id", newestId);

    console.log(`✅ X scan complete (${data.data.length} tweets checked).`);
  } catch (e) {
    console.error("X scan error:", e.message);
  }
}

app.listen(PORT, () => console.log(`🚀 WASSY backend listening on ${PORT}`));
