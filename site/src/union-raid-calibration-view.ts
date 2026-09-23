import { calibratedCandidates, calibrationEffect, calibrationGroupKey, calibrationSampleStatus, calibrationTrend, sampleRatio, type CalibrationState } from './union-raid-calibration';
import { remainingCandidates, remainingPhases, usedCounts, type FiredShot } from './union-raid-live';
import type { RaidPlannerInput, RaidPlannerPlan } from './union-raid-planner';

interface Context {
  base: RaidPlannerInput;
  fired: FiredShot[];
  state: CalibrationState;
  plan?: RaidPlannerPlan;
}

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const deviation = (ratio: number): string => ratio === 1 ? '與模擬相同'
  : `模擬${ratio > 1 ? '低估' : '高估'} ${Math.abs((ratio - 1) * 100).toFixed(2)}%`;
const yi = (damage: number): string => `${(damage / 100_000_000).toFixed(2)} 億`;
const reached = { phase1: '第 1 階段', phase2: '第 2 階段', phase3: '第 3 階段', endless: '無限五王' };

/** 預覽使用獨立 worker；任一盤面變動立即作廢，絕不把舊預覽套到新紀錄。 */
export function mountCalibrationPanel(host: HTMLElement, callbacks: {
  labelOf: (name: string) => string;
  change: (state: CalibrationState, preview?: RaidPlannerPlan) => void;
  samplesChanged: (replan?: boolean) => void;
  editShot: (shot: FiredShot) => void;
  removeShot: (shot: FiredShot) => void;
}) {
  let context: Context | undefined;
  let worker: Worker | undefined;
  let preview: { state: CalibrationState; plan: RaidPlannerPlan } | undefined;
  let message = '';
  let expanded = false;
  const cancel = (): void => {
    worker?.terminate(); worker = undefined; preview = undefined; message = '';
  };
  const button = (text: string, action: () => void): HTMLButtonElement => {
    const result = node('button', text);
    result.type = 'button'; result.className = 'roster-import'; result.addEventListener('click', action);
    return result;
  };

  function startPreview(state: CalibrationState): void {
    if (!context?.plan) return;
    cancel();
    const { base, fired } = context;
    const next = new Worker(new URL('./union-planner.worker.ts', import.meta.url), { type: 'module' });
    worker = next; message = '正在計算校正預覽，現有排刀尚未變更…';
    next.addEventListener('message', (event: MessageEvent<{ kind: string; message?: string; plan?: RaidPlannerPlan }>) => {
      if (worker !== next) return;
      if (event.data.kind === 'progress') return;
      next.terminate(); worker = undefined;
      if (event.data.kind === 'done' && event.data.plan) {
        preview = { state, plan: event.data.plan }; message = '';
      } else message = `校正預覽失敗：${event.data.message ?? '未知錯誤'}。現有排刀與係數未變更。`;
      draw();
    });
    next.addEventListener('error', () => {
      if (worker !== next) return;
      next.terminate(); worker = undefined;
      message = '校正預覽失敗。現有排刀與係數未變更，可重試。'; draw();
    });
    next.postMessage({ phases: remainingPhases(base.phases, fired),
      candidates: remainingCandidates(calibratedCandidates(base.candidates, state), fired),
      alreadyUsed: usedCounts(fired) });
    draw();
  }

  function draw(): void {
    host.replaceChildren();
    if (!context) return;
    const { base, fired, state, plan } = context;
    const title = node('label'); title.className = 'live-calibration-toggle';
    const toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = state.enabled;
    toggle.setAttribute('role', 'switch'); toggle.ariaLabel = '啟用實戰傷害校正';
    toggle.addEventListener('change', () => {
      cancel();
      // 關閉時清除已採用係數，下次開啟仍需重新預覽確認。
      callbacks.change({ enabled: toggle.checked, factors: {} });
    });
    title.append(toggle, node('strong', '實戰傷害校正（實驗功能）'));
    host.append(title, node('p', state.enabled
      ? '已開啟分析。係數可能無法解釋模型誤差；僅供本盤手動試算，預覽並確認後才影響排刀。'
      : '目前關閉，排刀使用原始模擬值；實際回填仍會正常扣血、扣刀並重排。'));
    if (state.legacyFactorsCleared) host.append(node('p', '已清除舊版整隻王的校正係數；出刀紀錄保留，請依同王、同五人刀型重新預覽確認。'));
    if (!state.enabled) return;
    host.append(node('p', '同王、同五人刀型分開分析（排列順序不限）；每種刀型獨立累積 5 刀、3 位成員。只納入已核對且條件可比較的完整出刀，套用僅影響該王同刀型的剩餘候選。階段、爆裂與操作條件仍需人工核對。已採用係數不隨樣本增減自動更新，可隨時撤銷。'));
    const groups = new Map<string, { bossName: string; squad: string[] }>();
    for (const row of [...base.candidates, ...fired]) {
      const key = calibrationGroupKey(row);
      if (key && !groups.has(key)) groups.set(key, row);
    }
    const groupLabel = (key: string): string => {
      const group = groups.get(key);
      return group ? `${group.bossName}／${group.squad.map(callbacks.labelOf).join('、')}` : '未知刀型';
    };
    const grid = node('div'); grid.className = 'live-calibration-grid';
    for (const [key, group] of groups) {
      const trend = calibrationTrend(fired, key);
      const card = node('section'); card.className = 'live-calibration-boss';
      const factor = state.factors[key] ?? 1;
      card.append(node('strong', group.bossName), node('p', `刀型：${group.squad.map(callbacks.labelOf).join('、')}`),
        node('p', `有效樣本 ${trend.count} 刀／${trend.members} 人 · 目前係數 ×${factor.toFixed(4)}`));
      const description = !trend.enough ? '樣本不足：至少需 5 刀、3 位成員。'
        : !trend.stable ? '偏差分散，暫不建議統一比例校正。'
        : trend.factor < 0.5 || trend.factor > 1.5 ? '偏差過大，請先核對模擬條件；不提供比例校正。'
        : !trend.ready ? '目前未達 5% 偏差提醒門檻。'
        : `${deviation(trend.factor)}。建議係數 ×${trend.factor.toFixed(4)}。`;
      card.append(node('p', description));
      if (factor !== 1) {
        const effect = calibrationEffect(fired, key, state.revisions?.[key]);
        const evaluation = node('p'); evaluation.className = 'live-calibration-effect';
        evaluation.textContent = effect.count
          ? `校正成效：後續 ${effect.count} 刀，平均誤差由 ${(effect.originalError * 100).toFixed(2)}% → ${(effect.calibratedError * 100).toFixed(2)}%。${effect.count < 5 ? '後續樣本未滿 5 刀，先觀察。' : effect.worse ? '校正後誤差較大，建議檢查或撤銷此刀型校正。' : effect.calibratedError < effect.originalError ? '目前校正後較接近實際。' : '目前未見明顯改善，繼續觀察。'}`
          : '校正成效：尚無後續有效出刀；開始追蹤前的紀錄不拿來評分。';
        card.append(evaluation);
      }
      if (trend.ready && Math.abs(trend.factor - factor) >= 0.005) {
        const action = button('預覽校正與重排', () => startPreview({ enabled: true, factors: { ...state.factors, [key]: trend.factor } }));
        action.disabled = !plan || !!worker; card.append(action);
      }
      if (factor !== 1) card.append(button('撤銷此刀型校正', () => {
        const factors = { ...state.factors }; delete factors[key]; cancel(); callbacks.change({ enabled: true, factors });
      }));
      grid.append(card);
    }
    host.append(grid);
    const note = node('p', '提醒門檻為試行設定：至少八成同方向，且至少八成落在比例中位數正負 3 個百分點內；不是準確度保證。校正成效只計本次係數開始追蹤後、已核對的完整出刀，以實際傷害為分母比較平均絕對百分比誤差。改係數後重新累積，升級前的紀錄不補算。');
    note.className = 'field-note'; host.append(note);
    if (message) { const status = node('p', message); status.setAttribute('role', 'status'); host.append(status); }
    if (worker) host.append(button('取消預覽', () => { cancel(); draw(); }));
    if (preview && plan) {
      const box = node('section'); box.className = 'live-calibration-preview'; box.setAttribute('aria-label', '校正重排預覽');
      box.append(node('h4', '校正重排預覽（尚未套用）'));
      for (const [key, factor] of Object.entries(preview.state.factors)) {
        if (factor !== (state.factors[key] ?? 1)) box.append(node('p', `${groupLabel(key)}：係數 ×${(state.factors[key] ?? 1).toFixed(4)} → ×${factor.toFixed(4)}`));
      }
      box.append(node('p', `推進階段：${reached[plan.reached]} → ${reached[preview.plan.reached]}；剩餘排刀數：${plan.plannedAttacks} → ${preview.plan.plannedAttacks}；無限五王預估：${yi(plan.endlessDamage)} → ${yi(preview.plan.endlessDamage)}。`));
      box.append(node('p', '前後使用不同傷害假設；預估數字增加不代表實際輸出提升。'));
      if (!preview.plan.provenOptimal) box.append(node('p', '這次求解尚未證明最優，顯示目前可行方案。'));
      const list = node('ul');
      const assignments = (value: RaidPlannerPlan, member: string): string => value.bars.flatMap(bar =>
        bar.shots.filter(s => s.memberId === member).map(s => `${s.phase === 3 ? '無限' : `${s.phase + 1}階`}／${s.bossName}／${s.deckLabel || `第 ${s.deckIndex + 1} 隊`}`)).sort().join('、') || '未排刀';
      const members = new Map([...plan.members, ...preview.plan.members].map(m => [m.memberId, m.memberName]));
      for (const [id, name] of members) {
        const before = assignments(plan, id); const after = assignments(preview.plan, id);
        if (before !== after) list.append(node('li', `${name}：${before} → ${after}`));
      }
      box.append(list.childElementCount ? list : node('p', '成員、隊伍與階段分配相同；傷害預估或出刀順序可能改變。'));
      const queues = node('details'); queues.append(node('summary', '查看校正後完整出刀順序'));
      for (const bar of preview.plan.bars.filter(b => b.shots.length)) {
        queues.append(node('p', `${bar.phase === 3 ? '無限' : `${bar.phase + 1}階`}／${bar.shots[0]!.bossName}：${bar.shots.map((s, i) => `${i + 1}. ${s.memberName}（${s.deckLabel || `第 ${s.deckIndex + 1} 隊`}，${yi(s.damage)}）`).join(' → ')}`));
      }
      box.append(queues);
      box.append(button('確認套用校正', () => {
        if (!preview) return;
        const selected = preview; cancel(); callbacks.change(selected.state, selected.plan);
      }), button('取消', () => { cancel(); draw(); }));
      host.append(box);
    }
    const pendingFinishers = fired.filter(s => s.finishingShot && calibrationSampleStatus(s) === 'unreviewed').length;
    const details = node('details'); details.open = expanded || pendingFinishers > 0;
    details.addEventListener('toggle', () => { expanded = details.open; });
    details.append(node('summary', `檢查出刀樣本與誤差（${fired.length} 刀${pendingFinishers ? `，${pendingFinishers} 筆收尾待確認` : ''}）`));
    details.append(node('p', '擊殺王不代表傷害溢出。極限收掉且正常完整出刀可納入；確認因王提早死亡而未打滿時，才標記「溢出尾刀」。未核對的紀錄暫不納入。'));
    fired.forEach((shot, index) => {
      const row = node('div'); row.className = 'live-calibration-sample';
      const ratio = sampleRatio(shot);
      row.append(node('span', `${index + 1}. ${shot.memberName}／${shot.bossName}／${shot.phase === 3 ? '無限' : `${shot.phase + 1}階`}／${shot.deckLabel || `第 ${shot.deckIndex + 1} 隊`}：實際 ${yi(shot.damage)}${ratio === undefined ? '；舊紀錄缺少有效模擬快照，不納入' : `；原始 ${yi(shot.simulatedDamage!)}；${deviation(ratio)}；當時預估 ${yi(shot.predictedDamage ?? shot.simulatedDamage!)}`}`));
      const group = calibrationGroupKey(shot);
      row.append(node('span', group ? `刀型：${shot.squad.map(callbacks.labelOf).join('、')}` : '缺少完整五人編成，不納入刀型分析'));
      const select = node('select'); select.ariaLabel = `第 ${index + 1} 刀樣本狀態`;
      for (const [value, label] of [['unreviewed', '待確認／暫不納入'], ['verified', '正常完整出刀／極限收尾（納入）'], ['overflow', '已確認溢出尾刀（排除）'], ['abnormal', '失誤／斷線／條件不同（排除）']]) {
        const option = node('option', label); option.value = value!; select.append(option);
      }
      select.value = calibrationSampleStatus(shot); select.disabled = ratio === undefined || !group;
      select.addEventListener('change', () => {
        shot.calibrationSample = select.value as FiredShot['calibrationSample'];
        shot.finishingReviewed = select.value !== 'unreviewed'; callbacks.samplesChanged();
      });
      row.append(select);
      if (shot.calibrationSample === 'overflow') row.append(node('span', '已確認溢出尾刀：排除'));
      else if (shot.finishingShot) row.append(node('span', calibrationSampleStatus(shot) === 'unreviewed'
        ? '疑似收尾刀：請確認是否正常打滿' : calibrationSampleStatus(shot) === 'verified'
          ? '完整收尾刀：納入分析' : '收尾刀：依異常標記排除'));
      row.append(button('修改傷害', () => callbacks.editShot(shot)),
        button('撤銷此筆出刀', () => callbacks.removeShot(shot)));
      details.append(row);
    });
    host.append(details);
  }

  return { render(next?: Context): void { cancel(); context = next; draw(); } };
}
