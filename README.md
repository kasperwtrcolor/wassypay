WASSY PAY — Decentralized Social Payments via X (Twitter) + Solana

WASSY Pay is a decentralized micro-payments system that lets users send USDC to each other through X posts using the @bot_wassy bot.
Users FUND → TAG → CLAIM, and the app handles all accounting, on-chain settlement, and cross-platform identity (wallet + X handle).

WASSY Pay allows users to send money by writing a simple X post:

@bot_wassy send @username $amount

The backend scans X every 30 minutes → records the payment → the recipient sees it in the WASSY Pay app → claims the USDC → and the sender’s app balance auto-updates.

All accounting and transfers happen on Solana with a transparent, trust-minimized system.

No account numbers.
No banks.
Just a post.

⸻

Architecture Overview

┌──────────────────────┐
│   FRONTEND (React)   │
│ - Wallet Connect      │
│ - Connect X account   │
│ - Fund balance        │
│ - Claim payments      │
│ - Leaderboard         │
└─────────────▲────────┘
              │
              │ fetches
              │ payments & claims
              ▼
┌──────────────────────────────┐
│   BACKEND (Node / Express)   │
│ - Scans X API every 30 mins  │
│ - Records @bot_wassy sends   │
│ - Tracks deposits            │
│ - Returns pending claims     │
│ - Prevents retweet spam      │
└─────────────▲────────────────┘
              │
              │ triggers actions
              ▼
┌──────────────────────────────┐
│        DEVBASE LOGIC         │
│ - Profiles (wallet + X)      │
│ - Funds accounting           │
│ - Payment claims             │
│ - Transfer USDC on Solana    │
│ - Compute functions          │
└─────────────▲────────────────┘
              │
              │ does settlement
              ▼
┌──────────────────────────────┐
│      SOLANA BLOCKCHAIN       │
│ - Vault wallet               │
│ - USDC transfers             │
└──────────────────────────────┘


⸻

🧩 Flow Overview (FUND → TAG → CLAIM)

1. FUND

User connects:
	•	Solana wallet
	•	X account

Then deposits USDC into the WASSY vault.
Funds tracked in Devbase → stored in funds entity.

⸻

2. TAG

User sends payment using an X post:

@bot_wassy send @kasperwtrcolor $3

Backend scans for:
	•	@bot_wassy
	•	send
	•	X handle
	•	Amount

Retweets, quotes, and duplicates are automatically ignored.

Payment is stored in SQLite:

sender: <x_handle>
recipient: <x_handle>
amount: <number>
tweet_id: <id>

⸻

📡 Backend Features

✔ X scanning every 30 minutes

Uses Twitter API v2 search endpoint:

query = "@bot_wassy send -is:retweet -is:quote"

✔ Duplicate protection

Prevents:
	•	same tweet
	•	duplicate sender→recipient→amount within 120min
	•	retweets
	•	quote tweets
	•	manual “RT @” reposts

Token Flow

USER → WASSY (vault) → recipient

Sender’s USDC is held escrow-style until:
	1.	Payment is posted
	2.	The backend detects it
	3.	Recipient clicks Claim
	4.	Devbase performs transfer
	5.	Sender and recipient balances update

📘 License

MIT

⸻
