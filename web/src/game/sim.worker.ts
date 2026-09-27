/// <reference lib="webworker" />
// Runs the simulation engine (sim/core, the same code the CLI uses) off the main
// thread so the 3D scene keeps animating while 500 runs and the plan search execute.
import {
  optimizeShelters, shelterCandidates, simulateDetailed, simulateHurricane,
  type HurricaneParams, type HurricaneScenario, type Place, type ProtectionConfig, type SimParams, type TornadoScenario,
} from '../../../sim/core/index.js';
import paramsJson from '../../../sim/params/sim_params.json';
import protectionsJson from '../../../sim/params/protections.json';
import hurricaneJson from '../../../sim/params/hurricane.json';
import type { WorkerRequest, WorkerResponse } from './simClient';

const params = paramsJson as unknown as SimParams;
const protections = protectionsJson as unknown as ProtectionConfig;
const hp = hurricaneJson as unknown as HurricaneParams;
let place: Place | null = null;

type AnyScenario = TornadoScenario | HurricaneScenario;
const run = (s: AnyScenario) => s.hazard === 'hurricane'
  ? simulateHurricane(s, place!, params, hp, protections)
  : simulateDetailed(s, place!, params, protections);

function handle(req: WorkerRequest): unknown {
  if (req.kind === 'load') { place = req.place as unknown as Place; return null; }
  if (!place) throw new Error('place not loaded');
  const s = req.scenario as AnyScenario;
  switch (req.kind) {
    case 'run': return run(s);
    case 'candidates': return shelterCandidates(s, place, params, protections, hp);
    case 'optimize': {
      const plan = optimizeShelters({ ...s, protections: [] }, place, params, protections, req.budget, req.selected, hp);
      const shelters = plan.building_ids.map(building_id => ({ type: 'shelter' as const, building_id }));
      return { plan, result: run({ ...s, protections: shelters }) };
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  let res: WorkerResponse;
  try { res = { id: req.id, ok: true, value: handle(req) }; }
  catch (error) { res = { id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(res);
};
