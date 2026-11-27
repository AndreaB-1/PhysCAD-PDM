import { createRequire } from "node:module";

type OcctMesh = {
  name?: string;
  color?: [number, number, number];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
};

let occtPromise: Promise<{ ReadStepFile: (data: Uint8Array, params: unknown) => { success: boolean; meshes: OcctMesh[] } }> | null = null;
function occt() {
  if (!occtPromise) {
    const require = createRequire(import.meta.url);
    const init = require("occt-import-js");
    occtPromise = init();
  }
  return occtPromise!;
}

/** Convert a STEP file to a binary glTF (one mesh/node per STEP body, with colours). */
export async function stepToGlb(step: Buffer): Promise<Buffer> {
  const o = await occt();
  const res = o.ReadStepFile(new Uint8Array(step), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
  if (!res.success || !res.meshes.length) throw new Error("STEP conversion failed");
  return meshesToGlb(res.meshes);
}

export function meshesToGlb(meshes: OcctMesh[]): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const gltfMeshes: object[] = [];
  const materials: object[] = [];
  const nodes: object[] = [];
  const push = (data: Buffer, target: number) => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  for (const m of meshes) {
    const pos = Float32Array.from(m.attributes.position.array);
    // STEP is Z-up in mm; glTF is Y-up in metres: the viewer rescales, we only rotate.
    for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1]!; pos[i + 1] = pos[i + 2]!; pos[i + 2] = -y; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, pos[i + k]!); max[k] = Math.max(max[k]!, pos[i + k]!); }
    const attributes: Record<string, number> = {};
    accessors.push({ bufferView: push(Buffer.from(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    attributes.POSITION = accessors.length - 1;
    if (m.attributes.normal) {
      const n = Float32Array.from(m.attributes.normal.array);
      for (let i = 0; i < n.length; i += 3) { const y = n[i + 1]!; n[i + 1] = n[i + 2]!; n[i + 2] = -y; }
      accessors.push({ bufferView: push(Buffer.from(n.buffer), 34962), componentType: 5126, count: n.length / 3, type: "VEC3" });
      attributes.NORMAL = accessors.length - 1;
    }
    const idx = Uint32Array.from(m.index.array);
    accessors.push({ bufferView: push(Buffer.from(idx.buffer), 34963), componentType: 5125, count: idx.length, type: "SCALAR" });
    // occt gives 0..1 colours; a missing or (near-)black colour becomes neutral grey so shading stays readable
    let c: number[] = m.color ? [...m.color] : [0.7, 0.72, 0.75];
    if (c.some((x) => x > 1)) c = c.map((x) => x / 255);
    if (c[0]! + c[1]! + c[2]! < 0.09) c = [0.7, 0.72, 0.75];
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [c[0], c[1], c[2], 1], metallicFactor: 0.1, roughnessFactor: 0.6 }, doubleSided: true });
    gltfMeshes.push({ name: m.name, primitives: [{ attributes, indices: accessors.length - 1, material: materials.length - 1 }] });
    nodes.push({ mesh: gltfMeshes.length - 1, name: m.name || `Body ${nodes.length + 1}` });
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "PLM Lite" }, scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes: gltfMeshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
