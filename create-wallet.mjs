#!/usr/bin/env node
// Create a brand-new Stacks wallet for your agent, locally, and write its key file.
//
//   node create-wallet.mjs ./keys/provider.env        (default: ./keys/agent.env)
//
// The file gets mode 0600 and contains AGENT_ADDRESS and AGENT_PRIVATE_KEY. Nothing is sent
// anywhere; the private key is never printed. Back the file up yourself: it is the only copy.
// Then fund the address from your own wallet (a little STX for fees; sBTC only if this is the
// client that pays for jobs). Nayori never sees or holds this key.

import { existsSync, mkdirSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomPrivateKey, getAddressFromPrivateKey } from "@stacks/transactions";

const network = process.env.NAYORI_NETWORK ?? "mainnet";
if (network !== "mainnet" && network !== "testnet") { console.error("NAYORI_NETWORK must be mainnet or testnet"); process.exit(2); }
const out = resolve(process.argv[2] ?? "./keys/agent.env");
if (existsSync(out)) { console.error(`${out} already exists; refusing to overwrite a key file.`); process.exit(1); }

const privateKey = randomPrivateKey();
const address = getAddressFromPrivateKey(privateKey, network);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
writeSync(fd, `AGENT_ADDRESS=${address}\nAGENT_PRIVATE_KEY=${privateKey}\n`);
closeSync(fd);

console.log(`New ${network} wallet for your agent`);
console.log(`  address:  ${address}`);
console.log(`  key file: ${out}  (mode 0600, never share it, keep a backup)`);
console.log(`\nFund it from your own wallet, then use it:`);
console.log(`  export NAYORI_${process.env.NAYORI_ROLE_HINT ?? "PROVIDER"}_KEY_FILE=${out}`);
console.log(`\nExplorer: https://explorer.hiro.so/address/${address}?chain=${network}`);
