const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const paymentMiddleware = require("./middleware/paymentMiddleware");

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;

// Attach x402-like middleware globally
app.use(
  paymentMiddleware(VAULT_ADDRESS, {
    "/api/fund": "$0.01",
    "/api/send": "$0.02",
  })
);

// Example protected routes
app.post("/api/fund", async (req, res) => {
  res.json({ success: true, message: "✅ Fund processed after payment" });
});

app.post("/api/send", async (req, res) => {
  res.json({ success: true, message: "✅ Transfer successful" });
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ WASSY PAY Backend is running");
});

app.listen(PORT, () =>
  console.log(`🚀 WASSY PAY Backend running on port ${PORT}`)
);
