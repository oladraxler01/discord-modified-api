#!/usr/bin/env bash
# Start a packet capture to tcp-chat/experiments/captures/<name>.pcap. Press Ctrl+C to stop.
#
#   sudo ./capture.sh exp1-handshake "tcp port 5000"
#   sudo ./capture.sh exp2-loss "tcp port 5000" lo
#   sudo ./capture.sh compare-loss "port 6001 or port 6002" lo
#
# Open the .pcap in Wireshark on your laptop (scp it down from the VM first).
set -euo pipefail
name="${1:?capture name}"
filter="${2:-tcp port 5000}"
iface="${3:-any}"
dir="$(cd "$(dirname "$0")" && pwd)/captures"
mkdir -p "$dir"
echo "Capturing on $iface with filter '$filter' -> $dir/$name.pcap (Ctrl+C to stop)"
# -s 0 full packets; -n no DNS lookups (faster, shows raw IPs)
tcpdump -i "$iface" -s 0 -n -w "$dir/$name.pcap" $filter
