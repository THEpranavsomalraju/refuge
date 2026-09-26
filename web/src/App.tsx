import { useState } from 'react';
import { Town, type LoadState } from './scene';
import { DevPanel } from './scene/DevPanel';

// App shell. The game UI (web/src/game, Simulation) mounts here next to the scene.
// Until it exists, the scene's dev panel stands in for it.
export function App() {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <Town placeId="lumberton" onLoad={setLoad} />
      <DevPanel load={load} />
    </div>
  );
}
