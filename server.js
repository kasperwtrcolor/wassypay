// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const FRONTEND_URL = process.env.FRONTEND_URL || "https://wassypay.onrender.com";

// === 1️⃣ Health check ===
app.get("/", (_, res) => {
  res.send("🟢 WASSY PAY relay backend active");
});

// === 2️⃣ Handle Tweet Webhook ===
app.post("/api/handleTweet", async (req, res) => {
  try {
    const { tweet_id, text, sender_handle } = req.body;
    console.log(`🐦 Tweet received: @${sender_handle} → "${text}"`);

    const match = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
    if (!match) {
      return res.json({ success: false, message: "No valid payment command" });
    }

    const recipient = match[1];
    const amount = parseFloat(match[2]);

    // Forward to frontend (Dev.Fun-capable client)
    const forward = await fetch(`${FRONTEND_URL}/api/frontend/relayPayment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender_handle, to: recipient, amount })
    });

    const result = await forward.json().catch(() => ({}));
    console.log("🧾 Payment result:", result);

    res.json({ success: true, relayed: result });
  } catch (err) {
    console.error("💥 handleTweet error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error", error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 WASSY relay backend running on port ${PORT}`));
