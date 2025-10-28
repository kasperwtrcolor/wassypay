import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import { StateClient } from "@devfunlabs/state-client";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIG ---
const APP_ID = process.env.DEVFUN_APP_ID || "699840f631c97306a0c4";
const DEVBASE_URL = process.env.DEVBASE_URL || "https://devbase.dev.fun";
const PORT = process.env.PORT || 3000;

// --- INIT DEVFUN CLIENT ---
const devbaseClient = new StateClient({
  endpoint: DEVBASE_URL,
  appId: APP_ID
});

// --- HEALTH CHECK ---
app.get("/", (req, res) => {
  res.send("✅ WASSY Pay backend is running");
});

// --- CHECK PROFILE ---
app.get("/api/check-profile", async (req, res) => {
  try {
    const handle = req.query.handle?.trim().toLowerCase();
    if (!handle) {
      return res.status(400).json({ success: false, message: "Missing handle" });
    }

    console.log(`🔍 Checking profile for handle: ${handle}`);

    const profiles = await devbaseClient.listEntities("profiles", {
      xHandle: handle
    });

    if (profiles.length > 0) {
      return res.json({ success: true, message: "Profile exists", profile: profiles[0] });
    } else {
      return res.json({ success: false, message: "No profile found for that handle" });
    }
  } catch (err) {
    console.error("💥 Error in /api/check-profile:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error", error: err.message });
  }
});

// --- SEND PAYMENT (simple test route) ---
app.post("/api/send", async (req, res) => {
  try {
    const { fromTwitterId, toHandle, amount } = req.body;
    if (!fromTwitterId || !toHandle || !amount) {
      return res.status(400).json({ success: false, message: "Missing parameters" });
    }

    console.log(`💸 Simulating payment: ${fromTwitterId} → ${toHandle} ($${amount})`);

    // for now just mock success (we’ll wire Dev.Fun funds next)
    return res.json({ success: true, message: "Payment simulated" });
  } catch (err) {
    console.error("💥 Error in /api/send:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error", error: err.message });
  }
});

// --- START SERVER ---
app.listen(PORT, () => console.log(`🚀 WASSY Pay backend running on port ${PORT}`));
