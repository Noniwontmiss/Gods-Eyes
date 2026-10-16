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
const { mainnet, arbitrum, base, degen } = require("viem/chains");

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
  },
  {
    key: "degen",
    env: "DEGEN_RPC_URL",
    startEnv: "DEGEN_START_BLOCK",
    name: "Degen",
    slug: "degen",
    chain: degen,
    contract: "0x18e5585ca7ce31b90bc8bb7aaf84152857ce243f",
    explorer: "https://explorer.degen.tips/tx/",
    currency: "DEGEN"
  }
];
const STATE_FILE = path.join(
  process.env.DATA_DIR || "/data",
  "state.json"
);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 1);
const BLOCK_CHUNK_SIZE = Number(process.env.BLOCK_CHUNK_SIZE || 1000);
const START_FROM_CURRENT =
  String(process.env.START_FROM_CURRENT || "true").toLowerCase() === "true";

function log(message, ...args) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { version: 1, chains: {} };
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

function bountyUrl(chain, id) {
  return `https://poidh.xyz/${chain.slug}/bounty/${id.toString()}`;
}

function formatAmount(amount, chain) {
  const value = formatEther(amount);
  return `${value} ${chain.currency}`;
}

function buildTelegramMessage(chain, args, txHash) {
  const id = args.id;
  const title = escapeHtml(args.title || "Untitled bounty");
  const descriptionRaw = String(args.description || "").trim();
  const description =
    descriptionRaw.length > 700
      ? `${descriptionRaw.slice(0, 700)}…`
      : descriptionRaw;

  const openLabel = args.isOpenBounty ? "Open bounty" : "Standard bounty";

  return [
    "🚨 <b>NEW POIDH BOUNTY</b>",
    "",
    `📌 <b>${title}</b>`,
    `💰 <b>${escapeHtml(formatAmount(args.amount, chain))}</b>`,
    `⛓ <b>${escapeHtml(chain.name)}</b>`,
    `👤 <code>${shortenAddress(args.issuer)}</code>`,
    `🆔 <code>${id.toString()}</code>`,
    `🎯 ${escapeHtml(openLabel)}`,
    description ? "" : null,
    description ? `📝 ${escapeHtml(description)}` : null,
    "",
    `🔗 <a href="${bountyUrl(chain, id)}">View bounty</a>`,
    `🔍 <a href="${chain.explorer}${txHash}">View transaction</a>`
  ].filter((x) => x !== null).join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
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
    if (!process.env[chain.env]) missing.push(chain.env);
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  for (const chain of CHAINS) {
    if (!isAddress(chain.contract)) {
      throw new Error(`Invalid contract address for ${chain.name}`);
    }
  }
}

function createClient(chain) {
  return createPublicClient({
    chain: chain.chain,
    transport: http(process.env[chain.env], {
      retryCount: 3,
      retryDelay: 1000
    }),
  });
}

async function initializeChainState(chain, client, state) {
  if (state.chains[chain.key]) return;

  const current = await client.getBlockNumber();
  let startBlock = current;

  if (!START_FROM_CURRENT) {
    const configured = process.env[chain.startEnv];
    startBlock = configured ? BigInt(configured) : current;
  }

  state.chains[chain.key] = {
    lastScannedBlock: (startBlock - 1n).toString(),
    seen: []
  };

  saveState(state);
  log(`${chain.name}: starting at block ${startBlock.toString()}`);
}

async function processRange(chain, client, state, fromBlock, toBlock) {
  const logs = await client.getLogs({
    address: chain.contract,
    event: EVENT_ABI[0],
    fromBlock,
    toBlock
  });

  if (!logs.length) return;

  log(`${chain.name}: found ${logs.length} BountyCreated event(s) in ${fromBlock}-${toBlock}`);

  const chainState = state.chains[chain.key];
  const seenSet = new Set(chainState.seen || []);

  for (const logItem of logs) {
    const key = eventKey(logItem);

    if (seenSet.has(key)) {
      continue;
    }

    const args = logItem.args;

    try {
      const message = buildTelegramMessage(
        chain,
        args,
        logItem.transactionHash
      );

      await sendTelegram(message);

      seenSet.add(key);
      chainState.seen = Array.from(seenSet).slice(-5000);

      saveState(state);

      log(
        `✅ ${chain.name}: notified bounty ${args.id.toString()} (${logItem.transactionHash}:${logItem.logIndex})`
      );
    } catch (error) {
      log(`❌ ${chain.name}: failed to notify ${key}: ${error.message}`);
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

    await processRange(chain, client, state, fromBlock, toBlock);

    chainState.lastScannedBlock = toBlock.toString();
    saveState(state);

    fromBlock = toBlock + 1n;
  }
}

async function main() {
  validateConfig();

  const state = loadState();

  log("🚀 POIDH Telegram watcher starting");
  log(`Polling every ${POLL_INTERVAL_MS}ms; confirmations=${CONFIRMATIONS}`);

  // Send a startup notification only if explicitly requested.
  if (String(process.env.SEND_STARTUP_TEST).toLowerCase() === "true") {
    await sendTelegram(
      "🟢 <b>POIDH watcher online</b>\n\nBlockchain monitoring is active."
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

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
