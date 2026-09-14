import { BURST_STAGES, MAX_CYCLES, candidatesFor, estimateCycles, trimSequence, type BurstSequence } from './burst-order';
import { matchingPresets, presetSequence } from './burst-presets';
import type { CharacterMeta, DeckState } from './types';

export function cleanNoBurst(raw: unknown, squad: string[]): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((name): name is string =>
    typeof name === 'string' && Boolean(name) && squad.includes(name)))] : [];
}

/** Never mutate imported roster overrides. Explicit rounds must also respect skip. */
export function applyUnionBurst(deck: DeckState, sequence: unknown, catalog: CharacterMeta[], noBurst: string[] = []): void {
  for (const name of cleanNoBurst(noBurst, deck.squad)) deck.characters[name] = { ...deck.characters[name], burst: { mode: 'skip' } };
  const skipped = deck.squad.filter(name => deck.characters[name]?.burst?.mode === 'skip');
  deck.strictNoBurst = skipped.length > 0;
  deck.burstSequence = compileUnionSequence(sequence, deck.squad, catalog, skipped);
}

/** Decode untrusted drafts with a strict allowlist; prune removed squad members. */
export function cleanUnionSequence(raw: unknown, squad: string[]): BurstSequence | undefined {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set(squad.filter(Boolean));
  const sequence = raw.slice(0, MAX_CYCLES).map(cycle => Object.fromEntries(BURST_STAGES.map(stage => [stage,
    Array.isArray(cycle?.[stage]) ? [...new Set(cycle[stage].filter((name: unknown): name is string =>
      typeof name === 'string' && allowed.has(name)))] : [],
  ]))) as BurstSequence;
  return trimSequence(sequence) ?? undefined;
}

/** Empty UI choices mean automatic stage order, not an empty engine candidate list. */
export function compileUnionSequence(raw: unknown, squad: string[], catalog: CharacterMeta[], noBurst: string[] = []): BurstSequence | undefined {
  const clean = cleanUnionSequence(raw, squad);
  if (!clean) return undefined;
  return clean.map(cycle => Object.fromEntries(BURST_STAGES.map(stage => {
    const allowed = candidatesFor(stage, { squad, skipped: new Set(noBurst), metaOf: name => catalog.find(char => char.name === name) });
    const picked = cycle[stage].filter(name => allowed.includes(name));
    return [stage, picked.length ? picked : allowed];
  }))) as BurstSequence;
}

export function createUnionBurstEditor(options: {
  squad: string[]; sequence?: BurstSequence; catalog: CharacterMeta[]; duration: number; noBurst?: string[];
  labelOf: (name: string) => string; onChange: (sequence: BurstSequence | undefined) => void;
}): HTMLDetailsElement {
  const box = document.createElement('details'); box.className = 'union-deck-code union-burst-editor';
  const summary = document.createElement('summary'); summary.textContent = '逐輪爆裂編輯'; box.append(summary);
  const note = document.createElement('p'); note.className = 'field-note';
  note.textContent = '每輪可指定 B1／B2／B3；指定者冷卻時會等待。自動＝依站位選可用角色，未編輯的後續輪次恢復引擎自動。手動輪次會覆蓋角色的預設爆裂分工；設定隨本機盤面保存，不包含在 NK2／NK4 分享碼。';
  box.append(note);
  if (!options.squad.some(Boolean)) { note.textContent = '先放入角色，再設定逐輪爆裂。'; return box; }
  let sequence: BurstSequence = cleanUnionSequence(options.sequence, options.squad) ?? [{ 1: [], 2: [], 3: [] }];
  const presets = matchingPresets(options.squad);
  if (presets.length) {
    const presetBox = document.createElement('div'); presetBox.className = 'union-burst-presets';
    const presetLabel = document.createElement('p'); presetLabel.className = 'field-note';
    presetLabel.textContent = '這個編成常用的固定循環：';
    presetBox.append(presetLabel);
    for (const preset of presets) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'roster-import';
      button.textContent = `套用 B${preset.stage} 固定循環：${preset.pattern.map(options.labelOf).join(' → ')}`;
      button.addEventListener('click', () => {
        sequence = presetSequence(preset, Math.max(sequence.length, estimateCycles(options.duration)), sequence);
        draw(); save();
      });
      presetBox.append(button);
    }
    box.append(presetBox);
  }
  const countLabel = document.createElement('label'); countLabel.textContent = '編輯輪數';
  const count = document.createElement('input'); count.type = 'number'; count.min = '1'; count.max = String(MAX_CYCLES);
  count.step = '1'; count.value = String(sequence.length); count.className = 'union-boss-num'; count.ariaLabel = '編輯輪數';
  countLabel.append(count); box.append(countLabel);
  const rows = document.createElement('div'); box.append(rows);
  const save = () => options.onChange(cleanUnionSequence(sequence, options.squad));
  const draw = () => {
    rows.replaceChildren(); count.value = String(sequence.length);
    sequence.forEach((cycle, index) => {
      const row = document.createElement('div'); row.className = 'union-burst-cycle';
      const heading = document.createElement('b'); heading.textContent = `第 ${index + 1} 輪`; row.append(heading);
      for (const stage of BURST_STAGES) {
        const label = document.createElement('label'); label.textContent = `B${stage}`;
        const select = document.createElement('select'); select.ariaLabel = `第 ${index + 1} 輪 B${stage}`;
        const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = '自動'; select.append(automatic);
        for (const name of candidatesFor(stage, { squad: options.squad, skipped: new Set(options.noBurst), metaOf: name => options.catalog.find(char => char.name === name) })) {
          const option = document.createElement('option'); option.value = name; option.textContent = options.labelOf(name); select.append(option);
        }
        select.value = cycle[stage][0] ?? '';
        select.addEventListener('change', () => { cycle[stage] = select.value ? [select.value] : []; save(); });
        label.append(select); row.append(label);
      }
      rows.append(row);
    });
  };
  const resize = (commit: boolean) => {
    const n = Number(count.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CYCLES) {
      if (commit) count.value = String(sequence.length);
      return;
    }
    sequence = Array.from({ length: n }, (_, i) => sequence[i] ?? { 1: [], 2: [], 3: [] }); draw(); save();
  };
  count.addEventListener('input', () => resize(false));
  count.addEventListener('change', () => resize(true));
  const repeat = document.createElement('button'); repeat.type = 'button'; repeat.className = 'roster-import';
  repeat.textContent = `重複目前模式至 ${estimateCycles(options.duration)} 輪（估算）`;
  repeat.addEventListener('click', () => {
    const pattern = sequence;
    sequence = Array.from({ length: Math.max(pattern.length, estimateCycles(options.duration)) }, (_, i) => {
      const cycle = pattern[i % pattern.length]!;
      return { 1: [...cycle[1]], 2: [...cycle[2]], 3: [...cycle[3]] };
    }); draw(); save();
  });
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'roster-import'; reset.textContent = '全部恢復自動';
  reset.addEventListener('click', () => { sequence = [{ 1: [], 2: [], 3: [] }]; draw(); save(); });
  box.append(repeat, reset); draw(); return box;
}
