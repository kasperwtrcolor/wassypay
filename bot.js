import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fetch from 'node-fetch';
import { TwitterApi } from 'twitter-api-v2';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new TwitterApi({
  appKey: process.env.TWITTER_APP_KEY,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});
const rwClient = client.readWrite;

const BACKEND_URL = process.env.BACKEND_URL;

/** ✅ Parse commands like "@wassy_bot send @user $5" */
function parsePaymentCommand(text) {
  const regex = /send\s+@(\w+)\s*\$?(\d+(\.\d{1,2})?)/i;
  const match = text.match(regex);
  if (!match) return null;
  return {
    toHandle: match[1],
    amount: parseFloat(match[2])
  };
}

/** ✅ Webhook endpoint (Twitter dev portal will hit this) */
app.post('/x-webhook', async (req, res) => {
  try {
    const event = req.body;
    if (!event?.tweet_create_events) return res.sendStatus(200);

    for (const tweet of event.tweet_create_events) {
      const { text, id_str, user } = tweet;
      if (!text.includes('@wassy_bot')) continue;

      const command = parsePaymentCommand(text);
      if (!command) {
        await rwClient.v2.reply(
          `❌ Invalid command. Try: "@wassy_bot send @username $5"`,
          id_str
        );
        continue;
      }

      const fromUser = user.screen_name;
      const { toHandle, amount } = command;

      console.log(`💸 Payment command: ${fromUser} → ${toHandle} (${amount} USDC)`);

      const response = await fetch(`${BACKEND_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromUser, toHandle, amount })
      });

      const result = await response.json();

      if (result.success) {
        await rwClient.v2.reply(
          `✅ @${fromUser} sent $${amount} USDC to @${toHandle}! #WASSYPAY`,
          id_str
        );
      } else {
        await rwClient.v2.reply(
          `⚠️ Payment failed: ${result.message || 'Insufficient funds or user not found.'}`,
          id_str
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🤖 WASSY Bot running on port ${PORT}`));
