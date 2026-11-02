#!/usr/bin/env bash
# Runs inside a node container: installs packages the way Pi does, audits the npm root, then starts Pi.
# usage: scenario.sh <step>...
#   npm:<package>[@version]  `pi install` from the registry (a version pins it, as Pi does)
#   PACKED:<folder>          npm install /packages/<packed tarball> with Pi's own npm arguments, then register it
#   UNPIN                    drop version pins, as if every package had been installed without a version
#   UPDATE                   `pi update --extensions`
# Mounts: /check (this folder), /packages (tarballs from `pnpm pack`, optional). PI_VERSION selects the host.
set -u
PI_VERSION=${PI_VERSION:-1.4.0}
AGENT=/root/.pi/agent
ROOT=$AGENT/npm
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1
npm install -g "@earendil-works/pi-coding-agent@$PI_VERSION" >/tmp/host.log 2>&1 || { echo "HOST INSTALL FAIL"; tail -3 /tmp/host.log; exit 1; }
HOST=$(npm root -g)/@earendil-works/pi-coding-agent
mkdir -p $AGENT && echo '{"extensions":["-builtin:mcp"],"defaultTools":["+codemode"]}' > $AGENT/settings.json

for step in "$@"; do
  case "$step" in
    PACKED:*)
      name=${step#PACKED:}
      tarball=$(ls /packages/buyong-"$name"-*.tgz 2>/dev/null | head -1)
      [ -n "$tarball" ] || { echo "PACKED MISSING $name"; continue; }
      npm install "$tarball" --prefix $ROOT --legacy-peer-deps >/tmp/packed.log 2>&1 || { echo "PACKED FAIL $name"; tail -3 /tmp/packed.log; }
      node -e 'const f=process.argv[1],s=require(f),p="npm:@buyong/"+process.argv[2];s.packages=(s.packages||[]).filter(x=>x!==p&&!x.startsWith(p+"@"));s.packages.push(p);require("fs").writeFileSync(f,JSON.stringify(s,null,2))' $AGENT/settings.json "$name";;
    UNPIN)
      node -e '
        const fs=require("fs"),[settings,root]=process.argv.slice(1),s=require(settings),n=require(root+"/package.json");
        s.packages=s.packages.map(p=>p.replace(/^(npm:(@[^/]+\/)?[^@]+)@.*$/,"$1"));
        for(const k of Object.keys(n.dependencies))n.dependencies[k]="^"+require(root+"/node_modules/"+k+"/package.json").version;
        fs.writeFileSync(settings,JSON.stringify(s,null,2));fs.writeFileSync(root+"/package.json",JSON.stringify(n,null,2))' $AGENT/settings.json $ROOT;;
    UPDATE)
      pi update --extensions >/tmp/update.log 2>&1 || { echo "UPDATE FAIL"; tail -3 /tmp/update.log; };;
    *)
      pi install "$step" >/tmp/install.log 2>&1 || { echo "INSTALL FAIL $step"; tail -3 /tmp/install.log; };;
  esac
done

cd $ROOT
echo "installed: $(node -e 'const d=require("./package.json").dependencies;console.log(Object.keys(d).map(k=>k.replace("@buyong/","")+"@"+require("./node_modules/"+k+"/package.json").version).join(" "))')"
node /check/check-installed.mjs $ROOT "$HOST" 2>&1

mkdir -p /project && cd /project
tmux new-session -d -s pi -x 400 -y 80 "pi; echo EXIT=\$?; sleep 600"; sleep 45
tmux capture-pane -t pi -p -S -400 | grep -v '^\s*$' > /tmp/screen.txt
extensions=$(awk '/\[Extensions\]/{f=1;next} f&&/^ *\[|^ [a-z]+ (not found|installed)/{f=0} f' /tmp/screen.txt | tr -d '\n ')
grep -E "Error:|Failed to load" /tmp/screen.txt | grep -v "Linux is not supported" | head -3 | cut -c1-250 | sed 's/^/  START-ERR: /'
echo "STARTED: $(grep -q "v$PI_VERSION" /tmp/screen.txt && ! grep -q 'EXIT=' /tmp/screen.txt && echo yes || echo NO)"
for k in $(node -p "Object.keys(require('$ROOT/package.json').dependencies).join(' ')"); do
  case "$k" in
    @buyong/pi-codex) for c in auto-review computer-use fast-mode image-gen memory; do echo "$extensions" | grep -q "pi-codex-$c" || echo "NOT LOADED: $k/$c"; done;;
    *) echo "$extensions" | grep -q "$k" || echo "NOT LOADED: $k";;
  esac
done
# Linux containers cannot run Computer Use, and tmux reports its own key setting.
echo "SCREEN ERRORS:"; grep -iE "error|warn|fail|cannot|invalid" /tmp/screen.txt | grep -vE "Linux is not supported|tmux extended-keys|codex-cua: .*error|No models available|/login" | sed 's/^/  /' | cut -c1-300
timeout 30 pi --mode rpc </dev/null >/tmp/rpc.out 2>/tmp/rpc.err
echo "RPC NOTIFY:"; grep '"notify"' /tmp/rpc.out | grep -v "Linux is not supported" | cut -c1-300 | sed 's/^/  /'; grep -iE "error|warn" /tmp/rpc.err | sed 's/^/  stderr: /' | head
