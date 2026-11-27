import { build } from "esbuild";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
const external = Object.keys(pkg.dependencies).filter((d) => d !== "@plm/shared");
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/main.js",
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log("api built");
