// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { StateClient } from "@devfunlabs/state-client";

dotenv.config();

// === ENV ===
const {
  PORT = 3000,
  DEVBASE_ENDPOINT = "https://devbase.dev.fun",
  DEVFUN_API_KEY,
  APP_ID,
  VAULT_ADDRESS
} = process.env;

if (!DEVFUN_API_KEY) console.error("❌ Missing DEVFUN_API_KEY in .env");
if (!APP_ID) console.error("❌ Missing APP_ID in .env");
if (!VAULT_ADDRESS) console.error("⚠️ Missing VAULT_ADDRESS in .env (not critical)");

// === APP ===
const app = express();
app.use(cors());
app.use(express.json());

// === DEV.FUN CLIENT ===
const devbaseClient = new StateClient({
  baseUrl: DEVBASE_ENDPOINT,
  appId: APP_ID,
  apiKey: DEVFUN_API_KEY
});

// === 1️⃣ CHECK PROFILE ===
app.get("/api/check-profile", async (req, res) => {
  try {
    const handle = req.query.handle;
    if (!handle) {
      return res.status(400).json({ success: false, message: "Missing handle" });
    }

    console.log(`🔍 Checking profile for handle: ${handle}`);
    const profiles = await devbaseClient.listEntities("profiles", { xHandle: handle });

    if (profiles && profiles.length > 0) {
      return res.json({ success: true, profile: profiles[0] });
    }

    return res.json({ success: false, message: "Profile not found" });
  } catch (err) {
    console.error("💥 /api/check-profile error:", err);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: err.message || String(err)
    });
  }
});

// === 2️⃣ SEND PAYMENT ===
app.post("/api/send", async (req, res) => {
  try {
    const { fromTwitterId, toHandle, amount } = req.body;
    if (!fromTwitterId || !toHandle || !amount) {
      return res.status(400).json({ success: false, message: "Missing parameters" });
    }

    console.log(`💸 Payment request: @${fromTwitterId} → @${toHandle} | ${amount} USDC`);

    // 1️⃣ Verify both users exist
    const senderProfiles = await devbaseClient.listEntities("profiles", { xHandle: fromTwitterId });
    const receiverProfiles = await devbaseClient.listEntities("profiles", { xHandle: toHandle });

    if (!senderProfiles.length) {
      return res.status(404).json({ success: false, message: "Sender not found on Dev.Fun" });
    }
    if (!receiverProfiles.length) {
      return res.status(404).json({ success: false, message: "Recipient not found on Dev.Fun" });
    }

    const senderWallet = senderProfiles[0].wallet;
    const receiverWallet = receiverProfiles[0].wallet;

    // 2️⃣ Check sender balance
    const senderFunds = await devbaseClient.listEntities("funds", { userId: senderWallet });
    const balance = senderFunds.length > 0 ? senderFunds[0].balanceUSDC || 0 : 0;

    if (balance < amount) {
      console.log(`⚠️ Insufficient funds: ${balance} < ${amount}`);
      return res.status(402).json({
        success: false,
        message: "Insufficient balance in vault"
      });
    }

    // 3️⃣ Perform transfer (record on Dev.Fun)
    console.log(`✅ Initiating transfer of ${amount} USDC`);
    await devbaseClient.createEntity("payment_transfers", {
      fromUser: senderWallet,
      toHandle: toHandle,
      amount: amount
    });

    // 4️⃣ Update fund balances (optional simulation)
    const newSenderBalance = balance - amount;
    await devbaseClient.updateEntity("funds", senderFunds[0].id, {
      balanceUSDC: newSenderBalance
    });

    const receiverFunds = await devbaseClient.listEntities("funds", { userId: receiverWallet });
    if (receiverFunds.length > 0) {
      const newReceiverBalance = (receiverFunds[0].balanceUSDC || 0) + amount;
      await devbaseClient.updateEntity("funds", receiverFunds[0].id, {
        balanceUSDC: newReceiverBalance
      });
    } else {
      await devbaseClient.createEntity("funds", {
        userId: receiverWallet,
        balanceUSDC: amount
      });
    }

    console.log(`✅ Payment complete: @${fromTwitterId} → @${toHandle} (${amount} USDC)`);

    return res.json({
      success: true,
      message: `Payment of ${amount} USDC sent from @${fromTwitterId} to @${toHandle}`
    });
  } catch (err) {
    console.error("💥 /api/send error:", err);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: err.message || String(err)
    });
  }
});

// === 3️⃣ HEALTH CHECK ===
app.get("/", (_, res) => {
  res.send("🟢 WASSY PAY BACKEND ACTIVE");
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 WASSY PAY backend running on port ${PORT}`);
});
