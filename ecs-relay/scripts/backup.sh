#!/usr/bin/env bash
# backup.sh —— relay.db 每日滚动备份（docs/19 §5.6：sqlite3 .backup 滚动 7 份；缓存可丢，重建即回填）
#
# 安装（二选一）：
#   A) systemd timer：sudo cp deploy/devhub-relay-backup.{service,timer} /etc/systemd/system/
#      && sudo systemctl daemon-reload && sudo systemctl enable --now devhub-relay-backup.timer
#   B) cron：sudo crontab -e 追加
#      15 3 * * * /opt/devhub-relay/scripts/backup.sh >> /var/log/devhub-relay-backup.log 2>&1
#
# 红线：备份文件含 relay.db 全量（sha256 哈希与审计）——0600 权限，绝不离机分发。

set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/devhub-relay/relay.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/devhub-relay/backups}"
KEEP="${KEEP:-7}"   # 滚动保留份数（docs/19 §5.6）

command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR: sqlite3 CLI 未安装（apt install sqlite3）" >&2; exit 1; }
[ -f "$DB_PATH" ] || { echo "ERROR: $DB_PATH 不存在" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d)"
TARGET="$BACKUP_DIR/relay-$STAMP.db"
# .backup 在线快照（WAL 一致性由 sqlite3 .backup 保证，无需停服）
sqlite3 "$DB_PATH" ".backup '$TARGET'"
chmod 600 "$TARGET"

# 同日重跑覆盖当日快照；滚动删除超限旧份（按文件名排序 = 时间序）
ls -1 "$BACKUP_DIR"/relay-????????.db 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

echo "backup ok: $TARGET ($(date -Is))"
