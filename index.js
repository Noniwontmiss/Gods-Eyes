/**
 * GodEye — POIDH BountyCreated -> Telegram notifications.
 *
 * Requirements: Node.js 18+ and `npm install viem dotenv`.
 * Configuration is read from .env; see setup notes below the download.
 *
 * Active POIDH networks: Ethereum, Arbitrum, Base.
 * Degen Chain is retired and deliberately not monitored.
 */

"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { createPublicClient, http, parseAbi, formatEther, isAddress } = require("viem");
const { mainnet, arbitrum, base } = require("viem/chains");

const BOUNTY_CREATED_EVENT = parseAbi([
  "event BountyCreated(uint256 indexed id, address indexed issuer, string title, string description, uint256 amount, uint256 createdAt, bool isOpenBounty, uint256 round)",
])[0];

// A contract ID must be offset ONCE to produce its poidh.xyz frontend ID.
const CHAINS = [
  {
    key: "ethereum",
    env: "ETH_RPC_URL",
    startEnv: "ETH_START_BLOCK",
    name: "Ethereum",
    slug: "mainnet",
    chain: mainnet,
    contract: "0xE731dFadBFf20542E10D09D26Fc71445C70d4232",
    explorer: "https://etherscan.io",
    currency: "ETH",
    idOffset: 0n,
  },
  {
    key: "arbitrum",
    env: "ARBITRUM_RPC_URL",
    startEnv: "ARBITRUM_START_BLOCK",
    name: "Arbitrum One",
    slug: "arbitrum",
    chain: arbitrum,
    contract: "0x5555fa783936c260f77385b4e153b9725fef1719",
    explorer: "https://arbiscan.io",
    currency: "ETH",
    idOffset: 180n,
  },
  {
    key: "base",
    env: "BASE_RPC_URL",
    startEnv: "BASE_START_BLOCK",
    name: "Base",
    slug: "base",
    chain: base,
    contract: "0x5555fa783936c260f77385b4e153b9725fef1719",
    explorer: "https://basescan.org",
    currency: "ETH",
    idOffset: 986n,
  },
];

const STATE_FILE = path.join(
  process.env.DATA_DIR || path.join(__dirname, "data"),
  "state.json",
);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 1);
const BLOCK_CHUNK_SIZE = Number(process.env.BLOCK_CHUNK_SIZE ?? 1000);
const REORG_LOOKBACK_BLOCKS = Number(process.env.REORG_LOOKBACK_BLOCKS ?? 6);
const START_FROM_CURRENT = String(process.env.START_FROM_CURRENT ?? "true").toLowerCase() === "true";
const SEND_STARTUP_TEST = String(process.env.SEND_STARTUP_TEST ?? "false").toLowerCase() === "true";

const TELEGRAM_MAX_SAFE_LENGTH = 3900; // Conservative limit, including HTML markup.
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const priceCache = new Map();
const farcasterCache = new Map();

let stopping = false;
let telegramBackoffUntil = 0;

function log(message, ...args) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateConfig() {
  const missing = CHAINS.filter((c) => !process.env[c.env]).map((c) => c.env);
  if (!process.env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) throw new Error(`Missing .env variables: ${missing.join(", ")}`);

  for (const chain of CHAINS) {
    if (!isAddress(chain.contract)) {
      throw new Error(`Invalid contract address for ${chain.name}`);
    }
    try {
      const rpc = new URL(process.env[chain.env]);
      if (!["http:", "https:"].includes(rpc.protocol)) throw new Error("unsupported protocol");
    } catch {
      throw new Error(`${chain.env} must contain a valid HTTP(S) RPC URL`);
    }

    const fromBlock = process.env[chain.startEnv];
    if (fromBlock != null && !/^\d+$/.test(fromBlock)) {
      throw new Error(`${chain.startEnv} must be a nonnegative block number`);
    }
  }

  const settings = [
    ["POLL_INTERVAL_MS", POLL_INTERVAL_MS, 100],
    ["CONFIRMATIONS", CONFIRMATIONS, 0],
    ["BLOCK_CHUNK_SIZE", BLOCK_CHUNK_SIZE, 1],
    ["REORG_LOOKBACK_BLOCKS", REORG_LOOKBACK_BLOCKS, 0],
  ];
  for (const [name, value, min] of settings) {
    if (!Number.isSafeInteger(value) || value < min) {
      throw new Error(`${name} must be an integer >= ${min}`);
    }
  }
  if (!["true", "false"].includes(String(process.env.START_FROM_CURRENT ?? "true").toLowerCase())) {
    throw new Error("START_FROM_CURRENT must be true or false");
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { version: 2, chains: {} };

  // Do not quietly reset an unreadable or corrupt file: that can skip bounties.
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!state || typeof state !== "object" || !state.chains ||
      typeof state.chains !== "object" || Array.isArray(state.chains)) {
    throw new Error(`Invalid state file: ${STATE_FILE}. Back it up and inspect it.`);
  }

  // Compatible with the previous script's {version:1,chains:{...}} format.
  for (const [name, entry] of Object.entries(state.chains)) {
    if (!entry || typeof entry !== "object" ||
        !/^-?\d+$/.test(String(entry.lastScannedBlock)) ||
        (entry.seen != null && !Array.isArray(entry.seen))) {
      throw new Error(`Invalid saved scanning state for ${name}`);
    }
    if (entry.firstScannedBlock != null && !/^\d+$/.test(String(entry.firstScannedBlock))) {
      throw new Error(`Invalid first scanned block for ${name}`);
    }
    // Older state files did not record the initial scan boundary.
    if (entry.firstScannedBlock == null) {
      const next = BigInt(entry.lastScannedBlock) + 1n;
      entry.firstScannedBlock = String(next > 0n ? next : 0n);
    }
    if (entry.pending != null &&
        (typeof entry.pending.key !== "string" ||
         !Number.isSafeInteger(entry.pending.nextPart) || entry.pending.nextPart < 0 ||
         !Array.isArray(entry.pending.messages) ||
         !entry.pending.messages.every((s) => typeof s === "string") ||
         entry.pending.nextPart > entry.pending.messages.length)) {
      throw new Error(`Invalid pending notification state for ${name}`);
    }
  }
  return state;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateText(value, maxCharacters) {
  const chars = Array.from(String(value ?? ""));
  return chars.length <= maxCharacters
    ? chars.join("")
    : `${chars.slice(0, maxCharacters - 1).join("")}…`;
}

function shortenAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function frontendBountyId(chain, contractId) {
  return BigInt(contractId) + chain.idOffset;
}

function bountyUrl(chain, contractId) {
  return `https://poidh.xyz/${chain.slug}/bounty/${frontendBountyId(chain, contractId)}`;
}

function eventKey(item) {
  if (item.transactionHash == null || item.logIndex == null) {
    throw new Error("RPC returned a BountyCreated log without transactionHash/logIndex");
  }
  return `${item.transactionHash}:${item.logIndex}`;
}

function cachedValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) return { found: false };
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return { found: false };
  }
  return { found: true, value: entry.value };
}

function cacheValue(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchUsdPrice() {
  const key = "ethereum";
  const hit = cachedValue(priceCache, key);
  if (hit.found) return hit.value;

  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000) },
    );
    if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
    const data = await response.json();
    const number = Number(data?.ethereum?.usd);
    const price = Number.isFinite(number) && number > 0 ? number : null;
    cacheValue(priceCache, key, price, price ? PRICE_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS);
    return price;
  } catch {
    cacheValue(priceCache, key, null, FAILURE_CACHE_TTL_MS);
    return null;
  }
}

async function formatAmountWithUsd(amount, chain) {
  const amountEth = formatEther(amount);
  const price = await fetchUsdPrice();
  if (price === null) return `${amountEth} ${chain.currency}`;
  const usd = Number(amountEth) * price;
  return Number.isFinite(usd)
    ? `${amountEth} ${chain.currency} (~$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })})`
    : `${amountEth} ${chain.currency}`;
}

async function lookupFarcasterProfile(address) {
  const key = String(address ?? "").toLowerCase();
  if (!key) return null;
  const hit = cachedValue(farcasterCache, key);
  if (hit.found) return hit.value;

  try {
    const response = await fetch(
      `https://api.web3.bio/profile/farcaster/${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!response.ok) throw new Error(`Web3.bio HTTP ${response.status}`);
    const data = await response.json();
    const identity = String(data?.identity || data?.username || data?.fname || "").replace(/^@/, "");
    // Never let malformed profile API data create an enormous or unsafe URL.
    const profile = /^[a-zA-Z0-9_.-]{1,100}$/.test(identity)
      ? {
          identity,
          displayName: String(data?.displayName || data?.display_name || identity),
        }
      : null;
    cacheValue(farcasterCache, key, profile, profile ? PROFILE_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS);
    return profile;
  } catch {
    cacheValue(farcasterCache, key, null, FAILURE_CACHE_TTL_MS);
    return null; // Profile lookup must never stop notifications.
  }
}

// Escape BEFORE splitting, character-by-character, so HTML entities are never broken.
// 3000 is deliberately below Telegram's 4096-character limit.
function splitEscapedText(text, firstLimit, laterLimit = 3000) {
  const parts = [];
  let current = "";
  let max = firstLimit;
  for (const char of String(text)) {
    const piece = escapeHtml(char);
    if (current && current.length + piece.length > max) {
      parts.push(current);
      current = "";
      max = laterLimit;
    }
    current += piece;
  }
  if (current) parts.push(current);
  return parts;
}

async function buildTelegramMessages(chain, args, txHash) {
  const frontendId = frontendBountyId(chain, args.id);
  const link = bountyUrl(chain, args.id); // FIX: never pass a previously offset ID.
  const issuer = String(args.issuer || "");
  const description = String(args.description || "").trim();
  const title = escapeHtml(truncateText(args.title || "Untitled bounty", 250));

  const [profile, amountText] = await Promise.all([
    lookupFarcasterProfile(issuer),
    formatAmountWithUsd(args.amount, chain),
  ]);

  const profileLine = profile
    ? `🟪 <b>Farcaster:</b> <a href="https://farcaster.xyz/${encodeURIComponent(profile.identity)}">${escapeHtml(truncateText(profile.displayName, 100))} (@${escapeHtml(truncateText(profile.identity, 75))})</a>`
    : null;

  const header = [
    "🔔 <b>NEW BOUNTY !!</b>",
    "",
    ` <a href="${link}">📝</a>`,
    `📌 <b>${title}</b>`,
    `💰 <b>${escapeHtml(amountText)}</b>`,
    `⛓ <b>${escapeHtml(chain.name)}</b>`,
    `👤 <b>Issuer:</b> <a href="${chain.explorer}/address/${issuer}">${escapeHtml(shortenAddress(issuer))}</a>`,
    profileLine,
    `🆔 <code>${frontendId}</code>`,
    `🎯 ${args.isOpenBounty ? "Open bounty" : "Standard bounty"}`,
  ].filter((s) => s !== null);

  const footer = [
    "",
    `🔗 <a href="${link}">View bounty</a>`,
    `🔍 <a href="${chain.explorer}/tx/${txHash}">View transaction</a>`,
  ];

  if (!description) {
    return [[...header, ...footer].join("\n")];
  }

  const intro = [...header, "", "📝 <b>Description:</b>"].join("\n");
  const outro = footer.join("\n");
  const firstBudget = Math.max(200, Math.min(2800,
    TELEGRAM_MAX_SAFE_LENGTH - intro.length - outro.length - 70,
  ));
  const parts = splitEscapedText(description, firstBudget);
  const main = [intro, parts[0], ...(parts.length > 1 ? ["", "↪️ Description continues below"] : []), outro].join("\n");
  const messages = [main];

  for (let i = 1; i < parts.length; i += 1) {
    messages.push([
      `📝 <b>Description (part ${i + 1}/${parts.length}):</b>`,
      parts[i],
      `🔗 <a href="${link}">View bounty</a>`,
    ].join("\n"));
  }

  for (const msg of messages) {
    if (msg.length > TELEGRAM_MAX_SAFE_LENGTH) {
      throw new Error(`Generated Telegram message too long (${msg.length} chars)`);
    }
  }
  return messages;
}

async function sendTelegram(message) {
  if (message.length > TELEGRAM_MAX_SAFE_LENGTH) {
    throw new Error("Refusing to send an oversized Telegram message");
  }

  if (telegramBackoffUntil > Date.now()) {
    await sleep(telegramBackoffUntil - Date.now());
  }

  const payload = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };
  if (process.env.TELEGRAM_MESSAGE_THREAD_ID) {
    const thread = Number(process.env.TELEGRAM_MESSAGE_THREAD_ID);
    if (!Number.isSafeInteger(thread) || thread <= 0) {
      throw new Error("TELEGRAM_MESSAGE_THREAD_ID must be a positive integer");
    }
    payload.message_thread_id = thread;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    },
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const retryAfter = Number(result?.parameters?.retry_after || 0);
    if (response.status === 429 && retryAfter > 0) {
      telegramBackoffUntil = Date.now() + retryAfter * 1000;
    }
    throw new Error(`Telegram HTTP ${response.status}: ${result.description || response.statusText}`);
  }
  return result;
}

function createClient(chain) {
  return createPublicClient({
    chain: chain.chain,
    transport: http(process.env[chain.env], {
      timeout: 15000,
      retryCount: 2,
      retryDelay: 1000,
    }),
  });
}

async function initializeChainState(chain, client, state) {
  if (state.chains[chain.key]) return;

  const latest = await client.getBlockNumber();
  const fromEnv = process.env[chain.startEnv];
  const startBlock = !START_FROM_CURRENT && fromEnv != null ? BigInt(fromEnv) : latest;
  state.chains[chain.key] = {
    lastScannedBlock: (startBlock - 1n).toString(),
    firstScannedBlock: startBlock.toString(),
    seen: [],
  };
  saveState(state);
  log(`${chain.name}: monitoring from block ${startBlock}`);
}

async function processRange(chain, client, state, fromBlock, toBlock) {
  const logs = await client.getLogs({
    address: chain.contract,
    event: BOUNTY_CREATED_EVENT,
    fromBlock,
    toBlock,
  });

  const chainState = state.chains[chain.key];
  const seen = new Set(chainState.seen || []);

  // A reorganized block may remove the event we were halfway through sending.
  if (chainState.pending &&
      BigInt(chainState.pending.blockNumber ?? fromBlock) >= fromBlock &&
      BigInt(chainState.pending.blockNumber ?? fromBlock) <= toBlock &&
      !logs.some((item) => eventKey(item) === chainState.pending.key)) {
    log(`⚠️ ${chain.name}: dropping pending message from a changed block`);
    delete chainState.pending;
    saveState(state);
  }

  if (logs.length) {
    log(`${chain.name}: found ${logs.length} BountyCreated event(s) in blocks ${fromBlock}-${toBlock}`);
  }

  for (const item of logs) {
    const key = eventKey(item);
    if (seen.has(key)) continue;

    try {
      // Freeze notification text and per-part progress on disk. If a send fails,
      // restarting or rescanning continues with the unsent part instead of
      // resending every previously successful part.
      if (!chainState.pending || chainState.pending.key !== key) {
        chainState.pending = {
          key,
          blockNumber: String(item.blockNumber),
          nextPart: 0,
          messages: await buildTelegramMessages(chain, item.args, item.transactionHash),
        };
        saveState(state);
      }

      const pending = chainState.pending;
      for (let i = pending.nextPart; i < pending.messages.length; i += 1) {
        await sendTelegram(pending.messages[i]);
        pending.nextPart = i + 1;
        saveState(state);
      }

      seen.add(key);
      chainState.seen = [...seen].slice(-5000);
      delete chainState.pending;
      saveState(state);
      log(`✅ ${chain.name}: notified bounty ${frontendBountyId(chain, item.args.id)} (${key})`);
    } catch (error) {
      log(`❌ ${chain.name}: failed to notify ${key}: ${error.message}`);
      throw error; // Don't advance the cursor past an unsent bounty.
    }
  }
}

async function scanChain(chain, client, state) {
  await initializeChainState(chain, client, state);
  const chainState = state.chains[chain.key];
  const latest = await client.getBlockNumber();
  if (latest < BigInt(CONFIRMATIONS)) return;

  const safeLatest = latest - BigInt(CONFIRMATIONS);
  let fromBlock = BigInt(chainState.lastScannedBlock) + 1n;
  if (fromBlock > safeLatest) return;

  // Revisit a few confirmed blocks when the chain advances; this catches
  // replacement logs after shallow chain reorganizations. Saved event keys
  // prevent repeat alerts for previously delivered events.
  const earliest = BigInt(chainState.firstScannedBlock);
  const rewindTo = fromBlock - BigInt(REORG_LOOKBACK_BLOCKS);
  if (!chainState.pending && rewindTo < fromBlock) {
    fromBlock = rewindTo > earliest ? rewindTo : earliest;
  }

  while (!stopping && fromBlock <= safeLatest) {
    const end = fromBlock + BigInt(BLOCK_CHUNK_SIZE) - 1n;
    const toBlock = end < safeLatest ? end : safeLatest;
    await processRange(chain, client, state, fromBlock, toBlock);
    chainState.lastScannedBlock = String(toBlock);
    saveState(state);
    fromBlock = toBlock + 1n;
  }
}

async function main() {
  validateConfig();
  const state = loadState();
  const clients = CHAINS.map((chain) => ({ chain, client: createClient(chain) }));

  log("🚀 GodEye starting (Ethereum, Arbitrum, Base)");
  log(`Poll interval: ${POLL_INTERVAL_MS} ms; block confirmations: ${CONFIRMATIONS}`);
  log(`State: ${STATE_FILE}`);

  if (SEND_STARTUP_TEST) {
    await sendTelegram("🦅 <b>GodEye Online...</b>\n\nBlockchain monitoring is active.");
  }

  while (!stopping) {
    // Chains run independently: a slow RPC on one won't delay the other two.
    await Promise.all(clients.map(async ({ chain, client }) => {
      try {
        await scanChain(chain, client, state);
      } catch (error) {
        log(`⚠️ ${chain.name}: ${error.message}`);
      }
    }));
    if (!stopping) await sleep(POLL_INTERVAL_MS);
  }
  log("GodEye stopped.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!stopping) log(`Received ${signal}; finishing current work...`);
    stopping = true;
  });
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exitCode = 1;
});
