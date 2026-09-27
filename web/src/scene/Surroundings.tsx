import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';

/**
 * Stand-in land outside the modeled town: plain ground and generic low blocks in muted gray, so the
 * plot doesn't float in a void. Not real data (no buildings.json behind it); deterministic per town.
 * A bright outline and the town's name mark where the real, simulated town is.
 */
const MARGIN = 0.7;          // stand-in band width, as a share of the town's larger side
const HOODS = 90;            // neighborhood clusters in the band
const PER_HOOD = 70;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function Surroundings({ frame, name }: { frame: Frame; name: string }) {
  const hw = frame.width / 2, hd = frame.depth / 2, m = MARGIN * Math.max(frame.width, frame.depth);
  const groundY = useMemo(() => {
    let lo = Infinity;
    for (let i = 0; i <= 20; i++) for (let k = 0; k <= 20; k++) lo = Math.min(lo, frame.groundY((i / 20 - 0.5) * frame.width, (k / 20 - 0.5) * frame.depth));
    return lo - 3;
  }, [frame]);

  // Generic blocks, clustered into neighborhoods, only outside the town rectangle.
  const blocks = useMemo(() => {
    const rand = rng(Math.round(frame.width * 7 + frame.depth * 13));
    const out: { x: number; z: number; w: number; d: number; h: number }[] = [];
    let guard = 0;
    while (out.length < HOODS * PER_HOOD && guard++ < HOODS * PER_HOOD * 6) {
      const hx = (rand() * 2 - 1) * (hw + m), hz = (rand() * 2 - 1) * (hd + m);
      if (Math.abs(hx) < hw + 150 && Math.abs(hz) < hd + 150) continue;           // hood center outside the town
      const spread = 250 + rand() * 450;
      for (let j = 0; j < PER_HOOD; j++) {
        const r = spread * Math.sqrt(rand()), a = rand() * Math.PI * 2;
        const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
        if (Math.abs(x) < hw + 60 && Math.abs(z) < hd + 60) continue;             // never inside the real town
        if (Math.abs(x) > hw + m || Math.abs(z) > hd + m) continue;
        out.push({ x, z, w: 10 + rand() * 14, d: 8 + rand() * 12, h: 4 + rand() * 8 });
      }
    }
    return out;
  }, [frame, hw, hd, m]);

  const mesh = useMemo(() => {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ color: '#4a5552', roughness: 0.95, metalness: 0 });
    const inst = new THREE.InstancedMesh(geo, mat, blocks.length);
    const o = new THREE.Object3D();
    blocks.forEach((b, i) => {
      o.position.set(b.x, groundY, b.z); o.scale.set(b.w, b.h, b.d); o.rotation.set(0, (i % 7) * 0.22, 0); o.updateMatrix();
      inst.setMatrixAt(i, o.matrix);
    });
    inst.raycast = () => null;
    return inst;
  }, [blocks, groundY]);
  useEffect(() => () => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }, [mesh]);

  // Town boundary: follows the terrain along the rectangle's edges.
  const outline = useMemo(() => {
    const pts: number[] = [];
    const edge = (x0: number, z0: number, x1: number, z1: number) => {
      for (let t = 0; t <= 60; t++) {
        const x = x0 + (x1 - x0) * (t / 60), z = z0 + (z1 - z0) * (t / 60);
        pts.push(x, frame.groundY(x, z) + 4, z);
      }
    };
    edge(-hw, -hd, hw, -hd); edge(hw, -hd, hw, hd); edge(hw, hd, -hw, hd); edge(-hw, hd, -hw, -hd);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [frame, hw, hd]);
  useEffect(() => () => outline.dispose(), [outline]);

  const size = (Math.max(frame.width, frame.depth) + 2 * m) * 3;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY, 0]} raycast={() => null}>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#2f3a37" roughness={1} metalness={0} />
      </mesh>
      <primitive object={mesh} />
      <line>
        <primitive object={outline} attach="geometry" />
        <lineBasicMaterial color={PALETTE.shelter} transparent opacity={0.9} />
      </line>
      <Html position={[0, frame.groundY(0, -hd) + 40, -hd]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{
          padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap', background: 'rgba(12,18,20,0.85)',
          border: `1px solid ${PALETTE.shelter}`, color: '#e3eae7', font: '600 12px "Public Sans", system-ui, sans-serif',
        }}>{name}: simulated area</div>
      </Html>
    </group>
  );
}
