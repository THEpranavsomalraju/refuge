import { useCallback, useEffect, useState } from 'react';
import { buildPlace, listPlaces, suggestPlace, type BuildJob, type PlaceEntry, type PlaceSource, type Suggestion } from './places';

export interface PlaceRef { id: string; source: PlaceSource }

/**
 * Pick a built place, or type any U.S. city to build it with the local build service.
 * Part of the scene's dev tools; the game UI can reuse the helpers in places.ts.
 */
export function PlacePicker({ current, onPick }: { current: PlaceRef; onPick: (p: PlaceRef) => void }) {
  const [places, setPlaces] = useState<PlaceEntry[]>([]);
  const [service, setService] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [area, setArea] = useState<'rural' | 'urban'>('rural');
  const [job, setJob] = useState<BuildJob | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await listPlaces();
    setPlaces(r.places);
    setService(r.service);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const check = async () => {
    if (!query.trim()) return;
    setBusy(true); setMessage('Looking up the city and counting buildings…'); setSuggestion(null);
    try {
      const s = await suggestPlace(query.trim());
      setSuggestion(s); setArea(s.suggested_area); setMessage('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const build = async () => {
    if (!suggestion) return;
    setBusy(true); setMessage('');
    try {
      const done = await buildPlace(suggestion.query, area, setJob);
      await refresh();
      onPick({ id: done.place_id, source: done.source ?? 'generated' });
      setJob(null); setSuggestion(null); setQuery('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const value = `${current.source}:${current.id}`;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ display: 'grid', gap: 3 }}>
        <span style={muted}>Place</span>
        <select id="place-select" value={value} style={input}
          onChange={e => { const [source, id] = e.target.value.split(':'); onPick({ id, source: source as PlaceSource }); }}>
          {!places.some(p => `${p.source}:${p.place_id}` === value) && <option value={value}>{current.id}</option>}
          {places.map(p => (
            <option key={`${p.source}:${p.place_id}`} value={`${p.source}:${p.place_id}`}>
              {(p.name ?? p.place_id).replace(', USA', '')} · {p.buildings.toLocaleString()} bldgs{p.source === 'generated' ? ' · built' : ''}
            </option>
          ))}
        </select>
      </label>

      <form style={{ display: 'grid', gap: 4 }} onSubmit={e => { e.preventDefault(); check(); }}>
        <span style={muted}>Load any U.S. city</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <input id="city-query" style={{ ...input, flex: 1 }} placeholder="e.g. Wilmington, North Carolina"
            value={query} onChange={e => setQuery(e.target.value)} disabled={!service || busy} />
          <button style={btn} type="submit" disabled={!service || busy || !query.trim()}>Check</button>
        </div>
        {!service && <span style={muted}>Build service not running. Start it with <code>places/.venv/Scripts/python -m places.server</code>.</span>}
      </form>

      {suggestion && !job && (
        <div style={card}>
          <div style={{ fontWeight: 600 }}>{suggestion.query}</div>
          <div style={muted}>{suggestion.buildings.toLocaleString()} buildings · {suggestion.pop_night.toLocaleString()} people at night · {suggestion.area_km2} km²</div>
          {suggestion.will_trim_to && <div style={muted}>Large city: keeps the most-populated square with up to {suggestion.will_trim_to.toLocaleString()} buildings.</div>}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span>Traffic</span>
            <select id="area-select" style={input} value={area} onChange={e => setArea(e.target.value as 'rural' | 'urban')}>
              <option value="rural">rural</option>
              <option value="urban">urban</option>
            </select>
            <span style={muted}>suggested {suggestion.suggested_area} ({suggestion.density_per_km2.toLocaleString()} people/km²)</span>
          </label>
          <button style={btn} onClick={build} disabled={busy}>Build this city</button>
        </div>
      )}

      {job && (
        <div style={card}>
          <div>{job.status === 'queued' ? 'Waiting for another build…' : `Building: ${job.step ?? 'starting'}`}</div>
          {job.steps && <progress max={job.steps.length} value={(job.step_index ?? 0) + (job.status === 'done' ? 1 : 0)} style={{ width: '100%' }} />}
          <div style={muted}>{job.elapsed_s ?? 0} s · a first build takes about 1–3 minutes</div>
        </div>
      )}
      {message && <div style={{ fontSize: 12.5 }}>{message}</div>}
    </div>
  );
}

const muted: React.CSSProperties = { color: '#93a4a0', fontSize: 12 };
const input: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, padding: '4px 6px', borderRadius: 5, border: '1px solid #3a4a47',
  background: '#101817', color: '#e3eae7',
};
const btn: React.CSSProperties = {
  font: 'inherit', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #3a4a47',
  background: '#1c2826', color: '#e3eae7', cursor: 'pointer',
};
const card: React.CSSProperties = { display: 'grid', gap: 4, padding: 8, borderRadius: 6, border: '1px solid #2c3a37', background: '#131c1b' };
