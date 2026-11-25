#!/usr/bin/env bash
# Controlled network impairment with Linux tc netem (needs sudo, Linux only).
# Run ONLY on machines/networks you own (your laptop or your own cloud VM).
#
#   sudo ./netem.sh loss 10            # drop 10% of outgoing packets on lo
#   sudo ./netem.sh delay 100          # add 100 ms delay
#   sudo ./netem.sh delayloss 100 5    # 100 ms delay + 5% loss
#   sudo ./netem.sh rate 256           # limit bandwidth to 256 kbit/s
#   sudo ./netem.sh show
#   sudo ./netem.sh clear              # ALWAYS clear when finished
#
# Interface defaults to lo (loopback). netem acts on EGRESS: on lo every packet
# passes once, so both directions are affected. Override with IFACE=ens4.
set -euo pipefail
IFACE="${IFACE:-lo}"
cmd="${1:-show}"

case "$cmd" in
  loss)      tc qdisc replace dev "$IFACE" root netem loss "${2:?percent}%" ;;
  delay)     tc qdisc replace dev "$IFACE" root netem delay "${2:?ms}ms" ;;
  delayloss) tc qdisc replace dev "$IFACE" root netem delay "${2:?ms}ms" loss "${3:?percent}%" ;;
  rate)      tc qdisc replace dev "$IFACE" root netem rate "${2:?kbit}kbit" ;;
  clear)     tc qdisc del dev "$IFACE" root 2>/dev/null || true ;;
  show)      ;;
  *) echo "usage: $0 loss P | delay MS | delayloss MS P | rate KBIT | show | clear"; exit 1 ;;
esac
echo "Current qdisc on $IFACE:"
tc qdisc show dev "$IFACE"
