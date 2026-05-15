# Verse

Solana volume sequencer. Build sentences of wallet pairs, ARM them with SOL, fire trades in sequence.

Runs as a local server with a React dashboard. Wallet private keys are encrypted at rest (AES-256-GCM). Multi-user auth with admin/operator roles.

---

## What it does

- **Sequencer** — queue wallet pairs (prefix + suffix) as steps, fire buy/sell trades in order
- **Action modes** — Buy+Sell (recommended), Buy only, Sell only, Alternate
- **ARM** — distributes SOL from control wallet to every wallet in the queue before firing
- **Cleanup** — drains SOL back to the control wallet when done
- **Withdraw** — sends the control wallet balance back to your personal address
- **Auto-fire** — fires steps on a timer with a configurable interval
- **Roster** — manage and bulk-import wallets; view balances
- **Pools** — track Solana token pools (Raydium, Pump.fun AMM)
- **Grinder tools** — Python scripts for managing vanity wallet grinding (`grinder/`)

Read the in-app **Guide** tab before firing anything real.

---

## Wallets

Verse uses **vanity wallet pairs** — two Solana wallets whose addresses spell out a word.
A *prefix* wallet starts with the word (`BULL…`) and a *suffix* wallet ends with it (`…BULL`).
Together they form one step in a sentence.

**Private keys never leave your server.** They are stored in `config/wallets.encrypted.json`
using AES-256-GCM encryption (scrypt KDF). That file is gitignored — it is never committed
and never touches GitHub.

### Importing wallets

Wallets are imported through the **Roster** tab (admin only):

1. Produce a `curated.csv` from the grinder (see Grinder tools below).
2. Open Roster → **Bulk import** → paste the CSV content.
3. Enter your vault password to encrypt and save.

The CSV format the grinder outputs:
```
Word,Type,Short Wallet,Wallet Address,Private Key,Source File
BULL,Prefix,BULLab,BULL...,<base58-private-key>,bull-prefix.json
BULL,Suffix,xyzBULL,...BULL,<base58-private-key>,bull-suffix.json
```

### Grinding vanity wallets

Use a GPU vanity grinder (e.g. [Vanity-SOL](https://github.com/something/vanity-sol) or similar)
to generate wallet `.json` files, then run the scripts in `grinder/` to manage and curate them.
See the Grinder tools section below.

---

## Setup

**Requirements:** [Bun](https://bun.sh) 1.1+, Node 22+, a [Helius](https://helius.dev) API key.

```bash
git clone git@github.com:dutchiono/verse.git
cd verse
bun install
cd web && bun install && cd ..
```

Copy and fill in your env:

```bash
cp .env.example .env
# Edit .env — add your HELIUS_API_KEY
```

Copy starter config files:

```bash
cp config/pools.example.json config/pools.json
cp config/sequences.example.json config/sequences.json
```

---

## Running

```bash
# Development (backend + frontend with hot reload)
bun run dev

# Production build
cd web && bun run build && cd ..
bun run start
```

The dashboard is served at `http://localhost:7000` by default (set `SERVER_PORT` in `.env`).

On first launch you'll be prompted to create the first admin account.

---

## Production deploy (nginx + systemd)

See `LIVE_ADMIN.md` and `SECURITY.md` for deployment and security guidance.

Key points:
- Set `SERVER_HOST=127.0.0.1` in `.env` — never expose the backend directly
- Terminate TLS at nginx and proxy to the backend port
- Keep `AUTO_UNLOCK_PASSWORD` disabled in production

---

## Grinder tools

`grinder/` contains Python scripts for managing vanity wallet grinding on a separate Linux machine:

| Script | Purpose |
|---|---|
| `cycle.sh` | Full pipeline: sort words → run manager → list remaining → orphan check → curate |
| `orphan_check.py` | Find .json wallet files not matched by any word in words.txt |
| `curate.py` | Produce curated.csv with only complete pairs, minus anything in omit.txt |
| `omit.txt` | Words or wallet addresses to exclude from the curated output |

---

## Security

- Private keys stored encrypted (`config/wallets.encrypted.json`, AES-256-GCM + scrypt KDF)
- Never committed to git
- See `SECURITY.md` for full model
