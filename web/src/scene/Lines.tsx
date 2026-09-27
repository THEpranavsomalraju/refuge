import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import type { LonLat, PlaceData } from './types';

const LIFT_M = 1.2; // draw just above the ground so lines don't flicker into it
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

function segments(lines: LonLat[][], frame: Frame): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const [ax, az] = frame.toXZ(line[k][0], line[k][1]);
      const [bx, bz] = frame.toXZ(line[k + 1][0], line[k + 1][1]);
      pos.push(ax, frame.groundY(ax, az) + LIFT_M, az, bx, frame.groundY(bx, bz) + LIFT_M, bz);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

/** Roads (minor and major) and streams draped on the terrain. */
export function Lines({ place, frame }: { place: PlaceData; frame: Frame }) {
  const { minor, major, streams } = useMemo(() => ({
    minor: segments(place.meta.roads.filter(r => !MAJOR.has(r.class)).map(r => r.line), frame),
    major: segments(place.meta.roads.filter(r => MAJOR.has(r.class)).map(r => r.line), frame),
    streams: segments(place.meta.streams, frame),
  }), [place, frame]);
  useEffect(() => () => { minor.dispose(); major.dispose(); streams.dispose(); }, [minor, major, streams]);

  return (
    <group raycast={() => null}>
      <lineSegments geometry={minor} raycast={() => null}>
        <lineBasicMaterial color={PALETTE.road} transparent opacity={0.55} />
      </lineSegments>
      <lineSegments geometry={major} raycast={() => null}>
        <lineBasicMaterial color={PALETTE.roadMajor} />
      </lineSegments>
      <lineSegments geometry={streams} raycast={() => null}>
        <lineBasicMaterial color={PALETTE.stream} />
      </lineSegments>
    </group>
  );
}
