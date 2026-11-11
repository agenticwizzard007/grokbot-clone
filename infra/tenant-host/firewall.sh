#!/bin/sh
# The host is trusted; none of these paths or firewall capabilities are mounted in workloads.
set -eu
rm -f /run/swarm-host/network-ready
iptables -N SWARM-EGRESS 2>/dev/null || iptables -F SWARM-EGRESS
iptables -A SWARM-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Only the desktop companion may initiate its authenticated connection to the tenant app.
# ACCEPT this one flow here: RETURN would still hit Docker's inter-bridge isolation and drop it.
iptables -A SWARM-EGRESS -s 172.31.0.2/32 -d 172.30.0.2/32 -p tcp --dport 8787 -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A SWARM-EGRESS -d "$cidr" -j REJECT
done
iptables -A SWARM-EGRESS -j RETURN
iptables -C DOCKER-USER -j SWARM-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -j SWARM-EGRESS
# A container must not reach services listening on the host's bridge interfaces.
iptables -C INPUT -i br+ -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -I INPUT 1 -i br+ -m conntrack --ctstate NEW -j REJECT
iptables -C INPUT -i docker0 -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -I INPUT 1 -i docker0 -m conntrack --ctstate NEW -j REJECT
# Docker IPv6 is disabled; reject forwarding rather than allowing an alternate route.
ip6tables -C FORWARD -j REJECT 2>/dev/null || ip6tables -I FORWARD 1 -j REJECT
ip6tables -C OUTPUT -d fc00::/7 -j REJECT 2>/dev/null || ip6tables -I OUTPUT 1 -d fc00::/7 -j REJECT
ip6tables -C OUTPUT -d fe80::/10 -j REJECT 2>/dev/null || ip6tables -I OUTPUT 1 -d fe80::/10 -j REJECT
iptables -C OUTPUT -d 169.254.0.0/16 -j REJECT 2>/dev/null || iptables -I OUTPUT 1 -d 169.254.0.0/16 -j REJECT
# Assertions are fatal. Readiness is not a best-effort firewall log message.
iptables -C DOCKER-USER -j SWARM-EGRESS
iptables -C SWARM-EGRESS -s 172.31.0.2/32 -d 172.30.0.2/32 -p tcp --dport 8787 -j ACCEPT
iptables -C SWARM-EGRESS -d 169.254.0.0/16 -j REJECT
ip6tables -C FORWARD -j REJECT
install -m 400 /dev/null /run/swarm-host/network-ready
