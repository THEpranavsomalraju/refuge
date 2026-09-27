import { useState } from 'react';
import { Game } from '../../game/Game';
import { useGame } from '../../game/store';
import { Town, type LoadState } from '../../scene';

// Adapter: the ONLY landing file that imports scene/ and game/. If their APIs change,
// only this file changes. Body is the old full-screen App.tsx, unchanged.
export function GameMount() {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const placeId = useGame(s => s.placeId);
  return (
    <>
      <Town placeId={placeId} onLoad={setLoad} />
      <Game load={load} />
    </>
  );
}
