# Cloud deployment: GCP Compute Engine (free tier)

**Why this setup:** the chat is a raw TCP service on port 5000. PaaS hosts like Render,
Vercel or Cloud Run only forward HTTP(S), so they can't carry it. A small **virtual machine**
gives us a public IP, full control of the TCP port and firewall, and root access for
`tcpdump` and `tc netem`. GCP's `e2-micro` in `us-central1`, `us-west1` or `us-east1` is in the
*Always Free* tier.

```
 Laptop A (client.js) ─┐                    GCP project
                       │  TCP :5000   ┌──────────────────────────────────────────┐
 Laptop B (client.js) ─┼─ Internet ──►│ VPC firewall: allow tcp:5000 0.0.0.0/0   │
                       │              │               allow tcp:22 <your IP>/32  │
 Admin (SSH :22) ──────┘              │      │                                    │
                                      │      ▼  external IP ↔ internal 10.x (NAT)│
                                      │  e2-micro VM, Ubuntu 24.04               │
                                      │   systemd → node tcp-chat/server.js      │
                                      │   listens 0.0.0.0:5000                   │
                                      └──────────────────────────────────────────┘
```

## 0. Cost check (do this first)

- Always Free: 1 × e2-micro VM per month in us-central1, us-west1 or us-east1, plus 30 GB standard
  persistent disk and 1 GB of outbound traffic per month (excluding China and Australia). Check the current terms at
  https://cloud.google.com/free/docs/free-cloud-features#compute
- Things that **cost money**: another region or machine type, an SSD or balanced disk, more than
  1 GB of outbound traffic, or a *reserved static IP that isn't attached to a running VM*. We use an
  ephemeral IP, so none of these apply.
- Set a budget alert at Billing → Budgets & alerts → Create budget → $1, with alerts at 50%, 90% and 100%.
- **Estimated cost: $0.00 per month** within the free tier. If you go over, it's roughly $7/month for e2-micro
  outside a free region. Chat traffic is a few KB per message, far below 1 GB.

## 1. Provision (Cloud Console, or Cloud Shell commands)

1. Create a project and enable billing (needed even for the free tier) and the Compute Engine API.
2. Create the VM. You can use the console (Compute Engine → VM instances → Create: name `veil-tcp`,
   region `us-central1`, type `e2-micro`, Ubuntu 24.04 LTS, 10 GB **standard** disk, network tag
   `veil-chat`), or run this in Cloud Shell:

   ```bash
   gcloud compute instances create veil-tcp --zone=us-central1-a --machine-type=e2-micro --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=10GB --boot-disk-type=pd-standard --tags=veil-chat
   ```

3. Firewall: open only the chat port, and restrict SSH to your own IP. Find your IP at https://ifconfig.me.

   ```bash
   gcloud compute firewall-rules create veil-chat-tcp-5000 --network=default --direction=INGRESS --action=ALLOW --rules=tcp:5000 --source-ranges=0.0.0.0/0 --target-tags=veil-chat
   ```

   ```bash
   gcloud compute firewall-rules create veil-ssh-admin --network=default --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=<YOUR-IP>/32 --target-tags=veil-chat
   ```

   The `default` network ships with a `default-allow-ssh` rule open to 0.0.0.0/0. Delete it
   (or narrow it) so SSH really is restricted:

   ```bash
   gcloud compute firewall-rules delete default-allow-ssh
   ```

   If you use the browser "SSH" button, also allow Google's IAP range `35.235.240.0/20` on tcp:22.
   For the UDP comparison over the internet, open udp:6001 and tcp:6002 **only while testing**
   and then delete those rules.

4. Note the VM's **External IP** (it's shown in the instance list).

## 2. Configure the VM

SSH in, then install Node 22 and git:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs git tcpdump
```

Create an unprivileged service user and get the code:

```bash
sudo useradd -m -s /bin/bash veil
```

```bash
sudo -u veil git clone -b claude/jolly-davinci-db5797 https://github.com/oladraxler01/discord-modified-api.git /home/veil/discord-modified-api
```

If the repository is private, clone it with a GitHub personal access token, or make it public
for the submission. Never commit the token.

The TCP chat needs **no** secrets and no `npm install`. The VEIL web API's secrets
(Mongo, Pusher, Firebase) stay in environment variables and are *not* needed on this VM.

## 3. Deploy and run as a service

Install the service file:

```bash
sudo cp /home/veil/discord-modified-api/tcp-chat/deploy/veil-tcp-chat.service /etc/systemd/system/
```

Then enable and start it:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now veil-tcp-chat
```

Check that it's running and listening:

```bash
systemctl status veil-tcp-chat
```

```bash
sudo ss -ltnp 'sport = :5000'
```

Follow the logs:

```bash
journalctl -u veil-tcp-chat -f
```

The application log is also written to `/home/veil/discord-modified-api/tcp-chat/logs/server.log`.

| Action | Command |
|---|---|
| Start | `sudo systemctl start veil-tcp-chat` |
| Restart (after `git pull`) | `sudo systemctl restart veil-tcp-chat` |
| Stop (graceful: clients are told, FIN sent) | `sudo systemctl stop veil-tcp-chat` |
| Change port live | `sudo systemctl edit veil-tcp-chat` → add `[Service]` and `Environment=TCP_PORT=6000`, then restart, **and** add a firewall rule for 6000 |

## 4. Verify from two laptops

Each laptop needs Node 18+ and a copy of `tcp-chat/` (`protocol.js` and `client.js` are enough).

On laptop A:

```bash
node tcp-chat/client.js --host <EXTERNAL-IP> --port 5000 --name ola
```

On laptop B:

```bash
node tcp-chat/client.js --host <EXTERNAL-IP> --port 5000 --name bob
```

To check the port is reachable at all from Windows PowerShell:

```powershell
Test-NetConnection <EXTERNAL-IP> -Port 5000
```

Take screenshots of both terminals exchanging messages, plus `journalctl` showing both connections.

## 5. TLS statement

The chat runs as **plaintext TCP** on purpose. That keeps the framing, handshake and payloads
visible in Wireshark, which the experiments need. The downside: anyone on the path can read or
change messages, so don't send sensitive content. The production fix would be wrapping the socket in TLS (`tls.createServer`
with a certificate for a domain, or a TLS-terminating proxy such as stunnel or nginx `stream`), so
the server would see the same TCP byte stream inside an encrypted channel. The VEIL web app itself
is already served over HTTPS/WSS by Vercel and Render.

## 6. Shutdown and safe cleanup (after grading)

Stop the server:

```bash
sudo systemctl disable --now veil-tcp-chat
```

Then delete the VM (and its disk) and the firewall rules:

```bash
gcloud compute instances delete veil-tcp --zone=us-central1-a
```

```bash
gcloud compute firewall-rules delete veil-chat-tcp-5000 veil-ssh-admin
```

Finally, check Billing → Reports shows $0, and remove the budget, or the whole project if you made one just for this.

---

## Alternative: AWS EC2 (12-month free tier)

- Launch an instance: Ubuntu 24.04, `t2.micro` or `t3.micro` (whichever is free-tier eligible in your region), 8–30 GB gp2/gp3.
- Security group: inbound **Custom TCP 5000 from 0.0.0.0/0**, **SSH 22 from My IP**. Nothing else.
- Use a key pair for SSH. Steps 2–4 above are identical (the user is `ubuntu`, so adjust the paths in the service file).
- Set up an AWS Budgets alert at $1. Release any Elastic IP you allocate, because unattached ones are billed.
- Cleanup: terminate the instance, delete the security group, and check that no EBS volumes or snapshots are left over.
