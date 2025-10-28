import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { StateClient } from "@devfunlabs/state-client";

const devbase = new StateClient({
  endpoint: "https://devbase.dev.fun",
  appId: "699840f631c97306a0c4",
});

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === 1️⃣ Check Profile ===
app.get("/api/check-profile", async (req, res) => {
  try {
    const { handle } = req.query;
    if (!handle) {
      return res.status(400).json({ success: false, message: "Missing handle" });
    }

    // Simulate checking Dev.Fun database for user profiles
    // Replace with actual devbaseClient.listEntities() when integrated
    const mockProfiles = ["kasperwtrcolor", "fpl_sol"]; // ✅ existing test users
    const exists = mockProfiles.includes(handle.toLowerCase());

    if (exists) {
      console.log(`✅ Profile check: @${handle} exists.`);
      return res.json({ success: true, message: "Profile exists" });
    } else {
      console.log(`❌ Profile check: @${handle} not found.`);
      return res.json({ success: false, message: "Profile not found" });
    }
  } catch (err) {
    console.error("💥 Error in /api/check-profile:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// === 2️⃣ Send Payment (used by bot + frontend) ===
app.post("/api/send", async (req, res) => {
  try {
    const { fromTwitterId, toHandle, amount } = req.body;
    if (!fromTwitterId || !toHandle || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing parameters" });
    }

    console.log(
      `💸 Payment attempt: @${fromTwitterId} -> @${toHandle} for $${amount}`
    );

    // Temporary simulation of account balance logic
    const mockBalances = {
      fpl_sol: 10.0,
      kasperwtrcolor: 5.0,
    };

    const senderBalance = mockBalances[fromTwitterId.toLowerCase()] || 0;
    if (senderBalance < amount) {
      console.log(`⚠️ Insufficient funds for @${fromTwitterId}`);
      return res.status(402).json({
        success: false,
        message: "Insufficient balance",
      });
    }

    // Simulate successful transfer
    console.log(
      `✅ Payment processed: @${fromTwitterId} sent $${amount} to @${toHandle}`
    );
    return res.json({
      success: true,
      message: `Transferred $${amount} from @${fromTwitterId} to @${toHandle}`,
    });
  } catch (err) {
    console.error("💥 Error in /api/send:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// === 3️⃣ Default route ===
app.get("/", (req, res) => {
  res.json({
    service: "WASSY Pay Backend",
    status: "running",
    endpoints: ["/api/check-profile", "/api/send"],
  });
});

app.listen(PORT, () => {
  console.log(`🚀 WASSY Pay backend running on port ${PORT}`);
});
