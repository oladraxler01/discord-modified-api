# TCP vs UDP comparison results

| Condition | Protocol | Sent | Received (unique) | Loss % | Missing seqs | Duplicates | Out of order | RTT avg ms | RTT p95 ms | RTT max ms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | TCP | 100 | 100 | 0 | none | 0 | 0 | 0.594 | 1.075 | 4.123 |
| baseline | UDP | 100 | 100 | 0 | none | 0 | 0 | 0.774 | 1.358 | 4.487 |
| loss10 | TCP | 100 | 100 | 0 | none | 0 | 0 | 18.19 | 87.732 | 128.276 |
| loss10 | UDP | 100 | 87 | 13 | 1, 9, 14, 24, 30, 33, 36, 37, 83, 87, 91, 92, … (13) | 0 | 0 | 1.634 | 2.726 | 6.44 |

RTT is measured by the sender from echoes. For UDP, an echo can also be lost, so the sender's echo count reflects loss in both directions. The receiver columns show one-way delivery.

## Experiment 4: chat server latency and throughput

| Condition | RTT avg ms | RTT p95 ms | RTT max ms | Messages | Seconds | Msg/s | KB/s sent |
|---|---|---|---|---|---|---|---|
| exp2-loss10 | 166.317 | 860.668 | 8309.063 | 2000 | 0.242 | 8252.4 | 4327.7 |
| exp2-noloss | 0.87 | 2.241 | 4.928 | 300 | 0.043 | 6974.3 | 3657.4 |
| exp4-delay100 | 1.675 | 2.841 | 9.18 | 500 | 0.213 | 2350.1 | 1232.4 |
