/**
 * 待移植的 TS 計算 worker，沿用 fork 的 prepare／simulate／combatPower 訊息格式。
 * 目前未接到正式畫面；須先通過完整跨引擎數值驗證。
 */
import { ENGINE_DATA_FILES, setEngineData } from './data';
import { run_combat_power, run_request } from './bridge';
import type { WorkerRequest } from '../types';

const siteBase = new URL(import.meta.env.BASE_URL, self.location.href);
let ready: Promise<string> | null = null;

const post = (id: number, type: string, payload?: unknown) => self.postMessage({ id, type, payload });

async function initialize(): Promise<string> {
  const manifestResponse = await fetch(new URL('runtime/manifest.json', siteBase), { cache: 'reload' });
  if (!manifestResponse.ok) throw new Error(`런타임 목록을 불러오지 못했습니다. (${manifestResponse.status})`);
  const manifest = await manifestResponse.json() as { version?: string; files: string[] };
  const version = encodeURIComponent(manifest.version || '');
  const paths = Object.keys(ENGINE_DATA_FILES);
  const listed = new Set(manifest.files);
  const missing = paths.filter((path) => !listed.has(path));
  if (missing.length) throw new Error(`고속 엔진 데이터가 런타임에 없습니다: ${missing.join(', ')}`);
  const bodies = await Promise.all(paths.map(async (path) => {
    const response = await fetch(new URL(`runtime/${path}?v=${version}`, siteBase));
    if (!response.ok) throw new Error(`${path} 파일을 불러오지 못했습니다. (${response.status})`);
    return response.json() as Promise<unknown>;
  }));
  setEngineData(Object.fromEntries(paths.map((path, index) => [path, bodies[index]])));
  return manifest.version ?? '';
}

function ensureReady(): Promise<string> {
  if (!ready) ready = initialize().catch((error) => { ready = null; throw error; });
  return ready;
}

async function handle(message: WorkerRequest): Promise<void> {
  const { id, type, payload } = message;
  try {
    const version = await ensureReady();
    if (type === 'prepare') { post(id, 'ready', version); return; }
    // 전투력은 목록 정렬용이라 타임라인 계산과 별개로 돈다 — 훨씬 가볍다.
    if (type === 'combatPower') {
      post(id, 'result', JSON.parse(run_combat_power(JSON.stringify(payload ?? {}))));
      return;
    }
    if (type !== 'simulate' || !payload) {
      throw new Error('고속 엔진이 지원하지 않는 계산 요청입니다.');
    }
    const result = JSON.parse(run_request(JSON.stringify(payload)));
    post(id, 'result', result);
  } catch (error) {
    post(id, 'error', error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error));
  }
}

let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(event.data));
};
