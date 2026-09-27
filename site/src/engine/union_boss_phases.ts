/** fork 六種聯盟 Boss 時間窗。以 Python 既有數字基準核對每種區間與重疊規則。 */
import type { HitEvent } from './sim_result';

export type BossPhaseKind = 'core' | 'parts' | 'immune' | 'element_gate' | 'pierce_gate' | 'optimal_range';
export interface BossPhase {
  kind: BossPhaseKind;
  from: number;
  to: number;
  weapons?: string[];
}

const KINDS: BossPhaseKind[] = ['core', 'parts', 'immune', 'element_gate', 'pierce_gate', 'optimal_range'];
const WEAPONS = new Set(['AR', 'SMG', 'SG', 'MG', 'SR', 'RL']);
const ELEMENTS = new Set(['수냉', '작열', '풍압', '전격', '철갑']);

export class UnionBossPhases {
  readonly phases: BossPhase[];
  readonly hasPartWindows: boolean;
  private readonly baseCore: number;
  private readonly baseParts: boolean;
  private readonly baseRange: string[];
  private readonly enemyCode: string;
  private readonly endedParts = new Set<number>();

  constructor(raw: unknown, enemy: Record<string, any>) {
    if (!Array.isArray(raw) || raw.length > 64) throw new Error('Boss 區間最多可輸入 64 個。');
    this.phases = raw.map((entry, index) => {
      if (entry == null || typeof entry !== 'object' || !KINDS.includes(entry.kind)) {
        throw new Error(`Boss 區間 ${index + 1} 的種類不正確。`);
      }
      const from = Number(entry.from);
      const to = Number(entry.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > 180) {
        throw new Error(`Boss 區間 ${index + 1} 須介於 0～180 秒。`);
      }
      if (entry.kind === 'optimal_range' && (!Array.isArray(entry.weapons)
          || entry.weapons.some((weapon: unknown) => !WEAPONS.has(weapon as string)))) {
        throw new Error(`Boss 區間 ${index + 1} 的適正武器不正確。`);
      }
      return { kind: entry.kind, from, to,
        ...(entry.kind === 'optimal_range' ? { weapons: [...new Set(entry.weapons)] as string[] } : {}) };
    });
    this.phases.sort((a, b) => a.from - b.from);
    this.baseCore = Number(enemy.core_px || 0);
    this.baseParts = Boolean(enemy.has_parts);
    this.baseRange = [...(enemy.optimal_range_weapons ?? [])];
    this.enemyCode = String(enemy.code ?? '');
    this.hasPartWindows = this.phases.some(phase => phase.kind === 'parts');
    if (this.phases.some(phase => phase.kind === 'element_gate') && !ELEMENTS.has(this.enemyCode)) {
      throw new Error('屬性關卡需要有效的 Boss 屬性。');
    }
  }

  private active(phase: BossPhase, time: number): boolean {
    return phase.from <= time && time < phase.to;
  }

  /** 在每幀最前更新敵方狀態；回傳本幀結束的部位窗數。 */
  beginFrame(time: number, enemy: Record<string, any>): number {
    const t = Math.round(time * 1e9) / 1e9;
    if (this.phases.some(phase => phase.kind === 'core')) {
      enemy.core_px = this.phases.some(phase => phase.kind === 'core' && this.active(phase, t))
        ? this.baseCore : 0;
    }
    if (this.hasPartWindows) {
      enemy.has_parts = this.baseParts || this.phases.some(phase => phase.kind === 'parts' && this.active(phase, t));
    }
    const range = this.phases.find(phase => phase.kind === 'optimal_range' && this.active(phase, t));
    if (range) enemy.optimal_range_weapons = new Set([...this.baseRange, ...(range.weapons ?? [])]);
    else if (this.phases.some(phase => phase.kind === 'optimal_range')) enemy.optimal_range_weapons = this.baseRange;
    let ended = 0;
    this.phases.forEach((phase, index) => {
      if (phase.kind === 'parts' && t >= phase.to && !this.endedParts.has(index)) {
        this.endedParts.add(index);
        ended++;
      }
    });
    return ended;
  }

  /** Boss 區間按命中事件的時刻判定，與一般免疫時間窗的收集幀規則不同。 */
  admits(hit: HitEvent, superior: (caster: string, enemyCode: string) => boolean): boolean {
    const t = Math.round(hit.t * 1e9) / 1e9;
    if (this.phases.some(phase => phase.kind === 'immune' && this.active(phase, t))) return false;
    if (this.phases.some(phase => phase.kind === 'pierce_gate' && this.active(phase, t))
        && !(hit.is_pierce || hit.hit_tag.startsWith('pierce:') || hit.hit_tag === 'pierce_damage')) return false;
    if (this.phases.some(phase => phase.kind === 'element_gate' && this.active(phase, t))
        && !superior(hit.caster, this.enemyCode)) return false;
    return true;
  }
}
