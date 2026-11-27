import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { stepToGlb } from "../src/worker/glb";

const req = createRequire(import.meta.url);
const pkgDir = path.dirname(req.resolve("occt-import-js/package.json"));
const cube = path.join(pkgDir, "test/testfiles/cube-10x10mm/Cube 10x10.stp");

describe.skipIf(!existsSync(cube))("STEP → GLB", () => {
  it("converts a cube", async () => {
    const glb = await stepToGlb(readFileSync(cube));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
    expect(json.meshes.length).toBeGreaterThan(0);
    expect(json.accessors[0].max[0] - json.accessors[0].min[0]).toBeCloseTo(10, 1);
  });
});
