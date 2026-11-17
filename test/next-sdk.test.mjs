// The keeper against the real NayoriNextClient, with the read-only transport and the signer mocked:
// checks the CLI and the SDK agree on method names, arguments and post-conditions. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cl } from "@stacks/transactions";
import { NayoriNextClient } from "@perkos/agent-sdk";
import * as X from "../next.mjs";

const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const CLIENT = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const PROVIDER = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const EVALUATOR = "ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC";
const TREASURY = "ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND";
const AUTHORITY = "ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB";
const APPLICANT = "ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0";
const KEEPER = "ST3NBRSFKX28FQ2ZJ1MAKX58HKHSDGNV5N7R21XCP";

const jobCv = (status, budget = 10_000n) => Cl.some(Cl.tuple({
  client: Cl.principal(CLIENT), evaluator: Cl.principal(EVALUATOR), provider: Cl.some(Cl.principal(PROVIDER)),
  treasury: Cl.principal(TREASURY), "appeal-authority": Cl.principal(AUTHORITY), budget: Cl.uint(budget),
  description: Cl.stringAscii("job"), "delivery-deadline": Cl.uint(1_000n), "delivery-blocks": Cl.uint(144n),
  "review-blocks": Cl.uint(12n), status: Cl.uint(status),
}));

function chain() {
  // sBTC: #1 submitted (review closed), #2 decided (appeal closed), #3 completed with one deposit left
  //       and an outcome the reputation registry did not take
  // STX:  #1 accepted past its deadline (2 STX budget)
  const sbtc = { 1: jobCv(4), 2: jobCv(5), 3: jobCv(7) };
  const stx = { 1: jobCv(3, 2_000_000n) };
  return async (call) => {
    const escrow = call.contract.endsWith("nayori-escrow-sbtc") ? sbtc : call.contract.endsWith("nayori-escrow-stx") ? stx : null;
    const id = call.functionArgs[0] ? Number(call.functionArgs[0].value) : 0;
    switch (call.functionName) {
      case "get-job-count": return Cl.uint(Object.keys(escrow).length);
      case "get-job": return escrow[id] ?? Cl.none();
      case "get-submission": return Cl.some(Cl.tuple({ deliverable: Cl.bufferFromHex("aa"), "review-deadline": Cl.uint(100n) }));
      case "get-decision": return Cl.some(Cl.tuple({ decision: Cl.uint(1n), "by-default": Cl.bool(false), "evidence-hash": Cl.bufferFromHex("11".repeat(32)), "appeal-deadline": Cl.uint(200n), appellant: Cl.none(), "resolution-deadline": Cl.none() }));
      case "get-escrow-balance": return escrow === stx ? Cl.uint(2_000_000n) : Cl.uint(10_000n);
      case "get-applications": return Cl.list(id === 3 ? [Cl.tuple({ applicant: Cl.principal(APPLICANT), deposit: Cl.uint(500n) })] : []);
      case "get-reputation-pending": return escrow === sbtc && id === 3 ? Cl.some(Cl.tuple({ provider: Cl.principal(PROVIDER), client: Cl.principal(CLIENT), completed: Cl.bool(true), value: Cl.uint(10_000n) })) : Cl.none();
      case "get-application": return id === 3 ? Cl.some(Cl.tuple({ applicant: Cl.principal(APPLICANT), deposit: Cl.uint(500n) })) : Cl.none();
      default: throw new Error(`unexpected read ${call.functionName}`);
    }
  };
}

test("a keeper pass through NayoriNextClient builds the expected contract calls with deny-mode post-conditions", async () => {
  const readOnlyTransport = chain();
  const plans = [];
  const signer = { getAddress: async () => KEEPER, signAndBroadcast: async (plan) => { plans.push(plan); return { txid: `0x${String(plans.length).padStart(64, "0")}` }; } };
  const base = { network: "testnet", deployer: DEPLOYER, readOnlyTransport };
  const reader = new NayoriNextClient(base);
  const wallet = { name: "keeper", signer, nayori: new NayoriNextClient({ ...base, signer }) };
  const lines = [];
  const ctx = { config: reader.config, reader, tip: async () => 2_000n, say: (...l) => lines.push(...l), confirm: async () => ({ status: "success" }), pendingCalls: async () => new Set() };

  const r = await X.runNextKeeper(ctx, wallet);
  assert.equal(r.failed.length, 0, lines.join("\n"));
  assert.deepEqual(plans.map((p) => `${p.contract.split(".")[1]}::${p.functionName}`), [
    "nayori-escrow-sbtc::record-default-approval",
    "nayori-escrow-sbtc::settle-job",
    "nayori-escrow-sbtc::retry-reputation",
    "nayori-applications::release",
    "nayori-escrow-stx::refund-no-delivery",
  ]);
  for (const p of plans) assert.equal(p.postConditionMode, "deny");
  assert.equal(plans[0].postConditions.length, 0); // no funds move
  assert.equal(plans[1].postConditions.length, 1); // escrow sends exactly the budget
  assert.equal(plans[1].postConditions[0].amount, "10000");
  assert.equal(plans[2].postConditions.length, 0); // reputation retry: no funds move
  assert.equal(plans[3].postConditions[0].amount, "500"); // the recorded deposit goes back
  assert.equal(plans[4].postConditions[0].amount, "2000000"); // STX: micro-STX back to the client
});
