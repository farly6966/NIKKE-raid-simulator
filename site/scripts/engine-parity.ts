/** 用 fork 既有 29 組 Python golden snapshot 檢查待移植 TS 引擎。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_DATA_FILES, setEngineData } from '../src/engine/data';
import { build_config, build_squad } from '../src/engine/spec';
import { simulate } from '../src/engine/timeline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const squads = JSON.parse(execFileSync(python, [
  '-c', 'import json; from context.snapshot import SQUADS; print(json.dumps(SQUADS, ensure_ascii=False))',
], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as Record<string, any>;

setEngineData(Object.fromEntries(Object.keys(ENGINE_DATA_FILES).map(path => [
  path, JSON.parse(readFileSync(join(root, path), 'utf8')),
])));

const only = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length);
const rows = Object.entries(squads).filter(([name]) => !only || name === only).map(([name, info]) => {
  const baseline = JSON.parse(readFileSync(join(root, 'context', 'baseline', `${name}.json`), 'utf8'));
  const expected = baseline.L1_numbers.squad_total as number;
  try {
    const squad = build_squad(info.members, info.chars ?? null);
    const config = build_config(squad, info.config ?? null);
    const result = simulate(squad, config, info.enemy ?? null, true, info.seed);
    const hitCounts: Record<string, number> = {};
    const hitTags: Record<string, Record<string, number>> = {};
    for (const hit of result.hits) hitCounts[hit.caster] = (hitCounts[hit.caster] ?? 0) + 1;
    for (const hit of result.hits) {
      const tags = hitTags[hit.caster] ??= {};
      tags[hit.hit_tag] = (tags[hit.hit_tag] ?? 0) + 1;
    }
    const skillTotals: Record<string, Record<string, { damage: number; hits: number }>> = {};
    for (const hit of result.hits) {
      const skills = skillTotals[hit.caster] ??= {};
      const row = skills[hit.skill_name] ??= { damage: 0, hits: 0 };
      row.damage += hit.damage;
      row.hits++;
    }
    const buffCounts: Record<string, number> = {};
    const buffTargets: Record<string, Set<string>> = {};
    for (const buff of result.log?.buff_events ?? []) {
      if (buff.kind === 'activate') {
        buffCounts[buff.name] = (buffCounts[buff.name] ?? 0) + 1;
        (buffTargets[buff.name] ??= new Set()).add(buff.target);
      }
    }
    const instantCounts: Record<string, number> = {};
    for (const instant of result.log?.instant_events ?? []) instantCounts[instant.name] = (instantCounts[instant.name] ?? 0) + 1;
    return { name, expected, actual: result.squad_total,
      expectedCharacters: baseline.L1_numbers.char_total as Record<string, number>,
      actualCharacters: result.char_total,
      expectedHits: Object.fromEntries(Object.entries(baseline.L1_numbers.per_char).map(([char, row]) => [char, (row as any).hits])),
      actualHits: hitCounts,
      expectedHitTags: Object.fromEntries(Object.entries(baseline.L1_numbers.per_char).map(([char, row]) => [char, (row as any).hit_tags])),
      actualHitTags: hitTags,
      fullChargeTimes: result.hits.filter(hit => hit.hit_tag === 'full_charge_hit')
        .reduce((out, hit) => { (out[hit.caster] ??= []).push(hit.t); return out; }, {} as Record<string, number[]>),
      reloadEvents: result.log?.reload_log.map(entry => [entry.t, entry.caster, entry.event]),
      expectedSkills: Object.fromEntries(Object.entries(baseline.L1_numbers.per_char).map(([char, row]) => [char, (row as any).skills])),
      actualSkills: skillTotals,
      expectedBuffs: Object.fromEntries(Object.entries(baseline.L2_activations.buffs).map(([key, row]) => [key, (row as any).count])),
      actualBuffs: buffCounts,
      expectedBuffTargets: Object.fromEntries(Object.entries(baseline.L2_activations.buffs).map(([key, row]) => [key, (row as any).targets])),
      actualBuffTargets: Object.fromEntries(Object.entries(buffTargets).map(([key, targets]) => [key, [...targets].sort()])),
      expectedInstants: Object.fromEntries(Object.entries(baseline.L2_activations.instants).map(([key, row]) => [key, (row as any).count])),
      actualInstants: instantCounts,
      expectedBursts: baseline.L1_numbers.full_burst_count as number,
      actualBursts: result.log?.burst_log.filter(entry => entry.event === 'full_burst 시작').length ?? 0,
      actualBurstStarts: result.log?.burst_log.filter(entry => entry.event === 'full_burst 시작').map(entry => entry.t) ?? [],
      firstBurstEvents: result.log?.burst_log.slice(0, 20).map(entry => [entry.t, entry.event, entry.caster]) ?? [],
      deltaPct: Math.round((result.squad_total / expected - 1) * 10_000) / 100,
      exact: result.squad_total === expected };
  } catch (error) {
    return { name, expected, error: error instanceof Error ? error.message : String(error), exact: false };
  }
});
if (rows.length === 0) throw new Error(`找不到指定基準：${only}`);

const exact = rows.filter(row => row.exact).length;
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ total: rows.length, exact, rows }));
} else {
  process.stdout.write(`TS/Python golden parity: ${exact}/${rows.length} exact\n`);
  for (const row of rows.filter(row => !row.exact)) {
    process.stdout.write(`${row.name}: ${'error' in row ? row.error : `${row.expected} → ${row.actual} (${row.deltaPct}%)`}\n`);
  }
}
if (exact !== rows.length) process.exitCode = 1;
