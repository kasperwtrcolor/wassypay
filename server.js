import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_HANDLE = (process.env.BOT_HANDLE || "bot_wassy").toLowerCase();
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ADMIN_WALLET = process.env.ADMIN_WALLET || "6SxLVfFovSjR2LAFcJ5wfT6RFjc8GxsscRekGnLq8BMe";

// Solana configuration
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const USDC_MINT = process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "HXAV7ysEaCH8imtGLU7A8c51tbP34NT9t8L3zvfR8L3Q";

// Create Solana connection
const solanaConnection = new Connection(SOLANA_RPC, "confirmed");

// Load vault keypair for executing transfers
// VAULT_PRIVATE_KEY should be a base58-encoded private key
let vaultKeypair = null;
if (process.env.VAULT_PRIVATE_KEY) {
  try {
    const secretKey = bs58.decode(process.env.VAULT_PRIVATE_KEY);
    vaultKeypair = Keypair.fromSecretKey(secretKey);
    console.log(`✅ Vault keypair loaded: ${vaultKeypair.publicKey.toBase58().slice(0, 8)}...`);
  } catch (e) {
    console.error("❌ Failed to load vault keypair:", e.message);
  }
} else {
  console.warn("⚠️ VAULT_PRIVATE_KEY not set - transfers will be disabled");
}

let db;

// ===== DB SETUP =====
(async () => {
  db = await open({
    filename: process.env.DB_PATH || "./wassy.db",
    driver: sqlite3.Database
  });

  // Users table - stores registered users
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x_username TEXT UNIQUE NOT NULL,
      x_user_id TEXT,
      wallet_address TEXT,
      is_delegated INTEGER DEFAULT 0,
      delegation_amount REAL DEFAULT 0,
      delegation_signature TEXT,
      total_deposited REAL DEFAULT 0,
      total_sent REAL DEFAULT 0,
      total_claimed REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Payments table - stores all payment records from tweets
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT UNIQUE,
      sender TEXT NOT NULL,
      sender_username TEXT,
      recipient TEXT NOT NULL,
      recipient_username TEXT,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      claimed_by TEXT,
      tx_signature TEXT,
      error_message TEXT,
      tweet_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Meta table for key-value storage
  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Fund deposits tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS fund_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT,
      amount REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database initialized");

  // Run scan at boot
  runScheduledTweetCheck();

  // Schedule every 30 minutes
  setInterval(runScheduledTweetCheck, SCAN_INTERVAL_MS);
})();

// ===== HELPERS =====
async function upsertMeta(key, value) {
  await db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, String(value)]
  );
}

async function getMeta(key) {
  const row = await db.get(`SELECT value FROM meta WHERE key = ?`, [key]);
  return row?.value ?? null;
}

function normalizeHandle(h) {
  if (!h) return "";
  return h.replace(/^@/, "").toLowerCase();
}

async function ensureUser(x_username) {
  const handle = normalizeHandle(x_username);
  let user = await db.get(`SELECT * FROM users WHERE x_username = ?`, [handle]);
  if (!user) {
    await db.run(`INSERT INTO users (x_username) VALUES (?)`, [handle]);
    user = await db.get(`SELECT * FROM users WHERE x_username = ?`, [handle]);
  }
  return user;
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

    // Get sender's USDC token account
    const ata = await getAssociatedTokenAddress(usdcMintPubkey, walletPubkey);

    let balance = 0;
    let delegatedAmount = 0;
    let authorized = false;

    try {
      const tokenAccount = await getAccount(solanaConnection, ata);
      // Balance is in smallest units (6 decimals for USDC)
      balance = Number(tokenAccount.amount) / 1_000_000;

      // Debug: Log delegation info
      console.log(`🔍 Checking delegation for ${walletAddress.slice(0, 8)}...`);
      console.log(`   Token Account delegate: ${tokenAccount.delegate?.toBase58() || 'NONE'}`);
      console.log(`   Expected vault: ${vaultPubkey.toBase58()}`);
      console.log(`   Delegated amount: ${Number(tokenAccount.delegatedAmount) / 1_000_000} USDC`);

      // Check if vault is the delegate and has allowance
      if (tokenAccount.delegate && tokenAccount.delegate.equals(vaultPubkey)) {
        delegatedAmount = Number(tokenAccount.delegatedAmount) / 1_000_000;
        authorized = delegatedAmount > 0;
        console.log(`   ✅ Authorized: ${authorized} (${delegatedAmount} USDC)`);
      } else if (tokenAccount.delegate) {
        console.log(`   ⚠️ Delegate mismatch! Token delegated to: ${tokenAccount.delegate.toBase58()}`);
      } else {
        console.log(`   ❌ No delegation set`);
      }
    } catch (tokenErr) {
      // Token account doesn't exist = 0 balance
      console.log(`Token account not found for ${walletAddress}`);
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

    // Skip if same tweet already exists
    const existingByTweet = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [tweet_id]);
    if (existingByTweet) {
      console.log(`⛔ Tweet ${tweet_id} already recorded — skipping`);
      return;
    }

    // Skip logical duplicates (same sender, recipient, amount in last 2h)
    const dup = await db.get(
      `SELECT * FROM payments 
       WHERE sender = ? AND recipient = ? AND amount = ? 
         AND created_at >= datetime('now', '-120 minutes')`,
      [s, r, a]
    );
    if (dup) {
      console.log(`⛔ Duplicate detected for @${s} → @${r} $${a} — skipping`);
      return;
    }

    // Insert new payment
    await db.run(
      `INSERT INTO payments (tweet_id, sender, sender_username, recipient, recipient_username, amount, status, tweet_url)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [tweet_id, s, s, r, r, a, `https://twitter.com/i/status/${tweet_id}`]
    );

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
  if (a) {
    return { recipient: a[1], amount: parseFloat(a[2]) };
  }

  // Format B: send $5 to @user
  const b = t.match(/send\s*\$?\s*([\d.]+)\s*(?:to)?\s*@(\w+)/i);
  if (b) {
    return { recipient: b[2], amount: parseFloat(b[1]) };
  }

  return null;
}

// ===== ROUTES =====
app.get("/", (_, res) => {
  res.send("🟢 WASSY PAY backend active — 30-min X scans + tweet-based payment logging");
});

app.get("/health", (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ===== USER AUTHENTICATION =====

// POST /api/login - Register or login user
app.post("/api/login", async (req, res) => {
  try {
    const { x_username, x_user_id, wallet_address } = req.body;
    if (!x_username) {
      return res.status(400).json({ success: false, message: "x_username required" });
    }

    const handle = normalizeHandle(x_username);

    // Upsert user
    await db.run(
      `INSERT INTO users (x_username, x_user_id, wallet_address, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(x_username) DO UPDATE SET 
         x_user_id = COALESCE(excluded.x_user_id, x_user_id),
         wallet_address = COALESCE(excluded.wallet_address, wallet_address),
         updated_at = CURRENT_TIMESTAMP`,
      [handle, x_user_id || null, wallet_address || null]
    );

    const user = await db.get(`SELECT * FROM users WHERE x_username = ?`, [handle]);

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

    await db.run(
      `UPDATE users SET 
        is_delegated = 1,
        delegation_amount = ?,
        delegation_signature = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE wallet_address = ?`,
      [Number(amount), signature || null, wallet]
    );

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

    const rows = await db.all(
      `SELECT * FROM payments 
       WHERE sender_username = ? OR recipient_username = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [handle, handle]
    );

    res.json({ success: true, payments: rows });
  } catch (e) {
    console.error("/api/payments/:username error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/payments - Query payments (existing endpoint)
app.get("/api/payments", async (req, res) => {
  try {
    const { id, tweet_id, recipient, handle, status } = req.query;

    const singleKey = id || tweet_id;
    if (singleKey) {
      const row = await db.get(`SELECT * FROM payments WHERE tweet_id = ?`, [String(singleKey)]);
      if (!row) return res.json({ success: false, message: "not_found" });
      return res.json({ success: true, payments: [row] });
    }

    const where = [];
    const args = [];
    if (recipient) {
      where.push(`recipient_username = ?`);
      args.push(normalizeHandle(recipient));
    }
    if (handle) {
      where.push(`(sender_username = ? OR recipient_username = ?)`);
      args.push(normalizeHandle(handle), normalizeHandle(handle));
    }
    if (status) {
      where.push(`status = ?`);
      args.push(status);
    }

    const sql = `SELECT * FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""
      } ORDER BY created_at DESC LIMIT 100`;

    const rows = await db.all(sql, args);
    res.json({ success: true, payments: rows });
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

    // Get payments where user is recipient and not yet claimed
    // Use LOWER() for case-insensitive match on sender username
    const rows = await db.all(
      `SELECT p.*, u.wallet_address as sender_wallet, u.is_delegated as sender_db_delegated
       FROM payments p
       LEFT JOIN users u ON LOWER(p.sender_username) = LOWER(u.x_username)
       WHERE LOWER(p.recipient_username) = LOWER(?) AND p.status = 'pending' AND p.claimed_by IS NULL
       ORDER BY p.created_at DESC`,
      [handle]
    );

    // Debug: List all users in DB for comparison
    const allUsers = await db.all(`SELECT x_username, wallet_address FROM users`);
    console.log(`📋 Fetching claims for @${handle}`);
    console.log(`   Users in DB: ${allUsers.map(u => `@${u.x_username}(${u.wallet_address ? 'has wallet' : 'no wallet'})`).join(', ') || 'NONE'}`);
    console.log(`   Found ${rows.length} pending claims`);

    // Enrich each claim with on-chain sender fund status
    const enrichedClaims = await Promise.all(rows.map(async (claim) => {
      // Debug: Log what we found
      console.log(`📋 Claim: @${claim.sender_username} → @${claim.recipient_username} $${claim.amount}`);
      console.log(`   Sender wallet from DB: ${claim.sender_wallet || 'NOT FOUND'}`);

      if (claim.sender_wallet) {
        const fundStatus = await getSenderFundStatus(claim.sender_wallet);
        return {
          ...claim,
          sender_balance: fundStatus.balance,
          sender_delegated_amount: fundStatus.delegatedAmount,
          sender_authorized: fundStatus.authorized,
          sender_can_pay: fundStatus.authorized && fundStatus.delegatedAmount >= claim.amount
        };
      }
      // No wallet registered for sender
      console.log(`   ⚠️ No wallet found for sender @${claim.sender_username}`);
      return {
        ...claim,
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

    // Check if payment exists and is claimable
    const payment = await db.get(
      `SELECT p.*, u.wallet_address as sender_wallet
       FROM payments p
       LEFT JOIN users u ON p.sender_username = u.x_username
       WHERE p.tweet_id = ? AND p.recipient_username = ?`,
      [tweet_id, handle]
    );

    if (!payment) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    if (payment.status === 'completed' || payment.claimed_by) {
      return res.status(400).json({ success: false, error: "Payment already claimed" });
    }

    // Verify sender has sufficient authorized funds on-chain
    if (payment.sender_wallet) {
      const fundStatus = await getSenderFundStatus(payment.sender_wallet);

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
    } else {
      // Sender hasn't registered their wallet
      return res.status(400).json({
        success: false,
        error: "Sender has not registered a wallet. They need to log in and fund their account."
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
      // Get sender wallet
      const senderUser = await db.get(
        `SELECT wallet_address FROM users WHERE x_username = ?`,
        [payment.sender_username]
      );

      if (!senderUser?.wallet_address) {
        return res.status(400).json({
          success: false,
          error: "Sender wallet not found"
        });
      }

      const senderPubkey = new PublicKey(senderUser.wallet_address);
      const recipientPubkey = new PublicKey(wallet);
      const usdcMint = new PublicKey(USDC_MINT);

      // Get Associated Token Accounts
      const senderATA = await getAssociatedTokenAddress(usdcMint, senderPubkey);
      const recipientATA = await getAssociatedTokenAddress(usdcMint, recipientPubkey);

      // Convert amount to USDC decimals (6 decimals)
      const transferAmount = Math.floor(payment.amount * 1_000_000);

      console.log(`📤 Initiating transfer: ${payment.amount} USDC`);
      console.log(`   From: ${senderPubkey.toBase58().slice(0, 8)}... (ATA: ${senderATA.toBase58().slice(0, 8)}...)`);
      console.log(`   To: ${recipientPubkey.toBase58().slice(0, 8)}... (ATA: ${recipientATA.toBase58().slice(0, 8)}...)`);

      // Create transfer instruction
      // Note: This uses the delegation where the sender has approved the vault to transfer on their behalf
      const transferInstruction = createTransferInstruction(
        senderATA,           // source
        recipientATA,        // destination
        vaultKeypair.publicKey, // owner/delegate (vault is the delegate)
        transferAmount,      // amount
        [],                  // multiSigners
        TOKEN_PROGRAM_ID
      );

      // Build transaction
      const transaction = new Transaction().add(transferInstruction);
      transaction.feePayer = vaultKeypair.publicKey;

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;

      // Sign and send transaction
      txSignature = await sendAndConfirmTransaction(
        solanaConnection,
        transaction,
        [vaultKeypair],
        { commitment: 'confirmed' }
      );

      console.log(`✅ Transfer successful! TX: ${txSignature}`);

    } catch (transferError) {
      console.error(`❌ On-chain transfer failed:`, transferError);
      return res.status(500).json({
        success: false,
        error: `Transfer failed: ${transferError.message}`,
        details: transferError.logs || null
      });
    }

    // Mark as claimed with transaction signature
    await db.run(
      `UPDATE payments SET 
        status = 'completed',
        claimed_by = ?,
        tx_signature = ?
       WHERE tweet_id = ?`,
      [wallet, txSignature, tweet_id]
    );

    // Update user stats
    await db.run(
      `UPDATE users SET 
        total_claimed = total_claimed + ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE x_username = ?`,
      [payment.amount, handle]
    );

    // Update sender stats
    await db.run(
      `UPDATE users SET 
        total_sent = total_sent + ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE x_username = ?`,
      [payment.amount, payment.sender_username]
    );

    console.log(`💰 Payment claimed: @${payment.sender_username} → @${handle} $${payment.amount}`);

    res.json({
      success: true,
      message: "Payment claimed successfully",
      amount: payment.amount,
      sender: payment.sender_username,
      txSignature: txSignature
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

    await db.run(
      `INSERT INTO fund_deposits (handle, amount, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [normalizedHandle, amount]
    );

    // Update user's total deposited
    await db.run(
      `UPDATE users SET 
        total_deposited = total_deposited + ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE x_username = ?`,
      [Number(amount), normalizedHandle]
    );

    console.log(`💰 Deposit recorded: ${handle} +${amount} USDC`);
    res.json({ success: true, message: "Deposit recorded" });
  } catch (e) {
    console.error("/api/deposit error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== ADMIN =====

// GET /api/admin/users - Get all users (admin only)
app.get("/api/admin/users", async (req, res) => {
  try {
    // In production, add proper authentication here
    const users = await db.all(
      `SELECT x_username, wallet_address, is_delegated, delegation_amount,
              total_deposited, total_sent, total_claimed, created_at
       FROM users
       ORDER BY (total_deposited + total_sent + total_claimed) DESC
       LIMIT 100`
    );

    res.json({ success: true, users });
  } catch (e) {
    console.error("/api/admin/users error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/rescan - Trigger manual tweet scan
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

      // Skip manual RT-style copies
      if (text.startsWith("rt ") || text.includes(" rt @") || text.includes("\nrt ")) {
        console.log(`⏭ Skipping manual RT-style tweet ${tweet.id}`);
        continue;
      }

      // Skip if tweet references another as retweet/quote
      if (tweet.referenced_tweets && Array.isArray(tweet.referenced_tweets)) {
        const isRef = tweet.referenced_tweets.some(r => r.type === "retweeted" || r.type === "quoted");
        if (isRef) {
          console.log(`⏭ Skipping retweet/quote ${tweet.id}`);
          continue;
        }
      }

      // Parse payment command
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
