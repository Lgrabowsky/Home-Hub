#!/bin/sh
# Restarts this machine when the Home Hub asked for it (button "Server neu starten" in the app).
# Installed by deploy/linux/install.sh, run by home-hub-reboot.path as root.
#
# The hub itself has no power over the machine: it can only leave this request file in the
# directory it shares with the machine. Only a fresh request counts, and the file is removed
# before anything happens, so a leftover file can never cause a restart loop.

request=/var/lib/home-hub/control/reboot-request
[ -f "$request" ] || exit 0
age=$(($(date +%s) - $(stat -c %Y "$request")))
rm -f "$request"
if [ "$age" -le 120 ]; then
  logger -t home-hub "Neustart auf Wunsch des Hubs"
  systemctl reboot
fi
