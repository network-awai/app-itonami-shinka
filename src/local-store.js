// Local record store. It keeps the read/write contract the domain code was
// written against (collection + rkey records, paged listing), but every record
// stays on this device: an in-memory map, persisted to localStorage when one is
// given. Nothing here talks to a network.

const PAGE_MAX = 100;
const SEALED_PREFIX = "sealed:";

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function digest(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  return "sha256-" + hex(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

let tidCounter = 0;
function nextTid() {
  tidCounter = (tidCounter + 1) % 1000;
  return Date.now().toString(36) + tidCounter.toString(36).padStart(2, "0");
}

export class LocalStore {
  /**
   * @param {{ did: string, storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void } | null, key?: string }} options
   */
  constructor({ did, storage = null, key = "" }) {
    if (!did) throw new Error("LocalStore needs a did");
    this.did = did;
    this.storage = storage;
    this.key = key;
    this.lastSaveError = null;
    /** @type {Map<string, Map<string, { cid: string | null, value: unknown }>>} */
    this.collections = new Map();
    if (storage && key) this.#load();
  }

  #load() {
    let raw = null;
    try { raw = this.storage.getItem(this.key); } catch { raw = null; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || data.schema !== "itonami.local-store.v1" || typeof data.collections !== "object") return;
    for (const [collection, records] of Object.entries(data.collections)) {
      const map = new Map();
      for (const [rkey, rec] of Object.entries(records ?? {})) map.set(rkey, { cid: rec.cid ?? null, value: rec.value });
      this.collections.set(collection, map);
    }
  }

  #save() {
    if (!this.storage || !this.key) return;
    const collections = {};
    for (const [collection, map] of this.collections) collections[collection] = Object.fromEntries(map);
    try {
      this.storage.setItem(this.key, JSON.stringify({ schema: "itonami.local-store.v1", collections }));
      this.lastSaveError = null;
    } catch (error) {
      this.lastSaveError = error;
      throw new Error("local save failed: " + (error?.message ?? String(error)));
    }
  }

  uri(collection, rkey) {
    return `at://${this.did}/${collection}/${rkey}`;
  }

  /**
   * Write a record. Writing an existing rkey replaces it (put semantics): the
   * domain code updates state-machine records this way, and checks for
   * existence itself where a duplicate must be refused.
   */
  async write({ collection, record, rkey }) {
    if (!collection) throw new Error("write: collection is required");
    if (record === null || typeof record !== "object") throw new Error("write: record must be an object");
    const key = rkey || nextTid();
    const map = this.collections.get(collection) ?? new Map();
    const value = JSON.parse(JSON.stringify(record));
    const cid = await digest(JSON.stringify(value));
    map.set(key, { cid, value });
    this.collections.set(collection, map);
    this.#save();
    return { uri: this.uri(collection, key), cid, blobCids: {}, pendingAnchor: 0n };
  }

  /** Read one record (rkey) or a page of a collection (limit, cursor, prefix). */
  async read({ collection, rkey, limit, cursor, prefix }) {
    const map = this.collections.get(collection) ?? new Map();
    const view = (key, rec) => ({ uri: this.uri(collection, key), cid: rec.cid, value: JSON.parse(JSON.stringify(rec.value)) });
    if (rkey) {
      const rec = map.get(rkey);
      return { records: rec ? [view(rkey, rec)] : [] };
    }
    const keys = [...map.keys()].sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    if (start < 0) return { records: [] };
    const size = Math.max(1, Math.min(limit ?? 50, PAGE_MAX));
    const page = keys.slice(start, start + size);
    const next = start + size < keys.length ? page[page.length - 1] : undefined;
    const records = page.filter((k) => !prefix || k.startsWith(prefix)).map((k) => view(k, map.get(k)));
    return next ? { records, cursor: next } : { records };
  }

  /**
   * Sealed records: stored with a read-cap (the writer plus explicit
   * recipients), and returned by sealedRead only to a store whose did is in
   * that read-cap. NOTE: this enforces who may read through this API; it does
   * NOT encrypt. The record sits in localStorage as plain JSON on this device.
   * The method names match the SDK the domain code was written against.
   */
  async encryptedWrite({ innerType, record, recipients = [], rkey }) {
    if (!innerType) throw new Error("encryptedWrite: innerType is required");
    const readCap = [...new Set([this.did, ...recipients])].sort();
    const keyId = (await digest(readCap.join("\n"))) ?? "local-readcap";
    const createdAt = new Date().toISOString();
    const receipt = await this.write({ collection: SEALED_PREFIX + innerType, record: { sender: this.did, readCap, keyId, createdAt, value: record }, rkey });
    return { uri: receipt.uri, cid: receipt.cid, keyId };
  }

  async encryptedRead({ innerType, cursor, limit }) {
    const page = await this.read({ collection: SEALED_PREFIX + innerType, cursor, limit });
    const records = page.records
      .filter((r) => Array.isArray(r.value?.readCap) && r.value.readCap.includes(this.did))
      .map((r) => ({ uri: r.uri, cid: r.cid, value: r.value.value, sender: r.value.sender, createdAt: r.value.createdAt, keyId: r.value.keyId }));
    return page.cursor ? { records, cursor: page.cursor } : { records };
  }

  /** All records of a collection, for the UI. */
  list(collection) {
    const map = this.collections.get(collection) ?? new Map();
    return [...map.keys()].sort().map((k) => ({ rkey: k, uri: this.uri(collection, k), value: map.get(k).value }));
  }

  count(collection) {
    return this.collections.get(collection)?.size ?? 0;
  }

  /** Remove every local record (used by the UI's reset). */
  clear() {
    this.collections.clear();
    this.#save();
  }
}
