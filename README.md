# Sharp Entry V3

A mobile-friendly XAU/USD (Gold) signal website with a server-side auto scanner.

## Included
- H1 trend filter
- M15 structure confirmation
- M5 sharp-entry logic
- BOS, liquidity sweep, FVG, EMA momentum, RSI and ATR checks
- BUY / SELL / WAIT
- Entry, Stop Loss, TP1, TP2, TP3
- Confidence score
- 5-minute background scanner
- Telegram alerts for new BUY/SELL signals
- Signal history
- Mobile website dashboard

## Fastest deployment: Railway
1. Create a new Railway project and upload/push this folder.
2. Add environment variables:
   - `TWELVE_DATA_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - optional `SCAN_INTERVAL_MINUTES=5`
3. Deploy.
4. In Railway networking/settings, generate a public domain.
5. Open that domain on your iPhone. You can use Safari → Share → Add to Home Screen.

## Telegram Chat ID
1. Open your bot in Telegram and send it a message such as `hello`.
2. In a browser, open the Telegram Bot API `getUpdates` endpoint using your bot token.
3. Look for `chat` → `id`. That whole number is the chat ID. It is NOT the first number inside the bot token.
4. Put that number in Railway as `TELEGRAM_CHAT_ID`.

## Local run
```bash
npm install
cp .env.example .env
# edit .env
npm start
```
Then open `http://localhost:3000`.

## Important
The scanner depends on the market-data plan allowing the requested XAU/USD intervals and request rate. Railway's filesystem can be ephemeral unless persistent storage is configured, so signal history may reset after a redeploy. Telegram and scanning continue as long as the deployed service is running.

Trading signals are not guaranteed and should not be treated as financial advice.
