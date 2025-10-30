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

// === DB Setup ===
let db;
(async () => {
  db = await open({
    filename: "./wassy.db",
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT UNIQUE,
      sender TEXT,
      recipient TEXT,
      amount REAL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME
    );
  `);
  console.log("✅ Database initialized");

  // Run periodic X scan
  runScheduledTweetCheck();
  // every 30 minutes
  setInterval(runScheduledTweetCheck, 30 * 60 * 1000);
})();

// === Helpers ===
async function recordPayment(sender, recipient, amount, tweet_id) {
  try {
    await db.run(
      `INSERT OR IGNORE INTO payments (tweet_id, sender, recipient, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [tweet_id, sender.toLowerCase(), recipient.toLowerCase(), amount]
    );
  } catch (e) {
    console.error("recordPayment error:", e.message);
  }
}

// === Routes ===

// Health check
app.get("/", (_, res) => res.send("🟢 WASSY backend active"));

// Manual record (fallback)
app.post("/api/record-transaction", async (req, res) => {
  try {
    const { sender, recipient, amount, tweet_id } = req.body;
    if (!sender || !recipient || !amount)
      return res.status(400).json({ success: false, message: "Missing fields" });

    await recordPayment(sender, recipient, amount, tweet_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Claims lookup
app.get("/api/claims", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle)
      return res.status(400).json({ success: false, message: "handle required" });

    const rows = await db.all(
      `SELECT id, tweet_id, sender, recipient, amount, status, created_at 
       FROM payments 
       WHERE recipient = ? AND status = 'pending' 
       ORDER BY created_at DESC`,
      [handle.toLowerCase()]
    );

    res.json({ success: true, claims: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Claim endpoint (mark claimed)
app.post("/api/claim", async (req, res) => {
  try {
    const { handle, tweet_id } = req.body;
    if (!handle || !tweet_id)
      return res.status(400).json({ success: false, message: "Missing handle or tweet_id" });

    const p = await db.get(
      `SELECT * FROM payments WHERE tweet_id = ? AND recipient = ? AND status = 'pending'`,
      [tweet_id, handle.toLowerCase()]
    );

    if (!p) return res.json({ success: false, message: "No pending claim found" });

    await db.run(
      `UPDATE payments SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [p.id]
    );

    res.json({ success: true, claimed: p });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// === Updated /api/payments route: supports ?id= and ?tweet_id= ===
app.get("/api/payments", async (req, res) => {
  try {
    const { id, tweet_id } = req.query;
    let rows;

    if (tweet_id) {
      rows = await db.all(
        `SELECT id, tweet_id, sender, recipient, amount, status, created_at, claimed_at 
         FROM payments 
         WHERE tweet_id = ?`,
        [tweet_id]
      );
    } else if (id) {
      rows = await db.all(
        `SELECT id, tweet_id, sender, recipient, amount, status, created_at, claimed_at 
         FROM payments 
         WHERE id = ?`,
        [id]
      );
    } else {
      rows = await db.all(
        `SELECT id, tweet_id, sender, recipient, amount, status, created_at, claimed_at 
         FROM payments 
         ORDER BY created_at DESC`
      );
    }

    res.json(rows);
  } catch (e) {
    console.error("💥 /api/payments error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// === X API Scanner ===
async function runScheduledTweetCheck() {
  if (!X_BEARER_TOKEN) {
    console.warn("⚠️ No X_BEARER_TOKEN set; skipping scan");
    return;
  }

  console.log(`🔍 Checking mentions for @${BOT_HANDLE}...`);
  try {
    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=@${BOT_HANDLE}&tweet.fields=author_id,created_at,text`,
      {
        headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` }
      }
    );

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

    for (const tweet of data.data) {
      const text = tweet.text.toLowerCase();
      const match = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
      if (match) {
        const recipient = match[1];
        const amount = parseFloat(match[2]);
        const sender = tweet.author_id || "unknown";
        await recordPayment(sender, recipient, amount, tweet.id);
        console.log(`💸 Recorded ${sender} → ${recipient} $${amount}`);
      }
    }

    console.log(`✅ X scan complete (${data.data.length} tweets checked).`);
  } catch (e) {
    console.error("X scan error:", e.message);
  }
}

// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 WASSY backend listening on ${PORT}`);
});
