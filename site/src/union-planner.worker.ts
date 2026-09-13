/// <reference lib="webworker" />

import loadHighs from 'highs';
import highsWasmUrl from 'highs/runtime?url';
import { optimizeRaidPlan, type RaidPlannerInput } from './union-raid-planner';

const runtime = loadHighs({ locateFile: () => highsWasmUrl });

self.addEventListener('message', async (event: MessageEvent<RaidPlannerInput>) => {
  try {
    const highs = await runtime;
    const plan = optimizeRaidPlan(event.data, model => highs.solve(model, {
      output_flag: false,
      time_limit: 30,
      mip_rel_gap: 0.00001,
      random_seed: 44,
    }), message => self.postMessage({ kind: 'progress', message }));
    self.postMessage({ kind: 'done', plan });
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});

