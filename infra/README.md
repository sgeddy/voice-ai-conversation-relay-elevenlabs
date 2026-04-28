# infra/

AWS deploy for the Voice AI reference architecture. Bare systemd + host Caddy
on a single `t4g.micro` (ARM, AL2023). No Docker, no IaC framework — just
bash, the `aws` CLI, and a cloud-init `user-data` script.

Target: `voice-ai.samueleddy.com` in the Bedison AWS account
(`680458885853`, `us-east-1`, profile `bedison`).

---

## Files

| File | Where it runs | What it does |
|---|---|---|
| `setup-aws.sh`       | laptop  | Provision EC2 + EIP + SG + Route 53 (one-shot). |
| `bootstrap.sh`       | EC2 first boot | Install Node 20, Caddy, clone, build, set up systemd. |
| `Caddyfile`          | EC2 (Caddy) | TLS termination + reverse proxy → `localhost:3000`. |
| `voice-ai.service`   | EC2 (systemd) | Run `node dist/index.js` as `voiceai`, journal logs. |
| `_common.sh`         | laptop (sourced) | Resolve instance / EIP by `Project` tag. |
| `deploy-aws.sh`      | laptop  | `git pull` + `npm ci` + `npm run build` + restart. |
| `start-aws.sh`       | laptop  | Start the EC2 instance. |
| `stop-aws.sh`        | laptop  | Stop the EC2 instance (compute billing pauses; EIP stays). |
| `tail-logs.sh`       | laptop  | `journalctl -u voice-ai -f` over SSH. |
| `preflight.sh`       | laptop → EC2 | Confirm `/etc/voice-ai.env` has all required keys. |
| `fetch-logs.sh`      | laptop  | Dump journal JSONL for a time window. |
| `validate-deploy.sh` | laptop  | Healthz + 5-call bench + log analyze. |

---

## Prereqs

- `aws` CLI v2 configured with profile `bedison` (us-east-1).
- `jq`, `curl` on your laptop.
- An EC2 key pair in us-east-1 (the script aborts if it doesn't exist).
- A Twilio number with the Voice webhook *not yet* pointed at the new domain
  (you'll cut it over after the box is healthy).
- API keys: Twilio Auth Token, Anthropic, ElevenLabs.

Create the key pair if you don't have one:

```sh
aws --profile bedison --region us-east-1 ec2 create-key-pair \
    --key-name voice-ai-aws --query KeyMaterial --output text \
    > ~/.ssh/voice-ai-aws.pem
chmod 400 ~/.ssh/voice-ai-aws.pem
```

---

## First-time deploy

### 1. Provision

```sh
KEY_NAME=voice-ai-aws ./infra/setup-aws.sh
```

Takes ~2–3 min. At the end you get an EIP, an A record for
`voice-ai.samueleddy.com`, and an instance whose user-data is running
`bootstrap.sh` in the background.

### 2. Watch bootstrap finish

Bootstrap takes another ~3–5 min after the script returns. Tail it:

```sh
./infra/tail-logs.sh cloud-init
```

Wait for: `BOOTSTRAP COMPLETE`. Ctrl-C.

### 3. Populate `/etc/voice-ai.env`

```sh
ssh -i ~/.ssh/voice-ai-aws.pem ec2-user@$(dig +short voice-ai.samueleddy.com)
sudo vim /etc/voice-ai.env
```

Required keys: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `PUBLIC_BASE_URL`. The file is
already pre-populated with safe defaults; you're filling in the empty values.

`PUBLIC_BASE_URL` should be exactly `https://voice-ai.samueleddy.com` — Twilio
signs webhooks against this URL, so a mismatch breaks signature validation.

### 4. Preflight check

From your laptop:

```sh
./infra/preflight.sh
```

If it reports missing keys, fix the env file and rerun.

### 5. Start the service

On the box:

```sh
sudo systemctl enable --now voice-ai
sudo journalctl -u voice-ai -f
```

You should see a startup line with `version`, `gitSha`, `serviceActive`,
`devBypassSignature`. From your laptop, smoke test:

```sh
curl -i https://voice-ai.samueleddy.com/healthz
```

Expected: `200 OK` + JSON with `gitSha`, `version`, `nodeVersion`, `startedAt`.

### 6. Cut Twilio over

In the Twilio console (or via REST API), update your voice number's webhook:

- **A call comes in** → `Webhook` → `https://voice-ai.samueleddy.com/twiml`
  (HTTP `POST`).

Place a test call manually first. Confirm the agent answers, you can have a
turn or two, and barge-in works. Logs:

```sh
./infra/tail-logs.sh
```

### 7. Validate latency

```sh
./infra/validate-deploy.sh
```

Runs `/healthz` → 5 synthetic calls via the bench → pulls the journal for
the run window → analyzes. Cost: ~$0.20.

Compare the printed p50/p95 of `Time to first TTS-bound text leaving app`
against the M1e ngrok numbers. AWS should be *the same or lower* — no ngrok
hop, real cloud network. If AWS p95 is significantly higher, something is
wrong (wrong region, swap thrashing, etc.).

---

## Day-2 ops

### Push code

```sh
./infra/deploy-aws.sh                  # main
REF=feature/foo ./infra/deploy-aws.sh  # any ref
```

### Pause billing when idle

```sh
./infra/stop-aws.sh
# later:
./infra/start-aws.sh
```

EIP stays attached (free while attached to a stopped instance), DNS keeps
working, `voice-ai.service` auto-starts on boot.

### Logs

```sh
./infra/tail-logs.sh             # voice-ai
./infra/tail-logs.sh caddy       # TLS / proxy
./infra/tail-logs.sh cloud-init  # bootstrap output
```

---

## Troubleshooting

**`curl https://voice-ai.samueleddy.com/healthz` returns "no route to host"**
DNS hasn't propagated yet (rare — `setup-aws.sh` waits for INSYNC) or the
SG isn't allowing 443. Check `dig +short voice-ai.samueleddy.com`.

**`curl ... /healthz` returns Caddy's "default" page or a TLS handshake error**
Caddy is up but couldn't get a cert. Tail Caddy: `./infra/tail-logs.sh caddy`.
Most likely cause: port 80 not reachable from Let's Encrypt (SG misconfig).

**`/healthz` times out**
`voice-ai.service` isn't listening on 3000. `./infra/preflight.sh` then
`./infra/tail-logs.sh` to see the boot error. Common cause: missing env var.

**`/twiml` returns 403 on real Twilio calls**
Twilio signature validation failing. Two suspects:
- `TWILIO_AUTH_TOKEN` doesn't match the account that placed the call.
- `PUBLIC_BASE_URL` doesn't match the URL Twilio is calling. They must be
  byte-identical (scheme, host, no trailing slash variance).

**`/twiml` returns 503 with `Retry-After: 60`**
`SERVICE_ACTIVE=false` in `/etc/voice-ai.env`. Flip to `true` and
`sudo systemctl restart voice-ai`.

**Bench reports calls "FAILED"**
Twilio's REST API rejected the call. Check `TWILIO_PHONE_NUMBER` (bench source)
and `BENCH_AGENT_NUMBER` (target) in your laptop's `.env` — they need to be
your two numbers, both verified.

**`tsc` runs out of memory during deploy**
The 1 GB box plus 2 GB swap is usually enough with the
`NODE_OPTIONS=--max-old-space-size=768` cap. If it OOMs anyway, build locally
and `rsync` `dist/` instead — but first try a `sudo systemctl restart voice-ai`
to free memory and retry the deploy.

---

## Cost

| Resource | Approximate monthly |
|---|---|
| `t4g.micro` 730 hr | $6.13 |
| 20 GB gp3 root | $1.60 |
| EIP (associated) | $0.00 |
| Route 53 A record | (within hosted-zone fee) |
| Outbound bandwidth | ~$0 idle, scales with calls |
| **Total idle** | **~$8/mo** |

Compute drops to $0 while the instance is `stopped`. EIP stays free as long as
it's attached to a stopped instance (a *detached* EIP costs $3.65/mo).
