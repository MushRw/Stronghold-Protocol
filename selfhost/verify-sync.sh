#!/usr/bin/env bash
# Full verification of the upstream sync pipeline, end to end.
set -u
NODE="C:/Users/16094/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PY="C:/Users/16094/.workbuddy/binaries/python/versions/3.13.12/python.exe"
cd E:/code/protocol/Stronghold-Protocol || exit 1
OUT=E:/tmp/sp-sync4

echo "===== 1. 生成同步产物 ====="
"$NODE" tools/selfhost-sync.mjs sgangss/master --out "$OUT" 2>&1 | tail -12

echo
echo "===== 2. 处置已知冲突（4 处，均已逐条确认性质）====="
for f in public/dev/game-mock.js public/js/screens/loadout.js public/js/ui/shopBar.js; do
  git show "sgangss/master:$f" > "$OUT/$f"
  echo "  theirs <- $f"
done
cp data/assets.json "$OUT/data/assets.json"
echo "  ours   <- data/assets.json"
find "$OUT" -name '*.conflict' -delete
echo "  残留冲突标记: $(grep -rl '^<<<<<<<' "$OUT" 2>/dev/null | wc -l) 个文件"

echo
echo "===== 3. 关键文件是否为我们的版本（keep 生效）====="
echo "  server/data.js 依赖 data-node.js: $(grep -c "from './data-node.js'" "$OUT/server/data.js")"
echo "  worker/index.js 存在: $(test -f "$OUT/worker/index.js" && echo yes || echo NO)"
echo "  public/js/screens/history.js 存在: $(test -f "$OUT/public/js/screens/history.js" && echo yes || echo NO)"
echo "  public/js/audio.js 含语音: $(grep -c 'voice(charId' "$OUT/public/js/audio.js")"

echo
echo "===== 4. 复制到验证目录（node_modules 用目录联接指回主仓库）====="
"$PY" - <<'PYEOF'
import shutil, os, time
src, dst = 'E:/tmp/sp-sync4', '.align-check'
if os.path.exists(dst):
    stale = dst + '.old-' + str(int(time.time()))
    os.rename(dst, stale)
shutil.copytree(src, dst)
print('  复制文件数:', sum(len(f) for _, _, f in os.walk(dst)))
PYEOF
"$NODE" -e "const fs=require('fs');const p='.align-check/node_modules';if(!fs.existsSync(p))fs.symlinkSync('E:/code/protocol/Stronghold-Protocol/node_modules',p,'junction');console.log('  node_modules junction:', fs.existsSync(p)?'ok':'missing')"

echo
echo "===== 5. 打包验证（esbuild 解析 worker 入口可达的全部 import）====="
cd .align-check || exit 1
timeout 420 "$NODE" E:/tmp/bundle-check.mjs 2>&1 | tail -6
