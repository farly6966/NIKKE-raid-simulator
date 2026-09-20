/// <reference lib="webworker" />

import loadHighs from 'highs';
import highsWasmUrl from 'highs/runtime?url';
import { optimizeRaidPlan, type RaidPlannerInput } from './union-raid-planner';

const runtime = loadHighs({ locateFile: () => highsWasmUrl });

self.addEventListener('message', async (event: MessageEvent<RaidPlannerInput>) => {
  try {
    const highs = await runtime;
    // `mip_rel_gap`은 배분기에도 알려 준다 — 단계 추진 판정이 incumbent가 아니라
    // 상계를 봐야 하기 때문이다(`objectiveUpperBound`). 그것을 안 알려 주면 이 값을
    // 푸는 순간 1단계에서 멈춘다.
    const RELATIVE_GAP = 0.00001;
    const BUDGET_SECONDS = 30;
    const plan = optimizeRaidPlan(event.data, (model, options) => highs.solve(model, {
      output_flag: false,
      time_limit: options?.budgetSeconds ?? BUDGET_SECONDS,
      mip_rel_gap: RELATIVE_GAP,
      random_seed: 44,
    }), message => self.postMessage({ kind: 'progress', message }), RELATIVE_GAP);
    self.postMessage({ kind: 'done', plan });
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});

