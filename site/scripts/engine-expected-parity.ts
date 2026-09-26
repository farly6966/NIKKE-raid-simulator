/** 用預期值模式隔離亂數順序，逐隊比對 Python 與 TS 的公式結果。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_DATA_FILES, setEngineData } from '../src/engine/data';
import { build_config, build_squad } from '../src/engine/spec';
import { simulate } from '../src/engine/timeline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const code = [
  'import json',
  'from context.snapshot import SQUADS, build_squad',
  'from context.spec import build_config',
  'from calculator.timeline import simulate',
  'out = {}',
  'for name, info in SQUADS.items():',
  '    squad = build_squad(info["members"], info.get("chars"))',
  '    config = build_config(squad, info.get("config"))',
  '    config["rng_mode"] = "expected"',
  '    result = simulate(squad, config=config, enemy=info.get("enemy"), verbose=False, seed=info["seed"])',
  '    out[name] = {"total": result.squad_total, "chars": result.char_total}',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');
const expected = JSON.parse(execFileSync(python, ['-c', code], {
  cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
})) as Record<string, { total: number; chars: Record<string, number> }>;
const squads = JSON.parse(execFileSync(python, [
  '-c', 'import json; from context.snapshot import SQUADS; print(json.dumps(SQUADS, ensure_ascii=False))',
], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as Record<string, any>;

setEngineData(Object.fromEntries(Object.keys(ENGINE_DATA_FILES).map(path => [
  path, JSON.parse(readFileSync(join(root, path), 'utf8')),
])));
const only = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length);
const rows = Object.entries(squads).filter(([name]) => !only || name === only).map(([name, info]) => {
  const squad = build_squad(info.members, info.chars ?? null);
  const config = build_config(squad, info.config ?? null);
  config.rng_mode = 'expected';
  const result = simulate(squad, config, info.enemy ?? null, false, info.seed);
  const baseline = expected[name]!;
  return { name, expected: baseline.total, actual: result.squad_total,
    deltaPct: 100 * (result.squad_total / baseline.total - 1),
    expectedChars: baseline.chars, actualChars: result.char_total,
    exact: result.squad_total === baseline.total };
});
if (rows.length === 0) throw new Error(`找不到指定基準：${only}`);
const exact = rows.filter(row => row.exact).length;
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ total: rows.length, exact, rows }));
else {
  process.stdout.write(`TS/Python expected parity: ${exact}/${rows.length} exact\n`);
  for (const row of rows.filter(row => !row.exact)) {
    process.stdout.write(`${row.name}: ${row.expected} → ${row.actual} (${row.deltaPct.toFixed(5)}%)\n`);
  }
}
if (exact !== rows.length) process.exitCode = 1;
