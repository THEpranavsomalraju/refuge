import { useState } from 'react';
import { Town, type LoadState } from './scene';
import { Game } from './game/Game';

// App shell. The game UI (web/src/game, Simulation) mounts here next to the scene.
export function App() {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <Town placeId="lumberton" onLoad={setLoad} />
      <Game load={load} />
    </div>
  );
}
