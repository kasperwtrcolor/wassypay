// middleware/paymentMiddleware.js
const fetch = require("node-fetch");

/**
 * A lightweight Dev.fun-compatible x402-style middleware.
 * 
 * If no proof headers are provided, returns HTTP 402 with pay instructions.
 * Otherwise, checks payment via Devbase and allows through.
 */
function paymentMiddleware(vaultAddress, pricingRules = {}) {
  return async function (req, res, next) {
    const route = req.path;
    const price = pricingRules[route];

    // Skip routes without a price rule
    if (!price) return next();

    const proof = req.headers["x-payment-proof"];
    const payer = req.headers["x-wallet"];
    const amount = req.headers["x-amount"];

    if (!proof || !payer || !amount) {
      res.setHeader("X-Pay-To", vaultAddress);
      res.setHeader("X-Price", price);
      return res.status(402).json({
        success: false,
        message: `Payment of ${price} required to access ${route}`,
      });
    }

    // Verify payment against Devbase
    const verified = await verifyDevbasePayment(payer, amount, vaultAddress);
    if (!verified) {
      return res.status(402).json({
        success: false,
        message: "Payment not verified",
      });
    }

    next();
  };
}

async function verifyDevbasePayment(fromWallet, amount, vaultAddress) {
  try {
    const res = await fetch(`${process.env.DEVBASE_ENDPOINT}/functions/eval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.DEVFUN_API_KEY,
      },
      body: JSON.stringify({
        functionName: "$FUNC_VERIFY_PAYMENT",
        payload: { fromWallet, amount, vaultAddress },
      }),
    });

    const data = await res.json();
    return data?.result === "true";
  } catch (err) {
    console.error("verifyDevbasePayment error:", err);
    return false;
  }
}

module.exports = paymentMiddleware;
