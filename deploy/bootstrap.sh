#!/usr/bin/env bash
#
# One-shot provisioning for the drivers-ed lesson bot on a fresh Ubuntu 24.04
# server. Safe to re-run: every step is idempotent.
#
#   sudo bash deploy/bootstrap.sh
#
# It does NOT install your secrets. After this finishes, upload your .env
# (README §3.4) and start the service.
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jaydenaleung/drivers-ed.git}"
APP_DIR="/opt/drivers-ed"
APP_USER="driversed"
DOMAIN="${DOMAIN:-drivers-ed.duckdns.org}"

say() { printf '\n=== %s ===\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "0. Checking outbound port 587 BEFORE anything else"
# If the host blocks SMTP submission the bot can never send a claim email, and
# every later step would appear to succeed while doing nothing useful.
if timeout 5 bash -c 'cat < /dev/null > /dev/tcp/smtp.gmail.com/587' 2>/dev/null; then
  echo "port 587 is OPEN — good"
else
  echo "port 587 is BLOCKED on this host." >&2
  echo "The bot cannot send claim email here. Stop and use a different provider." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "1. System packages"
export DEBIAN_FRONTEND=noninteractive

# A freshly booted Ubuntu VM runs unattended-upgrades, which holds the dpkg
# lock for several minutes. Without this, any apt command in the meantime dies
# with "Could not get lock /var/lib/dpkg/lock-frontend" and provisioning stops
# halfway. Setting the timeout globally (rather than per-command) also covers
# apt calls made by scripts we invoke, such as NodeSource's installer.
mkdir -p /etc/apt/apt.conf.d
echo 'DPkg::Lock::Timeout "900";' > /etc/apt/apt.conf.d/99-drivers-ed-lock-timeout

if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
  echo "another package manager (probably unattended-upgrades) holds the dpkg lock."
  echo "waiting for it — this can take a few minutes on a new server..."
fi

apt-get update -qq
apt-get install -y -qq curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "installing Node 22 (Ubuntu's own package is too old)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "node $(node -v)"

# ---------------------------------------------------------------------------
say "2. Unprivileged service user"
# Deliberately NOT --home "$APP_DIR". Making the app directory the service
# user's home hands that user ownership of its own source code, which is both a
# weaker security posture and the reason git refuses to run as root here
# ("dubious ownership", CVE-2022-24765). The code stays root-owned and
# read-only to the service; only data/ is writable.
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group --no-create-home --home /nonexistent "$APP_USER"
  echo "created $APP_USER"
else
  echo "$APP_USER already exists"
  # Repair an earlier run that pointed the home at $APP_DIR.
  if [[ "$(getent passwd "$APP_USER" | cut -d: -f6)" == "$APP_DIR" ]]; then
    usermod -d /nonexistent "$APP_USER"
    echo "moved its home off $APP_DIR"
  fi
fi

# ---------------------------------------------------------------------------
say "3. Application code"
# Reclaim the tree for root if a previous run (or a manual clone) left it owned
# by the service user, otherwise git refuses to touch it.
if [[ -d "$APP_DIR" ]]; then
  chown -R root:root "$APP_DIR"
fi
# Belt and braces for any other ownership surprise.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard --quiet origin/main
  echo "updated existing checkout"
else
  # $APP_DIR may already exist (e.g. a manual clone), so stage the clone in /tmp
  # and copy in, rather than requiring an empty target.
  git clone --quiet "$REPO_URL" /tmp/drivers-ed-clone
  cp -a /tmp/drivers-ed-clone/. "$APP_DIR/"
  rm -rf /tmp/drivers-ed-clone
  echo "cloned $REPO_URL"
fi

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

# The service only ever writes to data/ (the SQLite file and its WAL sidecars).
# Everything else stays root-owned and world-readable, so a compromised bot
# cannot rewrite its own code.
mkdir -p "$APP_DIR/data"
chown -R root:root "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"
chmod 755 "$APP_DIR"

# .env, if already uploaded, must stay readable by the service and nobody else.
if [[ -f "$APP_DIR/.env" ]]; then
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "secured existing .env"
fi

# ---------------------------------------------------------------------------
say "4. systemd service"
cp "$APP_DIR/deploy/drivers-ed.service" /etc/systemd/system/drivers-ed.service
systemctl daemon-reload
systemctl enable drivers-ed >/dev/null
echo "installed and enabled (not started — it needs .env first)"

# ---------------------------------------------------------------------------
say "5. Caddy for HTTPS"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sed -i "s|^drivers-ed\.duckdns\.org {|${DOMAIN} {|" /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl reload caddy || systemctl restart caddy
echo "Caddy serving ${DOMAIN}"

# ---------------------------------------------------------------------------
say "6. Firewall"
# Only SSH and web. The bot's own port 8080 stays on loopback.
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ufw --force enable >/dev/null || true
  echo "ufw: SSH, 80, 443 allowed"
fi

# ---------------------------------------------------------------------------
say "Done — one step left"
cat <<EOF

The service is installed but NOT started, because it has no secrets yet.

  1. Upload your .env  (README section 3.4), then:

       sudo chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
       sudo chmod 600 ${APP_DIR}/.env

     (Or just re-run this script — it secures an existing .env for you.)

  2. Confirm it loaded (prints key names and lengths, never the secrets):

       cd ${APP_DIR} && npm run env-check

  3. Prove every integration works FROM THIS SERVER:

       cd ${APP_DIR} && npm run preflight -- --skip-haiku

  4. Start it:

       sudo systemctl start drivers-ed
       sudo systemctl status drivers-ed
       journalctl -u drivers-ed -f

  5. Open https://${DOMAIN} and log in.

Leave DRY_RUN=true until step 3 passes and you have watched one real poll.

EOF
