#!/usr/bin/env node
// Nayori SDK demo: run a whole sBTC job on Stacks mainnet from code with @perkos/agent-sdk.
//
// Two wallets you control (the client and the provider agent), each with a HeadlessSigner that
// reads its key from a mode-0600 file only at signing time. Nothing here prints, logs or stores
// key material. Every state change is a real transaction; every wait is a real block wait.
//
//   NAYORI_CLIENT_KEY_FILE=/abs/client.env NAYORI_PROVIDER_KEY_FILE=/abs/provider.env \
//     node run-job.mjs job.json
//   node run-job.mjs --read-only            # no keys, no transactions: public reads only
//
// Steps: 1 read public state · 2 register the provider agent · 3 create, budget and fund a job
// with acceptance criteria · 4 hire the provider · 5 deliver committed evidence · 6 ask Nayori's
// evaluator to decide. After the appeal window, `node finalize.mjs <jobId>` pays out the escrow.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  PerkOSClient,
  HeadlessSigner,
  prepareEvaluationJob,
  prepareEvaluationSubmission,
  evaluationJobId,
} from "@perkos/agent-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const READ_ONLY = process.argv.includes("--read-only");
const jobFile = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "job.json";

// ---------- network profile (mainnet by default; NAYORI_NETWORK=testnet for QA) ----------
const PROFILES = {
  mainnet: {
    deployer: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH",
    evaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3",
    hiro: "https://api.hiro.so",
    relay: "https://app.nayori.ai/api/evaluations",
    explorerChain: "mainnet",
  },
  testnet: {
    deployer: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5",
    evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
    hiro: "https://api.testnet.hiro.so",
    relay: "https://qa.nayori.ai/api/evaluations",
    explorerChain: "testnet",
  },
};
const NETWORK = process.env.NAYORI_NETWORK ?? "mainnet";
const P = PROFILES[NETWORK];
if (!P) throw new Error("NAYORI_NETWORK must be mainnet or testnet");
const ASSET = "sbtc";
const CONTRACTS = { stxCommerce: `${P.deployer}.agentic-commerce-v6`, sbtcCommerce: `${P.deployer}.sbtc-commerce-v5` };
const EVALUATOR = process.env.NAYORI_EVALUATOR ?? P.evaluator;
const OUT = join(HERE, "runs");

// ---------- the job definition (task, criteria, budget, agent, deliverable) ----------
const jobPath = existsSync(resolve(jobFile)) ? resolve(jobFile) : join(HERE, "job.example.json");
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const BUDGET_SATS = BigInt(job.budgetSats ?? 1000);
if (!job.task || !Array.isArray(job.criteria) || job.criteria.length === 0) throw new Error(`${jobFile}: task and criteria are required`);

// ---------- console helpers ----------
const say = (...lines) => { for (const l of lines) console.log(`   ${l}`); };
const step = (title) => { console.log(`\n${"#".repeat(70)}\n#  STEP ${title}\n${"#".repeat(70)}`); };
const link = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=${P.explorerChain}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const journal = [];
const record = (label, txid) => { journal.push({ label, txid }); say(`${label}: ${txid}`, `  ${link(txid)}`); };
const ask = async (prompt) => { const rl = createInterface({ input: stdin, output: stdout }); const a = await rl.question(prompt); rl.close(); return a.trim(); };

// ---------- key files: KEY=value lines, read at signing time only, never printed ----------
function keyProvider(envVar) {
  const path = process.env[envVar];
  if (!path || !isAbsolute(path)) throw new Error(`${envVar} must be an absolute path to a mode-0600 key file.`);
  return async () => {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error(`${envVar}: not a regular mode-0600 file.`);
    const m = readFileSync(path, "utf8").match(/^(?:AGENT_PRIVATE_KEY|STACKS_PRIVATE_KEY)=["']?([0-9a-fA-F]{64,66})["']?$/m);
    if (!m) throw new Error(`${envVar}: AGENT_PRIVATE_KEY not found.`);
    return m[1];
  };
}
function actor(envVar, spendingPolicy) {
  const signer = READ_ONLY ? undefined : new HeadlessSigner({ network: NETWORK, privateKeyProvider: keyProvider(envVar) });
  return { nayori: new PerkOSClient({ network: NETWORK, contracts: CONTRACTS, signer, spendingPolicy }), signer };
}
async function confirmed(nayori, receipt, label) {
  say(`${label} broadcast, waiting for the Stacks block...`);
  const c = await nayori.confirm(receipt, { timeoutMs: 15 * 60_000, pollIntervalMs: 15_000 });
  if (c.status !== "success") {
    throw new Error(`${label} did not succeed: ${c.status} ${c.result ?? ""}. Re-run with resumeJobId: the script continues from the live state.`);
  }
  record(label, receipt.txid);
  await sleep(10_000); // let the API observe the new nonce before the same wallet signs again
  return c;
}

// ---------- criteria convention shared with app.nayori.ai (anyone can rebuild it from chain) ----------
const CRITERIA_HEADER = "Acceptance criteria:";
const toAcceptanceCriteria = (lines) => lines.map((line, i) => ({ id: `c${i + 1}`, requirement: line, verification: `Confirm from the evidence that: ${line}` }));
const plainDescription = (task, lines) => `${task}\n${CRITERIA_HEADER}\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  // The SDK refuses to fund without an explicit spending cap: this run may move at most the budget.
  const { nayori: client, signer: clientSigner } = actor("NAYORI_CLIENT_KEY_FILE",
    { maxPerTransaction: { sbtc: BUDGET_SATS }, maxPerSession: { sbtc: BUDGET_SATS } });
  const { nayori: provider, signer: providerSigner } = actor("NAYORI_PROVIDER_KEY_FILE");
  const clientAddress = READ_ONLY ? "(read-only)" : await clientSigner.getAddress();
  const providerAddress = READ_ONLY ? "(read-only)" : await providerSigner.getAddress();
  console.log(`Nayori Agent SDK demo  |  @perkos/agent-sdk  |  Stacks ${NETWORK}  |  ${new Date().toISOString().slice(0, 16)}Z`);
  console.log(`client wallet ${clientAddress}  |  provider wallet ${providerAddress}  |  evaluator ${EVALUATOR}`);

  step("1/6  READ THE PUBLIC STATE. No wallet needed.");
  const [agentCount, jobCount, policy, reviewWindow, appealWindow] = await Promise.all([
    client.getAgentCount(), client.getJobCount(ASSET), client.getServiceFeePolicy(ASSET), client.getReviewWindow(ASSET), client.getAppealWindow(ASSET),
  ]);
  say(`agents registered: ${agentCount}`, `sBTC jobs on ${CONTRACTS.sbtcCommerce}: ${jobCount}`,
    `service fee: ${policy.basisPoints} bps, earned only on an evaluated settlement, treasury ${policy.treasury}`,
    `review window ${reviewWindow} Bitcoin blocks, appeal window ${appealWindow} Bitcoin blocks`);
  if (READ_ONLY) { say("read-only mode: stopping before any transaction."); return; }
  await sleep(2000);

  step("2/6  REGISTER THE PROVIDER AGENT. One signature from its own wallet.");
  say("The wallet stays with you. The SDK builds the plan, the HeadlessSigner signs it;", "the key file is read only for that signature and never printed.");
  let agentId = job.agent?.existingId ? BigInt(job.agent.existingId) : null;
  if (agentId) {
    say(`reusing agent #${agentId} (set agent.existingId to skip registration)`);
  } else {
    const reg = await provider.registerAgent({
      name: job.agent?.name ?? "Demo Provider Agent",
      description: job.agent?.description ?? "Demo agent operated with @perkos/agent-sdk.",
      wallet: providerAddress,
      endpoints: job.agent?.endpoints ?? [],
    });
    await confirmed(provider, reg, "register-agent");
    agentId = await provider.getAgentCount();
    say(`agent #${agentId} is live in agent-registry`);
  }
  await sleep(2000);

  step("3/6  CREATE, BUDGET AND FUND A JOB WITH ACCEPTANCE CRITERIA. Client wallet.");
  const prepared = await prepareEvaluationJob({
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, client: clientAddress, evaluator: EVALUATOR,
    description: plainDescription(job.task, job.criteria), acceptanceCriteria: toAcceptanceCriteria(job.criteria),
  });
  say("task and criteria go on-chain in the description, with their commitment:", ...prepared.description.split("\n").map((l) => `  ${l}`));
  let jobId;
  let onChain;
  if (job.resumeJobId) {
    // Resume a job this client already created (for example after an interrupted run): every
    // step below checks the live state first and only signs what is still missing.
    jobId = BigInt(job.resumeJobId);
    onChain = await client.getJob(ASSET, jobId);
    if (!onChain || onChain.client !== clientAddress || onChain.description !== prepared.description) throw new Error(`job #${jobId} is not this client's job with these criteria`);
    say(`resuming job #${jobId}: currently ${onChain.status}, budget ${onChain.budget} sats`);
  } else {
    const tip = await fetch(`${P.hiro}/extended/v1/block?limit=1`).then((r) => r.json());
    const expiredAt = BigInt(tip.results[0].height) + BigInt(job.expiryBlocks ?? 17280); // 24 h at 5 s/block, app convention
    const created = await client.createJob({ asset: ASSET, evaluator: EVALUATOR, expiredAt, description: prepared.description });
    await confirmed(client, created, "create-job");
    jobId = await client.getJobCount(ASSET);
    say(`job #${jobId} created`);
    onChain = await client.getJob(ASSET, jobId);
  }
  const fee = await client.getJobServiceFee(ASSET, jobId);
  const acceptance = { gross: BUDGET_SATS, basisPoints: 200, treasury: fee.treasury, rejectionRefund: "net-after-evaluation" };
  const feeSats = BUDGET_SATS * 200n / 10000n;
  if (onChain.statusCode === 0n) {
    if (onChain.budget !== BUDGET_SATS) {
      const budgeted = await client.setBudget({ asset: ASSET, jobId, amount: BUDGET_SATS });
      await confirmed(client, budgeted, "set-budget");
    }
    say(`gross ${BUDGET_SATS} sats; on approval the provider receives ${BUDGET_SATS - feeSats}, the treasury ${feeSats}`);
    const funded = await client.fundJob({ asset: ASSET, jobId, amount: BUDGET_SATS, serviceFeeAcceptance: acceptance });
    await confirmed(client, funded, "fund-job");
    onChain = await client.getJob(ASSET, jobId);
  } else {
    say(`already funded: gross ${onChain.budget} sats; on approval the provider receives ${BUDGET_SATS - feeSats}, the treasury ${feeSats}`);
  }
  say(`escrow locked: ${await client.getEscrowBalance(ASSET, jobId)} sats`);
  await sleep(2000);

  step("4/6  HIRE THE PROVIDER. Client wallet assigns the provider's wallet.");
  say("(In the web app, agents can also apply to an open job and the client picks one.)");
  if (onChain.statusCode === 1n && !onChain.provider) {
    const assigned = await client.assignProvider({ asset: ASSET, jobId, provider: providerAddress });
    await confirmed(client, assigned, "assign-provider");
    onChain = await client.getJob(ASSET, jobId);
  } else if (onChain.provider && onChain.provider !== providerAddress) {
    throw new Error(`job #${jobId} is assigned to ${onChain.provider}, not to this provider`);
  } else {
    say(`already assigned to ${onChain.provider}`);
  }
  await sleep(2000);

  step("5/6  DELIVER. The provider publishes its work and commits its hash on-chain.");
  const deliverablePath = job.deliverableFile ? resolve(job.deliverableFile) : join(OUT, `job-${jobId}-deliverable.txt`);
  if (!job.deliverableFile) writeFileSync(deliverablePath, job.deliverable ?? "");
  const local = readFileSync(deliverablePath);
  if (local.byteLength === 0 || local.byteLength > 8192) throw new Error("the deliverable must be 1 to 8192 bytes of UTF-8 text");
  const localSha = createHash("sha256").update(local).digest("hex");
  say(`deliverable: ${deliverablePath} (${local.byteLength} bytes, sha256 ${localSha.slice(0, 16)}…)`,
    "publish that exact file as text/plain on an allowed origin: nayori.ai/job-evidence,",
    "raw.githubusercontent.com or gist.githubusercontent.com (a public Gist works), then paste its URL.");
  const uri = process.env.NAYORI_EVIDENCE_URL ?? (await ask("   evidence URL > "));
  const res = await fetch(uri, { redirect: "error" });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!res.ok || sha256 !== localSha || mediaType !== "text/plain") throw new Error(`published evidence does not match (${res.status} ${mediaType} ${sha256.slice(0, 16)})`);
  say(`verified online: ${bytes.byteLength} bytes, ${mediaType}, sha256 ${sha256.slice(0, 16)}…`);
  const evidence = [{ id: "deliverable", uri, sha256, mediaType, sizeBytes: bytes.byteLength }];
  const submission = await prepareEvaluationSubmission({
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId), client: clientAddress, provider: providerAddress,
    evaluator: EVALUATOR, description: plainDescription(job.task, job.criteria), acceptanceCriteria: toAcceptanceCriteria(job.criteria), evidence,
  });
  if (submission.criteriaHash !== prepared.criteriaHash) throw new Error("criteria commitment mismatch");
  const deliverableHex = Array.from(submission.deliverable, (b) => b.toString(16).padStart(2, "0")).join("");
  say(`evidence commitment ny1:${submission.evidenceHash.slice(0, 16)}… (36 bytes on-chain; the text itself stays off-chain)`);
  if (onChain.statusCode === 1n) {
    const submitted = await provider.submitWork({ asset: ASSET, jobId, deliverable: submission.deliverable, serviceFeeAcceptance: acceptance });
    await confirmed(provider, submitted, "submit-work");
    onChain = await client.getJob(ASSET, jobId);
  } else if (String(onChain.deliverable ?? "").replace(/^0x/, "").toLowerCase().startsWith(deliverableHex)) {
    say("already submitted with this exact evidence commitment");
  } else {
    throw new Error(`job #${jobId} is ${onChain.status} with a different deliverable; use the evidence that was submitted`);
  }
  await sleep(2000);

  step("6/6  ASK NAYORI'S EVALUATOR. No key, no signature: it recomputes every hash against the chain.");
  onChain = await client.getJob(ASSET, jobId);
  const body = {
    commitmentVersion: "1",
    evaluationId: await evaluationJobId({ network: NETWORK, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId) }),
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId),
    job: { client: clientAddress, provider: providerAddress, evaluator: EVALUATOR, status: "submitted", reviewDeadlineBurn: String(onChain.reviewDeadline ?? ""), description: prepared.description },
    acceptanceCriteria: toAcceptanceCriteria(job.criteria), evidence,
  };
  writeFileSync(join(OUT, `job-${jobId}-evaluation-request.json`), JSON.stringify(body, null, 2));
  const relay = await fetch(P.relay, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch(() => null);
  say(`POST ${P.relay} -> ${relay ? `HTTP ${relay.status}` : "no answer yet (the evaluator may still admit it)"} (evaluation ${body.evaluationId})`);
  say("the evaluator downloads the evidence, checks the commitment, runs primary and verifier inference", "and signs only record-decision. Waiting for it on-chain...");
  let decision = null;
  for (let i = 0; i < 40 && !decision; i++) {
    await sleep(15_000);
    decision = await client.getDecision(ASSET, jobId).catch(() => null);
    if (!decision) process.stdout.write(".");
  }
  console.log();
  if (!decision) throw new Error("no decision recorded within 10 minutes; check the job in the app");
  say(`decision: ${String(decision.originalDecision).toUpperCase()}`,
    `appeal window closes at Bitcoin block ${decision.appealDeadline}; then anyone can finalize and the escrow pays out:`,
    `  node finalize.mjs ${jobId}`);

  console.log(`\n${"=".repeat(70)}\nSUMMARY  job #${jobId}  |  ${journal.length} transactions signed by two wallets  |  0 keys shown\n${"=".repeat(70)}`);
  for (const j of journal) console.log(`  ${j.label.padEnd(16)} ${j.txid}`);
  console.log(`  status           ${(await client.getJob(ASSET, jobId)).status}`);
  writeFileSync(join(OUT, `job-${jobId}-journal.json`), JSON.stringify({ network: NETWORK, jobId: String(jobId), agentId: String(agentId), journal, decision }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((error) => { console.error(`\nSTOPPED: ${error.message}`); process.exit(1); });
