#!/usr/bin/env bash
# M3-A server-side setup — run on ECS 59.110.149.11 as root, AFTER tar upload to /opt/devhub-relay.
# Mirrors ecs-relay/README.md deploy runbook steps 1/3/4 (Node already installed).
set -euo pipefail

# 1) service user + dirs (idempotent)
id devhub-relay >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin devhub-relay
install -d -o devhub-relay -g devhub-relay -m 750 /opt/devhub-relay /var/lib/devhub-relay

# 2) ownership + exec bits on uploaded tree
chown -R devhub-relay:devhub-relay /opt/devhub-relay
find /opt/devhub-relay -name '*.sh' -type f -exec chmod 755 {} +

# 3) deps (zero runtime deps; verifies lockfile integrity)
cd /opt/devhub-relay
runuser -u devhub-relay -- npm install --omit=dev --no-fund --no-audit >/tmp/npm-install.log 2>&1 || { tail -5 /tmp/npm-install.log; exit 1; }

# 4) env file (0600, devhub-relay-owned; registration code generated on-site, never printed)
install -d -m 755 /etc/devhub-relay
if [ ! -f /etc/devhub-relay/env ]; then
  umask 077
  {
    echo "RELAY_REGISTRATION_CODE=$(openssl rand -hex 32)"
    echo "RELAY_DB_PATH=/var/lib/devhub-relay/relay.db"
  } > /etc/devhub-relay/env
fi
chown devhub-relay:devhub-relay /etc/devhub-relay/env
chmod 600 /etc/devhub-relay/env

# 5) systemd units
install -m 644 /opt/devhub-relay/deploy/devhub-relay.service /etc/systemd/system/
install -m 644 /opt/devhub-relay/deploy/devhub-relay-backup.service /etc/systemd/system/
install -m 644 /opt/devhub-relay/deploy/devhub-relay-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now devhub-relay devhub-relay-backup.timer >/dev/null 2>&1

# 6) verify (no credentials echoed)
sleep 2
systemctl is-active devhub-relay
ss -tlnp | grep -E ':8443\b' | head -2
curl -s -o /dev/null -w 'local health HTTP %{http_code}\n' http://127.0.0.1:8443/v1/health
echo SETUP_DONE
