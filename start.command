#!/bin/bash
# macOS / Linux：双击或在终端运行  ./start.command
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装 Node 18 或更高版本： https://nodejs.org"
  read -n 1 -s -r -p "按任意键退出"
  exit 1
fi
(sleep 2; (command -v open >/dev/null && open http://localhost:8787/) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8787/)) >/dev/null 2>&1 &
node server.js
