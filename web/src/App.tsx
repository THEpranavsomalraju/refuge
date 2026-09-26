import { useState } from 'react';
import { Town, type LoadState } from './scene';
import { Game } from './game/Game';
import { useGame } from './game/store';

// App shell. The game UI (web/src/game, Simulation) mounts here next to the scene.
export function App() {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  // The game picks the town (past event or chosen city); Lumberton is the opening backdrop.
  const placeId = useGame(s => s.placeId);
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <Town placeId={placeId} onLoad={setLoad} />
      <Game load={load} />
    </div>
  );
}
