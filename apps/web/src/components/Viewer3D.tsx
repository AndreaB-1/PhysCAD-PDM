import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { Box3, Vector3 } from "three";
import type { OrbitControls as OrbitImpl } from "three-stdlib";
import { Eye, EyeOff, Maximize, Ruler, Scissors, Shapes } from "lucide-react";
import { cx } from "./ui";

type ViewName = "iso" | "front" | "top" | "right";
const DIRS: Record<ViewName, [number, number, number]> = { iso: [1, 0.8, 1], front: [0, 0, 1], top: [0, 1, 0.0001], right: [1, 0, 0] };

function Model({ url, edges, clip, hidden, onParts, onPick }: {
  url: string; edges: boolean; clip: THREE.Plane | null; hidden: Set<string>;
  onParts: (p: { id: string; name: string }[], box: Box3) => void; onPick: (p: Vector3) => void;
}) {
  const { scene } = useGLTF(url);
  const root = useMemo(() => scene.clone(true), [scene]);
  useEffect(() => {
    const parts: { id: string; name: string }[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        parts.push({ id: m.uuid, name: m.name || m.parent?.name || `Body ${parts.length + 1}` });
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        m.material = mats.map((mat) => { const c = (mat as THREE.MeshStandardMaterial).clone(); c.side = THREE.DoubleSide; return c; }) as never;
        if (!Array.isArray(mats) || mats.length === 1) m.material = (m.material as THREE.Material[])[0]!;
      }
    });
    onParts(parts, new Box3().setFromObject(root));
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.visible = !hidden.has(m.uuid);
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
      for (const mat of mats) { mat.clippingPlanes = clip ? [clip] : []; mat.needsUpdate = true; }
      const existing = m.children.find((c) => c.userData.edges);
      if (edges && !existing) {
        const ls = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6 }));
        ls.userData.edges = true;
        m.add(ls);
      }
      if (existing) { existing.visible = edges; ((existing as THREE.LineSegments).material as THREE.Material).clippingPlanes = clip ? [clip] : []; }
    });
  }, [root, edges, clip, hidden]);
  return <primitive object={root} onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPick(e.point.clone()); }} />;
}

function CameraRig({ box, view, nonce }: { box: Box3 | null; view: ViewName; nonce: number }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3()).length();
    const fov = ((camera as THREE.PerspectiveCamera).fov ?? 35) * (Math.PI / 180);
    const dist = (size / 2 / Math.sin(fov / 2)) * 1.1;
    const dir = new Vector3(...DIRS[view]).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    camera.near = size / 1000; camera.far = size * 100;
    camera.updateProjectionMatrix();
    const c = controls as unknown as OrbitImpl | null;
    if (c) { c.target.copy(center); c.update(); }
    else camera.lookAt(center);
  }, [box, view, nonce, camera, controls]);
  return null;
}

export default function Viewer3D({ url, className }: { url: string; className?: string }) {
  const [parts, setParts] = useState<{ id: string; name: string }[]>([]);
  const [box, setBox] = useState<Box3 | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [edges, setEdges] = useState(true);
  const [view, setView] = useState<ViewName>("iso");
  const [nonce, setNonce] = useState(0);
  const [section, setSection] = useState<null | { axis: "x" | "y" | "z"; t: number }>(null);
  const [measure, setMeasure] = useState<Vector3[] | null>(null);
  const [showTree, setShowTree] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const clip = useMemo(() => {
    if (!section || !box) return null;
    const n = { x: new Vector3(-1, 0, 0), y: new Vector3(0, -1, 0), z: new Vector3(0, 0, -1) }[section.axis];
    const min = box.min[section.axis], max = box.max[section.axis];
    return new THREE.Plane(n, min + (max - min) * section.t);
  }, [section, box]);

  const dist = measure && measure.length === 2 ? measure[0]!.distanceTo(measure[1]!) : null;
  const tb = "flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-panel2";

  return (
    <div ref={wrap} className={cx("relative aspect-[4/3] w-full bg-gradient-to-b from-panel2 to-panel", className)}>
      <Canvas camera={{ fov: 35 }} gl={{ localClippingEnabled: true, antialias: true }} dpr={[1, 2]}>
        <hemisphereLight args={["#ffffff", "#666b75", 1.1]} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[5, 10, 7]} intensity={1.4} />
        <directionalLight position={[-6, -3, -5]} intensity={0.5} />
        <Suspense fallback={null}>
          <Model url={url} edges={edges} clip={clip} hidden={hidden}
            onParts={(p, b) => { setParts(p); setBox(b); }}
            onPick={(p) => { if (measure) setMeasure(measure.length >= 2 ? [p] : [...measure, p]); }} />
        </Suspense>
        {measure?.map((p, i) => <mesh key={i} position={p}><sphereGeometry args={[box ? box.getSize(new Vector3()).length() / 300 : 0.5]} /><meshBasicMaterial color="#ef4444" /></mesh>)}
        {measure && measure.length === 2 && <Line points={measure} color="#ef4444" lineWidth={2} />}
        <OrbitControls makeDefault enableDamping />
        <CameraRig box={box} view={view} nonce={nonce} />
      </Canvas>
      <div className="absolute top-2 left-2 flex flex-wrap gap-1 rounded-md border border-line bg-panel/90 p-1 backdrop-blur">
        <button className={tb} onClick={() => setNonce(nonce + 1)} title="Fit"><Maximize className="size-3.5" />Fit</button>
        {(["iso", "front", "top", "right"] as ViewName[]).map((v) => <button key={v} className={cx(tb, view === v && "bg-panel2")} onClick={() => { setView(v); setNonce(nonce + 1); }}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}
        <button className={cx(tb, edges && "bg-panel2")} onClick={() => setEdges(!edges)}><Shapes className="size-3.5" />Edges</button>
        <button className={cx(tb, section && "bg-panel2")} onClick={() => setSection(section ? null : { axis: "x", t: 0.5 })}><Scissors className="size-3.5" />Section</button>
        <button className={cx(tb, measure && "bg-panel2")} onClick={() => setMeasure(measure ? null : [])}><Ruler className="size-3.5" />Measure</button>
        {parts.length > 1 && <button className={cx(tb, showTree && "bg-panel2")} onClick={() => setShowTree(!showTree)}><Eye className="size-3.5" />Parts ({parts.length})</button>}
      </div>
      {section && (
        <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md border border-line bg-panel/90 px-2 py-1 text-xs backdrop-blur">
          {(["x", "y", "z"] as const).map((a) => <button key={a} className={cx("rounded px-1.5", section.axis === a && "bg-accent text-accent-fg")} onClick={() => setSection({ ...section, axis: a })}>{a.toUpperCase()}</button>)}
          <input type="range" min={0} max={1} step={0.005} value={section.t} onChange={(e) => setSection({ ...section, t: Number(e.target.value) })} />
        </div>
      )}
      {measure && (
        <div className="absolute right-2 bottom-2 rounded-md border border-line bg-panel/90 px-2 py-1 text-xs backdrop-blur">
          {dist != null ? <>Distance: <b className="mono">{dist.toFixed(3)}</b> model units</> : `Click ${2 - measure.length} point${measure.length === 1 ? "" : "s"} on the model`}
        </div>
      )}
      {showTree && (
        <div className="absolute top-12 right-2 max-h-[70%] w-56 overflow-y-auto rounded-md border border-line bg-panel/95 p-1 text-xs backdrop-blur">
          {parts.map((p) => (
            <button key={p.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel2"
              onClick={() => { const h = new Set(hidden); if (h.has(p.id)) h.delete(p.id); else h.add(p.id); setHidden(h); }}>
              {hidden.has(p.id) ? <EyeOff className="size-3.5 text-muted" /> : <Eye className="size-3.5" />}<span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
