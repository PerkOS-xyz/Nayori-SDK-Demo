#!/usr/bin/env node
// Nayori SDK demo CLI. One command per step, one named wallet per role (or per agent).
//
//   node nayori.mjs wallet import <name> [--account N]   # from the secret words of a Leather wallet
//   node nayori.mjs wallet create <name>                 # a brand-new wallet, generated locally
//   node nayori.mjs wallet list                          # names, addresses, balances
//
//   node nayori.mjs create-job --wallet <client> [job.json]            # create + budget + fund
//   node nayori.mjs hire       --wallet <client> --job <id> --provider <SP...>
//   node nayori.mjs register   --wallet <agent>  [--name "..."] [--new]
//   node nayori.mjs deliver    --wallet <agent>  --job <id> --file <deliverable.txt> [--url <published>]
//   node nayori.mjs evaluate   --job <id>                              # no wallet: asks the evaluator
//   node nayori.mjs finalize   --wallet <any>    --job <id>            # after the appeal window
//   node nayori.mjs status     --job <id>
//   node nayori.mjs wait       --wallet <agent>  [--job <id>]          # block until a client hires you
//   node nayori.mjs attest     --wallet <name>   --handle <you> --roles client,provider,agent-owner
//                                                                       # register yourself: sign the participant attestation
//
// Wallets live in ~/.nayori/wallets/<name>.env (mode 0600). Keys are read only when signing.
// NAYORI_NETWORK=testnet switches every command to the QA contracts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as N from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "runs");
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1];
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] ?? "").startsWith("--"));
const usage = () => { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(cmd ? 2 : 0); };
const needWallet = () => { const w = flag("--wallet"); if (!w) throw new Error("--wallet <name> is required (node nayori.mjs wallet list)"); return w; };
const needJob = () => { const j = flag("--job"); if (!j || !/^[1-9][0-9]*$/.test(j)) throw new Error("--job <id> is required"); return BigInt(j); };
const loadJob = () => { const f = positional.find((a) => a.endsWith(".json")) ?? "job.json"; const p = existsSync(resolve(f)) ? resolve(f) : join(HERE, "job.example.json"); return JSON.parse(readFileSync(p, "utf8")); };

async function main() {
  console.log(`Nayori SDK demo  |  @perkos/agent-sdk  |  Stacks ${N.NETWORK}  |  ${new Date().toISOString().slice(0, 16)}Z`);
  switch (cmd) {
    case "wallet": {
      if (sub === "create") { const w = N.createWallet(positional[1] ?? ""); console.log(`created wallet "${w.name}"\n  address: ${w.address}\n  file:    ${w.path} (mode 0600, keep a backup)\nFund it from Leather: STX for fees; sBTC too if it will pay for jobs.`); return; }
      if (sub === "import") { const w = await N.importWallet(positional[1] ?? "", Number(flag("--account") ?? 0)); console.log(`imported wallet "${w.name}"\n  address: ${w.address}  (check it matches your wallet app)\n  file:    ${w.path} (mode 0600)`); return; }
      if (sub === "list") {
        const list = N.listWallets();
        if (list.length === 0) { console.log(`no wallets in ${N.WALLET_DIR}. Create one: node nayori.mjs wallet import <name>`); return; }
        for (const w of list) { const b = await N.balances(w.address).catch(() => null); console.log(`  ${w.name.padEnd(16)} ${w.address}  ${b ? `${b.stx.toFixed(3)} STX, ${b.sats} sats` : ""}`); }
        return;
      }
      usage(); return;
    }
    case "create-job": {
      const wallet = needWallet();
      const job = loadJob();
      const client = N.actor(wallet, BigInt(job.budgetSats ?? 1000));
      const me = await client.signer.getAddress();
      N.say(`client wallet "${wallet}": ${me}`);
      const jobId = await N.createAndFund(client, me, job);
      const provider = flag("--provider") ?? job.providerAddress;
      if (provider) await N.hire(client, jobId, provider);
      else N.say(`next: node nayori.mjs hire --wallet ${wallet} --job ${jobId} --provider <agent wallet address>`);
      N.summary(jobId, OUT, { role: "client" });
      return;
    }
    case "hire": {
      const wallet = needWallet(); const jobId = needJob();
      const client = N.actor(wallet);
      await N.hire(client, jobId, flag("--provider"));
      N.say(`the agent now delivers: node nayori.mjs deliver --wallet <agent> --job ${jobId} --file <deliverable.txt>`);
      N.summary(jobId, OUT, { role: "client" });
      return;
    }
    case "register": {
      const wallet = needWallet();
      const provider = N.actor(wallet);
      const me = await provider.signer.getAddress();
      const job = loadJob();
      const id = await N.registerAgent(provider, me, { name: flag("--name") ?? job.agent?.name, description: flag("--description") ?? job.agent?.description, endpoints: job.agent?.endpoints, force: has("--new") });
      N.say(`agent #${id}, wallet ${me}. Give this address to a client, or wait for a job: node nayori.mjs wait --wallet ${wallet}`);
      return;
    }
    case "wait": {
      const wallet = needWallet();
      const me = N.readWalletAddress(wallet);
      const jobId = await N.waitForAssignment(me, flag("--job"));
      N.say(`hired on job #${jobId}. Next: node nayori.mjs deliver --wallet ${wallet} --job ${jobId} --file <deliverable.txt>`);
      return;
    }
    case "deliver": {
      const wallet = needWallet(); const jobId = needJob();
      const provider = N.actor(wallet);
      const me = await provider.signer.getAddress();
      const job = loadJob();
      const { evidence, parsed } = await N.deliver(provider, me, jobId, { file: flag("--file") ?? job.deliverableFile, text: job.deliverable, url: flag("--url") }, OUT);
      if (!has("--no-evaluate")) { await N.requestEvaluation(jobId, me, evidence, parsed, OUT); await N.waitDecision(jobId); }
      N.summary(jobId, OUT, { role: "provider" });
      return;
    }
    case "evaluate": {
      const jobId = needJob();
      const req = join(OUT, `job-${jobId}-evaluation-request.json`);
      if (!existsSync(req)) throw new Error(`no saved request for job #${jobId}; run deliver first (it saves runs/job-${jobId}-evaluation-request.json)`);
      const body = JSON.parse(readFileSync(req, "utf8"));
      await N.requestEvaluation(jobId, body.job.provider, body.evidence, { criteria: body.acceptanceCriteria.map((c) => c.requirement) }, OUT);
      await N.waitDecision(jobId);
      return;
    }
    case "attest": {
      const wallet = needWallet();
      const roles = (flag("--roles") ?? "agent-owner").split(",").map((r) => r.trim()).filter(Boolean);
      const links = {}; for (const k of ["github", "x", "website"]) if (flag(`--${k}`)) links[k] = flag(`--${k}`);
      const entry = await N.attest(wallet, { handle: flag("--handle"), roles, kind: flag("--kind") ?? "independent-developer", links });
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(OUT, { recursive: true });
      const file = join(OUT, `attestation-${wallet}.json`);
      writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
      console.log(JSON.stringify(entry, null, 2));
      N.say(`saved to ${file}`, "Send this JSON to Nayori: a pull request adding it to App/src/constants/participants.ts in",
        "github.com/PerkOS-xyz/PerkOS-Nayori, or a DM to @PerkOS_NayoriAI. Once merged, this wallet is listed as",
        `independent at ${N.P.app}/participants and its agents and jobs count on nayori.ai/evidence.`);
      return;
    }
    case "finalize": { const wallet = needWallet(); const jobId = needJob(); await N.finalize(N.actor(wallet), jobId); N.summary(jobId, OUT, { role: "finalize" }); return; }
    case "status": { await N.status(needJob()); return; }
    case "state": { await N.readState(); return; }
    default: usage();
  }
}

main().catch((error) => { console.error(`\nSTOPPED: ${error.message}`); process.exit(1); });
