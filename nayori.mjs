#!/usr/bin/env node
// Nayori CLI (npx @perkos/nayori). One command per step, one named wallet per role (or per agent).
//
//   nayori wallet generate [name]               # new wallet: 24 secret words + key, saved under a name (random if omitted)
//   nayori wallet import [name] [--account N]   # an existing wallet, from its secret words (hidden prompt)
//   nayori wallet list | show <name>            # every wallet created or imported here, with balances
//
//   nayori create-job --wallet <client> [job.json]            # create + budget + fund
//   nayori hire       --wallet <client> --job <id> --provider <SP...>
//   nayori register   --wallet <agent>  [--name "..."] [--new]
//   nayori deliver    --wallet <agent>  --job <id> --file <deliverable.txt> [--url <published>]
//   nayori evaluate   --job <id>                              # no wallet: asks the evaluator
//   nayori finalize   --wallet <any>    --job <id>            # after the appeal window
//   nayori status     --job <id>
//   nayori wait       --wallet <agent>  [--job <id>]          # block until a client hires you
//   nayori attest     --wallet <name>   [--handle <you> --roles client,provider,agent-owner]
//                                     # register yourself: a short wizard, then the wallet signs the attestation
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
const usage = () => { if (has("--help") || has("-h") || !cmd) { /* fallthrough */ } console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(cmd ? 2 : 0); };
const needWallet = () => { const w = flag("--wallet"); if (!w) throw new Error("--wallet <name> is required (nayori wallet list)"); return w; };
const needJob = () => { const j = flag("--job"); if (!j || !/^[1-9][0-9]*$/.test(j)) throw new Error("--job <id> is required"); return BigInt(j); };
const loadJob = () => { const f = positional.find((a) => a.endsWith(".json")) ?? "job.json"; const p = existsSync(resolve(f)) ? resolve(f) : join(HERE, "job.example.json"); return JSON.parse(readFileSync(p, "utf8")); };

async function main() {
  console.log(`Nayori SDK demo  |  @perkos/agent-sdk  |  Stacks ${N.NETWORK}  |  ${new Date().toISOString().slice(0, 16)}Z`);
  switch (cmd) {
    case "wallet": {
      if (sub === "generate" || sub === "create") {
        const w = await N.createWallet(positional[1]);
        console.log(`\nGenerated wallet "${w.name}" on Stacks ${w.network}\n`);
        console.log(`  address      ${w.address}   (receives STX and sBTC; sBTC is a token on Stacks, same address)`);
        console.log(`  key file     ${w.path}`);
        console.log(`  secret words ${w.wordsPath}`);
        console.log(`\n  Your 24 secret words (shown once; the same file holds them, mode 0600):\n`);
        console.log(`  ${w.words}\n`);
        console.log(`  Anyone with these words controls the wallet. Back them up offline; you can restore the wallet in Leather`);
        console.log(`  with them (account 1 = this address), and you may delete the .words file afterwards.\n`);
        console.log(`  Next:`);
        console.log(`    fund it from Leather: STX for fees (0.1 STX is plenty); sBTC too if this wallet will pay for jobs`);
        console.log(`    nayori attest --wallet ${w.name} --handle <your-handle> --roles agent-owner,provider   # register yourself`);
        console.log(`    nayori register --wallet ${w.name} --name "<agent name>"                              # agent side`);
        console.log(`    nayori create-job --wallet ${w.name}                                                  # client side`);
        console.log(`    nayori wallet list`);
        return;
      }
      if (sub === "import") {
        const w = await N.importWallet(positional[1], Number(flag("--account") ?? 0));
        console.log(`\nImported wallet "${w.name}" on Stacks ${w.network} (account ${w.account})\n`);
        console.log(`  address   ${w.address}   (check it matches the account in your wallet app)`);
        console.log(`  key file  ${w.path}  (mode 0600; the secret words were not stored)`);
        console.log(`\n  Next: nayori attest --wallet ${w.name} --handle <your-handle> --roles client   |   nayori wallet list`);
        return;
      }
      if (sub === "list") {
        const list = N.listWallets();
        if (list.length === 0) { console.log(`no wallets in ${N.WALLET_DIR}. Generate one: nayori wallet generate [name]`); return; }
        console.log(`\n  ${"name".padEnd(18)} ${"address".padEnd(42)} ${"source".padEnd(9)} ${"created".padEnd(11)} balances`);
        for (const w of list) {
          const b = await N.balances(w.address).catch(() => null);
          console.log(`  ${w.name.padEnd(18)} ${w.address.padEnd(42)} ${w.source.padEnd(9)} ${(w.createdAt || "").slice(0, 10).padEnd(11)} ${b ? `${b.stx.toFixed(3)} STX, ${b.sats} sats` : "(balance unavailable)"}${w.hasWords ? "  [words on disk]" : ""}`);
        }
        console.log(`\n  store: ${N.WALLET_DIR}`);
        return;
      }
      if (sub === "address") {
        const name = positional[1]; if (!name) throw new Error("wallet address <name>");
        console.log(N.readWalletAddress(name));
        return;
      }
      if (sub === "show") {
        const name = positional[1]; if (!name) throw new Error("wallet show <name>");
        const w = N.listWallets().find((x) => x.name === name); if (!w) throw new Error(`wallet "${name}" not found`);
        const b = await N.balances(w.address).catch(() => null);
        const agent = await N.findAgentByWallet(w.address).catch(() => null);
        console.log(`\n  ${w.name}  (${w.source}, ${w.network}${w.createdAt ? ", " + w.createdAt.slice(0, 10) : ""})`);
        console.log(`  address      ${w.address}   (STX and sBTC: one Stacks address receives both)`);
        console.log(`  key file     ${w.path}${w.hasWords ? `\n  secret words ${w.path.replace(/\.env$/, ".words")}` : ""}`);
        console.log(`  balances     ${b ? `${b.stx.toFixed(6)} STX, ${b.sats} sats sBTC` : "unavailable"}`);
        console.log(`  agent        ${agent ? `#${agent.id} "${agent.name}"` : "none registered yet"}`);
        console.log(`  explorer     https://explorer.hiro.so/address/${w.address}?chain=${N.P.chain}`);
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
      else N.say(`next: nayori hire --wallet ${wallet} --job ${jobId} --provider <agent wallet address>`);
      N.summary(jobId, OUT, { role: "client" });
      return;
    }
    case "hire": {
      const wallet = needWallet(); const jobId = needJob();
      const client = N.actor(wallet);
      await N.hire(client, jobId, flag("--provider"));
      N.say(`the agent now delivers: nayori deliver --wallet <agent> --job ${jobId} --file <deliverable.txt>`);
      N.summary(jobId, OUT, { role: "client" });
      return;
    }
    case "register": {
      const wallet = needWallet();
      const provider = N.actor(wallet);
      const me = await provider.signer.getAddress();
      const job = loadJob();
      const id = await N.registerAgent(provider, me, { name: flag("--name") ?? job.agent?.name, description: flag("--description") ?? job.agent?.description, endpoints: job.agent?.endpoints, force: has("--new") });
      N.say(`agent #${id}, wallet ${me}. Give this address to a client, or wait for a job: nayori wait --wallet ${wallet}`);
      return;
    }
    case "wait": {
      const wallet = needWallet();
      const me = N.readWalletAddress(wallet);
      const jobId = await N.waitForAssignment(me, flag("--job"));
      N.say(`hired on job #${jobId}. Next: nayori deliver --wallet ${wallet} --job ${jobId} --file <deliverable.txt>`);
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
      const { mkdirSync, writeFileSync } = await import("node:fs");
      // Wizard by default (prefilled with what Nayori already lists for this wallet); flags skip the questions.
      const answers = flag("--handle")
        ? { handle: flag("--handle"), roles: (flag("--roles") ?? "agent-owner").split(",").map((r) => r.trim()).filter(Boolean), kind: flag("--kind") ?? "independent-developer",
            links: Object.fromEntries(["github", "x", "website"].filter((k) => flag(`--${k}`)).map((k) => [k, flag(`--${k}`)])), organization: flag("--organization"), notes: flag("--notes") }
        : await N.attestWizard(wallet);
      const entry = await N.attest(wallet, answers);
      mkdirSync(OUT, { recursive: true });
      const file = join(OUT, `attestation-${wallet}.json`);
      writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
      console.log(`\n  signed by ${entry.wallet.address} as "${entry.handle}" (${entry.kind}; roles ${entry.wallet.roles.join(", ")})`);
      console.log(`  agents this wallet owns on-chain: ${entry.agentIds.length ? entry.agentIds.map((id) => "#" + id).join(", ") : "none yet"}`);
      console.log(`  saved       ${file}`);
      console.log(`\n  Send this file to Nayori: a pull request adding it to App/src/constants/participants.ts in`);
      console.log(`  github.com/PerkOS-xyz/PerkOS-Nayori, or a DM to @PerkOS_NayoriAI. Once listed, this wallet appears as`);
      console.log(`  independent at ${N.P.app}/participants and its agents and jobs count on nayori.ai/evidence.`);
      console.log(`  To change anything later, run "nayori attest --wallet ${wallet}" again: it prefills what is listed and you re-sign.`);
      return;
    }
    case "finalize": { const wallet = needWallet(); const jobId = needJob(); await N.finalize(N.actor(wallet), jobId); N.summary(jobId, OUT, { role: "finalize" }); return; }
    case "status": { await N.status(needJob()); return; }
    case "state": { await N.readState(); return; }
    case "--help": case "-h": case undefined: usage(); return;
    default: usage();
  }
}

main().catch((error) => { console.error(`\nSTOPPED: ${error.message}`); process.exit(1); });
