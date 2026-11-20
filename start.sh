#!/usr/bin/env bash
# 启动 AIBridge 主服务（Linux / macOS）
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

RED=$'\033[31m'; YELLOW=$'\033[33m'; NC=$'\033[0m'

# ---- 优先用内置 Node（打包时若带了 Linux 版运行时）----
NODE_BIN=""
for cand in "runtime/node/bin/node" "runtime/node-linux/bin/node"; do
  if [ -x "$cand" ]; then
    NODE_BIN="$PWD/$cand"
    echo "使用内置 Node: $NODE_BIN"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "${RED}没有找到 node${NC}"
    echo "  安装 Node.js 18+：https://nodejs.org/"
    echo "  或使用 nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
    exit 1
  fi
  NODE_BIN="$(command -v node)"
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "${RED}Node 版本过低: $("$NODE_BIN" -v)，需要 18 或更高${NC}"
  exit 1
fi

if [ ! -f data/config.json ]; then
  echo "${YELLOW}首次启动，将生成默认配置${NC}"
fi

echo "AIBridge 启动中… ($("$NODE_BIN" -v))"
exec "$NODE_BIN" server.js
