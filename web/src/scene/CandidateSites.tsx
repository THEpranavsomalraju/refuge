import { Html } from '@react-three/drei';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore } from './store';

const PIN_M = 60;

/** Clickable markers for scene.showCandidateSites; clicks go to scene.onSiteClick. */
export function CandidateSites({ frame }: { frame: Frame }) {
  const sites = useSceneStore(s => s.sites);
  return (
    <group>
      {sites.map(s => {
        const [x, z] = frame.toXZ(s.lon, s.lat);
        const y = frame.groundY(x, z);
        const color = s.selected ? PALETTE.shelter : PALETTE.site;
        const click = () => useSceneStore.getState().onSiteClick?.(s.id);
        return (
          <group key={s.id} position={[x, y, z]}>
            <mesh position={[0, PIN_M / 2, 0]} onClick={e => { e.stopPropagation(); click(); }}>
              <cylinderGeometry args={[3, 3, PIN_M, 8]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={[0, PIN_M, 0]} onClick={e => { e.stopPropagation(); click(); }}>
              <sphereGeometry args={[12, 16, 12]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.5, 0]} raycast={() => null}>
              <ringGeometry args={[18, 24, 24]} />
              <meshBasicMaterial color={color} transparent opacity={0.85} />
            </mesh>
            <Html position={[0, PIN_M + 26, 0]} center zIndexRange={[20, 0]}>
              <button
                type="button"
                onClick={click}
                aria-pressed={!!s.selected}
                style={{
                  font: '600 12px "Public Sans", "Segoe UI", system-ui, sans-serif', whiteSpace: 'nowrap',
                  padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${color}`, color: s.selected ? '#0c1214' : '#e3eae7',
                  background: s.selected ? color : 'rgba(12, 18, 20, 0.85)',
                }}
              >
                {s.label}
              </button>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
