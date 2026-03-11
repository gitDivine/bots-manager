# 🛠️ VPS Auto-Restart Guide (systemd)

To make your manager and bots survive crashes and VPS reboots, you should register them as **systemd** services.

## 1. Create the Manager Service
This keeps the Telegram controller running forever.

1. Create the file:
   ```bash
   sudo nano /etc/systemd/system/bots-manager.service
   ```
2. Paste this in (update `/home/ubuntu` if your username is different):
   ```ini
   [Unit]
   Description=Bots Manager Telegram Controller
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/bots-manager
   ExecStart=/usr/bin/node manager.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

## 2. Create Bot Services (Optional but Recommended)
If you want the bots to start themselves even if the manager is off:

### Arb Bot
```bash
sudo nano /etc/systemd/system/arb-bot.service
```
Paste:
```ini
[Unit]
Description=Base Arb Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/base-arb-bot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Liquidation Bot
```bash
sudo nano /etc/systemd/system/liquidation-bot.service
```
Paste:
```ini
[Unit]
Description=Aave Liquidation Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/aave-liquidation-bot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 3. Enable and Start
Run these commands to activate everything:

```bash
# Reload systemd to see new files
sudo systemctl daemon-reload

# Enable (starts automatically on boot)
sudo systemctl enable bots-manager
sudo systemctl enable arb-bot
sudo systemctl enable liquidation-bot

# Start now
sudo systemctl start bots-manager
sudo systemctl start arb-bot
sudo systemctl start liquidation-bot
```

## 4. Useful Commands

| Action | Command |
|---|---|
| Check if service is OK | `sudo systemctl status bots-manager` |
| View live logs | `journalctl -u bots-manager -f` |
| Stop a service | `sudo systemctl stop bots-manager` |
| Restart a service | `sudo systemctl restart bots-manager` |

---

### Alternative: PM2 (Easier)
If systemd feels too complex, you can use **PM2**:
```bash
sudo npm install -g pm2
cd ~/bots-manager && pm2 start manager.js --name manager
cd ~/base-arb-bot && pm2 start npm --name arb -- start
cd ~/aave-liquidation-bot && pm2 start npm --name liquidation -- start

# Save for reboot
pm2 save
pm2 startup
```
