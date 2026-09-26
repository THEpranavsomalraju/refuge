import type { DetailedResult, ShelterCandidate, ShelterPlan, TornadoScenario } from '../../../sim/core/index.js';
import type { BuildingRecord, CellRecord, CrossingRecord } from '../scene';
import paramsJson from '../../../sim/params/sim_params.json';
import protectionsJson from '../../../sim/params/protections.json';

export type { DetailedResult, ShelterCandidate, ShelterPlan, TornadoScenario };

export type WorkerRequest = { id: number } & (
  | { kind: 'load'; place: { buildings: BuildingRecord[]; cells: CellRecord[]; crossings: CrossingRecord[] } }
  | { kind: 'run'; scenario: TornadoScenario }
  | { kind: 'candidates'; scenario: TornadoScenario }
  | { kind: 'optimize'; scenario: TornadoScenario; budget: number; selected: string[] }
);
export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
type Body<K> = K extends WorkerRequest ? Omit<K, 'id'> : never;

/** Calibrated params (ML lead) and protection settings, for the UI's own display needs. */
export const riskBands = { ...paramsJson.risk_bands, min_cell_people: paramsJson.min_cell_people };
export const shelterRules = protectionsJson.shelter;
export const defaultBudget = protectionsJson.default_budget_usd;

const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const res = event.data;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) p.resolve(res.value); else p.reject(new Error(res.error));
};

function call<T>(body: Body<WorkerRequest>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ ...body, id });
  });
}

export const sim = {
  load: (place: Body<Extract<WorkerRequest, { kind: 'load' }>>['place']) => call<null>({ kind: 'load', place }),
  run: (scenario: TornadoScenario) => call<DetailedResult>({ kind: 'run', scenario }),
  candidates: (scenario: TornadoScenario) => call<ShelterCandidate[]>({ kind: 'candidates', scenario }),
  optimize: (scenario: TornadoScenario, budget: number, selected: string[]) =>
    call<{ plan: ShelterPlan; result: DetailedResult }>({ kind: 'optimize', scenario, budget, selected }),
};
