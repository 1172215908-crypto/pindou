#!/bin/bash
# 双击本文件 → 自动把「拼豆图纸生成器」发布到公网，手机扫码/点链接即可用。
# 保持这个终端窗口开着 = 服务运行中；关掉窗口或按 Control+C = 停止。
cd "$(dirname "$0")" || exit 1
PORT=8123
LOG=/tmp/pindou_tunnel.log

pkill -f "http.server $PORT" 2>/dev/null
pkill -f "nokey@localhost.run" 2>/dev/null
rm -f "$LOG"
sleep 1

python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
HTTP_PID=$!
ssh -T -n \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/tmp/pindou_known_hosts \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -R 80:localhost:$PORT nokey@localhost.run > "$LOG" 2>&1 &
SSH_PID=$!
trap 'kill $HTTP_PID $SSH_PID 2>/dev/null' EXIT INT TERM

URL=""
for _ in $(seq 1 25); do
  URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo
if [ -z "$URL" ]; then
  echo "❌ 没能拿到公网地址（多半是网络问题）。重新双击本文件再试一次。"
  exit 1
fi
echo "📱 手机访问：$URL"
echo "$URL" | pbcopy
echo "   （地址已复制到剪贴板，微信发给「文件传输助手」就能在安卓上点开）"
echo
echo "⚠️ 这个窗口别关：关掉 = 网址失效。电脑睡眠也会断开。"
echo "⏹  停止服务：关掉本窗口，或按 Control+C"
echo

open "$URL"
wait $SSH_PID
