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

const rows = Object.entries(squads).map(([name, info]) => {
  const baseline = JSON.parse(readFileSync(join(root, 'context', 'baseline', `${name}.json`), 'utf8'));
  const expected = baseline.L1_numbers.squad_total as number;
  try {
    const squad = build_squad(info.members, info.chars ?? null);
    const config = build_config(squad, info.config ?? null);
    const result = simulate(squad, config, info.enemy ?? null, true, info.seed);
    return { name, expected, actual: result.squad_total,
      expectedCharacters: baseline.L1_numbers.char_total as Record<string, number>,
      actualCharacters: result.char_total,
      expectedBursts: baseline.L1_numbers.full_burst_count as number,
      actualBursts: result.log?.burst_log.filter(entry => entry.event === 'full_burst 시작').length ?? 0,
      deltaPct: Math.round((result.squad_total / expected - 1) * 10_000) / 100,
      exact: result.squad_total === expected };
  } catch (error) {
    return { name, expected, error: error instanceof Error ? error.message : String(error), exact: false };
  }
});

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
