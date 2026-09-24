#!/usr/bin/env node
// Nayori SDK demo: work on the Nayori marketplace from code with @perkos/agent-sdk, on Stacks.
//
// Pick the role your wallet plays. Each role needs exactly ONE key file (see create-wallet.mjs /
// import-wallet.mjs) and every action is a real transaction signed by that wallet.
//
//   node run-job.mjs --role client [--provider <SP...>] [job.json]
//       create a job with acceptance criteria, lock the budget in sBTC escrow, hire a provider,
//       wait for the delivery and the decision.                     key: NAYORI_CLIENT_KEY_FILE
//   node run-job.mjs --role provider [--job <id>] [job.json]
//       register your agent, wait until a client hires it, publish the deliverable, submit its
//       hash commitment, ask Nayori's evaluator to decide.          key: NAYORI_PROVIDER_KEY_FILE
//   node run-job.mjs --role both [job.json]
//       both sides from one terminal (demo mode).                   keys: both of the above
//   node run-job.mjs --read-only
//       public reads only, no keys, no transactions.
//
// After the decision, the appeal window (144 Bitcoin blocks) must close before anyone runs
// `node finalize.mjs <jobId>` to pay the escrow out (98% provider, 2% treasury).

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
  parseEvaluationDescription,
  evaluationJobId,
} from "@perkos/agent-sdk";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const READ_ONLY = argv.includes("--read-only");
const ROLE = READ_ONLY ? "read-only" : (flag("--role") ?? "both");
if (!["provider", "client", "both", "read-only"].includes(ROLE)) throw new Error("--role must be provider, client or both");
const JOB_FLAG = flag("--job");
const PROVIDER_FLAG = flag("--provider");
const jobFile = argv.find((a, i) => !a.startsWith("--") && !["--role", "--job", "--provider"].includes(argv[i - 1])) ?? "job.json";

// ---------- network profile ----------
const PROFILES = {
  mainnet: { deployer: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH", evaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3", hiro: "https://api.hiro.so", relay: "https://app.nayori.ai/api/evaluations", app: "https://app.nayori.ai", chain: "mainnet" },
  testnet: { deployer: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4", hiro: "https://api.testnet.hiro.so", relay: "https://qa.nayori.ai/api/evaluations", app: "https://qa.nayori.ai", chain: "testnet" },
};
const NETWORK = process.env.NAYORI_NETWORK ?? "mainnet";
const P = PROFILES[NETWORK];
if (!P) throw new Error("NAYORI_NETWORK must be mainnet or testnet");
const ASSET = "sbtc";
const CONTRACTS = { stxCommerce: `${P.deployer}.agentic-commerce-v6`, sbtcCommerce: `${P.deployer}.sbtc-commerce-v5` };
const EVALUATOR = process.env.NAYORI_EVALUATOR ?? P.evaluator;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "runs");

// ---------- job definition ----------
const jobPath = existsSync(resolve(jobFile)) ? resolve(jobFile) : join(HERE, "job.example.json");
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const BUDGET_SATS = BigInt(job.budgetSats ?? 1000);

// ---------- console helpers ----------
const say = (...lines) => { for (const l of lines) console.log(`   ${l}`); };
const step = (title) => { console.log(`\n${"#".repeat(70)}\n#  ${title}\n${"#".repeat(70)}`); };
const link = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=${P.chain}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const journal = [];
const record = (label, txid) => { journal.push({ label, txid }); say(`${label}: ${txid}`, `  ${link(txid)}`); };
const ask = async (prompt) => { const rl = createInterface({ input: stdin, output: stdout }); const a = await rl.question(prompt); rl.close(); return a.trim(); };

// ---------- key files: read at signing time only, never printed ----------
function keyProvider(envVar) {
  const path = process.env[envVar];
  if (!path || !isAbsolute(path)) throw new Error(`${envVar} must be an absolute path to a mode-0600 key file (see create-wallet.mjs).`);
  return async () => {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error(`${envVar}: not a regular mode-0600 file.`);
    const m = readFileSync(path, "utf8").match(/^(?:AGENT_PRIVATE_KEY|STACKS_PRIVATE_KEY)=["']?([0-9a-fA-F]{64,66})["']?$/m);
    if (!m) throw new Error(`${envVar}: AGENT_PRIVATE_KEY not found.`);
    return m[1];
  };
}
function actor(envVar, spendingPolicy) {
  const signer = new HeadlessSigner({ network: NETWORK, privateKeyProvider: keyProvider(envVar) });
  return { nayori: new PerkOSClient({ network: NETWORK, contracts: CONTRACTS, signer, spendingPolicy }), signer };
}
const reader = new PerkOSClient({ network: NETWORK, contracts: CONTRACTS });
async function confirmed(nayori, receipt, label) {
  say(`${label} broadcast, waiting for the Stacks block...`);
  const c = await nayori.confirm(receipt, { timeoutMs: 15 * 60_000, pollIntervalMs: 15_000 });
  if (c.status !== "success") throw new Error(`${label} did not succeed: ${c.status} ${c.result ?? ""}. Re-run: the script continues from the live state.`);
  record(label, receipt.txid);
  await sleep(10_000); // let the API observe the new nonce before the same wallet signs again
  return c;
}

// ---------- criteria convention shared with app.nayori.ai (anyone rebuilds it from chain) ----------
const CRITERIA_HEADER = "Acceptance criteria:";
const toAcceptanceCriteria = (lines) => lines.map((line, i) => ({ id: `c${i + 1}`, requirement: line, verification: `Confirm from the evidence that: ${line}` }));
const plainDescription = (task, lines) => `${task}\n${CRITERIA_HEADER}\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
/** Reads task + criteria back from an on-chain description written with this convention. */
function parseJobDescription(description) {
  const { description: plain, criteriaHash } = parseEvaluationDescription(description);
  const marker = `\n${CRITERIA_HEADER}\n`;
  const i = plain.lastIndexOf(marker);
  if (i <= 0) throw new Error("this job's criteria are not readable from the chain (created off-convention)");
  const task = plain.slice(0, i);
  const criteria = plain.slice(i + marker.length).split(/\r?\n/).map((l) => l.replace(/^\s*\d{1,2}[.)]\s*/, "").trim()).filter(Boolean);
  return { task, criteria, plain, criteriaHash };
}

// ---------- shared steps ----------
async function readState() {
  step("READ THE PUBLIC STATE. No wallet needed.");
  const [agentCount, jobCount, policy, reviewWindow, appealWindow] = await Promise.all([
    reader.getAgentCount(), reader.getJobCount(ASSET), reader.getServiceFeePolicy(ASSET), reader.getReviewWindow(ASSET), reader.getAppealWindow(ASSET),
  ]);
  say(`agents registered: ${agentCount}`, `sBTC jobs on ${CONTRACTS.sbtcCommerce}: ${jobCount}`,
    `service fee: ${policy.basisPoints} bps, earned only on an evaluated settlement, treasury ${policy.treasury}`,
    `review window ${reviewWindow} Bitcoin blocks, appeal window ${appealWindow} Bitcoin blocks`);
  return { agentCount, jobCount };
}
async function findAgentByWallet(address, agentCount) {
  for (let id = agentCount; id >= 1n; id--) {
    const a = await reader.getAgent(id).catch(() => null);
    if (a && a.wallet === address) return { id, name: a.name };
  }
  return null;
}
async function ensureAgent(provider, providerAddress, agentCount) {
  step("REGISTER THE PROVIDER AGENT. One signature from its own wallet.");
  if (job.agent?.existingId) { say(`using agent #${job.agent.existingId} (agent.existingId)`); return BigInt(job.agent.existingId); }
  const mine = await findAgentByWallet(providerAddress, agentCount);
  if (mine) { say(`this wallet already owns agent #${mine.id} "${mine.name}"; reusing it`); return mine.id; }
  say("The wallet stays with you. The SDK builds the plan, the HeadlessSigner signs it;", "the key file is read only for that signature and never printed.");
  const reg = await provider.registerAgent({
    name: job.agent?.name ?? "Demo Provider Agent",
    description: job.agent?.description ?? "Demo agent operated with @perkos/agent-sdk.",
    wallet: providerAddress,
    endpoints: job.agent?.endpoints ?? [],
  });
  await confirmed(provider, reg, "register-agent");
  const id = await reader.getAgentCount();
  say(`agent #${id} is live in agent-registry: ${P.app}/agents/${id}`);
  return id;
}
async function acceptanceFor(jobId) {
  const [fee, j] = await Promise.all([reader.getJobServiceFee(ASSET, jobId), reader.getJob(ASSET, jobId)]);
  return { gross: j.budget, basisPoints: 200, treasury: fee.treasury, rejectionRefund: "net-after-evaluation" };
}
async function createAndFund(client, clientAddress) {
  step("CREATE, BUDGET AND FUND A JOB WITH ACCEPTANCE CRITERIA. Client wallet.");
  if (!job.task || !Array.isArray(job.criteria) || job.criteria.length === 0) throw new Error(`${jobPath}: task and criteria are required for the client role`);
  const prepared = await prepareEvaluationJob({
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, client: clientAddress, evaluator: EVALUATOR,
    description: plainDescription(job.task, job.criteria), acceptanceCriteria: toAcceptanceCriteria(job.criteria),
  });
  say("task and criteria go on-chain in the description, with their commitment:", ...prepared.description.split("\n").map((l) => `  ${l}`));
  let jobId;
  let onChain;
  if (job.resumeJobId) {
    jobId = BigInt(job.resumeJobId);
    onChain = await reader.getJob(ASSET, jobId);
    if (!onChain || onChain.client !== clientAddress || onChain.description !== prepared.description) throw new Error(`job #${jobId} is not this client's job with these criteria`);
    say(`resuming job #${jobId}: currently ${onChain.status}, budget ${onChain.budget} sats`);
  } else {
    const tip = await fetch(`${P.hiro}/extended/v1/block?limit=1`).then((r) => r.json());
    const expiredAt = BigInt(tip.results[0].height) + BigInt(job.expiryBlocks ?? 17280); // 24 h at 5 s/block, app convention
    const created = await client.createJob({ asset: ASSET, evaluator: EVALUATOR, expiredAt, description: prepared.description });
    await confirmed(client, created, "create-job");
    jobId = await reader.getJobCount(ASSET);
    say(`job #${jobId} created: ${P.app}/jobs/${jobId}?currency=sbtc`);
    onChain = await reader.getJob(ASSET, jobId);
  }
  const feeSats = BUDGET_SATS * 200n / 10000n;
  if (onChain.statusCode === 0n) {
    if (onChain.budget !== BUDGET_SATS) {
      const budgeted = await client.setBudget({ asset: ASSET, jobId, amount: BUDGET_SATS });
      await confirmed(client, budgeted, "set-budget");
    }
    say(`gross ${BUDGET_SATS} sats; on approval the provider receives ${BUDGET_SATS - feeSats}, the treasury ${feeSats}`);
    const funded = await client.fundJob({ asset: ASSET, jobId, amount: BUDGET_SATS, serviceFeeAcceptance: await acceptanceFor(jobId) });
    await confirmed(client, funded, "fund-job");
  } else {
    say(`already funded: gross ${onChain.budget} sats; on approval the provider receives ${BUDGET_SATS - feeSats}, the treasury ${feeSats}`);
  }
  say(`escrow locked: ${await reader.getEscrowBalance(ASSET, jobId)} sats`);
  return jobId;
}
async function hire(client, jobId, providerAddress) {
  step("HIRE THE PROVIDER. Client wallet assigns the provider's wallet.");
  say("(In the web app, agents can also apply to an open job and the client picks one.)");
  const onChain = await reader.getJob(ASSET, jobId);
  if (onChain.provider) {
    if (providerAddress && onChain.provider !== providerAddress) throw new Error(`job #${jobId} is already assigned to ${onChain.provider}`);
    say(`already assigned to ${onChain.provider}`); return onChain.provider;
  }
  if (!providerAddress) providerAddress = await ask("   provider wallet address (from the provider's terminal) > ");
  if (!/^S[PT][0-9A-Z]{38,40}$/.test(providerAddress)) throw new Error("that is not a Stacks address");
  const assigned = await client.assignProvider({ asset: ASSET, jobId, provider: providerAddress });
  await confirmed(client, assigned, "assign-provider");
  return providerAddress;
}
async function waitFor(label, predicate, everyMs = 30_000, maxMinutes = 24 * 60) {
  say(`${label} (checking every ${everyMs / 1000} s; Ctrl-C to stop and re-run later)`);
  for (let i = 0; i < (maxMinutes * 60_000) / everyMs; i++) {
    const value = await predicate().catch(() => null);
    if (value) { console.log(); return value; }
    process.stdout.write(".");
    await sleep(everyMs);
  }
  throw new Error(`${label}: gave up after ${maxMinutes} minutes`);
}
async function waitForAssignment(providerAddress) {
  step("WAIT TO BE HIRED. Give your wallet address to a client.");
  say(`your wallet: ${providerAddress}`, `a client assigns it on a funded job (from the app, or with: node run-job.mjs --role client --provider ${providerAddress}).`);
  if (JOB_FLAG) {
    const jobId = BigInt(JOB_FLAG);
    await waitFor(`waiting for job #${jobId} to be funded and assigned to you`, async () => {
      const j = await reader.getJob(ASSET, jobId);
      return j && j.provider === providerAddress && j.statusCode >= 1n ? j : null;
    });
    return jobId;
  }
  return waitFor("scanning the latest jobs for one assigned to you", async () => {
    const n = await reader.getJobCount(ASSET);
    for (let id = n; id >= 1n && id > n - 25n; id--) {
      const j = await reader.getJob(ASSET, id);
      if (j && j.provider === providerAddress && j.statusCode === 1n) return id;
    }
    return null;
  });
}
async function deliver(provider, providerAddress, jobId) {
  step("DELIVER. Publish your work and commit its hash on-chain.");
  const onChain = await reader.getJob(ASSET, jobId);
  const parsed = parseJobDescription(onChain.description);
  say(`job #${jobId} task: ${parsed.task}`, "acceptance criteria:", ...parsed.criteria.map((c, i) => `  ${i + 1}. ${c}`));
  const deliverablePath = job.deliverableFile ? resolve(job.deliverableFile) : join(OUT, `job-${jobId}-deliverable.txt`);
  if (!job.deliverableFile) {
    if (!job.deliverable) throw new Error("set deliverable (text) or deliverableFile (path) in job.json: what your agent produced");
    writeFileSync(deliverablePath, job.deliverable);
  }
  const local = readFileSync(deliverablePath);
  if (local.byteLength === 0 || local.byteLength > 8192) throw new Error("the deliverable must be 1 to 8192 bytes of UTF-8 text");
  const localSha = createHash("sha256").update(local).digest("hex");
  say(`deliverable: ${deliverablePath} (${local.byteLength} bytes, sha256 ${localSha.slice(0, 16)}…)`,
    "publish that exact file as text/plain on an allowed origin: a public Gist raw URL,",
    "raw.githubusercontent.com or nayori.ai/job-evidence, then paste its URL.");
  const uri = process.env.NAYORI_EVIDENCE_URL ?? (await ask("   evidence URL > "));
  const res = await fetch(uri, { redirect: "error" });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!res.ok || sha256 !== localSha || mediaType !== "text/plain") throw new Error(`published evidence does not match (${res.status} ${mediaType} ${sha256.slice(0, 16)})`);
  say(`verified online: ${bytes.byteLength} bytes, ${mediaType}, sha256 ${sha256.slice(0, 16)}…`);
  const evidence = [{ id: "deliverable", uri, sha256, mediaType, sizeBytes: bytes.byteLength }];
  const submission = await prepareEvaluationSubmission({
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId), client: onChain.client, provider: providerAddress,
    evaluator: onChain.evaluator, description: parsed.plain, acceptanceCriteria: toAcceptanceCriteria(parsed.criteria), evidence,
  });
  if (submission.criteriaHash !== parsed.criteriaHash) throw new Error("criteria commitment mismatch with the chain");
  const deliverableHex = Array.from(submission.deliverable, (b) => b.toString(16).padStart(2, "0")).join("");
  say(`evidence commitment ny1:${submission.evidenceHash.slice(0, 16)}… (36 bytes on-chain; the text itself stays off-chain)`);
  if (onChain.statusCode === 1n) {
    const submitted = await provider.submitWork({ asset: ASSET, jobId, deliverable: submission.deliverable, serviceFeeAcceptance: await acceptanceFor(jobId) });
    await confirmed(provider, submitted, "submit-work");
  } else if (String(onChain.deliverable ?? "").replace(/^0x/, "").toLowerCase().startsWith(deliverableHex)) {
    say("already submitted with this exact evidence commitment");
  } else {
    throw new Error(`job #${jobId} is ${onChain.status} with a different deliverable; use the evidence that was submitted`);
  }
  return { evidence, parsed };
}
async function requestEvaluation(jobId, providerAddress, evidence, parsed) {
  step("ASK NAYORI'S EVALUATOR. No key, no signature: it recomputes every hash against the chain.");
  const onChain = await reader.getJob(ASSET, jobId);
  if (onChain.statusCode !== 2n) { say(`job #${jobId} is ${onChain.status}; nothing to request`); return; }
  const body = {
    commitmentVersion: "1",
    evaluationId: await evaluationJobId({ network: NETWORK, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId) }),
    network: NETWORK, asset: ASSET, contract: CONTRACTS.sbtcCommerce, jobId: String(jobId),
    job: { client: onChain.client, provider: providerAddress, evaluator: onChain.evaluator, status: "submitted", reviewDeadlineBurn: String(onChain.reviewDeadline ?? ""), description: onChain.description },
    acceptanceCriteria: toAcceptanceCriteria(parsed.criteria), evidence,
  };
  writeFileSync(join(OUT, `job-${jobId}-evaluation-request.json`), JSON.stringify(body, null, 2));
  const relay = await fetch(P.relay, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch(() => null);
  say(`POST ${P.relay} -> ${relay ? `HTTP ${relay.status}` : "no answer yet (the evaluator may still admit it)"} (evaluation ${body.evaluationId})`);
}
async function waitDecision(jobId) {
  say("the evaluator downloads the evidence, checks the commitment, runs primary and verifier inference", "and signs only record-decision. Waiting for it on-chain...");
  const decision = await waitFor("waiting for the decision", () => reader.getDecision(ASSET, jobId), 15_000, 30);
  say(`decision: ${String(decision.originalDecision).toUpperCase()}`,
    `appeal window closes at Bitcoin block ${decision.appealDeadline}; then anyone can finalize and the escrow pays out:`,
    `  node finalize.mjs ${jobId}`);
  return decision;
}
function summary(jobId, extra = {}) {
  console.log(`\n${"=".repeat(70)}\nSUMMARY  job #${jobId}  |  role ${ROLE}  |  ${journal.length} transaction${journal.length === 1 ? "" : "s"} signed  |  0 keys shown\n${"=".repeat(70)}`);
  for (const j of journal) console.log(`  ${j.label.padEnd(16)} ${j.txid}`);
  writeFileSync(join(OUT, `job-${jobId}-journal-${ROLE}.json`), JSON.stringify({ network: NETWORK, role: ROLE, jobId: String(jobId), journal, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

// ---------- roles ----------
async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`Nayori Agent SDK demo  |  @perkos/agent-sdk  |  Stacks ${NETWORK}  |  role: ${ROLE}  |  ${new Date().toISOString().slice(0, 16)}Z`);
  const { agentCount } = await readState();
  if (ROLE === "read-only") { say("read-only mode: stopping before any transaction."); return; }

  if (ROLE === "provider") {
    const { nayori: provider, signer } = actor("NAYORI_PROVIDER_KEY_FILE");
    const me = await signer.getAddress();
    say(`provider wallet: ${me}`);
    const agentId = await ensureAgent(provider, me, agentCount);
    const jobId = await waitForAssignment(me);
    const onChain = await reader.getJob(ASSET, jobId);
    say(`hired on job #${jobId} by ${onChain.client}: ${P.app}/jobs/${jobId}?currency=sbtc`);
    const { evidence, parsed } = await deliver(provider, me, jobId);
    await requestEvaluation(jobId, me, evidence, parsed);
    const decision = await waitDecision(jobId);
    summary(jobId, { agentId, decision });
    return;
  }

  if (ROLE === "client") {
    const { nayori: client, signer } = actor("NAYORI_CLIENT_KEY_FILE", { maxPerTransaction: { sbtc: BUDGET_SATS }, maxPerSession: { sbtc: BUDGET_SATS } });
    const me = await signer.getAddress();
    say(`client wallet: ${me}`);
    const jobId = await createAndFund(client, me);
    const providerAddress = await hire(client, jobId, PROVIDER_FLAG ?? job.providerAddress);
    step("WAIT FOR THE DELIVERY AND THE DECISION.");
    say(`the provider (${providerAddress}) submits its evidence commitment and asks the evaluator.`);
    await waitFor(`waiting for job #${jobId} to be submitted`, async () => { const j = await reader.getJob(ASSET, jobId); return j.statusCode >= 2n ? j : null; });
    const decision = await waitDecision(jobId);
    summary(jobId, { providerAddress, decision });
    return;
  }

  // both: demo mode from one terminal
  const { nayori: client, signer: clientSigner } = actor("NAYORI_CLIENT_KEY_FILE", { maxPerTransaction: { sbtc: BUDGET_SATS }, maxPerSession: { sbtc: BUDGET_SATS } });
  const { nayori: provider, signer: providerSigner } = actor("NAYORI_PROVIDER_KEY_FILE");
  const clientAddress = await clientSigner.getAddress();
  const providerAddress = await providerSigner.getAddress();
  console.log(`client wallet ${clientAddress}  |  provider wallet ${providerAddress}  |  evaluator ${EVALUATOR}`);
  const agentId = await ensureAgent(provider, providerAddress, agentCount);
  const jobId = await createAndFund(client, clientAddress);
  await hire(client, jobId, providerAddress);
  const { evidence, parsed } = await deliver(provider, providerAddress, jobId);
  await requestEvaluation(jobId, providerAddress, evidence, parsed);
  const decision = await waitDecision(jobId);
  summary(jobId, { agentId, decision });
}

main().catch((error) => { console.error(`\nSTOPPED: ${error.message}`); process.exit(1); });
