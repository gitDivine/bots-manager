// ============================================================
//  BOTS CONFIG — Add your bots here
//  The manager reads this file to know what it can control.
//  To add a new bot, just add a new entry to this object.
// ============================================================

const BOTS = {
    arb: {
        name: '⚡ Arb Bot',
        dir: '/home/ubuntu/base-arb-bot',
        cmd: 'npm start',
        logFile: 'arb.log',
        // Contract info for /withdraw command
        contractAddress: '',   // filled from the bot's .env
        contractABI: [
            'function withdraw(address token) external',
            'function withdrawETH() external',
            'function getBalance(address token) external view returns (uint256)',
        ],
    },

    liquidation: {
        name: '💀 Liquidation Bot (Base)',
        dir: '/home/ubuntu/aave-liquidation-bot',
        cmd: 'CHAIN=base npm start',
        logFile: 'liquidation_base.log',
        contractAddress: '',
        contractABI: [
            'function withdraw(address token) external',
            'function withdrawETH() external',
            'function getBalance(address token) external view returns (uint256)',
        ],
    },

    arb_arbitrum: {
        name: '⚡ Arb Bot (Arbitrum)',
        dir: '/home/ubuntu/base-arb-bot',
        cmd: 'CHAIN=arbitrum npm start',
        logFile: 'arb_arbitrum.log',
        contractAddress: '',
        contractABI: [
            'function withdrawToken(address token) external',
            'function withdrawEth() external',
            'function getBalance(address token) external view returns (uint256)',
        ],
    },

    liquidation_arbitrum: {
        name: '💀 Liquidation Bot (Arbitrum)',
        dir: '/home/ubuntu/aave-liquidation-bot',
        cmd: 'CHAIN=arbitrum npm start',
        logFile: 'liquidation_arbitrum.log',
        contractAddress: '',
        contractABI: [
            'function withdraw(address token) external',
            'function withdrawETH() external',
            'function getBalance(address token) external view returns (uint256)',
        ],
    },

    // ── Add more bots here ──────────────────────────────────
    // example: {
    //   name: '🤖 My New Bot',
    //   dir: '/home/ubuntu/my-new-bot',
    //   cmd: 'npm start',
    //   logFile: 'newbot.log',
    //   contractAddress: '',
    //   contractABI: [],
    // },
};

module.exports = { BOTS };
