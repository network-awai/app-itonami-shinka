// Shared checks: the app runs locally with no external operation, under the
// strict CSP and the single read-only Tauri command. Run after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(resolve(root, p), "utf8");
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost";

async function distScripts() {
  const out = [];
  for (const dir of ["dist", "dist/domain"]) for (const name of await readdir(resolve(root, dir))) if (name.endsWith(".js")) out.push(join(dir, name));
  return out;
}

test("descriptor declares local state and no external operation", async () => {
  const d = JSON.parse(await read("dist/descriptor.json"));
  assert.equal(d.schema, "kotoba.app.client-runtime.v1");
  assert.deepEqual(d.operations, []);
  assert.deepEqual(d.workers, []);
  assert.equal(d["local-state"].adapter, "localstorage");
});

test("shipped scripts contain no network API", async () => {
  for (const file of await distScripts()) {
    const src = await read(file);
    for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /import\s*\(\s*["'`]https?:/, /from\s+["']https?:/]) {
      assert.ok(!api.test(src), `${file} uses ${api}`);
    }
  }
});

test("CSP is strict in the page and in the Tauri config", async () => {
  assert.ok((await read("src/ui/index.html")).includes(CSP));
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  assert.ok(conf.app.security.csp.startsWith(CSP));
  assert.equal(conf.$schema, "https://schema.tauri.app/config/3");
});

test("the Tauri host grants only the read-only host-info command", async () => {
  const caps = await readdir(resolve(root, "src-tauri/capabilities"));
  for (const name of caps) {
    const cap = JSON.parse(await read(join("src-tauri/capabilities", name)));
    assert.deepEqual(cap.permissions, ["allow-awai-host-info"]);
  }
  const cargo = await read("src-tauri/Cargo.toml");
  assert.match(cargo, /tauri = \{ version = "=3\.0\.0-alpha\.6"/);
  assert.doesNotMatch(cargo, /tauri-plugin-(http|fs|shell)/);
});

test("release manifest pins every shipped file", async () => {
  const release = JSON.parse(await read("dist/release.json"));
  for (const file of await distScripts()) assert.ok(release.files[file.replace(/^dist\//, "")], `${file} is not pinned`);
});

test("every UI action is wired to a function and every collection is declared", async () => {
  const { app } = await import(resolve(root, "dist/app-def.js"));
  assert.ok(app.title && app.did && app.storageKey);
  assert.ok(app.actions.length > 0);
  for (const action of app.actions) {
    assert.equal(typeof action.run, "function", action.name);
    for (const f of action.fields) assert.ok(f.name && f.label, `${action.name} field`);
  }
  assert.ok(app.collections.length > 0);
});

test("the local store round-trips through storage and replaces on rewrite", async () => {
  const { LocalStore } = await import(resolve(root, "dist/local-store.js"));
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = new LocalStore({ did: "did:example:t", storage, key: "t" });
  const w = await a.write({ collection: "c", record: { n: 1 }, rkey: "r1" });
  assert.equal(w.uri, "at://did:example:t/c/r1");
  await a.write({ collection: "c", record: { n: 2 }, rkey: "r1" });
  const b = new LocalStore({ did: "did:example:t", storage, key: "t" });
  assert.equal((await b.read({ collection: "c", rkey: "r1" })).records[0].value.n, 2);
  assert.equal(b.count("c"), 1);
  for (let i = 0; i < 5; i++) await b.write({ collection: "p", record: { i }, rkey: `k${i}` });
  const p1 = await b.read({ collection: "p", limit: 2 });
  const p2 = await b.read({ collection: "p", limit: 2, cursor: p1.cursor });
  assert.deepEqual([...p1.records, ...p2.records].map((r) => r.value.i), [0, 1, 2, 3]);
  const failing = new LocalStore({ did: "did:example:t", storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } }, key: "t" });
  await assert.rejects(failing.write({ collection: "c", record: {}, rkey: "x" }), /local save failed/);
});

test("sealed records are encrypted and returned only to dids in their read-cap", async () => {
  const { LocalStore } = await import(resolve(root, "dist/local-store.js"));
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const opts = { storage, key: "s", sealIterations: 1000 };
  const owner = new LocalStore({ did: "did:example:owner", ...opts });
  assert.equal(owner.sealedState(), "none");
  assert.deepEqual(await owner.encryptedRead({ innerType: "t.secret" }), { records: [] });
  await assert.rejects(owner.encryptedWrite({ innerType: "t.secret", record: { x: 1 } }), (e) => e.code === "SEALED_NONE");
  await assert.rejects(owner.setupSealKey("short"), (e) => e.code === "SEALED_WEAK_PASSPHRASE");
  await owner.setupSealKey("correct horse battery");
  assert.equal(owner.sealedState(), "unlocked");
  const r = await owner.encryptedWrite({ innerType: "t.secret", record: { x: 1, note: "very-private-text" }, recipients: ["did:example:friend"], rkey: "a" });
  assert.ok(r.keyId);
  assert.equal((await owner.encryptedRead({ innerType: "t.secret" })).records[0].value.note, "very-private-text");
  // Nothing persisted holds the plaintext or the raw key.
  const persisted = mem.get("s");
  assert.ok(!persisted.includes("very-private-text"));
  assert.ok(!persisted.includes("correct horse"));
  assert.match(persisted, /"alg":"A256GCM"/);

  // Another store on the same storage starts locked; a wrong passphrase fails.
  const friend = new LocalStore({ did: "did:example:friend", ...opts });
  assert.equal(friend.sealedState(), "locked");
  await assert.rejects(friend.encryptedRead({ innerType: "t.secret" }), (e) => e.code === "SEALED_LOCKED");
  await assert.rejects(friend.unlockSealed("wrong passphrase"), (e) => e.code === "SEALED_BAD_PASSPHRASE");
  await friend.unlockSealed("correct horse battery");
  assert.equal((await friend.encryptedRead({ innerType: "t.secret" })).records[0].value.x, 1);
  const outsider = new LocalStore({ did: "did:example:other", ...opts });
  await outsider.unlockSealed("correct horse battery");
  assert.equal((await outsider.encryptedRead({ innerType: "t.secret" })).records.length, 0);

  // Editing the readable metadata (here: adding a did to the read-cap) breaks decryption.
  const data = JSON.parse(mem.get("s"));
  data.collections["sealed:t.secret"].a.value.readCap.push("did:example:other");
  mem.set("s", JSON.stringify(data));
  const tampered = new LocalStore({ did: "did:example:other", ...opts });
  await tampered.unlockSealed("correct horse battery");
  await assert.rejects(tampered.encryptedRead({ innerType: "t.secret" }), (e) => e.code === "SEALED_CORRUPT");

  // Lock drops the key; changing the passphrase keeps the records readable.
  owner.lockSealed();
  assert.equal(owner.sealedState(), "locked");
  await owner.unlockSealed("correct horse battery");
  await owner.changeSealPassphrase("correct horse battery", "new passphrase 2");
  const later = new LocalStore({ did: "did:example:owner", ...opts });
  await assert.rejects(later.unlockSealed("correct horse battery"), (e) => e.code === "SEALED_BAD_PASSPHRASE");
  await later.unlockSealed("new passphrase 2");
  // (owner's save rewrote the untampered record from its memory)
  assert.equal((await later.encryptedRead({ innerType: "t.secret" })).records[0].value.x, 1);
  later.clear();
  assert.equal(later.sealedState(), "none");
});

test("plaintext sealed records from the read-cap-only version are encrypted on setup", async () => {
  const { LocalStore } = await import(resolve(root, "dist/local-store.js"));
  const legacy = { schema: "itonami.local-store.v1", collections: { "sealed:t.secret": { a: { cid: null, value: { sender: "did:example:owner", readCap: ["did:example:owner"], keyId: "x", createdAt: "2026-11-01T00:00:00.000Z", value: { note: "old-plaintext" } } } } } };
  const mem = new Map([["s", JSON.stringify(legacy)]]);
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const store = new LocalStore({ did: "did:example:owner", storage, key: "s", sealIterations: 1000 });
  await assert.rejects(store.encryptedRead({ innerType: "t.secret" }), (e) => e.code === "SEALED_NONE");
  await store.setupSealKey("migrate passphrase");
  assert.ok(!mem.get("s").includes("old-plaintext"));
  assert.equal((await store.encryptedRead({ innerType: "t.secret" })).records[0].value.note, "old-plaintext");
});
