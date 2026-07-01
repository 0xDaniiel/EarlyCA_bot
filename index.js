require("dotenv").config();
const axios = require("axios");
const TelegramBot =
  require("node-telegram-bot-api").default || require("node-telegram-bot-api");
const { Anthropic } = require("@anthropic-ai/sdk");
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const alerted = new Set();

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  addSubscriber(chatId);
  bot.sendMessage(chatId, "You're subscribed to memecoin alerts!");
});

const fs = require("fs");
const SUBS_FILE = "./subscribers.json";

function loadSubscribers() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function addSubscriber(chatId) {
  const subs = loadSubscribers();
  if (!subs.includes(chatId)) {
    subs.push(chatId);
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs));
  }
}
async function fetchNewTokens() {
  const tokenMap = new Map();

  // Source 1: DexScreener new pairs
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/latest/dex/pairs/solana",
    );
    const pairs = res.data?.pairs || [];
    for (const pair of pairs.slice(0, 50)) {
      const addr = pair.baseToken?.address;
      if (addr && !tokenMap.has(addr)) {
        tokenMap.set(addr, { ...pair, tokenAddress: addr });
      }
    }
  } catch (e) {
    console.error("DexScreener fetch error:", e.message);
  }

  // Source 2: Pump.fun new tokens via DexScreener
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/latest/dex/search?q=pump&chainId=solana",
    );
    const pairs = res.data?.pairs || [];
    for (const pair of pairs.slice(0, 50)) {
      const addr = pair.baseToken?.address;
      if (addr && !tokenMap.has(addr)) {
        tokenMap.set(addr, { ...pair, tokenAddress: addr });
      }
    }
  } catch (e) {
    console.error("Pump.fun fetch error:", e.message);
  }

  // Source 3: Raydium new pools via DexScreener
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/latest/dex/search?q=raydium&chainId=solana",
    );
    const pairs = res.data?.pairs || [];
    for (const pair of pairs.slice(0, 50)) {
      const addr = pair.baseToken?.address;
      if (addr && !tokenMap.has(addr)) {
        tokenMap.set(addr, { ...pair, tokenAddress: addr });
      }
    }
  } catch (e) {
    console.error("Raydium fetch error:", e.message);
  }

  return Array.from(tokenMap.values());
}

async function getRugcheckData(tokenAddress) {
  try {
    const res = await axios.get(
      "https://api.rugcheck.xyz/v1/tokens/" + tokenAddress + "/report",
      {
        timeout: 5000,
      },
    );
    const topHolder = res.data?.topHolders?.[0];
    return {
      score: res.data?.score_normalised || 0,
      lpLockedPct: res.data?.lpLockedPct || 0,
      risks: res.data?.risks || [],
      totalHolders: res.data?.totalHolders || 0,
      topHolderPct: topHolder?.pct || 0,
    };
  } catch (e) {
    return null;
  }
}

async function passesFilter(token) {
  const chainId = token?.chainId || "";
  const volume = token?.volume?.h1 || 0;
  const liquidity = token?.liquidity?.usd || 0;
  const marketCap = token?.marketCap || 0;
  const buys = token?.txns?.h1?.buys || 0;
  const name = token?.baseToken?.symbol || "unknown";
  const ageMs = Date.now() - (token?.pairCreatedAt || 0);
  const ageMin = Math.floor(ageMs / 60000);
  const isNewLaunch = ageMin < 10;

  if (chainId !== "solana") return false;

  if (isNewLaunch) {
    // Relaxed thresholds for tokens under 10 minutes old
    if (volume < 1000) {
      console.log(name, "failed: new launch low volume", volume);
      return false;
    }
    if (buys < 5) {
      console.log(name, "failed: new launch low buys", buys);
      return false;
    }
    if (liquidity === 0 && marketCap < 10000) {
      console.log(name, "failed: new launch low mcap");
      return false;
    }
    if (liquidity > 0 && liquidity < 3000) {
      console.log(name, "failed: new launch low liquidity", liquidity);
      return false;
    }
  } else {
    // Existing strict thresholds for tokens over 10 minutes old
    if (volume < 5000) {
      console.log(name, "failed: low volume", volume);
      return false;
    }
    if (buys < 20) {
      console.log(name, "failed: low buys", buys);
      return false;
    }
    if (liquidity === 0 && marketCap < 30000) {
      console.log(name, "failed: low mcap");
      return false;
    }
    if (liquidity > 0 && liquidity < 10000) {
      console.log(name, "failed: low liquidity", liquidity);
      return false;
    }
  }

  // Safety checks always apply regardless of age
  const rugcheck = await getRugcheckData(token.tokenAddress);
  if (!rugcheck || rugcheck.score < 65) {
    console.log(name, "failed: rugcheck score", rugcheck?.score);
    return false;
  }
  if (rugcheck.topHolderPct > 30) {
    console.log(name, "failed: top holder", rugcheck.topHolderPct);
    return false;
  }

  return true;
}

function scoreToken(token, rugcheck) {
  let score = 5;
  const volume = token?.volume?.h1 || 0;
  const buys = token?.txns?.h1?.buys || 0;
  const sells = token?.txns?.h1?.sells || 0;
  const priceChange = token?.priceChange?.h1 || 0;
  const liquidity = token?.liquidity?.usd || 0;
  const marketCap = token?.marketCap || 0;

  if (volume > 20000) score += 1;
  if (buys > sells) score += 1;
  if (priceChange > 10) score += 1;
  if (liquidity > 50000 || marketCap > 60000) score += 1;

  if (rugcheck) {
    if (rugcheck.lpLockedPct === 0) score -= 2;
    if (rugcheck.topHolderPct > 15) score -= 1;
    if (rugcheck.risks.some((r) => r.name.toLowerCase().includes("rug")))
      score -= 2;
  }

  return Math.min(Math.max(score, 1), 10);
}

function getRiskLevel(score, rugcheck) {
  if (rugcheck) {
    if (rugcheck.lpLockedPct === 0 && rugcheck.topHolderPct > 15) return "High";
    if (rugcheck.risks.some((r) => r.name.toLowerCase().includes("rug")))
      return "High";
  }
  if (score >= 8) return "Low";
  if (score >= 6) return "Medium";
  return "High";
}

function formatRisk(riskScore) {
  if (riskScore >= 80) return "Very Low";
  if (riskScore >= 60) return "Low";
  if (riskScore >= 40) return "Medium";
  return "High";
}
async function sendAdminAlert(message) {
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, " BOT ERROR\n\n" + message);
  } catch (e) {
    console.error("Failed to send admin alert:", e.message);
  }
}

async function generateAnalysis(token, rugcheck) {
  try {
    const prompt = `You are a crypto memecoin analyst. Analyze this Solana token and provide a brief trading signal (2-3 sentences max).

Token: ${token.baseToken?.name}
Ticker: ${token.baseToken?.symbol}
Market Cap: $${(token?.marketCap || 0).toLocaleString()}
Liquidity: $${(token?.liquidity?.usd || 0).toLocaleString()}
Volume (1h): $${(token?.volume?.h1 || 0).toLocaleString()}
Buys/Sells (1h): ${token?.txns?.h1?.buys || 0}/${token?.txns?.h1?.sells || 0}
Price Change (1h): ${token?.priceChange?.h1 || 0}%
Total Holders: ${rugcheck?.totalHolders || 0}
Top Holder: ${rugcheck?.topHolderPct.toFixed(2) || 0}%
LP Locked: ${rugcheck?.lpLockedPct || 0}%
Rugcheck Score: ${rugcheck?.score || 0}/100

IMPORTANT: Reply in plain text only. Do NOT use asterisks, bold, headers, or any markdown formatting whatsoever. No ** or * characters anywhere in your response.
1. Momentum: one sentence on signals
2. Exit range: suggested target (e.g., 3x-5x or $100k-$150k mcap)
3. Risk: one key risk to watch`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    return message.content[0].type === "text"
      ? message.content[0].text
      : "Unable to generate analysis";
  } catch (e) {
    console.error("Claude error:", e.message);
    return "Analysis unavailable";
  }
}

async function sendAlert(token, rugcheck) {
  const score = scoreToken(token, rugcheck);
  const risk = getRiskLevel(score, rugcheck);
  const liquidity = token?.liquidity?.usd || 0;
  const platform = liquidity === 0 ? "Pump.fun" : "Raydium";
  const ageMs = Date.now() - (token?.pairCreatedAt || 0);
  const ageMin = Math.floor(ageMs / 60000);
  const contractAddr = token.tokenAddress || token.pairAddress || "N/A";

  const analysis = await generateAnalysis(token, rugcheck);

  const message = [
    "NEW TOKEN ALERT",
    "",
    "Name: " + (token.baseToken?.name || "Unknown"),
    "Ticker: $" + (token.baseToken?.symbol || "N/A"),
    "Contract:",
    "```",
    contractAddr,
    "```",
    "Chain: Solana",
    "Platform: " + platform,
    "",
    "-----------------",
    "METRICS",
    "Market Cap: $" + (token?.marketCap || 0).toLocaleString(),
    "Liquidity: $" + liquidity.toLocaleString(),
    "Volume (1h): $" + (token?.volume?.h1 || 0).toLocaleString(),
    "Buys/Sells (1h): " +
      (token?.txns?.h1?.buys || 0) +
      "/" +
      (token?.txns?.h1?.sells || 0),
    "Price Change (1h): " + (token?.priceChange?.h1 || 0) + "%",
    "",
    "-----------------",
    "SAFETY",
    "Rugcheck Score: " + (rugcheck?.score || 0) + "/100",
    // "Rugcheck Score Rating: " + formatRisk(rugcheck?.score || 0),
    "Total Holders: " + (rugcheck?.totalHolders || 0),
    "Top Holder: " + (rugcheck?.topHolderPct.toFixed(2) || 0) + "%",
    "LP Locked: " + (rugcheck?.lpLockedPct || 0) + "%",
    rugcheck && rugcheck.risks.length > 0
      ? "Flags: " + rugcheck.risks.map((r) => r.name).join(", ")
      : "Flags: None detected",
    "",
    "-----------------",
    "RISK LEVEL: " + risk,
    "SCORE: " + score + "/10",
    "",
    "-----------------",
    "ANALYSIS",
    analysis,
    "",
    "-----------------",
    "Age: " + ageMin + " mins",
    "DexScreener: https://dexscreener.com/solana/" + token.pairAddress,
    "Rugcheck: https://rugcheck.xyz/tokens/" + contractAddr,
  ].join("\n");

  const subs = loadSubscribers();
  for (const chatId of subs) {
    try {
      await bot.sendMessage(chatId, message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: " Copy Contract", copy_text: { text: contractAddr } }],
          ],
        },
      });
    } catch (e) {
      console.error("Failed to send to " + chatId + ":", e.message);
    }
  }
}

async function scan() {
  console.log("Scanning for new tokens...");
  try {
    const tokens = await fetchNewTokens();
    let passed = 0;
    for (const token of tokens) {
      const id = token.pairAddress || token.tokenAddress;
      if (!id || alerted.has(id)) continue;
      try {
        if (await passesFilter(token)) {
          passed++;
          alerted.add(id);
          const rugcheck = await getRugcheckData(token.tokenAddress);
          await sendAlert(token, rugcheck);
          console.log("Alert sent for $" + token.baseToken?.symbol);
        }
      } catch (e) {
        console.error("Error processing token:", e.message);
        await sendAdminAlert("Error processing token: " + e.message);
      }
    }
    console.log(
      "Done. " + tokens.length + " checked, " + passed + " alerts sent.",
    );
  } catch (e) {
    console.error("Scan failed:", e.message);
    await sendAdminAlert("Scan failed: " + e.message);
  }
}

scan();
setInterval(scan, 30000);
console.log("Memecoin bot started with Claude AI...");
