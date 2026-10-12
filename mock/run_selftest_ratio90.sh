#!/usr/bin/env bash
# 自测（90% 直接切模式）：点「90%」按钮后再开始，验证它直接切、不等任务点完成
set -e

AB="/c/Users/Eintv631/.workbuddy/binaries/node/workspace/node_modules/agent-browser/bin/agent-browser-win32-x64.exe"
PY="/c/Users/Eintv631/.workbuddy/binaries/python/versions/3.13.12/python.exe"
DIR="/c/Users/Eintv631/WorkBuddy/2026-10-11-22-59-44/chaoxing-autoplay"
PORT=8138

"$PY" -m http.server "$PORT" --directory "$DIR" >/tmp/cx_http2.log 2>&1 &
SRV=$!
sleep 1.5

"$AB" open "http://127.0.0.1:$PORT/mock/index.html"

"$AB" eval "(async()=>{const r=await fetch('/chaoxing-auto-next.user.js');const t=await r.text();const s=document.createElement('script');s.textContent=t;document.documentElement.appendChild(s);return 'injected:'+t.length;})()"

"$AB" wait 2500

# 先切到 90% 模式
"$AB" eval "var b=document.querySelector('#cx-autonext-panel #cx-ratio-90');if(b){b.click();'ratio90'}else{'NO_BTN'}"

# 再点「开始自动」
"$AB" eval "var b=document.querySelector('#cx-autonext-panel #cx-toggle');if(b){b.click();'started'}else{'NO_PANEL'}"

"$AB" wait 70000

"$AB" eval "(function(){try{var f=document.getElementById('iframe');var vframe=f.contentDocument.getElementById('vframe');var l2win=vframe.contentDocument.defaultView;var st=(typeof l2win.__state==='function')?l2win.__state():null;return JSON.stringify({activated:window.__activated,panelLog:(document.querySelector('#cx-autonext-panel #cx-log')||{innerText:'(no panel)'}).innerText,deepest:st});}catch(e){return 'ERR:'+e;}})()"

"$AB" close
kill $SRV 2>/dev/null || true
