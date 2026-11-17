// Static build: dist/ holds the whole app (HTML, CSS, JS) for the Tauri v3
// shell and for a plain static host. TypeScript domain sources are turned into
// JavaScript with Node's built-in type stripping (no bundler, no dependency).
import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pins = JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(resolve(root, "vendor", name))) !== digest) throw new Error(`canonical runtime pin drift: ${name}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "domain"), { recursive: true });

for (const name of ["index.html", "style.css", "app.js"]) await copyFile(resolve(root, "src/ui", name), join(out, name));
for (const name of ["local-store.js", "app-def.js"]) await copyFile(resolve(root, "src", name), join(out, name));

const domainDir = resolve(root, "src/domain");
const domainFiles = [];
for (const name of (await readdir(domainDir)).sort()) {
  if (name.endsWith(".ts")) {
    const js = stripTypeScriptTypes(await readFile(join(domainDir, name), "utf8"), { mode: "strip" });
    await writeFile(join(out, "domain", name.replace(/\.ts$/, ".js")), js);
    domainFiles.push("domain/" + name.replace(/\.ts$/, ".js"));
  } else if (name.endsWith(".js")) {
    await copyFile(join(domainDir, name), join(out, "domain", name));
    domainFiles.push("domain/" + name);
  }
}

// The shared client-runtime descriptor: local state only, no external operation.
const descriptor = {
  schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "trusted-page-v1", entry: "index.html",
  "local-state": { adapter: "localstorage", schema: app.storageKey, version: 1 }, workers: [], operations: [],
};
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");

const names = ["index.html", "style.css", "app.js", "local-store.js", "app-def.js", ...domainFiles, "descriptor.json"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6", runtimePins: pins, files,
}, null, 2) + "\n");
console.log(`${app.title} static build: ${names.length} pinned files`);
