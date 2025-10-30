import express from "express";
import sqlite3 from "sqlite3";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "wassy.db");

app.use(cors());
app.use(bodyParser.json());

// ✅ Initialize SQLite DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ Error opening DB:", err);
  else console.log("✅ Connected to SQLite DB");
});

// ✅ Create payments table if not exists
db.run(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT UNIQUE,
    sender TEXT,
    recipient TEXT,
    amount REAL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    claimed_at DATETIME
  )
`);

// ✅ Health check
app.get("/", (req, res) => {
  res.json({ success: true, message: "WassyPay backend running ✅" });
});

// ✅ Get all payments or filter by handle/tweet_id
app.get("/api/payments", (req, res) => {
  const { handle, id, tweet_id } = req.query;
  let query = "SELECT * FROM payments";
  const params = [];

  if (handle) {
    query += " WHERE recipient = ?";
    params.push(handle);
  } else if (id) {
    query += " WHERE id = ?";
    params.push(id);
  } else if (tweet_id) {
    query += " WHERE tweet_id = ?";
    params.push(tweet_id);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ Error fetching payments:", err);
      return res.status(500).json({ success: false, message: "DB error" });
    }
    res.json({ success: true, payments: rows });
  });
});

// ✅ Deposit (mock)
app.post("/api/deposit", (req, res) => {
  const { handle, amount } = req.body;
  if (!handle || !amount) {
    return res
      .status(400)
      .json({ success: false, message: "Missing handle or amount" });
  }

  console.log(`💰 Deposit received: ${amount} USDC for @${handle}`);
  res.json({ success: true, message: `Deposited ${amount} for ${handle}` });
});

// ✅ Create a payment manually (used by bot or admin)
app.post("/api/payments", (req, res) => {
  const { tweet_id, sender, recipient, amount } = req.body;

  if (!tweet_id || !sender || !recipient || !amount) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  db.run(
    `INSERT OR IGNORE INTO payments (tweet_id, sender, recipient, amount, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [tweet_id, sender, recipient, amount],
    function (err) {
      if (err) {
        console.error("❌ Error inserting payment:", err);
        return res.status(500).json({ success: false, message: "DB error" });
      }
      console.log(`💾 Payment inserted: ${tweet_id} (${amount} USDC)`);
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ✅ Get claims (for frontend display)
app.get("/api/claims", (req, res) => {
  const { handle } = req.query;
  if (!handle) {
    return res
      .status(400)
      .json({ success: false, message: "Missing handle parameter" });
  }

  db.all(
    "SELECT * FROM payments WHERE recipient = ? AND status = 'pending'",
    [handle],
    (err, rows) => {
      if (err) {
        console.error("❌ Error fetching claims:", err);
        return res.status(500).json({ success: false, message: "DB error" });
      }
      res.json({ success: true, claims: rows });
    }
  );
});

// ✅ Update payment status (NEW)
app.post("/api/payments/update-status", (req, res) => {
  try {
    const { tweet_id, status } = req.body;
    if (!tweet_id || !status) {
      return res
        .status(400)
        .json({ success: false, message: "Missing tweet_id or status" });
    }

    const updateQuery = `
      UPDATE payments
      SET status = ?, claimed_at = CURRENT_TIMESTAMP
      WHERE tweet_id = ?;
    `;

    db.run(updateQuery, [status, tweet_id], function (err) {
      if (err) {
        console.error("❌ Error updating payment status:", err);
        return res.status(500).json({ success: false, message: "DB update failed" });
      }

      if (this.changes === 0) {
        console.warn(`⚠️ No payment found for tweet_id ${tweet_id}`);
        return res.status(404).json({ success: false, message: "Payment not found" });
      }

      console.log(`✅ Payment ${tweet_id} marked as ${status}`);
      res.json({ success: true });
    });
  } catch (error) {
    console.error("❌ Error in /api/payments/update-status:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ✅ Basic profile route
app.get("/api/profile", (req, res) => {
  const { handle } = req.query;
  if (!handle) {
    return res.status(400).json({ success: false, message: "Missing handle" });
  }
  res.json({ success: true, handle, balance: 0 });
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 WassyPay backend running on port ${PORT}`);
});
