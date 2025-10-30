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
  // ✅ store DB on Render persistent disk
  db = await open({
    filename: "/mnt/data/wassy.db",
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

  // Run initial scan and schedule repeats
  await runScheduledTweetCheck();
  setInterval(runScheduledTweetCheck, 30 * 60 * 1000); // every 30 min
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
    console.error("💥 recordPayment error:", e.message);
  }
}

// === Routes ===

// Root
app.get("/", (_, res) =>
  res.send("🟢 WASSY backend active — X scan runs every 30min.")
);

// Manual record fallback
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

// ✅ Claim endpoints
app.get("/api/claims", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle)
      return res
        .status(400)
        .json({ success: false, message: "handle required" });

    const rows = await db.all(
      `SELECT * FROM payments WHERE recipient = ? AND status = 'pending' ORDER BY created_at DESC`,
      [handle.toLowerCase()]
    );
    res.json({ success: true, claims: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/claim", async (req, res) => {
  try {
    const { handle, tweet_id } = req.body;
    if (!handle || !tweet_id)
      return res
        .status(400)
        .json({ success: false, message: "Missing handle or tweet_id" });

    const p = await db.get(
      `SELECT * FROM payments WHERE tweet_id = ? AND recipient = ? AND status = 'pending'`,
      [tweet_id, handle.toLowerCase()]
    );

    if (!p)
      return res.json({ success: false, message: "No pending claim found" });

    await db.run(
      `UPDATE payments SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [p.id]
    );

    res.json({ success: true, claimed: p });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ✅ Enhanced /api/payments (supports ?handle= or ?id=)
app.get("/api/payments", async (req, res) => {
  try {
    const { handle, id } = req.query;
    let query = "SELECT * FROM payments";
    const params = [];

    if (id) {
      query += " WHERE id = ?";
      params.push(id);
    } else if (handle) {
      query += " WHERE recipient = ?";
      params.push(handle.toLowerCase());
    }

    query += " ORDER BY created_at DESC";

    const rows = await db.all(query, params);
    res.json(rows);
  } catch (e) {
    console.error("💥 /api/payments error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ✅ Manual scan trigger (for cron or pinger)
app.get("/api/scan", async (_, res) => {
  console.log("🕒 Manual scan triggered via /api/scan");
  await runScheduledTweetCheck();
  res.json({ success: true, message: "Manual scan triggered" });
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
        headers: {
          Authorization: `Bearer ${X_BEARER_TOKEN}`
        }
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
      console.log("ℹ️ No new mentions found.");
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
    console.error("💥 X scan error:", e.message);
  }
}

// Start server
app.listen(PORT, () => console.log(`🚀 WASSY backend listening on ${PORT}`));
