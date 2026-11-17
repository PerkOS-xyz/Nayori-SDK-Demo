// The next Nayori contract generation (nayori-escrow-sbtc, nayori-escrow-stx, nayori-applications,
// nayori-agents, nayori-permissions ...). UPCOMING, NOT DEPLOYED YET: every command here needs the
// deployer address from --deployer or NAYORI_NEXT_DEPLOYER, and refuses to run without one.
// Selected with --generation next (or NAYORI_GENERATION=next); the current contracts stay the default.
//
// The keeper logic is pure (keeperDueForJob, planNextKeeper, runNextKeeper) and takes its reads and
// writes from a context object, so it is tested without the network.

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  NayoriNextClient,
  NAYORI_NEXT_LIMITS,
  assertNayoriNextDeployed,
  describeNayoriNextError,
  quoteNayoriNextFee,
  resolveNayoriNextConfig,
} from "@perkos/agent-sdk";

export const GENERATIONS = ["current", "next"];
export const ASSETS = ["sbtc", "stx"];
/** Statuses in which a job still takes applications (nayori-applications `accepting`). */
export const ACCEPTING = new Set(["open", "funded", "offered"]);
export const DEFAULT_DELIVERY_BLOCKS = 144n;
export const DEFAULT_REVIEW_BLOCKS = 144n;

// ---------- selection and configuration ----------

/** "current" unless --generation or NAYORI_GENERATION says "next". */
export function generationOf(flagValue, env = process.env) {
  const g = String(flagValue ?? env.NAYORI_GENERATION ?? "current").trim().toLowerCase();
  if (!GENERATIONS.includes(g)) throw new Error(`--generation must be "current" or "next" (got "${g}")`);
  return g;
}

/** The deployer of the next contracts, from --deployer or NAYORI_NEXT_DEPLOYER. Undefined = not deployed. */
export function nextDeployer(flagValue, env = process.env) {
  const d = flagValue ?? env.NAYORI_NEXT_DEPLOYER;
  return d && d.trim() ? d.trim() : undefined;
}

/** Resolved SDK config; `deployed` is false until a real deployer is given. */
export function nextConfig({ network, deployer }) {
  return resolveNayoriNextConfig({ network, ...(deployer ? { deployer } : {}) });
}

export function requireDeployed(config) {
  try {
    assertNayoriNextDeployed(config);
  } catch {
    throw new Error(`the next Nayori contracts are not deployed on ${config.network} yet. ` +
      "When they are, pass --deployer <address> or set NAYORI_NEXT_DEPLOYER. The current contracts need no flag.");
  }
}

// ---------- small parsers ----------

export function parseJobId(value) {
  if (!value || !/^[1-9][0-9]*$/.test(String(value))) throw new Error("--job <id> is required");
  return BigInt(value);
}
export function parseAsset(value) {
  const a = String(value ?? "sbtc").toLowerCase();
  if (!ASSETS.includes(a)) throw new Error(`--asset must be sbtc or stx (got "${a}")`);
  return a;
}
export function parseUint(value, name, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return BigInt(fallback);
    throw new Error(`${name} is required`);
  }
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${name} must be a whole number (got "${value}")`);
  return BigInt(value);
}
export function parseDecision(value) {
  const d = String(value ?? "").toLowerCase();
  if (d === "approve" || d === "reject") return d;
  throw new Error('--decision must be "approve" or "reject"');
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
/** A 32-byte hash from --<name>-hash <hex> or the sha256 of --<name>-file <path>. */
export function hashFrom(flag, name, readFile = readFileSync) {
  const hex = flag(`--${name}-hash`);
  const file = flag(`--${name}-file`);
  if (hex && file) throw new Error(`give --${name}-hash or --${name}-file, not both`);
  if (hex) {
    const h = hex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(h) || /^0+$/.test(h)) throw new Error(`--${name}-hash must be 32 non-zero bytes in hex`);
    return h.toLowerCase();
  }
  if (file) return sha256(readFile(resolve(file))).toString("hex");
  throw new Error(`--${name}-hash <hex> or --${name}-file <path> is required`);
}
/** The on-chain deliverable: ASCII text up to 64 bytes, or the sha256 of a file (32 bytes). */
export function deliverableFrom(flag, readFile = readFileSync) {
  const text = flag("--deliverable");
  const file = flag("--file");
  if (text && file) throw new Error("give --deliverable or --file, not both");
  if (file) return { value: new Uint8Array(sha256(readFile(resolve(file)))), shown: `sha256 of ${file}` };
  if (text) {
    if (!/^[\x20-\x7e]{1,64}$/.test(text)) throw new Error("--deliverable must be 1 to 64 printable ASCII characters (or use --file)");
    return { value: text, shown: `"${text}"` };
  }
  throw new Error("--deliverable <text up to 64 chars> or --file <path> (its sha256 goes on-chain) is required");
}
const isAddress = (a) => /^S[PTMN][0-9A-Z]{38,40}$/.test(a ?? "");

/** "(err u314)" -> "(err u314) ERR_TOO_EARLY: The window ..." */
export function explainResult(repr) {
  const m = /\(err u(\d+)\)/.exec(repr ?? "");
  const info = m ? describeNayoriNextError(Number(m[1])) : undefined;
  return info ? `${repr} ${info.name}: ${info.message}` : (repr ?? "");
}
/** The job id from a create-job result "(ok u7)". */
export function createdJobId(repr) {
  const m = /^\(ok u(\d+)\)$/.exec(repr ?? "");
  return m ? BigInt(m[1]) : null;
}

// ---------- keeper ----------

/**
 * What a permissionless caller may do with a job at Bitcoin block `tip`, mirroring the contract checks:
 *   submitted, tip >  review deadline      -> record-default-approval
 *   decided,   tip >  appeal deadline      -> settle-job
 *   disputed,  tip >  resolution deadline  -> settle-job
 *   funded/offered/accepted, tip >= deadline -> refund-no-delivery
 *   open,      tip >= deadline             -> close-unfunded
 * Returns null when nothing is due.
 */
export function keeperDueForJob({ job, submission, decision, tip }) {
  if (!job) return null;
  const t = BigInt(tip);
  switch (job.status) {
    case "submitted":
      if (submission && t > submission.reviewDeadline) return { action: "record-default-approval", why: `no decision, review window closed at ${submission.reviewDeadline}` };
      return null;
    case "decided":
      if (decision && t > decision.appealDeadline) return { action: "settle-job", why: `${decision.byDefault ? "default " : ""}${decision.decision}, appeal window closed at ${decision.appealDeadline}` };
      return null;
    case "disputed":
      if (decision && decision.resolutionDeadline !== undefined && t > decision.resolutionDeadline) return { action: "settle-job", why: `appeal unresolved, resolution window closed at ${decision.resolutionDeadline}; the ${decision.decision} stands` };
      return null;
    case "funded":
    case "offered":
    case "accepted":
      if (t >= job.deliveryDeadline) return { action: "refund-no-delivery", why: `${job.status}, no delivery by ${job.deliveryDeadline}` };
      return null;
    case "open":
      if (t >= job.deliveryDeadline) return { action: "close-unfunded", why: `never funded, deadline ${job.deliveryDeadline} passed` };
      return null;
    default:
      return null;
  }
}

/** Reads one job with whatever its status needs to decide. */
async function readJobState(read, asset, id) {
  const job = await read.getJob(asset, id);
  if (!job) return { job: null };
  const submission = job.status === "submitted" ? await read.getSubmission(asset, id) : null;
  const decision = job.status === "decided" || job.status === "disputed" ? await read.getDecision(asset, id) : null;
  return { job, submission, decision };
}

/**
 * One scan of both escrows. `read` is a NayoriNextClient (or a stand-in with the same read methods).
 * Application deposits are released only for sBTC jobs that no longer take applications.
 */
export async function planNextKeeper(read, { tip, assets = ASSETS, onError = () => {} } = {}) {
  const due = [];
  const counts = {};
  for (const asset of assets) {
    const count = await read.getJobCount(asset);
    counts[asset] = count;
    for (let id = 1n; id <= count; id++) {
      let state;
      try { state = await readJobState(read, asset, id); } catch (error) { onError(asset, id, error); continue; }
      if (!state.job) continue;
      const item = keeperDueForJob({ ...state, tip });
      if (item) due.push({ asset, id, ...item });
      if (asset === "sbtc" && !ACCEPTING.has(state.job.status)) {
        const applications = await read.getApplications(id).catch((error) => { onError(asset, id, error); return []; });
        for (const a of applications) due.push({ asset, id, action: "release", applicant: a.applicant, deposit: a.deposit, why: `job ${state.job.status}, deposit ${a.deposit} sats goes back to ${a.applicant}` });
      }
    }
  }
  return { counts, tip: BigInt(tip), due };
}

/** Is the item still due right now? Guards against another keeper (or the parties) having acted first. */
export async function stillDue(read, item, tip) {
  if (item.action === "release") {
    const [job, app] = await Promise.all([read.getJob("sbtc", item.id), read.getApplication(item.id, item.applicant)]);
    return Boolean(job && !ACCEPTING.has(job.status) && app);
  }
  const again = keeperDueForJob({ ...(await readJobState(read, item.asset, item.id)), tip });
  return again?.action === item.action;
}

/** Key of a contract call, to match the keeper wallet's own pending (mempool) transactions. */
export function callKey(contract, functionName, argReprs) {
  return `${contract}|${functionName}|${argReprs.join(",")}`;
}
export function itemKey(config, item) {
  if (item.action === "release") return callKey(config.contracts.applications, "release", [`u${item.id}`, `'${item.applicant}`]);
  const contract = item.asset === "sbtc" ? config.contracts.escrowSbtc : config.contracts.escrowStx;
  return callKey(contract, item.action, [`u${item.id}`]);
}

async function send(nayori, item) {
  switch (item.action) {
    case "record-default-approval": return nayori.recordDefaultApproval({ asset: item.asset, jobId: item.id });
    case "settle-job": return nayori.settleJob(item.asset, item.id);
    case "refund-no-delivery": return nayori.refundNoDelivery(item.asset, item.id);
    case "close-unfunded": return nayori.closeUnfunded({ asset: item.asset, jobId: item.id });
    case "release": return nayori.releaseApplication(item.id, item.applicant);
    default: throw new Error(`unknown keeper action ${item.action}`);
  }
}

/**
 * One keeper pass: scan, then for each due item re-check the live state, skip it if the keeper
 * wallet already has the same call pending, and otherwise sign it and wait for the block.
 * Only permissionless functions are ever called; the keeper wallet pays fees and never receives funds.
 * ctx: { reader, config, tip(), say(), confirm(nayori, receipt, label), pendingCalls?(address) }
 * wallet: { name, nayori, signer } or null for a dry run.
 */
export async function runNextKeeper(ctx, wallet, { dryRun = false } = {}) {
  const tip = await ctx.tip();
  const { counts, due } = await planNextKeeper(ctx.reader, { tip, onError: (asset, id, e) => ctx.say(`${asset} job #${id}: read failed (${e.message}); skipped this pass`) });
  ctx.say(`keeper (next): ${counts.sbtc ?? 0n} sBTC and ${counts.stx ?? 0n} STX jobs scanned at Bitcoin block ${tip}; ${due.length} due`);
  const done = [];
  const skipped = [];
  const failed = [];
  if (due.length === 0) return { tip, due, done, skipped, failed };
  let pending = new Set();
  if (!dryRun && ctx.pendingCalls) {
    const address = await wallet.signer.getAddress();
    pending = await ctx.pendingCalls(address).catch((e) => { ctx.say(`could not read pending transactions (${e.message}); relying on the live re-check`); return new Set(); });
  }
  for (const item of due) {
    const label = `${item.asset} job #${item.id}: ${item.action}${item.applicant ? ` ${item.applicant}` : ""}`;
    ctx.say(`${label} (${item.why})${dryRun ? " [dry run, nothing signed]" : ""}`);
    if (dryRun) continue;
    try {
      if (pending.has(itemKey(ctx.config, item))) { ctx.say(`  already pending from this wallet; skipped`); skipped.push(item); continue; }
      if (!(await stillDue(ctx.reader, item, tip))) { ctx.say(`  no longer due (someone acted first); skipped`); skipped.push(item); continue; }
      const receipt = await send(wallet.nayori, item);
      await ctx.confirm(wallet.nayori, receipt, item.action);
      done.push(item);
    } catch (error) {
      ctx.say(`  failed (${error.message.split("\n")[0]}); it stays due for the next pass`);
      failed.push(item);
    }
  }
  return { tip, due, done, skipped, failed };
}

/**
 * Runs `fn` only if no other keeper pass holds the lock file. A lock left by a process that no
 * longer exists is removed. Returns { ran: false, holder } when another pass is running.
 */
export async function withKeeperLock(path, fn, { isAlive = processAlive } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      try { return { ran: true, result: await fn() }; } finally { try { unlinkSync(path); } catch {} }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = null;
      try { holder = JSON.parse(readFileSync(path, "utf8")); } catch {}
      if (holder && Number.isInteger(holder.pid) && isAlive(holder.pid)) return { ran: false, holder };
      try { unlinkSync(path); } catch {} // stale lock: its process is gone
    }
  }
  return { ran: false, holder: null };
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } // signal 0 only checks existence
}

// ---------- commands ----------

const units = (asset) => (asset === "sbtc" ? "sats" : "micro-STX");
const policyFor = (asset, amount) => ({ maxPerTransaction: { [asset]: amount }, maxPerSession: { [asset]: amount } });
const fundsFor = (asset, amount, purpose) => (asset === "sbtc" ? { stx: 0.05, sats: Number(amount), purpose } : { stx: 0.05 + Number(amount) / 1e6, purpose });

async function signer(ctx, a, { spendingPolicy, funds } = {}) {
  const name = a.wallet();
  const w = ctx.actor(name, spendingPolicy);
  const address = await w.signer.getAddress();
  await ctx.requireFunds(name, address, funds ?? { stx: 0.01, purpose: "the transaction fee" });
  return { ...w, address };
}
async function requireJob(ctx, asset, id) {
  const job = await ctx.reader.getJob(asset, id);
  if (!job) throw new Error(`${asset} job #${id} not found on ${ctx.config.contracts[asset === "sbtc" ? "escrowSbtc" : "escrowStx"]}`);
  return job;
}
/** A permissionless call: refuse early (no fee spent) when the job is not due yet. */
async function permissionless(ctx, a, action) {
  const asset = parseAsset(a.flag("--asset"));
  const id = parseJobId(a.flag("--job"));
  const [state, tip] = await Promise.all([readJobState(ctx.reader, asset, id), ctx.tip()]);
  if (!state.job) throw new Error(`${asset} job #${id} not found`);
  const due = keeperDueForJob({ ...state, tip });
  if (due?.action !== action) throw new Error(`${asset} job #${id} is ${state.job.status}; ${action} is not due at Bitcoin block ${tip}${due ? ` (due instead: ${due.action})` : ""}. See: nayori status --generation next --job ${id}${asset === "stx" ? " --asset stx" : ""}`);
  const w = await signer(ctx, a);
  const receipt = await send(w.nayori, { action, asset, id });
  await ctx.confirm(w.nayori, receipt, action);
  return { asset, id };
}

export const NEXT_COMMANDS = {
  "create-job": async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const job = a.jobFile?.() ?? {};
    const evaluator = a.flag("--evaluator") ?? ctx.env?.NAYORI_NEXT_EVALUATOR;
    if (!isAddress(evaluator)) throw new Error("--evaluator <address> is required (or NAYORI_NEXT_EVALUATOR); the next generation has no default evaluator yet");
    const budget = parseUint(a.flag("--budget") ?? (asset === "sbtc" ? job.budgetSats : undefined), "--budget");
    const { min, max } = NAYORI_NEXT_LIMITS.budget[asset];
    if (budget < min || budget > max) throw new Error(`--budget must be ${min} to ${max} ${units(asset)}`);
    const deliveryBlocks = parseUint(a.flag("--delivery-blocks"), "--delivery-blocks", DEFAULT_DELIVERY_BLOCKS);
    const reviewBlocks = parseUint(a.flag("--review-blocks"), "--review-blocks", DEFAULT_REVIEW_BLOCKS);
    const description = a.flag("--description") ?? (job.task && Array.isArray(job.criteria) && ctx.plainDescription ? ctx.plainDescription(job.task, job.criteria) : undefined);
    if (!description) throw new Error('--description "<what to do, max 512 ASCII characters>" is required (or task and criteria in job.json)');
    const fund = !a.has("--no-fund");
    const w = await signer(ctx, a, { spendingPolicy: policyFor(asset, budget), funds: fund ? fundsFor(asset, budget, "the create and fund transactions") : { stx: 0.02, purpose: "the create-job transaction" } });
    const fee = quoteNayoriNextFee(budget);
    ctx.step?.(`CREATE ${fund ? "AND FUND " : ""}A NEXT-GENERATION ${asset.toUpperCase()} JOB. Wallet "${w.name}".`);
    ctx.say(`budget ${budget} ${units(asset)} (provider ${fee.net}, treasury fee ${fee.fee} on settlement), delivery ${deliveryBlocks} and review ${reviewBlocks} Bitcoin blocks`, `evaluator ${evaluator}`);
    const created = await w.nayori.createJob({ asset, evaluator, budget, deliveryBlocks, reviewBlocks, description, client: w.address });
    const c = await ctx.confirm(w.nayori, created, "create-job");
    const id = createdJobId(c?.result?.repr) ?? (await ctx.reader.getJobCount(asset));
    ctx.say(`job #${id} created on ${asset === "sbtc" ? ctx.config.contracts.escrowSbtc : ctx.config.contracts.escrowStx}`);
    if (fund) {
      const funded = await w.nayori.fundJob(asset, id);
      await ctx.confirm(w.nayori, funded, "fund-job");
    } else ctx.say(`next: nayori fund --generation next --wallet ${w.name} --job ${id}${asset === "stx" ? " --asset stx" : ""}`);
    const provider = a.flag("--provider");
    if (provider && fund) {
      const named = await w.nayori.nameProvider(asset, id, provider);
      await ctx.confirm(w.nayori, named, "name-provider");
    }
    return { asset, id };
  },
  fund: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const job = await requireJob(ctx, asset, id);
    if (job.status !== "open") throw new Error(`${asset} job #${id} is ${job.status}; only an open job can be funded`);
    const w = await signer(ctx, a, { spendingPolicy: policyFor(asset, job.budget), funds: fundsFor(asset, job.budget, "the fund-job transaction") });
    if (job.client !== w.address) throw new Error(`job #${id} belongs to ${job.client}, not to wallet "${w.name}"`);
    const receipt = await w.nayori.fundJob(asset, id);
    await ctx.confirm(w.nayori, receipt, "fund-job");
    return { asset, id };
  },
  "name-provider": async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const provider = a.flag("--provider");
    if (!isAddress(provider)) throw new Error("--provider <address> is required");
    const w = await signer(ctx, a);
    const receipt = await w.nayori.nameProvider(asset, id, provider);
    await ctx.confirm(w.nayori, receipt, "name-provider");
    ctx.say(`offered to ${provider}; it accepts with: nayori accept --generation next --wallet <provider> --job ${id}`);
    return { asset, id };
  },
  accept: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const job = await requireJob(ctx, asset, id);
    const w = await signer(ctx, a);
    if (job.status !== "offered" || job.provider !== w.address) throw new Error(`job #${id} is ${job.status}${job.provider ? `, offered to ${job.provider}` : ""}; wallet "${w.name}" cannot accept it`);
    const receipt = await w.nayori.acceptJob({ asset, jobId: id });
    await ctx.confirm(w.nayori, receipt, "accept-job");
    ctx.say(`accepted: deliver within ${job.deliveryBlocks} Bitcoin blocks`);
    return { asset, id };
  },
  submit: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const deliverable = deliverableFrom(a.flag, ctx.readFile);
    const w = await signer(ctx, a);
    ctx.say(`deliverable on-chain: ${deliverable.shown}`);
    const receipt = await w.nayori.submitWork({ asset, jobId: id, deliverable: deliverable.value });
    await ctx.confirm(w.nayori, receipt, "submit-work");
    return { asset, id };
  },
  decide: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const decision = parseDecision(a.flag("--decision"));
    const evidenceHash = hashFrom(a.flag, "evidence", ctx.readFile);
    const w = await signer(ctx, a);
    const receipt = await w.nayori.recordDecision({ asset, jobId: id, decision, evidenceHash });
    await ctx.confirm(w.nayori, receipt, "record-decision");
    ctx.say(`decision ${decision} recorded; the losing side may appeal for ${NAYORI_NEXT_LIMITS.appealBlocks} Bitcoin blocks`);
    return { asset, id };
  },
  "default-approval": (ctx, a) => permissionless(ctx, a, "record-default-approval"),
  appeal: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const evidenceHash = hashFrom(a.flag, "evidence", ctx.readFile);
    const w = await signer(ctx, a);
    const receipt = await w.nayori.appeal({ asset, jobId: id, evidenceHash });
    await ctx.confirm(w.nayori, receipt, "appeal");
    return { asset, id };
  },
  "resolve-appeal": async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const decision = parseDecision(a.flag("--decision"));
    const resolutionHash = hashFrom(a.flag, "resolution", ctx.readFile);
    const w = await signer(ctx, a);
    const receipt = await w.nayori.resolveAppeal({ asset, jobId: id, decision, resolutionHash });
    await ctx.confirm(w.nayori, receipt, "resolve-appeal");
    return { asset, id };
  },
  settle: (ctx, a) => permissionless(ctx, a, "settle-job"),
  refund: (ctx, a) => permissionless(ctx, a, "refund-no-delivery"),
  close: (ctx, a) => permissionless(ctx, a, "close-unfunded"),
  rate: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const score = parseUint(a.flag("--score"), "--score");
    if (score < 1n || score > 5n) throw new Error("--score must be 1 to 5");
    const w = await signer(ctx, a);
    const receipt = await w.nayori.rateProvider({ asset, jobId: id, score });
    await ctx.confirm(w.nayori, receipt, "rate-provider");
    return { asset, id };
  },
  register: async (ctx, a) => {
    const name = a.flag("--name");
    if (!name) throw new Error('--name "<agent name>" is required');
    const uri = a.flag("--uri") ?? "";
    const w = await signer(ctx, a);
    if (await ctx.reader.isRegisteredAgent(w.address)) { ctx.say(`wallet ${w.address} already has an agent in nayori-agents (one per wallet)`); return { address: w.address }; }
    const receipt = await w.nayori.registerAgent({ name, uri });
    await ctx.confirm(w.nayori, receipt, "register-agent");
    return { address: w.address };
  },
  apply: async (ctx, a) => {
    const id = parseJobId(a.flag("--job"));
    const deposit = parseUint(a.flag("--deposit"), "--deposit");
    const { min, max } = NAYORI_NEXT_LIMITS.applicationDeposit;
    if (deposit < min || deposit > max) throw new Error(`--deposit must be ${min} to ${max} sats`);
    const w = await signer(ctx, a, { spendingPolicy: policyFor("sbtc", deposit), funds: { stx: 0.01, sats: Number(deposit), purpose: "the apply-to-job transaction" } });
    const receipt = await w.nayori.applyToJob({ jobId: id, deposit });
    await ctx.confirm(w.nayori, receipt, "apply-to-job");
    ctx.say(`applied to sBTC job #${id} with a ${deposit} sats deposit; it comes back on withdraw, decline or release`);
    return { id };
  },
  withdraw: async (ctx, a) => {
    const id = parseJobId(a.flag("--job"));
    const w = await signer(ctx, a);
    const receipt = await w.nayori.withdrawApplication(id);
    await ctx.confirm(w.nayori, receipt, "withdraw-application");
    return { id };
  },
  decline: async (ctx, a) => {
    const id = parseJobId(a.flag("--job"));
    const applicant = a.flag("--applicant");
    if (!isAddress(applicant)) throw new Error("--applicant <address> is required");
    const w = await signer(ctx, a);
    const receipt = await w.nayori.declineApplication(id, applicant);
    await ctx.confirm(w.nayori, receipt, "decline-application");
    return { id };
  },
  release: async (ctx, a) => {
    const id = parseJobId(a.flag("--job"));
    const applicant = a.flag("--applicant");
    if (!isAddress(applicant)) throw new Error("--applicant <address> is required");
    const job = await requireJob(ctx, "sbtc", id);
    if (ACCEPTING.has(job.status)) throw new Error(`sBTC job #${id} is ${job.status} and still takes applications; deposits are released once it moves on`);
    const w = await signer(ctx, a);
    const receipt = await w.nayori.releaseApplication(id, applicant);
    await ctx.confirm(w.nayori, receipt, "release-application");
    return { id };
  },
  "allow-caller": async (ctx, a) => {
    const caller = a.flag("--caller");
    const target = a.flag("--target");
    if (!caller || !target) throw new Error("--caller <contract id> and --target <escrowSbtc|escrowStx|agents|applications|contract id> are required");
    const untilFlag = a.flag("--until");
    const until = untilFlag === undefined ? undefined : parseUint(untilFlag, "--until");
    const w = await signer(ctx, a);
    const receipt = await w.nayori.allowContractCaller({ caller, target, ...(until !== undefined ? { until } : {}) });
    await ctx.confirm(w.nayori, receipt, "allow-contract-caller");
    ctx.say(`${caller} may now call ${target} for ${w.address}${until !== undefined ? ` until Bitcoin block ${until}` : " (no expiry)"}`);
    return { caller, target };
  },
  "disallow-caller": async (ctx, a) => {
    const caller = a.flag("--caller");
    const target = a.flag("--target");
    if (!caller || !target) throw new Error("--caller <contract id> and --target <escrowSbtc|escrowStx|agents|applications|contract id> are required");
    const w = await signer(ctx, a);
    const receipt = await w.nayori.disallowContractCaller({ caller, target });
    await ctx.confirm(w.nayori, receipt, "disallow-contract-caller");
    return { caller, target };
  },
  status: async (ctx, a) => {
    const asset = parseAsset(a.flag("--asset"));
    const id = parseJobId(a.flag("--job"));
    const [state, tip] = await Promise.all([readJobState(ctx.reader, asset, id), ctx.tip()]);
    const { job, submission, decision } = state;
    if (!job) throw new Error(`${asset} job #${id} not found`);
    const escrow = await ctx.reader.getEscrowBalance(asset, id);
    ctx.say(`${asset} job #${id} (next generation): ${job.status} | budget ${job.budget} ${units(asset)} | escrow ${escrow}`,
      `client ${job.client}`, `provider ${job.provider ?? "(none yet)"}`, `evaluator ${job.evaluator}`,
      `deadline ${job.deliveryDeadline} | review ${job.reviewBlocks} blocks | Bitcoin block now ${tip}`, `description: ${job.description}`);
    if (submission) ctx.say(`submitted; review deadline ${submission.reviewDeadline}`);
    if (decision) ctx.say(`decision ${decision.decision}${decision.byDefault ? " (default)" : ""}, appeal deadline ${decision.appealDeadline}${decision.resolutionDeadline !== undefined ? `, appealed by ${decision.appellant}, resolution deadline ${decision.resolutionDeadline}` : ""}`);
    if (asset === "sbtc") {
      const apps = await ctx.reader.getApplications(id);
      if (apps.length) ctx.say(`applications: ${apps.map((x) => `${x.applicant} (${x.deposit} sats)`).join(", ")}`);
    }
    const due = keeperDueForJob({ ...state, tip });
    if (due) ctx.say(`due now (anyone, or the keeper): ${due.action} (${due.why})`);
    return { job, submission, decision, escrow, due };
  },
};
/** Same verbs as the current generation, mapped to the next one. */
export const NEXT_ALIASES = { hire: "name-provider", deliver: "submit", evaluate: "decide", finalize: "settle" };

/** Runs a next-generation command (not the keeper, which nayori.mjs loops). */
export async function runNextCommand(cmd, ctx, a) {
  const name = NEXT_ALIASES[cmd] ?? cmd;
  const fn = NEXT_COMMANDS[name];
  if (!fn) throw new Error(`"${cmd}" is not a next-generation command. Next-generation commands: ${Object.keys(NEXT_COMMANDS).join(", ")}, keeper`);
  return fn(ctx, a);
}

// ---------- the real context (network, wallets) ----------

/** Wires the SDK client, the wallet store and the Hiro API. `N` is lib.mjs. */
export function makeNextContext(N, { deployer, env = process.env } = {}) {
  const network = N.NETWORK;
  const config = nextConfig({ network, deployer });
  requireDeployed(config);
  const base = { network, deployer };
  return {
    network, config, env,
    reader: new NayoriNextClient(base),
    actor: (name, spendingPolicy) => {
      const signer = N.signerFor(name);
      return { name, signer, nayori: new NayoriNextClient({ ...base, signer, ...(spendingPolicy ? { spendingPolicy } : {}) }) };
    },
    tip: () => N.burnTip(),
    say: N.say,
    step: N.step,
    requireFunds: N.requireFunds,
    plainDescription: N.plainDescription,
    readFile: readFileSync,
    async confirm(nayori, receipt, label) {
      N.say(`${label} broadcast, waiting for the Stacks block...`);
      const c = await nayori.confirm(receipt, { timeoutMs: 15 * 60_000, pollIntervalMs: 15_000 });
      if (c.status !== "success") throw new Error(`${label} did not succeed: ${c.status} ${explainResult(c.result?.repr)}`);
      N.journal.push({ label, txid: receipt.txid });
      N.say(`${label}: ${receipt.txid}`, `  ${N.link(receipt.txid)}`);
      await N.sleep(10_000); // let the API observe the new nonce before the same wallet signs again
      return c;
    },
    /** Contract calls this wallet has waiting in the mempool, as callKey strings. */
    async pendingCalls(address) {
      const res = await fetch(`${N.P.hiro}/extended/v1/tx/mempool?sender_address=${address}&limit=50`);
      if (!res.ok) throw new Error(`mempool HTTP ${res.status}`);
      const body = await res.json();
      return pendingKeys(body.results ?? []);
    },
  };
}
export function pendingKeys(txs) {
  return new Set(txs.filter((t) => t.tx_type === "contract_call" && t.contract_call)
    .map((t) => callKey(t.contract_call.contract_id, t.contract_call.function_name, (t.contract_call.function_args ?? []).map((x) => x.repr))));
}
export const keeperLockPath = (walletDir) => resolve(walletDir, "..", "keeper-next.lock");
