require("dotenv").config();
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const alerted = new Set();

async function fetchNewTokens() {
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/token-profiles/latest/v1",
    );
    return res.data || [];
  } catch (err) {
    console.error("DexScreener error:", err.message);
    return [];
  }
}

function passesFilter(token) {
  const liquidity = token?.liquidity?.usd || 0;
  const volume = token?.volume?.h1 || 0;
  const chainId = token?.chainId || "";
  return chainId === "solana" && liquidity > 10000 && volume > 5000;
}

function scoreToken(token) {
  let score = 5;
  if ((token?.volume?.h1 || 0) > 20000) score += 1;
  if ((token?.txns?.h1?.buys || 0) > (token?.txns?.h1?.sells || 0)) score += 1;
  if ((token?.priceChange?.h1 || 0) > 10) score += 1;
  return Math.min(score, 10);
}

function getRiskLevel(score) {
  if (score >= 8) return "🟢 Low";
  if (score >= 6) return "🟡 Medium";
  return "🔴 High";
}

async function sendAlert(token) {
  const score = scoreToken(token);
  const risk = getRiskLevel(score);

  const message = `
🚨 *NEW TOKEN ALERT*

📌 *Name:* ${token.name || "Unknown"}
🔤 *Ticker:* $${token.symbol || "N/A"}
⛓ *Chain:* ${token.chainId || "N/A"}

─────────────────
📊 *METRICS*
💧 Liquidity: $${(token?.liquidity?.usd || 0).toLocaleString()}
📈 Volume (1h): $${(token?.volume?.h1 || 0).toLocaleString()}
🔁 Buys/Sells: ${token?.txns?.h1?.buys || 0}/${token?.txns?.h1?.sells || 0}
📉 Price Change (1h): ${token?.priceChange?.h1 || 0}%

─────────────────
⚠️ *RISK LEVEL:* ${risk}
🎯 *SCORE:* ${score}/10

─────────────────
🤖 *ANALYSIS*
Early signal detected. Monitor closely.
Exit suggested at 3x-5x.

🔗 [DexScreener](https://dexscreener.com/${token.chainId}/${token.pairAddress})
  `.trim();

  await bot.sendMessage(CHAT_ID, message, { parse_mode: "Markdown" });
}

async function scan() {
  console.log("🔍 Scanning for new tokens...");
  const tokens = await fetchNewTokens();

  for (const token of tokens) {
    const id = token.pairAddress || token.tokenAddress;
    if (!id || alerted.has(id)) continue;
    if (passesFilter(token)) {
      alerted.add(id);
      await sendAlert(token);
      console.log(`✅ Alert sent for ${token.symbol}`);
    }
  }
}

scan();
setInterval(scan, 30000);
console.log("🚀 Memecoin bot started...");
