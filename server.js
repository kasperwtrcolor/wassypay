import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import admin from "firebase-admin";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_HANDLE = (process.env.BOT_HANDLE || "bot_wassy").toLowerCase();
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ADMIN_WALLET = process.env.ADMIN_WALLET || "6SxLVfFovSjR2LAFcJ5wfT6RFjc8GxsscRekGnLq8BMe";
const DEBUG_MODE = process.env.DEBUG_MODE === "true"; // Set to true for verbose logging

// Solana configuration - SOLANA_RPC must be set in environment
const SOLANA_RPC = process.env.SOLANA_RPC;
if (!SOLANA_RPC) {
  console.error("❌ SOLANA_RPC environment variable not set!");
  process.exit(1);
}
const USDC_MINT = process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "Hu7wMzbwR5RSTXk2bF5CEDhdSAN1mzX9vTiqbQJWESxE";

// Create Solana connection with faster commitment
const solanaConnection = new Connection(SOLANA_RPC, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000
});

// Load vault keypair for executing transfers
let vaultKeypair = null;
if (process.env.VAULT_PRIVATE_KEY) {
  try {
    const secretKey = bs58.decode(process.env.VAULT_PRIVATE_KEY);
    vaultKeypair = Keypair.fromSecretKey(secretKey);
    console.log(`✅ Vault keypair loaded: ${vaultKeypair.publicKey.toBase58()}`);
    console.log(`   Make sure this address has SOL for fees!`);
  } catch (e) {
    console.error("❌ Failed to load vault keypair:", e.message);
  }
} else {
  console.warn("⚠️ VAULT_PRIVATE_KEY not set - transfers will be disabled");
}

// ===== FIREBASE SETUP =====
let firestore;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firestore = admin.firestore();
    console.log("✅ Firebase initialized");
  } else {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT not configured properly");
    process.exit(1);
  }
} catch (e) {
  console.error("❌ Failed to initialize Firebase:", e.message);
  process.exit(1);
}

// Firestore collections
const usersCollection = firestore.collection("backend_users");
const paymentsCollection = firestore.collection("payments");
const metaCollection = firestore.collection("meta");

// Run scan at boot
setTimeout(() => {
  console.log("🕐 Starting initial tweet scan...");
  runScheduledTweetCheck();
  // Schedule every 30 minutes
  setInterval(runScheduledTweetCheck, SCAN_INTERVAL_MS);
  console.log(`📅 Tweet scanner scheduled every ${SCAN_INTERVAL_MS / 60000} minutes`);
}, 2000);

// ===== HELPERS =====
async function upsertMeta(key, value) {
  await metaCollection.doc(key).set({ value: String(value) }, { merge: true });
}

async function getMeta(key) {
  const doc = await metaCollection.doc(key).get();
  return doc.exists ? doc.data().value : null;
}

function normalizeHandle(h) {
  if (!h) return "";
  return h.replace(/^@/, "").toLowerCase();
}

async function ensureUser(x_username) {
  const handle = normalizeHandle(x_username);
  const userRef = usersCollection.doc(handle);
  const doc = await userRef.get();

  if (!doc.exists) {
    const newUser = {
      x_username: handle,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    };
    await userRef.set(newUser);
    return { x_username: handle, ...newUser };
  }

  return { x_username: handle, ...doc.data() };
}

// Get sender's on-chain USDC balance and authorization status
async function getSenderFundStatus(walletAddress) {
  if (!walletAddress) {
    return { balance: 0, authorized: false, error: "No wallet address" };
  }

  try {
    const walletPubkey = new PublicKey(walletAddress);
    const usdcMintPubkey = new PublicKey(USDC_MINT);
    const vaultPubkey = new PublicKey(VAULT_ADDRESS);

    const ata = await getAssociatedTokenAddress(usdcMintPubkey, walletPubkey);

    let balance = 0;
    let delegatedAmount = 0;
    let authorized = false;

    try {
      const tokenAccount = await getAccount(solanaConnection, ata);
      balance = Number(tokenAccount.amount) / 1_000_000;

      if (tokenAccount.delegate && tokenAccount.delegate.equals(vaultPubkey)) {
        delegatedAmount = Number(tokenAccount.delegatedAmount) / 1_000_000;
        authorized = delegatedAmount > 0;
      }
    } catch (tokenErr) {
      // Token account doesn't exist = 0 balance
    }

    return { balance, delegatedAmount, authorized, error: null };
  } catch (e) {
    console.error(`Error getting fund status for ${walletAddress}:`, e.message);
    return { balance: 0, delegatedAmount: 0, authorized: false, error: e.message };
  }
}

async function recordPayment(sender, recipient, amount, tweet_id) {
  try {
    const s = normalizeHandle(sender);
    const r = normalizeHandle(recipient);
    const a = Number(amount);

    // Check if tweet already exists
    const existingDoc = await paymentsCollection.doc(tweet_id).get();
    if (existingDoc.exists) {
      console.log(`⛔ Tweet ${tweet_id} already recorded — skipping`);
      return;
    }

    // Check for duplicates (same sender, recipient, amount in last 2h)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dupQuery = await paymentsCollection
      .where("sender_username", "==", s)
      .where("recipient_username", "==", r)
      .where("amount", "==", a)
      .where("created_at", ">=", twoHoursAgo)
      .limit(1)
      .get();

    if (!dupQuery.empty) {
      console.log(`⛔ Duplicate detected for @${s} → @${r} $${a} — skipping`);
      return;
    }

    // Insert new payment
    await paymentsCollection.doc(tweet_id).set({
      tweet_id,
      sender: s,
      sender_username: s,
      recipient: r,
      recipient_username: r,
      amount: a,
      status: "pending",
      claimed_by: null,
      tx_signature: null,
      tweet_url: `https://twitter.com/i/status/${tweet_id}`,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // Ensure both users exist
    await ensureUser(s);
    await ensureUser(r);

    console.log(`✅ Payment recorded: @${s} → @${r} $${a} (tweet ${tweet_id})`);
  } catch (e) {
    console.error("recordPayment error:", e.message);
  }
}

function parsePaymentCommand(text) {
  if (!text) return null;
  const t = String(text).trim();

  // Format A: send @user $5
  const a = t.match(/send\s+@(\w+)\s*\$?\s*([\d.]+)/i);
  if (a) return { recipient: a[1], amount: parseFloat(a[2]) };

  // Format B: send $5 to @user
  const b = t.match(/send\s*\$?\s*([\d.]+)\s+to\s+@(\w+)/i);
  if (b) return { recipient: b[2], amount: parseFloat(b[1]) };

  // Format C: pay @user $5
  const c = t.match(/pay\s+@(\w+)\s*\$?\s*([\d.]+)/i);
  if (c) return { recipient: c[1], amount: parseFloat(c[2]) };

  return null;
}

// ===== API ROUTES =====

app.get("/", (req, res) => {
  res.json({ status: "ok", name: "WASSY API", version: "2.0-firebase" });
});

// POST /api/login - Register or login user
app.post("/api/login", async (req, res) => {
  try {
    const { x_username, x_user_id, wallet_address } = req.body;
    if (!x_username) {
      return res.status(400).json({ success: false, message: "x_username required" });
    }

    const handle = normalizeHandle(x_username);
    const userRef = usersCollection.doc(handle);

    // Upsert user
    await userRef.set({
      x_username: handle,
      x_user_id: x_user_id || null,
      wallet_address: wallet_address || null,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const userDoc = await userRef.get();
    const user = userDoc.data() || {};

    console.log(`👤 User logged in: @${handle} (wallet: ${wallet_address?.slice(0, 8)}...)`);

    res.json({
      success: true,
      is_delegated: !!user.is_delegated,
      delegation_amount: user.delegation_amount || 0,
      wallet_address: user.wallet_address
    });
  } catch (e) {
    console.error("/api/login error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/authorize - Record delegation authorization
app.post("/api/authorize", async (req, res) => {
  try {
    const { wallet, amount, signature } = req.body;
    if (!wallet || !amount) {
      return res.status(400).json({ success: false, message: "wallet and amount required" });
    }

    // Find user by wallet address
    const usersQuery = await usersCollection.where("wallet_address", "==", wallet).limit(1).get();

    if (!usersQuery.empty) {
      const userDoc = usersQuery.docs[0];
      await userDoc.ref.update({
        is_delegated: true,
        delegation_amount: Number(amount),
        delegation_signature: signature || null,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    console.log(`🔐 Authorization recorded: ${wallet.slice(0, 8)}... for $${amount}`);
    res.json({ success: true, message: "Authorization recorded" });
  } catch (e) {
    console.error("/api/authorize error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== PAYMENTS =====

// GET /api/payments/:username - Get payments for a user
app.get("/api/payments/:username", async (req, res) => {
  try {
    const handle = normalizeHandle(req.params.username);
    if (!handle) {
      return res.status(400).json({ success: false, message: "username required" });
    }

    // Get payments where user is sender
    const sentQuery = await paymentsCollection
      .where("sender_username", "==", handle)
      .orderBy("created_at", "desc")
      .limit(50)
      .get();

    // Get payments where user is recipient
    const receivedQuery = await paymentsCollection
      .where("recipient_username", "==", handle)
      .orderBy("created_at", "desc")
      .limit(50)
      .get();

    const payments = [];
    sentQuery.forEach(doc => payments.push({ id: doc.id, ...doc.data() }));
    receivedQuery.forEach(doc => {
      if (!payments.find(p => p.id === doc.id)) {
        payments.push({ id: doc.id, ...doc.data() });
      }
    });

    // Sort by created_at
    payments.sort((a, b) => {
      const aTime = a.created_at?.toMillis?.() || 0;
      const bTime = b.created_at?.toMillis?.() || 0;
      return bTime - aTime;
    });

    res.json({ success: true, payments: payments.slice(0, 100) });
  } catch (e) {
    console.error("/api/payments error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== CLAIMS =====

// GET /api/claims - Get pending claims for a user (with sender fund status)
app.get("/api/claims", async (req, res) => {
  try {
    const handle = normalizeHandle(req.query.handle);
    if (!handle) {
      return res.status(400).json({ success: false, message: "handle required" });
    }

    // Get pending payments where user is recipient
    const claimsQuery = await paymentsCollection
      .where("recipient_username", "==", handle)
      .where("status", "==", "pending")
      .orderBy("created_at", "desc")
      .get();

    const claims = [];
    claimsQuery.forEach(doc => claims.push({ id: doc.id, ...doc.data() }));

    // Enrich with sender fund status
    const enrichedClaims = await Promise.all(claims.map(async (claim) => {
      // Get sender's wallet from Firestore
      const senderDoc = await usersCollection.doc(claim.sender_username).get();
      const senderWallet = senderDoc.exists ? senderDoc.data().wallet_address : null;

      if (senderWallet) {
        const fundStatus = await getSenderFundStatus(senderWallet);
        return {
          ...claim,
          sender_wallet: senderWallet,
          sender_balance: fundStatus.balance,
          sender_delegated_amount: fundStatus.delegatedAmount,
          sender_authorized: fundStatus.authorized,
          sender_can_pay: fundStatus.authorized && fundStatus.delegatedAmount >= claim.amount
        };
      }

      return {
        ...claim,
        sender_wallet: null,
        sender_balance: 0,
        sender_delegated_amount: 0,
        sender_authorized: false,
        sender_can_pay: false
      };
    }));

    res.json({ success: true, claims: enrichedClaims });
  } catch (e) {
    console.error("/api/claims error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/claim - Claim a payment (with sender fund verification)
app.post("/api/claim", async (req, res) => {
  try {
    const { tweet_id, wallet, username } = req.body;
    if (!tweet_id || !wallet || !username) {
      return res.status(400).json({ success: false, message: "tweet_id, wallet, and username required" });
    }

    const handle = normalizeHandle(username);

    // Get payment from Firestore
    const paymentDoc = await paymentsCollection.doc(tweet_id).get();
    if (!paymentDoc.exists) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    const payment = paymentDoc.data();

    if (payment.recipient_username !== handle) {
      return res.status(403).json({ success: false, error: "You are not the recipient of this payment" });
    }

    if (payment.status === 'completed' || payment.claimed_by) {
      return res.status(400).json({ success: false, error: "Payment already claimed" });
    }

    // Get sender's wallet
    const senderDoc = await usersCollection.doc(payment.sender_username).get();
    const senderWallet = senderDoc.exists ? senderDoc.data().wallet_address : null;

    if (!senderWallet) {
      return res.status(400).json({
        success: false,
        error: "Sender has not registered a wallet. They need to log in and fund their account."
      });
    }

    // Verify sender has sufficient authorized funds on-chain
    const fundStatus = await getSenderFundStatus(senderWallet);

    if (!fundStatus.authorized) {
      return res.status(400).json({
        success: false,
        error: "Sender has not authorized the vault. Ask them to authorize first.",
        sender_status: {
          authorized: false,
          balance: fundStatus.balance,
          delegated_amount: fundStatus.delegatedAmount
        }
      });
    }

    if (fundStatus.delegatedAmount < payment.amount) {
      return res.status(400).json({
        success: false,
        error: `Sender's authorized amount ($${fundStatus.delegatedAmount.toFixed(2)}) is less than payment amount ($${payment.amount}).`,
        sender_status: {
          authorized: true,
          balance: fundStatus.balance,
          delegated_amount: fundStatus.delegatedAmount,
          required: payment.amount
        }
      });
    }

    if (fundStatus.balance < payment.amount) {
      return res.status(400).json({
        success: false,
        error: `Sender's USDC balance ($${fundStatus.balance.toFixed(2)}) is less than payment amount ($${payment.amount}).`,
        sender_status: {
          authorized: true,
          balance: fundStatus.balance,
          delegated_amount: fundStatus.delegatedAmount,
          required: payment.amount
        }
      });
    }

    // ===== EXECUTE ON-CHAIN USDC TRANSFER =====
    let txSignature = null;

    if (!vaultKeypair) {
      return res.status(500).json({
        success: false,
        error: "Server not configured for transfers (vault keypair missing)"
      });
    }

    try {
      const senderPubkey = new PublicKey(senderWallet);
      const recipientPubkey = new PublicKey(wallet);
      const usdcMint = new PublicKey(USDC_MINT);

      const senderATA = await getAssociatedTokenAddress(usdcMint, senderPubkey);
      const recipientATA = await getAssociatedTokenAddress(usdcMint, recipientPubkey);

      const transferAmount = Math.floor(payment.amount * 1_000_000);

      console.log(`📤 Transfer: $${payment.amount} USDC from @${payment.sender_username} to @${handle}`);

      // Add priority fee to ensure transaction gets processed
      const priorityFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 50000  // 50,000 microlamports = 0.00005 SOL per CU
      });

      const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
        units: 100000  // Token transfer needs ~20k, but set higher for safety
      });

      const transferInstruction = createTransferInstruction(
        senderATA,
        recipientATA,
        vaultKeypair.publicKey,
        transferAmount,
        [],
        TOKEN_PROGRAM_ID
      );

      // Priority fees first, then transfer
      const transaction = new Transaction()
        .add(priorityFee)
        .add(computeLimit)
        .add(transferInstruction);
      transaction.feePayer = vaultKeypair.publicKey;

      const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;

      // Check vault SOL balance before sending
      const vaultBalance = await solanaConnection.getBalance(vaultKeypair.publicKey);
      if (vaultBalance < 5000) {
        throw new Error(`Vault has insufficient SOL for fees`);
      }

      // Sign the transaction
      transaction.sign(vaultKeypair);

      // Send raw transaction with skipPreflight for speed
      const rawTransaction = transaction.serialize();
      txSignature = await solanaConnection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 3
      });

      console.log(`📝 TX submitted: ${txSignature.slice(0, 20)}...`);

      // Confirm with timeout
      const confirmation = await solanaConnection.confirmTransaction({
        signature: txSignature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      console.log(`✅ Transfer successful! TX: ${txSignature}`);

    } catch (transferError) {
      console.error(`❌ On-chain transfer failed:`, transferError);
      return res.status(500).json({
        success: false,
        error: `Transfer failed: ${transferError.message}`,
        details: transferError.logs || null
      });
    }

    // Update payment in Firestore
    await paymentsCollection.doc(tweet_id).update({
      status: "completed",
      claimed_by: wallet,
      tx_signature: txSignature,
      claimed_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update recipient stats
    const recipientRef = usersCollection.doc(handle);
    await recipientRef.set({
      total_claimed: admin.firestore.FieldValue.increment(payment.amount),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Update sender stats
    const senderRef = usersCollection.doc(payment.sender_username);
    await senderRef.set({
      total_sent: admin.firestore.FieldValue.increment(payment.amount),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`💰 Payment claimed: @${payment.sender_username} → @${handle} $${payment.amount}`);

    res.json({
      success: true,
      message: "Payment claimed successfully",
      amount: payment.amount,
      sender: payment.sender_username,
      txSignature
    });
  } catch (e) {
    console.error("/api/claim error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== DEPOSITS =====

app.post("/api/deposit", async (req, res) => {
  try {
    const { handle, amount } = req.body;
    if (!handle || !amount) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const normalizedHandle = normalizeHandle(handle);
    const userRef = usersCollection.doc(normalizedHandle);

    await userRef.set({
      total_deposited: admin.firestore.FieldValue.increment(Number(amount)),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`💰 Deposit: @${normalizedHandle} +$${amount}`);
    res.json({ success: true, message: "Deposit recorded" });
  } catch (e) {
    console.error("/api/deposit error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== FUND STATUS CHECK =====

app.get("/api/check-fund-status", async (req, res) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet) {
      return res.status(400).json({ success: false, message: "wallet required" });
    }

    const status = await getSenderFundStatus(wallet);
    res.json({ success: true, ...status });
  } catch (e) {
    console.error("/api/check-fund-status error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== LEADERBOARD =====

app.get("/api/leaderboard", async (req, res) => {
  try {
    const usersSnapshot = await usersCollection.limit(50).get();
    const users = [];
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      const totalSent = data.total_sent || 0;
      const totalClaimed = data.total_claimed || 0;
      const points = (totalSent * 10) + (totalClaimed * 5); // 10 pts per $ sent, 5 pts per $ claimed

      if (totalSent > 0 || totalClaimed > 0) {
        users.push({
          x_username: data.x_username,
          wallet_address: doc.id, // The document ID is the wallet address
          total_sent: totalSent,
          total_claimed: totalClaimed,
          points
        });
      }
    });

    // Sort by points descending
    users.sort((a, b) => b.points - a.points);

    res.json({ success: true, users: users.slice(0, 20) });
  } catch (e) {
    console.error("/api/leaderboard error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== ADMIN =====

app.get("/api/admin/users", async (req, res) => {
  try {
    const usersSnapshot = await usersCollection.limit(100).get();
    const users = [];
    usersSnapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, users });
  } catch (e) {
    console.error("/api/admin/users error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== LOTTERY CLAIM =====
app.post("/api/lottery/claim", async (req, res) => {
  const { lotteryId, winnerWallet } = req.body;

  if (!lotteryId || !winnerWallet) {
    return res.status(400).json({ success: false, message: "Missing lotteryId or winnerWallet" });
  }

  if (!vaultKeypair) {
    return res.status(500).json({ success: false, message: "Vault not configured for transfers" });
  }

  console.log(`🎰 Processing lottery claim: ${lotteryId} for ${winnerWallet}`);

  try {
    // Get lottery from Firebase
    const lotteriesCollection = firestore.collection("lotteries");
    const lotteryDoc = await lotteriesCollection.doc(lotteryId).get();

    if (!lotteryDoc.exists) {
      return res.status(404).json({ success: false, message: "Lottery not found" });
    }

    const lottery = lotteryDoc.data();

    // Validate lottery status and winner
    if (lottery.status === 'claimed') {
      return res.status(400).json({ success: false, message: "Prize already claimed" });
    }

    if (lottery.status !== 'completed') {
      return res.status(400).json({ success: false, message: "Lottery not yet drawn" });
    }

    if (!lottery.winner || lottery.winner.walletAddress !== winnerWallet) {
      return res.status(403).json({ success: false, message: "Not the winner of this lottery" });
    }

    const prizeAmount = lottery.prizeAmount || 0;
    if (prizeAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid prize amount" });
    }

    // Convert $ to USDC (6 decimals)
    const usdcAmount = Math.floor(prizeAmount * 1000000);

    // Get token accounts
    const vaultPubkey = vaultKeypair.publicKey;
    const recipientPubkey = new PublicKey(winnerWallet);
    const usdcMintPubkey = new PublicKey(USDC_MINT);

    const vaultAta = await getAssociatedTokenAddress(usdcMintPubkey, vaultPubkey);
    const recipientAta = await getAssociatedTokenAddress(usdcMintPubkey, recipientPubkey);

    // Check vault balance
    try {
      const vaultAccount = await getAccount(solanaConnection, vaultAta);
      if (Number(vaultAccount.amount) < usdcAmount) {
        console.error("❌ Insufficient vault balance for lottery claim");
        return res.status(400).json({
          success: false,
          message: `Insufficient vault balance. Need ${prizeAmount} USDC`
        });
      }
    } catch (e) {
      console.error("❌ Error checking vault balance:", e);
      return res.status(500).json({ success: false, message: "Could not verify vault balance" });
    }

    // Build transfer transaction
    const transaction = new Transaction();

    // Add priority fee for faster confirmation
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Add transfer instruction
    transaction.add(
      createTransferInstruction(
        vaultAta,
        recipientAta,
        vaultPubkey,
        usdcAmount,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    // Get latest blockhash
    const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = vaultPubkey;

    // Sign and send
    transaction.sign(vaultKeypair);
    const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });

    console.log(`📤 Lottery prize transfer sent: ${signature}`);

    // Confirm transaction
    await solanaConnection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, "confirmed");

    console.log(`✅ Lottery prize confirmed: ${signature}`);

    // Update lottery status in Firebase
    await lotteriesCollection.doc(lotteryId).update({
      status: 'claimed',
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      claimTxSignature: signature
    });

    console.log(`🎉 Lottery ${lotteryId} claimed successfully!`);

    res.json({
      success: true,
      txSignature: signature,
      amount: prizeAmount,
      message: `Successfully transferred $${prizeAmount} USDC`
    });

  } catch (e) {
    console.error("❌ Lottery claim error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/rescan", async (req, res) => {
  await runScheduledTweetCheck();
  res.json({ success: true, message: "Manual rescan triggered" });
});

// ===== TWITTER SCANNER =====
async function runScheduledTweetCheck() {
  if (!X_BEARER_TOKEN) {
    console.warn("⚠️ No X_BEARER_TOKEN set; skipping scan");
    return;
  }

  console.log(`🔍 Checking mentions for @${BOT_HANDLE}...`);
  try {
    const lastSeen = await getMeta("last_seen_tweet_id");

    const q = encodeURIComponent(`@${BOT_HANDLE} send -is:retweet -is:quote`);

    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${q}` +
      `&tweet.fields=author_id,created_at,text,referenced_tweets` +
      `&expansions=author_id` +
      `&user.fields=username` +
      (lastSeen ? `&since_id=${lastSeen}` : "");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` }
    });

    if (response.status === 429) {
      console.warn("⚠️ Rate limit reached (429 Too Many Requests). Skipping this cycle.");
      return;
    }

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`X API error: ${txt}`);
    }

    const data = await response.json();
    if (!data.data || data.data.length === 0) {
      console.log("No mentions found.");
      return;
    }

    const users = {};
    if (data.includes && data.includes.users) {
      for (const u of data.includes.users) {
        users[u.id] = u.username.toLowerCase();
      }
    }

    let newestId = lastSeen;
    for (const tweet of data.data) {
      const text = (tweet.text || "").toLowerCase();

      if (text.startsWith("rt ") || text.includes(" rt @") || text.includes("\nrt ")) {
        console.log(`⏭ Skipping manual RT-style tweet ${tweet.id}`);
        continue;
      }

      if (tweet.referenced_tweets && Array.isArray(tweet.referenced_tweets)) {
        const isRef = tweet.referenced_tweets.some(r => r.type === "retweeted" || r.type === "quoted");
        if (isRef) {
          console.log(`⏭ Skipping retweet/quote ${tweet.id}`);
          continue;
        }
      }

      const parsed = parsePaymentCommand(tweet.text || "");
      if (parsed && parsed.recipient && Number.isFinite(parsed.amount)) {
        const sender = users[tweet.author_id] || tweet.author_id || "unknown";
        await recordPayment(sender, parsed.recipient, parsed.amount, tweet.id);
      }

      if (!newestId || BigInt(tweet.id) > BigInt(newestId)) {
        newestId = tweet.id;
      }
    }

    if (newestId) await upsertMeta("last_seen_tweet_id", newestId);
    console.log(`✅ Scan complete (${data.data.length} tweets checked).`);
  } catch (e) {
    console.error("X scan error:", e.message);
  }
}

app.listen(PORT, () => console.log(`🚀 WASSY backend listening on ${PORT}`));
