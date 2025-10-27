import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { paymentMiddleware } from "x402";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const fetch = require("node-fetch");
const { paymentMiddleware } = require("x402");

dotenv.config();

const {
  DEVBASE_ENDPOINT,
  DEVFUN_API_KEY,
  VAULT_ADDRESS,
  PORT
} = process.env;

/** Helper to call Devbase functions */
async function callDevbaseFunction(funcName, payload) {
  const res = await fetch(`${DEVBASE_ENDPOINT}/functions/eval`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": DEVFUN_API_KEY
    },
    body: JSON.stringify({
      functionName: funcName,
      payload
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Devbase function failed");
  return data;
}

/** -------------------- FUND ROUTE -------------------- **/
app.post(
  "/api/fund",
  paymentMiddleware(VAULT_ADDRESS, { "/api/fund": "$amount" }),
  async (req, res) => {
    try {
      const { userWallet, amount } = req.body;

      if (!userWallet || !amount) {
        return res.status(400).json({ success: false, message: "Missing fields" });
      }

      const result = await callDevbaseFunction("$FUNC_FUND_ACCOUNT", {
        userWallet,
        amount
      });

      res.json({ success: true, result });
    } catch (err) {
      console.error("Error in /api/fund:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/** -------------------- SEND ROUTE -------------------- **/
app.post(
  "/api/send",
  paymentMiddleware(VAULT_ADDRESS, { "/api/send": "$amount" }),
  async (req, res) => {
    try {
      const { fromUser, toHandle, amount } = req.body;

      if (!fromUser || !toHandle || !amount) {
        return res.status(400).json({ success: false, message: "Missing fields" });
      }

      const canProcess = await callDevbaseFunction("$FUNC_CAN_PROCESS_PAYMENT", {
        fromUser,
        toHandle,
        amount
      });

      if (canProcess.result !== "true") {
        return res.status(400).json({
          success: false,
          message: "Insufficient balance or invalid recipient"
        });
      }

      const result = await callDevbaseFunction("$FUNC_SEND_PAYMENT", {
        fromUser,
        toHandle,
        amount
      });

      res.json({ success: true, result });
    } catch (err) {
      console.error("Error in /api/send:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/** -------------------- HEALTH CHECK -------------------- **/
app.get("/", (req, res) => {
  res.send("✅ WASSY PAY Backend is running");
});

app.listen(PORT || 3000, () => {
  console.log(`🚀 WASSY PAY Backend running on port ${PORT || 3000}`);
});
