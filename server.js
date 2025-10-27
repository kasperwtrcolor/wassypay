import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { StateClient } from "@devfunlabs/state-client";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// === Devbase Setup ===
const DEVBASE_ENDPOINT = process.env.DEVBASE_ENDPOINT || "https://devbase.dev.fun";
const APP_ID = process.env.APP_ID || "699840f631c97306a0c4";
const client = new StateClient(DEVBASE_ENDPOINT, APP_ID);

// === Health Check ===
app.get("/", (req, res) => {
  res.send("🟢 WASSY Pay backend is active and ready.");
});

// === 1️⃣ Check if a user exists on Dev.fun ===
app.get("/api/check-profile", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle) {
      return res.status(400).json({ success: false, message: "Missing handle" });
    }

    const profiles = await client.listEntities("profiles", { xHandle: handle });
    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ success: false, message: "No Dev.fun account found" });
    }

    res.json({ success: true, profile: profiles[0] });
  } catch (err) {
    console.error("check-profile error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// === 2️⃣ Send Payment (used by bot + frontend) ===
app.post("/api/send", async (req, res) => {
  try {
    const { fromTwitterId, toHandle, amount } = req.body;
    if (!fromTwitterId || !toHandle || !amount) {
      return res.status(400).json({ success: false, message: "Missing parameters" });
    }

    // Step 1. Verify sender has an account
    const senderProfiles = await client.listEntities("profiles", { xHandle: fromTwitterId });
    if (!senderProfiles || senderProfiles.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Sender has no active WASSY Pay account"
      });
    }

    // Step 2. Verify recipient account exists
    const receiverProfiles = await client.listEntities("profiles", { xHandle: toHandle });
    if (!receiverProfiles || receiverProfiles.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Recipient not found on WASSY Pay"
      });
    }

    // Step 3. Get sender balance
    const funds = await client.listEntities("funds", { userId: senderProfiles[0].wallet });
    const balance = funds?.[0]?.balanceUSDC || 0;

    if (balance < amount) {
      return res.status(402).json({
        success: false,
        message: "Payment required — insufficient funds"
      });
    }

    // Step 4. Log transfer intent (actual transfer done via Devbase transfer action)
    await client.createEntity("payment_transfers", {
      fromUser: senderProfiles[0].wallet,
      toHandle,
      amount: parseFloat(amount),
      timestamp: new Date().toISOString(),
      status: "completed"
    });

    console.log(`💸 ${fromTwitterId} sent ${amount} USDC to @${toHandle}`);
    res.json({ success: true, message: `Payment sent to @${toHandle}` });
  } catch (err) {
    console.error("send error:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// === 3️⃣ Process Tweet (optional: used for non-polling triggers) ===
app.post("/api/process-tweet", async (req, res) => {
  try {
    const { text, author } = req.body;
    if (!text || !author) {
      return res.status(400).json({ success: false, message: "Missing text or author" });
    }

    const regex = /send\s+@(\w+)\s*\$?([\d.]+)/i;
    const match = text.match(regex);
    if (!match) {
      return res.status(400).json({ success: false, message: "No payment command found" });
    }

    const handle = match[1];
    const amount = parseFloat(match[2]);

    console.log(`🧾 Tweet parsed: ${author} -> @${handle} | ${amount} USDC`);

    // Verify both users exist before proceeding
    const senderProfiles = await client.listEntities("profiles", { xHandle: author });
    const receiverProfiles = await client.listEntities("profiles", { xHandle: handle });
    if (!senderProfiles.length || !receiverProfiles.length) {
      return res.status(403).json({
        success: false,
        message: "Either sender or receiver has no Dev.fun account"
      });
    }

    // Log transfer intent
    await client.createEntity("payment_requests", {
      fromUser: senderProfiles[0].wallet,
      toHandle: handle,
      amount,
      timestamp: new Date().toISOString(),
      status: "pending"
    });

    res.json({ success: true, message: `Payment request recorded for @${handle}` });
  } catch (err) {
    console.error("process-tweet error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// === 4️⃣ Optional: verify server health ===
app.get("/api/status", async (req, res) => {
  res.json({
    service: "wassy-pay-backend",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 WASSY Pay backend running on port ${PORT}`));
