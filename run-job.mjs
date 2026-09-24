#!/usr/bin/env node
// Demo mode: the whole cycle from one terminal with two named wallets (what the video shows).
// For real use, run one step at a time with nayori.mjs, one wallet per role.
//
//   node run-job.mjs --client <wallet> --provider <wallet> [job.json]
//   node run-job.mjs --read-only

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as N from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "runs");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const jobFile = argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").startsWith("--")) ?? "job.json";
const job = JSON.parse(readFileSync(existsSync(resolve(jobFile)) ? resolve(jobFile) : join(HERE, "job.example.json"), "utf8"));

async function main() {
  console.log(`Nayori Agent SDK demo  |  @perkos/agent-sdk  |  Stacks ${N.NETWORK}  |  ${new Date().toISOString().slice(0, 16)}Z`);
  await N.readState();
  if (argv.includes("--read-only")) { N.say("read-only mode: stopping before any transaction."); return; }
  const clientName = flag("--client"); const providerName = flag("--provider");
  if (!clientName || !providerName) throw new Error("demo mode needs --client <wallet> --provider <wallet> (node nayori.mjs wallet list)");
  const client = N.actor(clientName, BigInt(job.budgetSats ?? 1000));
  const provider = N.actor(providerName);
  const clientAddress = await client.signer.getAddress();
  const providerAddress = await provider.signer.getAddress();
  console.log(`client "${clientName}" ${clientAddress}  |  provider "${providerName}" ${providerAddress}  |  evaluator ${N.EVALUATOR}`);
  const agentId = await N.registerAgent(provider, providerAddress, job.agent ?? {});
  const jobId = await N.createAndFund(client, clientAddress, job);
  await N.hire(client, jobId, providerAddress);
  const { evidence, parsed } = await N.deliver(provider, providerAddress, jobId, { file: job.deliverableFile, text: job.deliverable }, OUT);
  await N.requestEvaluation(jobId, providerAddress, evidence, parsed, OUT);
  const decision = await N.waitDecision(jobId);
  N.summary(jobId, OUT, { role: "both", agentId, decision });
}

main().catch((error) => { console.error(`\nSTOPPED: ${error.message}`); process.exit(1); });
