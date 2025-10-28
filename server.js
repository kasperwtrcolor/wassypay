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
const APP_ID = process.env.APP_ID || "699840f631c97306a0c4";

// === 1️⃣ Health check ===
app.get("/", (_, res) => {
  res.send("🟢 WASSY PAY relay backend active");
});

// === 2️⃣ Handle Tweet Webhook ===
app.post("/api/handleTweet", async (req, res) => {
  try {
    const { tweet_id, text, sender_handle } = req.body;
    console.log(`🐦 Tweet received: @${sender_handle} → "${text}"`);

    // --- Parse tweet for payment command
    const match = text.match(/send\s*@(\w+)\s*\$?([\d.]+)/i);
    if (!match) {
      console.log("⚠️ No valid payment command found in tweet");
      return res.json({ success: false, message: "No valid payment command" });
    }

    const recipient = match[1];
    const amount = parseFloat(match[2]);
    console.log(`🧾 Parsed command: send $${amount} to @${recipient}`);

    // === 3️⃣ Call Dev.Fun Function ===
    const relayUrl = `https://dev.fun/api/run/${APP_ID}/$FUNC_RELAY_PAYMENT`;
    const relayRes = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: [sender_handle, recipient, amount]
      })
    });

    const relayResult = await relayRes.json().catch(() => ({}));
    console.log("🔁 Relay Result:", relayResult);

    // === 4️⃣ Optionally forward result to frontend for display/logging
    await fetch(`${FRONTEND_URL}/api/frontend/relayPayment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: sender_handle,
        to: recipient,
        amount,
        relayResult
      })
    }).catch(() => console.log("⚠️ Skipped frontend relay call"));

    // === 5️⃣ Respond to the request
    res.json({ success: true, relayed: relayResult });
  } catch (err) {
    console.error("💥 handleTweet error:", err);
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error", error: err.message });
  }
});

// === 6️⃣ Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 WASSY relay backend running on port ${PORT}`));
