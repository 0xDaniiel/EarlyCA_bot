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
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  addSubscriber(chatId);
  bot.sendMessage(
    chatId,
    "Welcome to EarlyCA Bot! You have 70 free alerts to try the service.\n\nAfter that, subscribe for $5/month to continue receiving alerts.\n\nTap /subscribe when ready to upgrade.",
  );
});

const pendingVerification = new Map();

bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "To subscribe for $5/month, send payment to:\n\n" +
      WALLET_ADDRESS +
      "\n\nAccepted tokens: USDC, USDT, or SOL (Solana network only)\n\n" +
      "After paying, tap /verify to confirm your payment.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "  Copy Wallet Address",
              copy_text: { text: WALLET_ADDRESS },
            },
          ],
        ],
      },
    },
  );
});
bot.onText(/\/verify/, (msg) => {
  const chatId = msg.chat.id;
  pendingVerification.set(chatId, true);
  bot.sendMessage(chatId, "Please paste your transaction signature:");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!pendingVerification.get(chatId)) return;
  if (msg.text?.startsWith("/")) return;

  pendingVerification.delete(chatId);
  const signature = msg.text?.trim();

  try {
    const res = await axios.post(process.env.SOLANA_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", commitment: "finalized" }],
    });

    const tx = res.data?.result;
    if (!tx) {
      return bot.sendMessage(
        chatId,
        "We couldn't find that transaction on the Solana blockchain. Please double-check and try again.",
      );
    }

    const instructions = tx.transaction?.message?.instructions || [];
    const accountKeys =
      tx.transaction?.message?.accountKeys?.map((k) => k.pubkey || k) || [];

    // Check destination wallet is yours
    const destIndex = accountKeys.indexOf(WALLET_ADDRESS);
    if (destIndex === -1) {
      return bot.sendMessage(
        chatId,
        "We found that transaction but it wasn't sent to our wallet. Please make sure you sent to the correct address.",
      );
    }
    // Check signature hasn't been used before
    const subs = loadSubscribers();
    const alreadyUsed = subs.some((s) => s.usedSignatures?.includes(signature));
    if (alreadyUsed) {
      return bot.sendMessage(
        chatId,
        "This transaction has already been used to verify a subscription.",
      );
    }

    let amountUSD = 0;
    let paymentToken = null;

    // Check USDC or USDT transfer
    for (const ix of instructions) {
      if (ix.program === "spl-token" && ix.parsed?.type === "transferChecked") {
        const info = ix.parsed.info;
        const mint = info?.mint;
        const amount = parseFloat(info?.tokenAmount?.uiAmount || 0);
        if (
          (mint === process.env.USDC_MINT || mint === process.env.USDT_MINT) &&
          accountKeys.includes(WALLET_ADDRESS)
        ) {
          amountUSD = amount;
          paymentToken = mint === process.env.USDC_MINT ? "USDC" : "USDT";
          break;
        }
      }
    }

    // Check SOL transfer if no USDC/USDT found
    if (!paymentToken) {
      const solRes = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      );
      const solPrice = solRes.data?.solana?.usd || 0;
      const preBalances = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const walletIndex = accountKeys.indexOf(WALLET_ADDRESS);
      if (walletIndex !== -1) {
        const lamportsDiff =
          postBalances[walletIndex] - preBalances[walletIndex];
        if (lamportsDiff > 0) {
          amountUSD = (lamportsDiff / 1e9) * solPrice;
          paymentToken = "SOL";
        }
      }
    }

    if (!paymentToken) {
      return bot.sendMessage(
        chatId,
        "We found that transaction but it doesn't match our payment details. Make sure you sent USDC, USDT, or SOL to " +
          WALLET_ADDRESS,
      );
    }

    if (amountUSD < 4.5) {
      return bot.sendMessage(
        chatId,
        "We received $" +
          amountUSD.toFixed(2) +
          " " +
          paymentToken +
          " but the minimum is $5. Please send the remaining amount and verify again.",
      );
    }

    const days = Math.floor((amountUSD / 5) * 30);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    const usedSignatures = getSubscriber(chatId)?.usedSignatures || [];
    updateSubscriber(chatId, {
      subscribed: true,
      expiry: expiry.toISOString(),
      usedSignatures: [...usedSignatures, signature],
    });

    bot.sendMessage(
      chatId,
      "Payment verified! Received $" +
        amountUSD.toFixed(2) +
        " " +
        paymentToken +
        ".\n\nYou are now subscribed for " +
        days +
        " days. Enjoy your alerts!",
    );
    sendAdminAlert(
      "New subscriber: " +
        chatId +
        " | " +
        amountUSD.toFixed(2) +
        " " +
        paymentToken +
        " | Tx: " +
        signature,
    );
  } catch (e) {
    console.error("Verify error:", e.message);
    bot.sendMessage(
      chatId,
      "Something went wrong verifying your transaction. Please try again or contact support.",
    );
  }
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

function saveSubscribers(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function getSubscriber(chatId) {
  const subs = loadSubscribers();
  return subs.find((s) => s.chatId === chatId);
}

function addSubscriber(chatId) {
  const subs = loadSubscribers();
  if (!subs.find((s) => s.chatId === chatId)) {
    subs.push({ chatId, alertCount: 0, subscribed: false, expiry: null });
    saveSubscribers(subs);
  }
}

function updateSubscriber(chatId, updates) {
  const subs = loadSubscribers();
  const sub = subs.find((s) => s.chatId === chatId);
  if (sub) {
    Object.assign(sub, updates);
    saveSubscribers(subs);
  }
}
async function fetchNewTokens() {
  const tokenMap = new Map();

  // Source 1: DexScreener new pairs
  try {
    const profilesRes = await axios.get(
      "https://api.dexscreener.com/token-profiles/latest/v1",
    );
    const profiles = (profilesRes.data || []).filter(
      (t) => t.chainId === "solana",
    );
    for (const profile of profiles.slice(0, 50)) {
      try {
        const pairRes = await axios.get(
          "https://api.dexscreener.com/latest/dex/tokens/" +
            profile.tokenAddress,
        );
        const pair = pairRes.data?.pairs?.[0];
        if (pair) {
          const addr = profile.tokenAddress;
          if (!tokenMap.has(addr)) {
            tokenMap.set(addr, { ...pair, tokenAddress: addr });
          }
        }
      } catch (e) {}
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
1. Momentum: one sentence on buying pressure and price action
2. Exit range: suggested profit target (e.g., 2x-3x or $100k-$150k mcap)
3. Signal: BUY, WAIT, or SKIP with one reason why`;

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
    contractAddr,
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
  for (const sub of subs) {
    const chatId = sub.chatId;
    try {
      const now = new Date();
      const expiry = sub.expiry ? new Date(sub.expiry) : null;
      const isExpired = expiry && now > expiry;

      // If subscribed but expired, flip them back
      if (sub.subscribed && isExpired) {
        updateSubscriber(chatId, { subscribed: false, expiry: null });
        sub.subscribed = false;
      }

      if (sub.subscribed) {
        // Paid subscriber — send normally
        await bot.sendMessage(chatId, message, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "  Copy Contract Address",
                  copy_text: { text: contractAddr },
                },
              ],
            ],
          },
        });
      } else if (sub.alertCount < 70) {
        // Free trial — send and increment count
        await bot.sendMessage(chatId, message, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "  Copy Contract Address",
                  copy_text: { text: contractAddr },
                },
              ],
            ],
          },
        });
        updateSubscriber(chatId, { alertCount: sub.alertCount + 1 });

        // Warn at 65 alerts
        if (sub.alertCount + 1 === 65) {
          await bot.sendMessage(
            chatId,
            "You have 5 free alerts remaining. Subscribe to continue receiving alerts after your trial ends.",
          );
        }
      } else {
        // Trial exhausted — notify once at exactly 70, then silence
        if (sub.alertCount === 70) {
          await bot.sendMessage(
            chatId,
            "Your 70 free alerts have been used up.\n\nTap /subscribe to continue receiving alerts for $5/month.",
          );
          updateSubscriber(chatId, { alertCount: 71 });
        }
        continue;
      }
    } catch (e) {
      // console.error("Failed to send to " + chatId + ":", e.message);
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
          // console.log("Alert sent for $" + token.baseToken?.symbol);
        }
      } catch (e) {
        // console.error("Error processing token:", e.message);
        await sendAdminAlert("Error processing token: " + e.message);
      }
    }
    // console.log(
    //   "Done. " + tokens.length + " checked, " + passed + " alerts sent.",
    // );
  } catch (e) {
    // console.error("Scan failed:", e.message);
    await sendAdminAlert("Scan failed: " + e.message);
  }
}

scan();
setInterval(scan, 30000);
console.log("Memecoin bot started with Claude AI...");
