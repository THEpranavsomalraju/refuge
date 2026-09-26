/// <reference lib="webworker" />
// Runs the simulation engine (sim/core, the same code the CLI uses) off the main
// thread so the 3D scene keeps animating while 500 runs and the plan search execute.
import {
  optimizeShelters, shelterCandidates, simulateDetailed,
  type Place, type ProtectionConfig, type SimParams, type TornadoScenario,
} from '../../../sim/core/index.js';
import paramsJson from '../../../sim/params/sim_params.json';
import protectionsJson from '../../../sim/params/protections.json';
import type { WorkerRequest, WorkerResponse } from './simClient';

const params = paramsJson as unknown as SimParams;
const protections = protectionsJson as unknown as ProtectionConfig;
let place: Place | null = null;

function handle(req: WorkerRequest): unknown {
  if (req.kind === 'load') { place = req.place as unknown as Place; return null; }
  if (!place) throw new Error('place not loaded');
  const s = req.scenario as TornadoScenario;
  switch (req.kind) {
    case 'run': return simulateDetailed(s, place, params, protections);
    case 'candidates': return shelterCandidates(s, place, params, protections);
    case 'optimize': {
      const plan = optimizeShelters({ ...s, protections: [] }, place, params, protections, req.budget, req.selected);
      const shelters = plan.building_ids.map(building_id => ({ type: 'shelter' as const, building_id }));
      const result = simulateDetailed({ ...s, protections: shelters }, place, params, protections);
      return { plan, result };
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
