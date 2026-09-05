#!/usr/bin/env bash
# gen-ip-cert.sh —— DevHub ECS Relay 无域名 IP TLS：自签 IP SAN 证书一键生成（U1 已裁决，docs/21 §1.1）
#
# 用法（在 ECS 上执行，需 openssl）：
#   sudo ./gen-ip-cert.sh                        # 默认 EC P-256，输出到 /etc/devhub-relay/tls
#   sudo KEY_ALGO=rsa ./gen-ip-cert.sh           # RSA 4096
#   sudo OUT_DIR=/tmp/tls ./gen-ip-cert.sh       # 自定义输出目录
#   sudo DAYS=90 IP=59.110.149.11 ./gen-ip-cert.sh
#
# 产出：
#   server.key / server.crt          —— Caddy/Nginx 443 装载（server.crt = 叶证书，含 IP SAN）
#   ca.key / ca.crt                  —— 自签根 CA（ca.crt 分发给客户端 curl --cacert / relayClient ca 装载）
#   spki-sha256.txt                  —— SPKI SHA-256 指纹，格式 sha256/{hex}（客户端 pinning 用，docs/19 §10.2/§10.3）
#   cert-sha256.txt                  —— 证书整体 SHA-256 指纹（仅 openssl x509 人工核对用，勿与 pin 混用）
#
# 有效期：默认 90 天（DAYS 可改）。续期：到期前重新执行本脚本生成新证书（新密钥对），
# 按 docs/19 §10.4 双指纹窗口流程轮换——客户端同时配置旧+新两枚 SPKI 指纹，服务端切载新证书，
# 观察期后收敛回单指纹。指纹配置是数据不是代码，不依赖 App 发版。
#
# 目标平台：Linux ECS（Ubuntu 24，docs/19 §5.1）。Windows Git Bash 上调试运行需先
# `export MSYS2_ARG_CONV_EXCL="*"`（否则 -subj 的 /CN=... 会被 MSYS 误转成 Windows 路径）。
#
# 红线（约束 #13 同款）：server.key / ca.key 仅存 ECS（0600），绝不入仓库/日志/审计；
# 指纹是公开物料，可入文档与客户端配置。

set -euo pipefail

IP="${IP:-59.110.149.11}"
DAYS="${DAYS:-90}"
KEY_ALGO="${KEY_ALGO:-ec}"          # ec | rsa
OUT_DIR="${OUT_DIR:-/etc/devhub-relay/tls}"

CA_KEY="${CA_KEY:-}"                # 复用已有 CA：传入 ca.key 路径则不新建 CA
CA_CERT="${CA_CERT:-}"              # 同上，传 ca.crt 路径

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl 未安装" >&2; exit 1; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

# ---- 1. 根 CA（自签；若未复用已有 CA） --------------------------------------
if [ -n "$CA_KEY" ] && [ -n "$CA_CERT" ]; then
  echo "==> 复用已有 CA：$CA_CERT"
else
  CA_KEY="$OUT_DIR/ca.key"
  CA_CERT="$OUT_DIR/ca.crt"
  if [ "$KEY_ALGO" = "rsa" ]; then
    openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  else
    openssl ecparam -name prime256v1 -genkey -noout -out "$CA_KEY" 2>/dev/null
  fi
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days "$DAYS" \
    -subj "/CN=DevHub Relay Root CA (self-signed, no domain)" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$CA_CERT"
  echo "==> 自签根 CA 已生成：$CA_CERT"
fi

# ---- 2. 服务端叶证书密钥 + CSR（SAN 含 IP，这是 IP TLS 的硬要求） -----------
if [ "$KEY_ALGO" = "rsa" ]; then
  openssl genrsa -out "$OUT_DIR/server.key" 4096 2>/dev/null
else
  openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_DIR/server.key" 2>/dev/null
fi

openssl req -new -key "$OUT_DIR/server.key" \
  -subj "/CN=devhub-relay-ip" -out "$OUT_DIR/server.csr"

# SAN 扩展落临时 ext 文件（不用进程替换：openssl 原生二进制读不了 /dev/fd，Windows Git Bash 亦可用）
cat > "$OUT_DIR/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP
EOF

openssl x509 -req -in "$OUT_DIR/server.csr" \
  -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -days "$DAYS" -sha256 \
  -extfile "$OUT_DIR/server.ext" \
  -out "$OUT_DIR/server.crt" 2>/dev/null
rm -f "$OUT_DIR/server.ext"

# ---- 3. 指纹输出（pinning 消费形态 sha256/{hex}，docs/19 §10） --------------
# SPKI 指纹 = CertificatePinner / tls.checkServerIdentity 的比对对象（不是证书整体指纹）
SPKI_DER="$OUT_DIR/.spki.der"
openssl x509 -in "$OUT_DIR/server.crt" -pubkey -noout \
  | openssl pkey -pubin -outform DER -out "$SPKI_DER" 2>/dev/null
SPKI_HEX="$(openssl dgst -sha256 -hex < "$SPKI_DER" | awk '{print $NF}')"
rm -f "$SPKI_DER"
printf 'sha256/%s\n' "$SPKI_HEX" > "$OUT_DIR/spki-sha256.txt"

CERT_HEX="$(openssl x509 -in "$OUT_DIR/server.crt" -noout -fingerprint -sha256 \
  | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f')"
printf 'sha256/%s\n' "$CERT_HEX" > "$OUT_DIR/cert-sha256.txt"

chmod 600 "$OUT_DIR/server.key" "$OUT_DIR/ca.key"

# ---- 4. 摘要报告（零私钥内容，可粘贴到部署记录） ----------------------------
EXPIRY="$(openssl x509 -in "$OUT_DIR/server.crt" -noout -enddate | cut -d= -f2)"
cat <<EOF

============================================================
 自签 IP 证书已生成（无域名 IP TLS，U1 已裁决 docs/21 §1.1）
  输出目录   : $OUT_DIR
  IP SAN     : $IP
  有效期     : $DAYS 天（至 $EXPIRY）
  证书       : $OUT_DIR/server.crt
  私钥       : $OUT_DIR/server.key（0600，绝不外传）
  CA 证书    : $OUT_DIR/ca.crt（分发客户端：curl --cacert / relayClient ca 装载）
  ------------------------------------------------------------
  SPKI 指纹（客户端 pinning 用）:
    $(cat "$OUT_DIR/spki-sha256.txt")
  证书整体指纹（仅人工核对，勿用于 pin）:
    $(cat "$OUT_DIR/cert-sha256.txt")
  ------------------------------------------------------------
  续期提示：本证书 $DAYS 天后过期（过期 = 全链路 TLS 握手失败，
  即验收三拒之「过期证书被拒」，docs/20 §3 R-B9）。到期前执行：
    1) 重新运行本脚本生成新证书（新密钥对）
    2) 客户端指纹配置写入 旧+新 双指纹（docs/19 §10.4 双指纹窗口）
    3) Caddy/Nginx 切载新证书（reload）
    4) 观察期后重分发仅含新指纹的配置并收敛回单指纹
  浏览器访问 https://$IP 会出告警——自签 IP 证书不受系统默认
  信任，属预期（docs/19 §10.5），绝不作为「证书有问题」的判据。
============================================================
EOF
