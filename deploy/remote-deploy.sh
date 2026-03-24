#!/bin/bash
set -euo pipefail

VM_IP="20.115.21.70"
VM_USER="Jreeder5029"
DOMAIN="comms.reeder-systems.com"
APP_DIR="/home/${VM_USER}/command-comms"
SSH_KEY_FILE=$(mktemp)
ENV_TMP_FILE=$(mktemp)

cleanup() {
  rm -f "$SSH_KEY_FILE" "$ENV_TMP_FILE"
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PEM_FILE="${PROJECT_DIR}/attached_assets/commandcomms-key_1774361622787.pem"

if [ -f "$PEM_FILE" ]; then
  cp "$PEM_FILE" "$SSH_KEY_FILE"
elif [ -n "${AZURE_SSH_KEY:-}" ]; then
  printf '%s\n' "-----BEGIN RSA PRIVATE KEY-----" > "$SSH_KEY_FILE"
  echo "$AZURE_SSH_KEY" | sed 's/-----BEGIN RSA PRIVATE KEY----- //;s/ -----END RSA PRIVATE KEY-----//' | tr ' ' '\n' >> "$SSH_KEY_FILE"
  printf '%s\n' "-----END RSA PRIVATE KEY-----" >> "$SSH_KEY_FILE"
else
  echo "ERROR: No SSH key found (no PEM file and AZURE_SSH_KEY secret not set)"
  exit 1
fi
chmod 600 "$SSH_KEY_FILE"

SSH_CMD="ssh -i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30"
SCP_CMD="scp -i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30"

echo "=== Command Comms — Remote Deployment ==="
echo "Target: ${VM_USER}@${VM_IP}"
echo "App dir: ${APP_DIR}"
echo "Domain:  ${DOMAIN}"
echo ""

echo "[1/8] Testing SSH connection..."
$SSH_CMD ${VM_USER}@${VM_IP} "echo 'SSH connection successful'; uname -a"

echo ""
echo "[2/8] Running server setup (Node.js, nginx, PM2, certbot, firewall)..."
$SSH_CMD ${VM_USER}@${VM_IP} "sudo SKIP_LOCAL_PG=1 bash -s" < "${SCRIPT_DIR}/setup-server.sh" || {
  echo "WARNING: Setup script had issues, continuing..."
}

echo ""
echo "[3/8] Syncing application code via rsync..."
rsync -az --delete \
  -e "ssh -i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  --exclude node_modules \
  --exclude .env \
  --exclude client/node_modules \
  --exclude client/dist \
  --exclude .git \
  --exclude attached_assets \
  --exclude desktop-app \
  --exclude android-native \
  --exclude android-app \
  --exclude .local \
  --exclude .replit \
  --exclude replit.nix \
  "${PROJECT_DIR}/" "${VM_USER}@${VM_IP}:${APP_DIR}/"
echo "  Code synced"

echo ""
echo "[4/8] Writing production .env file..."
cat > "$ENV_TMP_FILE" <<ENVFILE
NODE_ENV=production
PORT=3001
DATABASE_URL=${AZURE_DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
AZURE_SPEECH_KEY=${AZURE_SPEECH_KEY}
AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-eastus}
AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY}
AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT}
AZURE_OPENAI_DEPLOYMENT=${AZURE_OPENAI_DEPLOYMENT}
AUDIO_RELAY_PORT=5100
AUDIO_RELAY_HOST=${DOMAIN}
RADIO_TRANSPORT_MODE=custom-radio
RADIO_USE_TLS=true
AI_DISPATCHER_VOICE=en-US-GuyNeural
CAD_URL=${CAD_URL:-}
CAD_API_KEY=${CAD_API_KEY:-}
ENVFILE
$SCP_CMD "$ENV_TMP_FILE" "${VM_USER}@${VM_IP}:${APP_DIR}/.env"
$SSH_CMD ${VM_USER}@${VM_IP} "chmod 600 ${APP_DIR}/.env"
echo "  .env written and secured"

echo ""
echo "[5/8] Installing dependencies and building frontend..."
$SSH_CMD ${VM_USER}@${VM_IP} bash <<REMOTE_SCRIPT
set -euo pipefail
cd ${APP_DIR}
echo "  Installing backend dependencies..."
npm install --production
echo "  Installing frontend dependencies..."
cd client
npm install
echo "  Building frontend..."
npm run build
cd ..
echo "  Build complete"
REMOTE_SCRIPT

echo ""
echo "[6/8] Configuring nginx with SSL..."
$SSH_CMD ${VM_USER}@${VM_IP} bash <<REMOTE_SCRIPT
set -euo pipefail

if [ -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ]; then
  echo "  SSL certificate already exists, using full SSL config..."
  sudo cp ${APP_DIR}/deploy/nginx.conf /etc/nginx/sites-available/command-comms
else
  echo "  No SSL cert yet, using pre-SSL config..."
  sudo cp ${APP_DIR}/deploy/nginx-pre-ssl.conf /etc/nginx/sites-available/command-comms
fi

sudo sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" /etc/nginx/sites-available/command-comms
sudo ln -sf /etc/nginx/sites-available/command-comms /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
echo "  nginx configured for ${DOMAIN}"

if [ ! -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ]; then
  echo "  Requesting SSL certificate..."
  sudo certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@reeder-systems.com || {
    echo "  WARNING: certbot failed — SSL may need manual setup"
  }
fi
REMOTE_SCRIPT

echo ""
echo "[7/8] Starting application with PM2..."
$SSH_CMD ${VM_USER}@${VM_IP} bash <<REMOTE_SCRIPT
set -euo pipefail
cd ${APP_DIR}
if pm2 describe command-comms &>/dev/null; then
  echo "  Restarting existing PM2 process..."
  pm2 restart deploy/ecosystem.config.cjs
else
  echo "  Starting new PM2 process..."
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save
echo "  PM2 status:"
pm2 status
REMOTE_SCRIPT

echo ""
echo "[8/8] Verifying deployment..."
sleep 5
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ]; then
  echo "  SUCCESS: https://${DOMAIN}/ returned HTTP ${HTTP_STATUS}"
else
  echo "  WARNING: https://${DOMAIN}/ returned HTTP ${HTTP_STATUS}"
  echo "  The app may still be starting up. Check with: ssh ${VM_USER}@${VM_IP} 'pm2 logs'"
fi

echo ""
echo "=== Remote Deployment Complete ==="
echo "App URL: https://${DOMAIN}"
echo ""
echo "Useful commands (run via SSH):"
echo "  pm2 logs command-comms    — View application logs"
echo "  pm2 restart command-comms — Restart the application"
echo "  pm2 status                — Check PM2 process status"
