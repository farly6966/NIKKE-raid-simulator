/** 以 fork 已釘住的六類 Boss 區間數字，檢查 TS 引擎的逐角色總傷與命中數。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_DATA_FILES, setEngineData } from '../src/engine/data';
import { build_config, build_squad } from '../src/engine/spec';
import { simulate } from '../src/engine/timeline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const fixture = JSON.parse(execFileSync(python, [
  '-c', 'import json; from calculator.test_boss_phase_numbers import CASES, EXPECTED; print(json.dumps({"cases": CASES, "expected": EXPECTED}, ensure_ascii=False))',
], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as {
  cases: Record<string, Record<string, unknown>>;
  expected: Record<string, [number, number, Record<string, number>]>;
};
setEngineData(Object.fromEntries(Object.keys(ENGINE_DATA_FILES).map(path => [
  path, JSON.parse(readFileSync(join(root, path), 'utf8')),
])));

const only = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length);
const rows = Object.entries(fixture.cases).filter(([name]) => !only || name === only).map(([name, enemy]) => {
  const [total, hits, chars] = fixture.expected[name]!;
  try {
    const squad = build_squad(['리타', '크라운', '레이븐', '앨리스']);
    const result = simulate(squad, build_config(squad, { duration: 25, rng_mode: 'expected' }),
      { code: '전격', core_px: 0, ...enemy }, true);
    const exact = result.squad_total === total && result.hits.length === hits
      && Object.entries(chars).every(([char, damage]) => result.char_total[char] === damage);
    return { name, exact, expected: total, actual: result.squad_total,
      expectedHits: hits, actualHits: result.hits.length, expectedChars: chars, actualChars: result.char_total };
  } catch (error) {
    return { name, exact: false, error: error instanceof Error ? error.message : String(error) };
  }
});
if (rows.length === 0) throw new Error(`找不到指定基準：${only}`);
const exact = rows.filter(row => row.exact).length;
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ total: rows.length, exact, rows }));
else {
  process.stdout.write(`TS/Python boss phase parity: ${exact}/${rows.length} exact\n`);
  for (const row of rows.filter(row => !row.exact)) process.stdout.write(`${row.name}: ${JSON.stringify(row)}\n`);
}
if (exact !== rows.length) process.exitCode = 1;
