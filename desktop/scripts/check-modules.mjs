/**
 * Static module audit for the renderer.
 *
 * Catches three things `node --check` cannot, because they are runtime errors
 * in valid syntax:
 *
 *   1. an import that points at a file or export that does not exist
 *   2. an identifier that is USED but never imported or declared — the failure
 *      that silently blanked the Voices view when a Spinner import was dropped
 *   3. an import that is never used
 *
 * Run: node scripts/check-modules.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

// Retired pre-redesign renderer; excluded from packaging and from this audit.
const EXCLUDE = [/^renderer\/app\.js$/];

const files = execSync('find renderer -name "*.js"', { encoding: "utf8" })
  .trim().split("\n")
  .filter((f) => !EXCLUDE.some((re) => re.test(f)));

const GLOBALS = new Set([
  "window", "document", "console", "navigator", "location", "localStorage",
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Symbol",
  "Promise", "Set", "Map", "WeakMap", "Date", "Error", "RegExp", "Intl",
  "Infinity", "NaN", "undefined", "globalThis", "Proxy", "Reflect",
  "fetch", "Request", "Response", "Headers", "FormData", "URL", "URLSearchParams",
  "Blob", "File", "FileReader", "Audio", "Image", "EventSource", "AbortController",
  "TextEncoder", "TextDecoder", "Uint8Array", "Float32Array", "ArrayBuffer",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  "ResizeObserver", "MutationObserver", "IntersectionObserver",
  "AudioContext", "performance", "structuredClone", "CustomEvent", "Event",
  "HTMLElement", "Node", "SVGElement", "DOMParser",
]);

const exportsOf = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g))
    m[1].split(",").forEach((p) => {
      const t = p.trim().split(/\s+as\s+/);
      names.add((t[1] || t[0]).trim());
    });
  exportsOf.set(path.resolve(f), names);
}

let problems = 0;
const report = (msg) => { console.log(`  ${msg}`); problems++; };

for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Strip comments and strings so their contents are not mistaken for code.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

  const declared = new Set();
  // local name -> { spec, exported } where `exported` is the ORIGINAL name in
  // the source module. `import { icon as makeIcon }` must be checked against
  // `icon`, not `makeIcon`.
  const imported = new Map();

  for (const m of src.matchAll(/import\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const raw of m[1].split(",")) {
      if (!raw.trim()) continue;
      const parts = raw.trim().split(/\s+as\s+/);
      const exported = parts[0].trim();
      const local = (parts[1] || parts[0]).trim();
      declared.add(local);
      imported.set(local, { spec: m[2], exported });
    }
  }
  // Namespace and default imports bind a whole module; there is no single
  // named export to verify.
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*["']([^"']+)["']/g)) {
    declared.add(m[1]);
    imported.set(m[1], { spec: m[2], exported: null });
  }
  for (const m of src.matchAll(/import\s+([A-Za-z0-9_$]+)\s*(?:,|from)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?:function|class)\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g))
    m[1].split(",").forEach((p) =>
      declared.add(p.trim().split(":").pop().trim().split("=")[0].trim()));

  // 1 + 2: resolve every relative import
  for (const [local, { spec, exported }] of imported) {
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(f), spec);
    if (!existsSync(target)) { report(`${f}: imports missing file ${spec}`); continue; }
    if (exported === null) continue;   // namespace import
    const have = exportsOf.get(target);
    if (have && !have.has(exported)) {
      report(`${f}: ${spec} does not export ${exported}`
        + (exported === local ? "" : ` (imported as ${local})`));
    }
  }

  // 2: capitalised call sites that were never brought into scope
  for (const m of code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
    const name = m[1];
    if (!declared.has(name) && !GLOBALS.has(name)) {
      report(`${f}: ${name}() is used but never imported or declared`);
    }
  }

  // 3: imports nothing uses
  for (const name of imported.keys()) {
    if (name === "$" || name === "$$") continue;
    const uses = (code.match(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g")) || []).length;
    if (uses === 0) report(`${f}: imports ${name} but never uses it`);
  }
}

console.log("");
if (problems) {
  console.error(`  ${problems} problem(s) across ${files.length} modules\n`);
  process.exit(1);
}
console.log(`  ${files.length} modules clean: imports resolve, nothing undeclared, nothing unused\n`);
