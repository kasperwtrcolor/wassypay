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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS fund_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT,
      amount REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database initialized");

  // Run scan at boot
  runScheduledTweetCheck();

  // Schedule every 30 minutes
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
    const s = String(sender).toLowerCase();
    const r = String(recipient).toLowerCase();
    const a = Number(amount);

    // Skip if same tweet already exists
    const existingByTweet = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [tweet_id]);
    if (existingByTweet) {
      console.log(`⛔ Tweet ${tweet_id} already recorded — skipping`);
      return;
    }

    // Skip logical duplicates (same sender, recipient, amount in last 2h)
    const dup = await db.get(
      `SELECT * FROM payments 
       WHERE sender = ? AND recipient = ? AND amount = ? 
         AND created_at >= datetime('now', '-120 minutes')`,
      [s, r, a]
    );
    if (dup) {
      console.log(`⛔ Duplicate detected for @${s} → @${r} $${a} — skipping`);
      return;
    }

    // Insert new
    await db.run(
      `INSERT INTO payments (tweet_id, sender, recipient, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [tweet_id, s, r, a]
    );

    console.log(`✅ Payment recorded: @${s} → @${r} $${a} (tweet ${tweet_id})`);
  } catch (e) {
    console.error("recordPayment error:", e.message);
  }
}

function normalizeHandle(h) {
  if (!h) return "";
  return h.replace(/^@/, "").toLowerCase();
}

/**
 * ✅ NEW: Parse BOTH formats
 * 1) "@bot_wassy send @user $5"
 * 2) "@bot_wassy send $5 to @user"
 *
 * Returns: { recipient, amount } or null
 */
function parsePaymentCommand(text) {
  if (!text) return null;

  // keep original text for @handle capture; use case-insensitive regex
  const t = String(text).trim();

  // Format A: send @user $5
  const a = t.match(/send\s+@(\w+)\s*\$?\s*([\d.]+)/i);
  if (a) {
    return { recipient: a[1], amount: parseFloat(a[2]) };
  }

  // Format B: send $5 to @user
  const b = t.match(/send\s*\$?\s*([\d.]+)\s*(?:to)?\s*@(\w+)/i);
  if (b) {
    return { recipient: b[2], amount: parseFloat(b[1]) };
  }

  return null;
}

// ===== ROUTES =====
app.get("/", (_, res) => {
  res.send("🟢 WASSY PAY backend active — 30-min X scans + tweet-based payment logging");
});

app.get("/api/payments", async (req, res) => {
  try {
    const { id, tweet_id, recipient, handle, status } = req.query;

    const singleKey = id || tweet_id;
    if (singleKey) {
      const row = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [String(singleKey)]);
      if (!row) return res.json({ success: false, message: "not_found" });
      row.status = "recorded";
      return res.json({ success: true, payments: [row] });
    }

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

    const sql = `SELECT * FROM payments ${
      where.length ? "WHERE " + where.join(" AND ") : ""
    } ORDER BY created_at DESC`;

    const rows = await db.all(sql, args);
    rows.forEach(r => (r.status = "recorded"));
    res.json({ success: true, payments: rows });
  } catch (e) {
    console.error("/api/payments error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/claims", async (req, res) => {
  try {
    const handle = normalizeHandle(req.query.handle);
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });

    const rows = await db.all(
      `SELECT * FROM payments
       WHERE recipient = ? 
       ORDER BY created_at DESC`,
      [handle]
    );
    rows.forEach(r => (r.status = "recorded"));
    res.json({ success: true, claims: rows });
  } catch (e) {
    console.error("/api/claims error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

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

app.post("/api/deposit", async (req, res) => {
  try {
    const { handle, amount } = req.body;
    if (!handle || !amount) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    await db.run(
      `INSERT INTO fund_deposits (handle, amount, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [handle.toLowerCase(), amount]
    );

    console.log(`💰 Deposit recorded: ${handle} +${amount} USDC`);
    res.json({ success: true, message: "Deposit recorded" });
  } catch (e) {
    console.error("/api/deposit error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/rescan", async (req, res) => {
  await runScheduledTweetCheck();
  res.json({ success: true, message: "Manual rescan triggered" });
});

// ===== TWITTER SCANNER =====
async function runScheduledTweetCheck() {
  if (!X_BEARER_TOKEN) {
    console.warn("⚠️ No X_BEARER_TOKEN set; skipping scan");
    return;
  }

  console.log(`🔍 Checking mentions for @${BOT_HANDLE}...`);
  try {
    const lastSeen = await getMeta("last_seen_tweet_id");

    // keep your existing filters
    const q = encodeURIComponent(`@${BOT_HANDLE} send -is:retweet -is:quote`);

    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${q}` +
      `&tweet.fields=author_id,created_at,text,referenced_tweets` +
      `&expansions=author_id` +
      `&user.fields=username` +
      (lastSeen ? `&since_id=${lastSeen}` : "");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` }
    });

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

    const users = {};
    if (data.includes && data.includes.users) {
      for (const u of data.includes.users) {
        users[u.id] = u.username.toLowerCase();
      }
    }

    let newestId = lastSeen;
    for (const tweet of data.data) {
      const text = (tweet.text || "").toLowerCase();

      // 🚫 skip manual RT-style copies
      if (text.startsWith("rt ") || text.includes(" rt @") || text.includes("\nrt ")) {
        console.log(`⏭ Skipping manual RT-style tweet ${tweet.id}`);
        continue;
      }

      // 🚫 skip if tweet references another as retweet/quote
      if (tweet.referenced_tweets && Array.isArray(tweet.referenced_tweets)) {
        const isRef = tweet.referenced_tweets.some(r => r.type === "retweeted" || r.type === "quoted");
        if (isRef) {
          console.log(`⏭ Skipping retweet/quote ${tweet.id}`);
          continue;
        }
      }

      // ✅ NEW: support both command formats
      const parsed = parsePaymentCommand(tweet.text || "");
      if (parsed && parsed.recipient && Number.isFinite(parsed.amount)) {
        const sender = users[tweet.author_id] || tweet.author_id || "unknown";
        await recordPayment(sender, parsed.recipient, parsed.amount, tweet.id);
      }

      if (!newestId || BigInt(tweet.id) > BigInt(newestId)) {
        newestId = tweet.id;
      }
    }

    if (newestId) await upsertMeta("last_seen_tweet_id", newestId);
    console.log(`✅ Scan complete (${data.data.length} tweets checked).`);
  } catch (e) {
    console.error("X scan error:", e.message);
  }
}

app.listen(PORT, () => console.log(`🚀 WASSY backend listening on ${PORT}`));
