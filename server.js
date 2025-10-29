import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

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
      tweet_id TEXT,
      sender TEXT,
      recipient TEXT,
      amount REAL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME
    );
  `);
})();

// === Routes ===

// Health check
app.get("/", (_, res) => res.send("🟢 WASSY API running"));

// 1️⃣ Record transaction from bot
app.post("/api/record-transaction", async (req, res) => {
  try {
    const { sender, recipient, amount, tweet_id } = req.body;
    if (!sender || !recipient || !amount) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    await db.run(
      `INSERT INTO payments (tweet_id, sender, recipient, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [tweet_id || "", sender.toLowerCase(), recipient.toLowerCase(), amount]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("record-transaction error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// 2️⃣ Get pending claims for user
app.get("/api/claims", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle) return res.status(400).json({ success: false, message: "handle required" });

    const rows = await db.all(
      `SELECT * FROM payments WHERE recipient = ? AND status = 'pending' ORDER BY created_at DESC`,
      [handle.toLowerCase()]
    );

    res.json({ success: true, claims: rows });
  } catch (e) {
    console.error("claims error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// 3️⃣ Claim payment
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
    console.error("claim error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// 4️⃣ Admin route to view all payments
app.get("/api/payments", async (_, res) => {
  const rows = await db.all("SELECT * FROM payments ORDER BY created_at DESC");
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 WASSY backend running on port ${PORT}`));
