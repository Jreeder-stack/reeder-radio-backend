#!/bin/bash
set -euo pipefail

echo "=== Command Comms — Azure VM Setup Script ==="
echo "Run this as root (or with sudo) on a fresh Ubuntu 22.04/24.04 Azure VM"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Please run as root (sudo bash setup-server.sh)"
  exit 1
fi

DEPLOY_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"
if [ -z "$DEPLOY_USER" ] || [ "$DEPLOY_USER" = "root" ]; then
  echo "WARNING: Could not determine non-root user."
  echo "PM2 startup will be configured for root. You can reconfigure later with:"
  echo "  pm2 startup systemd -u YOUR_USER --hp /home/YOUR_USER"
  DEPLOY_USER="root"
  DEPLOY_HOME="/root"
else
  DEPLOY_HOME="/home/$DEPLOY_USER"
fi

echo "[1/7] Updating system and installing prerequisites..."
apt-get update && apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg lsb-release

echo "[2/7] Installing Node.js 20.x..."
CURRENT_NODE=$(node -v 2>/dev/null || echo "none")
if [[ "$CURRENT_NODE" != v20.* ]]; then
  echo "  Current Node.js: $CURRENT_NODE — installing 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "  Node.js $CURRENT_NODE already installed"
fi
echo "  Node.js $(node -v) installed"
echo "  npm $(npm -v) installed"

if [ "${SKIP_LOCAL_PG:-0}" = "1" ]; then
  echo "[3/7] Skipping local PostgreSQL (using external database)..."
else
  echo "[3/7] Installing PostgreSQL 16..."
  CURRENT_PG=$(psql --version 2>/dev/null | awk '{print $3}' || echo "none")
  if [[ "$CURRENT_PG" != 16.* ]]; then
    echo "  Current PostgreSQL: $CURRENT_PG — installing 16..."
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
    apt-get update
    apt-get install -y postgresql-16
  else
    echo "  PostgreSQL $CURRENT_PG already installed"
  fi
  systemctl enable postgresql
  systemctl start postgresql
  echo "  PostgreSQL $(psql --version | awk '{print $3}') installed"
fi

echo "[4/7] Installing nginx..."
apt-get install -y nginx
systemctl enable nginx
echo "  nginx installed"

echo "[5/7] Installing PM2 globally..."
npm install -g pm2
pm2 startup systemd -u "$DEPLOY_USER" --hp "$DEPLOY_HOME"
echo "  PM2 installed and configured for user: $DEPLOY_USER"

echo "[6/7] Installing certbot for SSL..."
apt-get install -y certbot python3-certbot-nginx
echo "  certbot installed"

echo "[7/7] Configuring firewall (ufw)..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 5100/udp
ufw --force enable
ufw status verbose
echo "  Firewall configured: SSH(22), HTTP(80), HTTPS(443), Audio Relay UDP(5100)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "IMPORTANT: Ensure your Azure Network Security Group (NSG) also allows:"
echo "  - Inbound TCP 80   (HTTP)"
echo "  - Inbound TCP 443  (HTTPS)"
echo "  - Inbound UDP 5100 (Audio relay)"
echo "  UFW only controls the VM's OS firewall; Azure NSG rules must match."
echo ""
echo "Next steps:"
echo "  1. Set up PostgreSQL database:  sudo bash deploy/init-db.sh"
echo "  2. Copy HTTP-only nginx config (pre-SSL) and set your domain:"
echo "       sudo cp deploy/nginx-pre-ssl.conf /etc/nginx/sites-available/command-comms"
echo "       sudo sed -i 's/YOUR_DOMAIN/your.actual.domain/g' /etc/nginx/sites-available/command-comms"
echo "  3. Enable nginx site:           sudo ln -sf /etc/nginx/sites-available/command-comms /etc/nginx/sites-enabled/"
echo "  4. Remove default site:         sudo rm -f /etc/nginx/sites-enabled/default"
echo "  5. Reload nginx:                sudo nginx -t && sudo systemctl reload nginx"
echo "  6. Get SSL cert (certbot will update the nginx config automatically):"
echo "       sudo certbot --nginx -d YOUR_DOMAIN"
echo "     After certbot succeeds, your site is SSL-enabled. The deploy/nginx.conf"
echo "     file is provided as a reference for the final SSL config if needed."
echo "  7. Copy .env.production.example to .env and fill in values"
echo "  8. Run deploy script:           bash deploy/deploy.sh"
