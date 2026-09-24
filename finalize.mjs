#!/usr/bin/env node
// Finalize an approved Nayori job once its appeal window has closed. Anyone can call it: the escrow
// pays the provider net and the treasury fee.
//   NAYORI_CLIENT_KEY_FILE=/abs/path node finalize.mjs <jobId>      (any funded wallet works)
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PerkOSClient, HeadlessSigner } from "@perkos/agent-sdk";

const NETWORK = process.env.NAYORI_NETWORK ?? "mainnet";
const DEPLOYER = NETWORK === "mainnet" ? "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH" : "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const HIRO = NETWORK === "mainnet" ? "https://api.hiro.so" : "https://api.testnet.hiro.so";
const CONTRACTS = { stxCommerce: `${DEPLOYER}.agentic-commerce-v6`, sbtcCommerce: `${DEPLOYER}.sbtc-commerce-v5` };
const jobId = BigInt(process.argv[2] ?? "0");
if (jobId <= 0n) { console.error("usage: node finalize.mjs <jobId>"); process.exit(2); }
const path = process.env.NAYORI_CLIENT_KEY_FILE ?? process.env.NAYORI_PROVIDER_KEY_FILE;
if (!path || !isAbsolute(path)) { console.error("set NAYORI_CLIENT_KEY_FILE (or NAYORI_PROVIDER_KEY_FILE) to an absolute path."); process.exit(2); }
const signer = new HeadlessSigner({ network: NETWORK, privateKeyProvider: async () => {
  const st = lstatSync(path); if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("key file must be a regular mode-0600 file");
  const m = readFileSync(path, "utf8").match(/^(?:AGENT_PRIVATE_KEY|STACKS_PRIVATE_KEY)=["']?([0-9a-fA-F]{64,66})["']?$/m); if (!m) throw new Error("AGENT_PRIVATE_KEY not found"); return m[1];
} });
const nayori = new PerkOSClient({ network: NETWORK, contracts: CONTRACTS, signer });
const [job, decision, burn] = await Promise.all([
  nayori.getJob("sbtc", jobId), nayori.getDecision("sbtc", jobId),
  fetch(`${HIRO}/extended/v1/block?limit=1`).then((r) => r.json()).then((d) => BigInt(d.results[0].burn_block_height)),
]);
console.log(`job #${jobId}: status ${job.status}, decision ${decision?.originalDecision ?? "none"}, appeal deadline ${decision?.appealDeadline ?? "n/a"}, Bitcoin block now ${burn}`);
if (job.status !== "decision-pending" || !decision) { console.error("nothing to finalize"); process.exit(1); }
if (burn <= decision.appealDeadline) { console.error(`appeal window still open: ${decision.appealDeadline - burn} Bitcoin blocks left`); process.exit(1); }
const receipt = await nayori.finalizeDecision("sbtc", jobId);
console.log(`finalize-decision broadcast: ${receipt.txid}\n  ${receipt.explorerUrl}`);
const c = await nayori.confirm(receipt, { timeoutMs: 20 * 60_000, pollIntervalMs: 15_000 });
console.log(`confirmed: ${c.status} at block ${c.blockHeight}`);
const after = await nayori.getJob("sbtc", jobId);
console.log(`job #${jobId} is now ${after.status}; escrow ${await nayori.getEscrowBalance("sbtc", jobId)} sats`);
