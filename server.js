// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

    // === Call Dev.Fun function securely ===
    const relayUrl = `https://devbase.dev.fun/api/v1/${process.env.APP_ID}/run?func=$FUNC_RELAY_PAYMENT`;
    console.log("🚀 Calling Dev.Fun relay:", relayUrl);

    const relayRes = await fetch(relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devbase-secret": process.env.DEVBASE_SECRET
      },
      body: JSON.stringify({
        args: [sender_handle, recipient, amount]
      })
    });

    const relayResult = await relayRes.json();
    console.log("🔁 Relay Result:", relayResult);

    res.json({ success: true, relayed: relayResult });
  } catch (err) {
    console.error("💥 handleTweet error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error", error: err.message });
  }
});

// === 3️⃣ Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WASSY relay backend running on port ${PORT}`);
});
