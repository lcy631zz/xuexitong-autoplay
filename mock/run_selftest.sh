#!/usr/bin/env bash
# 自测：用真实无头浏览器跑 mock（三层 iframe + 弹题），验证自动下一节 + 弹题暴力作答
set -e

AB="/c/Users/Eintv631/.workbuddy/binaries/node/workspace/node_modules/agent-browser/bin/agent-browser-win32-x64.exe"
PY="/c/Users/Eintv631/.workbuddy/binaries/python/versions/3.13.12/python.exe"
DIR="/c/Users/Eintv631/WorkBuddy/2026-10-11-22-59-44/chaoxing-autoplay"
PORT=8137

# 起本地同域静态服务器（避开 file:// 的 fetch / 跨域限制）
"$PY" -m http.server "$PORT" --directory "$DIR" >/tmp/cx_http.log 2>&1 &
SRV=$!
sleep 1.5

"$AB" open "http://127.0.0.1:$PORT/mock/index.html"

# 注入用户脚本（同域 fetch 文件，塞进 <script> 执行）
"$AB" eval "(async()=>{const r=await fetch('/chaoxing-auto-next.user.js');const t=await r.text();const s=document.createElement('script');s.textContent=t;document.documentElement.appendChild(s);return 'injected:'+t.length;})()"

# 等看门狗建面板
"$AB" wait 2500

# 点「开始自动」
"$AB" eval "var b=document.querySelector('#cx-autonext-panel #cx-toggle');if(b){b.click();'started'}else{'NO_PANEL'}"

# 等整轮跑完（4 节，每节含弹题暴力作答）
"$AB" wait 80000

# 读取结果
"$AB" eval "(function(){try{var f=document.getElementById('iframe');var vframe=f.contentDocument.getElementById('vframe');var l2win=vframe.contentDocument.defaultView;var st=(typeof l2win.__state==='function')?l2win.__state():null;return JSON.stringify({activated:window.__activated,panelLog:(document.querySelector('#cx-autonext-panel #cx-log')||{innerText:'(no panel)'}).innerText,deepest:st});}catch(e){return 'ERR:'+e;}})()"

"$AB" screenshot "$DIR/mock/selftest-quiz.png"
"$AB" close
kill $SRV 2>/dev/null || true
