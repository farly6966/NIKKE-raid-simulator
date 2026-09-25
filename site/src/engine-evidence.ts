import type { SimulationRequest, SimulationResult } from './types';

export interface EngineEvidenceCase {
  id: number;
  member: number;
  bossIndex: number;
  deckIndex: number;
  request: SimulationRequest;
  expected: Pick<SimulationResult, 'squadTotal' | 'hitCount' | 'charTotals'>;
}

/**
 * 只匯出重跑所需的完整計算輸入與結果；成員名稱、openid、cookie 不進驗證檔。
 * request 仍含角色育成資料，檔案只應保存在本機或交給信任的驗證者。
 */
export function engineEvidence(rows: Array<{
  job: { member: { openid: string }; bossIndex: number; deckIndex: number };
  detail?: { request: SimulationRequest; result: SimulationResult };
}>): { format: 'nikke-engine-evidence'; version: 1; cases: EngineEvidenceCase[] } {
  const members = new Map<string, number>();
  const cases: EngineEvidenceCase[] = [];
  for (const row of rows) {
    if (!row.detail || row.detail.request.squad.length !== 5) continue;
    const { request, result } = row.detail;
    if (!Number.isFinite(result.squadTotal) || !Number.isFinite(result.hitCount)) continue;
    let member = members.get(row.job.member.openid);
    if (member === undefined) {
      member = members.size + 1;
      members.set(row.job.member.openid, member);
    }
    cases.push({
      id: cases.length + 1,
      member,
      bossIndex: row.job.bossIndex,
      deckIndex: row.job.deckIndex,
      request,
      expected: {
        squadTotal: result.squadTotal,
        hitCount: result.hitCount,
        charTotals: result.charTotals,
      },
    });
  }
  return { format: 'nikke-engine-evidence', version: 1, cases };
}
