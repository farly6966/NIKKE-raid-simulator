/**
 * 유니온 레이드 (BETA) — 유니온원 각자의 실제 스펙으로 같은 보스·같은 덱을 돌려
 * «누가 얼마나 기여할 수 있나»를 견준다.
 *
 * 데이터가 오는 길이 둘로 갈린다. 그 이유를 여기 적어 둔다:
 *
 *   명단(닉네임·openid·싱크로) → **본인 브라우저에서만** 온다.
 *       `Game/GetGuildMembers`는 호출자가 게임 계정에 묶인 로그인이어야 한다.
 *       우리 프록시 계정은 게임 롤이 없어 `user no bind role`로 거부된다(실측
 *       2026-08-27). 그래서 붙여넣기로 받는다 — 쿠키를 우리가 만지지 않는 길이다.
 *
 *   유니온원 스펙(니케·장비·오버로드·콘솔) → 기존 프록시로 온다.
 *       공개 계정은 그대로 오고, 비공개는 `1301002`로 막힌다. 그 갈림이 곧 «공개여부»다.
 *
 * 보스와 덱은 **공유 코드**로 채운다(전투 조건 `NK3-`, 조합 `NK2-`). 이미 있는 문법을
 * 그대로 쓰면 유니온원끼리 세팅을 주고받기도 쉽고, 이 탭이 편집기를 새로 만들지 않아도 된다.
 */

import {
  decodeBattleCode, decodeShareCode, decodeUnionCode, encodeBattleCode, encodeShareCode,
  encodeUnionCode, type UnionShare,
} from './share-code';
import type { BurstSequence } from './burst-order';
import { cleanUnionSequence, createUnionBurstEditor, cleanNoBurst, applyUnionBurst } from './union-burst';
import { bestThreeShots } from './union-planning';
import { plannerCandidates, type RaidPlannerInput, type RaidPlannerPlan } from './union-raid-planner';
import { createBattleAnalysis } from './battle-analysis';
import { ownedSSR, searchSquads } from './union-search';
import { DEFAULT_SYNCHRO_LEVEL, SYNCHRO_MAX, SYNCHRO_MEASURED_MAX } from './model';
import { parseExiaBatch, stripExiaProfile } from './exia-import';
import { UnionSquadPicker } from './union-squad';
import { cleanUnionCubes, applyUnionCubes, createUnionCubeEditor, type UnionCubes } from './union-cubes';
import { createTimelineBlock } from './timeline';
import { t } from './i18n';
import { UNION_BOSS_SEASONS, unionBossPreset, unionBossArt, bossWeakness, defaultUnionDecks, recommendedUnionBattle,
  unionSeasonForBosses, type UnionBossPreset } from './union-bosses';
import type { BattleSettings, DeckState, ElementCode, SimulationResult } from './types';

/** 유니온원 한 명. `GetGuildMembers`가 주는 것만 담는다. */
export interface UnionMember {
  name: string;
  /** `member_id` — 프로필 조회에 쓰는 intl_open_id다. */
  openid: string;
  /** 싱크로 디바이스 레벨. 계산에 그대로 반영한다(400 고정이 아니다). */
  synchro: number;
  /** 계정 레벨. 화면 참고용이다. */
  level: number;
  /** `bind_area_id` — 서버. 스펙 조회에 넣어야 5개 서버를 다 뒤지지 않는다. */
  area: number;
}

/** 공개여부 스캔 결과. */
export type MemberState = 'unknown' | 'scanning' | 'public' | 'private' | 'error';

export interface MemberRow extends UnionMember {
  state: MemberState;
  /** 공개일 때 계산기가 다루는 니케 수. */
  owned?: number;
  /** 비공개·오류일 때 사람에게 보여 줄 한 줄. */
  note?: string;
  /** 계산에 넣을지. 공개인 사람만 켤 수 있다. */
  picked: boolean;
  /**
   * 이 사람에게 어느 보스를 맡길지. 보스 번호(0~4) → 켬/끔이고, 안 적힌 보스는 켠 것으로 친다.
   * 풍압엔 강한데 전격엔 약한 사람이 있어서, 보스별로 사람을 갈라 맡길 수 있어야 한다.
   */
  bossPicks?: Record<number, boolean>;
}

/** 보스 한 칸. 체크를 끄면 그 보스는 통째로 건너뛴다. */
export interface BossSlot {
  bossId?: string;
  name: string;
  code: string;
  enabled: boolean;
  battle?: BattleSettings;
  /** 코드가 잘못됐을 때의 사유. */
  error?: string;
  decks: DeckSlot[];
}

/** 덱 한 칸. 니케 이름 다섯만 쓴다 — 수치는 유니온원 각자의 것을 쓴다. */
export interface DeckSlot {
  /** 玩家好記的隊伍名稱（例如「紅蓮速攻」）。只存在本機盤面與試算匯出，不進分享碼。 */
  label?: string;
  cubes?: UnionCubes;
  noBurst?: string[];
  code: string;
  squad?: string[];
  error?: string;
  cycle?: Pick<BattleSettings, 'burstReaction' | 'burstRegenTime'>;
  burstSequence?: BurstSequence;
}

/** 隊伍名稱的上限長度；超過的部分直接截掉。 */
export const DECK_LABEL_MAX = 20;

/** 隊伍名稱清理：去頭尾空白、壓掉換行、限制長度。空字串視為沒有名稱。 */
export function cleanDeckLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = [...value.replace(/\s+/g, ' ').trim()].slice(0, DECK_LABEL_MAX).join('');
  return text || undefined;
}

/** Local board draft only: never store imported account data or credentials. */
/**
 * `withLabels: false` 用在「盤面有沒有變」的比較：隊伍名稱不影響模擬數值，
 * 改名不應該讓已經算好的結果失效。
 */
export function encodeUnionDraft(bosses: BossSlot[], withLabels = true): string {
  return JSON.stringify(bosses.map(boss => ({
    name: boss.name, code: boss.code, enabled: boss.enabled, bossId: boss.bossId,
    decks: boss.decks.map(deck => ({ code: deck.code, label: withLabels ? cleanDeckLabel(deck.label) : undefined, cubes: cleanUnionCubes(deck.cubes, deck.squad ?? []), cycle: deck.cycle ? {
      burstReaction: deck.cycle.burstReaction, burstRegenTime: deck.cycle.burstRegenTime,
    } : undefined, burstSequence: cleanUnionSequence(deck.burstSequence, deck.squad ?? []), noBurst: cleanNoBurst(deck.noBurst, deck.squad ?? []) })),
  })));
}

export function decodeUnionDraft(text: string, names: string[]): BossSlot[] {
  const raw = JSON.parse(text);
  if (!Array.isArray(raw) || ![BOSS_SLOTS, 6].includes(raw.length)) throw new Error('盤面草稿格式錯誤');
  return raw.map(item => {
    if (!item || typeof item.name !== 'string' || typeof item.code !== 'string'
      || typeof item.enabled !== 'boolean' || !Array.isArray(item.decks)) throw new Error('盤面草稿格式錯誤');
    const decks = Array.from({ length: DECK_SLOTS }, (_, index) => {
      const value = item.decks[index];
      const deck = readDeckCode({ code: typeof value?.code === 'string' ? value.code : '' }, names);
      const label = cleanDeckLabel(value?.label);
      if (label) deck.label = label;
      deck.cubes = cleanUnionCubes(value?.cubes, deck.squad ?? []);
      deck.burstSequence = cleanUnionSequence(value?.burstSequence, deck.squad ?? []);
      deck.noBurst = cleanNoBurst(value?.noBurst, deck.squad ?? []);
      if (value?.cycle && ['burstReaction', 'burstRegenTime'].every(key =>
        typeof value.cycle[key] === 'number' && Number.isFinite(value.cycle[key]) && value.cycle[key] >= 0 && value.cycle[key] <= 180)) {
        deck.cycle = { burstReaction: value.cycle.burstReaction, burstRegenTime: value.cycle.burstRegenTime };
      }
      return deck;
    });
    return readBossCode({ name: item.name, code: item.code, enabled: item.enabled, decks,
      ...(unionBossPreset(item.bossId) ? { bossId: item.bossId } : {}) });
  });
}

/** A season has five bosses. Legacy sixth slots are recovery data, never jobs. */
export const BOSS_SLOTS = 5;

/** 모든 값이 기본값인 전투 조건(`{}`). 속성만 갈아 끼울 바탕으로 쓴다. */
const PLAIN_BATTLE_CODE = 'NK3-e30';

/**
 * 유니온 레이드 한 판의 길이(초).
 *
 * **180초다.** 한때 90으로 뒀었는데(`context/union_compare.py`의 기본값을 따라간
 * 것이었다) 그 값이 틀렸다 — 실제로 뛰는 지휘관이 바로잡아 주었다(2026-09-04).
 * 길이를 반으로 두면 딜도 대략 반으로 나오므로, 표의 모든 칸이 조용히 절반이 된다.
 */
export const UNION_DURATION = 180;

/** 유니온 레이드에서 고를 수 있는 보스 속성. 빈 값은 «무속성»이다. */
export const BOSS_CODES: ElementCode[] = ['', '전격', '수냉', '작열', '풍압', '철갑'];

/** 보스 한 마리의 «어떤 놈인가». 코드 없이 이것만 고르면 조건이 선다. */
export interface BossShape {
  element: ElementCode;
  /** 코어 지름(px). 0이면 코어 없음. */
  corePx: number;
  hasParts: boolean;
  enemyDef: number;
}

/**
 * 유니온 레이드 보스의 기본 모습.
 *
 * **코어는 켜져 있다.** 유니온 레이드 보스에는 코어가 있고, 꺼 두면 딜이 대략 절반이
 * 된다(실측 2026-09-04: 같은 편성 20.7B → 40.3B). 예전에는 속성만 고르게 해 두어
 * 코어가 꺼진 채로 돌았고, 표의 모든 칸이 실제의 절반쯤이었다.
 *
 * 방어력은 계산기 기본값을 그대로 쓴다 — 회차·단계마다 다른 값이라 정본이 없다.
 * 아는 사람이 고칠 수 있게 화면에 칸을 둔다.
 */
export const DEFAULT_BOSS_SHAPE: BossShape = {
  element: '', corePx: 52, hasParts: true, enemyDef: 31_784,
};

/** 지금 조건에서 «보스의 모습»만 읽어 낸다. 화면의 칸들이 이 값을 그린다. */
export function shapeOf(battle: BattleSettings | undefined): BossShape {
  if (!battle) return { ...DEFAULT_BOSS_SHAPE, element: '' };
  return {
    element: battle.enemyCode,
    corePx: battle.coreEnabled ? battle.corePx : 0,
    hasParts: battle.hasParts,
    enemyDef: battle.enemyDef,
  };
}

/**
 * 보스의 모습으로 전투 조건 코드를 만든다.
 *
 * 조건을 세우는 길이 «NK3 코드를 붙여넣기»뿐이면, 편성만 짜 둔 사람은 실행 자리가
 * 통째로 사라지는 것만 본다(실제 제보). 회차마다 실제로 바뀌는 것들만 고르게 하고
 * 나머지는 기본값으로 채운다.
 */
export function bossCodeForShape(
  shape: Partial<BossShape> = {}, coeff: Record<string, number> = {},
): string {
  const full = { ...DEFAULT_BOSS_SHAPE, ...shape };
  const base = decodeBattleCode(PLAIN_BATTLE_CODE);
  return encodeBattleCode({
    ...base,
    enemyCode: full.element,
    duration: UNION_DURATION,
    coreEnabled: full.corePx > 0,
    corePx: full.corePx > 0 ? full.corePx : DEFAULT_BOSS_SHAPE.corePx,
    hasParts: full.hasParts,
    enemyDef: full.enemyDef,
    synchroLevel: DEFAULT_SYNCHRO_LEVEL,
    console: emptyConsole(),
  } as BattleSettings, coeff);
}
/**
 * 보스 한 자리에 후보 덱 여럿.
 *
 * 예전엔 3으로 두고 「조합을 견주는 건 계산기 탭 5덱 모드의 일」이라며 늘리지
 * 않았다 — 배정표 한 칸에 값이 여럿이면 「이 사람 이 보스에서 얼마?」가 흐려진다는
 * 이유였다. 그런데 그 뒤에 이 fork가 얹은 전 유니온 최적 배정(`union-raid-planner.ts`)
 * 자체가 이미 「후보를 다 늘어놓고 총합이 제일 좋은 조합을 고른다」는 일이고,
 * `buildGrid`(아래)도 같은 사람·같은 왕이면 후보 중 가장 높은 값 하나만 남긴다 —
 * 그래서 배정표가 흐려지는 일은 이미 일어나지 않는다. 6으로 늘려, 같은 왕을 다른
 * 조합으로도 찔러 볼 여지를 넓힌다. 화면은 앞 3자리만 펼치고 나머지는 접어 둔다
 * (`renderBosses`).
 *
 * **무한정 늘리지는 않는다.** 판 수가 유니온원 × 보스 × 덱으로 곱해진다 — 32명 ×
 * 5보스 × 6덱이면 960판이라, 병렬로 돌려도 기기에 따라 여러 분이 걸린다. 빈 칸은
 * 판에 안 실리니 다 채울 필요는 없다 — 찔러 보고 싶은 자리만 채운다.
 */
export const DECK_SLOTS = 6;

/**
 * 명단을 뜨는 한 줄. 유니온 스퀘어에 **로그인한 채로** 콘솔에 붙여넣으면
 * 명단 JSON이 클립보드에 담긴다. 여기서 하는 일은 그 페이지가 이미 하는 호출 하나뿐이고,
 * 쿠키는 브라우저가 알아서 싣는다 — 우리가 받아 보관하는 값이 아니다.
 */
/**
 * 클립보드가 둘 다 막혔을 때 페이지에 띄우는 상자. 두 스니펫이 같이 쓴다.
 *
 * 닫는 길을 **눈에 보이게** 둔다 — Esc만 두면 상자 밖을 눌러 포커스를 잃은 사람은
 * 닫을 방법이 없다(실제로 그런 제보가 왔다). ✕ 단추, Esc, 바깥 누르기 셋 다 받는다.
 */
const COPY_BOX = `
  const wrap = document.createElement('div');
  wrap.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:rgba(2,7,13,.72);display:flex;align-items:center;justify-content:center');
  const card = document.createElement('div');
  card.setAttribute('style', 'width:90%;max-width:900px;background:#0b1420;border:2px solid #45d6d0;padding:12px;box-shadow:0 20px 60px rgba(0,0,0,.5)');
  const head = document.createElement('div');
  head.setAttribute('style', 'display:flex;align-items:center;gap:10px;margin-bottom:8px;color:#cfeceb;font:700 13px system-ui,sans-serif');
  const title = document.createElement('span');
  title.textContent = '계산기에 붙여넣을 내용 — Ctrl+A → Ctrl+C';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('style', 'margin-left:auto;width:30px;height:30px;cursor:pointer;background:transparent;border:1px solid rgba(146,176,201,.4);color:#cfeceb;font:700 14px system-ui,sans-serif');
  close.title = '닫기 (Esc)';
  head.appendChild(title); head.appendChild(close);
  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('style', 'width:100%;height:52vh;padding:10px;font:12px ui-monospace,monospace;background:#03090f;color:#e8f1f8;border:1px solid rgba(146,176,201,.25);resize:vertical');
  card.appendChild(head); card.appendChild(holder); wrap.appendChild(card);
  document.body.appendChild(wrap);
  holder.focus(); holder.select();
  try { document.execCommand('copy'); } catch (e) {}
  const shut = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); shut(); } };
  close.addEventListener('click', shut);
  wrap.addEventListener('mousedown', (ev) => { if (ev.target === wrap) shut(); });
  document.addEventListener('keydown', onKey, true);
`;

export const MEMBER_SNIPPET = `await (async () => {
  const call = async (route, body) => (await fetch('https://api.blablalink.com/api/game/proxy/' + route, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Channel-Type': '2', 'X-Language': 'ko',
      'X-Common-Params': JSON.stringify({ game_id: '29080', area_id: 'global', source: 'pc_web', intl_game_id: '29080', language: 'ko', env: 'prod' }) },
    body: JSON.stringify(body),
  })).json();
  const mine = await call('Game/GetMyGuildInfo', { latest: false });
  const box = mine.data || {};
  const info = box.card || box.guild_info || box.guild_detail || box;
  if (!info.guild_id) { console.error('유니온을 찾지 못했습니다:', mine.msg || mine.code, '— 로그인한 채 유니온 스퀘어에서 실행해 주세요.'); return; }
  const members = await call('Game/GetGuildMembers', { guild_id: String(info.guild_id), nikke_area_id: String(info.nikke_area_id || '') });
  const items = (members.data || {}).items || [];
  if (!items.length) { console.error('명단이 비어 있습니다:', members.msg || members.code); return; }
  const text = JSON.stringify({ guild_name: info.guild_name, items: items });
  const done = (how) => console.log(info.guild_name + ' · 유니온원 ' + items.length + '명 ' + how);
  try { copy(text); done('을 클립보드에 담았습니다. 계산기에 붙여넣으세요.'); return; } catch (e) {}
  try { await navigator.clipboard.writeText(text); done('을 클립보드에 담았습니다. 계산기에 붙여넣으세요.'); return; } catch (e) {}
  // 클립보드가 둘 다 막히면(콘솔에 포커스가 있으면 그렇다) 페이지에 상자를 띄우고
  // 내용을 통째로 골라 둔다 — 브라우저마다 이름이 다른 우클릭 메뉴를 찾을 필요가 없다.
  ${COPY_BOX}
  done('을 페이지 상자에 띄웠습니다. Ctrl+A → Ctrl+C로 복사해 계산기에 붙여넣고, ✕나 Esc로 닫으세요.');
})();`;

/**
 * 직접 긁기 스니펫. **저희 프록시를 거치지 않고** 지휘관님 세션으로 유니온원 스펙을
 * 그대로 받아 온다. 이 길이 따로 있어야 하는 이유는 하나다 —
 * 「유니온원에게만 공개」로 둔 사람은 우리 프록시 계정(그 유니온 소속이 아니다)이
 * 영원히 못 본다. 같은 유니온인 지휘관님 브라우저만 볼 수 있다.
 *
 * 200종 상세를 32명치 받으면 12MB가 넘는다. 계산에 쓰는 칸만 남기고(26%) gzip으로
 * 눌러 base64로 옮긴다 — 한 명에 9KB, 32명이면 300KB쯤이라 붙여넣기로 옮길 수 있다.
 */
export const DIRECT_SNIPPET = `await (async () => {
  const call = async (route, body) => (await fetch('https://api.blablalink.com/api/game/proxy/' + route, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Channel-Type': '2', 'X-Language': 'ko',
      'X-Common-Params': JSON.stringify({ game_id: '29080', area_id: 'global', source: 'pc_web', intl_game_id: '29080', language: 'ko', env: 'prod' }) },
    body: JSON.stringify(body),
  })).json();
  const gap = (ms) => new Promise((done) => setTimeout(done, ms));

  const mine = await call('Game/GetMyGuildInfo', { latest: false });
  const box0 = mine.data || {};
  const info = box0.card || box0.guild_info || box0.guild_detail || box0;
  if (!info.guild_id) { console.error('유니온을 찾지 못했습니다:', mine.msg || mine.code); return; }
  const list = await call('Game/GetGuildMembers', { guild_id: String(info.guild_id), nikke_area_id: String(info.nikke_area_id || '') });
  const roster = (list.data || {}).items || [];
  if (!roster.length) { console.error('명단이 비어 있습니다:', list.msg || list.code); return; }

  const PARTS = ['head', 'torso', 'arm', 'leg'];
  const KEEP = ['name_code', 'skill1_lv', 'skill2_lv', 'ulti_skill_lv', 'favorite_item_tid',
    'favorite_item_lv', 'harmony_cube_tid', 'harmony_cube_lv'];
  for (const part of PARTS) {
    KEEP.push(part + '_equip_tier', part + '_equip_lv',
      part + '_equip_option1_id', part + '_equip_option2_id', part + '_equip_option3_id');
  }
  const slimDetail = (detail) => {
    const out = {};
    for (const key of KEEP) if (detail[key]) out[key] = detail[key];
    return out;
  };

  const members = [];
  for (let i = 0; i < roster.length; i += 1) {
    const person = roster[i];
    const area = person.bind_area_id;
    const row = { name: person.nickname, openid: String(person.member_id),
      synchro: person.synchro_level || 0, level: person.level || 0, area: area, state: 'private' };
    try {
      await gap(500);
      const chars = await call('Game/GetUserCharacters', { intl_open_id: row.openid, nikke_area_id: area });
      const characters = chars.code === 0 ? ((chars.data || {}).characters || []) : [];
      if (characters.length === 0) {
        row.note = chars.msg || String(chars.code || '');
      } else {
        const codes = characters.map((c) => c.name_code);
        const details = [], effects = [];
        for (let at = 0; at < codes.length; at += 60) {
          await gap(500);
          const chunk = await call('Game/GetUserCharacterDetails',
            { intl_open_id: row.openid, nikke_area_id: area, name_codes: codes.slice(at, at + 60) });
          const data = chunk.data || {};
          for (const d of data.character_details || []) details.push(slimDetail(d));
          for (const e of data.state_effects || []) {
            const first = (e.function_details || [])[0] || {};
            effects.push({ id: e.id, function_details: [{ function_type: first.function_type, function_value: first.function_value }] });
          }
        }
        let outpost = null;
        try {
          await gap(500);
          const info2 = await call('Game/GetUserProfileOutpostInfo', { intl_open_id: row.openid, nikke_area_id: area });
          const got = (info2.data || {}).outpost_info;
          if (got) outpost = { recycle_room_researches: (got.recycle_room_researches || []).map((r) => ({ tid: r.tid, lv: r.lv })), synchro_level: got.synchro_level };
        } catch (e) {}
        row.state = 'public';
        row.profile = { openid: row.openid, areas: [{ area: area,
          characters: characters.map((c) => ({ name_code: c.name_code, grade: c.grade, core: c.core })),
          details: details, stateEffects: effects, outpost: outpost }] };
      }
    } catch (e) { row.state = 'error'; row.note = String(e).slice(0, 80); }
    members.push(row);
    console.log((i + 1) + '/' + roster.length + ' ' + row.name + ' · ' + (row.state === 'public' ? '공개' : row.state === 'error' ? '오류' : '비공개'));
  }

  const packed = JSON.stringify({ v: 1, guild_name: info.guild_name, members: members });
  let text = packed;
  if (typeof CompressionStream === 'function') {
    const gz = new Blob([packed]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    text = 'NKU1-' + btoa(binary);
  }
  const open = members.filter((m) => m.state === 'public').length;
  const done = (how) => console.log('유니온원 ' + members.length + '명(공개 ' + open + '명) ' + how);
  try { copy(text); done('을 클립보드에 담았습니다. 계산기에 붙여넣으세요.'); return; } catch (e) {}
  try { await navigator.clipboard.writeText(text); done('을 클립보드에 담았습니다. 계산기에 붙여넣으세요.'); return; } catch (e) {}
  ${COPY_BOX}
  done('을 페이지 상자에 띄웠습니다. Ctrl+A → Ctrl+C로 복사해 계산기에 붙여넣고, ✕나 Esc로 닫으세요.');
})();`;

/** 직접 긁어 온 유니온원 한 명. `profile`은 `areaToOverrides`가 그대로 먹는 모양이다. */
export interface DirectMember {
  name: string;
  openid: string;
  synchro: number;
  level: number;
  area: number;
  state: 'public' | 'private' | 'error';
  note?: string;
  profile?: { openid: string; areas: unknown[] };
}

/** 직접 긁기 결과를 푼다. `NKU1-`은 gzip+base64, 아니면 날 JSON이다. */
export async function parseDirectScan(text: string): Promise<DirectMember[]> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('붙여넣은 내용이 비어 있습니다.');
  let json = trimmed;
  if (trimmed.startsWith('NKU1-')) {
    try {
      const binary = atob(trimmed.slice(5));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      json = await new Response(stream).text();
    } catch {
      throw new Error('직접 긁은 자료를 푸는 데 실패했습니다. 복사가 중간에 잘리지 않았는지 확인해 주세요.');
    }
  }
  let box: { members?: unknown };
  try {
    box = JSON.parse(json) as { members?: unknown };
  } catch {
    throw new Error('직접 긁은 자료를 알아보지 못했습니다. 스니펫이 준 내용을 통째로 붙여넣어 주세요.');
  }
  const rows = Array.isArray(box.members) ? box.members : [];
  const out: DirectMember[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, any>;
    const openid = String(row.openid ?? '').trim();
    const name = String(row.name ?? '').trim();
    if (!name || !/^\d+$/.test(openid)) continue;
    out.push({
      name,
      openid,
      synchro: num(row.synchro, 0),
      level: num(row.level, 0),
      area: num(row.area, 0),
      state: row.state === 'public' ? 'public' : row.state === 'error' ? 'error' : 'private',
      note: typeof row.note === 'string' && row.note ? row.note : undefined,
      profile: row.profile,
    });
  }
  if (out.length === 0) throw new Error('직접 긁은 자료에서 유니온원을 찾지 못했습니다.');
  return out;
}

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 붙여넣은 것을 명단으로 읽는다. 받아들이는 모양 셋:
 *   `{data:{items:[...]}}`  — API 응답 그대로 (스니펫이 주는 것)
 *   `{items:[...]}` / `[...]` — 안쪽만 떼어 온 경우
 *   탭·쉼표로 나눈 표 — 손으로 정리해 온 경우 (이름, openid, 싱크로)
 * 사람이 옮겨 붙이다 어디까지 집었는지 알 수 없으니, 셋 다 받아 준다.
 */
export function parseMemberList(text: string): UnionMember[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('붙여넣은 내용이 비어 있습니다.');

  let items: unknown[] | null = null;
  try {
    const raw = JSON.parse(trimmed) as unknown;
    if (Array.isArray(raw)) items = raw;
    else if (raw && typeof raw === 'object') {
      const box = raw as Record<string, any>;
      if (box.code !== undefined && box.code !== 0 && !box.data) {
        throw new Error(`블라블라링크가 «${box.msg ?? box.code}»를 돌려줬습니다. 로그인한 채로 다시 떠 주세요.`);
      }
      const found = box.data?.items ?? box.items ?? box.data?.members ?? box.members;
      if (Array.isArray(found)) items = found;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('블라블라링크')) throw error;
    items = null;                                  // JSON이 아니면 표로 읽어 본다
  }

  if (items) {
    const rows = items
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        name: String(item.nickname ?? item.name ?? '').trim(),
        openid: String(item.member_id ?? item.intl_open_id ?? item.openid ?? '').trim(),
        synchro: num(item.synchro_level ?? item.synchro, 0),
        level: num(item.level, 0),
        area: num(item.bind_area_id ?? item.nikke_area_id ?? item.area, 0),
      }))
      .filter((row) => row.name && /^\d+$/.test(row.openid));
    if (rows.length === 0) throw new Error('명단에서 유니온원을 찾지 못했습니다. 스니펫이 알려 준 내용을 그대로 붙여넣어 주세요.');
    return dedupe(rows);
  }

  const rows: UnionMember[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const cells = line.split(/\t|,/).map((cell) => cell.trim());
    const openid = cells.find((cell) => /^\d{6,}$/.test(cell));
    const name = cells.find((cell) => cell && cell !== openid);
    if (!openid || !name) continue;
    const numbers = cells.filter((cell) => cell !== openid && /^\d+$/.test(cell)).map(Number);
    rows.push({ name, openid, synchro: numbers[0] ?? 0, level: numbers[1] ?? 0, area: numbers[2] ?? 0 });
  }
  if (rows.length === 0) {
    throw new Error('명단을 알아보지 못했습니다. 아래 스니펫을 유니온 스퀘어에서 실행한 결과를 붙여넣어 주세요.');
  }
  return dedupe(rows);
}

const dedupe = (rows: UnionMember[]): UnionMember[] => {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.openid) ? false : (seen.add(row.openid), true)));
};

/**
 * 공개여부 스캔에 걸리는 시간(초). 실측(2026-08-27, 3명 동시)에서
 * 비공개는 0.7초, 공개는 니케 200종 상세까지 받느라 4~6초였다.
 * 몇 명이 공개인지는 해 봐야 아는 값이라, 절반이 공개라고 보고 어림한다.
 */
export function estimateScanSeconds(count: number, concurrency = 2): number {
  if (count <= 0) return 0;
  const perMember = (0.7 + 5.0) / 2 + 0.7;      // 조회 + 간격 벌리기
  return Math.max(1, Math.round((count * perMember) / concurrency));
}

/** 「1분 20초」처럼 읽히게. 초 단위는 1분 아래에서만 적는다. */
export function humanSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

/** 보스 칸 하나를 코드에서 읽는다. 빈 칸은 조용히 비운다 — 아직 안 채운 것뿐이다. */
export function readBossCode(slot: BossSlot, synchro = DEFAULT_SYNCHRO_LEVEL): BossSlot {
  const code = slot.code.trim();
  if (!code) return { ...slot, battle: undefined, error: undefined };
  try {
    const share = decodeBattleCode(code);
    // 싱크로와 콘솔은 코드에 담기지 않는다(계정 육성 상태다). 유니온원마다 자기 것으로 덮으므로
    // 여기서는 자리만 채워 둔다.
    return {
      ...slot,
      battle: { ...share, synchroLevel: synchro, console: emptyConsole() },
      error: undefined,
    };
  } catch (error) {
    return { ...slot, battle: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 덱 칸 하나를 조합 코드에서 읽는다. 첫 덱만 쓴다 — 이 칸이 곧 덱 하나다. */
/**
 * 기본 편성을 얹을까, 그리고 보스 설정까지 얹을까.
 *
 * **편성이 하나도 없으면 얹는다** — 판이 통째로 비었을 때만이 아니다. 처음에는
 * 「완전히 빈 판」만 받았는데 그 조건에 걸리는 사람이 거의 없었다: 이 탭을 한 번이라도
 * 열면 그 자리에서 초안이 저장되고, 초안에는 회차가 자동으로 넣은 보스 이름·전투 조건이
 * 이미 들어 있다. 그래서 **기본 편성이 생기기 전에 열어 본 브라우저는 영영 기본 편성을
 * 못 받았다**(2026-09-20, 유저가 휴대폰에서 발견).
 *
 * 이름과 전투 조건은 회차가 넣은 것이라 「유저의 뜻」이 아니다. 뜻이 담기는 것은
 * 편성이므로 **편성이 비었나만 본다.**
 *
 * `blankBoard`를 따로 돌려주는 이유: 보스 설정은 빈 판일 때만 얹어야 한다. 편성만
 * 비었을 때 덮어쓰면 손봐 둔 전투 조건이 조용히 날아간다.
 */
export function defaultDeckDecision(
  restoredDraft: boolean, bosses: BossSlot[],
): { seed: boolean; blankBoard: boolean } {
  const blankBoard = !restoredDraft
    || bosses.every(boss => !boss.name && !boss.code && !boss.decks.some(deck => deck.code));
  const decksEmpty = bosses.every(boss => !boss.decks.some(deck => deck.code));
  return { seed: blankBoard || decksEmpty, blankBoard };
}

export function readDeckCode(slot: DeckSlot, catalogNames: string[]): DeckSlot {
  const code = slot.code.trim();
  if (!code) return { ...slot, squad: undefined, error: undefined };
  try {
    const payload = decodeShareCode(code, catalogNames);
    const squad = (payload.decks[0]?.squad ?? []).map((name) => name.trim());
    const filled = squad.filter(Boolean);
    if (filled.length === 0) return { ...slot, squad: undefined, error: '코드에 니케가 없습니다.' };
    return { ...slot, squad, cubes: cleanUnionCubes(slot.cubes, squad), noBurst: cleanNoBurst(slot.noBurst, squad), burstSequence: cleanUnionSequence(slot.burstSequence, squad), error: undefined };
  } catch (error) {
    return { ...slot, squad: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 지금 짜 둔 판을 유니온 판 코드(NK4)로 옮길 모양으로 바꾼다.
 *
 * 코드 문자열만 옮긴다 — 해석된 `battle`·`squad`는 코드에서 다시 나오므로 담지 않는다.
 * **유니온원 명단은 여기 들어가지 않는다.** 닉네임과 openid는 남의 계정 정보다.
 */
export function unionShareOf(bosses: BossSlot[]): UnionShare {
  return {
    bosses: bosses.map((boss) => ({
      name: boss.name,
      ...(boss.bossId ? { bossId: boss.bossId } : {}),
      enabled: boss.enabled,
      battleCode: boss.code,
      deckCodes: boss.decks.map((deck) => deck.code),
    })),
  };
}

/**
 * 받은 판을 보스 칸으로 편다.
 *
 * 코드에 든 보스가 다섯보다 적으면 **남은 칸은 비운다** — 「지난 시즌 것을 통째로
 * 불러온다」는 뜻인데 이전 판의 3·4번 보스가 남아 있으면 섞인 판이 된다.
 */
export function applyUnionShare(
  share: UnionShare,
  catalogNames: string[],
  synchro = DEFAULT_SYNCHRO_LEVEL,
): BossSlot[] {
  return Array.from({ length: BOSS_SLOTS }, (_, index) => {
    const shared = share.bosses[index];
    const decks = Array.from({ length: DECK_SLOTS }, (_, deckIndex) =>
      readDeckCode({ code: shared?.deckCodes[deckIndex] ?? '' }, catalogNames));
    const slot: BossSlot = {
      ...(unionBossPreset(shared?.bossId) ? { bossId: shared!.bossId } : {}),
      name: shared?.name ?? '',
      code: shared?.battleCode ?? '',
      // 코드에 없는 칸은 끈 채로 둔다 — 빈 보스가 켜져 있으면 실행 단추가 헷갈린다.
      enabled: shared?.enabled ?? false,
      decks,
    };
    return { ...readBossCode(slot, synchro), decks };
  });
}

/** 지금 판을 코드 한 줄로. 유니온방에 붙여넣으면 그대로 옮겨진다. */
export function unionCodeOf(bosses: BossSlot[]): string {
  return encodeUnionCode(unionShareOf(bosses));
}

/** 받은 코드를 보스 칸으로. 코드가 잘못되면 던진다 — 잡아서 한 줄로 알린다. */
export function readUnionCode(
  code: string,
  catalogNames: string[],
  synchro = DEFAULT_SYNCHRO_LEVEL,
): BossSlot[] {
  return applyUnionShare(decodeUnionCode(code), catalogNames, synchro);
}

/** 시뮬레이션 한 칸. 유니온원 × 보스 × 덱. */
export interface Job {
  cubes?: UnionCubes;
  noBurst?: string[];
  member: MemberRow;
  bossIndex: number;
  bossName: string;
  deckIndex: number;
  /** 這一隊的自訂名稱（沒有就不帶）。 */
  deckLabel?: string;
  squad: string[];
  battle: BattleSettings;
  burstSequence?: BurstSequence;
}

/**
 * 돌릴 것을 늘어놓는다. 순서는 **유니온원 → 보스 → 덱**이다 — 결과가 사람 단위로
 * 완성돼 가는 편이, 보스별로 흩어져 채워지는 것보다 기다리는 동안 읽을 것이 된다.
 */
export function buildJobs(members: MemberRow[], bosses: BossSlot[]): Job[] {
  const jobs: Job[] = [];
  for (const member of members) {
    if (!member.picked || member.state !== 'public') continue;
    bosses.forEach((boss, bossIndex) => {
      if (!boss.enabled || !boss.battle) return;
      // 아래 보스 체크가 켜져 있어도, 이 사람에게서 뺐으면 돌리지 않는다.
      if (member.bossPicks?.[bossIndex] === false) return;
      boss.decks.forEach((deck, deckIndex) => {
        if (!deck.squad) return;
        jobs.push({
          member,
          bossIndex,
          bossName: t(boss.name.trim()) || t('보스 {n}', { n: bossIndex + 1 }),
          deckIndex,
          ...(cleanDeckLabel(deck.label) ? { deckLabel: cleanDeckLabel(deck.label) } : {}),
          squad: deck.squad,
          cubes: cleanUnionCubes(deck.cubes, deck.squad),
          burstSequence: cleanUnionSequence(deck.burstSequence, deck.squad),
          noBurst: cleanNoBurst(deck.noBurst, deck.squad),
          battle: { ...boss.battle!, ...deck.cycle, ...(deck.cycle ? { burstRegenPerDeck: undefined } : {}) },
        });
      });
    });
  }
  return jobs;
}

/** 한 칸의 결과. 못 돌린 이유도 결과의 하나로 남긴다 — 빈칸은 «왜»를 못 말한다. */
export interface JobResult {
  job: Job;
  damage?: number;
  detail?: { deckId: number; request: ReturnType<typeof requestForDeck>; result: SimulationResult };
  /** 못 돌렸을 때: 미보유 니케 이름들, 또는 오류 한 줄. */
  missing?: string[];
  error?: string;
}

/**
 * 유니온원의 로스터로 덱을 짠다. 안 가진 니케가 하나라도 있으면 **돌리지 않는다** —
 * 없는 니케를 기본 스펙으로 채워 넣으면 «이 사람이 낼 수 있는 딜»이 아니게 된다.
 */
export function deckForMember(
  squad: string[],
  roster: Record<string, DeckState['characters'][string]>,
  allowDefaults = false,
): { deck: DeckState; missing: string[] } {
  const missing: string[] = [];
  const characters: DeckState['characters'] = {};
  for (const name of squad) {
    if (!name) continue;
    const found = roster[name];
    // `allowDefaults`는 «로스터 자체가 없다»는 뜻이다(개인용인데 CSV를 안 넣은 경우).
    // 그때는 못 가진 게 아니라 **모르는** 것이므로 기본 스펙으로 돌린다.
    if (!found) { if (!allowDefaults) missing.push(name); continue; }
    characters[name] = found;
  }
  return { deck: { id: 1, squad: [...squad], characters }, missing };
}

/** 결과를 화면 뼈대대로 «유니온원 → 보스 → 덱»으로 접는다. */
export interface MemberReport {
  member: MemberRow;
  bosses: Array<{ name: string; rows: JobResult[] }>;
}

export function groupResults(results: JobResult[]): MemberReport[] {
  const byMember = new Map<string, MemberReport>();
  for (const result of results) {
    const key = result.job.member.openid;
    let report = byMember.get(key);
    if (!report) {
      report = { member: result.job.member, bosses: [] };
      byMember.set(key, report);
    }
    let boss = report.bosses.find((entry) => entry.rows[0]?.job.bossIndex === result.job.bossIndex);
    if (!boss) {
      boss = { name: result.job.bossName, rows: [] };
      report.bosses.push(boss);
    }
    boss.rows.push(result);
  }
  for (const report of byMember.values()) {
    for (const boss of report.bosses) boss.rows.sort((a, b) => a.job.deckIndex - b.job.deckIndex);
    report.bosses.sort((a, b) => {
      const ai = a.rows[0]?.job.bossIndex ?? 0;
      const bi = b.rows[0]?.job.bossIndex ?? 0;
      return ai - bi;
    });
  }
  return [...byMember.values()];
}

/**
 * 배정표 한 칸. 공회 배정표(스프레드시트)의 «1·0.5·빈칸» 자리에 실제 수치가 들어간다.
 *
 * 빈칸의 뜻이 둘이라 나눠 적는다 — «안 맡겼다»와 «맡겼지만 못 친다(미보유)»는
 * 배정을 다시 짤 때 완전히 다른 뜻이다.
 */
export interface GridCell {
  /** 그 보스에서 낸 딜. 덱이 여럿이면 가장 높은 것. */
  damage?: number;
  /** 어느 덱이 그 값을 냈는지(0부터). 같은 보스에 덱이 여럿일 때만 뜻이 있다. */
  deckIndex?: number;
  /** 못 친 이유. 미보유 니케 이름들, 또는 오류 한 줄. */
  note?: string;
}

export interface GridRow {
  member: MemberRow;
  /** 보스 칸 번호(0부터) → 그 칸의 결과. 안 맡긴 보스는 아예 없다. */
  cells: Map<number, GridCell>;
  /** 맡은 보스들의 딜 합. 정렬 기본값이다 — 공회가 보고 싶은 것은 «총 기여»다. */
  total: number;
}

export interface Grid {
  /** 실제로 쓰는 보스 칸만, 판에 놓인 순서대로. */
  bosses: Array<{ index: number; name: string }>;
  rows: GridRow[];
}

/**
 * 결과를 «유니온원 × 보스» 표로 접는다.
 *
 * 한 보스에 덱이 셋까지 있는데 표는 칸이 하나다. **가장 높은 것**을 적는다 —
 * 배정표가 답하려는 물음이 「이 사람을 이 보스에 넣으면 얼마나 나오나」이고,
 * 그 답은 그 사람이 낼 수 있는 최선이기 때문이다. 어느 덱이었는지는 함께 남긴다.
 */
export function buildGrid(results: JobResult[], bosses: BossSlot[]): Grid {
  const used = new Map<number, string>();
  const rows = new Map<string, GridRow>();

  for (const result of results) {
    const { member, bossIndex, bossName } = result.job;
    if (!used.has(bossIndex)) used.set(bossIndex, bossName);

    let row = rows.get(member.openid);
    if (!row) {
      row = { member, cells: new Map(), total: 0 };
      rows.set(member.openid, row);
    }
    const cell = row.cells.get(bossIndex) ?? {};
    if (result.damage !== undefined) {
      if (cell.damage === undefined || result.damage > cell.damage) {
        cell.damage = result.damage;
        cell.deckIndex = result.job.deckIndex;
        delete cell.note;                       // 한 덱이라도 되면 «못 친다»가 아니다
      }
    } else if (cell.damage === undefined) {
      cell.note = result.missing ? `缺 ${result.missing.join('、')}` : (result.error ?? '計算失敗');
    }
    row.cells.set(bossIndex, cell);
  }

  for (const row of rows.values()) {
    row.total = [...row.cells.values()]
      .reduce((sum, cell) => sum + (cell.damage ?? 0), 0);
  }

  return {
    // 판에 놓인 순서 그대로 — 사람이 짜 둔 순서가 곧 읽는 순서다.
    bosses: [...used.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, name]) => ({ index, name: name || bosses[index]?.name || `王 ${index + 1}` })),
    rows: [...rows.values()].sort((a, b) => b.total - a.total),
  };
}

/**
 * 표를 스프레드시트에 그대로 붙일 수 있는 글자로. **BOM을 앞에 단다** —
 * 없으면 엑셀이 UTF-8을 못 알아보고 한자·한글이 통째로 깨진다(더블클릭으로 열 때).
 */
export function gridToCsv(grid: Grid): string {
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines: string[] = [];
  lines.push(['名稱', '同步器等級', ...grid.bosses.map((boss) => boss.name)].map(quote).join(','));
  for (const row of grid.rows) {
    const cells = grid.bosses.map((boss) => {
      const cell = row.cells.get(boss.index);
      if (!cell) return '';                     // 안 맡긴 보스 — 배정표의 빈칸과 같다
      // 수치는 **날것 그대로** 낸다. 「12.3億」으로 적으면 스프레드시트가 글자로 읽어
      // 합계도 정렬도 안 된다.
      return cell.damage !== undefined ? String(Math.round(cell.damage)) : (cell.note ?? '');
    });
    lines.push([row.member.name, String(row.member.synchro || ''), ...cells].map(quote).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 시뮬 한 판이 얼마나 걸리는지는 기기마다 달라 **재 보고** 알린다. */
export function remainingSeconds(done: number, total: number, elapsedMs: number): number {
  if (done <= 0) return 0;
  return ((elapsedMs / done) * (total - done)) / 1000;
}

export type Simulate = (squad: string[], characters: DeckState['characters'],
  battle: BattleSettings) => Promise<SimulationResult>;

// ── 화면 ────────────────────────────────────────────────────────────────────

import { areaToOverrides, consoleFrom, emptyConsole, pickArea } from './blablalink';
import type { RawProfile } from './blablalink';
import { requestForDeck, normalizeRequest } from './model';
import { mountSharePanel, squadPreview, type SharePanel } from './share-panel';
import { summarizeBattle, summarizeSquad, summarizeUnion, type ShareItem, type ShareKind, type ShareServer } from './share-server';
import type { CharacterMeta, CharacterOverrides, SettingsCatalog } from './types';

export interface UnionHosts {
  panel: HTMLElement;
}

export interface UnionDeps {
  isExternalBusy?: () => boolean;
  /** 블라블라링크 조회 프록시. 비어 있으면 이 탭 자체를 띄우지 않는다. */
  proxy: string;
  settings: SettingsCatalog;
  catalog: CharacterMeta[];
  simulate: (request: ReturnType<typeof requestForDeck>) => Promise<SimulationResult>;
  imageOf: (name: string) => string | undefined;
  /** 지금 계산기에 잡아 둔 전투 조건을 코드로. 「가져오기」 단추가 쓴다. */
  labelOf: (name: string) => string;
  /** 지금 계산기에 잡아 둔 전투 조건을 코드로. 「가져오기」 단추가 쓴다. */
  currentBattleCode: () => string;
  /** 지금 계산기 덱 하나를 코드로. 인자는 0부터. */
  currentDeckCode: (index: number) => string;
  currentDeckSequence?: (index: number) => BurstSequence | undefined;
  /** 계산기가 아는 니케 이름 전부 — 조합 코드 해석에 쓴다. */
  catalogNames: () => string[];
  /**
   * 설정 공유 서버. 없으면(주소를 안 잡아 뒀으면) «공유에서 고르기»를 아예 그리지 않는다 —
   * 누를 수 없는 단추를 남겨 두는 쪽이 더 헷갈린다.
   */
  shareServer?: ShareServer | null;
  /** 한 번에 몇 판을 함께 돌릴지(병렬 설정). 1이면 한 판씩. */
  concurrency?: () => number;
  /**
   * 개인용 모드에서 쓰는 «나». 명단·공개여부를 건너뛰고 계산기에 잡아 둔 내 스펙으로
   * 보스×덱을 돈다 — 「남의 딜은 궁금하지 않고 내 것만 보고 싶다」는 요청에서 나왔다.
   */
  me: () => { name: string; synchro: number; console: BattleSettings['console'];
    roster: Record<string, CharacterOverrides>; owned: number };
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const pick = <T extends HTMLElement>(root: HTMLElement, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`유니온 탭에 ${selector}가 없습니다.`);
  return found;
};

const DAMAGE = new Intl.NumberFormat('ko-KR');

/** 엔진 오류는 파이썬 트레이스백째로 온다 — 줄마다 쏟지 않고 마지막 한 줄만 적는다. */
export function lastLine(message: string): string {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? message;
}

/** 조회 시작 사이의 최소 간격(ms). 상류가 «너무 잦다»고 되던지는 선을 피한다. */
const REQUEST_GAP_MS = 700;
/** 실패했을 때 물러서는 간격. 세 번까지 더 해 보고 포기한다. */
const BACKOFF_MS = [1500, 4000, 9000];

/** 유니온 탭 전체를 배선한다. 상태는 이 안에만 산다 — 탭을 떠나도 남는다. */
/** 탭 밖에서 부를 수 있는 손잡이. 지금은 «내 스펙 다시 읽기» 하나뿐이다. */
export interface UnionHandle {
  /**
   * 개인용이면 계산기에 잡아 둔 내 스펙(싱크로·콘솔·로스터)을 다시 읽는다.
   * 탭을 옮겨 다니며 싱크로를 고치는 흐름이 흔한데, 모드를 켤 때 한 번만 읽으면
   * 그 뒤에 바꾼 값이 반영되지 않는다.
   */
  refreshMe(): void;

  /**
   * 이 판이 지금 워커를 쓰고 있나 — 돌리기·검색·덱 견주기 가운데 하나라도 도는 중.
   *
   * 계산기 쪽의 «미리 계산»(버프 대상 프리페치)이 이것을 보고 비켜선다. 요청 하나가
   * 도는 **사이사이**까지 포함해야 해서 «지금 요청이 떠 있나»가 아니라 **판이 도는가**를
   * 낸다 — 검색은 한 판마다 요청을 끊어 보내므로, 그 틈에 끼어들면 마찬가지다.
   */
  busy(): boolean;
}

export function mountUnionRaid(hosts: UnionHosts, deps: UnionDeps): UnionHandle {
  const { panel } = hosts;
  let members: MemberRow[] = [];
  let rosters = new Map<string, Record<string, CharacterOverrides>>();
  let consoles = new Map<string, BattleSettings['console']>();
  let bosses: BossSlot[] = Array.from({ length: BOSS_SLOTS }, () => ({
    name: '', code: '', enabled: true,
    decks: Array.from({ length: DECK_SLOTS }, () => ({ code: '' } as DeckSlot)),
  }));
  let results: JobResult[] = [];
  let raidPlan: RaidPlannerPlan | undefined;
  let raidPlannerWorker: Worker | undefined;
  const planSelections = new Set<JobResult>();
  const draftKey = 'nikke-union-board-v2';
  const legacyKey = 'nikke-union-board-v1';
  const retiredSharesKey = 'nikke-union-retired-shares-v1';
  const retiredBosses: BossSlot[] = [];
  let retiredShares: string[] = [];
  let restoredDraft = false;
  // v1 is deliberately never overwritten: it remains a byte-for-byte backup.
  for (const key of [draftKey, legacyKey]) {
    try {
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      const decoded = decodeUnionDraft(saved, deps.catalogNames());
      if (!restoredDraft) { bosses = decoded.slice(0, BOSS_SLOTS); restoredDraft = true; }
      if (decoded[5]) retiredBosses.push(decoded[5]);
    } catch { /* Invalid or unavailable storage must not prevent opening the editor. */ }
  }
  const retiredFromShare = (code: string): BossSlot | undefined => {
    const share = decodeUnionCode(code);
    return share.bosses[5] ? applyUnionShare({ ...share, bosses: [share.bosses[5]] }, deps.catalogNames())[0] : undefined;
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(retiredSharesKey) ?? '[]');
    if (Array.isArray(saved)) for (const code of saved) {
      if (typeof code !== 'string') continue;
      try {
        const retired = retiredFromShare(code);
        if (retired) { retiredShares.push(code); retiredBosses.push(retired); }
      } catch { /* Keep other valid backups. */ }
    }
  } catch { /* Storage can be unavailable. */ }
  let resultBoard = '';
  let resultsInvalidated = false;
  const boardState = () => encodeUnionDraft(bosses, false);
  const persistDraft = () => {
    try { localStorage.setItem(draftKey, encodeUnionDraft(bosses)); } catch { /* Storage can be unavailable. */ }
  };
  const invalidateResults = () => {
    persistDraft();
    if ((results.length || running) && resultBoard !== boardState()) {
      resultsInvalidated = true;
      if (running) cancelled = true;
      results = [];
      raidPlan = undefined;
      raidPlannerWorker?.terminate(); raidPlannerWorker = undefined;
      planSelections.clear();
      renderReport();
      runStatus.textContent = '編成或條件已變更，請重新執行模擬。';
    }
  };
  let running = false;
  let cancelled = false;

  // 모드 — 유니온원을 훑는 «유니온»과, 내 스펙만 쓰는 «개인용».
  //
  // 成員規格有三條路進來：代理伺服器掃描、瀏覽器自行擷取、以及匯出檔匯入。**只有第一條
  // 需要代理伺服器**，所以沒設代理的部署（不自架伺服器的 fork）仍然可以用「聯盟」，
  // 只是那個掃描按鈕按了一定失敗，所以把它整塊藏起來。
  const canScan = Boolean(deps.proxy);
  let personal = false;
  let modeInitialized = false;
  let unionAccounts = { members, rosters, consoles };
  const modeButtons = [...panel.querySelectorAll<HTMLButtonElement>('[data-union-mode]')];
  if (!canScan) {
    const scanBox = panel.querySelector<HTMLElement>('[data-union-scan-box]');
    if (scanBox) scanBox.hidden = true;
  }

  /** 내 로스터를 실제로 가져다 뒀는가. 없으면 개인용은 기본 스펙으로 돈다. */
  const hasMyRoster = () => (rosters.get('me') ? Object.keys(rosters.get('me')!).length > 0 : false);

  /** 계산기에 잡아 둔 내 스펙을 «유니온원 한 명»처럼 세운다 — 뒤 단계가 그대로 돈다. */
  /** 계산기에서 마지막으로 읽어 온 싱크로. 손으로 고친 값과 가려내는 데 쓴다. */
  let lastLoadedSynchro = 0;
  const loadMe = () => {
    const me = deps.me();
    lastLoadedSynchro = me.synchro;
    members = [{
      name: me.name, openid: 'me', synchro: me.synchro, level: 0, area: 0,
      state: 'public', picked: true, owned: me.owned,
      note: me.owned > 0 ? undefined : '가져온 스펙이 없어 기본 스펙으로 계산합니다',
    }];
    rosters = new Map([['me', me.roster]]);
    consoles = new Map([['me', me.console]]);
    results = [];
    planSelections.clear();
  };

  const setMode = (next: boolean) => {
    if (modeInitialized && next === personal) return;
    if (!personal && next) unionAccounts = { members, rosters, consoles };
    if (running) { resultsInvalidated = true; cancelled = true; }
    modeInitialized = true;
    // 以前沒有代理伺服器時，這裡會強制退回「個人用」。現在有了匯出檔匯入，
    // 聯盟模式不再綁著代理伺服器，所以按什麼就是什麼。
    personal = next;
    for (const button of modeButtons) {
      const on = (button.dataset.unionMode === 'personal') === personal;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (personal) loadMe();
    else { ({ members, rosters, consoles } = unionAccounts); results = []; planSelections.clear(); }
    const unionLede = panel.querySelector<HTMLElement>('[data-union-lede-union]');
    const personalLede = panel.querySelector<HTMLElement>('[data-union-lede-personal]');
    if (unionLede) unionLede.hidden = personal;
    if (personalLede) personalLede.hidden = !personal;
    showStep('1', !personal);
    showStep('2', !personal && members.length > 0);
    showStep('3', true); // 계정 자료를 넣기 전에도 보스를 고르고 편성을 준비할 수 있다.
    renderMembers();
    renderReport();
    refreshRunGate();
  };

  const steps = new Map<string, HTMLElement>();
  for (const step of panel.querySelectorAll<HTMLElement>('[data-union-step]')) {
    steps.set(step.dataset.unionStep!, step);
  }
  const showStep = (id: string, on: boolean) => {
    const step = steps.get(id);
    if (step) step.hidden = !on;
  };

  // ── 1단계 · 명단 ─────────────────────────────────────────────────────────
  const snippetBox = pick<HTMLTextAreaElement>(panel, '[data-union-snippet]');
  const copyButton = pick<HTMLButtonElement>(panel, '[data-union-copy]');
  const pasteBox = pick<HTMLTextAreaElement>(panel, '[data-union-paste]');
  const readButton = pick<HTMLButtonElement>(panel, '[data-union-read]');
  const listStatus = pick(panel, '[data-union-list-status]');
  snippetBox.value = MEMBER_SNIPPET;

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(MEMBER_SNIPPET);
      listStatus.textContent = '복사했습니다. 블라블라링크 유니온 스퀘어에서 콘솔(F12)에 붙여넣으세요.';
    } catch {
      snippetBox.select();
      listStatus.textContent = '복사가 막혀 있습니다 — 위 상자의 내용을 직접 복사하세요.';
    }
  });

  readButton.addEventListener('click', () => {
    try {
      const parsed = parseMemberList(pasteBox.value);
      members = parsed.map((row) => ({ ...row, state: 'unknown', picked: false }));
      results = [];
      renderMembers();
      renderReport();
      showStep('2', true);
      listStatus.textContent = `유니온원 ${members.length}명을 읽었습니다. `
        + `공개여부 확인에 ${humanSeconds(estimateScanSeconds(members.length))}쯤 걸립니다.`;
    } catch (error) {
      listStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  // ── 2단계 · 공개여부 ─────────────────────────────────────────────────────
  const scanButton = pick<HTMLButtonElement>(panel, '[data-union-scan]');
  const scanStop = pick<HTMLButtonElement>(panel, '[data-union-scan-stop]');
  const scanStatus = pick(panel, '[data-union-scan-status]');
  const scanBar = pick(panel, '[data-union-scan-progress]');
  const memberBox = pick(panel, '[data-union-members]');
  const ask = pick(panel, '[data-union-ask]');
  const askText = pick(panel, '[data-union-ask-text]');

  const setBar = (bar: HTMLElement, done: number, total: number) => {
    bar.hidden = total === 0;
    const fill = bar.firstElementChild as HTMLElement | null;
    if (fill) fill.style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
  };

  /**
   * 싱크로 칸. 실측 스탯표는 1000까지라 그 위는 이어 붙인 추정치다 — 그 사실을
   * 딜 옆이 아니라 **사람 옆에** 적는다. 왜 이 사람 숫자만 덜 미더운지가 거기서 읽힌다.
   */
  const syncCell = (row: MemberRow): HTMLElement => {
    if (row.synchro <= 0) return el('span', 'union-sync', '싱크로 ?');
    const cell = el('span', 'union-sync', `싱크로 ${row.synchro}`);
    if (row.synchro > SYNCHRO_MEASURED_MAX) {
      cell.classList.add('is-estimated');
      cell.append(el('b', 'union-est', '추정'));
      cell.title = `실측이 닿는 곳이 ${SYNCHRO_MEASURED_MAX}레벨까지입니다. `
        + '그 위는 같은 성장 곡선을 이어 붙여 계산합니다.';
    }
    return cell;
  };

  /**
   * 개인용의 싱크로 칸 — **여기서 바로 고친다.** 값은 계산기 전투 조건에서 가져오지만,
   * 「싱크로만 올리면 얼마나 오르나」를 보려고 오는 자리라 전투 조건 창까지 다녀오게
   * 하면 번거롭다. 고친 값은 이 표를 도는 데만 쓰고 계산기 쪽은 건드리지 않는다.
   */
  const syncInput = (row: MemberRow): HTMLElement => {
    const wrap = el('label', 'union-sync-edit');
    wrap.append(el('span', undefined, '싱크로'));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(SYNCHRO_MAX);
    input.step = '1';
    input.value = String(row.synchro > 0 ? row.synchro : DEFAULT_SYNCHRO_LEVEL);
    input.dataset.unionSynchro = '';
    input.title = '블라블라링크 연동으로 받아 온 계정 싱크로입니다(연동 전이면 전투 조건 값).'
      + ' 여기서 바꾸면 이 표만 그 값으로 돕니다.'
      + ` 실측은 ${SYNCHRO_MEASURED_MAX}레벨까지이고 그 위는 이어 붙인 추정치입니다.`;
    input.addEventListener('change', () => {
      const next = Math.round(Number(input.value));
      if (!Number.isFinite(next) || next < 1 || next > SYNCHRO_MAX) {
        input.value = String(row.synchro);
        return;
      }
      row.synchro = next;
      renderMembers();
    });
    wrap.append(input);
    if (row.synchro > SYNCHRO_MEASURED_MAX) {
      const mark = el('b', 'union-est', '추정');
      mark.title = `실측이 닿는 곳이 ${SYNCHRO_MEASURED_MAX}레벨까지입니다.`;
      wrap.append(mark);
    }
    return wrap;
  };

  /**
   * 유니온원 줄 오른쪽의 보스 칩. **아래 보스 체크와 연동한다** — 꺼 둔 보스는 칩 자체가
   * 안 나온다. 여기서 끄면 그 사람만 그 보스를 건너뛴다(풍압은 되는데 전격은 아닌 사람).
   */
  const bossChips = (row: MemberRow): HTMLElement => {
    const wrap = el('div', 'union-boss-picks');
    const live = bosses.filter((boss) => boss.enabled);
    if (live.length === 0 || row.state !== 'public') return wrap;
    bosses.forEach((boss, index) => {
      if (!boss.enabled) return;
      const chip = el('label', 'union-boss-chip');
      const mark = document.createElement('input');
      mark.type = 'checkbox';
      mark.checked = row.bossPicks?.[index] !== false;
      mark.dataset.unionBossPick = String(index);
      const label = t(boss.name.trim()) || t('보스 {n}', { n: index + 1 });
      chip.title = `${row.name} — ${label}`;
      chip.classList.toggle('is-off', !mark.checked);
      mark.addEventListener('change', (event) => {
        event.stopPropagation();
        row.bossPicks = { ...(row.bossPicks ?? {}), [index]: mark.checked };
        chip.classList.toggle('is-off', !mark.checked);
        refreshRunGate();
      });
      chip.append(mark, el('span', '', String(index + 1)));
      wrap.append(chip);
    });
    return wrap;
  };

  function renderMembers(): void {
    memberBox.replaceChildren();
    if (members.length === 0) return;
    const table = el('div', 'union-table');
    for (const row of members) {
      const line = el('label', 'union-row');
      line.dataset.unionMember = row.openid;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = row.picked;
      box.disabled = row.state !== 'public';
      box.addEventListener('change', () => {
        row.picked = box.checked;
        refreshRunGate();
      });
      const state = el('span', `union-state is-${row.state}`, {
        unknown: '미확인', scanning: '확인 중', public: '공개', private: '비공개', error: '오류',
      }[row.state]);
      // 개인용은 «나» 한 줄뿐이다 — 고를 것도, 공개여부를 따질 것도 없어 아예 안 그린다
      // (`hidden`만으로는 격자 자리가 남아 줄이 어긋난다).
      const owned = row.owned !== undefined && row.owned > 0 ? `니케 ${row.owned}종` : '';
      const note = el('span', 'union-note', [owned, row.note ?? ''].filter(Boolean).join(' · '));
      if (personal) {
        line.classList.add('is-personal');
        line.append(el('span', 'union-name', row.name), syncInput(row), note, bossChips(row));
      } else {
        line.append(box, el('span', 'union-name', row.name), syncCell(row), state, note, bossChips(row));
      }
      table.append(line);
    }
    memberBox.append(table);

    const open = members.filter((row) => row.state === 'public');
    const done = members.filter((row) => row.state !== 'unknown' && row.state !== 'scanning');
    ask.hidden = done.length !== members.length || members.length === 0;
    if (!ask.hidden) {
      askText.textContent = open.length > 0
        ? `공개된 유니온원 ${open.length}명 대상으로 테스트를 해보시겠습니까?`
        : '공개된 유니온원이 없습니다. 「나의 니케」를 공개로 바꾼 뒤 다시 스캔해 주세요.';
    }
    refreshRunGate();
  }

  // 호출 간격을 벌리는 문지기. 한 사람을 여는 데 상류 호출이 예닐곱 번 나가서,
  // 그냥 몰아치면 «212000 request too frequently»가 돌아온다(실측 2026-08-27).
  let nextStart = 0;
  const spaced = async (): Promise<void> => {
    const now = Date.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + REQUEST_GAP_MS;
    if (wait > 0) await new Promise((done) => { setTimeout(done, wait); });
  };

  /**
   * 한 명을 조회한다. 상류가 흔들리거나 «너무 잦다»고 하면 **간격을 벌려 다시** 부른다 —
   * 여럿을 훑는 동안 잠깐 튄 것을 «비공개»로 굳혀 버리면, 실제로 공개한 사람이
   * 계산에서 빠진다. 비공개는 상류가 그렇게 말한 것이므로 다시 부르지 않는다.
   */
  const scanOne = async (row: MemberRow, attempt = 0): Promise<void> => {
    await spaced();
    row.state = 'scanning';
    try {
      const response = await fetch(`${deps.proxy}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileUrl: row.openid,
          ...(row.area > 0 ? { area: row.area } : {}),
        }),
      });
      const payload = await response.json() as RawProfile & { error?: string; reason?: string };
      if (!response.ok) {
        if (payload.reason !== 'private' && attempt < BACKOFF_MS.length) {
          await new Promise((done) => { setTimeout(done, BACKOFF_MS[attempt]); });
          return scanOne(row, attempt + 1);
        }
        row.state = payload.reason === 'private' ? 'private' : 'error';
        row.note = payload.reason === 'private' ? '니케 목록 비공개' : (payload.error ?? `조회 실패 (${response.status})`);
        return;
      }
      const area = pickArea(payload, row.area > 0 ? row.area : undefined);
      if (!area) { row.state = 'private'; row.note = '니케 목록이 비어 있습니다'; return; }
      const { overrides, matched } = areaToOverrides(area, deps.settings, deps.catalog);
      if (matched.length === 0) { row.state = 'private'; row.note = '계산기가 아는 니케가 없습니다'; return; }
      rosters.set(row.openid, overrides);
      const levels = consoleFrom(area);
      if (levels) consoles.set(row.openid, levels);
      row.state = 'public';
      row.owned = matched.length;
      // 전초기지가 비공개면 콘솔을 모른다. 0으로 치고 계산하되, 그 사실을 줄에 적는다 —
      // 딜이 낮게 나온 이유가 스펙이 아니라 «못 본 값»일 수 있어서다.
      row.note = levels ? undefined : '콘솔 비공개 · 0으로 계산';
      row.picked = true;
    } catch (error) {
      if (attempt < BACKOFF_MS.length) {
        await new Promise((done) => { setTimeout(done, BACKOFF_MS[attempt]); });
        return scanOne(row, attempt + 1);
      }
      row.state = 'error';
      row.note = error instanceof Error ? error.message : String(error);
    }
  };

  const runScan = async () => {
    if (running || members.length === 0) return;
    running = true;
    cancelled = false;
    scanButton.disabled = true;
    scanStop.hidden = false;
    const total = members.length;
    let done = 0;
    const started = Date.now();
    const queue = [...members];
    const worker = async () => {
      while (queue.length > 0 && !cancelled) {
        const row = queue.shift()!;
        await scanOne(row);
        done += 1;
        setBar(scanBar, done, total);
        scanStatus.textContent = `${done}/${total} · 남은 시간 약 `
          + humanSeconds(remainingSeconds(done, total, Date.now() - started));
        renderMembers();
      }
    };
    // 둘씩만 동시에 부른다. 셋으로 돌렸더니 공개한 사람이 실패로 튀어 «비공개»로
    // 잘못 잡히는 일이 실제로 났다(2026-08-27). 조금 느려도 맞는 답이 낫다.
    await Promise.all([worker(), worker()]);
    running = false;
    scanButton.disabled = false;
    scanStop.hidden = true;
    const open = members.filter((row) => row.state === 'public').length;
    scanStatus.textContent = cancelled
      ? `중단했습니다 (${done}/${total} 확인).`
      : `${total}명 확인 · 공개 ${open}명 · ${humanSeconds((Date.now() - started) / 1000)} 걸렸습니다.`;
    renderMembers();
    if (open > 0) showStep('3', true);
  };

  scanButton.addEventListener('click', () => { void runScan(); });

  // 직접 긁기 — 저희 프록시를 거치지 않는 길. 「유니온원에게만 공개」는 이쪽으로만 보인다.
  const directSnippet = pick<HTMLTextAreaElement>(panel, '[data-union-direct-snippet]');
  const directCopy = pick<HTMLButtonElement>(panel, '[data-union-direct-copy]');
  const directPaste = pick<HTMLTextAreaElement>(panel, '[data-union-direct-paste]');
  const directRead = pick<HTMLButtonElement>(panel, '[data-union-direct-read]');
  const directStatus = pick(panel, '[data-union-direct-status]');
  directSnippet.value = DIRECT_SNIPPET;

  directCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(DIRECT_SNIPPET);
      directStatus.textContent = '복사했습니다. 블라블라링크에서 콘솔(F12)에 붙여넣으세요 — 32명이면 2~3분 걸립니다.';
    } catch {
      directSnippet.select();
      directStatus.textContent = '복사가 막혀 있습니다 — 위 상자의 내용을 직접 복사하세요.';
    }
  });

  directRead.addEventListener('click', () => {
    directStatus.textContent = '푸는 중…';
    void (async () => {
      try {
        const rows = await parseDirectScan(directPaste.value);
        members = rows.map((row) => ({
          name: row.name, openid: row.openid, synchro: row.synchro, level: row.level, area: row.area,
          state: row.state, picked: false, note: row.note,
        }));
        rosters = new Map();
        consoles = new Map();
        results = [];
        let open = 0;
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]!;
          const seat = members[index]!;
          if (row.state !== 'public' || !row.profile) continue;
          const area = pickArea(row.profile as never, row.area > 0 ? row.area : undefined);
          if (!area) { seat.state = 'private'; seat.note = '니케 목록이 비어 있습니다'; continue; }
          const { overrides, matched } = areaToOverrides(area, deps.settings, deps.catalog);
          if (matched.length === 0) { seat.state = 'private'; seat.note = '계산기가 아는 니케가 없습니다'; continue; }
          rosters.set(seat.openid, overrides);
          const levels = consoleFrom(area);
          if (levels) consoles.set(seat.openid, levels);
          seat.owned = matched.length;
          seat.note = levels ? undefined : '콘솔 비공개 · 0으로 계산';
          seat.picked = true;
          open += 1;
        }
        renderMembers();
        renderReport();
        showStep('2', true);
        if (open > 0) showStep('3', true);
        directStatus.textContent = `유니온원 ${members.length}명을 읽었습니다 · 공개 ${open}명. `
          + '서버 스캔 없이 바로 고르실 수 있습니다.';
      } catch (error) {
        directStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  // 匯出檔匯入 —— 三條路裡唯一不需要任何登入的。每位成員各自匯出一個檔案交出來，
  // 指揮官一次全部拖進來。設「僅對聯盟成員公開」甚至完全不公開的人也算得到，
  // 因為資料是他自己給的，不是我們去查的。
  const fileInput = pick<HTMLInputElement>(panel, '[data-union-files]');
  const fileDrop = pick<HTMLElement>(panel, '[data-union-drop]');
  const fileStatus = pick(panel, '[data-union-file-status]');

  /**
   * 讀進來的檔案 → 成員表。
   *
   * `openid` 這裡沒有真的 openid（那是 blablalink 的東西），拿暱稱當代號。
   * 後面每一步都只把它當成「這一列是誰」的鍵，不會拿去查詢，所以夠用。
   */
  const takeFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    fileStatus.textContent = `讀取中… (${files.length} 個檔案)`;
    try {
      const texts = await Promise.all(files.map(async (file) => ({
        name: file.name, text: await file.text(),
      })));
      const { profiles, failed } = parseExiaBatch(texts, deps.settings);
      if (personal) setMode(false);

      if (profiles.length > 0) {
        results = []; raidPlan = undefined; planSelections.clear();
        if (running) { resultsInvalidated = true; cancelled = true; }
      }
      let usable = 0;
      let added = 0, updated = 0;

      for (const profile of profiles) {
        const { overrides, matched } = areaToOverrides(profile.raw, deps.settings, deps.catalog);
        const seat: MemberRow = {
          name: profile.name,
          openid: `file:${profile.name}`,
          synchro: profile.synchro || DEFAULT_SYNCHRO_LEVEL,
          level: 0,
          area: profile.area,
          state: matched.length > 0 ? 'public' : 'error',
          owned: matched.length,
          picked: matched.length > 0,
          note: matched.length > 0
            ? (profile.notes.length > 0 ? profile.notes.join(' ') : undefined)
            : '檔案裡沒有計算機認得的妮姬',
        };
        const previous = members.findIndex(row => row.openid === seat.openid);
        if (previous >= 0) {
          seat.picked = seat.state === 'public' && members[previous]!.picked;
          seat.bossPicks = members[previous]!.bossPicks;
          members[previous] = seat; updated += 1;
        } else { members.push(seat); added += 1; }
        rosters.delete(seat.openid); consoles.delete(seat.openid);
        if (matched.length === 0) continue;
        rosters.set(seat.openid, overrides);
        const levels = consoleFrom(profile.raw);
        if (levels) consoles.set(seat.openid, levels);
        usable += 1;
      }

      // 讀不起來的檔案也留一列。靜靜地少一個人，會讓人以為那個人的檔案傳丟了。
      for (const bad of failed) {
        members = members.filter(row => row.openid !== `bad:${bad.file}`);
        members.push({
          name: bad.file, openid: `bad:${bad.file}`, synchro: 0, level: 0, area: 0,
          state: 'error', picked: false, note: bad.reason,
        });
      }

      renderMembers();
      renderReport();
      showStep('2', true);
      if (usable > 0) showStep('3', true);
      refreshRunGate();

      fileStatus.textContent = t('추가 {added}명 · 갱신 {updated}명 · 전체 {total}명 · 실패 {failed}개', {
        added, updated, total: members.filter(row => row.state === 'public').length, failed: failed.length,
      });
    } catch (error) {
      fileStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  };

  /** 選檔和拖放走同一條路。拖放要擋掉瀏覽器預設的「直接開啟檔案」。 */
  const wireDrop = (
    zone: HTMLElement, input: HTMLInputElement, take: (files: File[]) => void,
  ): void => {
    input.addEventListener('change', () => {
      take([...(input.files ?? [])]);
      input.value = '';                 // 清空才能重選同一個檔案時仍然觸發 change
    });
    for (const type of ['dragenter', 'dragover'] as const) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      zone.addEventListener(type, () => zone.classList.remove('is-over'));
    }
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      take([...(event.dataTransfer?.files ?? [])]);
    });
  };

  let pendingFiles = Promise.resolve();
  wireDrop(fileDrop, fileInput, files => { pendingFiles = pendingFiles.then(() => takeFiles(files)); });

  // 清洗工具 —— 傳檔之前用的。瀏覽器改不了硬碟上的原檔，所以這裡是「另存一份乾淨的」。
  const washInput = pick<HTMLInputElement>(panel, '[data-union-wash-files]');
  const washDrop = pick<HTMLElement>(panel, '[data-union-wash-drop]');
  const washStatus = pick(panel, '[data-union-wash-status]');

  const washFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    let done = 0;
    const bad: string[] = [];
    for (const file of files) {
      try {
        const clean = stripExiaProfile(await file.text());
        const url = URL.createObjectURL(new Blob([clean], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name.replace(/(\.json)?$/i, '-clean.json');
        link.click();
        // 給瀏覽器一點時間真的開始存檔，再放掉這個網址。
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        done += 1;
      } catch {
        bad.push(file.name);
      }
    }
    washStatus.textContent = bad.length === 0
      ? `已清洗 ${done} 個檔案並下載。傳這些 -clean.json 就好。`
      : `已清洗 ${done} 個。讀不起來的：${bad.join('、')}`;
  };

  wireDrop(washDrop, washInput, (files) => { void washFiles(files); });

  scanStop.addEventListener('click', () => { cancelled = true; });
  pick<HTMLButtonElement>(panel, '[data-union-pick-all]').addEventListener('click', () => {
    for (const row of members) row.picked = row.state === 'public';
    renderMembers();
  });
  pick<HTMLButtonElement>(panel, '[data-union-pick-none]').addEventListener('click', () => {
    for (const row of members) row.picked = false;
    renderMembers();
  });

  // ── 3단계 · 보스와 덱 ────────────────────────────────────────────────────
  const bossBox = pick(panel, '[data-union-bosses]');
  let undoBossBoard: string | undefined;
  let undoIncludesDecks = false;
  const rememberBossBoard = (includeDecks = false): void => {
    undoBossBoard = encodeUnionDraft(bosses); undoIncludesDecks = includeDecks;
  };
  const loadBoardCode = (code: string): void => {
    const next = readUnionCode(code, deps.catalogNames(), DEFAULT_SYNCHRO_LEVEL);
    const retired = retiredFromShare(code);
    if (retired && !retiredShares.includes(code)) {
      retiredShares.push(code); retiredBosses.push(retired);
      try { localStorage.setItem(retiredSharesKey, JSON.stringify(retiredShares)); } catch { /* Session recovery still works. */ }
    }
    bosses = next; undoBossBoard = undefined;
  };
  const seasonBox = el('section', 'union-season');
  steps.get('1')!.before(seasonBox);
  const applyPreset = (boss: BossSlot, preset: UnionBossPreset): BossSlot => ({
    ...readBossCode({ ...boss, name: preset.name, bossId: preset.id, enabled: true,
      code: encodeBattleCode(recommendedUnionBattle(preset)) }),
    decks: boss.decks,
  });
  const portrait = (preset: UnionBossPreset, className: string): HTMLElement => {
    const frame = el('div', className);
    const src = unionBossArt(preset);
    if (!src) {
      frame.append(el('span', 'union-art-fallback', t(preset.name)));
      return frame;
    }
    const img = document.createElement('img');
    img.src = src; img.alt = t(preset.name); img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      frame.append(el('span', 'union-art-fallback', t(preset.name)));
    }, { once: true });
    frame.append(img);
    return frame;
  };
  function renderSeason(): void {
    seasonBox.replaceChildren();
    const season = unionSeasonForBosses(bosses);
    const heading = el('div', 'union-season-heading');
    heading.append(el('h4', undefined, t('회차 보스')));
    const select = el('select');
    select.ariaLabel = t('회차 선택');
    select.dataset.unionSeason = '';
    if (!season) select.append(new Option(t('사용자 설정 / 가져온 판'), ''));
    for (const entry of UNION_BOSS_SEASONS) select.append(new Option(entry.label, entry.id));
    select.value = season?.id ?? '';
    select.addEventListener('change', () => {
      const selected = UNION_BOSS_SEASONS.find(entry => entry.id === select.value);
      if (!selected) return;
      rememberBossBoard();
      bosses = bosses.map((boss, index) => applyPreset(boss, selected.bosses[index]!));
      renderBosses(); renderMembers();
    });
    heading.append(select);
    if (undoBossBoard) {
      const undo = el('button', 'roster-import', t('보스 변경 되돌리기'));
      undo.type = 'button';
      undo.dataset.unionSeasonUndo = '';
      undo.addEventListener('click', () => {
        const previous = decodeUnionDraft(undoBossBoard!, deps.catalogNames());
        bosses = previous.map((boss, index) => ({ ...boss, decks: undoIncludesDecks ? boss.decks : bosses[index]!.decks }));
        undoBossBoard = undefined;
        renderBosses(); renderMembers();
      });
      heading.append(undo);
    }
    seasonBox.append(heading, el('p', 'field-note',
      t('회차를 바꾸면 보스 1~5의 조건이 자동으로 바뀝니다. 각 칸의 편성·버스트 설정은 유지되며, 변경을 되돌릴 수 있습니다.')));
    const lineup = el('div', 'union-season-lineup');
    bosses.forEach((boss, index) => {
      const preset = unionBossPreset(boss.bossId);
      const tile = el('button', 'union-season-tile');
      tile.type = 'button';
      if (preset) tile.append(portrait(preset, 'union-season-art'));
      tile.append(el('span', undefined, t('보스 {n}', { n: index + 1 })),
        el('strong', undefined, t(boss.name) || t('직접 설정')),
        el('span', undefined, t('약점: {code}', { code: t(bossWeakness(boss.battle?.enemyCode ?? '')) || '—' })));
      tile.title = t('보스 {n} 선택', { n: index + 1 });
      tile.addEventListener('click', () => {
        bossBox.children[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      lineup.append(tile);
    });
    seasonBox.append(lineup);
    if (season?.id === 's44') seasonBox.append(el('p', 'field-note',
      t('추천값은 DILDORO S44 설정(2026-09-09)입니다. 단계와 실제 부위 파괴 시간에 맞게 수정하세요.')));
    if (bosses.some(boss => { const preset = unionBossPreset(boss.bossId); return preset && preset.seasonId !== 's44'; })) {
      seasonBox.append(el('p', 'field-note union-season-warning',
        t('과거 회차는 보스 명단·속성만 검증되었습니다. 전투 조건은 기본값이며 방어력·코어·부위·구간을 확인해야 합니다. S44 추천값은 적용하지 않습니다.')));
    }
    retiredBosses.forEach((retired, index) => {
      if (!retired.name && !retired.code && !retired.decks.some(deck => deck.code)) return;
      const recovery = el('details', 'union-retired-boss');
      recovery.append(el('summary', undefined, t('이전 6번 칸 백업 (계산 제외)')),
        el('p', 'field-note', `${index + 1}. ${t(retired.name) || t('직접 설정')} · ${t('기존 백업은 유지됩니다. 복사하면 선택한 칸의 조건과 편성을 덮어쓰며, 되돌릴 수 있습니다.')}`));
      const target = el('select'); target.ariaLabel = t('백업 복원 위치');
      for (let at = 0; at < BOSS_SLOTS; at++) target.append(new Option(t('보스 {n}', { n: at + 1 }), String(at)));
      const restore = el('button', 'roster-import', t('선택한 칸에 백업 복사 (덮어쓰기)'));
      restore.type = 'button';
      restore.addEventListener('click', () => {
        rememberBossBoard(true);
        // Round-trip a full board to preserve codes and all per-deck options.
        const copy = decodeUnionDraft(encodeUnionDraft(Array.from({ length: BOSS_SLOTS }, () => retired)), deps.catalogNames())[0]!;
        bosses[Number(target.value)] = copy;
        renderBosses(); renderMembers();
      });
      recovery.append(target, restore); seasonBox.append(recovery);
    });
    const source = el('a', 'field-note', t('자료 출처: DILDORO'));
    source.href = 'https://dildoro.com/union'; source.target = '_blank'; source.rel = 'noopener noreferrer';
    seasonBox.append(source);
  }

  // 視覺排隊器。판은 **하나뿐**이고 겨눈 덱 줄 아래로 옮겨 다닌다 — 덱 줄이 열다섯이라
  // 줄마다 격자를 그리면 니케 200명이 열다섯 벌 깔린다.
  const picker = new UnionSquadPicker({
    catalog: deps.catalog,
    labelOf: deps.labelOf,
    imageOf: deps.imageOf,
    onRedraw: () => renderBosses(),
  });

  // ── 공유에서 고르기 ──────────────────────────────────────────────────────
  // 보스 조건·덱·판 전체가 같은 목록 구조를 쓰므로 창 하나에 판 셋을 얹고 필요한 것만
  // 보인다. 「어디에 넣을지」는 창을 열 때 정하고, 아래 콜백들이 그 값을 읽는다.
  type ShareTarget =
    | { kind: 'boss'; boss: number }
    | { kind: 'squad'; boss: number; deck: number }
    | { kind: 'union' };

  const shareModal = panel.querySelector<HTMLElement>('[data-union-share-modal]');
  const sharePanels = new Map<ShareKind, SharePanel>();
  const shareHosts = new Map<ShareKind, HTMLElement>();
  let shareTarget: ShareTarget = { kind: 'union' };
  let openSharePicker: ((target: ShareTarget) => void) | null = null;

  const shareMsg = shareModal?.querySelector<HTMLElement>('[data-union-share-msg]') ?? null;
  const notifyShare = (message: string, ok = false): void => {
    if (!shareMsg) return;
    shareMsg.textContent = message;
    shareMsg.hidden = message === '';
    shareMsg.classList.toggle('is-ok', ok);
  };

  /** 지금 그 칸에 있는 것을 「올리기」 탭에 넘긴다. 창을 열 때 정한 자리를 본다. */
  const currentFor = (kind: ShareKind): { code: string; auto: string } => {
    if (kind === 'union') {
      return { code: unionCodeOf(bosses), auto: summarizeUnion(unionShareOf(bosses).bosses) };
    }
    if (kind === 'boss' && shareTarget.kind === 'boss') {
      const boss = bosses[shareTarget.boss];
      return {
        code: boss?.code ?? '',
        auto: boss?.battle ? summarizeBattle(boss.battle) : '조건 없음',
      };
    }
    if (kind === 'squad' && shareTarget.kind === 'squad') {
      const deck = bosses[shareTarget.boss]?.decks[shareTarget.deck];
      return {
        code: deck?.code ?? '',
        auto: summarizeSquad([{ squad: deck?.squad ?? [] }], false),
      };
    }
    return { code: '', auto: '' };
  };

  /** 목록에서 고른 것을 그 자리에 넣는다. 코드가 깨졌으면 던져서 창이 알리게 둔다. */
  const applyShared = (kind: ShareKind, item: ShareItem): void => {
    if (kind === 'union') {
      loadBoardCode(item.code);
      renderBosses();
      renderMembers();
      notifyShare(`«${item.name}» 판을 깔았습니다.`, true);
      return;
    }
    if (kind === 'boss' && shareTarget.kind === 'boss') {
      const at = shareTarget.boss;
      const boss = bosses[at];
      if (!boss) return;
      bosses[at] = { ...readBossCode({ ...boss, code: item.code }), decks: boss.decks };
      const failed = bosses[at]!.error;
      renderBosses();
      if (failed) throw new Error(failed);
      notifyShare(`已把 «${item.name}» 條件填入王 ${at + 1} 格。`, true);
      return;
    }
    if (kind === 'squad' && shareTarget.kind === 'squad') {
      const { boss: at, deck: deckAt } = shareTarget;
      const boss = bosses[at];
      if (!boss) return;
      boss.decks[deckAt] = { ...readDeckCode({ code: item.code }, deps.catalogNames()), label: boss.decks[deckAt]?.label };
      const failed = boss.decks[deckAt]!.error;
      renderBosses();
      if (failed) throw new Error(failed);
      notifyShare(`已把 «${item.name}» 填入王 ${at + 1} 的第 ${deckAt + 1} 隊。`, true);
    }
  };

  if (shareModal && deps.shareServer) {
    const server = deps.shareServer;
    const body = pick(shareModal, '[data-union-share-body]');
    const title = pick(shareModal, '[data-union-share-title]');
    const desc = pick(shareModal, '[data-union-share-desc]');

    const closeShare = (): void => { shareModal.hidden = true; };
    pick<HTMLButtonElement>(shareModal, '[data-union-share-close]')
      .addEventListener('click', closeShare);
    shareModal.addEventListener('click', (event) => {
      if (event.target === shareModal) closeShare();
    });

    for (const kind of ['boss', 'squad', 'union'] as ShareKind[]) {
      const host = el('div', 'union-share-host');
      host.hidden = true;
      const tabs = el('div', 'share-tabs');
      const upload = el('div', 'share-pane');
      const list = el('div', 'share-pane');
      const code = el('div', 'share-pane');
      host.append(tabs, upload, list, code);
      body.append(host);
      shareHosts.set(kind, host);

      sharePanels.set(kind, mountSharePanel({ tabs, upload, list, code }, {
        kind,
        server,
        // 코드 칸은 보스·덱 칸에 이미 나와 있다 — 창 안에 또 두지 않는다.
        tabs: ['upload', 'list'],
        current: () => currentFor(kind),
        apply: (item) => applyShared(kind, item),
        notify: notifyShare,
        preview: kind === 'squad' ? (item) => {
          try {
            const payload = decodeShareCode(item.code, deps.catalogNames());
            const squads = payload.decks
              .map((entry) => entry.squad.filter((name) => name.trim() !== ''))
              .filter((squad) => squad.length > 0);
            return squads.length > 0 ? squadPreview(squads, deps.imageOf, deps.labelOf) : null;
          } catch {
            return null;
          }
        } : undefined,
      }));
    }

    const LABELS: Record<ShareKind, { title: string; desc: string }> = {
      boss: {
        title: '보스 조건 고르기',
        desc: '남들이 올린 <b>전투 조건</b>입니다. 고르면 이 보스 칸에 그대로 들어갑니다 — 싱크로와 콘솔은 담기지 않으므로 유니온원 각자의 값이 그대로 쓰입니다.',
      },
      squad: {
        title: '조합 고르기',
        desc: '남들이 올린 <b>조합</b>입니다. 고르면 이 덱 칸에 들어갑니다 — 누가 편성됐는지만 담기고, 수치는 유니온원 각자의 것을 씁니다.',
      },
      // 유니온 판에서는 보스 그림을 고르지 않는다 — 이 표는 종류마다 한 줄이 있어야 해서
      // 자리만 채워 둔다(보스 메이커의 공유는 그쪽 화면이 제 문구로 연다).
      maker: {
        title: '보스 고르기',
        desc: '남들이 그린 <b>보스</b>입니다.',
      },
      union: {
        title: '유니온 레이드 판 고르기',
        desc: '보스 다섯과 각 칸의 덱까지 <b>한 판을 통째로</b> 담은 것입니다. 고르면 지금 짜 둔 판을 덮어씁니다. <b>유니온원 명단은 담기지 않습니다.</b>',
      },
    };

    openSharePicker = (target: ShareTarget): void => {
      shareTarget = target;
      title.textContent = LABELS[target.kind].title;
      desc.innerHTML = LABELS[target.kind].desc;
      for (const [kind, host] of shareHosts) host.hidden = kind !== target.kind;
      notifyShare('');
      shareModal.hidden = false;
      sharePanels.get(target.kind)?.open();
    };
  }

  // ── 판 코드 (NK4) ────────────────────────────────────────────────────────
  const setStatus = pick(panel, '[data-union-set-status]');
  const setBox = pick(panel, '[data-union-set-box]');
  const setCode = pick<HTMLTextAreaElement>(panel, '[data-union-set-code]');

  const sayBoard = (message: string, ok = false): void => {
    setStatus.textContent = message;
    setStatus.classList.toggle('is-ok', ok);
  };

  pick<HTMLButtonElement>(panel, '[data-union-set-copy]').addEventListener('click', async () => {
    const code = unionCodeOf(bosses);
    setBox.hidden = false;
    setCode.value = code;
    try {
      await navigator.clipboard.writeText(code);
      sayBoard('판 코드를 복사했습니다. 유니온방에 그대로 붙여넣으면 됩니다.', true);
    } catch {
      setCode.select();
      sayBoard('자동 복사가 막혀 코드를 선택해 뒀습니다. Ctrl+C로 복사해 주세요.');
    }
  });

  pick<HTMLButtonElement>(panel, '[data-union-set-paste]').addEventListener('click', () => {
    setBox.hidden = false;
    setCode.value = '';
    setCode.focus();
    sayBoard('받은 판 코드(NK4-…)를 붙여넣고 「이 판 적용」을 누르세요.');
  });

  pick<HTMLButtonElement>(panel, '[data-union-set-apply]').addEventListener('click', () => {
    try {
      loadBoardCode(setCode.value);
      renderBosses();
      renderMembers();
      const live = bosses.filter((boss) => boss.enabled).length;
      sayBoard(t('판을 깔았습니다 — 보스 {n}개.', { n: live }), true);
      setBox.hidden = true;
    } catch (error) {
      sayBoard(error instanceof Error ? error.message : String(error));
    }
  });

  pick<HTMLButtonElement>(panel, '[data-union-set-close]').addEventListener('click', () => {
    setBox.hidden = true;
    sayBoard('');
  });

  const setShare = panel.querySelector<HTMLButtonElement>('[data-union-set-share]');
  if (setShare) {
    if (openSharePicker) {
      const open = openSharePicker;
      setShare.addEventListener('click', () => open({ kind: 'union' }));
    } else {
      setShare.hidden = true;
    }
  }

  function renderBosses(): void {
    invalidateResults();
    renderSeason();
    bossBox.replaceChildren();
    bosses.forEach((boss, index) => {
      const card = el('div', 'union-boss');
      card.dataset.bossIndex = String(index);
      const preset = unionBossPreset(boss.bossId);
      const hero = el('div', 'union-boss-hero');
      if (preset) hero.append(portrait(preset, 'union-boss-art'));
      else hero.append(el('div', 'union-boss-art union-art-empty', String(index + 1).padStart(2, '0')));
      const identity = el('div', 'union-boss-identity');
      const stage = t('보스 {n}', { n: index + 1 });
      identity.append(el('span', 'union-boss-stage', stage));
      const choose = el('select', 'union-boss-preset');
      choose.ariaLabel = t('보스 {n} 선택', { n: index + 1 });
      choose.append(new Option(t('직접 설정'), ''));
      for (const season of UNION_BOSS_SEASONS) {
        const group = el('optgroup'); group.label = season.label;
        for (const entry of season.bosses) group.append(new Option(t(entry.name), entry.id));
        choose.append(group);
      }
      choose.value = preset?.id ?? '';
      choose.addEventListener('change', () => {
        rememberBossBoard();
        const selected = unionBossPreset(choose.value);
        bosses[index] = selected ? applyPreset(boss, selected) : { ...boss, bossId: undefined };
        renderBosses(); renderMembers();
      });
      identity.append(choose);
      const weak = bossWeakness(boss.battle?.enemyCode ?? '');
      identity.append(el('span', 'union-boss-weakness', weak
        ? t('약점: {code}', { code: t(weak) }) : t('전투 조건을 설정하세요')));
      const outcome = el('div', 'union-boss-outcome');
      outcome.dataset.bossOutcome = String(index);
      outcome.textContent = t('계산 결과 없음');
      identity.append(outcome);
      hero.append(identity);
      card.append(hero);
      if (!boss.enabled) card.classList.add('is-off');

      const head = el('div', 'union-boss-head');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = boss.enabled;
      toggle.title = '끄면 이 보스는 계산하지 않습니다';
      toggle.addEventListener('change', () => {
        boss.enabled = toggle.checked;
        renderBosses();
        renderMembers();       // 줄 오른쪽 칩이 보스 체크를 따라간다
      });
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'union-boss-name';
      name.placeholder = t('보스 {n} 이름', { n: index + 1 });
      name.value = t(boss.name);
      name.addEventListener('input', () => {
        boss.name = name.value;
        invalidateResults();
        refreshRunGate();
        for (const chip of memberBox.querySelectorAll<HTMLElement>('.union-boss-chip')) {
          const at = Number(chip.querySelector<HTMLInputElement>('[data-union-boss-pick]')?.dataset.unionBossPick);
          if (at === index) chip.title = `${chip.title.split(' — ')[0]} — ${boss.name.trim() || `王 ${index + 1}`}`;
        }
      });
      head.append(toggle, name, el('span', 'union-boss-summary', battleSummary(boss)));
      card.append(head);

      // 보스의 모습. 회차마다 실제로 바뀌는 것들만 여기서 고르고, 나머지는 기본값이다.
      // 코드를 붙여넣지 않아도 조건이 서야 편성만 짜 둔 사람이 막히지 않는다.
      const codeRow = el('div', 'union-code-row');
      const shape = shapeOf(boss.battle);
      const applyShape = (next: Partial<BossShape>): void => {
        const changed = decodeBattleCode(bossCodeForShape({ ...shape, ...next }));
        const code = encodeBattleCode({ ...(boss.battle ?? changed),
          enemyCode: changed.enemyCode, coreEnabled: changed.coreEnabled, corePx: changed.corePx,
          hasParts: changed.hasParts, enemyDef: changed.enemyDef } as BattleSettings);
        bosses[index] = { ...readBossCode({ ...boss, code }), decks: boss.decks };
        renderBosses();
      };

      const pickCode = el('label', 'union-boss-code');
      pickCode.append(el('span', undefined, t('보스 속성')));
      const codeSelect = document.createElement('select');
      for (const value of BOSS_CODES) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value ? value : '無屬性';
        codeSelect.append(option);
      }
      codeSelect.value = shape.element;
      codeSelect.addEventListener('change', () =>
        applyShape({ element: codeSelect.value as ElementCode }));
      pickCode.append(codeSelect);
      codeRow.append(pickCode);

      // 조건이 선 보스에만 나머지 칸을 그린다 — 속성을 고르기 전에는 고칠 것이 없다.
      if (boss.battle) {
        const core = el('label', 'union-boss-code');
        core.append(el('span', undefined, '核心'));
        const corePx = document.createElement('input');
        corePx.type = 'number';
        corePx.min = '0';
        corePx.max = '400';
        corePx.step = '1';
        corePx.className = 'union-boss-num';
        corePx.value = String(shape.corePx);
        corePx.title = '核心直徑(px)。0 = 沒有核心。開核心的傷害差快兩倍。';
        corePx.addEventListener('change', () =>
          applyShape({ corePx: Math.max(0, Math.trunc(Number(corePx.value) || 0)) }));
        core.append(corePx, el('span', undefined, 'px'));
        codeRow.append(core);

        const def = el('label', 'union-boss-code');
        def.append(el('span', undefined, '防禦'));
        const defInput = document.createElement('input');
        defInput.type = 'number';
        defInput.min = '0';
        defInput.step = '1';
        defInput.className = 'union-boss-num';
        defInput.value = String(shape.enemyDef);
        defInput.title = '王的防禦力。每期・每階段不同,知道實際值就填進來。';
        defInput.addEventListener('change', () =>
          applyShape({ enemyDef: Math.max(0, Math.trunc(Number(defInput.value) || 0)) }));
        def.append(defInput);
        codeRow.append(def);

        const parts = el('label', 'union-boss-code');
        const partsBox = document.createElement('input');
        partsBox.type = 'checkbox';
        partsBox.checked = shape.hasParts;
        partsBox.title = '這隻王有可破壞部位';
        partsBox.addEventListener('change', () => applyShape({ hasParts: partsBox.checked }));
        parts.append(partsBox, el('span', undefined, t('상시 부위')));
        codeRow.append(parts);
      }

      const code = document.createElement('input');
      code.type = 'text';
      code.className = 'union-code';
      code.placeholder = '전투 조건 코드 (NK3-…)';
      code.value = boss.code;
      code.addEventListener('input', () => {
        bosses[index] = { ...readBossCode({ ...boss, code: code.value }), decks: boss.decks };
        boss = bosses[index]!;
        renderBosses();
      });
      const grab = el('button', 'roster-import', '지금 조건');
      (grab as HTMLButtonElement).type = 'button';
      grab.title = '계산기에 잡아 둔 전투 조건을 그대로 가져옵니다';
      grab.addEventListener('click', () => {
        bosses[index] = { ...readBossCode({ ...boss, code: deps.currentBattleCode() }), decks: boss.decks };
        renderBosses();
      });
      codeRow.append(code, grab);
      if (openSharePicker) {
        const open = openSharePicker;
        const fromShare = el('button', 'roster-import', '공유에서');
        (fromShare as HTMLButtonElement).type = 'button';
        fromShare.title = '남들이 올린 보스 조건 목록에서 고릅니다';
        fromShare.addEventListener('click', () => open({ kind: 'boss', boss: index }));
        codeRow.append(fromShare);
      }
      card.append(codeRow);
      if (boss.battle) {
        const advanced = el('details', 'union-boss-settings');
        advanced.append(el('summary', undefined, t('추천 설정 상세 · 수정')));
        const reset = el('button', 'roster-import', t(preset?.seasonId === 's44' ? '추천값 복원' : '기본 조건 복원'));
        reset.type = 'button'; reset.disabled = !preset;
        reset.addEventListener('click', () => {
          if (!preset) return;
          rememberBossBoard();
          bosses[index] = { ...applyPreset(boss, preset), name: boss.name, enabled: boss.enabled };
          renderBosses();
        });
        advanced.append(reset);
        const updateBattle = (next: Partial<BattleSettings>): void => {
          bosses[index] = readBossCode({ ...boss,
            code: encodeBattleCode({ ...boss.battle!, ...next }) });
          renderBosses();
          const fold = bossBox.children[index]?.querySelector<HTMLDetailsElement>('.union-boss-settings');
          if (fold) fold.open = true;
        };
        const ranges = el('div', 'union-setting-row');
        ranges.append(el('span', undefined, t('적정거리 무기')));
        for (const weapon of ['AR', 'SMG', 'SG', 'SR', 'RL', 'MG']) {
          const label = el('label', undefined, weapon);
          const check = el('input'); check.type = 'checkbox';
          check.checked = boss.battle.optimalRangeWeapons.includes(weapon);
          check.addEventListener('change', () => updateBattle({ optimalRangeWeapons: check.checked
            ? [...boss.battle!.optimalRangeWeapons, weapon]
            : boss.battle!.optimalRangeWeapons.filter(w => w !== weapon) }));
          label.prepend(check); ranges.append(label);
        }
        advanced.append(ranges);
        const coeffs = el('div', 'union-setting-row');
        coeffs.append(el('span', undefined, t('무기별 평타 계수')));
        for (const weapon of ['AR', 'SMG', 'SG', 'SR', 'RL', 'MG']) {
          const label = el('label', undefined, weapon);
          const input = el('input', 'union-boss-num'); input.type = 'number';
          input.min = '0'; input.max = '2'; input.step = '0.01';
          input.value = String(boss.battle.normalHitCoeff[weapon] ?? 1);
          input.ariaLabel = t('{weapon} 평타 계수', { weapon });
          input.addEventListener('change', () => {
            if (!input.checkValidity() || !input.value) {
              input.value = String(boss.battle!.normalHitCoeff[weapon] ?? 1);
              return;
            }
            updateBattle({ normalHitCoeff: { ...boss.battle!.normalHitCoeff, [weapon]: Number(input.value) } });
          });
          label.append(input); coeffs.append(label);
        }
        advanced.append(coeffs);
        const timing = el('div', 'union-setting-row');
        for (const [field, title, fallback] of [
          ['burstSwitchDelay', '버스트 단계 전환 간격', 0.1],
          ['burstReaction', '버스트 반응속도', 0.05],
        ] as const) {
          const label = el('label', undefined, t(title));
          const input = el('input', 'union-boss-num'); input.type = 'number';
          input.min = '0'; input.max = '3'; input.step = '0.01';
          input.value = String(boss.battle[field] ?? fallback);
          input.ariaLabel = t(title);
          input.addEventListener('change', () => {
            if (!input.value || !input.checkValidity()) {
              input.value = String(boss.battle![field] ?? fallback);
              return;
            }
            updateBattle({ [field]: Number(input.value) });
          });
          label.append(input, t('초')); timing.append(label);
        }
        advanced.append(timing);
        advanced.append(el('p', 'field-note',
          t('부위는 시작부터 종료 직전까지 존재하며, 종료 시 부위 하나가 파괴됩니다. 같은 구간을 여러 번 넣으면 여러 부위입니다. 무적은 모든 피해를 막고 속성 저지는 우월 코드만 통과시킵니다.')));
        const phases = boss.battle.bossPhases ?? [];
        const kinds = { parts: '부위', immune: '모든 피해 차단', element_gate: '속성 저지', core: '核心出現', optimal_range: '適正距離', pierce_gate: '僅貫通傷害' };
        advanced.append(el('p', 'field-note', '有核心區間時，僅在區間內開啟上方設定的核心。適正距離區間補充全程武器設定；重疊時較早開始者優先。貫通限定區間只讓貫通傷害通過。'));
        phases.forEach((phase, at) => {
          const line = el('div', 'union-phase-row');
          const phaseError = el('p', 'union-error');
          phaseError.hidden = true;
          phaseError.setAttribute('role', 'alert');
          const kind = el('select');
          kind.ariaLabel = t('구간 {n} 종류', { n: at + 1 });
          for (const [value, label] of Object.entries(kinds)) kind.append(new Option(t(label), value));
          kind.value = phase.kind;
          kind.addEventListener('change', () => updateBattle({ bossPhases: phases.map((p, i) =>
            i === at ? { ...p, kind: kind.value as typeof p.kind } : p) }));
          line.append(kind);
          if (phase.kind === 'optimal_range') {
            const weapons = el('select'); weapons.multiple = true; weapons.size = 3;
            weapons.ariaLabel = `區間 ${at + 1} 適正武器`;
            for (const weapon of ['AR', 'SMG', 'SG', 'MG', 'SR']) {
              const option = new Option(weapon, weapon); option.selected = phase.weapons?.includes(weapon) ?? false; weapons.append(option);
            }
            weapons.addEventListener('change', () => updateBattle({ bossPhases: phases.map((p, i) => i === at
              ? { ...p, weapons: [...weapons.selectedOptions].map(o => o.value) } : p) }));
            line.append(weapons);
          }
          for (const field of ['from', 'to'] as const) {
            const input = el('input', 'union-boss-num'); input.type = 'number';
            input.min = '0'; input.max = '180'; input.step = '0.1'; input.value = String(phase[field]);
            input.ariaLabel = t(field === 'from' ? '구간 {n} 시작' : '구간 {n} 종료', { n: at + 1 });
            input.addEventListener('change', () => {
              const next = { ...phase, [field]: Number(input.value) };
              if (!input.value || !input.checkValidity() || next.from >= next.to) {
                input.value = String(phase[field]);
                phaseError.textContent = t('구간은 0~180초 안에서 시작이 종료보다 빨라야 합니다. 이전 값으로 복원했습니다.');
                phaseError.hidden = false;
                return;
              }
              updateBattle({ bossPhases: phases.map((p, i) => i === at ? next : p) });
            });
            input.addEventListener('input', () => { phaseError.hidden = true; });
            line.append(input);
          }
          const remove = el('button', 'roster-import', t('삭제')); remove.type = 'button';
          remove.ariaLabel = t('구간 {n} 삭제', { n: at + 1 });
          remove.addEventListener('click', () => updateBattle({ bossPhases: phases.filter((_, i) => i !== at) }));
          line.append(el('span', undefined, t('초')), remove, phaseError); advanced.append(line);
        });
        const add = el('button', 'roster-import', t('구간 추가')); add.type = 'button';
        add.disabled = phases.length >= 64;
        add.addEventListener('click', () => updateBattle({ bossPhases: [...phases, { kind: 'parts', from: 0, to: 5 }] }));
        advanced.append(add);
        card.append(advanced);
      }
      if (boss.error) card.append(el('p', 'union-error', boss.error));

      const deckBox = el('div', 'union-decks');
      const extraDeckBox = el('div', 'union-decks');
      let extraHasSquad = false;
      boss.decks.forEach((deck, deckIndex) => {
        const row = el('div', 'union-deck');
        const labelRow = el('div', 'union-deck-label-row');
        labelRow.append(el('p', 'union-deck-label', `第 ${deckIndex + 1} 隊`));
        const nameInput = el('input', 'union-deck-name');
        nameInput.type = 'text';
        nameInput.maxLength = DECK_LABEL_MAX;
        nameInput.placeholder = '隊伍名稱（選填）';
        nameInput.title = '取個好記的名字，例如「紅蓮速攻」；實戰推演頁會顯示這個名稱';
        nameInput.ariaLabel = `第 ${deckIndex + 1} 隊名稱`;
        nameInput.value = deck.label ?? '';
        nameInput.addEventListener('input', () => {
          // 名稱不影響模擬數值，所以不清掉已算好的結果；匯出時才讀。
          deck.label = cleanDeckLabel(nameInput.value);
          // 已算好的結果也跟著改名 —— 同一個 squad 陣列代表還是這一格算出來的。
          for (const row of results) {
            if (row.job.bossIndex === index && row.job.deckIndex === deckIndex && row.job.squad === deck.squad) {
              if (deck.label) row.job.deckLabel = deck.label; else delete row.job.deckLabel;
            }
          }
          persistDraft();
        });
        labelRow.append(nameInput);
        row.append(labelRow);
        const deckOutcome = el('p', 'union-boss-outcome', t('계산 결과 없음'));
        deckOutcome.dataset.deckOutcome = `${index}-${deckIndex}`;
        row.append(deckOutcome);

        // 視覺排隊 —— 點頭像放入。代碼欄仍在下面的「代碼」摺疊裡，因為盤面碼(NK4)
        // 是靠它組出來的，而且貼別人給的組合代碼還是最快的路。
        const slots = el('div', 'union-slots');
        // **먼저 붙이고 그린다.** 판은 `host.after(...)`로 이 줄 아래에 끼어드는데,
        // 아직 부모가 없는 동안 그리면 그 호출이 조용히 아무 일도 하지 않는다.
        row.append(slots);
        picker.renderSlots(slots, `${index}-${deckIndex}`, deck.squad ?? [], (squad) => {
          // 이름 다섯을 코드로 되돌려 둔다 — 판 코드(NK4)와 «지금 무엇이 들어 있나»의
          // 정본이 둘로 갈리면 어느 쪽이 맞는지 알 수 없게 된다.
          const filled = squad.filter(Boolean);
          boss.decks[deckIndex] = filled.length > 0
            ? readDeckCode({ code: encodeShareCode(
              [{ id: 1, squad: [...squad], characters: {} } as DeckState], false), cycle: deck.cycle, burstSequence: deck.burstSequence, noBurst: deck.noBurst, cubes: deck.cubes, label: deck.label },
            deps.catalogNames())
            : { code: '', squad: undefined, error: undefined, label: deck.label };
          renderBosses();
        });

        const tools = el('div', 'union-deck-tools');
        const cycle = el('details', 'union-deck-code');
        cycle.append(el('summary', undefined, '爆裂循環'));
        for (const [field, label] of [
          ['burstReaction', '每階段爆裂反應（秒）'],
          ['burstRegenTime', '全爆裂後充能（秒）'],
        ] as const) {
          const wrap = el('label', 'union-boss-code', label);
          const input = el('input', 'union-boss-num');
          input.type = 'number'; input.min = '0'; input.max = '180'; input.step = '0.1';
          input.value = String(deck.cycle?.[field] ?? boss.battle?.[field] ?? (field === 'burstReaction' ? 0.1 : 2));
          input.addEventListener('input', () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || value < 0 || value > 180) { input.reportValidity(); return; }
            deck.cycle = {
              burstReaction: deck.cycle?.burstReaction ?? boss.battle?.burstReaction ?? 0.1,
              burstRegenTime: deck.cycle?.burstRegenTime ?? boss.battle?.burstRegenTime ?? 2,
              [field]: value,
            };
            invalidateResults();
          });
          wrap.append(input); cycle.append(wrap);
        }
        cycle.append(el('p', 'field-note', '循環設定會隨盤面保存在此瀏覽器；NK2／NK4 分享碼仍只攜帶編成與王條件。'));
        cycle.append(el('p', 'field-note', t('풀버스트가 끝난 뒤 게이지를 다시 채우는 고정 시간입니다. 기본 2초이며 사격으로 자동 추정하지 않습니다. 다음 버스트는 게이지와 스킬 쿨타임이 모두 준비되어야 시작합니다. 첫 버스트 시각은 이 값과 별개입니다.')));
        row.append(cycle);
        if (deck.squad?.some(Boolean)) row.append(createUnionCubeEditor(deck.squad, deck.cubes,
          deps.settings, deps.labelOf, cubes => { deck.cubes = cubes; invalidateResults(); refreshRunGate(); }));
        const skipBox = el('details', 'union-deck-code');
        skipBox.append(el('summary', undefined, '禁止爆裂（仍提供被動技能）'));
        for (const name of (deck.squad ?? []).filter(Boolean)) {
          const label = el('label', undefined, deps.labelOf(name));
          const check = el('input'); check.type = 'checkbox'; check.ariaLabel = `禁止爆裂：${deps.labelOf(name)}`;
          check.checked = deck.noBurst?.includes(name) ?? false;
          check.addEventListener('change', () => {
            deck.noBurst = cleanNoBurst(check.checked ? [...(deck.noBurst ?? []), name] : (deck.noBurst ?? []).filter(n => n !== name), deck.squad ?? []);
            renderBosses();
          });
          label.prepend(check); skipBox.append(label);
        }
        skipBox.append(el('p', 'field-note', '僅保存在本機盤面，不包含在分享碼；若禁用必要階段，可能無法進入全爆裂。'));
        row.append(skipBox);
        row.append(createUnionBurstEditor({
          squad: deck.squad ?? [], sequence: deck.burstSequence, catalog: deps.catalog, noBurst: deck.noBurst,
          duration: boss.battle?.duration ?? 180, labelOf: deps.labelOf,
          onChange: sequence => { deck.burstSequence = sequence; invalidateResults(); refreshRunGate(); },
        }));
        for (const target of [-1, 1]) {
          const to = deckIndex + target;
          if (to < 0 || to >= boss.decks.length) continue;
          const exchange = el('button', 'roster-import', `與第 ${to + 1} 隊交換`);
          exchange.type = 'button';
          exchange.addEventListener('click', () => {
            picker.close();
            [boss.decks[deckIndex], boss.decks[to]] = [boss.decks[to]!, boss.decks[deckIndex]!];
            renderBosses();
          });
          tools.append(exchange);
        }
        const take = el('button', 'roster-import', `帶入計算機第 ${deckIndex + 1} 隊`);
        (take as HTMLButtonElement).type = 'button';
        take.title = '直接帶入計算機裡目前排好的這一隊';
        take.addEventListener('click', () => {
          boss.decks[deckIndex] = readDeckCode({ code: deps.currentDeckCode(deckIndex),
            burstSequence: deps.currentDeckSequence?.(deckIndex), label: deck.label }, deps.catalogNames());
          renderBosses();
        });
        tools.append(take);
        if (openSharePicker) {
          const open = openSharePicker;
          const fromShare = el('button', 'roster-import', '從分享選取');
          (fromShare as HTMLButtonElement).type = 'button';
          fromShare.title = '從別人上傳的組合清單中挑選';
          fromShare.addEventListener('click', () =>
            open({ kind: 'squad', boss: index, deck: deckIndex }));
          tools.append(fromShare);
        }
        if (deck.squad) {
          const clear = el('button', 'roster-import', '清空');
          (clear as HTMLButtonElement).type = 'button';
          clear.addEventListener('click', () => {
            boss.decks[deckIndex] = { code: '', squad: undefined, error: undefined };
            renderBosses();
          });
          tools.append(clear);
        }
        row.append(tools);

        const codeFold = document.createElement('details');
        codeFold.className = 'union-deck-code';
        const codeSummary = document.createElement('summary');
        codeSummary.textContent = '組合代碼 (NK2-)';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'union-code';
        input.placeholder = t('덱 {n} 조합 코드 (NK2-…)', { n: deckIndex + 1 });
        input.value = deck.code;
        input.addEventListener('input', () => {
          boss.decks[deckIndex] = { ...readDeckCode({ code: input.value }, deps.catalogNames()), label: deck.label };
          renderBosses();
        });
        codeFold.append(codeSummary, input);
        row.append(codeFold);

        if (deck.error) row.append(el('p', 'union-error', deck.error));
        if (deckIndex < 3) { deckBox.append(row); return; }
        if (deck.squad?.some(Boolean)) extraHasSquad = true;
        extraDeckBox.append(row);
      });
      card.append(deckBox);
      if (boss.decks.length > 3) {
        const fold = document.createElement('details');
        fold.className = 'union-deck-fold';
        fold.open = extraHasSquad;
        const summary = document.createElement('summary');
        summary.textContent = `+ 更多候選隊伍（第 4～${boss.decks.length} 隊）`;
        fold.append(summary, extraDeckBox);
        card.append(fold);
      }
      bossBox.append(card);
    });
    renderBossOutcomes();
    refreshRunGate();
  }

  const battleSummary = (boss: BossSlot): string => {
    if (!boss.battle) return t('조건 없음');
    const parts = [t('{n}초', { n: boss.battle.duration }),
      t(boss.battle.enemyCode || '무속성'),
      boss.battle.coreEnabled ? t('코어 {n}px', { n: boss.battle.corePx }) : t('코어 없음'),
      t('방어 {n}', { n: DAMAGE.format(boss.battle.enemyDef) }),
      t('보스 구간 {n}개', { n: boss.battle.bossPhases?.length ?? 0 })];
    const decks = boss.decks.filter((deck) => deck.squad).length;
    parts.push(t('편성 {n}개', { n: decks }));
    return parts.join(' · ');
  };

  // ── 4단계 · 실행 ─────────────────────────────────────────────────────────
  const runButton = pick<HTMLButtonElement>(panel, '[data-union-run]');
  const searchBox = el('details', 'union-deck-code union-auto-search');
  searchBox.append(el('summary', undefined, '自動生成 SSR 隊伍與推薦三刀（試用）'));
  searchBox.append(el('p', 'field-note', '只使用帳號持有、計算器支援的正式 SSR 與原有養成。每個啟用的王各搜尋指定盤數，實際模擬評分後跨王挑選不重複三刀。有限搜尋不保證全角色全域最優；不含血量、轉階段、出刀先後與操作極限。盤面既有隊伍會優先測試。'));
  const searchMember = el('select'); searchMember.ariaLabel = '自動組隊帳號';
  const searchBudget = el('input'); searchBudget.type = 'number'; searchBudget.min = '10'; searchBudget.max = '300'; searchBudget.step = '10'; searchBudget.value = '60'; searchBudget.ariaLabel = '每個王搜尋盤數';
  const budgetLabel = el('label', undefined, '每個王搜尋盤數（10–300）'); budgetLabel.append(searchBudget);
  const searchExclude = el('select'); searchExclude.multiple = true; searchExclude.size = 6; searchExclude.ariaLabel = '自動組隊排除角色';
  const excludeLabel = el('label', undefined, '排除角色（可多選；不會自動排除冷門 SSR）'); excludeLabel.append(searchExclude);
  const searchStart = el('button', 'roster-import', '開始生成並搜尋三刀'); searchStart.type = 'button';
  const searchStop = el('button', 'roster-import', '停止搜尋並保留結果'); searchStop.type = 'button'; searchStop.hidden = true;
  const searchStatus = el('p', 'union-status'); searchStatus.setAttribute('aria-live', 'polite');
  searchBox.append(searchMember, budgetLabel, excludeLabel, searchStart, searchStop, searchStatus);
  runButton.parentElement!.before(searchBox);
  const refreshExclusions = () => {
    const excluded = new Set([...searchExclude.selectedOptions].map(o => o.value));
    searchExclude.replaceChildren();
    for (const char of ownedSSR(deps.catalog, deps.settings, rosters.get(searchMember.value) ?? {})) {
      const option = el('option', undefined, deps.labelOf(char.name)); option.value = char.name; option.selected = excluded.has(char.name); searchExclude.append(option);
    }
  };
  const poolNote = el('p', 'field-note'); searchBox.append(poolNote);
  const updatePoolNote = () => {
    const n = searchExclude.options.length - searchExclude.selectedOptions.length;
    const combinations = n < 5 ? 0 : Math.round(n * (n - 1) * (n - 2) * (n - 3) * (n - 4) / 120);
    poolNote.textContent = `SR／R 已排除。可用 SSR ${n} 位；單看五人選擇有 ${combinations.toLocaleString('en-US')} 種，尚未計入站位與爆裂順序。搜尋盤數限制的是模擬次數，不是稀有度。`;
  };
  searchExclude.addEventListener('change', updatePoolNote);
  searchMember.addEventListener('change', () => { refreshExclusions(); updatePoolNote(); });
  const runStop = pick<HTMLButtonElement>(panel, '[data-union-stop]');
  const runStatus = pick(panel, '[data-union-run-status]');
  const runBar = pick(panel, '[data-union-run-progress]');
  const reportBox = pick(panel, '[data-union-report]');
  const gridBox = pick(panel, '[data-union-grid]');
  const raidPlannerBox = pick(panel, '[data-union-raid-planner]');
  const raidHealthKey = 'nikke-union-raid-health-v1';
  const defaultRaidHealth = [
    [1000, 1000, 1508, 1000, 1508],
    [1500, 1500, 2261, 1500, 2261],
    [2920, 2920, 3490, 2920, 3490],
  ];
  let raidHealth = defaultRaidHealth.map(phase => [...phase]);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(raidHealthKey) ?? 'null');
    if (Array.isArray(saved) && saved.length === 3 && saved.every(phase => Array.isArray(phase)
      && phase.length === 5 && phase.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0))) {
      raidHealth = saved.map(phase => [...phase]);
    }
  } catch { /* Invalid health settings fall back to the published defaults. */ }

  /**
   * 무엇이 모자라 못 도는지 한 줄로.
   *
   * 예전에는 돌릴 것이 없으면 실행 자리를 **통째로 감췄다**. 편성만 짜 둔 사람은 화면에서
   * 실행 단추가 사라진 것만 보고 무엇이 모자란지 알 길이 없었다(실제 제보). 자리는 늘
   * 두고, 모자란 것을 짚어 말한다.
   */
  function missingReason(): string {
    if (members.length === 0) return '先在上面匯入成員資料。';
    const picked = members.filter((row) => row.picked && row.state === 'public');
    if (picked.length === 0) return '還沒選取任何成員 — 請在上面的名單勾選。';
    const on = bosses.filter((boss) => boss.enabled);
    if (on.length === 0) return '所有王都被取消勾選了。';
    const noBattle = on.filter((boss) => !boss.battle).length;
    const noDeck = on.filter((boss) => boss.battle && !boss.decks.some((deck) => deck.squad)).length;
    if (noBattle > 0 && noDeck > 0) return `有 ${noBattle} 個王沒設屬性、${noDeck} 個王沒排隊伍。`;
    if (noBattle > 0) return `有 ${noBattle} 個王還沒設屬性 — 在王的「屬性」下拉選單選一個。`;
    if (noDeck > 0) return `有 ${noDeck} 個王還沒排隊伍 — 點王底下的空格放入妮姬。`;
    return '沒有可執行的組合。';
  }

  function refreshRunGate(): void {
    if (!running) {
      const prior = searchMember.value;
      searchMember.replaceChildren();
      for (const member of members.filter(m => m.picked && m.state === 'public' && Object.keys(rosters.get(m.openid) ?? {}).length)) {
        const option = el('option', undefined, member.name); option.value = member.openid; searchMember.append(option);
      }
      if ([...searchMember.options].some(o => o.value === prior)) searchMember.value = prior;
      refreshExclusions();
      updatePoolNote();
    }
    searchStart.disabled = running || comparing || Boolean(deps.isExternalBusy?.()) || !searchMember.value || !bosses.some(b => b.enabled && b.battle);
    const jobs = buildJobs(members, bosses);
    const ready = jobs.length > 0 && !running && !comparing && !deps.isExternalBusy?.();
    runButton.disabled = !ready;
    // 자리는 명단이 들어온 뒤로 늘 보인다 — 모자란 것을 말해 주려면 보여야 한다.
    showStep('4', members.length > 0 || results.length > 0);
    if (!running) {
      const people = new Set(jobs.map((job) => job.member.openid)).size;
      runStatus.textContent = resultsInvalidated
        ? '編成或條件已變更，請重新執行模擬。'
        : jobs.length === 0
        ? (personal ? '要先填好王與隊伍才能執行。' : missingReason())
        : (personal
          ? t('보스·편성 {n}개를 계산합니다.', { n: jobs.length })
          : t('{people}명의 보스·편성 {n}개를 계산합니다.', { people, n: jobs.length }));
    }
  }

  let comparing = false;
  searchStop.addEventListener('click', () => { cancelled = true; });
  searchStart.addEventListener('click', () => { void runSearch(); });
  async function runSearch(): Promise<void> {
    if (running || comparing || deps.isExternalBusy?.()) return;
    if (personal) { loadMe(); renderMembers(); }
    const member = members.find(m => m.openid === searchMember.value);
    if (!member) { searchStatus.textContent = '請先匯入有持有角色資料的帳號。'; return; }
    const budget = Number(searchBudget.value);
    if (!Number.isInteger(budget) || budget < 10 || budget > 300) { searchStatus.textContent = '每王盤數請輸入 10–300 的整數。'; return; }
    const roster = structuredClone(rosters.get(member.openid) ?? {});
    const pool = ownedSSR(deps.catalog, deps.settings, roster, [...searchExclude.selectedOptions].map(o => o.value));
    if (pool.length < 5) { searchStatus.textContent = `可用 SSR 僅 ${pool.length} 位，至少需要 5 位。`; return; }
    const targets = bosses.map((boss, index) => ({ boss: structuredClone(boss), index }))
      .filter(({ boss, index }) => boss.enabled && boss.battle && member.bossPicks?.[index] !== false);
    if (!targets.length) { searchStatus.textContent = '此帳號沒有啟用的王。'; return; }
    // A new search must not recommend an old candidate containing an excluded/non-SSR unit.
    const eligible = new Set(pool.map(c => c.name));
    results = results.filter(row => row.job.member.openid !== member.openid || row.job.squad.every(name => eligible.has(name)));
    for (const row of [...planSelections]) if (!results.includes(row)) planSelections.delete(row);
    const accountState = () => JSON.stringify([members.find(m => m.openid === member.openid), rosters.get(member.openid), consoles.get(member.openid)]);
    const accountSnapshot = accountState();
    const memberSnapshot = structuredClone(member);
    const consoleSnapshot = structuredClone(consoles.get(member.openid));
    running = true; cancelled = false; resultsInvalidated = false; resultBoard = boardState();
    searchStart.disabled = true; runButton.disabled = true; searchStop.hidden = false;
    searchMember.disabled = searchBudget.disabled = searchExclude.disabled = true;
    const current = () => !resultsInvalidated && resultBoard === boardState() && accountSnapshot === accountState();
    let completed = 0, failures = 0;
    const selectBest = () => {
      for (const row of [...planSelections]) if (row.job.member.openid === member.openid) planSelections.delete(row);
      for (const row of bestThreeShots(results.filter(r => r.job.member.openid === member.openid))) planSelections.add(row);
    };
    try {
      for (const { boss, index } of targets) {
        if (cancelled || !current()) break;
        const base = completed, priorFailures = failures;
        await searchSquads({ pool, budget, element: boss.battle!.enemyCode,
          seeds: boss.decks.filter(d => d.squad?.filter(Boolean).length === 5).map(d => ({ squad: d.squad!, noBurst: d.noBurst, burstSequence: d.burstSequence, cycle: d.cycle, cubes: d.cubes })),
          stopped: () => cancelled || !current(),
          evaluate: async candidate => {
            const { deck, missing } = deckForMember(candidate.squad, roster);
            if (missing.length) throw new Error('缺少持有資料');
            applyUnionBurst(deck, candidate.burstSequence, deps.catalog, candidate.noBurst);
            applyUnionCubes(deck, candidate.cubes, deps.settings);
            const battle = { ...boss.battle!, ...candidate.cycle, ...(candidate.cycle ? { burstRegenPerDeck: undefined } : {}), synchroLevel: memberSnapshot.synchro > 0 ? memberSnapshot.synchro : boss.battle!.synchroLevel,
              console: consoleSnapshot ?? boss.battle!.console };
            const request = requestForDeck(deck, battle);
            const result = await deps.simulate(request);
            if (!current()) throw new Error('搜尋條件已變更');
            if (!Number.isFinite(result.squadTotal) || result.squadTotal < 0) throw new Error('無效模擬結果');
            const job: Job = { member: memberSnapshot, bossIndex: index, bossName: boss.name || `王 ${index + 1}`,
              deckIndex: 3 + completed, battle, ...candidate };
            results.push({ job, damage: result.squadTotal, detail: { deckId: 1, request, result } });
            return result.squadTotal;
          },
          progress: (done, failed) => {
            completed = base + done; failures = priorFailures + failed;
            searchStatus.textContent = `${memberSnapshot.name} · ${boss.name || `王 ${index + 1}`} · 已測 ${completed}/${targets.length * budget} 盤 · 失敗 ${failures} · SSR 池 ${pool.length} 位`;
            if (completed % 10 === 0 && current()) { selectBest(); renderReport(); }
          },
        });
      }
      if (!current()) {
        results = []; raidPlan = undefined; planSelections.clear();
        searchStatus.textContent = '帳號或條件已變更，舊搜尋結果已作廢，請重新搜尋。';
      } else {
        selectBest();
        const best = bestThreeShots(results.filter(r => r.job.member.openid === member.openid));
        searchStatus.textContent = `${cancelled ? '已停止，保留完成結果' : '本輪搜尋完成'} · 已測 ${completed} 盤，失敗 ${failures} · 找到 ${best.length}/3 刀，合計 ${DAMAGE.format(Math.round(best.reduce((sum, r) => sum + r.damage!, 0)))}。`
          + (best.length < 3 ? '尚未找到三隊不重複候選；不代表帳號沒有三刀。可增加盤數或加入不同的種子隊伍。' : '已勾選本輪候選中的最佳三刀；不保證全域最優。');
      }
    } catch (error) {
      searchStatus.textContent = `搜尋中斷：${error instanceof Error ? error.message : String(error)}；已完成結果保留。`;
    } finally {
      running = false; searchStop.hidden = true;
      searchMember.disabled = searchBudget.disabled = searchExclude.disabled = false;
      renderReport(); refreshRunGate();
    }
  }
  const runAll = async () => {
    if (comparing || deps.isExternalBusy?.()) return;
    // 개인용은 돌리기 직전에 내 스펙을 다시 읽는다 — 그 사이 싱크로나 로스터를
    // 바꿨을 수 있고, 그때 화면에 적힌 값과 계산이 어긋나면 안 된다.
    if (personal) { loadMe(); renderMembers(); }
    const jobs = buildJobs(members, bosses);
    if (jobs.length === 0 || running) return;
    running = true;
    cancelled = false;
    runButton.disabled = true;
    runStop.hidden = false;
    results = [];
    raidPlan = undefined;
    raidPlannerWorker?.terminate(); raidPlannerWorker = undefined;
    resultsInvalidated = false;
    resultBoard = boardState();
    renderReport();
    const started = Date.now();
    let done = 0;
    const runJob = async (job: Job) => {
      const roster = rosters.get(job.member.openid) ?? {};
      const { deck, missing } = deckForMember(job.squad, roster, personal && !hasMyRoster());
      if (missing.length > 0) {
        if (!resultsInvalidated) results.push({ job, missing });
      } else {
        try {
          const battle: BattleSettings = {
            ...job.battle,
            // 싱크로와 콘솔은 **그 사람 것**을 쓴다 — 400 고정이 아니다.
            synchroLevel: job.member.synchro > 0 ? job.member.synchro : job.battle.synchroLevel,
            console: consoles.get(job.member.openid) ?? job.battle.console,
          };
          applyUnionBurst(deck, job.burstSequence, deps.catalog, job.noBurst);
          applyUnionCubes(deck, job.cubes, deps.settings);
          const request = requestForDeck(deck, battle);
          const result = await deps.simulate(request);
          if (!resultsInvalidated && resultBoard === boardState()) results.push({ job, damage: result.squadTotal, detail: { deckId: job.deckIndex + 1, request, result } });
        } catch (error) {
          if (!resultsInvalidated) results.push({ job, error: lastLine(error instanceof Error ? error.message : String(error)) });
        }
      }
      done += 1;
      setBar(runBar, done, jobs.length);
      runStatus.textContent = `${done}/${jobs.length} · ${job.member.name} · ${job.bossName} `
        + `· 남은 시간 약 ${humanSeconds(remainingSeconds(done, jobs.length, Date.now() - started))}`;
      renderReport();     // 도착 순서와 무관하게 사람→보스→덱으로 다시 세운다
    };
    // 판마다 서로 독립이라 나눠 돌려도 결과가 같다. 여기가 병렬로 가장 크게 덕을 보는
    // 자리다 — 유니온원 × 보스 × 덱이라 수십 판이 쌓인다.
    const lanes = Math.max(1, Math.trunc(deps.concurrency?.() ?? 1));
    const queue = [...jobs];
    const lane = async () => {
      while (queue.length > 0 && !cancelled) await runJob(queue.shift()!);
    };
    await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
    running = false;
    runStop.hidden = true;
    renderReport(); // Re-enable planning controls now that every lane has finished.
    runButton.disabled = false;
    // 문지기가 «몇 판을 돌립니다»로 되돌리기 전에 부르고, 마무리 문구를 마지막에 적는다.
    refreshRunGate();
    runStatus.textContent = resultsInvalidated
      ? '編成或條件已變更，舊模擬已作廢，請重新執行。'
      : cancelled
      ? t('중단했습니다 ({done}/{n}판).', { done: results.length, n: jobs.length })
      : t('{n}판 완료 · {seconds}초', { n: jobs.length, seconds: Math.round((Date.now() - started) / 1000) });
  };

  runButton.addEventListener('click', () => { void runAll(); });
  runStop.addEventListener('click', () => { cancelled = true; });

  const yi = (value: number): string => `${(value / 100_000_000).toLocaleString('zh-TW', {
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  })} 億`;

  const planCsv = (plan: RaidPlannerPlan): string => {
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [['順序', '成員', '同步器', '階段', 'Boss', '隊伍', '角色', '模擬傷害', '有效傷害', '打完剩餘']];
    let order = 0;
    for (const bar of plan.bars) for (const shot of bar.shots) rows.push([
      String(++order), shot.memberName, String(shot.synchro), shot.phase === 3 ? '無限' : String(shot.phase + 1),
      shot.bossName, String(shot.deckIndex + 1), shot.squad.map(deps.labelOf).join('／'),
      String(Math.round(shot.damage)), String(Math.round(shot.effectiveDamage)),
      shot.remainingAfter === null ? '' : String(Math.round(shot.remainingAfter)),
    ]);
    return `\ufeff${rows.map(row => row.map(quote).join(',')).join('\r\n')}`;
  };

  function renderRaidPlanner(): void {
    raidPlannerBox.replaceChildren();
    if (results.length === 0) return;
    if (running) {
      raidPlannerBox.append(el('p', 'field-note', '全部模擬完成後即可依三階段血量排出全聯盟出刀順序。'));
      return;
    }
    const card = el('section', 'union-plan-card');
    card.append(el('h4', undefined, '全聯盟最優出刀'));
    card.append(el('p', 'field-note', '使用目前所有有效模擬結果；每位成員最多三刀且角色不得重複。擊殺溢傷不跨血條，五王全清才進下一階段，第三階段全清後剩餘刀投入無限五王。血量單位為億。'));

    const health = el('table', 'union-plan-health');
    const head = el('tr');
    for (const label of ['階段', ...bosses.map((boss, index) => boss.name.trim() || `Boss ${index + 1}`)]) head.append(el('th', undefined, label));
    health.append(head);
    raidHealth.forEach((phase, phaseIndex) => {
      const row = el('tr'); row.append(el('th', undefined, `第 ${phaseIndex + 1} 階段`));
      phase.forEach((value, bossIndex) => {
        const td = el('td'); const input = el('input'); input.type = 'number'; input.min = '0.01'; input.step = '0.01';
        input.value = String(value); input.ariaLabel = `第 ${phaseIndex + 1} 階段 Boss ${bossIndex + 1} 血量（億）`;
        input.addEventListener('change', () => {
          const next = Number(input.value);
          if (!Number.isFinite(next) || next <= 0) { input.value = String(raidHealth[phaseIndex]![bossIndex]); return; }
          raidHealth[phaseIndex]![bossIndex] = next; raidPlan = undefined;
          try { localStorage.setItem(raidHealthKey, JSON.stringify(raidHealth)); } catch { /* Optional preference. */ }
        });
        td.append(input); row.append(td);
      });
      health.append(row);
    });
    card.append(health);

    const actions = el('div', 'union-plan-actions');
    const solve = el('button', 'roster-import union-run', '計算全聯盟最優出刀'); solve.type = 'button';
    const stop = el('button', 'roster-import', '停止排刀'); stop.type = 'button'; stop.hidden = true;
    const exportResults = el('button', 'roster-import', '匯出試算結果'); exportResults.type = 'button';
    exportResults.title = '存成 JSON 檔，供「實戰推演」分頁匯入，現場邊打邊重算用。';
    const status = el('span', 'union-status'); status.setAttribute('aria-live', 'polite');
    actions.append(solve, stop, exportResults, status); card.append(actions);
    stop.addEventListener('click', () => {
      raidPlannerWorker?.terminate(); raidPlannerWorker = undefined;
      stop.hidden = true; solve.disabled = false; status.textContent = '已停止排刀。';
    });
    exportResults.addEventListener('click', () => {
      const candidates = plannerCandidates(results);
      if (!candidates.length) { status.textContent = '沒有成功完成的五人模擬結果。'; return; }
      const input: RaidPlannerInput = { phases: raidHealth.map(phase => phase.map(value => value * 100_000_000)), candidates };
      const url = URL.createObjectURL(new Blob([JSON.stringify(input)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `聯盟戰試算結果_${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    solve.addEventListener('click', () => {
      if (raidPlannerWorker) return;
      const candidates = plannerCandidates(results);
      if (!candidates.length) { status.textContent = '沒有成功完成的五人模擬結果。'; return; }
      solve.disabled = true; stop.hidden = false; status.textContent = '正在載入最佳化解算器…'; raidPlan = undefined;
      const worker = new Worker(new URL('./union-planner.worker.ts', import.meta.url), { type: 'module' });
      raidPlannerWorker = worker;
      worker.addEventListener('message', (event: MessageEvent<{ kind: string; message?: string; plan?: RaidPlannerPlan }>) => {
        if (worker !== raidPlannerWorker) return;
        if (event.data.kind === 'progress') { status.textContent = event.data.message ?? ''; return; }
        worker.terminate(); raidPlannerWorker = undefined;
        if (event.data.kind === 'done' && event.data.plan) {
          raidPlan = event.data.plan; renderRaidPlanner();
        } else {
          stop.hidden = true; solve.disabled = false; status.textContent = `排刀失敗：${event.data.message ?? '未知錯誤'}`;
        }
      });
      worker.addEventListener('error', (event) => {
        if (worker !== raidPlannerWorker) return;
        worker.terminate(); raidPlannerWorker = undefined;
        stop.hidden = true; solve.disabled = false; status.textContent = `排刀失敗：${event.message}`;
      });
      worker.postMessage({ phases: raidHealth.map(phase => phase.map(value => value * 100_000_000)), candidates });
    });

    if (raidPlan) {
      const plan = raidPlan;
      const attempted = new Map(results.map(row => [row.job.member.openid, row.job.member.name]));
      const available = new Set(plan.members.map(member => member.memberId));
      const unavailable = [...attempted].filter(([id]) => !available.has(id)).map(([, name]) => name);
      const short = plan.members.filter(member => member.capacity < 3);
      const reach = { phase1: '第 1 階段', phase2: '第 2 階段', phase3: '第 3 階段', endless: '無限五王' }[plan.reached];
      const summary = el('div', 'union-plan-summary');
      for (const [label, value] of [
        ['可用成員', `${plan.candidateMembers}/${attempted.size}`],
        ['有效刀數上限', `${plan.attackCapacity}/96`],
        ['本方案安排', `${plan.plannedAttacks} 刀`],
        ['推進位置', reach],
      ]) {
        const box = el('div', 'union-plan-kpi'); box.append(el('span', undefined, label), el('b', undefined, value)); summary.append(box);
      }
      card.append(summary);
      card.append(el('p', 'field-note', plan.provenOptimal
        ? `HiGHS 已證明此候選範圍內為最優解。有限血條有效傷害 ${yi(plan.effectiveFiniteDamage)}${plan.endlessDamage ? `；無限五王 ${yi(plan.endlessDamage)}` : ''}。`
        : `解算器達到時間限制，以下是目前最佳可行解，尚未證明全域最優。有限血條有效傷害 ${yi(plan.effectiveFiniteDamage)}。`));
      if (unavailable.length) card.append(el('p', 'union-error', `沒有有效模擬結果，未納入：${unavailable.join('、')}`));
      if (short.length) card.append(el('p', 'union-error', `有效互斥隊伍不足三刀：${short.map(member => `${member.memberName}（${member.capacity}）`).join('、')}`));

      const maxPhase = plan.reached === 'endless' ? 3 : Number(plan.reached.at(-1)) - 1;
      for (let phase = 0; phase <= maxPhase; phase++) {
        const section = el('section', 'union-plan-phase');
        section.append(el('h5', undefined, phase === 3 ? '無限階段・Boss 5' : `第 ${phase + 1} 階段`));
        for (const bar of plan.bars.filter(item => item.phase === phase)) {
          const block = el('div', `union-plan-bar${bar.cleared ? ' is-clear' : ''}`);
          const bossName = bosses[bar.bossIndex]?.name.trim() || `Boss ${bar.bossIndex + 1}`;
          block.append(el('p', undefined, phase === 3
            ? `${bossName}｜${bar.shots.length} 刀｜總傷害 ${yi(bar.rawDamage)}`
            : `${bossName}｜血量 ${yi(bar.hp!)}｜${bar.shots.length} 刀｜${bar.cleared ? `擊殺，溢傷 ${yi(Math.max(0, bar.rawDamage - bar.hp!))}` : `剩餘 ${yi(bar.remaining!)}`}`));
          bar.shots.forEach((shot, index) => {
            const line = el('div', 'union-plan-shot');
            line.append(el('code', undefined, String(index + 1)), el('b', undefined, shot.memberName),
              el('span', undefined, `第 ${shot.deckIndex + 1} 隊${shot.deckLabel ? `「${shot.deckLabel}」` : ''}｜${shot.squad.map(deps.labelOf).join('／')}`),
              el('span', undefined, yi(shot.damage)),
              el('span', undefined, shot.remainingAfter === null ? '無限' : `剩 ${yi(shot.remainingAfter)}`));
            block.append(line);
          });
          section.append(block);
        }
        card.append(section);
      }

      const membersBox = el('details', 'union-plan-members');
      membersBox.append(el('summary', undefined, '依成員查看三刀'));
      const table = el('table'); const tr = el('tr');
      for (const label of ['成員', '容量', '第 1 刀', '第 2 刀', '第 3 刀']) tr.append(el('th', undefined, label));
      table.append(tr);
      for (const member of plan.members) {
        const row = el('tr'); row.append(el('th', undefined, member.memberName), el('td', undefined, String(member.capacity)));
        for (let index = 0; index < 3; index++) {
          const shot = member.shots[index];
          row.append(el('td', undefined, shot ? `${shot.phase === 3 ? '無限' : `P${shot.phase + 1}`}・B${shot.bossIndex + 1}・${shot.deckLabel ?? `T${shot.deckIndex + 1}`}（${yi(shot.damage)}）` : '—'));
        }
        table.append(row);
      }
      membersBox.append(table); card.append(membersBox);
      const save = el('button', 'roster-import', '下載最優出刀 CSV'); save.type = 'button';
      save.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([planCsv(plan)], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url;
        link.download = `聯盟戰最優出刀_${new Date().toISOString().slice(0, 10)}.csv`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
      card.append(save);
    }
    raidPlannerBox.append(card);
  }

  /**
   * 배정표 — 공회가 실제로 보는 모양. 줄이 사람, 칸이 보스다.
   *
   * 아래의 «사람 한 장씩» 보고서는 그대로 둔다. 표는 «누구를 어디에 넣나»를 정하는
   * 자리이고, 카드는 «왜 그 숫자인가»(어느 덱, 무엇이 없어서 못 치나)를 보는 자리다.
   */
  function renderGrid(): void {
    gridBox.replaceChildren();
    if (results.length === 0) return;
    const grid = buildGrid(results, bosses);
    if (grid.bosses.length === 0) return;

    const head = el('div', 'union-grid-head');
    head.append(el('h4', undefined, '分配表'));
    const save = el('button', 'roster-import', '下載 Excel (CSV)');
    (save as HTMLButtonElement).type = 'button';
    save.title = '下載後可直接用 Excel 開啟,或貼進現有的分配表';
    save.addEventListener('click', () => {
      const blob = new Blob([gridToCsv(grid)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const day = new Date().toISOString().slice(0, 10);
      link.download = `聯盟突襲分配表_${day}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    head.append(save);
    gridBox.append(head);

    const table = document.createElement('table');
    table.className = 'union-grid';
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const label of ['名稱', '同步器', ...grid.bosses.map((boss) => boss.name)]) {
      const th = document.createElement('th');
      th.textContent = label;
      hrow.append(th);
    }
    thead.append(hrow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of grid.rows) {
      const tr = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = row.member.name;
      tr.append(name);
      const sync = document.createElement('td');
      sync.className = 'union-grid-sync';
      sync.textContent = row.member.synchro ? String(row.member.synchro) : '';
      tr.append(sync);
      for (const boss of grid.bosses) {
        const td = document.createElement('td');
        const cell = row.cells.get(boss.index);
        if (!cell) {
          // 안 맡긴 보스. 배정표의 빈칸과 같은 뜻이라 비워 둔다.
          td.className = 'union-grid-off';
        } else if (cell.damage !== undefined) {
          td.className = 'union-grid-num';
          td.textContent = DAMAGE.format(Math.round(cell.damage));
        } else {
          td.className = 'union-grid-miss';
          td.textContent = cell.note ?? '—';
          td.title = cell.note ?? '';
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    gridBox.append(table);
  }

  function renderBossOutcomes(): void {
    for (const output of bossBox.querySelectorAll<HTMLElement>('[data-boss-outcome]')) {
      const rows = results.filter(row => row.job.bossIndex === Number(output.dataset.bossOutcome));
      const damages = rows.flatMap(row => row.damage !== undefined ? [row.damage] : []);
      output.textContent = damages.length ? t('최고 피해 {damage} · {n}개 결과', {
        damage: DAMAGE.format(Math.round(Math.max(...damages))), n: damages.length,
      }) : t('계산 결과 없음');
    }
    for (const output of bossBox.querySelectorAll<HTMLElement>('[data-deck-outcome]')) {
      const [bossIndex, deckIndex] = output.dataset.deckOutcome!.split('-').map(Number);
      const rows = results.filter(row => row.job.bossIndex === bossIndex && row.job.deckIndex === deckIndex);
      const damages = rows.flatMap(row => row.damage !== undefined ? [row.damage] : []);
      output.textContent = damages.length ? t('최고 피해 {damage} · {n}개 결과', {
        damage: DAMAGE.format(Math.round(Math.max(...damages))), n: damages.length,
      }) : rows.length ? t('계산 실패 · 아래 결과에서 원인을 확인하세요') : t('계산 결과 없음');
    }
  }

  function renderReport(): void {
    renderGrid();
    renderRaidPlanner();
    renderBossOutcomes();
    reportBox.replaceChildren();
    for (const report of groupResults(results)) {
      const card = el('div', 'union-report-card');
      const head = el('div', 'union-report-head');
      head.append(el('b', 'union-report-name', report.member.name),
        el('span', 'union-report-sync', `싱크로 ${report.member.synchro}`));
      card.append(head);
      const selected = new Map<JobResult, HTMLInputElement>();
      const plan = el('p', 'union-status', '三刀規劃：勾選最多 3 隊，檢查角色重複並合計傷害。');
      card.append(plan);
      const optimize = el('button', 'roster-import', '自動選擇最佳三刀'); optimize.type = 'button';
      optimize.disabled = running;
      const scope = el('p', 'field-note', '從此帳號已完成的五人候選隊伍，跨王精確挑選最多三刀、角色不得重複，以总傷害最大為準；可用上方「自動生成 SSR 隊伍」新增候選，不估算王血量、轉階段或出刀先後。');
      optimize.addEventListener('click', () => {
        if (running) return;
        const best = new Set(bestThreeShots(report.bosses.flatMap(boss => boss.rows)));
        for (const [row, checkbox] of selected) {
          checkbox.checked = best.has(row);
          if (checkbox.checked) planSelections.add(row); else planSelections.delete(row);
        }
        updatePlan();
        plan.append(best.size === 0 ? ' · 沒有可用的完整五人結果。'
          : best.size < 3 ? ' · 最佳方案不足三刀：新增不重複候選後可再搜尋。' : ' · 已選取候選中的最高總傷害方案。');
      });
      card.append(optimize, scope);
      const updatePlan = () => {
        const chosen = [...selected].filter(([, checkbox]) => checkbox.checked).map(([row]) => row);
        const names = chosen.flatMap(row => row.job.squad.filter(Boolean));
        const repeated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
        plan.textContent = repeated.length
          ? `角色重複，無法作為三刀編成：${repeated.map(deps.labelOf).join('、')}`
          : `已選 ${chosen.length}/3 刀 · 合計 ${DAMAGE.format(Math.round(chosen.reduce((sum, row) => sum + (row.damage ?? 0), 0)))}`;
      };
      for (const boss of report.bosses) {
        card.append(el('h4', 'union-report-boss', boss.name));
        for (const row of boss.rows) {
          const line = el('div', 'union-report-row');
          line.append(squadPreview([row.job.squad.filter(Boolean)], deps.imageOf, deps.labelOf));
          if (row.job.noBurst?.length) line.append(el('span', 'field-note', `禁止爆裂：${row.job.noBurst.map(deps.labelOf).join('、')}`));
          if (row.damage !== undefined) {
            line.append(el('b', 'union-report-damage', DAMAGE.format(Math.round(row.damage))));
            const choose = el('input'); choose.type = 'checkbox'; choose.ariaLabel = `納入三刀：${boss.name} 第 ${row.job.deckIndex + 1} 隊`;
            choose.checked = planSelections.has(row);
            selected.set(row, choose);
            choose.addEventListener('change', () => {
              if ([...selected.values()].filter(input => input.checked).length > 3) choose.checked = false;
              if (choose.checked) planSelections.add(row); else planSelections.delete(row);
              updatePlan();
            });
            line.append(choose);
          } else if (row.missing) {
            line.append(el('span', 'union-report-skip', `미보유 · ${row.missing.join(', ')}`));
          } else {
            line.append(el('span', 'union-report-skip', row.error ?? '계산 실패'));
          }
          card.append(line);
          if (row.detail) {
            const detail = el('details', 'union-deck-code');
            detail.append(el('summary', undefined, `第 ${row.job.deckIndex + 1} 隊傷害明細與時間軸`));
            const table = el('table');
            const header = el('tr');
            for (const label of ['角色', '總傷害', '普攻', '技能', '命中次數']) header.append(el('th', undefined, label));
            table.append(header);
            for (const name of row.job.squad.filter(Boolean)) {
              const values = row.detail.result.charBreakdown?.[name];
              const tr = el('tr');
              for (const value of [deps.labelOf(name), DAMAGE.format(Math.round(row.detail.result.charTotals[name] ?? 0)),
                values ? DAMAGE.format(Math.round(values.normal)) : '—', values ? DAMAGE.format(Math.round(values.skill)) : '—',
                values ? String(values.normalHits + values.skillHits) : '—']) tr.append(el('td', undefined, value));
              table.append(tr);
            }
            detail.append(table);
            detail.append(createBattleAnalysis({ request: row.detail.request, settings: deps.settings, labelOf: deps.labelOf,
              simulate: deps.simulate, isBusy: () => running || comparing || Boolean(deps.isExternalBusy?.()),
              setBusy: busy => { comparing = busy; refreshRunGate(); },
            }));
            const compare = el('details', 'union-deck-code');
            compare.append(el('summary', undefined, '換人／B3 站位順序比較'));
            const position = el('select'); position.ariaLabel = '換人位置';
            row.job.squad.forEach((name, index) => {
              const option = el('option', undefined, `第 ${index + 1} 格 ${deps.labelOf(name)}`); option.value = String(index); position.append(option);
            });
            const replace = el('button', 'roster-import', '比較同爆裂階段的持有角色'); replace.type = 'button';
            const order = el('button', 'roster-import', '比較 B3 站位排列'); order.type = 'button';
            const stop = el('button', 'roster-import', '停止比較'); stop.type = 'button'; stop.hidden = true;
            const output = el('div');
            let stopped = false;
            stop.addEventListener('click', () => { stopped = true; });
            const evaluate = async (squads: string[][]) => {
              if (running || comparing || deps.isExternalBusy?.()) { output.textContent = '請等目前模擬或比較完成。'; return; }
              comparing = true;
              runButton.disabled = true;
              replace.disabled = true; order.disabled = true; stop.hidden = false; stopped = false;
              output.replaceChildren();
              const progress = el('p'); output.append(progress);
              const ranked: { squad: string[]; damage: number }[] = [];
              let failures = 0;
              for (const squad of squads) {
                if (stopped || !compare.isConnected) break;
                const candidate = deckForMember(squad, rosters.get(row.job.member.openid) ?? {}, personal && !hasMyRoster());
                if (candidate.missing.length) continue;
                try {
                  applyUnionBurst(candidate.deck, row.job.burstSequence, deps.catalog, row.job.noBurst);
                  applyUnionCubes(candidate.deck, row.job.cubes, deps.settings);
                  const request = normalizeRequest({ ...row.detail!.request, squad: candidate.deck.squad, characters: candidate.deck.characters,
                    burstSequence: candidate.deck.burstSequence, strictNoBurst: candidate.deck.strictNoBurst });
                  const result = await deps.simulate(request);
                  ranked.push({ squad, damage: result.squadTotal });
                } catch { failures += 1; }
                progress.textContent = `已完成 ${ranked.length + failures}/${squads.length} · 失敗 ${failures}`;
              }
              ranked.sort((a, b) => b.damage - a.damage);
              for (const entry of ranked) {
                output.append(el('p', undefined, `${entry.squad.map(deps.labelOf).join(' → ')}：${DAMAGE.format(Math.round(entry.damage))}（差 ${DAMAGE.format(Math.round(entry.damage - row.damage!))}）`));
              }
              if (stopped) progress.append(' · 已停止');
              replace.disabled = false; order.disabled = false; stop.hidden = true;
              comparing = false;
              refreshRunGate();
            };
            replace.addEventListener('click', () => {
              const at = Number(position.value);
              const stage = deps.catalog.find(char => char.name === row.job.squad[at])?.burstStage;
              const roster = rosters.get(row.job.member.openid) ?? {};
              const candidates = deps.catalog.filter(char => char.burstStage === stage && !row.job.squad.includes(char.name)
                && (roster[char.name] || (personal && !hasMyRoster())));
              void evaluate([row.job.squad, ...candidates.map(char => row.job.squad.map((name, index) => index === at ? char.name : name))]);
            });
            order.addEventListener('click', () => {
              const indices = row.job.squad.map((name, index) => deps.catalog.find(char => char.name === name)?.burstStage === '3' ? index : -1).filter(index => index >= 0);
              const permutations = (values: string[]): string[][] => values.length < 2 ? [values] : values.flatMap((name, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [name, ...rest]));
              void evaluate(permutations(indices.map(index => row.job.squad[index]!)).map(names => {
                const squad = [...row.job.squad]; indices.forEach((index, at) => { squad[index] = names[at]!; }); return squad;
              }));
            });
            compare.append(el('p', 'field-note', '使用這筆結果的帳號、王條件與逐輪爆裂設定。B3 比較只改站位；已指定的爆裂角色不變。換人時移除離隊角色的指定，改用該階段自動候選。'), position, replace, order, stop, output);
            detail.append(compare);
            detail.addEventListener('toggle', () => {
              if (!detail.open || detail.querySelector('.timeline-block')) return;
              const names = row.job.squad.filter(Boolean);
              const timeline = createTimelineBlock(row.detail!,
                Object.fromEntries(names.map(name => [name, deps.imageOf(name) ?? ''])),
                Object.fromEntries(names.map(name => [name, deps.labelOf(name)])));
              if (timeline) detail.append(timeline);
            });
            card.append(detail);
          }
        }
      }
      if ([...selected.values()].some(checkbox => checkbox.checked)) updatePlan();
      reportBox.append(card);
    }
  }

  for (const button of modeButtons) {
    button.addEventListener('click', () => setMode(button.dataset.unionMode === 'personal'));
  }

  const { seed, blankBoard } = defaultDeckDecision(restoredDraft, bosses);
  if (seed) {
    // 불러온 판이나 저장된 판의 편성은 건드리지 않는다 — 위 조건이 이미 걸러 준다.
    // 명단에 없는 니케는 `readDeckCode`가 조용히 빼고 나머지만 채운다.
    const names = deps.catalogNames();
    bosses = bosses.map((boss, index) => {
      const preset = UNION_BOSS_SEASONS[0]!.bosses[index]!;
      const squads = defaultUnionDecks(preset);
      // 보스 설정은 **빈 판일 때만** 얹는다. 편성만 비었을 때 덮어쓰면 손봐 둔
      // 전투 조건이 조용히 날아간다.
      const withPreset = blankBoard ? applyPreset(boss, preset) : boss;
      if (squads.length === 0) return withPreset;
      return {
        ...withPreset,
        decks: withPreset.decks.map((deck, slot) => {
          const squad = squads[slot];
          if (!squad) return deck;
          return readDeckCode({
            ...deck,
            code: encodeShareCode([{ id: 1, squad: [...squad], characters: {} }], false),
          }, names);
        }),
      };
    });
  }
  renderBosses();
  // 開起來就停在「聯盟」。匯出檔匯入不需要代理伺服器，所以沒設代理也一樣從這裡開始。
  setMode(false);

  return {
    busy() {
      return running || comparing;
    },
    refreshMe() {
      if (!personal) return;
      // 여기서 손으로 고쳐 둔 싱크로가 있으면 그것을 존중한다 — 계산기 값으로
      // 되돌리면 방금 적어 넣은 숫자가 탭을 옮길 때마다 지워진다.
      const edited = members[0]?.synchro;
      loadMe();
      const fresh = members[0];
      if (fresh && edited !== undefined && edited > 0 && edited !== lastLoadedSynchro) {
        fresh.synchro = edited;
      }
      lastLoadedSynchro = fresh?.synchro ?? lastLoadedSynchro;
      renderMembers();
    },
  };
}
