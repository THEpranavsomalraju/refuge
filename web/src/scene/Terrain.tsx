import { useMemo } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { VERTICAL_EXAGGERATION } from './geo';
import { PALETTE } from './palette';
import type { PlaceData } from './types';

/** Ground mesh spacing in meters. Coarse on purpose: low-poly look, light on the GPU. */
const SPACING_M = 50;

/** Low-poly ground mesh, heights from terrain.bin through the same lookup buildings use. */
export function Terrain({ place, frame }: { place: PlaceData; frame: Frame }) {
  const geometry = useMemo(() => {
    const segX = Math.max(1, Math.round(frame.width / SPACING_M));
    const segZ = Math.max(1, Math.round(frame.depth / SPACING_M));
    const geo = new THREE.PlaneGeometry(frame.width, frame.depth, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const ts = place.meta.terrain_source;
    const range = ts ? Math.max(1, (ts.max_m - ts.min_m) * VERTICAL_EXAGGERATION) : 1;
    const lo = new THREE.Color(PALETTE.ground), hi = new THREE.Color(PALETTE.groundHigh), c = new THREE.Color();
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = frame.groundY(pos.getX(i), pos.getZ(i));
      pos.setY(i, y);
      c.copy(lo).lerp(hi, y / range);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Non-indexed with per-face normals gives the faceted low-poly look.
    const flat = geo.toNonIndexed();
    flat.computeVertexNormals();
    geo.dispose();
    return flat;
  }, [place, frame]);

  return (
    <mesh geometry={geometry} receiveShadow raycast={() => null}>
      <meshStandardMaterial vertexColors flatShading roughness={1} metalness={0} />
    </mesh>
  );
}
