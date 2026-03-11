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
const manuallyKilled = new Set(); // bots stopped via /stop — skip auto-restart
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

async function tgSendWithButtons(text, buttons) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons },
            }),
        });
    } catch { }
}

async function tgAnswerCallback(callbackId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackId, text }),
        });
    } catch { }
}

async function tgGetUpdates() {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=["message","callback_query"]`
        );
        const data = await res.json();
        return data.ok ? data.result : [];
    } catch {
        return [];
    }
}

// Build inline keyboard rows for bot selection
function buildBotButtons(action, includeAll = true) {
    const buttons = Object.entries(BOTS).map(([id, bot]) => ({
        text: bot.name,
        callback_data: `${action}:${id}`,
    }));
    const rows = [buttons];
    if (includeAll) {
        rows.push([{ text: '🔁 All Bots', callback_data: `${action}:all` }]);
    }
    return rows;
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

        if (manuallyKilled.has(botId)) {
            // Intentionally stopped via /stop — don't auto-restart
            manuallyKilled.delete(botId);
            await tgSend(`🛑 ${bot.name} stopped by command`);
        } else {
            // Unexpected crash — auto-restart after 10 seconds
            await tgSend(
                `⚠️ ${bot.name} crashed (exit code: ${code})\n` +
                `🔄 Auto-restarting in 10 seconds...`
            );
            setTimeout(() => {
                const result = startBot(botId);
                log.info(`Auto-restart: ${result}`);
                tgSend(`✅ ${bot.name} auto-restarted`);
            }, 10_000);
        }
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

    manuallyKilled.add(botId);
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

// ── Status ───────────────────────────────────────────────────────
async function getStatus(botId) {
    // Fetch ETH balance
    let ethBal = '?';
    if (RPC_URL && PRIVATE_KEY) {
        try {
            const provider = new ethers.JsonRpcProvider(RPC_URL);
            const w = new ethers.Wallet(PRIVATE_KEY, provider);
            const bal = await provider.getBalance(w.address);
            ethBal = parseFloat(ethers.formatEther(bal)).toFixed(4);
        } catch { }
    }

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
    msg += `Manager uptime: ${formatUptime(Date.now() - startTime)}\n`;
    msg += `🔋 ETH: ${ethBal}\n\n`;

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

// ── Logs ─────────────────────────────────────────────────────────
function getLogs(botId, lines = 10) {
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

// ── Wallet ───────────────────────────────────────────────────────
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getWallet() {
    if (!RPC_URL || !PRIVATE_KEY) return '❌ Set RPC_URL and PRIVATE_KEY in manager .env';
    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const balance = await provider.getBalance(wallet.address);
        const ethBal = parseFloat(ethers.formatEther(balance)).toFixed(4);

        // USDC balance
        let usdcBal = '0.00';
        try {
            const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
            const usdcRaw = await usdc.balanceOf(wallet.address);
            usdcBal = parseFloat(ethers.formatUnits(usdcRaw, 6)).toFixed(2);
        } catch { }

        return `💰 <b>Wallet</b>\n` +
            `Address: <code>${wallet.address}</code>\n` +
            `🔋 ETH: ${ethBal}\n` +
            `💵 USDC: $${usdcBal}`;
    } catch (err) {
        return `❌ Wallet error: ${err.message}`;
    }
}

// ── Heartbeat ────────────────────────────────────────────────────
async function getHeartbeat() {
    const uptime = formatUptime(Date.now() - startTime);
    const running = Object.entries(BOTS).filter(([id]) => {
        const proc = processes[id];
        return proc?.process && !proc.process.killed;
    }).length;
    const total = Object.keys(BOTS).length;

    let ethBal = '?';
    if (RPC_URL && PRIVATE_KEY) {
        try {
            const provider = new ethers.JsonRpcProvider(RPC_URL);
            const w = new ethers.Wallet(PRIVATE_KEY, provider);
            const bal = await provider.getBalance(w.address);
            ethBal = parseFloat(ethers.formatEther(bal)).toFixed(4);
        } catch { }
    }

    return `💓 <b>Manager is ALIVE</b>\n` +
        `⏱ Uptime: ${uptime}\n` +
        `🤖 Bots: ${running}/${total} running\n` +
        `🔋 ETH: ${ethBal}\n` +
        `⏰ Time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
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
        `/status — All bots + ETH balance\n` +
        `/status &lt;bot&gt; — Specific bot status\n` +
        `/start &lt;bot&gt; — Start a bot\n` +
        `/stop &lt;bot&gt; — Stop a bot\n` +
        `/restart &lt;bot&gt; — Restart a bot\n` +
        `/startall — Start all bots\n` +
        `/stopall — Stop all bots\n` +
        `/restartall — Restart all bots\n` +
        `/logs &lt;bot&gt; — Last 10 log lines\n` +
        `/wallet — ETH + USDC balance\n` +
        `/heartbeat — Manual alive ping\n` +
        `/withdraw &lt;bot&gt; &lt;token&gt; — Withdraw profits\n` +
        `/help — This message\n\n` +
        `<b>Bot IDs:</b> ${Object.keys(BOTS).join(', ')}`;
}

// ── Command Router ───────────────────────────────────────────
// Returns { text, buttons } or just a string
async function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@\w+/, ''); // strip @botname
    const arg1 = parts[1]?.toLowerCase();
    const arg2 = parts[2];

    switch (cmd) {
        case '/start':
            if (!arg1) return { text: '▶️ <b>Which bot to start?</b>', buttons: buildBotButtons('start') };
            return startBot(arg1);

        case '/stop':
        case '/kill':
            if (!arg1) return { text: '⏹ <b>Which bot to stop?</b>', buttons: buildBotButtons('stop') };
            return killBot(arg1);

        case '/restart':
            if (!arg1) return { text: '🔄 <b>Which bot to restart?</b>', buttons: buildBotButtons('restart') };
            return await restartBot(arg1);

        case '/startall':
            return await handleBulk('start');

        case '/stopall':
        case '/killall':
            return await handleBulk('stop');

        case '/restartall':
            return await handleBulk('restart');

        case '/status':
            if (!arg1) return await getStatus();
            return await getStatus(arg1);

        case '/logs':
            if (!arg1) return { text: '📝 <b>Which bot\'s logs?</b>', buttons: buildBotButtons('logs', false) };
            return getLogs(arg1);

        case '/wallet':
            return await getWallet();

        case '/heartbeat':
        case '/ping':
            return await getHeartbeat();

        case '/withdraw':
            if (!arg1) return { text: '💸 <b>Withdraw from which bot?</b>', buttons: buildBotButtons('withdraw', false) };
            if (!arg2) return '❓ Usage: /withdraw <bot> <token_address|eth>';
            return await doWithdraw(arg1, arg2);

        case '/help':
            return getHelp();

        default:
            return getHelp();
    }
}

// Handle bulk operations
async function handleBulk(action) {
    let msg = '';
    for (const id of Object.keys(BOTS)) {
        if (action === 'start') msg += startBot(id) + '\n';
        else if (action === 'stop') msg += killBot(id) + '\n';
        else if (action === 'restart') msg += await restartBot(id) + '\n';
    }
    return msg;
}

// Handle button press callbacks
async function handleCallback(action, botId) {
    if (botId === 'all') {
        return await handleBulk(action);
    }

    switch (action) {
        case 'start': return startBot(botId);
        case 'stop': return killBot(botId);
        case 'restart': return await restartBot(botId);
        case 'logs': return getLogs(botId);
        case 'status': return await getStatus(botId);
        case 'withdraw':
            // Show sub-options for withdraw
            return {
                text: `💸 <b>Withdraw from ${BOTS[botId]?.name || botId}:</b>`,
                buttons: [
                    [{ text: '🔷 Withdraw ETH', callback_data: `dowithdraw:${botId}:eth` }],
                    [{ text: '💵 Enter token address', callback_data: `withdrawhelp:${botId}` }],
                ]
            };
        default: return '❓ Unknown action';
    }
}

// ── Send response (text or text+buttons) ─────────────────────
async function sendResponse(response) {
    if (typeof response === 'object' && response.buttons) {
        await tgSendWithButtons(response.text, response.buttons);
    } else {
        await tgSend(response);
    }
}

// ── Telegram Polling Loop ────────────────────────────────────
async function pollTelegram() {
    while (true) {
        try {
            const updates = await tgGetUpdates();

            for (const update of updates) {
                lastUpdateId = update.update_id;

                // ── Handle button press ──
                if (update.callback_query) {
                    const cb = update.callback_query;
                    if (String(cb.message?.chat?.id) !== String(TG_CHAT_ID)) continue;

                    const data = cb.data; // e.g. "start:arb" or "dowithdraw:arb:eth"
                    log.info(`Button: ${data}`);
                    await tgAnswerCallback(cb.id, '⏳ Processing...');

                    const parts = data.split(':');
                    let response;

                    if (parts[0] === 'dowithdraw' && parts.length === 3) {
                        response = await doWithdraw(parts[1], parts[2]);
                    } else if (parts[0] === 'withdrawhelp') {
                        response = `💸 Type: /withdraw ${parts[1]} <token_address>`;
                    } else {
                        response = await handleCallback(parts[0], parts[1]);
                    }

                    await sendResponse(response);
                    continue;
                }

                // ── Handle text message ──
                const msg = update.message;
                if (!msg || !msg.text) continue;

                // Security: only respond to authorized chat
                if (String(msg.chat.id) !== String(TG_CHAT_ID)) continue;

                const text = msg.text;
                if (!text.startsWith('/')) continue;

                log.info(`Command: ${text}`);
                const response = await handleCommand(text);
                await sendResponse(response);
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
