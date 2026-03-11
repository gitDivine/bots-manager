# 🤖 Bots Manager

Telegram-controlled process supervisor. Start, stop, restart, and monitor all your crypto bots from your phone.

## Quick Start

### 0. Install Dependencies

**Ubuntu / Debian:**
```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

**macOS:**
```bash
brew install git node
```

**Windows:**
1. Download and install Git: https://git-scm.com/download/win
2. Download and install Node.js 18+: https://nodejs.org

### 1. Clone & Install

```bash
git clone https://github.com/gitDivine/bots-manager.git
cd bots-manager
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` in a text editor and fill in your values:

```bash
# Linux / Mac
nano .env

# Windows
notepad .env
```

Fill in these fields, then save and close (`Ctrl+O` → `Enter` → `Ctrl+X` in nano):

| Variable | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Message @BotFather on Telegram → `/newbot` |
| `TELEGRAM_CHAT_ID` | Message @userinfobot on Telegram |
| `RPC_URL` | [Alchemy](https://alchemy.com) → Base Mainnet HTTP URL |
| `PRIVATE_KEY` | MetaMask → Export Private Key |

### 3. Configure Your Bots

Edit `bots.config.js` to set the paths to your bot directories:

```js
const BOTS = {
  arb: {
    name: '⚡ Arb Bot',
    dir: '/home/ubuntu/base-arb-bot',    // ← Change to your path
    cmd: 'npm start',
    logFile: 'arb.log',
  },
  liquidation: {
    name: '💀 Liquidation Bot',
    dir: '/home/ubuntu/aave-liquidation-bot',  // ← Change to your path
    cmd: 'npm start',
    logFile: 'liquidation.log',
  },
};
```

### 4. Run

```bash
npm start
```

The manager starts, auto-launches all configured bots, and begins listening for your Telegram commands.

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | Show all bots status |
| `/status <bot>` | Show specific bot status |
| `/start <bot>` | Start a bot |
| `/stop <bot>` | Stop a bot |
| `/restart <bot>` | Restart a bot |
| `/startall` | Start all bots |
| `/stopall` | Stop all bots |
| `/restartall` | Restart all bots |
| `/logs <bot>` | Show last 15 log lines |
| `/wallet` | Check ETH balance |
| `/withdraw <bot> <token>` | Withdraw profits from bot contract |
| `/help` | Show all commands |

**Bot IDs** are the keys in `bots.config.js` (e.g., `arb`, `liquidation`).

## Adding a New Bot

Just add a new entry to `bots.config.js`:

```js
mybot: {
  name: '🚀 My New Bot',
  dir: '/home/ubuntu/my-new-bot',
  cmd: 'npm start',
  logFile: 'mybot.log',
  contractAddress: '',
  contractABI: [],
},
```

Restart the manager and the new bot is immediately controllable via Telegram.

## Running 24/7 on a VPS

```bash
# Install PM2
sudo npm install -g pm2

# Start the manager (it auto-starts all bots)
pm2 start manager.js --name "bots-manager"

# View logs
pm2 logs bots-manager

# Persist across reboots
pm2 save
pm2 startup
```

## How It Works

```
Your Phone (Telegram)
    ↕ commands + responses
Bots Manager (always running)
    ↕ spawns / kills / monitors
    ├── Arb Bot process
    ├── Liquidation Bot process
    └── Any future bot process
```

The manager is a lightweight Node.js process that:
- Listens for Telegram commands via long-polling
- Spawns bot processes as child processes
- Pipes bot output to log files
- Sends you alerts if a bot crashes
- Sends hourly heartbeat status
- Auto-starts all bots on launch

## License

MIT
