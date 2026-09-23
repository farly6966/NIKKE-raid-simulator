import { squadPreview } from './share-panel';
import { calibratedCandidates, calibrationGroupKey, freshCalibration, readCalibration, trackCalibration } from './union-raid-calibration';
import { mountCalibrationPanel } from './union-raid-calibration-view';
import {
  memberAttackCapacity, type RaidPlannerCandidate, type RaidPlannerInput, type RaidPlannerPlan,
  type RaidPlannerShot,
} from './union-raid-planner';
import {
  actualPhaseIndex, findCandidate, remainingCandidates, remainingPhases, usedCounts, type FiredShot,
} from './union-raid-live';
import { LIVE_SESSION_KEY, makeLiveBackup, readLiveBase, readLiveImport, readLiveShots, readLiveStored,
  unusualDamage, type LiveRecovery, type LiveSession } from './union-raid-session';

export interface LiveRaidHosts {
  panel: HTMLElement;
}

export interface LiveRaidDeps {
  imageOf: (name: string) => string | undefined;
  labelOf: (name: string) => string;
}

export type LiveRaidHandle = Record<string, never>;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const YI = 100_000_000;
const yi = (value: number): string => `${(value / YI).toLocaleString('zh-TW', {
  minimumFractionDigits: 0, maximumFractionDigits: 2,
})} 億`;

const BASE_KEY = 'nikke-live-raid-base-v1';
const FIRED_KEY = 'nikke-live-raid-fired-v1';
const CALIBRATION_KEY = 'nikke-live-raid-calibration-v1';

/** 대기 중인 한 발을 가리키는 열쇠 — 지난 방안과 견줘 자리가 바뀌었는지 볼 때 쓴다. */
const pendingKey = (shot: { phase: number; bossIndex: number; memberId: string; deckIndex: number }): string =>
  `${shot.phase}:${shot.bossIndex}:${shot.memberId}:${shot.deckIndex}`;

const PHASE_LABELS = ['第 1 階段', '第 2 階段', '第 3 階段', '無限五王'];
/** 사람별 카드의 줄머리 — 긴 이름을 그대로 쓰면 카드가 이름으로 가득 찬다. */
const PHASE_SHORT = ['1階', '2階', '3階', '無限'];

/** 玩家看得懂的隊伍稱呼：有自訂名稱就用名稱，沒有才退回「第 N 隊」。 */
export const deckTitle = (deck: { deckIndex: number; deckLabel?: string }): string =>
  deck.deckLabel?.trim() || `第 ${deck.deckIndex + 1} 隊`;

/**
 * 「실전 추연(BETA)」 — 미리 낸 시뮬레이션 결과를 불러와, 현장에서 확정되는 대로
 * 남은 문제를 계속 다시 푼다.
 *
 * 유니온 탭과는 일부러 분리한다 — 명단 가져오기·Boss 편성 같은 준비 단계가 전혀
 * 필요 없고, 조작하는 사람도 현장에서는 다른 사람일 수 있다(§AGENTS 대화 참고).
 * 그래서 입력은 JSON 파일 하나뿐이고, 여기서 나오는 상태는 이 브라우저에만 남는다.
 */
export function mountLiveRaid(hosts: LiveRaidHosts, deps: LiveRaidDeps): LiveRaidHandle {
  const { panel } = hosts;
  const importBox = panel.querySelector<HTMLElement>('[data-live-import]')!;
  const importStatus = panel.querySelector<HTMLElement>('[data-live-import-status]')!;
  const fileInput = panel.querySelector<HTMLInputElement>('[data-live-file]')!;
  const dropZone = panel.querySelector<HTMLElement>('[data-live-drop]')!;
  const board = panel.querySelector<HTMLElement>('[data-live-board]')!;
  const status = panel.querySelector<HTMLElement>('[data-live-status]')!;
  const phasesBox = panel.querySelector<HTMLElement>('[data-live-phases]')!;
  const summaryBox = panel.querySelector<HTMLElement>('[data-live-summary]')!;
  const membersBox = panel.querySelector<HTMLElement>('[data-live-members]')!;
  const recorderBox = panel.querySelector<HTMLElement>('[data-live-recorder]')!;
  const overviewBox = panel.querySelector<HTMLElement>('[data-live-overview]')!;
  const bossesBox = panel.querySelector<HTMLElement>('[data-live-bosses]')!;
  const reimportButton = panel.querySelector<HTMLButtonElement>('[data-live-reimport]')!;
  const resetButton = panel.querySelector<HTMLButtonElement>('[data-live-reset]')!;

  let base: RaidPlannerInput | undefined;
  let fired: FiredShot[] = [];
  let plan: RaidPlannerPlan | undefined;
  let worker: Worker | undefined;
  let lastPendingKeys = new Set<string>();
  let calibration = freshCalibration();
  let recovery: LiveRecovery | undefined;
  let mutation = 0;
  const sessionBox = el('section', 'live-session');
  sessionBox.setAttribute('aria-label', '實戰進度備份與還原');
  const saveStatus = el('p', 'field-note'); saveStatus.setAttribute('role', 'status');
  const actions = el('div', 'live-toolbar');
  const exportButton = el('button', 'roster-import', '匯出實戰進度'); exportButton.type = 'button';
  const recoverButton = el('button', 'roster-import', '還原上一份進度'); recoverButton.type = 'button';
  const actionBox = el('section', 'live-action-confirm');
  actionBox.setAttribute('aria-label', '操作確認'); actionBox.setAttribute('role', 'region');
  const history = el('details', 'live-history');
  actions.append(exportButton, recoverButton); sessionBox.append(actions, saveStatus, actionBox, history);
  board.before(sessionBox);
  const calibrationBox = el('section', 'live-calibration');
  summaryBox.before(calibrationBox);
  const calibrationPanel = mountCalibrationPanel(calibrationBox, {
    labelOf: deps.labelOf,
    change: (next, preview) => {
      calibration = trackCalibration(next, calibration);
      persist();
      if (preview) {
        worker?.terminate(); worker = undefined;
        const previous = lastPendingKeys;
        plan = preview;
        lastPendingKeys = new Set(plan.bars.flatMap(bar => bar.shots.map(pendingKey)));
        status.textContent = '';
        renderAll(previous);
      } else resolve();
    },
    samplesChanged: (replan) => { persist(); if (replan) resolve(); else renderAll(lastPendingKeys); },
    editShot,
    removeShot,
  });
  const effectiveCandidates = (): RaidPlannerCandidate[] => calibratedCandidates(base?.candidates ?? [], calibration);

  const persist = (): void => {
    mutation++; actionBox.replaceChildren();
    exportButton.disabled = !base; recoverButton.disabled = !recovery;
    recoverButton.textContent = recovery ? `還原上一份進度（${recovery.label}）` : '還原上一份進度';
    if (!base) return;
    try {
      const current = makeLiveBackup({ base, fired, calibration });
      // 盤面、出刀、係數與還原點一次寫入，避免部分成功造成彼此不一致。
      localStorage.setItem(LIVE_SESSION_KEY, JSON.stringify({ current, recovery }));
      saveStatus.textContent = `已儲存至此瀏覽器：${new Date(current.savedAt).toLocaleString('zh-TW')}。可匯出備份交接或換電腦。`;
    } catch {
      saveStatus.textContent = '尚未存入此瀏覽器：儲存空間不足或儲存被停用。畫面仍保有目前進度，請立即匯出實戰進度備份。';
    }
  };

  const restore = (): void => {
    try {
      const current = localStorage.getItem(LIVE_SESSION_KEY);
      if (current) {
        const saved = readLiveStored(JSON.parse(current));
        base = saved.current.base; fired = saved.current.fired; calibration = trackCalibration(saved.current.calibration);
        recovery = saved.recovery; persist(); return;
      }
      const savedBase = localStorage.getItem(BASE_KEY);
      const savedFired = localStorage.getItem(FIRED_KEY);
      if (savedBase) {
        const nextBase = readLiveBase(JSON.parse(savedBase));
        const nextFired = savedFired ? readLiveShots(JSON.parse(savedFired)) : [];
        try { calibration = readCalibration(JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? 'null')); }
        catch { calibration = freshCalibration(); }
        base = nextBase; fired = nextFired; calibration = trackCalibration(calibration); persist();
      } else saveStatus.textContent = '匯入試算結果或實戰進度備份後，會自動儲存在此瀏覽器。';
    } catch {
      saveStatus.textContent = '無法讀取此瀏覽器的實戰進度。原有儲存內容保留，請匯入有效備份還原。';
    }
    exportButton.disabled = !base; recoverButton.disabled = !recovery;
  };

  function checkpoint(label: string): void {
    if (base) recovery = { label, snapshot: makeLiveBackup({ base, fired, calibration }) };
  }

  function requestAction(message: string, label: string, action: () => void): void {
    const version = mutation;
    const confirm = el('button', 'roster-import', label); confirm.type = 'button';
    const cancel = el('button', 'roster-import', '取消操作'); cancel.type = 'button';
    confirm.addEventListener('click', () => { if (mutation === version) { actionBox.replaceChildren(); action(); } });
    cancel.addEventListener('click', () => actionBox.replaceChildren());
    actionBox.replaceChildren(el('p', undefined, message), confirm, cancel);
    actionBox.scrollIntoView?.({ block: 'nearest' }); cancel.focus();
  }

  function applySession(next: LiveSession): void {
    base = next.base; fired = next.fired; calibration = trackCalibration(next.calibration);
    lastPendingKeys = new Set(); plan = undefined;
    importBox.hidden = true; board.hidden = false; importStatus.textContent = '';
    persist(); resolve();
  }

  exportButton.addEventListener('click', () => {
    if (!base) return;
    try {
      const backup = makeLiveBackup({ base, fired, calibration });
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const revoke = URL.revokeObjectURL.bind(URL);
      const link = document.createElement('a'); link.href = url;
      link.download = `實戰進度_${backup.savedAt.replace(/[:.]/g, '-')}.json`; link.click();
      setTimeout(() => revoke(url), 1000);
    } catch { saveStatus.textContent = '備份下載失敗，請重試；目前畫面中的進度仍保留。'; }
  });
  recoverButton.addEventListener('click', () => {
    if (!recovery) return;
    const selected = recovery;
    requestAction(`還原「${selected.label}」保存的進度（${selected.snapshot.fired.length} 刀）？目前盤面將保留為新的還原點。`, '確認還原', () => {
      checkpoint('還原前'); applySession(selected.snapshot);
    });
  });

  function removeShot(shot: FiredShot): void {
    const index = fired.indexOf(shot);
    if (index < 0) return;
    checkpoint('撤銷出刀前'); fired.splice(index, 1); persist(); resolve();
  }

  function editShot(shot: FiredShot): void {
    const version = mutation;
    const input = el('input', 'live-damage-input'); input.type = 'number'; input.min = '0.01'; input.step = '0.01';
    input.value = String(shot.damage / YI); input.ariaLabel = '修改實際傷害（億）';
    const save = el('button', 'roster-import', '儲存傷害修改'); save.type = 'button';
    const cancel = el('button', 'roster-import', '取消操作'); cancel.type = 'button';
    const feedback = el('p', 'field-note'); feedback.setAttribute('role', 'status');
    save.addEventListener('click', () => {
      const damage = Number(input.value) * YI;
      if (!Number.isFinite(damage) || damage <= 0) { feedback.textContent = '請填入大於 0 的傷害（億）。'; return; }
      const apply = (): void => {
        if (mutation !== version || !base || !fired.includes(shot)) return;
        checkpoint('修改傷害前'); shot.damage = damage;
        const hpBefore = remainingPhases(base.phases, fired.slice(0, fired.indexOf(shot)))[shot.phase]?.[shot.bossIndex];
        shot.finishingShot = shot.phase < 3 && hpBefore !== undefined && damage >= hpBefore;
        shot.calibrationSample = 'unreviewed'; shot.finishingReviewed = false;
        persist(); resolve();
      };
      if (unusualDamage(damage, shot.predictedDamage ?? shot.simulatedDamage)) requestAction(
        `修改為 ${yi(damage)}，與當時預估 ${yi(shot.predictedDamage ?? shot.simulatedDamage!)} 差距較大。請核對單位為「億」，以及是否為未打滿的尾刀。`, '確認傷害無誤', apply);
      else apply();
    });
    cancel.addEventListener('click', () => actionBox.replaceChildren());
    actionBox.replaceChildren(el('p', undefined, `修改 ${shot.memberName}／${shot.bossName} 的實際傷害；修改後需重新核對樣本分類，原始模擬與當時預估保留。`), input, save, cancel, feedback);
    actionBox.scrollIntoView?.({ block: 'nearest' }); input.focus();
  }

  function resolve(): void {
    if (!base) return;
    worker?.terminate();
    const input: RaidPlannerInput = {
      phases: remainingPhases(base.phases, fired),
      candidates: remainingCandidates(effectiveCandidates(), fired),
      alreadyUsed: usedCounts(fired),
    };
    plan = undefined;
    status.textContent = '正在重新計算…';
    renderAll(lastPendingKeys);
    const next = new Worker(new URL('./union-planner.worker.ts', import.meta.url), { type: 'module' });
    worker = next;
    next.addEventListener('message', (event: MessageEvent<{ kind: string; message?: string; plan?: RaidPlannerPlan }>) => {
      if (worker !== next) return;
      if (event.data.kind === 'progress') { status.textContent = event.data.message ?? ''; return; }
      next.terminate(); worker = undefined;
      if (event.data.kind === 'done' && event.data.plan) {
        const previous = lastPendingKeys;
        plan = event.data.plan;
        lastPendingKeys = new Set(plan.bars.flatMap((bar) => bar.shots.map(pendingKey)));
        status.textContent = '';
        renderAll(previous);
      } else {
        status.textContent = `重算失敗：${event.data.message ?? '未知錯誤'}（已確認的紀錄不會遺失，但暫時算不出新的建議出刀）`;
        renderAll(lastPendingKeys);
      }
    });
    next.addEventListener('error', (event) => {
      if (worker !== next) return;
      next.terminate(); worker = undefined;
      status.textContent = `重算失敗：${event.message}`;
      renderAll(lastPendingKeys);
    });
    next.postMessage(input);
  }

  const bossName = (bossIndex: number): string =>
    base?.candidates.find((candidate) => candidate.bossIndex === bossIndex)?.bossName || `第 ${bossIndex + 1} 王`;

  const currentPhase = (): number => base ? actualPhaseIndex(base.phases, fired) : 0;

  /** 이 왕의 다음 한 발로 방안이 고른 것. 없으면 undefined. */
  const suggestedFor = (phase: number, bossIndex: number): RaidPlannerShot | undefined =>
    plan?.bars.find((bar) => bar.phase === phase && bar.bossIndex === bossIndex)?.shots[0];

  /**
   * 建議 그대로 그 자리에서 확정하는 한 쌍(실제 피해 칸 + 버튼).
   *
   * 왕별 목록 맨 아래까지 내려가지 않아도 되게 하려는 것이라 **덱을 고르는 자리는
   * 두지 않는다** — 다른 덱으로 쐈다면 아래 목록의 「換隊伍」나 기록 표를 쓴다.
   */
  function quickConfirm(shot: RaidPlannerShot): HTMLElement {
    const wrap = el('span', 'live-quick-confirm');
    const damageInput = el('input', 'live-damage-input');
    damageInput.type = 'number'; damageInput.min = '0.01'; damageInput.step = '0.01';
    damageInput.value = (shot.damage / YI).toFixed(2);
    damageInput.ariaLabel = `${shot.memberName} 打 ${bossName(shot.bossIndex)} 的實際傷害（億）`;
    const confirm = el('button', 'roster-import', '確認');
    const verification = sampleVerification();
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      const picked = findCandidate(base!.candidates, shot.memberId, shot.bossIndex, shot.deckIndex);
      const damage = Number(damageInput.value);
      if (!picked || !Number.isFinite(damage) || damage <= 0) {
        status.textContent = '請填入大於 0 的實際傷害。';
        return;
      }
      recordShot(picked, shot.phase, damage, verification.checked());
    });
    wrap.append(damageInput, confirm);
    if (calibration.enabled) wrap.append(verification.label);
    return wrap;
  }

  /** 一隊的樣子：五張頭像＋名稱（有取名才顯示名稱文字，沒取名只看頭像就好）。 */
  function teamBadge(deck: { deckIndex: number; deckLabel?: string; squad: string[] }, extra?: string): HTMLElement {
    const box = el('span', 'live-team');
    box.append(squadPreview([deck.squad], deps.imageOf, deps.labelOf));
    const text = [deck.deckLabel?.trim(), extra].filter(Boolean).join(' · ');
    if (text) box.append(el('span', 'live-team-name', text));
    box.title = `${deckTitle(deck)}：${deck.squad.map(deps.labelOf).join('／')}`;
    return box;
  }

  /**
   * 用頭像挑隊伍。原生 <select> 放不進圖片，玩家又記不住 T1/T2，
   * 所以改成一排排可點的隊伍按鈕（radiogroup 語意，鍵盤也能操作）。
   */
  function teamPicker(
    options: RaidPlannerCandidate[], selected: number, label: string,
    onPick: (candidate: RaidPlannerCandidate) => void,
    suggestedDeckIndex?: number,
  ): HTMLElement {
    const group = el('div', 'live-team-picker');
    group.setAttribute('role', 'radiogroup');
    group.ariaLabel = label;
    const buttons: HTMLButtonElement[] = [];
    const mark = (deckIndex: number): void => {
      for (const button of buttons) {
        const on = Number(button.dataset.deckIndex) === deckIndex;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-checked', String(on));
        button.tabIndex = on ? 0 : -1;
      }
    };
    options.forEach((option, index) => {
      const button = el('button', 'live-team-option');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.dataset.deckIndex = String(option.deckIndex);
      const isSuggested = option.deckIndex === suggestedDeckIndex;
      button.ariaLabel = `${deckTitle(option)}：${option.squad.map(deps.labelOf).join('、')}，`
        + `預估 ${yi(option.damage)}${isSuggested ? '，這是建議的隊伍' : ''}`;
      button.append(teamBadge(option, `預估 ${yi(option.damage)}`));
      if (isSuggested) {
        button.classList.add('is-suggested');
        button.append(el('span', 'live-team-suggested', '建議'));
      }
      button.addEventListener('click', () => { mark(option.deckIndex); onPick(option); });
      button.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = options[(index + step + options.length) % options.length]!;
        mark(next.deckIndex); onPick(next);
        buttons.find((b) => Number(b.dataset.deckIndex) === next.deckIndex)?.focus();
      });
      buttons.push(button);
      group.append(button);
    });
    mark(options.some((o) => o.deckIndex === selected) ? selected : (options[0]?.deckIndex ?? -1));
    return group;
  }

  const capacityOf = (candidates: RaidPlannerCandidate[], subtractUsed: boolean): number => {
    const groups = new Map<string, RaidPlannerCandidate[]>();
    for (const candidate of candidates) {
      const rows = groups.get(candidate.memberId) ?? [];
      rows.push(candidate); groups.set(candidate.memberId, rows);
    }
    const used = usedCounts(fired);
    return [...groups.entries()].reduce((total, [memberId, rows]) => total + Math.min(
      memberAttackCapacity(rows), subtractUsed ? Math.max(0, 3 - (used[memberId] ?? 0)) : 3,
    ), 0);
  };

  function renderPhaseStepper(): void {
    phasesBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
    const row = el('div', 'live-phase-stepper');
    PHASE_LABELS.forEach((label, index) => {
      const state = index < now ? 'done' : index === now ? 'now' : 'todo';
      const mark = state === 'done' ? '✓' : state === 'now' ? '●' : '○';
      row.append(el('span', `live-phase-chip is-${state}`, `${label} ${mark}`));
      if (index < PHASE_LABELS.length - 1) row.append(el('span', 'live-phase-arrow', '→'));
    });
    phasesBox.append(row);
  }

  /** 사람마다 확정·대기를 왕별로 합쳐 총람 표를 만든다. */
  function renderSummary(): void {
    summaryBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
    const totalCapacity = capacityOf(base.candidates, false);
    const available = remainingCandidates(base.candidates, fired);
    const remainingCapacity = capacityOf(available, true);
    const remaining = remainingPhases(base.phases, fired);

    const metrics = el('div', 'live-metrics');
    const metric = (label: string, value: string): HTMLElement => {
      const card = el('div', 'live-metric');
      card.append(el('span', undefined, label), el('b', undefined, value));
      return card;
    };
    metrics.append(
      metric('目前階段', PHASE_LABELS[now]!),
      metric('已確認出刀', `${fired.length} / ${totalCapacity}`),
      metric('帳面剩餘刀', String(Math.max(0, totalCapacity - fired.length))),
      metric('仍有候選可排', String(remainingCapacity)),
      metric('重算狀態', plan ? '建議已更新' : '正在計算'),
    );
    summaryBox.append(metrics);

    const hpRow = el('div', 'live-hp-row');
    if (now === 3) {
      hpRow.append(el('span', 'live-hp-pill', `${bossName(4)} · 無限血量`));
    } else {
      remaining[now]!.forEach((hp, index) => {
        hpRow.append(el('span', `live-hp-pill${hp <= 0 ? ' is-cleared' : ''}`,
          `${bossName(index)} · ${hp <= 0 ? '已清' : `剩 ${yi(hp)}`}`));
      });
    }
    summaryBox.append(hpRow);

    const recommendation = el('div', 'live-recommendation');
    recommendation.append(el('b', undefined, '目前各王下一刀建議'));
    const suggested = plan?.bars.filter((bar) => bar.phase === now && bar.shots.length > 0)
      .map((bar) => bar.shots[0]!) ?? [];
    if (!suggested.length) {
      recommendation.append(el('span', 'field-note', plan
        ? '目前最佳解沒有分配這一階段；仍可用下方「記錄實際出刀」手動登記。'
        : '重算完成後會顯示；現在仍可先用下方表單登記。'));
    } else {
      const list = el('div', 'live-recommendation-list');
      for (const shot of suggested) {
        const item = el('div', 'live-recommendation-item');
        item.append(el('b', undefined, `${bossName(shot.bossIndex)} → ${shot.memberName}`),
          teamBadge(shot, `預估 ${yi(shot.damage)}`), quickConfirm(shot));
        list.append(item);
      }
      recommendation.append(list);
    }
    summaryBox.append(recommendation);
  }

  function sampleVerification() {
    const label = el('label', 'live-sample-verification');
    const input = el('input'); input.type = 'checkbox';
    label.append(input, '已核對結算、正常完整出刀（含極限收尾；納入分析）');
    return { label, checked: () => calibration.enabled && input.checked };
  }

  function recordShot(candidate: RaidPlannerCandidate, phase: number, damageYi: number, verified = false, acknowledged = false): boolean {
    if (!base || !Number.isFinite(damageYi * YI) || damageYi <= 0) {
      status.textContent = '請選擇實際隊伍並填入大於 0 的傷害。';
      return false;
    }
    const available = remainingCandidates(base.candidates, fired).some((row) =>
      row.memberId === candidate.memberId && row.bossIndex === candidate.bossIndex
      && row.deckIndex === candidate.deckIndex);
    if (!available) {
      status.textContent = '這個隊伍已出刀或與已用角色重疊，請重新選擇。';
      renderAll(lastPendingKeys);
      return false;
    }
    const original = findCandidate(base.candidates, candidate.memberId, candidate.bossIndex, candidate.deckIndex)!;
    const predicted = findCandidate(effectiveCandidates(), candidate.memberId, candidate.bossIndex, candidate.deckIndex)!;
    if (!acknowledged && unusualDamage(damageYi * YI, predicted.damage)) {
      requestAction(`${candidate.memberName}／${candidate.bossName}：填入 ${yi(damageYi * YI)}，目前預估 ${yi(predicted.damage)}。差距較大，請核對單位為「億」，以及是否為未打滿的尾刀。`,
        '確認傷害無誤', () => recordShot(candidate, phase, damageYi, verified, true));
      return false;
    }
    const group = calibrationGroupKey(candidate);
    const revision = calibration.enabled && group ? calibration.revisions?.[group] : undefined;
    const hpBefore = remainingPhases(base.phases, fired)[phase]?.[candidate.bossIndex];
    fired.push({
      memberId: candidate.memberId, memberName: candidate.memberName,
      bossIndex: candidate.bossIndex, bossName: candidate.bossName,
      phase, deckIndex: candidate.deckIndex,
      ...(candidate.deckLabel ? { deckLabel: candidate.deckLabel } : {}),
      squad: candidate.squad, damage: damageYi * YI,
      simulatedDamage: original.damage, predictedDamage: predicted.damage,
      ...(revision ? { calibrationRevision: revision } : {}),
      calibrationSample: verified ? 'verified' : 'unreviewed',
      finishingShot: phase < 3 && hpBefore !== undefined && damageYi * YI >= hpBefore,
      finishingReviewed: verified,
    });
    persist();
    resolve();
    return true;
  }

  function renderRecorder(): void {
    recorderBox.replaceChildren();
    if (!base) return;
    const now = currentPhase();
    const card = el('section', 'live-recorder-card');
    const heading = el('div', 'live-recorder-heading');
    heading.append(el('h3', undefined, '記錄實際出刀'),
      el('p', 'field-note', '選誰、打哪隻王、實際用了哪隊，再填遊戲結算傷害（單位：億）。確認後立刻扣血、扣刀並重排。'));
    card.append(heading);

    const controls = el('div', 'live-recorder-controls');
    const labeled = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'live-recorder-field');
      wrap.append(el('span', undefined, label), control);
      return wrap;
    };
    const bossSelect = el('select', 'live-recorder-select');
    bossSelect.ariaLabel = '實際攻擊 Boss';
    const currentHp = remainingPhases(base.phases, fired)[now];
    const bossIndexes = now === 3 ? [4] : Array.from({ length: 5 }, (_, index) => index)
      .filter((index) => (currentHp?.[index] ?? 0) > 0);
    for (const index of bossIndexes) {
      const option = document.createElement('option');
      option.value = String(index); option.textContent = bossName(index); bossSelect.append(option);
    }
    const memberSelect = el('select', 'live-recorder-select');
    memberSelect.ariaLabel = '實際出刀成員';
    const deckBox = el('div', 'live-recorder-teams');
    let pickedDeck: number | undefined;
    const damageInput = el('input', 'live-damage-input');
    damageInput.type = 'number'; damageInput.min = '0.01'; damageInput.step = '0.01';
    damageInput.placeholder = '例如 523.4'; damageInput.ariaLabel = '實際傷害（億）';

    const candidatesForSelection = (): RaidPlannerCandidate[] => remainingCandidates(effectiveCandidates(), fired)
      .filter((candidate) => candidate.bossIndex === Number(bossSelect.value)
        && candidate.memberId === memberSelect.value);
    /**
     * **이 표는 건의를 따라간다.** 예전에는 후보 목록의 첫 줄을 그냥 골랐는데, 그것은
     * 방안이 고른 덱이 아니다 — 그대로 확정하면 **쏘지도 않은 덱이 기록되고**, 「한 사람이
     * 같은 니케를 두 번 못 쓴다」는 배제가 그 덱의 명단으로 돌아 이후 건의가 통째로
     * 어긋난다. 게다가 조용히 어긋난다.
     */
    const updateDecks = (): void => {
      deckBox.replaceChildren();
      const options = candidatesForSelection();
      const suggested = suggestedFor(now, Number(bossSelect.value));
      const suggestedDeck = suggested?.memberId === memberSelect.value ? suggested.deckIndex : undefined;
      const picked = options.find((option) => option.deckIndex === suggestedDeck) ?? options[0];
      pickedDeck = picked?.deckIndex;
      damageInput.value = picked ? (picked.damage / YI).toFixed(2) : '';
      if (!options.length) return;
      deckBox.append(teamPicker(options, picked!.deckIndex, '實際使用隊伍', (candidate) => {
        pickedDeck = candidate.deckIndex;
        damageInput.value = (candidate.damage / YI).toFixed(2);
      }, suggestedDeck));
    };
    const updateMembers = (): void => {
      memberSelect.replaceChildren();
      const boss = Number(bossSelect.value);
      const unique = new Map<string, string>();
      for (const candidate of remainingCandidates(base!.candidates, fired)) {
        if (candidate.bossIndex === boss) unique.set(candidate.memberId, candidate.memberName);
      }
      const suggested = suggestedFor(now, boss);
      for (const [id, name] of [...unique.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id === suggested?.memberId ? `${name}（建議）` : name;
        memberSelect.append(option);
      }
      // 이름순은 그대로 두고 **고른 값만** 건의로 맞춘다 — 목록이 매번 재배열되면
      // 현장에서 사람을 눈으로 찾기 어렵다.
      if (suggested && unique.has(suggested.memberId)) memberSelect.value = suggested.memberId;
      updateDecks();
    };
    bossSelect.addEventListener('change', updateMembers);
    memberSelect.addEventListener('change', updateDecks);
    updateMembers();

    const confirm = el('button', 'roster-import union-run', '確認這一刀並重算');
    const verification = sampleVerification();
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      const picked = candidatesForSelection().find((candidate) => candidate.deckIndex === pickedDeck);
      if (picked) recordShot(picked, now, Number(damageInput.value), verification.checked());
      else status.textContent = '這位成員在這隻王沒有可用隊伍。';
    });
    controls.append(
      labeled('Boss', bossSelect), labeled('出刀成員', memberSelect),
      labeled('實際傷害（億）', damageInput), confirm,
    );
    const teamField = el('div', 'live-recorder-field live-recorder-team-field');
    teamField.append(el('span', undefined, '實際隊伍（點頭像選擇）'), deckBox);
    card.append(controls, teamField);
    if (calibration.enabled) card.append(verification.label);
    recorderBox.append(card);
  }

  function renderOverview(now: number): void {
    overviewBox.replaceChildren();
    if (!base) return;
    interface Row { memberId: string; memberName: string; perBoss: Map<number, { done: number; pending: number }>; used: number }
    const rows = new Map<string, Row>();
    const ensure = (memberId: string, memberName: string): Row => {
      let row = rows.get(memberId);
      if (!row) { row = { memberId, memberName, perBoss: new Map(), used: 0 }; rows.set(memberId, row); }
      return row;
    };
    for (const candidate of base.candidates) ensure(candidate.memberId, candidate.memberName);
    for (const shot of fired) {
      const row = ensure(shot.memberId, shot.memberName);
      row.used += 1;
      const cell = row.perBoss.get(shot.bossIndex) ?? { done: 0, pending: 0 };
      cell.done += 1; row.perBoss.set(shot.bossIndex, cell);
    }
    if (plan) for (const member of plan.members) {
      const row = ensure(member.memberId, member.memberName);
      for (const shot of member.shots.filter((candidate) => candidate.phase === now)) {
        const cell = row.perBoss.get(shot.bossIndex) ?? { done: 0, pending: 0 };
        cell.pending += 1; row.perBoss.set(shot.bossIndex, cell);
      }
    }
    const bossNames = Array.from({ length: 5 }, (_, index) =>
      base!.candidates.find((c) => c.bossIndex === index)?.bossName || `第 ${index + 1} 王`);
    const active = [...rows.values()].filter((row) => row.used < 3
      || [...row.perBoss.values()].some((cell) => cell.pending > 0));
    const doneCount = rows.size - active.length;
    active.sort((a, b) => a.memberName.localeCompare(b.memberName));

    const table = el('table', 'live-overview-table');
    const head = el('tr');
    for (const label of ['成員', ...bossNames, '已出/上限']) head.append(el('th', undefined, label));
    table.append(head);
    for (const row of active) {
      const tr = el('tr');
      tr.append(el('th', undefined, row.memberName));
      for (let boss = 0; boss < 5; boss++) {
        const cell = row.perBoss.get(boss);
        const mark = !cell ? '·' : cell.pending > 0 ? `○${cell.done + cell.pending}/${cell.done + cell.pending}`
          : `✓${cell.done}/${cell.done}`;
        tr.append(el('td', undefined, mark));
      }
      tr.append(el('td', undefined, `${row.used}/3`));
      table.append(tr);
    }
    overviewBox.append(table);
    if (doneCount > 0) overviewBox.append(el('p', 'field-note', `已完成 ${doneCount} 人(全部出完，未列出)。`));
  }

  /**
   * 「이 사람은 오늘 무엇을 쏘나」 — 사람 단위로, **단계를 가로질러** 세 발을 다 보여 준다.
   *
   * 다른 곳(총람 표·왕별 목록)은 전부 **지금 단계만** 본다. 그래서 1단계에 안 뽑힌 사람은
   * 화면에서 `0/3`·`·`으로만 보이고, 그 사람 몫이 2·3단계에 잡혀 있다는 것이 안 보인다.
   * 실제로는 방안이 96발을 전원 3/3으로 배정한다 — 안 보였을 뿐이다.
   *
   * 여기서는 머리 수가 많으므로 얼굴은 싣지 않는다(32명 × 3발 = 480장). 이름·단계·왕·예상만
   * 두고 편성은 `title`로 넘긴다.
   */
  function renderMembers(now: number): void {
    membersBox.replaceChildren();
    if (!base) return;

    interface Row {
      memberId: string; memberName: string;
      done: FiredShot[]; pending: RaidPlannerShot[];
    }
    const rows = new Map<string, Row>();
    const ensure = (memberId: string, memberName: string): Row => {
      let row = rows.get(memberId);
      if (!row) { row = { memberId, memberName, done: [], pending: [] }; rows.set(memberId, row); }
      return row;
    };
    for (const candidate of base.candidates) ensure(candidate.memberId, candidate.memberName);
    for (const shot of fired) ensure(shot.memberId, shot.memberName).done.push(shot);
    if (plan) {
      for (const member of plan.members) {
        ensure(member.memberId, member.memberName).pending.push(...member.shots);
      }
    }

    const heading = el('div', 'live-members-heading');
    heading.append(el('b', undefined, '每個人要出的刀'),
      el('span', 'field-note', plan
        ? '跨階段列出，不只目前階段。灰色是已確認的。'
        : '重算完成後才會有建議；已確認的仍然顯示。'));
    membersBox.append(heading);

    const firstPhase = (row: Row): number => row.pending[0]?.phase ?? 99;
    const active = [...rows.values()].filter((row) => row.done.length + row.pending.length > 0);
    active.sort((a, b) => firstPhase(a) - firstPhase(b) || a.memberName.localeCompare(b.memberName));
    const idle = rows.size - active.length;

    const grid = el('div', 'live-members-grid');
    for (const row of active) {
      const card = el('div', 'live-member-card');
      const head = el('div', 'live-member-head');
      head.append(el('b', undefined, row.memberName),
        el('span', undefined, `${row.done.length} / 3 已出`));
      card.append(head);

      for (const shot of row.done) {
        const line = el('div', 'live-member-shot is-done');
        line.title = shot.squad.map(deps.labelOf).join('／');
        line.append(el('span', 'live-member-phase', `✓ ${PHASE_SHORT[shot.phase] ?? ''}`),
          el('span', 'live-member-boss', bossName(shot.bossIndex)),
          el('span', 'live-member-damage', yi(shot.damage)));
        card.append(line);
      }
      for (const shot of row.pending) {
        const line = el('div', 'live-member-shot' + (shot.phase === now ? ' is-now' : ''));
        line.title = `${deckTitle(shot)}：${shot.squad.map(deps.labelOf).join('／')}`;
        line.append(el('span', 'live-member-phase', PHASE_SHORT[shot.phase] ?? ''),
          el('span', 'live-member-boss', bossName(shot.bossIndex)),
          el('span', 'live-member-damage', `預估 ${yi(shot.damage)}`));
        card.append(line);
      }
      grid.append(card);
    }
    membersBox.append(grid);
    if (idle > 0) {
      membersBox.append(el('p', 'field-note', `另有 ${idle} 人這次沒有被排到刀，也還沒出刀。`));
    }
  }

  function renderConfirmedRow(shot: FiredShot, order: number, remainingAfter: number): HTMLElement {
    const row = el('div', 'live-shot-row is-done');
    row.append(el('span', 'live-shot-order', String(order)));
    row.append(el('span', 'live-shot-member', shot.memberName));
    row.append(teamBadge(shot));
    row.append(el('span', 'live-shot-damage', yi(shot.damage)));
    row.append(el('span', 'live-shot-remain', `剩 ${yi(remainingAfter)}`));
    const undo = el('button', 'roster-import live-undo', '撤銷此刀');
    undo.type = 'button';
    undo.addEventListener('click', () => removeShot(shot));
    const edit = el('button', 'roster-import', '修改傷害'); edit.type = 'button';
    edit.addEventListener('click', () => editShot(shot));
    row.append(edit, undo);
    return row;
  }

  function renderPendingRow(shot: RaidPlannerShot, order: number, changed: boolean): HTMLElement {
    const row = el('div', 'live-shot-row is-pending' + (changed ? ' is-changed' : ''));
    row.append(el('span', 'live-shot-order', String(order)));
    row.append(el('span', 'live-shot-member', shot.memberName));
    if (changed) row.append(el('span', 'live-shot-flag', '🔄 剛重新分配'));

    // 이 사람이 이 왕에 아직 안 쏜 후보만 — 이미 확정된 (사람·왕·덱)을 또 고르면
    // 같은 조합이 두 번 나간 걸로 잡혀 혈량·한도 계산이 어긋난다.
    const options = remainingCandidates(effectiveCandidates(), fired)
      .filter((c) => c.memberId === shot.memberId && c.bossIndex === shot.bossIndex);
    const preview = el('span', 'live-shot-preview');
    const damageInput = el('input', 'live-damage-input');
    damageInput.type = 'number'; damageInput.min = '0.01'; damageInput.step = '0.01';
    damageInput.ariaLabel = `${shot.memberName} 實際傷害（億）`;
    let pickedDeck = options.some((o) => o.deckIndex === shot.deckIndex) ? shot.deckIndex : options[0]?.deckIndex;

    const drawPreview = (): void => {
      preview.replaceChildren();
      const picked = options.find((o) => o.deckIndex === pickedDeck);
      if (picked) preview.append(teamBadge(picked, `預估 ${yi(picked.damage)}`));
      damageInput.value = picked ? (picked.damage / YI).toFixed(2) : '';
    };
    drawPreview();

    // 大多數人照建議出刀，所以預設只顯示建議的那一隊；真的換隊才展開頭像清單。
    let swap: HTMLElement | undefined;
    if (options.length > 1) {
      const fold = el('details', 'live-team-swap');
      fold.append(el('summary', undefined, '換隊伍'));
      fold.append(teamPicker(options, pickedDeck ?? -1, `${shot.memberName} 實際隊伍`, (candidate) => {
        pickedDeck = candidate.deckIndex;
        drawPreview();
        fold.open = false;
      }));
      swap = fold;
    }

    const confirm = el('button', 'roster-import', '確認並重算');
    const verification = sampleVerification();
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      const picked = pickedDeck === undefined ? undefined
        : findCandidate(base!.candidates, shot.memberId, shot.bossIndex, pickedDeck);
      const damage = Number(damageInput.value);
      if (!picked || !Number.isFinite(damage) || damage <= 0) {
        status.textContent = '請選擇實際隊伍並填入大於 0 的傷害。';
        return;
      }
      recordShot(picked, shot.phase, damage, verification.checked());
    });

    row.append(preview, damageInput, confirm);
    if (calibration.enabled) row.append(verification.label);
    if (swap) row.append(swap);
    return row;
  }

  function renderBossBlock(phase: number, bossIndex: number, previousKeys: Set<string>): HTMLElement {
    const bar = plan?.bars.find((entry) => entry.phase === phase && entry.bossIndex === bossIndex);
    const bossName = base!.candidates.find((c) => c.bossIndex === bossIndex)?.bossName || `第 ${bossIndex + 1} 王`;
    const confirmedHere = fired.filter((shot) => shot.phase === phase && shot.bossIndex === bossIndex);

    const trueRemaining = confirmedHere.reduce(
      (hp, shot) => Math.max(0, hp - shot.damage),
      base!.phases[phase]?.[bossIndex] ?? 0,
    );
    const trulyCleared = trueRemaining <= 0;

    const wrap = el('details', 'live-boss-block');
    wrap.open = !trulyCleared;
    const summary = el('summary');
    if (trulyCleared) {
      summary.textContent = `✓ ${bossName} · 已清 · 打完後剩餘 ${yi(trueRemaining)}`;
    } else {
      const left = bar?.shots.length ?? 0;
      summary.textContent = `${bossName} · 進行中 · 剩餘 ${yi(trueRemaining)}${left ? ` · 還差 ${left} 刀` : ''}`;
    }
    wrap.append(summary);

    const body = el('div', 'live-boss-body');
    let runningHp = base!.phases[phase]?.[bossIndex] ?? 0;
    confirmedHere.forEach((shot, index) => {
      runningHp = Math.max(0, runningHp - shot.damage);
      body.append(renderConfirmedRow(shot, index + 1, runningHp));
    });
    if (!trulyCleared) {
      bar?.shots.forEach((shot, index) => {
        const changed = previousKeys.size > 0 && !previousKeys.has(pendingKey(shot));
        body.append(renderPendingRow(shot, confirmedHere.length + index + 1, changed));
      });
    }
    if (!trulyCleared && !(bar?.shots.length)) {
      body.append(el('p', 'field-note', plan
        ? '目前最佳解沒有分配這隻王；可用上方「記錄實際出刀」手動選人與隊伍。'
        : '正在重算建議；可先用上方「記錄實際出刀」登記。'));
    }
    wrap.append(body);
    return wrap;
  }

  function renderAll(previousKeys: Set<string>): void {
    history.replaceChildren(el('summary', undefined, `全部出刀紀錄（${fired.length} 刀）`));
    for (const [index, shot] of fired.entries()) {
      const row = el('div', 'live-history-row');
      const edit = el('button', 'roster-import', '修改傷害'); edit.type = 'button';
      const undo = el('button', 'roster-import', '撤銷此刀'); undo.type = 'button';
      edit.addEventListener('click', () => editShot(shot)); undo.addEventListener('click', () => removeShot(shot));
      row.append(el('span', undefined, `${index + 1}. ${shot.memberName}／${PHASE_LABELS[shot.phase]}／${shot.bossName}／${deckTitle(shot)}：${yi(shot.damage)}`), edit, undo);
      history.append(row);
    }
    calibrationPanel.render(base ? { base, fired, state: calibration, plan } : undefined);
    renderPhaseStepper();
    renderSummary();
    renderRecorder();
    const now = currentPhase();
    renderMembers(now);
    renderOverview(now);
    bossesBox.replaceChildren();
    if (now === 3) {
      bossesBox.append(el('p', 'field-note', '三階段已全清，現在可從上方登記無限五王的實際出刀；重算建議會持續更新。'));
      return;
    }
    for (let bossIndex = 0; bossIndex < 5; bossIndex++) bossesBox.append(renderBossBlock(now, bossIndex, previousKeys));
  }

  function applyImport(text: string): void {
    try {
      const next = readLiveImport(JSON.parse(text));
      if (base) requestAction(`目前已有 ${fired.length} 刀紀錄，將載入 ${next.fired.length} 刀及其校正設定。確認取代盤面？取代前的進度會保留供還原。`, '確認匯入', () => {
        checkpoint('匯入前'); applySession(next);
      });
      else applySession(next);
    } catch (error) {
      importStatus.textContent = `無法匯入，現有進度未變更。請使用試算結果或實戰進度備份 JSON。${error instanceof Error ? error.message : ''}`;
    }
  }

  let fileRead = 0;
  async function readFile(file: File): Promise<void> {
    const request = ++fileRead;
    try { const text = await file.text(); if (request === fileRead) applyImport(text); }
    catch { if (request === fileRead) importStatus.textContent = '檔案讀取失敗，現有進度未變更，請重新選擇檔案。'; }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void readFile(file);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (event) => event.preventDefault());
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void readFile(file);
  });
  reimportButton.addEventListener('click', () => {
    importBox.hidden = false;
    importStatus.textContent = '';
  });
  resetButton.addEventListener('click', () => {
    if (!base) return;
    requestAction(`將清空 ${fired.length} 刀現場紀錄及校正設定。清空前的進度會保留，可使用「還原上一份進度」取回。`, '確認清空', () => {
      checkpoint('清空前'); fired = []; calibration = freshCalibration();
      lastPendingKeys = new Set(); plan = undefined; persist(); resolve();
    });
  });

  restore();
  if (base) {
    importBox.hidden = true;
    board.hidden = false;
    renderAll(lastPendingKeys);
    resolve();
  }

  return {};
}
