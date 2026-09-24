#!/usr/bin/env node
// Import an EXISTING wallet (for example one you created in Leather) as your agent's key file.
//
//   node import-wallet.mjs ./keys/client.env [accountIndex]
//
// You will be asked for the wallet's 12 or 24 secret words in a hidden prompt (nothing is echoed).
// The script derives the Stacks account at the given index (default 0, the first account in
// Leather), writes AGENT_ADDRESS and AGENT_PRIVATE_KEY to the file with mode 0600, prints the
// address so you can confirm it matches your wallet, and forgets the words. Never paste the
// words anywhere else: not in a chat, a file, a shell argument or an environment variable.

import { existsSync, mkdirSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { generateWallet } from "@stacks/wallet-sdk";
import { getAddressFromPrivateKey } from "@stacks/transactions";

const network = process.env.NAYORI_NETWORK ?? "mainnet";
if (network !== "mainnet" && network !== "testnet") { console.error("NAYORI_NETWORK must be mainnet or testnet"); process.exit(2); }
const out = resolve(process.argv[2] ?? "./keys/agent.env");
const index = Number(process.argv[3] ?? "0");
if (!Number.isInteger(index) || index < 0 || index > 100) { console.error("accountIndex must be 0..100"); process.exit(2); }
if (existsSync(out)) { console.error(`${out} already exists; refusing to overwrite a key file.`); process.exit(1); }

function hiddenPrompt(question) {
  return new Promise((resolveWords) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          stdout.write("\n");
          resolveWords(buf);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

const raw = await hiddenPrompt(`Secret words of the wallet to import (${network}, account ${index}); typing is hidden: `);
const words = raw.trim().toLowerCase().split(/\s+/);
if (words.length !== 12 && words.length !== 24) { console.error(`Expected 12 or 24 words, got ${words.length}.`); process.exit(1); }
let privateKey;
try {
  const wallet = await generateWallet({ secretKey: words.join(" "), password: "" });
  let w = wallet;
  const { generateNewAccount } = await import("@stacks/wallet-sdk");
  for (let i = w.accounts.length; i <= index; i++) w = generateNewAccount(w);
  privateKey = w.accounts[index].stxPrivateKey;
} catch {
  console.error("Could not derive a key from those words (invalid mnemonic?)."); process.exit(1);
}
const address = getAddressFromPrivateKey(privateKey, network);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
writeSync(fd, `AGENT_ADDRESS=${address}\nAGENT_PRIVATE_KEY=${privateKey}\n`);
closeSync(fd);
privateKey = undefined;

console.log(`Imported ${network} account ${index}`);
console.log(`  address:  ${address}   (check it matches the account in your wallet app)`);
console.log(`  key file: ${out}  (mode 0600, never share it)`);
console.log(`\nUse it:  export NAYORI_CLIENT_KEY_FILE=${out}   or   export NAYORI_PROVIDER_KEY_FILE=${out}`);
