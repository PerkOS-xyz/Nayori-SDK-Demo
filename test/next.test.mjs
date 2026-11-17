// Next contract generation: command and keeper logic against an in-memory read layer. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as X from "../next.mjs";

const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const CLIENT = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const PROVIDER = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const EVALUATOR = "ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC";
const APPLICANT = "ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND";
const KEEPER = "ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB";
const config = X.nextConfig({ network: "testnet", deployer: DEPLOYER });

const job = (id, status, extra = {}) => ({ id: BigInt(id), status, client: CLIENT, evaluator: EVALUATOR, provider: PROVIDER, budget: 10_000n, deliveryDeadline: 1_000n, deliveryBlocks: 144n, reviewBlocks: 12n, description: "d", ...extra });

/** An in-memory read layer with the NayoriNextClient read methods the CLI uses. */
function fakeReader({ sbtc = [], stx = [], submissions = {}, decisions = {}, applications = {} } = {}) {
  const jobs = { sbtc: new Map(sbtc.map((j) => [j.id, j])), stx: new Map(stx.map((j) => [j.id, j])) };
  const reads = [];
  return {
    jobs, applications, reads,
    async getJobCount(asset) { reads.push(["count", asset]); return BigInt(jobs[asset].size); },
    async getJob(asset, id) { reads.push(["job", asset, id]); return jobs[asset].get(BigInt(id)) ?? null; },
    async getSubmission(asset, id) { return submissions[`${asset}:${id}`] ?? null; },
    async getDecision(asset, id) { return decisions[`${asset}:${id}`] ?? null; },
    async getApplications(id) { reads.push(["apps", id]); return applications[String(id)] ?? []; },
    async getApplication(id, applicant) { return (applications[String(id)] ?? []).find((a) => a.applicant === applicant) ?? null; },
    async getEscrowBalance() { return 10_000n; },
    async isRegisteredAgent() { return false; },
  };
}
/** A signing stand-in that records each write instead of broadcasting it. */
function fakeWallet(address = KEEPER, { failOn = [] } = {}) {
  const calls = [];
  const rec = (name) => async (...args) => { if (failOn.includes(name)) throw new Error(`${name} rejected`); calls.push([name, ...args]); return { txid: `0x${String(calls.length).padStart(64, "0")}` }; };
  const nayori = new Proxy({}, { get: (_, name) => rec(name) });
  return { name: "w", calls, nayori, signer: { getAddress: async () => address } };
}
function ctxWith(reader, { tip = 2_000n, wallet = fakeWallet(), pending = new Set(), flags = {}, confirmResult } = {}) {
  const lines = [];
  const funds = [];
  const actors = [];
  return {
    lines, funds, actors, wallet,
    config, reader, env: {},
    tip: async () => tip,
    say: (...l) => lines.push(...l),
    step: (l) => lines.push(l),
    requireFunds: async (name, address, need) => { funds.push({ name, address, need }); },
    actor: (name, spendingPolicy) => { actors.push({ name, spendingPolicy }); return wallet; },
    confirm: async () => confirmResult ?? { status: "success" },
    pendingCalls: async () => pending,
    plainDescription: (task, criteria) => `${task}\nAcceptance criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    readFile: () => Buffer.from("hello"),
  };
}
const args = (flags, has = []) => ({ flag: (n) => flags[n], has: (n) => has.includes(n), wallet: () => flags["--wallet"] ?? "w" });

// ---------- selection ----------

test("generation defaults to current and accepts next from the flag or the env", () => {
  assert.equal(X.generationOf(undefined, {}), "current");
  assert.equal(X.generationOf("next", {}), "next");
  assert.equal(X.generationOf(undefined, { NAYORI_GENERATION: "NEXT" }), "next");
  assert.throws(() => X.generationOf("v2", {}), /must be "current" or "next"/);
});

test("without a deployer the next generation is not deployed and commands refuse to run", () => {
  assert.equal(X.nextDeployer(undefined, {}), undefined);
  assert.equal(X.nextDeployer(undefined, { NAYORI_NEXT_DEPLOYER: DEPLOYER }), DEPLOYER);
  const placeholder = X.nextConfig({ network: "mainnet" });
  assert.equal(placeholder.deployed, false);
  assert.throws(() => X.requireDeployed(placeholder), /not deployed on mainnet yet/);
  assert.equal(config.deployed, true);
  assert.equal(config.contracts.escrowSbtc, `${DEPLOYER}.nayori-escrow-sbtc`);
  X.requireDeployed(config);
});

test("the CLI's makeNextContext refuses a missing deployer", () => {
  const N = { NETWORK: "mainnet" };
  assert.throws(() => X.makeNextContext(N, {}), /not deployed on mainnet yet/);
});

// ---------- keeper rules (mirror the contract checks) ----------

test("keeperDueForJob follows each contract window, strict and inclusive bounds included", () => {
  const sub = { reviewDeadline: 100n };
  assert.equal(X.keeperDueForJob({ job: job(1, "submitted"), submission: sub, tip: 100n }), null);
  assert.equal(X.keeperDueForJob({ job: job(1, "submitted"), submission: sub, tip: 101n }).action, "record-default-approval");

  const decided = { decision: "approve", byDefault: false, appealDeadline: 200n };
  assert.equal(X.keeperDueForJob({ job: job(1, "decided"), decision: decided, tip: 200n }), null);
  assert.equal(X.keeperDueForJob({ job: job(1, "decided"), decision: decided, tip: 201n }).action, "settle-job");

  const disputed = { decision: "reject", byDefault: false, appealDeadline: 200n, appellant: PROVIDER, resolutionDeadline: 344n };
  assert.equal(X.keeperDueForJob({ job: job(1, "disputed"), decision: disputed, tip: 300n }), null);
  assert.equal(X.keeperDueForJob({ job: job(1, "disputed"), decision: disputed, tip: 345n }).action, "settle-job");

  for (const status of ["funded", "offered", "accepted"]) {
    assert.equal(X.keeperDueForJob({ job: job(1, status), tip: 999n }), null);
    assert.equal(X.keeperDueForJob({ job: job(1, status), tip: 1_000n }).action, "refund-no-delivery");
  }
  assert.equal(X.keeperDueForJob({ job: job(1, "open"), tip: 999n }), null);
  assert.equal(X.keeperDueForJob({ job: job(1, "open"), tip: 1_000n }).action, "close-unfunded");

  for (const status of ["completed", "rejected", "refunded", "expired"]) assert.equal(X.keeperDueForJob({ job: job(1, status), tip: 9_999n }), null);
});

test("planNextKeeper scans both escrows and releases deposits only of sBTC jobs that stopped taking applications", async () => {
  const reader = fakeReader({
    sbtc: [job(1, "submitted"), job(2, "open"), job(3, "completed"), job(4, "funded", { deliveryDeadline: 5_000n }), job(5, "decided")],
    stx: [job(1, "accepted"), job(2, "disputed")],
    submissions: { "sbtc:1": { reviewDeadline: 1_500n } },
    decisions: { "sbtc:5": { decision: "reject", byDefault: false, appealDeadline: 1_900n }, "stx:2": { decision: "approve", appealDeadline: 1_000n, appellant: CLIENT, resolutionDeadline: 2_500n } },
    applications: { 3: [{ applicant: APPLICANT, deposit: 500n }], 4: [{ applicant: APPLICANT, deposit: 700n }] },
  });
  const { due, counts } = await X.planNextKeeper(reader, { tip: 2_000n });
  assert.deepEqual(counts, { sbtc: 5n, stx: 2n });
  assert.deepEqual(due.map((d) => `${d.asset}#${d.id}:${d.action}`), [
    "sbtc#1:record-default-approval",
    "sbtc#2:close-unfunded",
    "sbtc#3:release",
    "sbtc#5:settle-job",
    "stx#1:refund-no-delivery",
  ]);
  assert.equal(due.find((d) => d.action === "release").applicant, APPLICANT);
  // job 4 still accepts applications (funded, before its deadline): its applications are not even read
  assert.ok(!reader.reads.some(([k, id]) => k === "apps" && id === 4n));
});

// ---------- keeper pass ----------

test("a dry run signs nothing", async () => {
  const reader = fakeReader({ sbtc: [job(1, "open")] });
  const ctx = ctxWith(reader);
  const r = await X.runNextKeeper(ctx, null, { dryRun: true });
  assert.equal(r.due.length, 1);
  assert.equal(r.done.length, 0);
  assert.ok(ctx.lines.some((l) => l.includes("dry run")));
});

test("a pass calls exactly the permissionless functions that are due", async () => {
  const reader = fakeReader({
    sbtc: [job(1, "submitted"), job(2, "decided"), job(3, "funded"), job(4, "open"), job(5, "refunded")],
    stx: [job(1, "disputed")],
    submissions: { "sbtc:1": { reviewDeadline: 10n } },
    decisions: { "sbtc:2": { decision: "approve", appealDeadline: 10n }, "stx:1": { decision: "reject", appealDeadline: 10n, appellant: PROVIDER, resolutionDeadline: 20n } },
    applications: { 5: [{ applicant: APPLICANT, deposit: 300n }] },
  });
  const ctx = ctxWith(reader);
  const r = await X.runNextKeeper(ctx, ctx.wallet);
  assert.equal(r.done.length, 6);
  assert.deepEqual(ctx.wallet.calls.map((c) => c[0]), ["recordDefaultApproval", "settleJob", "refundNoDelivery", "closeUnfunded", "releaseApplication", "settleJob"]);
  assert.deepEqual(ctx.wallet.calls[0][1], { asset: "sbtc", jobId: 1n });
  assert.deepEqual(ctx.wallet.calls[4].slice(1), [5n, APPLICANT]);
  assert.deepEqual(ctx.wallet.calls[5].slice(1), ["stx", 1n]);
});

test("the keeper is idempotent: a second pass over the settled state does nothing", async () => {
  const reader = fakeReader({ sbtc: [job(1, "decided")], decisions: { "sbtc:1": { decision: "approve", appealDeadline: 10n } } });
  const ctx = ctxWith(reader);
  await X.runNextKeeper(ctx, ctx.wallet);
  assert.equal(ctx.wallet.calls.length, 1);
  reader.jobs.sbtc.set(1n, job(1, "completed")); // what the chain shows after settle-job
  const second = await X.runNextKeeper(ctx, ctx.wallet);
  assert.equal(second.due.length, 0);
  assert.equal(ctx.wallet.calls.length, 1);
});

test("an item already pending from the keeper wallet, or settled by someone else meanwhile, is skipped", async () => {
  const reader = fakeReader({ sbtc: [job(1, "open"), job(2, "open")] });
  const pending = new Set([X.callKey(config.contracts.escrowSbtc, "close-unfunded", ["u1"])]);
  const ctx = ctxWith(reader, { pending });
  const getJob = reader.getJob.bind(reader);
  let n = 0;
  reader.getJob = async (asset, id) => { const j = await getJob(asset, id); return BigInt(id) === 2n && ++n > 1 ? job(2, "expired") : j; };
  const r = await X.runNextKeeper(ctx, ctx.wallet);
  assert.equal(r.skipped.length, 2);
  assert.equal(ctx.wallet.calls.length, 0);
});

test("one failing call does not stop the pass; it stays due for the next one", async () => {
  const reader = fakeReader({ sbtc: [job(1, "open"), job(2, "funded")] });
  const wallet = fakeWallet(KEEPER, { failOn: ["closeUnfunded"] });
  const ctx = ctxWith(reader, { wallet });
  const r = await X.runNextKeeper(ctx, wallet);
  assert.equal(r.failed.length, 1);
  assert.equal(r.done.length, 1);
  assert.equal(wallet.calls[0][0], "refundNoDelivery");
});

test("pendingKeys reads the Hiro mempool shape into call keys", () => {
  const keys = X.pendingKeys([
    { tx_type: "contract_call", contract_call: { contract_id: config.contracts.applications, function_name: "release", function_args: [{ repr: "u3" }, { repr: `'${APPLICANT}` }] } },
    { tx_type: "token_transfer" },
  ]);
  assert.ok(keys.has(X.itemKey(config, { action: "release", asset: "sbtc", id: 3n, applicant: APPLICANT })));
  assert.equal(keys.size, 1);
});

test("the keeper lock lets one pass run at a time and clears a stale lock", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "nayori-keeper-")), "keeper-next.lock");
  const inner = await X.withKeeperLock(path, async () => X.withKeeperLock(path, async () => "nested", { isAlive: () => true }));
  assert.equal(inner.ran, true);
  assert.equal(inner.result.ran, false);
  assert.equal(existsSync(path), false);
  writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: "x" }));
  const stale = await X.withKeeperLock(path, async () => "ok", { isAlive: () => false });
  assert.deepEqual(stale, { ran: true, result: "ok" });
});

// ---------- commands ----------

test("create-job creates with the given terms, funds under a cap equal to the budget and names the provider", async () => {
  const reader = fakeReader();
  const ctx = ctxWith(reader, { confirmResult: { status: "success", result: { repr: "(ok u7)" } } });
  const r = await X.runNextCommand("create-job", ctx, args({ "--evaluator": EVALUATOR, "--budget": "5000", "--review-blocks": "24", "--description": "Summarize the doc", "--provider": PROVIDER }));
  assert.deepEqual(r, { asset: "sbtc", id: 7n });
  const [create, fund, name] = ctx.wallet.calls;
  assert.equal(create[0], "createJob");
  assert.deepEqual(create[1], { asset: "sbtc", evaluator: EVALUATOR, budget: 5000n, deliveryBlocks: 144n, reviewBlocks: 24n, description: "Summarize the doc", client: KEEPER });
  assert.deepEqual(fund.slice(0, 3), ["fundJob", "sbtc", 7n]);
  assert.deepEqual(name.slice(0, 4), ["nameProvider", "sbtc", 7n, PROVIDER]);
  assert.deepEqual(ctx.actors[0].spendingPolicy, { maxPerTransaction: { sbtc: 5000n }, maxPerSession: { sbtc: 5000n } });
  assert.equal(ctx.funds[0].need.sats, 5000);
});

test("create-job checks bounds and the evaluator before signing", async () => {
  const ctx = ctxWith(fakeReader());
  await assert.rejects(X.runNextCommand("create-job", ctx, args({ "--budget": "5000", "--description": "x" })), /--evaluator/);
  await assert.rejects(X.runNextCommand("create-job", ctx, args({ "--evaluator": EVALUATOR, "--budget": "999", "--description": "x" })), /1000 to 100000000 sats/);
  await assert.rejects(X.runNextCommand("create-job", ctx, args({ "--evaluator": EVALUATOR, "--budget": "1000", "--asset": "stx", "--description": "x" })), /1000000 to 100000000000 micro-STX/);
  await assert.rejects(X.runNextCommand("create-job", ctx, args({ "--evaluator": EVALUATOR, "--budget": "5000" })), /--description/);
  assert.equal(ctx.wallet.calls.length, 0);
});

test("create-job --no-fund on STX only creates", async () => {
  const ctx = ctxWith(fakeReader({ stx: [job(1, "open")] }));
  const r = await X.runNextCommand("create-job", ctx, args({ "--evaluator": EVALUATOR, "--budget": "2000000", "--asset": "stx", "--description": "x" }, ["--no-fund"]));
  assert.deepEqual(r, { asset: "stx", id: 1n }); // no result repr: falls back to the job count
  assert.deepEqual(ctx.wallet.calls.map((c) => c[0]), ["createJob"]);
});

test("fund refuses another wallet's job and a job that is not open", async () => {
  const reader = fakeReader({ sbtc: [job(1, "open"), job(2, "funded")] });
  await assert.rejects(X.runNextCommand("fund", ctxWith(reader), args({ "--job": "1" })), /belongs to/);
  await assert.rejects(X.runNextCommand("fund", ctxWith(reader, { wallet: fakeWallet(CLIENT) }), args({ "--job": "2" })), /only an open job/);
  const ctx = ctxWith(reader, { wallet: fakeWallet(CLIENT) });
  await X.runNextCommand("fund", ctx, args({ "--job": "1" }));
  assert.deepEqual(ctx.wallet.calls[0].slice(0, 3), ["fundJob", "sbtc", 1n]);
  assert.deepEqual(ctx.actors[0].spendingPolicy.maxPerTransaction, { sbtc: 10_000n });
});

test("the lifecycle commands pass their arguments to the SDK", async () => {
  const reader = fakeReader({ sbtc: [job(1, "offered")] });
  const hex = "ab".repeat(32);
  const cases = [
    ["hire", { "--job": "1", "--provider": PROVIDER }, ["nameProvider", "sbtc", 1n, PROVIDER]],
    ["submit", { "--job": "1", "--deliverable": "ipfs://bafy" }, ["submitWork", { asset: "sbtc", jobId: 1n, deliverable: "ipfs://bafy" }]],
    ["decide", { "--job": "1", "--decision": "reject", "--evidence-hash": `0x${hex}` }, ["recordDecision", { asset: "sbtc", jobId: 1n, decision: "reject", evidenceHash: hex }]],
    ["appeal", { "--job": "1", "--evidence-hash": hex }, ["appeal", { asset: "sbtc", jobId: 1n, evidenceHash: hex }]],
    ["resolve-appeal", { "--job": "1", "--decision": "approve", "--resolution-hash": hex }, ["resolveAppeal", { asset: "sbtc", jobId: 1n, decision: "approve", resolutionHash: hex }]],
    ["rate", { "--job": "1", "--score": "5" }, ["rateProvider", { asset: "sbtc", jobId: 1n, score: 5n }]],
    ["register", { "--name": "Agent One", "--uri": "https://a.example" }, ["registerAgent", { name: "Agent One", uri: "https://a.example" }]],
    ["apply", { "--job": "1", "--deposit": "500" }, ["applyToJob", { jobId: 1n, deposit: 500n }]],
    ["withdraw", { "--job": "1" }, ["withdrawApplication", 1n]],
    ["decline", { "--job": "1", "--applicant": APPLICANT }, ["declineApplication", 1n, APPLICANT]],
    ["allow-caller", { "--caller": `${DEPLOYER}.helper`, "--target": "escrowSbtc", "--until": "900000" }, ["allowContractCaller", { caller: `${DEPLOYER}.helper`, target: "escrowSbtc", until: 900000n }]],
    ["disallow-caller", { "--caller": `${DEPLOYER}.helper`, "--target": "applications" }, ["disallowContractCaller", { caller: `${DEPLOYER}.helper`, target: "applications" }]],
  ];
  for (const [cmd, flags, expected] of cases) {
    const ctx = ctxWith(reader);
    await X.runNextCommand(cmd, ctx, args(flags));
    assert.deepEqual(ctx.wallet.calls[0], expected, cmd);
  }
});

test("accept checks the offer is for the signing wallet", async () => {
  const reader = fakeReader({ sbtc: [job(1, "offered")] });
  await assert.rejects(X.runNextCommand("accept", ctxWith(reader), args({ "--job": "1" })), /cannot accept/);
  const ctx = ctxWith(reader, { wallet: fakeWallet(PROVIDER) });
  await X.runNextCommand("accept", ctx, args({ "--job": "1" }));
  assert.deepEqual(ctx.wallet.calls[0], ["acceptJob", { asset: "sbtc", jobId: 1n }]);
});

test("submit --file puts the file's sha256 on-chain; hashes and deliverables are validated", async () => {
  const ctx = ctxWith(fakeReader());
  await X.runNextCommand("submit", ctx, args({ "--job": "1", "--file": "out.txt" }));
  const value = ctx.wallet.calls[0][1].deliverable;
  assert.equal(Buffer.from(value).toString("hex"), X.sha256(Buffer.from("hello")).toString("hex"));
  await assert.rejects(X.runNextCommand("submit", ctx, args({ "--job": "1", "--deliverable": "x".repeat(65) })), /1 to 64/);
  await assert.rejects(X.runNextCommand("decide", ctx, args({ "--job": "1", "--decision": "approve", "--evidence-hash": "00".repeat(32) })), /non-zero/);
  await assert.rejects(X.runNextCommand("decide", ctx, args({ "--job": "1", "--decision": "maybe", "--evidence-hash": "ab".repeat(32) })), /approve" or "reject/);
  await assert.rejects(X.runNextCommand("rate", ctx, args({ "--job": "1", "--score": "6" })), /1 to 5/);
  await assert.rejects(X.runNextCommand("apply", ctx, args({ "--job": "1", "--deposit": "50" })), /100 to 1000000/);
});

test("settle, refund, close and default-approval run only when due, without spending a fee otherwise", async () => {
  const reader = fakeReader({
    sbtc: [job(1, "decided"), job(2, "accepted"), job(3, "open"), job(4, "submitted")],
    decisions: { "sbtc:1": { decision: "approve", appealDeadline: 1_500n } },
    submissions: { "sbtc:4": { reviewDeadline: 1_990n } },
  });
  const early = ctxWith(reader, { tip: 900n });
  for (const [cmd, id] of [["settle", "1"], ["refund", "2"], ["close", "3"], ["default-approval", "4"]])
    await assert.rejects(X.runNextCommand(cmd, early, args({ "--job": id })), /is not due/);
  assert.equal(early.wallet.calls.length, 0);
  const late = ctxWith(reader, { tip: 2_000n });
  for (const [cmd, id] of [["finalize", "1"], ["refund", "2"], ["close", "3"], ["default-approval", "4"]])
    await X.runNextCommand(cmd, late, args({ "--job": id }));
  assert.deepEqual(late.wallet.calls.map((c) => c[0]), ["settleJob", "refundNoDelivery", "closeUnfunded", "recordDefaultApproval"]);
});

test("release refuses a job that still takes applications", async () => {
  const reader = fakeReader({ sbtc: [job(1, "funded"), job(2, "completed")] });
  await assert.rejects(X.runNextCommand("release", ctxWith(reader), args({ "--job": "1", "--applicant": APPLICANT })), /still takes applications/);
  const ctx = ctxWith(reader);
  await X.runNextCommand("release", ctx, args({ "--job": "2", "--applicant": APPLICANT }));
  assert.deepEqual(ctx.wallet.calls[0], ["releaseApplication", 2n, APPLICANT]);
});

test("status reports what is due next", async () => {
  const reader = fakeReader({ sbtc: [job(1, "open")], applications: { 1: [{ applicant: APPLICANT, deposit: 400n }] } });
  const ctx = ctxWith(reader);
  const r = await X.runNextCommand("status", ctx, args({ "--job": "1" }));
  assert.equal(r.due.action, "close-unfunded");
  assert.ok(ctx.lines.some((l) => l.includes(APPLICANT)));
});

test("unknown commands and contract errors are explained", async () => {
  await assert.rejects(X.runNextCommand("wallet", ctxWith(fakeReader()), args({})), /not a next-generation command/);
  assert.match(X.explainResult("(err u314)"), /ERR_TOO_EARLY/);
  assert.equal(X.createdJobId("(ok u12)"), 12n);
  assert.equal(X.createdJobId("(err u308)"), null);
});
