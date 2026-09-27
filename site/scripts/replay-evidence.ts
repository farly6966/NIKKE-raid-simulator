/** 本機重跑網頁匯出的精確計算輸入；只輸出編號與差值，不洩漏育成資料。 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_DATA_FILES, setEngineData } from '../src/engine/data';
import { run_request } from '../src/engine/bridge';

const path = process.argv[2];
if (!path) throw new Error('用法：npm run parity:evidence -- <引擎驗證 JSON 路徑>');
const evidence = JSON.parse(readFileSync(path, 'utf8')) as {
  format?: string; version?: number;
  cases?: Array<{ id: number; request: Record<string, unknown>; expected: { squadTotal: number; hitCount: number } }>;
};
if (evidence.format !== 'nikke-engine-evidence' || evidence.version !== 1 || !Array.isArray(evidence.cases)) {
  throw new Error('引擎驗證檔格式錯誤');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
setEngineData(Object.fromEntries(Object.keys(ENGINE_DATA_FILES).map(file => [
  file, JSON.parse(readFileSync(join(root, file), 'utf8')),
])));

const rows = evidence.cases.map(item => {
  try {
    const result = JSON.parse(run_request(item.request));
    const actual = Number(result.squadTotal);
    const expected = Number(item.expected.squadTotal);
    return { id: item.id, exact: actual === expected && result.hitCount === item.expected.hitCount,
      deltaPct: expected === 0 ? null : Math.round((actual / expected - 1) * 10_000) / 100,
      hitDelta: result.hitCount - item.expected.hitCount };
  } catch (error) {
    return { id: item.id, exact: false, error: error instanceof Error ? error.message : String(error) };
  }
});
const exact = rows.filter(row => row.exact).length;
process.stdout.write(JSON.stringify({ total: rows.length, exact, rows }) + '\n');
if (exact !== rows.length) process.exitCode = 1;
