// ============================================================
//  BOTS MANAGER — Telegram-controlled process supervisor
//  Controls all your bots from your phone via Telegram
//  Run with: node manager.js
// ============================================================

require('dotenv').config();
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { BOTS } = require('./bots.config');

// ── Config ───────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    process.exit(1);
}

// ── State ────────────────────────────────────────────────────
const processes = {};   // botId → { process, startedAt, logFile }
const startTime = Date.now();
let lastUpdateId = 0;

// ── Logging ──────────────────────────────────────────────────
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
    info: (...m) => console.log(`[${ts()}] ℹ️`, ...m),
    success: (...m) => console.log(`[${ts()}] ✅`, ...m),
    warn: (...m) => console.log(`[${ts()}] ⚠️`, ...m),
    error: (...m) => console.error(`[${ts()}] ❌`, ...m),
};

// ── Telegram API ─────────────────────────────────────────────
async function tgSend(text) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text,
                parse_mode: 'HTML',
            }),
        });
    } catch { }
}

async function tgGetUpdates() {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
        );
        const data = await res.json();
        return data.ok ? data.result : [];
    } catch {
        return [];
    }
}

// ── Process Management ───────────────────────────────────────
function startBot(botId) {
    const bot = BOTS[botId];
    if (!bot) return `❌ Unknown bot: ${botId}`;
    if (processes[botId]?.process && !processes[botId].process.killed) {
        return `⚠️ ${bot.name} is already running`;
    }

    const logPath = path.resolve(bot.dir, bot.logFile);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const [cmd, ...args] = bot.cmd.split(' ');
    const child = spawn(cmd, args, {
        cwd: bot.dir,
        env: { ...process.env, ...loadBotEnv(bot.dir) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on('exit', async (code) => {
        log.warn(`${bot.name} exited with code ${code}`);
        processes[botId].process = null;
        await tgSend(`⚠️ ${bot.name} stopped (exit code: ${code})`);
    });

    processes[botId] = {
        process: child,
        startedAt: Date.now(),
        logFile: logPath,
    };

    log.success(`Started ${bot.name} (PID: ${child.pid})`);
    return `✅ ${bot.name} started (PID: ${child.pid})`;
}

function killBot(botId) {
    const bot = BOTS[botId];
    if (!bot) return `❌ Unknown bot: ${botId}`;

    const proc = processes[botId]?.process;
    if (!proc || proc.killed) {
        return `⚠️ ${bot.name} is not running`;
    }

    proc.kill('SIGTERM');
    log.info(`Killed ${bot.name}`);
    return `🛑 ${bot.name} stopped`;
}

function restartBot(botId) {
    killBot(botId);
    // Small delay before restart
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(startBot(botId));
        }, 2000);
    });
}

// ── Status ───────────────────────────────────────────────────
function getStatus(botId) {
    if (botId) {
        const bot = BOTS[botId];
        if (!bot) return `❌ Unknown bot: ${botId}`;
        const proc = processes[botId];
        const running = proc?.process && !proc.process.killed;
        const uptime = running ? formatUptime(Date.now() - proc.startedAt) : 'stopped';
        return `${bot.name}\n` +
            `Status: ${running ? '🟢 Running' : '🔴 Stopped'}\n` +
            `Uptime: ${uptime}\n` +
            `PID: ${running ? proc.process.pid : 'N/A'}`;
    }

    // All bots status
    let msg = `📊 <b>Bots Manager Status</b>\n`;
    msg += `Manager uptime: ${formatUptime(Date.now() - startTime)}\n\n`;

    for (const [id, bot] of Object.entries(BOTS)) {
        const proc = processes[id];
        const running = proc?.process && !proc.process.killed;
        const uptime = running ? formatUptime(Date.now() - proc.startedAt) : '';
        msg += `${running ? '🟢' : '🔴'} <b>${bot.name}</b>`;
        if (running) msg += ` — ${uptime}`;
        msg += '\n';
    }

    return msg;
}

// ── Logs ─────────────────────────────────────────────────────
function getLogs(botId, lines = 15) {
    const bot = BOTS[botId];
    if (!bot) return `❌ Unknown bot: ${botId}`;

    const logPath = path.resolve(bot.dir, bot.logFile);
    if (!fs.existsSync(logPath)) return `📝 No logs yet for ${bot.name}`;

    try {
        const content = fs.readFileSync(logPath, 'utf8');
        const allLines = content.trim().split('\n');
        const lastLines = allLines.slice(-lines).join('\n');
        return `📝 <b>${bot.name} — Last ${lines} lines:</b>\n<pre>${lastLines}</pre>`;
    } catch {
        return `❌ Could not read logs for ${bot.name}`;
    }
}

// ── Wallet ───────────────────────────────────────────────────
async function getWallet() {
    if (!RPC_URL || !PRIVATE_KEY) return '❌ Set RPC_URL and PRIVATE_KEY in manager .env';
    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const balance = await provider.getBalance(wallet.address);
        const ethBal = parseFloat(ethers.formatEther(balance)).toFixed(4);
        return `💰 <b>Wallet</b>\n` +
            `Address: <code>${wallet.address}</code>\n` +
            `ETH: ${ethBal}`;
    } catch (err) {
        return `❌ Wallet error: ${err.message}`;
    }
}

// ── Withdraw ─────────────────────────────────────────────────
async function doWithdraw(botId, tokenAddress) {
    const bot = BOTS[botId];
    if (!bot) return `❌ Unknown bot: ${botId}`;
    if (!bot.contractAddress) return `❌ No contract address set for ${bot.name}`;
    if (!RPC_URL || !PRIVATE_KEY) return '❌ Set RPC_URL and PRIVATE_KEY';

    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(bot.contractAddress, bot.contractABI, wallet);

        if (tokenAddress === 'eth') {
            const tx = await contract.withdrawETH();
            await tx.wait();
            return `✅ ETH withdrawn from ${bot.name}\nTX: ${tx.hash}`;
        } else {
            const balance = await contract.getBalance(tokenAddress);
            if (balance === 0n) return `⚠️ Zero balance for this token in ${bot.name}`;
            const tx = await contract.withdraw(tokenAddress);
            await tx.wait();
            return `✅ Withdrawn from ${bot.name}\nTX: ${tx.hash}`;
        }
    } catch (err) {
        return `❌ Withdraw failed: ${err.message}`;
    }
}

// ── Helpers ──────────────────────────────────────────────────
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function loadBotEnv(dir) {
    const envPath = path.join(dir, '.env');
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
            vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
    }
    return vars;
}

function getHelp() {
    return `🤖 <b>Bots Manager Commands</b>\n\n` +
        `/status — All bots status\n` +
        `/status &lt;bot&gt; — Specific bot status\n` +
        `/start &lt;bot&gt; — Start a bot\n` +
        `/stop &lt;bot&gt; — Stop a bot\n` +
        `/restart &lt;bot&gt; — Restart a bot\n` +
        `/startall — Start all bots\n` +
        `/stopall — Stop all bots\n` +
        `/restartall — Restart all bots\n` +
        `/logs &lt;bot&gt; — Last 15 log lines\n` +
        `/wallet — Check ETH balance\n` +
        `/withdraw &lt;bot&gt; &lt;token&gt; — Withdraw profits\n` +
        `/help — This message\n\n` +
        `<b>Bot IDs:</b> ${Object.keys(BOTS).join(', ')}`;
}

// ── Command Router ───────────────────────────────────────────
async function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1]?.toLowerCase();
    const arg2 = parts[2];

    switch (cmd) {
        case '/start':
            if (!arg1) return '❓ Usage: /start <bot>\nBot IDs: ' + Object.keys(BOTS).join(', ');
            return startBot(arg1);

        case '/stop':
        case '/kill':
            if (!arg1) return '❓ Usage: /stop <bot>';
            return killBot(arg1);

        case '/restart':
            if (!arg1) return '❓ Usage: /restart <bot>';
            return await restartBot(arg1);

        case '/startall':
            let startMsg = '';
            for (const id of Object.keys(BOTS)) {
                startMsg += startBot(id) + '\n';
            }
            return startMsg;

        case '/stopall':
        case '/killall':
            let stopMsg = '';
            for (const id of Object.keys(BOTS)) {
                stopMsg += killBot(id) + '\n';
            }
            return stopMsg;

        case '/restartall':
            let restartMsg = '';
            for (const id of Object.keys(BOTS)) {
                restartMsg += await restartBot(id) + '\n';
            }
            return restartMsg;

        case '/status':
            return getStatus(arg1);

        case '/logs':
            if (!arg1) return '❓ Usage: /logs <bot>';
            return getLogs(arg1);

        case '/wallet':
            return await getWallet();

        case '/withdraw':
            if (!arg1 || !arg2) return '❓ Usage: /withdraw <bot> <token_address|eth>';
            return await doWithdraw(arg1, arg2);

        case '/help':
            return getHelp();

        default:
            return getHelp();
    }
}

// ── Telegram Polling Loop ────────────────────────────────────
async function pollTelegram() {
    while (true) {
        try {
            const updates = await tgGetUpdates();

            for (const update of updates) {
                lastUpdateId = update.update_id;

                const msg = update.message;
                if (!msg || !msg.text) continue;

                // Security: only respond to authorized chat
                if (String(msg.chat.id) !== String(TG_CHAT_ID)) continue;

                const text = msg.text;
                if (!text.startsWith('/')) continue;

                log.info(`Command: ${text}`);
                const response = await handleCommand(text);
                await tgSend(response);
            }
        } catch (err) {
            log.error('Poll error:', err.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// ── Load contract addresses from bot .env files ──────────────
function loadContractAddresses() {
    for (const [id, bot] of Object.entries(BOTS)) {
        if (!bot.contractAddress) {
            const env = loadBotEnv(bot.dir);
            const addr = env.CONTRACT_ADDRESS;
            if (addr) {
                BOTS[id].contractAddress = addr;
                log.info(`Loaded contract for ${bot.name}: ${addr.slice(0, 10)}...`);
            }
        }
    }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║       🤖 BOTS MANAGER — ACTIVE               ║');
    console.log('║       Telegram-controlled supervisor          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log();

    log.info(`Managing ${Object.keys(BOTS).length} bot(s): ${Object.keys(BOTS).join(', ')}`);

    // Load contract addresses from bot .env files
    loadContractAddresses();

    // Send startup notification
    await tgSend(
        `🤖 <b>Bots Manager Online</b>\n\n` +
        `Controlling ${Object.keys(BOTS).length} bot(s):\n` +
        Object.entries(BOTS).map(([id, b]) => `  • <code>${id}</code> — ${b.name}`).join('\n') +
        `\n\nType /help for commands`
    );

    // Auto-start all bots
    for (const id of Object.keys(BOTS)) {
        const result = startBot(id);
        log.info(result);
    }

    // Send status after bots launch
    setTimeout(async () => {
        await tgSend(getStatus());
    }, 5000);

    // Hourly heartbeat
    setInterval(async () => {
        await tgSend(getStatus());
    }, 3600_000);

    // Start listening for Telegram commands
    log.success('Listening for Telegram commands...');
    await pollTelegram();
}

// ── Graceful Shutdown ────────────────────────────────────────
process.on('SIGINT', async () => {
    log.info('Shutting down — killing all bots...');
    for (const id of Object.keys(BOTS)) {
        killBot(id);
    }
    await tgSend('🛑 Bots Manager stopped — all bots killed');
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    log.error('Unhandled rejection:', err?.message || err);
});

main().catch(err => {
    log.error('Fatal:', err.message);
    process.exit(1);
});
