import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { StateClient } from "@devfunlabs/state-client";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const devbase = new StateClient({
  endpoint: "https://devbase.dev.fun",
  appId: "699840f631c97306a0c4",
});

// === 1️⃣ Check Profile on Dev.Fun ===
app.get("/api/check-profile", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle) {
      return res.status(400).json({ success: false, message: "Missing handle" });
    }

    const profiles = await devbase.listEntities("profiles", { xHandle: handle });
    if (profiles.length > 0) {
      console.log(`✅ Found Dev.Fun profile for @${handle}`);
      return res.json({ success: true, message: "Profile exists" });
    } else {
      console.log(`❌ No Dev.Fun profile found for @${handle}`);
      return res.json({ success: false, message: "Profile not found" });
    }
  } catch (err) {
    console.error("💥 /api/check-profile failed:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// === 2️⃣ Send Payment via Dev.Fun ===
app.post("/api/send", async (req, res) => {
  try {
    const { fromTwitterId, toHandle, amount } = req.body;
    if (!fromTwitterId || !toHandle || !amount) {
      return res.status(400).json({ success: false, message: "Missing parameters" });
    }

    console.log(`💸 Payment attempt: @${fromTwitterId} -> @${toHandle} for $${amount}`);

    // 1. Find sender
    const senderProfile = await devbase.listEntities("profiles", { xHandle: fromTwitterId });
    if (senderProfile.length === 0)
      return res.status(400).json({ success: false, message: "Sender not found" });

    const senderWallet = senderProfile[0].wallet;
    const senderFunds = await devbase.listEntities("funds", { userId: senderWallet });
    const senderBalance = senderFunds[0]?.balanceUSDC || 0;

    if (senderBalance < amount)
      return res.status(402).json({ success: false, message: "Insufficient funds" });

    // 2. Find recipient
    const recipientProfile = await devbase.listEntities("profiles", { xHandle: toHandle });
    if (recipientProfile.length === 0)
      return res.status(400).json({ success: false, message: "Recipient not found" });

    const recipientWallet = recipientProfile[0].wallet;

    // 3. Record transaction
    await devbase.createEntity("payment_transfers", {
      fromUser: senderWallet,
      toHandle,
      amount: Number(amount),
      status: "completed",
    });

    // 4. Adjust balances (simple local update; could be managed by Devbase function)
    const newSenderBal = senderBalance - amount;
    await devbase.updateEntity(senderFunds[0].id, { balanceUSDC: newSenderBal });

    const recipientFunds = await devbase.listEntities("funds", { userId: recipientWallet });
    const newRecipientBal =
      (recipientFunds[0]?.balanceUSDC || 0) + Number(amount);
    if (recipientFunds.length > 0)
      await devbase.updateEntity(recipientFunds[0].id, { balanceUSDC: newRecipientBal });
    else
      await devbase.createEntity("funds", {
        userId: recipientWallet,
        balanceUSDC: newRecipientBal,
      });

    console.log(`✅ Payment recorded in Dev.Fun`);
    res.json({
      success: true,
      message: `Transferred $${amount} from @${fromTwitterId} to @${toHandle}`,
    });
  } catch (err) {
    console.error("💥 /api/send failed:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// === 3️⃣ Default route ===
app.get("/", (req, res) => {
  res.json({
    service: "WASSY Pay Backend (Dev.Fun linked)",
    status: "running",
  });
});

app.listen(PORT, () =>
  console.log(`🚀 WASSY Pay backend running on port ${PORT}`)
);
