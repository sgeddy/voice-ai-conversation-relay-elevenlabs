#!/usr/bin/env bash
# infra/bootstrap.sh — runs ONCE as EC2 user-data on first boot.
#
# Target: AL2023 ARM (t4g.micro). cloud-init runs this as root.
# Output streams to /var/log/cloud-init-output.log.
#
# What it does:
#   1. dnf update + base tools.
#   2. 2GB swapfile (t4g.micro has only 1GB RAM; tsc build is tight).
#   3. Node.js 20 LTS via NodeSource.
#   4. Caddy 2 static binary + systemd unit (no Docker, no COPR/EPEL gymnastics).
#   5. Clone the repo to /opt/voice-ai, build, install systemd unit + Caddyfile.
#   6. Start Caddy. voice-ai.service is installed but NOT started — operator
#      must populate /etc/voice-ai.env first, then `systemctl enable --now voice-ai`.

set -euxo pipefail

REPO_URL="https://github.com/sgeddy/voice-ai-conversation-relay-elevenlabs.git"
APP_DIR=/opt/voice-ai
APP_USER=voiceai
CADDY_VERSION=2.11.2
CADDY_USER=caddy

# --- 1. base packages --------------------------------------------------------
dnf update -y
dnf install -y git tar gzip libcap

# --- 2. swap (2GB) -----------------------------------------------------------
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

# --- 3. Node 20 via NodeSource ----------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs
fi
node -v
npm -v

# --- 4. Caddy ---------------------------------------------------------------
if ! id "$CADDY_USER" &>/dev/null; then
  useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin --create-home "$CADDY_USER"
fi

if ! command -v caddy >/dev/null; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz" \
    -o /tmp/caddy.tar.gz
  tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy
  chmod +x /usr/local/bin/caddy
  rm /tmp/caddy.tar.gz
  # allow binding 80/443 without root (defense in depth; systemd unit also grants this)
  setcap 'cap_net_bind_service=+ep' /usr/local/bin/caddy
fi

mkdir -p /etc/caddy
chown -R "$CADDY_USER:$CADDY_USER" /var/lib/caddy /etc/caddy

# Caddy systemd unit — adapted from the upstream official unit file.
cat >/etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

# --- 5. App user + clone + build --------------------------------------------
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_DIR"
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi

# Build as APP_USER. NODE_OPTIONS gives tsc enough heap on the 1GB box.
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci && NODE_OPTIONS='--max-old-space-size=768' npm run build"

# Pin GIT_SHA so /healthz reports the right rev to the operator.
GIT_SHA=$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)

# --- 6. Install Caddyfile + voice-ai.service from the repo ------------------
install -m 0644 -o "$CADDY_USER" -g "$CADDY_USER" "$APP_DIR/infra/Caddyfile" /etc/caddy/Caddyfile
install -m 0644 "$APP_DIR/infra/voice-ai.service" /etc/systemd/system/voice-ai.service

# /etc/voice-ai.env: owned by root, mode 600 (contains secrets).
# Don't overwrite if operator already populated it during a re-bootstrap.
if [[ ! -f /etc/voice-ai.env ]]; then
  cat >/etc/voice-ai.env <<EOF
# voice-ai environment file. Loaded by systemd unit (EnvironmentFile=).
# Mode 600, owned by root — secrets live here.
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
SERVICE_ACTIVE=true
DEV_BYPASS_SIGNATURE=false
GIT_SHA=$GIT_SHA

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
BENCH_AGENT_NUMBER=

# LLM (Anthropic default)
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# TTS
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

# STT (Conversation Relay native)
TRANSCRIPTION_PROVIDER=Deepgram

# Public base URL — MUST match what Twilio webhooks are signed against.
PUBLIC_BASE_URL=https://voice-ai.samueleddy.com

# OpenTelemetry (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=
EOF
  chmod 600 /etc/voice-ai.env
  chown root:root /etc/voice-ai.env
fi

# Same template, world-readable, for reference.
install -m 0644 "$APP_DIR/.env.example" /etc/voice-ai.env.example

# --- 7. Enable Caddy. Leave voice-ai disabled until env is populated. -------
systemctl daemon-reload
systemctl enable --now caddy

cat <<'DONE'

================================================================
BOOTSTRAP COMPLETE

Caddy is running and will issue a Let's Encrypt cert for
voice-ai.samueleddy.com on first request to :80.

voice-ai.service is INSTALLED but NOT STARTED.

To finish:
  1. sudo vim /etc/voice-ai.env
     (fill in TWILIO_*, ANTHROPIC_API_KEY, ELEVENLABS_*)
  2. sudo systemctl enable --now voice-ai
  3. sudo journalctl -u voice-ai -f

================================================================
DONE
