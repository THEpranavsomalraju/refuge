/** Mulberry32; identical uint32 seed and input order produce identical runs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), state | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact Bernoulli trials plus one fractional-population trial. */
export function sampleDeaths(people: number, probability: number, random: () => number): number {
  if (people === 0 || probability === 0) return 0;
  const whole = Math.floor(people);
  let deaths = probability === 1 ? whole : 0;
  if (probability !== 1) for (let i = 0; i < whole; i++) if (random() < probability) deaths++;
  const fraction = people - whole;
  if (fraction > 0 && random() < fraction * probability) deaths++;
  return deaths;
}

/** Empirical nearest-rank quantile; caller supplies a nonempty sorted array. */
export function nearestRank(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}
