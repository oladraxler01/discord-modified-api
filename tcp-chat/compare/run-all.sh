#!/usr/bin/env bash
# Reproducible TCP vs UDP comparison on one Linux machine (loopback), baseline + loss.
#
#   ./tcp-chat/compare/run-all.sh          # default 10% loss, 100 messages (asks for sudo for tc)
#   LOSS=5 COUNT=200 ./tcp-chat/compare/run-all.sh
#
# Only tc netem runs with sudo (node stays as your user). Results: tcp-chat/compare/results/*.json|csv and RESULTS.md
set -euo pipefail
cd "$(dirname "$0")/../.."
LOSS="${LOSS:-10}"
COUNT="${COUNT:-100}"
INTERVAL="${INTERVAL:-20}"
NETEM=tcp-chat/experiments/netem.sh

cleanup() { kill "${RU:-}" "${RT:-}" 2>/dev/null || true; sudo bash "$NETEM" clear >/dev/null; }
trap cleanup EXIT

node tcp-chat/compare/receiver.js --proto udp --port 6001 --label baseline > /tmp/recv-udp.log 2>&1 & RU=$!
node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label baseline > /tmp/recv-tcp.log 2>&1 & RT=$!
sleep 1

run() { # label
  node tcp-chat/compare/sender.js --proto udp --port 6001 --count "$COUNT" --interval "$INTERVAL" --label "$1"
  node tcp-chat/compare/sender.js --proto tcp --port 6002 --count "$COUNT" --interval "$INTERVAL" --label "$1"
  sleep 6 # let receivers hit their idle timeout and write summaries
}

echo "=== Baseline (no impairment) ==="
sudo bash "$NETEM" clear >/dev/null
run baseline

# Receivers name files by their own --label, so restart them for the loss run.
kill "$RU" "$RT"; sleep 0.5
node tcp-chat/compare/receiver.js --proto udp --port 6001 --label "loss${LOSS}" > /tmp/recv-udp.log 2>&1 & RU=$!
node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label "loss${LOSS}" > /tmp/recv-tcp.log 2>&1 & RT=$!
sleep 1

echo "=== ${LOSS}% packet loss (tc netem on lo) ==="
sudo bash "$NETEM" loss "$LOSS"
run "loss${LOSS}"
sudo bash "$NETEM" clear

node tcp-chat/compare/summarize.js
