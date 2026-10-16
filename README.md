# POIDH Telegram Watcher

An independent watcher for POIDH. It does NOT modify or depend on the POIDH application repository at runtime.

It watches the POIDH `BountyCreated` contract event on:

- Ethereum
- Arbitrum One
- Base
- Degen

and posts a formatted alert to an existing Telegram bot/channel.

## 1. Install

Requires Node.js 18+.

```bash
npm install
```

## 2. Configure

Copy:

```bash
cp .env.example .env
```

Fill in:

- `ETH_RPC_URL`
- `ARBITRUM_RPC_URL`
- `BASE_RPC_URL`
- `DEGEN_RPC_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Do not commit `.env`.

## 3. First run

The default is:

```env
START_FROM_CURRENT=true
```

This is deliberate: the first run starts at the current blockchain head, so it does not dump every historical POIDH bounty into your channel.

Run:

```bash
npm start
```

You should see the watcher polling each chain.

## 4. Test Telegram

Set:

```env
SEND_STARTUP_TEST=true
```

Run once. Your channel should receive:

`🟢 POIDH watcher online`

Then set it back to:

```env
SEND_STARTUP_TEST=false
```

## 5. How detection works

The watcher polls the four POIDH contracts for the exact:

`BountyCreated`

event.

It stores its last processed block and a rolling list of processed transaction/log IDs in:

`data/state.json`

If the process restarts, it resumes from the saved block rather than starting over.

If the internet/RPC connection temporarily fails, it retries on the next polling cycle and catches up from the last saved block.

## 6. Historical catch-up

If you intentionally want to scan historical bounties, set:

```env
START_FROM_CURRENT=false
```

and optionally set:

```env
ETH_START_BLOCK=
ARBITRUM_START_BLOCK=
BASE_START_BLOCK=
DEGEN_START_BLOCK=
```

Be careful: scanning from an old block can generate many Telegram messages.

For normal personal alerts, leave `START_FROM_CURRENT=true`.

## 7. Reliability settings

Default:

```env
POLL_INTERVAL_MS=3000
CONFIRMATIONS=1
BLOCK_CHUNK_SIZE=1000
```

That means the watcher checks about every 3 seconds and waits for one block confirmation before notifying.

For faster alerts, you can use:

```env
POLL_INTERVAL_MS=2000
CONFIRMATIONS=1
```

For more conservative confirmation:

```env
CONFIRMATIONS=2
```

## 8. Deployment

Use a host that supports a long-running Node.js process. Railway, Render, Fly.io, or a VPS are suitable.

Build/start command:

```bash
npm install
npm start
```

Add the same environment variables in the host's environment-variable settings.

Do NOT use a serverless cron as the primary watcher. This application is intended to stay running continuously.

## 9. POIDH contract addresses

These were taken from the POIDH application repository supplied for this project:

Ethereum:
`0xE731dFadBFf20542E10D09D26Fc71445C70d4232`

Arbitrum:
`0x5555fa783936c260f77385b4e153b9725fef1719`

Base:
`0x5555fa783936c260f77385b4e153b9725fef1719`

Degen:
`0x18e5585ca7ce31b90bc8bb7aaf84152857ce243f`

The event is:

`BountyCreated(uint256 indexed id, address indexed issuer, string title, string description, uint256 amount, uint256 createdAt, bool isOpenBounty, uint256 round)`

## 10. Security

Keep the Telegram bot token secret.

Never put it in:

- frontend code
- `NEXT_PUBLIC_*` variables
- GitHub
- screenshots
- public logs

The `.gitignore` already excludes `.env` and the local state file.
