#!/bin/bash
# Boots a user's Swarm VM: locks down the network and secrets, then keeps the companion running.
#   SWARM_SERVER        the Swarm server URL (set by the server when it creates the VM)
#   /run/swarm/token    this VM's pairing token (written by the provider when the VM is created)
set -u
SERVER="${SWARM_SERVER:?SWARM_SERVER is not set}"
TOKEN=/run/swarm/token

# sudo (used to run the Bots' shells as 'agent') needs the hostname to resolve.
grep -q "$(hostname)" /etc/hosts || echo "127.0.1.1 $(hostname)" >> /etc/hosts

# The token is readable only by the companion's user, never by the Bots' shells.
chown swarm:swarm "$TOKEN" && chmod 600 "$TOKEN"
# The volume holds the Bots' files and browser profiles; keep it owned by their user.
mkdir -p /home/agent/bots /home/agent/profiles && chown -R agent:agent /home/agent

# Egress: Bots can browse the internet, but not the cloud metadata service or the provider's private network.
# (Fly's internal DNS resolver, fdaa::3, stays reachable.)
iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT 2>/dev/null || true
# Replies to connections that came in (e.g. `fly ssh` for admins) are allowed; new outbound ones are not.
ip6tables -A OUTPUT -d fdaa::/16 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::3 -p udp --dport 53 -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::3 -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::/16 -j REJECT 2>/dev/null || true

# Keep the companion running. Each start fetches the version the server currently serves
# (runtime updates without rebuilding this image), falling back to the copy in the image.
while true; do
  # Keep the .mjs suffix so Node can validate the downloaded ES module before installing it.
  if curl -fsSL --max-time 20 "$SERVER/api/companion/script" -o /tmp/companion.new.mjs && node --check /tmp/companion.new.mjs; then
    install -o swarm -m 644 /tmp/companion.new.mjs /var/lib/swarm/companion.mjs
  fi
  JS=/var/lib/swarm/companion.mjs; [ -f "$JS" ] || JS=/opt/swarm/companion.mjs
  runuser -u swarm -- node "$JS" --server "$SERVER" --token-file "$TOKEN" --multi --run-as agent --agent-home /home/agent --data-dir /var/lib/swarm/data
  code=$?
  # 1 = the server refused this VM (token revoked): back off instead of hammering it.
  if [ "$code" = 1 ]; then sleep 60; else sleep 2; fi
done
