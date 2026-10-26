#!/usr/bin/env bash
# 自测（多视频节）：验证「一节里有多个视频」时，脚本会逐个看完再切下一节，
# 而不是看完第一个就切走。流程：3.1(两段视频) -> 3.2(单视频，末节) -> 自动结束。
set -e

AB="/c/Users/Eintv631/.workbuddy/binaries/node/workspace/node_modules/agent-browser/bin/agent-browser-win32-x64.exe"
PY="/c/Users/Eintv631/.workbuddy/binaries/python/versions/3.13.12/python.exe"
DIR="/c/Users/Eintv631/WorkBuddy/2026-10-11-22-59-44/chaoxing-autoplay"
PORT=8141

"$PY" -m http.server "$PORT" --directory "$DIR" >/tmp/cx_http_multi.log 2>&1 &
SRV=$!
sleep 1.5

"$AB" open "http://127.0.0.1:$PORT/mock/index_multi.html"

# 注入用户脚本
"$AB" eval "(async()=>{const r=await fetch('/chaoxing-auto-next.user.js');const t=await r.text();const s=document.createElement('script');s.textContent=t;document.documentElement.appendChild(s);return 'injected:'+t.length;})()"

"$AB" wait 2500

# 点「开始自动」
"$AB" eval "var b=document.querySelector('#cx-autonext-panel #cx-toggle');if(b){b.click();'started'}else{'NO_PANEL'}"

# 多视频节(2×10s) + 切章延迟 + 单视频节(10s) + 末节结束，留足余量
"$AB" wait 55000

# 读取结果
"$AB" eval "(function(){try{return JSON.stringify({activated:window.__activated,switchStates:window.__switchStates||[],panelLog:(document.querySelector('#cx-autonext-panel #cx-log')||{innerText:'(no panel)'}).innerText});}catch(e){return 'ERR:'+e;}})()"

"$AB" screenshot "$DIR/mock/selftest-multi.png"
"$AB" close
kill $SRV 2>/dev/null || true
