#!/bin/bash
# Boots a user's Grokbot VM: locks down the network and secrets, then keeps the companion running.
#   GROKBOT_SERVER        the Grokbot server URL (set by the server when it creates the VM)
#   /run/grokbot/token    this VM's pairing token (written by the provider when the VM is created)
set -u
SERVER="${GROKBOT_SERVER:?GROKBOT_SERVER is not set}"
TOKEN=/run/grokbot/token

# sudo (used to run the Bots' shells as 'agent') needs the hostname to resolve.
grep -q "$(hostname)" /etc/hosts || echo "127.0.1.1 $(hostname)" >> /etc/hosts

# The token is readable only by the companion's user, never by the Bots' shells.
chown grokbot:grokbot "$TOKEN" && chmod 600 "$TOKEN"
# The volume holds the Bots' files and browser profiles; keep it owned by their user.
mkdir -p /home/agent/bots /home/agent/profiles && chown -R agent:agent /home/agent

# Egress: Bots can browse the internet, but not the cloud metadata service or the provider's private network.
# (Fly's internal DNS resolver, fdaa::3, stays reachable.)
iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::3 -p udp --dport 53 -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::3 -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::/16 -j REJECT 2>/dev/null || true

# Keep the companion running. Each start fetches the version the server currently serves
# (runtime updates without rebuilding this image), falling back to the copy in the image.
while true; do
  if curl -fsSL --max-time 20 "$SERVER/api/companion/script" -o /tmp/companion.mjs.new && node --check /tmp/companion.mjs.new; then
    install -o grokbot -m 644 /tmp/companion.mjs.new /var/lib/grokbot/companion.mjs
  fi
  JS=/var/lib/grokbot/companion.mjs; [ -f "$JS" ] || JS=/opt/grokbot/companion.mjs
  runuser -u grokbot -- node "$JS" --server "$SERVER" --token-file "$TOKEN" --multi --run-as agent --agent-home /home/agent --data-dir /var/lib/grokbot/data
  code=$?
  # 1 = the server refused this VM (token revoked): back off instead of hammering it.
  if [ "$code" = 1 ]; then sleep 60; else sleep 2; fi
done
