# Mainnet Deploy Runbook — b402-solana

Step-by-step. Each step has the exact command, expected output, failure-recovery, and a SOL budget tag. Total budget: **~7 SOL** (~$1400 at $200/SOL).

**Program keypairs are reused from devnet** — program IDs are cluster-portable, so the SDK doesn't need a code change. Keypairs live at `ops/keypairs/*.json` (gitignored).

## Pre-flight

```bash
# 1. Confirm tooling
solana --version    # ≥ 2.0
anchor --version    # ≥ 0.30
node --version      # ≥ 20

# 2. Confirm program keypairs are present (devnet-deployed = mainnet-deployable)
ls ops/keypairs/
# Required: b402_pool-keypair.json, b402_verifier_transact-keypair.json,
#           b402_verifier_adapt-keypair.json, b402_jupiter_adapter-keypair.json,
#           b402_kamino_adapter-keypair.json
# (b402_mock_adapter / b402_orca_adapter / b402_adrena_adapter / b402_jupiter_perps_adapter
#  are NOT deployed in alpha — only the five above.)

# 3. Build all programs from current HEAD (idempotent, ~3 min)
./scripts/build-all.sh
# Produces target/deploy/*.so for the five alpha programs.
# Equivalent to running, in sequence, for each program name:
#   cargo build-sbf --tools-version v1.54 --manifest-path programs/<name>/Cargo.toml

# 4. Fund the deploy authority on mainnet
solana config set --url mainnet-beta
solana balance
# Need: ≥ 7 SOL on ~/.config/solana/id.json (4ym542u1DuC2i9hVxnr2EAdss8fHp4Rf4RFnyfqfy82t).
# Bridge from another wallet — do NOT withdraw direct from a CEX (leaves a chain
# link to your CEX deposit address; adversary can de-anonymize the deploy authority).

# 5. Use Helius RPC, NEVER public mainnet
solana config set --url https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

## Step 1 — Deploy programs (≈6 SOL)

The deploy script validates keypairs, computes rent, and only runs for real with `--execute`.

```bash
# Dry run — prints plan, sizes, and total rent. Does NOT spend SOL.
./ops/mainnet-deploy.sh

# Execute — deploys all 5 programs in dependency order (verifiers → adapters → pool).
./ops/mainnet-deploy.sh --execute
```

Programs deployed (in order):
1. `b402_verifier_transact` → `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK`
2. `b402_verifier_adapt`    → `3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae`
3. `b402_jupiter_adapter`   → `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7`
4. `b402_kamino_adapter`    → `2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX`
5. `b402_pool`              → `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`

**Failure recovery**: `solana program deploy` is idempotent on the same buffer. If a deploy fails partway with a buffer error, retry the same command — it'll resume from the buffer. If a single program fails, you can re-run `./ops/mainnet-deploy.sh --execute` and it will detect existing programs (via `solana program show`) and only redeploy the missing ones.

**Verification**:
```bash
for pid in Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK \
           3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae \
           3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7 \
           2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX \
           42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y; do
  solana program show $pid --url mainnet-beta | head -3
done
# Each should print ProgramData address + Authority = your keypair.
```

## Step 2 — Init pool + token configs + adapter registry (≈0.15 SOL)

One idempotent script does:
- `init_pool` (sets verifier_transact ID)
- `set_verifier(Adapt, VERIFIER_A_ID)`
- `add_token_config` for USDC (cap: 100k)
- `add_token_config` for WSOL (cap: 300)
- `register_adapter` for Jupiter (execute discriminator)
- `register_adapter` for Kamino (execute discriminator)

```bash
./ops/mainnet-init.sh
# Re-running on already-initialized state is a no-op for each step.
```

Override admin keypair or RPC if needed:
```bash
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
ADMIN_KEYPAIR=$HOME/.config/solana/id.json \
  ./ops/mainnet-init.sh
```

**Verification**:
```bash
# Pool config PDA — derived deterministically from POOL_ID
pnpm exec tsx -e '
import { PublicKey } from "@solana/web3.js";
import { poolConfigPda } from "@b402ai/solana";
console.log(poolConfigPda(new PublicKey("42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y")).toBase58());
'
# Then: solana account <PDA> --url mainnet-beta
# Expected: account exists, owner = pool program
```

## Step 3 — Create mainnet ALT + extend (≈0.02 SOL)

The ALT compresses stable, high-frequency account references in `adapt_execute` transactions. Without it, a 2-hop Jupiter swap overflows Solana's 1232-byte tx size cap.

```bash
# Create the ALT (seeds: pool, verifiers, Token/ATA/System program IDs, common mints)
pnpm exec tsx ops/alt/create-alt.ts create --cluster mainnet-beta
# Save the ALT pubkey it prints — you'll need it next.

# Extend with USDC accounts (vault + token-config)
pnpm exec tsx ops/alt/create-alt.ts add-mint \
  --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --alt <ALT_PUBKEY> --cluster mainnet-beta

# Extend with WSOL accounts
pnpm exec tsx ops/alt/create-alt.ts add-mint \
  --mint So11111111111111111111111111111111111111112 \
  --alt <ALT_PUBKEY> --cluster mainnet-beta

# Extend with Jupiter adapter scratch ATAs (USDC + WSOL)
pnpm exec tsx ops/alt/create-alt.ts add-adapter \
  --adapter 3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7 \
  --alt <ALT_PUBKEY> \
  --mints EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,So11111111111111111111111111111111111111112 \
  --cluster mainnet-beta

# Verify final state
pnpm exec tsx ops/alt/create-alt.ts show \
  --alt <ALT_PUBKEY> --cluster mainnet-beta
```

**Update SDK constant**: edit `packages/shared/src/constants.ts`:
```ts
export const B402_ALT_MAINNET = '<ALT_PUBKEY>';
```
Bump SDK version, republish (Step 5).

## Step 4 — Generate + fund mainnet relayer wallet (≈0.5 SOL)

```bash
# Generate dedicated mainnet relayer keypair
solana-keygen new --no-bip39-passphrase --silent \
  -o ~/.config/solana/b402-relayer-mainnet.json

solana address -k ~/.config/solana/b402-relayer-mainnet.json
# Save pubkey for monitoring + Cloud Run secret.

# Fund with 0.5 SOL — covers thousands of unshield txs + nullifier shard rent
solana transfer --from $HOME/.config/solana/id.json \
  --allow-unfunded-recipient \
  $(solana address -k ~/.config/solana/b402-relayer-mainnet.json) 0.5 \
  --url mainnet-beta
```

## Step 5 — Deploy mainnet relayer to Cloud Run (≈0 SOL, ~5 min)

Cloud Run gives us the public URL we'll bake into the published SDK + MCP package as the mainnet default. So this MUST happen before step 6 (publish).

```bash
cd packages/relayer

# Push the relayer keypair as a Cloud Run secret (NEVER commit it)
gcloud secrets create b402-relayer-mainnet-keypair \
  --data-file=$HOME/.config/solana/b402-relayer-mainnet.json

# Use the Helius Gatekeeper URL for low-latency runtime quote+submit
gcloud secrets create b402-relayer-mainnet-rpc \
  --data-file=<(echo -n "https://beta.helius-rpc.com/?api-key=YOUR_KEY")

# Build + deploy mainnet variant
gcloud builds submit --config cloudbuild.yaml \
  --substitutions _CLUSTER=mainnet,_SERVICE=b402-solana-relayer-mainnet

# Capture the URL — you'll bake it into context.ts in step 6
gcloud run services describe b402-solana-relayer-mainnet \
  --region us-central1 --format='value(status.url)'

# Sanity probe
curl -sf $(gcloud run services describe b402-solana-relayer-mainnet \
  --region us-central1 --format='value(status.url)')/health
```

Mint a public-tier API key for the mainnet relayer (matches the devnet `kp_8a28d0e86074cde3` model — embedded in the published MCP so end users get zero-config). Track it; you'll wire it into `defaultApiKey.mainnet` in step 6.

## Step 6 — Bump SDK + MCP, wire mainnet defaults, republish (≈0 SOL, ~5 min)

Wire three mainnet constants into the package source, then publish.

```bash
# (a) ALT pubkey — from step 3 output
# Edit packages/shared/src/constants.ts:
#   export const B402_ALT_MAINNET = '<ALT_PUBKEY>' as const;

# (b) Hosted-relayer URL + API key — from step 5 output
# Edit packages/mcp-server/src/context.ts:
#   defaultRelayerUrl.mainnet = 'https://b402-solana-relayer-mainnet-...run.app',
#   defaultApiKey.mainnet     = 'kp_<mainnet_public_tier_key>',

# (c) Bump versions
sed -i '' 's/"version": "0.0.4"/"version": "0.0.5"/' packages/sdk/package.json
sed -i '' 's/"version": "0.0.5"/"version": "0.0.6"/' packages/mcp-server/package.json

# Build clean
rm -rf packages/sdk/dist packages/mcp-server/dist packages/shared/dist
pnpm --filter='@b402ai/solana-shared' build
pnpm --filter='@b402ai/solana' build
pnpm --filter='@b402ai/solana-mcp' build

# Pack — inspect for leakage before publishing
mkdir -p /tmp/b402-tarballs
cd packages/sdk && pnpm pack --pack-destination /tmp/b402-tarballs
cd ../mcp-server && pnpm pack --pack-destination /tmp/b402-tarballs

tar -tzf /tmp/b402-tarballs/b402ai-solana-0.0.5.tgz \
  | grep -iE 'keypair|\.env|\.pem|secret|id\.json' || echo "clean"
tar -tzf /tmp/b402-tarballs/b402ai-solana-mcp-0.0.6.tgz \
  | grep -iE 'keypair|\.env|\.pem|secret|id\.json' || echo "clean"

# Publish — sdk first, then mcp (mcp depends on sdk)
cd /tmp/b402-tarballs
npm publish b402ai-solana-0.0.5.tgz
sleep 30   # wait for npm registry to index sdk before mcp resolves it
npm publish b402ai-solana-mcp-0.0.6.tgz
```

## Step 7 — Smoke test (≈0.01 SOL)

```bash
# Configure Claude Code MCP for mainnet
claude mcp remove b402-solana 2>/dev/null
claude mcp add b402-solana \
  --env B402_CLUSTER=mainnet \
  --env B402_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
  --env B402_RELAYER_KEYPAIR_PATH=$HOME/.config/solana/b402-relayer-mainnet.json \
  -- npx -y @b402ai/solana-mcp@latest

# Open fresh Claude Code session, run:
#   "shield 1000000 of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  (1 USDC)
#   "balance"
#   "quote_swap 1 USDC to SOL"
#   "private_swap 1000000 USDC to SOL"  (real Jupiter route on mainnet)
#   "balance"
#   "unshield to <fresh recipient>"
#
# Each step prints a real mainnet sig. Verify on
# https://explorer.solana.com/tx/<sig>
```

**Acceptance criteria for mainnet alpha**:
- Shield USDC tx confirms, ciphertext visible in CommitmentAppended event.
- Balance reflects deposit.
- Quote returns real Jupiter route.
- Private swap fires real Jupiter mainnet swap (different sig from quote).
- Unshield's signer[0] is the relayer pubkey, NOT user wallet.
- Recipient receives the OUT token at the destination address.

## Step 8 — Disclose ceremony status

Add to README hero + open a pinned GitHub issue:

> **Mainnet alpha** — current circuit ceremony is the throwaway-devnet output.
> A full multi-party ceremony is tracked in PRD-08 and ships before opening to
> broader use. Tx caps in place to bound risk while ceremony runs.

## Total cost recap

| Step | SOL |
|---|---|
| Programs deploy (×5) | 6.0 |
| Pool init + 2 token configs + 2 adapter registrations | 0.15 |
| Mainnet ALT (create + 2 add-mint + 1 add-adapter) | 0.02 |
| Relayer wallet funding | 0.5 |
| Smoke test | 0.01 |
| **Total** | **~6.7 SOL** |

Buffer: keep 0.3 SOL extra in deploy authority for retries / emergencies.

## Rollback

If smoke test fails:

1. **Don't open to users.** Mainnet pool exists but undocumented; no one will find it.
2. Diagnose via Solana Explorer + Cloud Run/relayer logs.
3. Programs CAN be redeployed (they're upgradeable). Pool state CANNOT be wiped — but undocumented = effectively unused.
4. Worst case: deploy again under fresh keypairs, switch SDK constants, re-publish 0.0.6.

## Post-deploy

- File a GitHub issue: "Mainnet alpha live — relayer indexing not yet wired (b402-solana-indexer pending PRD sign-off)."
- Monitor relayer wallet balance — refill at 0.1 SOL.
- Monitor pool tree leaf count — if it grows past ~5K without indexer, prioritize indexer ship.
