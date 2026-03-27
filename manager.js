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
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CHAIN_CONFIG = {
    base: {
        name: 'Base',
        rpc: process.env.BASE_HTTP_URL || "https://mainnet.base.org",
        fallbacks: ["https://mainnet.base.org", "https://base.publicnode.com", "https://1rpc.io/base"],
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    },
    arbitrum: {
        name: 'Arbitrum',
        rpc: process.env.ARB_HTTP_URL || "https://arb1.arbitrum.io/rpc",
        fallbacks: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arbitrum"],
        usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    }
};

if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    process.exit(1);
}

// ── State ────────────────────────────────────────────────────
const processes = {};   // botId → { process, startedAt, logFile }
const STATE_FILE = path.join(__dirname, 'state.json');
let manuallyKilled = new Set(); // bots stopped via /stop — persist to disk
const crashCount = {}; // botId -> consecutive crashes
const alertStatus = {}; // botId:errorType -> lastAlertTimestamp
const startTime = Date.now();

// ── State Persistence ────────────────────────────────────────
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ stopped: Array.from(manuallyKilled) }));
    } catch (e) { log.error('Failed to save state:', e.message); }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            manuallyKilled = new Set(data.stopped || []);
            log.info(`Loaded stopped state: ${Array.from(manuallyKilled).join(', ') || 'none'}`);
        }
    } catch (e) { log.error('Failed to load state:', e.message); }
}
loadState();

const ERROR_PATTERNS = [
    { name: 'RPC_429', pattern: /429|Monthly capacity limit exceeded/i, message: '🚫 RPC Limit Exceeded (429)' },
    { name: 'NETWORK_FAIL', pattern: /failed to detect network|not started/i, message: '🌐 RPC Network Failure' },
    { name: 'INSUFFICIENT_FUNDS', pattern: /insufficient funds/i, message: '💸 Insufficient Funds' },
];

let lastUpdateId = 0;
let rpcDownStartTime = null;
let lastRpcErrorAlert = 0;

// ── Helpers ──────────────────────────────────────────────────
function withTimeout(promise, ms, timeoutError = 'Timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutError)), ms))
    ]);
}

async function getSafeBalance(address, chainId = 'base') {
    const config = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.base;
    const urls = [config.rpc, ...config.fallbacks]
        .filter(url => url && !url.includes('alchemy'));

    for (const url of urls) {
        try {
            const provider = new ethers.JsonRpcProvider(url);
            const bal = await withTimeout(provider.getBalance(address), 5000, 'RPC Timeout');
            return parseFloat(ethers.formatEther(bal)).toFixed(4);
        } catch (err) { }
    }
    return '?';
}

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

    if (manuallyKilled.has(botId)) {
        manuallyKilled.delete(botId);
        saveState();
    }

    log.info(`Starting ${bot.name} in ${bot.dir}...`);
    const logPath = path.resolve(bot.dir, bot.logFile);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // Explicitly add common binary paths to ensure node/npm/sh are found under Systemd
    const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const combinedEnv = { 
        ...process.env, 
        ...loadBotEnv(bot.dir),
        PATH: process.env.PATH ? `${process.env.PATH}:${systemPath}` : systemPath
    };

    const [cmd, ...args] = bot.cmd.split(' ');
    const child = spawn(cmd, args, {
        cwd: bot.dir,
        env: combinedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        detached: true // Start in a new process group to allow killing children
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on('exit', async (code) => {
        log.warn(`${bot.name} exited with code ${code}`);
        processes[botId].process = null;

        if (manuallyKilled.has(botId)) {
            // Intentionally stopped via /stop — don't auto-restart
            await tgSend(`🛑 ${bot.name} stopped by command`);
        } else {
            // Unexpected crash
            crashCount[botId] = (crashCount[botId] || 0) + 1;
            
            if (crashCount[botId] > 5) {
                log.error(`[Alert] ${bot.name} is in a crash loop! Disabling auto-restart.`);
                await tgSend(`🚨 <b>${bot.name} Crash Loop</b>\nBot crashed 5+ times in a row. Auto-restart disabled. Please check logs.`);
                manuallyKilled.add(botId);
                saveState();
                return;
            }

            const delay = Math.min(10_000 * crashCount[botId], 60_000); // Backoff up to 1m
            await tgSend(
                `⚠️ ${bot.name} crashed (exit code: ${code})\n` +
                `🔄 Auto-restarting in ${delay/1000} seconds...`
            );
            setTimeout(() => {
                if (manuallyKilled.has(botId)) return;
                const result = startBot(botId);
                log.info(`Auto-restart: ${result}`);
            }, delay);
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
    saveState();
    
    try {
        // Kill the entire process group (negative PID)
        process.kill(-proc.pid, 'SIGTERM');
        // Fallback for systems that don't support process group kill
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 1000);
    } catch {
        proc.kill('SIGKILL');
    }
    
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
// ── Status ───────────────────────────────────────────────────────
async function getStatus(botId) {
    if (botId) {
        const bot = BOTS[botId];
        if (!bot) return `❌ Unknown bot: ${botId}`;
        const proc = processes[botId];
        const running = proc?.process && !proc.process.killed;
        const uptime = running ? formatUptime(Date.now() - proc.startedAt) : 'stopped';
        
        let ethBal = '?';
        if (PRIVATE_KEY) {
            const wallet = new ethers.Wallet(PRIVATE_KEY);
            ethBal = await getSafeBalance(wallet.address, bot.chain || 'base');
        }

        return `${bot.name}\n` +
            `Chain: ${bot.chain || 'base'}\n` +
            `Status: ${running ? '🟢 Running' : '🔴 Stopped'}\n` +
            `Uptime: ${uptime}\n` +
            `🔋 ETH: ${ethBal}\n` +
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
        if (running) {
            msg += ` — ${uptime}\n`;
            // Add last 2 lines of logs for visibility
            const logPath = path.resolve(bot.dir, bot.logFile);
            if (fs.existsSync(logPath)) {
                try {
                    const content = fs.readFileSync(logPath, 'utf8').trim().split('\n');
                    const lastLines = content.slice(-2).map(l => `  <i>${l.slice(0, 50)}...</i>`).join('\n');
                    msg += `${lastLines}\n`;
                } catch { }
            }
        } else {
            msg += ` (Stopped)\n`;
        }
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

async function monitorLogs() {
    for (const [id, bot] of Object.entries(BOTS)) {
        const proc = processes[id];
        if (!proc?.process || proc.process.killed) continue;

        try {
            if (!fs.existsSync(proc.logFile)) continue;

            // Read last 2KB of log file
            const stats = fs.statSync(proc.logFile);
            const size = stats.size;
            const bufferSize = Math.min(size, 2048);
            const fd = fs.openSync(proc.logFile, 'r');
            const buffer = Buffer.alloc(bufferSize);
            fs.readSync(fd, buffer, 0, bufferSize, size - bufferSize);
            fs.closeSync(fd);

            const tail = buffer.toString('utf8');

            for (const p of ERROR_PATTERNS) {
                if (p.pattern.test(tail)) {
                    const alertKey = `${id}:${p.name}`;
                    const now = Date.now();
                    const lastAlert = alertStatus[alertKey] || 0;

                    // 1 hour cooldown per error type
                    if (now - lastAlert > 3600_000) {
                        alertStatus[alertKey] = now;
                        log.error(`[Alert] ${bot.name}: ${p.message}`);
                        await tgSend(
                            `⚠️ <b>Bot Malfunction Detected</b>\n\n` +
                            `Bot: ${bot.name}\n` +
                            `Error: ${p.message}\n` +
                            `Action: Please check logs or RPC settings.`
                        );
                    }
                }
            }
        } catch (err) {
            log.warn(`MonitorLogs error for ${id}:`, err.message);
        }
    }
}

// ── Wallet ───────────────────────────────────────────────────────
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getWallet() {
    if (!PRIVATE_KEY) return '❌ Set PRIVATE_KEY in manager .env';
    try {
        const wallet = new ethers.Wallet(PRIVATE_KEY);
        let msg = `💰 <b>Multi-Chain Wallet</b>\n`;
        msg += `Address: <code>${wallet.address}</code>\n\n`;

        for (const [id, config] of Object.entries(CHAIN_CONFIG)) {
            const ethBal = await getSafeBalance(wallet.address, id);
            
            let usdcBal = '0.00';
            try {
                const urls = [config.rpc, ...config.fallbacks].filter(u => u && !u.includes('alchemy'));
                const provider = new ethers.JsonRpcProvider(urls[0]);
                const usdc = new ethers.Contract(config.usdc, USDC_ABI, provider);
                const usdcRaw = await withTimeout(usdc.balanceOf(wallet.address), 5000, 'USDC Timeout');
                usdcBal = parseFloat(ethers.formatUnits(usdcRaw, 6)).toFixed(2);
            } catch (err) { }

            msg += `<b>${config.name}</b>:\n`;
            msg += `  🔋 ETH: ${ethBal}\n`;
            msg += `  💵 USDC: $${usdcBal}\n\n`;
        }

        return msg;
    } catch (err) {
        return `❌ Wallet error: ${err.message}`;
    }
}

// ── Heartbeat ────────────────────────────────────────────────────
async function getHeartbeat() {
    const uptime = formatUptime(Date.now() - startTime);
    let runningCount = 0;
    let botStatusMsg = '';

    for (const [id, bot] of Object.entries(BOTS)) {
        const proc = processes[id];
        const running = proc?.process && !proc.process.killed;
        if (running) runningCount++;

        const botUptime = running ? formatUptime(Date.now() - proc.startedAt) : 'OFF';
        botStatusMsg += `  ${running ? '🟢' : '🔴'} ${bot.name}: ${botUptime}\n`;
    }

    let ethBal = '?';
    if (PRIVATE_KEY) {
        const wallet = new ethers.Wallet(PRIVATE_KEY);
        ethBal = await getSafeBalance(wallet.address);
    }

    return `💓 <b>Manager is ALIVE</b>\n` +
        `⏱ Manager Uptime: ${uptime}\n` +
        `🤖 Bots: ${runningCount}/${Object.keys(BOTS).length} running\n` +
        botStatusMsg +
        `🔋 ETH: ${ethBal}\n` +
        `⏰ Time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
}

// ── Withdraw ─────────────────────────────────────────────────
async function doWithdraw(botId, tokenAddress) {
    const bot = BOTS[botId];
    if (!bot) return `❌ Unknown bot: ${botId}`;
    if (!bot.contractAddress) return `❌ No contract address set for ${bot.name}`;
    if (!PRIVATE_KEY) return '❌ Set PRIVATE_KEY in manager .env';

    const chain = bot.chain || 'base';
    const config = CHAIN_CONFIG[chain];

    try {
        const urls = [config.rpc, ...config.fallbacks].filter(u => u && !u.includes('alchemy'));
        const provider = new ethers.JsonRpcProvider(urls[0]);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contract = new ethers.Contract(bot.contractAddress, bot.contractABI, wallet);

        if (tokenAddress.toLowerCase() === 'eth') {
            const tx = (typeof contract.withdrawETH === 'function') ? await contract.withdrawETH() : await contract.withdrawEth();
            await tx.wait();
            return `✅ ETH withdrawn from ${bot.name} (${chain})\nTX: ${tx.hash}`;
        } else {
            const balance = await contract.getBalance(tokenAddress);
            if (balance === 0n) return `⚠️ Zero balance for this token in ${bot.name}`;
            const tx = (typeof contract.withdraw === 'function') ? await contract.withdraw(tokenAddress) : await contract.withdrawToken(tokenAddress);
            await tx.wait();
            return `✅ Withdrawn from ${bot.name} (${chain})\nTX: ${tx.hash}`;
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

function getMainMenu() {
    return {
        text: `🤖 <b>Bots Manager</b>\nTap a button below:`,
        buttons: [
            [
                { text: '📊 Status', callback_data: 'menu:status' },
                { text: '💰 Wallet', callback_data: 'menu:wallet' },
            ],
            [
                { text: '▶️ Start', callback_data: 'menu:start' },
                { text: '⏹ Stop', callback_data: 'menu:stop' },
                { text: '🔄 Restart', callback_data: 'menu:restart' },
            ],
            [
                { text: '📝 Logs', callback_data: 'menu:logs' },
                { text: '💸 Withdraw', callback_data: 'menu:withdraw' },
            ],
            [
                { text: '💓 Heartbeat', callback_data: 'menu:heartbeat' },
                { text: '❓ Help', callback_data: 'menu:help' },
            ],
        ],
    };
}

function getHelpText() {
    return `🤖 <b>Bots Manager Commands</b>\n\n` +
        `/menu — Main menu\n` +
        `/status — All bots + ETH balance\n` +
        `/start — Start a bot\n` +
        `/stop — Stop a bot\n` +
        `/restart — Restart a bot\n` +
        `/logs — Bot logs\n` +
        `/wallet — ETH + USDC balance\n` +
        `/heartbeat — Manual alive ping\n` +
        `/withdraw — Withdraw profits\n\n` +
        `<b>Bot IDs:</b> ${Object.keys(BOTS).join(', ')}\n` +
        `<i>Or just tap the buttons!</i>`;
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
            return getHelpText();

        case '/menu':
        default:
            return getMainMenu();
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

                    if (parts[0] === 'menu') {
                        // Main menu button was tapped
                        const action = parts[1];
                        switch (action) {
                            case 'status': response = await getStatus(); break;
                            case 'wallet': response = await getWallet(); break;
                            case 'heartbeat': response = await getHeartbeat(); break;
                            case 'help': response = getHelpText(); break;
                            case 'start': response = { text: '\u25b6\ufe0f <b>Which bot to start?</b>', buttons: buildBotButtons('start') }; break;
                            case 'stop': response = { text: '\u23f9 <b>Which bot to stop?</b>', buttons: buildBotButtons('stop') }; break;
                            case 'restart': response = { text: '\ud83d\udd04 <b>Which bot to restart?</b>', buttons: buildBotButtons('restart') }; break;
                            case 'logs': response = { text: '\ud83d\udcdd <b>Which bot\'s logs?</b>', buttons: buildBotButtons('logs', false) }; break;
                            case 'withdraw': response = { text: '\ud83d\udcb8 <b>Withdraw from which bot?</b>', buttons: buildBotButtons('withdraw', false) }; break;
                            default: response = getMainMenu();
                        }
                    } else if (parts[0] === 'dowithdraw' && parts.length === 3) {
                        response = await doWithdraw(parts[1], parts[2]);
                    } else if (parts[0] === 'withdrawhelp') {
                        response = `\ud83d\udcb8 Type: /withdraw ${parts[1]} <token_address>`;
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

async function autoUpdate() {
    try {
        const branch = 'master';
        log.info('Checking for bots-manager updates...');
        execSync(`git fetch origin ${branch}`, { stdio: 'ignore', timeout: 15000 });
        
        const local = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        const remote = execSync(`git rev-parse origin/${branch}`, { encoding: 'utf8' }).trim();
        
        if (local !== remote) {
            log.info(`[Update] New manager version detected (${remote.slice(0, 7)}). Applying clean update...`);
            
            // Force clean reset to remote state
            execSync(`git reset --hard origin/${branch}`, { stdio: 'inherit' });
            
            // Re-install dependencies
            log.info('[Update] Re-installing manager dependencies...');
            execSync('npm install --omit=dev', { encoding: 'utf8', timeout: 60000 });
            
            await tgSend(`🔄 Bots Manager updated to ${remote.slice(0, 7)} — restarting...`);
            process.exit(0);
        } else {
            log.info('Bots Manager is already up to date.');
        }
    } catch (err) {
        log.warn('[Update] autoUpdate skipped:', err.message);
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

    // Log active RPCs per chain
    for (const [chain, cfg] of Object.entries(CHAIN_CONFIG)) {
        log.info(`RPC [${cfg.name}]: ${cfg.rpc.split('//')[1]?.split('/')[0] || 'NONE'}`);
    }

    // Initial auto-update check
    await autoUpdate();

    // Flush the Telegram update queue (reset offset to latest)
    log.info('Flushing Telegram update queue...');
    const initialUpdates = await tgGetUpdates();
    if (initialUpdates.length > 0) {
        lastUpdateId = initialUpdates[initialUpdates.length - 1].update_id;
        log.success(`Queue flushed. Starting from update #${lastUpdateId}`);
    }

    // Load contract addresses from bot .env files
    loadContractAddresses();

    // Send startup notification
    await tgSend(
        `🤖 <b>Bots Manager Online</b>\n\n` +
        `Controlling ${Object.keys(BOTS).length} bot(s):\n` +
        Object.entries(BOTS).map(([id, b]) => `  • <code>${id}</code> — ${b.name}`).join('\n') +
        `\n\nType /help for commands`
    );

    // Auto-start bots (only those NOT manually stopped)
    for (const id of Object.keys(BOTS)) {
        if (!manuallyKilled.has(id)) {
            const result = startBot(id);
            log.info(result);
        } else {
            log.info(`Skipping auto-start for ${BOTS[id].name} (manually stopped)`);
        }
    }

    // Send status after bots launch
    setTimeout(async () => {
        const s = await getStatus();
        await tgSend(s);
    }, 5000);

    // Hourly heartbeat
    setInterval(async () => {
        await tgSend(await getStatus());
    }, 3600_000);

    // 10-minute auto-update check
    setInterval(async () => {
        await autoUpdate();
    }, 600_000);

    // Start listening for Telegram commands
    log.success('Listening for Telegram commands...');

    // RPC Health Watchdog - every 1 minute
    setInterval(async () => {
        const wallet = new ethers.Wallet(PRIVATE_KEY);
        await getSafeBalance(wallet.address);
    }, 60_000);

    // Log monitoring loop - every 30s
    setInterval(monitorLogs, 30_000);
    monitorLogs();

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
