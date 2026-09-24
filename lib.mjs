// Shared pieces of the Nayori SDK demo: network profiles, the named-wallet store, signing
// actors, and the job steps (register, create/fund, hire, deliver, evaluate, finalize).
// Keys are read from mode-0600 files only at signing time and never printed.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, readdirSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { randomPrivateKey, getAddressFromPrivateKey, privateKeyToPublic, signMessageHashRsv, publicKeyFromSignatureRsv } from "@stacks/transactions";

// ---------- network ----------
export const PROFILES = {
  mainnet: { deployer: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH", evaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3", hiro: "https://api.hiro.so", relay: "https://app.nayori.ai/api/evaluations", app: "https://app.nayori.ai", chain: "mainnet" },
  testnet: { deployer: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4", hiro: "https://api.testnet.hiro.so", relay: "https://qa.nayori.ai/api/evaluations", app: "https://qa.nayori.ai", chain: "testnet" },
};
export const NETWORK = process.env.NAYORI_NETWORK ?? "mainnet";
export const P = PROFILES[NETWORK];
if (!P) throw new Error("NAYORI_NETWORK must be mainnet or testnet");
export const ASSET = "sbtc";
export const CONTRACTS = { stxCommerce: `${P.deployer}.agentic-commerce-v6`, sbtcCommerce: `${P.deployer}.sbtc-commerce-v5` };
export const EVALUATOR = process.env.NAYORI_EVALUATOR ?? P.evaluator;
export const reader = new PerkOSClient({ network: NETWORK, contracts: CONTRACTS });

// ---------- console ----------
export const say = (...lines) => { for (const l of lines) console.log(`   ${l}`); };
export const step = (title) => { console.log(`\n${"#".repeat(70)}\n#  ${title}\n${"#".repeat(70)}`); };
export const link = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=${P.chain}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const journal = [];
const record = (label, txid) => { journal.push({ label, txid }); say(`${label}: ${txid}`, `  ${link(txid)}`); };
export const ask = async (prompt) => { const rl = createInterface({ input: stdin, output: stdout }); const a = await rl.question(prompt); rl.close(); return a.trim(); };
export function hiddenPrompt(question) {
  return new Promise((done) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { stdin.off("data", onData); if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false); stdin.pause(); stdout.write("\n"); done(buf); return; }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.resume(); stdin.on("data", onData);
  });
}

// ---------- named wallets: ~/.nayori/wallets/<name>.env (override with NAYORI_HOME) ----------
export const WALLET_DIR = join(process.env.NAYORI_HOME ?? join(homedir(), ".nayori"), "wallets");
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
export function walletPath(name) {
  if (!NAME.test(name)) throw new Error(`wallet name "${name}" must be letters, digits, dot, dash or underscore (1..40)`);
  return join(WALLET_DIR, `${name}.env`);
}
function writeSecret(path, content) {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite`);
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  writeSync(fd, content);
  closeSync(fd);
}
export function walletMeta(name) {
  const p = join(WALLET_DIR, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
export function writeWallet(name, privateKey, meta) {
  const path = walletPath(name);
  if (existsSync(path)) throw new Error(`wallet "${name}" already exists at ${path}; refusing to overwrite a key file`);
  const address = getAddressFromPrivateKey(privateKey, NETWORK);
  writeSecret(path, `AGENT_ADDRESS=${address}\nAGENT_PRIVATE_KEY=${privateKey}\n`);
  const info = { name, address, network: NETWORK, account: 0, createdAt: new Date().toISOString(), ...meta };
  writeSecret(join(WALLET_DIR, `${name}.json`), JSON.stringify(info, null, 2) + "\n");
  return { ...info, path };
}
const randomName = () => `wallet-${randomPrivateKey().slice(0, 6)}`;
/** A brand-new wallet: 24 secret words (BIP39), account 0, like a fresh Leather wallet. */
export async function createWallet(name) {
  const { generateSecretKey, generateWallet } = await import("@stacks/wallet-sdk");
  name = name || randomName();
  walletPath(name); // validate the name before generating anything
  const words = generateSecretKey(256);
  const w = await generateWallet({ secretKey: words, password: "" });
  const info = writeWallet(name, w.accounts[0].stxPrivateKey, { source: "created" });
  const wordsPath = join(WALLET_DIR, `${name}.words`);
  writeSecret(wordsPath, words + "\n");
  return { ...info, words, wordsPath };
}
export async function importWallet(name, accountIndex = 0) {
  const { generateWallet, generateNewAccount } = await import("@stacks/wallet-sdk");
  name = name || randomName();
  walletPath(name);
  const raw = await hiddenPrompt(`Secret words of the wallet to import as "${name}" (${NETWORK}, account ${accountIndex}); typing is hidden: `);
  const words = raw.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) throw new Error(`expected 12 or 24 words, got ${words.length}`);
  let w;
  try { w = await generateWallet({ secretKey: words.join(" "), password: "" }); } catch { throw new Error("could not derive a key from those words (invalid mnemonic?)"); }
  for (let i = w.accounts.length; i <= accountIndex; i++) w = generateNewAccount(w);
  return writeWallet(name, w.accounts[accountIndex].stxPrivateKey, { source: "imported", account: accountIndex });
}
export function readWalletAddress(name) {
  const path = walletPath(name);
  if (!existsSync(path)) throw new Error(`wallet "${name}" not found. Create one: nayori wallet create ${name}   (or import: nayori wallet import ${name})`);
  const m = readFileSync(path, "utf8").match(/^AGENT_ADDRESS=([A-Z0-9]+)$/m);
  if (!m) throw new Error(`${path}: AGENT_ADDRESS not found`);
  return m[1];
}
export function listWallets() {
  if (!existsSync(WALLET_DIR)) return [];
  return readdirSync(WALLET_DIR).filter((f) => f.endsWith(".env")).map((f) => f.slice(0, -4)).sort().map((name) => {
    const meta = walletMeta(name) ?? {};
    return { name, address: readWalletAddress(name), path: walletPath(name), source: meta.source ?? "imported", createdAt: meta.createdAt ?? "", network: meta.network ?? NETWORK, hasWords: existsSync(join(WALLET_DIR, `${name}.words`)) };
  });
}
function keyProvider(name) {
  const path = walletPath(name);
  return async () => {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error(`wallet "${name}": key file must be a regular mode-0600 file`);
    const m = readFileSync(path, "utf8").match(/^(?:AGENT_PRIVATE_KEY|STACKS_PRIVATE_KEY)=["']?([0-9a-fA-F]{64,66})["']?$/m);
    if (!m) throw new Error(`wallet "${name}": AGENT_PRIVATE_KEY not found`);
    return m[1];
  };
}
/** A signing client for a named wallet. `capSats` bounds what fund-job may move in this run. */
export function actor(name, capSats) {
  readWalletAddress(name); // fail early with a clear message if the wallet does not exist
  const signer = new HeadlessSigner({ network: NETWORK, privateKeyProvider: keyProvider(name) });
  const spendingPolicy = capSats !== undefined ? { maxPerTransaction: { sbtc: capSats }, maxPerSession: { sbtc: capSats } } : undefined;
  return { name, nayori: new PerkOSClient({ network: NETWORK, contracts: CONTRACTS, signer, spendingPolicy }), signer };
}
export async function balances(address) {
  const d = await fetch(`${P.hiro}/extended/v1/address/${address}/balances`).then((r) => r.json());
  const sats = Object.entries(d.fungible_tokens ?? {}).filter(([k]) => k.includes("sbtc-token")).reduce((s, [, v]) => s + Number(v.balance), 0);
  return { stx: Number(d.stx?.balance ?? 0) / 1e6, sats };
}

// ---------- transactions ----------
export async function confirmed(nayori, receipt, label) {
  say(`${label} broadcast, waiting for the Stacks block...`);
  const c = await nayori.confirm(receipt, { timeoutMs: 15 * 60_000, pollIntervalMs: 15_000 });
  if (c.status !== "success") throw new Error(`${label} did not succeed: ${c.status} ${c.result ?? ""}. Re-run the command: it continues from the live state.`);
  record(label, receipt.txid);
  await sleep(10_000); // let the API observe the new nonce before the same wallet signs again
  return c;
}
export async function waitFor(label, predicate, everyMs = 30_000, maxMinutes = 24 * 60) {
  say(`${label} (checking every ${everyMs / 1000} s; Ctrl-C to stop and re-run later)`);
  for (let i = 0; i < (maxMinutes * 60_000) / everyMs; i++) {
    const value = await predicate().catch(() => null);
    if (value) { console.log(); return value; }
    process.stdout.write(".");
    await sleep(everyMs);
  }
  throw new Error(`${label}: gave up after ${maxMinutes} minutes`);
}

// ---------- criteria convention shared with app.nayori.ai ----------
export const CRITERIA_HEADER = "Acceptance criteria:";
export const toAcceptanceCriteria = (lines) => lines.map((line, i) => ({ id: `c${i + 1}`, requirement: line, verification: `Confirm from the evidence that: ${line}` }));
export const plainDescription = (task, lines) => `${task}\n${CRITERIA_HEADER}\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
export function parseJobDescription(description) {
  const { description: plain, criteriaHash } = parseEvaluationDescription(description);
  const marker = `\n${CRITERIA_HEADER}\n`;
  const i = plain.lastIndexOf(marker);
  if (i <= 0) throw new Error("this job's criteria are not readable from the chain (created off-convention)");
  const task = plain.slice(0, i);
  const criteria = plain.slice(i + marker.length).split(/\r?\n/).map((l) => l.replace(/^\s*\d{1,2}[.)]\s*/, "").trim()).filter(Boolean);
  return { task, criteria, plain, criteriaHash };
}

// ---------- job steps ----------
export async function readState() {
  step("PUBLIC STATE. No wallet needed.");
  const [agentCount, jobCount, policy, reviewWindow, appealWindow] = await Promise.all([
    reader.getAgentCount(), reader.getJobCount(ASSET), reader.getServiceFeePolicy(ASSET), reader.getReviewWindow(ASSET), reader.getAppealWindow(ASSET),
  ]);
  say(`agents registered: ${agentCount}`, `sBTC jobs on ${CONTRACTS.sbtcCommerce}: ${jobCount}`,
    `service fee: ${policy.basisPoints} bps, earned only on an evaluated settlement, treasury ${policy.treasury}`,
    `review window ${reviewWindow} Bitcoin blocks, appeal window ${appealWindow} Bitcoin blocks`);
  return { agentCount, jobCount };
}
export async function findAgentByWallet(address) {
  const n = await reader.getAgentCount();
  for (let id = n; id >= 1n; id--) {
    const a = await reader.getAgent(id).catch(() => null);
    if (a && a.wallet === address) return { id, name: a.name };
  }
  return null;
}
export async function registerAgent(provider, address, meta = {}) {
  step(`REGISTER THE AGENT. One signature from wallet "${provider.name}".`);
  const mine = await findAgentByWallet(address);
  if (mine && !meta.force) { say(`wallet ${address} already owns agent #${mine.id} "${mine.name}"; reusing it (pass --new to register another)`); return mine.id; }
  say("The wallet stays with you. The SDK builds the plan, the HeadlessSigner signs it;", "the key file is read only for that signature and never printed.");
  const reg = await provider.nayori.registerAgent({
    name: meta.name ?? "Demo Provider Agent",
    description: meta.description ?? "Demo agent operated with @perkos/agent-sdk.",
    wallet: address,
    endpoints: meta.endpoints ?? [],
  });
  await confirmed(provider.nayori, reg, "register-agent");
  const id = await reader.getAgentCount();
  say(`agent #${id} is live in agent-registry: ${P.app}/agents/${id}`);
  return id;
}
export async function acceptanceFor(jobId) {
  const [fee, j] = await Promise.all([reader.getJobServiceFee(ASSET, jobId), reader.getJob(ASSET, jobId)]);
  return { gross: j.budget, basisPoints: 200, treasury: fee.treasury, rejectionRefund: "net-after-evaluation" };
}
export async function createAndFund(client, clientAddress, job) {
  step(`CREATE, BUDGET AND FUND A JOB WITH ACCEPTANCE CRITERIA. Wallet "${client.name}".`);
  if (!job.task || !Array.isArray(job.criteria) || job.criteria.length === 0) throw new Error("job.json needs task and criteria");
  const budget = BigInt(job.budgetSats ?? 1000);
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
    if (!onChain || onChain.client !== clientAddress || onChain.description !== prepared.description) throw new Error(`job #${jobId} is not this wallet's job with these criteria`);
    say(`resuming job #${jobId}: currently ${onChain.status}, budget ${onChain.budget} sats`);
  } else {
    const tip = await fetch(`${P.hiro}/extended/v1/block?limit=1`).then((r) => r.json());
    const expiredAt = BigInt(tip.results[0].height) + BigInt(job.expiryBlocks ?? 17280); // 24 h at 5 s/block, app convention
    const created = await client.nayori.createJob({ asset: ASSET, evaluator: EVALUATOR, expiredAt, description: prepared.description });
    await confirmed(client.nayori, created, "create-job");
    jobId = await reader.getJobCount(ASSET);
    say(`job #${jobId} created: ${P.app}/jobs/${jobId}?currency=sbtc`);
    onChain = await reader.getJob(ASSET, jobId);
  }
  const feeSats = budget * 200n / 10000n;
  if (onChain.statusCode === 0n) {
    if (onChain.budget !== budget) {
      const budgeted = await client.nayori.setBudget({ asset: ASSET, jobId, amount: budget });
      await confirmed(client.nayori, budgeted, "set-budget");
    }
    say(`gross ${budget} sats; on approval the provider receives ${budget - feeSats}, the treasury ${feeSats}`);
    const funded = await client.nayori.fundJob({ asset: ASSET, jobId, amount: budget, serviceFeeAcceptance: await acceptanceFor(jobId) });
    await confirmed(client.nayori, funded, "fund-job");
  } else {
    say(`already funded: gross ${onChain.budget} sats`);
  }
  say(`escrow locked: ${await reader.getEscrowBalance(ASSET, jobId)} sats`);
  return jobId;
}
export async function hire(client, jobId, providerAddress) {
  step(`HIRE THE PROVIDER. Wallet "${client.name}" assigns the provider's wallet on job #${jobId}.`);
  say("(In the web app, agents can also apply to an open job and the client picks one.)");
  const onChain = await reader.getJob(ASSET, jobId);
  if (!onChain) throw new Error(`job #${jobId} not found`);
  if (onChain.provider) {
    if (providerAddress && onChain.provider !== providerAddress) throw new Error(`job #${jobId} is already assigned to ${onChain.provider}`);
    say(`already assigned to ${onChain.provider}`); return onChain.provider;
  }
  if (onChain.statusCode !== 1n) throw new Error(`job #${jobId} is ${onChain.status}; fund it before hiring`);
  if (!providerAddress) providerAddress = await ask("   provider wallet address (the agent prints it) > ");
  if (!/^S[PT][0-9A-Z]{38,40}$/.test(providerAddress)) throw new Error("that is not a Stacks address");
  const assigned = await client.nayori.assignProvider({ asset: ASSET, jobId, provider: providerAddress });
  await confirmed(client.nayori, assigned, "assign-provider");
  return providerAddress;
}
export async function waitForAssignment(providerAddress, jobFlag) {
  step("WAIT TO BE HIRED. Give this wallet address to a client.");
  say(`your wallet: ${providerAddress}`, `a client assigns it on a funded job (from the app, or with: nayori hire --wallet <client> --job <id> --provider ${providerAddress}).`);
  if (jobFlag) {
    const jobId = BigInt(jobFlag);
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
export async function deliver(provider, providerAddress, jobId, source, outDir) {
  step(`DELIVER. Wallet "${provider.name}" publishes its work and commits its hash on-chain.`);
  const onChain = await reader.getJob(ASSET, jobId);
  if (!onChain) throw new Error(`job #${jobId} not found`);
  if (onChain.provider !== providerAddress) throw new Error(`job #${jobId} is assigned to ${onChain.provider ?? "nobody"}, not to this wallet`);
  const parsed = parseJobDescription(onChain.description);
  say(`job #${jobId} task: ${parsed.task}`, "acceptance criteria:", ...parsed.criteria.map((c, i) => `  ${i + 1}. ${c}`));
  let deliverablePath;
  if (source.file) deliverablePath = resolve(source.file);
  else if (source.text) { mkdirSync(outDir, { recursive: true }); deliverablePath = join(outDir, `job-${jobId}-deliverable.txt`); writeFileSync(deliverablePath, source.text); }
  else throw new Error("give the deliverable with --file <path> (what your agent produced) or deliverable text in job.json");
  const local = readFileSync(deliverablePath);
  if (local.byteLength === 0 || local.byteLength > 8192) throw new Error("the deliverable must be 1 to 8192 bytes of UTF-8 text");
  const localSha = createHash("sha256").update(local).digest("hex");
  say(`deliverable: ${deliverablePath} (${local.byteLength} bytes, sha256 ${localSha.slice(0, 16)}…)`,
    "publish that exact file as text/plain on an allowed origin: a public Gist raw URL,",
    "raw.githubusercontent.com or nayori.ai/job-evidence, then paste its URL.");
  const uri = source.url ?? process.env.NAYORI_EVIDENCE_URL ?? (await ask("   evidence URL > "));
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
    const submitted = await provider.nayori.submitWork({ asset: ASSET, jobId, deliverable: submission.deliverable, serviceFeeAcceptance: await acceptanceFor(jobId) });
    await confirmed(provider.nayori, submitted, "submit-work");
  } else if (String(onChain.deliverable ?? "").replace(/^0x/, "").toLowerCase().startsWith(deliverableHex)) {
    say("already submitted with this exact evidence commitment");
  } else {
    throw new Error(`job #${jobId} is ${onChain.status} with a different deliverable; use the evidence that was submitted`);
  }
  return { evidence, parsed };
}
export async function requestEvaluation(jobId, providerAddress, evidence, parsed, outDir) {
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
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `job-${jobId}-evaluation-request.json`), JSON.stringify(body, null, 2));
  const relay = await fetch(P.relay, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch(() => null);
  say(`POST ${P.relay} -> ${relay ? `HTTP ${relay.status}` : "no answer yet (the evaluator may still admit it)"} (evaluation ${body.evaluationId})`);
}
export async function waitDecision(jobId) {
  say("the evaluator downloads the evidence, checks the commitment, runs primary and verifier inference", "and signs only record-decision. Waiting for it on-chain...");
  const decision = await waitFor("waiting for the decision", () => reader.getDecision(ASSET, jobId), 15_000, 30);
  say(`decision: ${String(decision.originalDecision).toUpperCase()}`,
    `appeal window closes at Bitcoin block ${decision.appealDeadline}; then anyone can finalize and the escrow pays out:`,
    `  nayori finalize --wallet <any> --job ${jobId}`);
  return decision;
}
export async function finalize(wallet, jobId) {
  step(`FINALIZE. Wallet "${wallet.name}" pays the escrow out of job #${jobId}.`);
  const [job, decision, tip] = await Promise.all([
    reader.getJob(ASSET, jobId), reader.getDecision(ASSET, jobId),
    fetch(`${P.hiro}/extended/v1/block?limit=1`).then((r) => r.json()).then((d) => BigInt(d.results[0].burn_block_height)),
  ]);
  say(`status ${job.status}, decision ${decision?.originalDecision ?? "none"}, appeal deadline ${decision?.appealDeadline ?? "n/a"}, Bitcoin block now ${tip}`);
  if (job.status !== "decision-pending" || !decision) throw new Error("nothing to finalize");
  if (tip <= decision.appealDeadline) throw new Error(`appeal window still open: ${decision.appealDeadline - tip} Bitcoin blocks left`);
  const receipt = await wallet.nayori.finalizeDecision(ASSET, jobId);
  await confirmed(wallet.nayori, receipt, "finalize-decision");
  const after = await reader.getJob(ASSET, jobId);
  say(`job #${jobId} is now ${after.status}; escrow ${await reader.getEscrowBalance(ASSET, jobId)} sats`);
}
export async function status(jobId) {
  const [job, decision, escrow] = await Promise.all([reader.getJob(ASSET, jobId), reader.getDecision(ASSET, jobId).catch(() => null), reader.getEscrowBalance(ASSET, jobId)]);
  if (!job) throw new Error(`job #${jobId} not found`);
  const parsed = (() => { try { return parseJobDescription(job.description); } catch { return null; } })();
  say(`job #${jobId}: ${job.status} | budget ${job.budget} sats | escrow ${escrow} sats`, `client ${job.client}`, `provider ${job.provider ?? "(none yet)"}`, `evaluator ${job.evaluator}`);
  if (parsed) say(`task: ${parsed.task}`, ...parsed.criteria.map((c, i) => `  ${i + 1}. ${c}`));
  if (decision) say(`decision: ${decision.originalDecision.toUpperCase()} (appeal deadline burn ${decision.appealDeadline})`);
  say(`${P.app}/jobs/${jobId}?currency=sbtc`);
  return { job, decision, escrow };
}
export function summary(jobId, outDir, extra = {}) {
  console.log(`\n${"=".repeat(70)}\nSUMMARY  job #${jobId}  |  ${journal.length} transaction${journal.length === 1 ? "" : "s"} signed  |  0 keys shown\n${"=".repeat(70)}`);
  for (const j of journal) console.log(`  ${j.label.padEnd(16)} ${j.txid}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `job-${jobId}-journal-${Date.now()}.json`), JSON.stringify({ network: NETWORK, jobId: String(jobId), journal, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

// ---------- participant attestation (the developer registers a wallet and its roles) ----------
// Same message and SIP-018 signature the web app produces at app.nayori.ai/participants, signed
// here with the wallet's own key. Nayori verifies it and lists the wallet as independent.
export const ATTESTATION_VERSION = "nayori-participant-attestation-v1";
export const ROLES = ["agent-owner", "client", "provider"];
export function attestationMessage({ handle, address, date }) {
  return [ATTESTATION_VERSION, `network: ${NETWORK}`, `wallet: ${address}`, `handle: ${handle}`, `date: ${date}`,
    "I operate this wallet and the Nayori agents it registers independently. I am not a member of the PerkOS team and PerkOS does not hold this wallet's keys."].join("\n");
}
function varint(n) { if (n < 0xfd) return Uint8Array.from([n]); if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >> 8) & 0xff]); return Uint8Array.from([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }
export function sip018Hash(message) {
  const enc = new TextEncoder(); const prefix = enc.encode("\x17Stacks Signed Message:\n"); const body = enc.encode(message); const len = varint(body.length);
  const bytes = new Uint8Array(prefix.length + len.length + body.length); bytes.set(prefix, 0); bytes.set(len, prefix.length); bytes.set(body, prefix.length + len.length);
  return createHash("sha256").update(bytes).digest("hex");
}
export async function attest(name, { handle, roles, kind = "independent-developer", links = {} }) {
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(handle ?? "")) throw new Error("--handle: 2 to 40 characters, letters, digits, dot, dash or underscore");
  for (const r of roles) if (!ROLES.includes(r)) throw new Error(`--roles: use a comma-separated subset of ${ROLES.join(", ")}`);
  const address = readWalletAddress(name);
  const date = new Date().toISOString().slice(0, 10);
  const message = attestationMessage({ handle, address, date });
  const hash = sip018Hash(message);
  const provider = keyProvider(name);
  let privateKey = await provider();
  const signature = signMessageHashRsv({ messageHash: hash, privateKey });
  const publicKey = privateKeyToPublic(privateKey);
  privateKey = undefined;
  if (publicKeyFromSignatureRsv(hash, signature).toLowerCase() !== publicKey.toLowerCase() || getAddressFromPrivateKey(await provider(), NETWORK) !== address) throw new Error("self-check failed");
  const agentIds = []; const n = await reader.getAgentCount();
  for (let id = n; id >= 1n; id--) { const a = await reader.getAgent(id).catch(() => null); if (a && a.wallet === address) agentIds.push(Number(id)); }
  return { handle, kind, ...(Object.keys(links).length ? { links } : {}), wallet: { address, roles }, agentIds: agentIds.sort((a, b) => a - b), attestation: { message, signature, publicKey, signedAt: new Date().toISOString() } };
}
