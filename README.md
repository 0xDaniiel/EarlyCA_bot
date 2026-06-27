# Memecoin Intelligence Bot

A 24/7 Solana token scanner that monitors new token launches, filters out low-quality tokens, scores them based on real trading data, and sends alerts directly to Telegram. Built for traders who want to be early without manually watching charts all day.

---

## What It Does

The bot continuously scans DexScreener for new Solana tokens every 30 seconds. Each token is run through a filter to remove obvious rugs and low-quality launches. Tokens that pass are scored and sent as an alert to your Telegram channel.

You decide whether to buy. The bot handles the research.

---

## Benefits

- Never miss an early token launch again
- Filters remove low liquidity, low volume, and suspicious tokens automatically
- Scoring system ranks each token so you know what is worth your attention
- Runs 24/7 on a VPS so it works while you sleep
- Claude AI analysis layer explains why a token is interesting and suggests exit ranges
- One alert goes to all subscribers simultaneously

---

## Alert Format

Every alert sent to Telegram looks like this:
```
NEW TOKEN ALERT

Name: PepeCat
Ticker: $PEPECAT
Contract: 7xK3...9mNp
Chain: Solana

-----------------
METRICS
Market Cap: $48K
Liquidity: $22K
Volume (5m): $8K
Holders: 312 (growing fast)
Buy/Sell Ratio: 74/26

-----------------
SAFETY
Mint Renounced: Yes
Liquidity Locked: Yes
Top Holder: 8%
Tax: 0/0

-----------------
HYPE SCORE: 7/10
RISK LEVEL: Medium
OPPORTUNITY SCORE: 8/10

-----------------
CLAUDE ANALYSIS
Early momentum with clean contract. Holder growth is
organic. Watch for whale exit above $200K mcap.
Suggested exit: 3x-5x range.

-----------------
Age: 14 mins
DexScreener: https://dexscreener.com/solana/...
Rugcheck: https://rugcheck.xyz/tokens/...
```

---

## Filter Criteria

A token must meet all of the following to trigger an alert:

- Chain: Solana only
- Market Cap: above $30,000 (Pump.fun tokens)
- Liquidity: above $10,000 (Raydium graduated tokens)
- Volume (1h): above $5,000
- Buys (1h): above 20

---

## Scoring System

Each token is scored out of 10 based on:

- Volume momentum
- Buy pressure vs sell pressure
- Price change in the last hour
- Liquidity depth
- Market cap progression

Risk levels:
- Score 8 and above: Low risk
- Score 6 to 7: Medium risk
- Score 5 and below: High risk

---

## Tech Stack

- Node.js
- DexScreener API
- Rugcheck API
- Claude AI (Anthropic)
- Telegram Bot API
- PM2 (process manager)
- Ubuntu VPS (24/7 uptime)

---

## Disclaimer

This bot is for informational purposes only. Nothing sent by this bot constitutes financial advice. Memecoin trading carries significant risk of total loss. Always do your own research before making any investment decision.
