require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  createPublicClient,
  http,
  parseAbi,
  formatEther,
  isAddress,
} = require("viem");

const { mainnet, arbitrum, base } = require("viem/chains");

const EVENT_ABI = parseAbi([
  "event BountyCreated(uint256 indexed id, address indexed issuer, string title, string description, uint256 amount, uint256 createdAt, bool isOpenBounty, uint256 round)"
]);

const CHAINS = [
  {
    key: "ethereum",
    env: "ETH_RPC_URL",
    startEnv: "ETH_START_BLOCK",
    name: "Ethereum",
    slug: "mainnet",
    chain: mainnet,
    contract: "0xE731dFadBFf20542E10D09D26Fc71445C70d4232",
    explorer: "https://etherscan.io/tx/",
    currency: "ETH"
  },
  {
    key: "arbitrum",
    env: "ARBITRUM_RPC_URL",
    startEnv: "ARBITRUM_START_BLOCK",
    name: "Arbitrum One",
    slug: "arbitrum",
    chain: arbitrum,
    contract: "0x5555fa783936c260f77385b4e153b9725fef1719",
    explorer: "https://arbiscan.io/tx/",
    currency: "ETH"
  },
  {
    key: "base",
    env: "BASE_RPC_URL",
    startEnv: "BASE_START_BLOCK",
    name: "Base",
    slug: "base",
    chain: base,
    contract: "0x5555fa783936c260f77385b4e153b9725fef1719",
    explorer: "https://basescan.org/tx/",
    currency: "ETH"
  }
];

const STATE_FILE = path.join(
  process.env.DATA_DIR || path.join(__dirname, "data"),
  "state.json"
);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 1);
const BLOCK_CHUNK_SIZE = Number(process.env.BLOCK_CHUNK_SIZE || 1000);

const START_FROM_CURRENT =
  String(process.env.START_FROM_CURRENT || "true").toLowerCase() === "true";

function log(message, ...args) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (!state || !state.chains || typeof state.chains !== "object" ||
        Array.isArray(state.chains)) {
      throw new Error("Invalid state.json structure");
    }

    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, chains: {} };
    }

    // Do not silently reset the cursor and miss new bounties.
    throw new Error(`Cannot load ${STATE_FILE}: ${error.message}`);
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const tmp = `${STATE_FILE}.tmp`;

  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortenAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function eventKey(logItem) {
  return `${logItem.transactionHash}:${String(logItem.logIndex)}`;
}

const BOUNTY_ID_OFFSETS = {
  ethereum: 0n,
  arbitrum: 180n,
  base: 986n,
};

function frontendBountyId(chain, contractId) {
  return BigInt(contractId) + (BOUNTY_ID_OFFSETS[chain.key] || 0n);
}

function bountyUrl(chain, contractId) {
  const id = frontendBountyId(chain, contractId);
  return `https://poidh.xyz/${chain.slug}/bounty/${id.toString()}`;
}
  
function formatAmount(amount, chain) {
  const value = formatEther(amount);
  return `${value} ${chain.currency}`;
}

// Refresh USD prices every five minutes, and retry failed lookups after 30 seconds.
const fiatPriceCache = new Map();

async function fetchUsdPrice(currency) {
  const key = currency === "DEGEN" ? "degen" : "ethereum";
  const cached = fiatPriceCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.price;
  }

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${key}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(4000) }
    );

    if (!response.ok) throw new Error(`Price API: HTTP ${response.status}`);

    const data = await response.json();
    const price = Number(data?.[key]?.usd);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Price API returned an invalid price");
    }

    fiatPriceCache.set(key, { price, expiresAt: Date.now() + 300000 });
    return price;
  } catch {
    fiatPriceCache.set(key, { price: null, expiresAt: Date.now() + 30000 });
    return null;
  }
}

async function formatAmountWithUsd(amount, chain) {
  const amountText = formatAmount(amount, chain);
  const price = await fetchUsdPrice(chain.currency);

  if (!price) return amountText;

  const value = Number(formatEther(amount));
  const usdValue = value * price;

  if (!Number.isFinite(usdValue)) return amountText;

  return `${amountText} (~$${usdValue.toLocaleString("en-US", {
    maximumFractionDigits: 2
  })})`;
}

// Split raw description text before HTML escaping so entities/tags are not cut.
function splitDescription(description, maxLength = 3400) {
  const parts = [];
  let part = "";
  let size = 0;

  for (const char of description) {
    const length = escapeHtml(char).length;

    if (size + length > maxLength && part) {
      parts.push(part);
      part = "";
      size = 0;
    }

    part += char;
    size += length;
  }

  if (part) parts.push(part);
  return parts;
}

// Cache Farcaster lookups to avoid repeatedly querying the same wallet.
const farcasterProfileCache = new Map();

async function lookupFarcasterProfile(address) {
  const key = String(address || "").toLowerCase();

  if (!key) return null;

  if (farcasterProfileCache.has(key)) {
    return farcasterProfileCache.get(key);
  }

  try {
    const response = await fetch(
      `https://api.web3.bio/profile/farcaster/${encodeURIComponent(address)}`,
      {
        signal: AbortSignal.timeout(4000)
      }
    );

    if (!response.ok) {
      farcasterProfileCache.set(key, null);
      return null;
    }

    const data = await response.json();

    const identity =
      data?.identity ||
      data?.username ||
      data?.fname ||
      null;

    const displayName =
      data?.displayName ||
      data?.display_name ||
      identity;

    const profile = identity
      ? {
          identity: String(identity).replace(/^@/, ""),
          displayName: String(displayName || identity)
        }
      : null;

    farcasterProfileCache.set(key, profile);

    return profile;
  } catch {
    // Farcaster lookup failures must not stop bounty notifications.
    return null;
  }
}

// Convert a transaction explorer base URL into an address explorer URL.
function addressExplorerUrl(chain, address) {
  return `${chain.explorer.replace(/\/tx\/?$/, "/address/")}${address}`;
}

async function buildTelegramMessage(chain, args, txHash) {
  const id = frontendBountyId(chain, args.id);

  // Keep oversized titles from making even the first notification too long.
  const title = escapeHtml(String(args.title || "Untitled bounty").slice(0, 500));

  // Preserve the complete on-chain description (send it in parts if necessary).
  const description = String(args.description || "").trim();

  const issuer = String(args.issuer || "");

  const issuerLink =
    `<a href="${addressExplorerUrl(chain, issuer)}">` +
    `${escapeHtml(shortenAddress(issuer))}</a>`;

  // Attempt to find a Farcaster account associated with the issuer wallet.
  const farcasterProfile = await lookupFarcasterProfile(issuer);

  const farcasterLine = farcasterProfile
    ? `🟪 <b>Farcaster:</b> <a href="https://farcaster.xyz/${encodeURIComponent(farcasterProfile.identity)}">${escapeHtml(farcasterProfile.displayName)} (@${escapeHtml(farcasterProfile.identity)})</a>`
    : null;

  const openLabel = args.isOpenBounty
    ? "Open bounty"
    : "Standard bounty";

  const amountText = await formatAmountWithUsd(args.amount, chain);

  const header = [
    "🔔 <b>NEW BOUNTY!</b>",
    "",
    ` <a href="${bountyUrl(chain, args.id)}">📝</a>`
    `📌 <b>${title}</b>`,
    `💰 <b>${escapeHtml(amountText)}</b>`,
    `⛓ <b>${escapeHtml(chain.name)}</b>`,
    `👤 <b>Issuer:</b> ${issuerLink}`,
    farcasterLine,
    `🆔 <code>${id.toString()}</code>`,
    `🎯 ${escapeHtml(openLabel)}`
  ]
    .filter((x) => x !== null)
    .join("\n");

  const footer = [
    "",
    // Pass the raw contract ID: bountyUrl() adds the frontend offset once.
    `🔗 <a href="${bountyUrl(chain, args.id)}">View bounty</a>`,
    `🔍 <a href="${chain.explorer}${txHash}">View transaction</a>`
  ].join("\n");

  const message = [
    header,
    description ? "" : null,
    description ? `📝 ${escapeHtml(description)}` : null,
    footer
  ]
    .filter((x) => x !== null)
    .join("\n");

  // Telegram's 4096-character limit is measured after parsing HTML.
  // Use a conservative pre-parse limit so each message is accepted.
  if (message.length <= 3900) return message;

  const parts = splitDescription(description);

  return [
    `${header}\n\n📝 Full description follows (${parts.length} part(s)).${footer}`,
    ...parts.map((part, index) =>
      `📝 <b>Description (${index + 1}/${parts.length})</b>\n\n${escapeHtml(part)}`
    )
  ];
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required"
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram API error: ${result.description || response.statusText}`
    );
  }

  return result;
}

function validateConfig() {
  const missing = [];

  for (const chain of CHAINS) {
    if (!process.env[chain.env]) {
      missing.push(chain.env);
    }
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    missing.push("TELEGRAM_BOT_TOKEN");
  }

  if (!process.env.TELEGRAM_CHAT_ID) {
    missing.push("TELEGRAM_CHAT_ID");
  }

  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }

  for (const chain of CHAINS) {
    if (!isAddress(chain.contract)) {
      throw new Error(
        `Invalid contract address for ${chain.name}`
      );
    }
  }
}

function createClient(chain) {
  return createPublicClient({
    chain: chain.chain,
    transport: http(process.env[chain.env], {
      retryCount: 3,
      retryDelay: 1000
    })
  });
}

async function initializeChainState(chain, client, state) {
  if (state.chains[chain.key]) return;

  const current = await client.getBlockNumber();

  let startBlock = current;

  if (!START_FROM_CURRENT) {
    const configured = process.env[chain.startEnv];

    startBlock = configured
      ? BigInt(configured)
      : current;
  }

  state.chains[chain.key] = {
    lastScannedBlock: (startBlock - 1n).toString(),
    seen: []
  };

  saveState(state);

  log(
    `${chain.name}: starting at block ${startBlock.toString()}`
  );
}

async function processRange(
  chain,
  client,
  state,
  fromBlock,
  toBlock
) {
  const logs = await client.getLogs({
    address: chain.contract,
    event: EVENT_ABI[0],
    fromBlock,
    toBlock
  });

  if (!logs.length) return;

  log(
    `${chain.name}: found ${logs.length} BountyCreated event(s) in ${fromBlock}-${toBlock}`
  );

  const chainState = state.chains[chain.key];
  const seenSet = new Set(chainState.seen || []);

  for (const logItem of logs) {
    const key = eventKey(logItem);

    if (seenSet.has(key)) {
      continue;
    }

    const args = logItem.args;

    try {
      // Save each part's progress, so retries don't repeat earlier parts.
      let pending = chainState.pending;

      if (!pending || pending.key !== key || !Array.isArray(pending.messages)) {
        const message = await buildTelegramMessage(
          chain,
          args,
          logItem.transactionHash
        );

        pending = {
          key,
          messages: Array.isArray(message) ? message : [message],
          nextPart: 0
        };

        chainState.pending = pending;
        saveState(state);
      }

      for (let i = pending.nextPart; i < pending.messages.length; i++) {
        await sendTelegram(pending.messages[i]);
        pending.nextPart = i + 1;
        saveState(state);
      }

      seenSet.add(key);
      chainState.seen = Array.from(seenSet).slice(-5000);
      delete chainState.pending;

      saveState(state);

      log(
        `✅ ${chain.name}: notified bounty ${args.id.toString()} (${logItem.transactionHash}:${logItem.logIndex})`
      );
    } catch (error) {
      log(
        `❌ ${chain.name}: failed to notify ${key}: ${error.message}`
      );

      throw error;
    }
  }
}

async function scanChain(chain, state) {
  const client = createClient(chain);

  await initializeChainState(chain, client, state);

  const chainState = state.chains[chain.key];

  const latest = await client.getBlockNumber();

  if (latest <= BigInt(CONFIRMATIONS)) return;

  const safeLatest = latest - BigInt(CONFIRMATIONS);

  let fromBlock = BigInt(chainState.lastScannedBlock) + 1n;

  if (fromBlock > safeLatest) return;

  while (fromBlock <= safeLatest) {
    const toBlock =
      fromBlock + BigInt(BLOCK_CHUNK_SIZE) - 1n > safeLatest
        ? safeLatest
        : fromBlock + BigInt(BLOCK_CHUNK_SIZE) - 1n;

    await processRange(
      chain,
      client,
      state,
      fromBlock,
      toBlock
    );

    chainState.lastScannedBlock = toBlock.toString();

    saveState(state);

    fromBlock = toBlock + 1n;
  }
}

async function main() {
  validateConfig();

  const state = loadState();

  log("🚀 GodEye starting");

  log(
    `Polling every ${POLL_INTERVAL_MS}ms; confirmations=${CONFIRMATIONS}`
  );

  // Send a startup notification only if explicitly requested.
  if (
    String(process.env.SEND_STARTUP_TEST).toLowerCase() === "true"
  ) {
    await sendTelegram(
      "🦅 <b>GodEye Online...</b>\n\nBlockchain monitoring is active."
    );
  }

  while (true) {
    for (const chain of CHAINS) {
      try {
        await scanChain(chain, state);
      } catch (error) {
        log(`⚠️ ${chain.name}: ${error.message}`);
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, POLL_INTERVAL_MS)
    );
  }
}

process.on("SIGINT", () => {
  log("Stopping...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Stopping...");
  process.exit(0);
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
