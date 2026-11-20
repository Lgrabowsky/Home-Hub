#!/bin/sh
# Keeps the hub's name servers current. Installed by deploy/linux/install.sh, run by
# home-hub-dns.path (whenever /etc/resolv.conf changes) and home-hub-dns.timer.
#
# Docker copies /etc/resolv.conf into a container only when the container starts. At boot the
# hub often starts before the network has handed out its name servers – then it cannot resolve
# any name (myGEKKO cloud, Spotify) until it is restarted. This restarts it once the machine's
# name servers differ from the hub's copy; at most once per set of name servers and boot.

host=$(grep -s '^nameserver' /etc/resolv.conf | sort)
[ -n "$host" ] || exit 0
inner=$(docker exec home-hub cat /etc/resolv.conf 2>/dev/null) || exit 0
inner=$(printf '%s\n' "$inner" | grep '^nameserver' | sort)
[ "$host" = "$inner" ] && exit 0

done_for=/run/home-hub-dns-synced
[ "$host" = "$(cat "$done_for" 2>/dev/null)" ] && exit 0
printf '%s\n' "$host" >"$done_for"
logger -t home-hub "Namensserver haben sich geändert – der Hub wird neu gestartet"
docker restart home-hub >/dev/null
