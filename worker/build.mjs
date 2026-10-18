// Сборка прода-бандла из src/{runtime,yandex,index}.js (конкатенация, как esbuild bundle)
// Использование: node build.mjs [--verify путь/к/эталонному-index.js]
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const args = process.argv.slice(2);
const srcDir = join(import.meta.dirname, "src");

const rl = readFileSync(join(srcDir, "runtime.js"), "utf8").trim();
const ya = readFileSync(join(srcDir, "yandex.js"), "utf8").trim();
const ix = readFileSync(join(srcDir, "index.js"), "utf8").trim();
const out = rl + "\n\n" + ya + "\n\n" + ix + "\n";

const verifyIdx = args.indexOf("--verify");
if (verifyIdx >= 0) {
  const etalon = readFileSync(args[verifyIdx + 1], "utf8");
  if (out === etalon) { console.log("IDENTICAL"); process.exit(0); }
  let i = 0; while (i < Math.min(out.length, etalon.length) && out[i] === etalon[i]) i++;
  console.log("DIFF at", i, JSON.stringify(out.slice(i, i + 100)), "|", JSON.stringify(etalon.slice(i, i + 100)));
  process.exit(1);
}

const outPath = join(import.meta.dirname, "dist", "index.js");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log("dist/index.js:", out.length, "символов");
