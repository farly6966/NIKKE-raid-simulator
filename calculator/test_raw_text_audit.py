"""원문 전수 대조 — 200명 전부를 `scraper/nikke_scraped.json`에 비춰 본다.

이 fork에서 실제로 딜을 갉아먹은 결함들은 전부 **조용한** 부류였다. 예외도 경고도 없이
조건만 안 맞거나, 값이 비어 있거나, 가리키는 이름이 없다. baseline은 그 편성을 안 돌면
초록불이고, 실측 제보가 아니면 드러날 길이 없다.

그래서 「편성을 돌려 본다」가 아니라 **원문과 파싱을 직접 맞춰 보는** 축을 세운다.
각 검사마다 그 검사가 실제로 잡았던 자리를 docstring에 남긴다 — 나중에 누가
이 검사를 느슨하게 만들고 싶어질 때 근거가 되도록.
"""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
RAW = json.loads((ROOT / "scraper/nikke_scraped.json").read_text(encoding="utf-8"))
PARSED = json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))
ROSTER = {n: e for n, e in PARSED.items() if isinstance(e, list) and n in RAW}


def _templates(name):
    entry = RAW.get(name) or {}
    out = [b.get("template", "") for b in entry.get("스킬", {}).values()]
    out += [s.get("template", "") for s in entry.get("애장품", {}).get("단계별", [])]
    return out


def _raw_block(name, effect):
    """그 효과가 나온 원문 블록(template + values)."""
    entry = RAW.get(name) or {}
    fav = effect.get("favorite")
    if fav:
        for stage in entry.get("애장품", {}).get("단계별", []):
            if stage.get("단계") == fav:
                return stage
        return None
    src = effect.get("source", "")
    if not src.startswith("스킬"):
        return None
    idx = int(src[2:]) - 1
    skills = list(entry.get("스킬", {}).values())
    return skills[idx] if 0 <= idx < len(skills) else None


def _columns(block):
    """원문 values 표를 열 단위로 뒤집는다 → [{level: abs(float)}, ...]"""
    vals = (block or {}).get("values") or {}
    if not vals:
        return []
    width = max(len(v) if isinstance(v, list) else 1 for v in vals.values())
    out = []
    for col in range(width):
        d = {}
        for lv, row in vals.items():
            cell = row[col] if isinstance(row, list) and col < len(row) else None
            if cell is None:
                break
            try:
                d[lv] = abs(float(cell))
            except (TypeError, ValueError):
                break
        else:
            out.append(d)
    return out


def _targets(effect):
    t = effect.get("target")
    return [str(x) for x in (t if isinstance(t, list) else [t]) if x]


class ValuesComeFromTheRawTableTest(unittest.TestCase):
    """모든 `values`는 원문 레벨표의 **어느 한 열과 정확히 일치**해야 한다.

    원문 `▼`는 파싱에서 음수로 뒤집히는 규약이므로 절대값으로 본다.
    """

    # 원문 수치에서 엔진 규약대로 **유도**한 값이라 열과 직접 안 맞는 자리들
    DERIVED = {
        "질/슈퍼 캅",                     # 재장전 속도 99.96% → 시간 1.00 × 0.0004
        "엑시아/인베이젼 재장전 고정",        # 재장전 속도 95% → 시간 2.00 × 0.05 = 0.1
        "엠마 : 택티컬 업/환경 조성 강화",    # 원문 「배율 100% 증가」를 동일 추가분으로 표현
    }

    def test_every_values_block_matches_a_column(self):
        bad = []
        checked = 0
        for name, effects in ROSTER.items():
            for effect in effects:
                vals = effect.get("values")
                if not isinstance(vals, dict) or not vals:
                    continue
                cols = _columns(_raw_block(name, effect))
                if not cols:
                    continue
                checked += 1
                mine = {k: abs(float(v)) for k, v in vals.items()}
                if any(mine == c for c in cols):
                    continue
                key = f"{name}/{effect.get('name')}"
                if key in self.DERIVED:
                    continue
                bad.append(f"{key} lv10={mine.get('10')} "
                           f"원문열={[c.get('10') for c in cols]}")
        self.assertGreater(checked, 1000, "검사 대상이 갑자기 줄었다 — 대조가 안 붙고 있다")
        self.assertEqual(bad, [], f"원문 표의 어느 열과도 안 맞는 값: {bad}")


class NamesPointAtSomethingTest(unittest.TestCase):
    """이름을 가리키는 축이 **허공을 가리키면 안 된다**.

    이 fork에서 두 번 딜을 갉아먹은 부류다:
      목단 `self_state:무기 변경` — 데이터에 없는 이름 → 조건이 영원히 거짓(`2584f4d`)
      솔린 : 프로스트 티켓 `target_effect: 첫차 할인` — 지울 대상이 아예 없었다

    이름 풀은 **전역**이다 — 동료가 건 버프를 가리키는 것이 정상이기 때문이다
    (엠마 : 택티컬 업 ↔ 은화 : 택티컬 업의 `포메이션 LT`·`포메이션 AS`).
    """

    NAME_CONDS = ("self_state:", "not_self_state:", "target_state:", "ally_state:")
    NAME_FIELDS = ("remove_named_buff", "target_effect", "scaling_ref")

    @staticmethod
    def _names(effects):
        out = set()
        for e in effects:
            if e.get("name"):
                out.add(e["name"])
            stat = str(e.get("stat", ""))
            if ":" in stat:
                out.add(stat.split(":", 1)[1])
            for key in ("gauge_id", "stack_name", "scaling_ref"):
                if e.get(key):
                    out.add(str(e[key]))
        return out

    def test_no_reference_points_at_a_name_that_does_not_exist(self):
        known = set()
        for effects in PARSED.values():
            if isinstance(effects, list):
                known |= self._names(effects)
        dangling = []
        for name, effects in PARSED.items():
            if not isinstance(effects, list):
                continue
            for e in effects:
                trig = e.get("trigger") or {}
                for cond in trig.get("condition") or []:
                    for pre in self.NAME_CONDS:
                        if cond.startswith(pre) and cond[len(pre):] not in known:
                            dangling.append(f"{name}/{e.get('name')} cond {cond}")
                for tm in trig.get("timing") or []:
                    ref = None
                    if tm.startswith("event:state_end:"):
                        ref = tm[len("event:state_end:"):]
                    elif tm.startswith("event:"):
                        ref = tm[len("event:"):]
                    # 엔진이 쏘는 고정 이벤트명은 한글이 아니다
                    if ref and re.search(r"[가-힣]", ref) and ref not in known:
                        dangling.append(f"{name}/{e.get('name')} timing {tm}")
                for key in self.NAME_FIELDS:
                    ref = e.get(key)
                    if isinstance(ref, str) and ref and ref not in known:
                        dangling.append(f"{name}/{e.get('name')} {key}={ref}")
        self.assertEqual(dangling, [], f"허공을 가리키는 참조: {dangling}")


class RawConstantsSurviveParsingTest(unittest.TestCase):
    """원문 대괄호 안에 **박혀 있는 숫자**는 파싱 결과 어딘가에 남아야 한다.

    아니스 : 스타 `[차지 시간 0.7초로 고정]`의 `fixed_value` 누락이 이 부류였다 ——
    값이 없으면 `_fixed_charge_time()`이 base로 폴백해 **단축이 통째로 사라진다**.
    소다 : 트윙클링 바니의 `[10 / 20 / 30 중첩 이상]` → 9 / 19 / 29도 같은 그물에 걸린다.
    """

    IGNORE = {0.0, 1.0, 2.0, 3.0, 100.0, 200.0}   # 배율·판본·순번 표기
    # 엑시아는 `[재장전 속도 95% 증가 상태로 고정]`을 엔진 규약대로 환산해
    # `fixed_value: 0.1`(= 무기 2.00초 × (1 − 0.95))로 적는다 — 95는 남지 않는다.
    DERIVED = {"엑시아": {95.0}}

    @classmethod
    def _constants(cls, template):
        out = set()
        for seg in re.findall(r"\[([^\[\]]*)\]", template or ""):
            seg = re.sub(r"\{\d+\}", " ", seg)     # 레벨표 자리는 상수가 아니다
            for m in re.finditer(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", seg):
                v = float(m.group(1))
                if v not in cls.IGNORE:
                    out.add(v)
        return out

    @classmethod
    def _numbers(cls, obj, acc):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k != "values":                  # 레벨표는 상수가 아니다
                    cls._numbers(v, acc)
        elif isinstance(obj, list):
            for v in obj:
                cls._numbers(v, acc)
        elif isinstance(obj, bool):
            pass
        elif isinstance(obj, (int, float)):
            acc.add(abs(float(obj)))
        elif isinstance(obj, str):
            for m in re.finditer(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", obj):
                acc.add(float(m.group(1)))

    def test_no_constant_disappears(self):
        lost = []
        for name, effects in ROSTER.items():
            have = set()
            self._numbers(effects, have)
            want = set()
            for t in _templates(name):
                want |= self._constants(t)
            missing = sorted(v for v in want - self.DERIVED.get(name, set())
                             if v not in have)
            if missing:
                lost.append(f"{name}: {missing}")
        self.assertEqual(lost, [], f"원문 상수가 파싱에서 사라졌다: {lost}")


class CasterBasedStatsFollowTheTextTest(unittest.TestCase):
    """「시전자 기준」이 붙으면 stat도 caster_based 쪽이어야 한다.

    솔린 : 프로스트 티켓·드레이크 : 그레이트 빌런이 원문 `[시전자 기준 최대 체력만 …]`인데
    수령자 기준 `max_hp_only_pct`로 파싱돼 있었다. 기준이 다르면 아군이 **자기** 스탯의
    비율을 받는다. 거꾸로, 원문에 그 문구가 없는데 caster_based로 적은 자리도 잡는다
    (아니스 : 스타 `슈팅 스타4`가 그랬다 — 평범한 `[방어력 N% ▲]`인데 caster_based였다).
    """

    # (원문 문구들, caster 기준 stat, 수령자 기준 stat들)
    PAIRS = [
        (("시전자 기준 공격력", "시전자 공격력 비례"),
         "atk_caster_based_pct", {"atk_pct"}),
        (("시전자 기준 방어력", "시전자 방어력 비례"),
         "def_caster_based_pct", {"def_pct"}),
        (("시전자 기준 최대 체력만",),
         "hp_only_caster_based_pct", {"max_hp_only_pct"}),
        (("시전자 기준 차지 속도",),
         "charge_speed_caster_based_pct", {"charge_speed_pct"}),
    ]

    def test_stat_family_matches_the_phrase(self):
        wrong = []
        for name, effects in ROSTER.items():
            text = "\n".join(_templates(name))
            stats = [str(e.get("stat") or "") for e in effects]
            for phrases, caster_stat, receiver_stats in self.PAIRS:
                said = any(p in text for p in phrases)
                if said and caster_stat not in stats and any(s in receiver_stats for s in stats):
                    wrong.append(f"{name}: 원문 「{phrases[0]}」인데 수령자 기준으로만 파싱됨")
                if not said and caster_stat in stats:
                    wrong.append(f"{name}: 원문에 「{phrases[0]}」가 없는데 {caster_stat}")
        self.assertEqual(wrong, [], f"기준이 어긋난 자리: {wrong}")


class ExcludeSelfTargetsTest(unittest.TestCase):
    """「자신을 제외한 … 아군에게」는 excl_self 계열 대상이어야 한다.

    메이든 : 아이스 로즈 `블레스 유`가 포함판(`allies_code:`)이라, MP≥1 아군판과
    MP=0 자기판이 **배타 분기인데 자기가 양쪽을 다** 받았다.

    「자신을 제외한 … 아군이 있다면/없다면」은 **조건**이지 대상이 아니므로 뺀다
    (아니스 : 스타 `스타 폴`, 델타 : 닌자 시프 `인법 카모플라쥬`).
    """

    EXCL = ("all_allies_excl_self", "allies_code_excl_self:", "allies_weapon_excl_self:",
            "allies_lowest_hp_excl:", "allies_top_atk_excl:", "allies_down_top_atk_excl:",
            "allies_burst3_persona_excl_self", "allies_random")

    def test_clauses_that_exclude_self_use_an_excl_target(self):
        bad = []
        for name, effects in ROSTER.items():
            text = "\n".join(_templates(name))
            clauses = [c for c in re.split(r"■", text)
                       if "자신을 제외한" in c and "아군" in c
                       and not re.search(r"자신을 제외한[^\n]*아군이 (있|없)다면", c)]
            if not clauses:
                continue
            targets = [t for e in effects for t in _targets(e)]
            if not any(t.startswith(self.EXCL) for t in targets):
                bad.append(f"{name} ({len(clauses)}절)")
        self.assertEqual(bad, [], f"자신 제외 절이 있는데 excl 대상이 없다: {bad}")


class DurationsMatchTheTextTest(unittest.TestCase):
    """원문 `[N초 유지]`의 N은 그 캐릭터의 duration 어딘가에 있어야 한다."""

    def test_no_stated_duration_is_missing(self):
        bad = []
        for name, effects in ROSTER.items():
            text = "\n".join(_templates(name))
            want = {float(m.group(1))
                    for m in re.finditer(r"\[(\d+(?:\.\d+)?) ?초 ?유지\]", text)}
            have = {float(e["duration"]) for e in effects
                    if isinstance(e.get("duration"), (int, float))}
            missing = sorted(want - have)
            if missing:
                bad.append(f"{name}: {missing} (있는 것 {sorted(have)})")
        self.assertEqual(bad, [], f"원문이 말한 지속시간이 파싱에 없다: {bad}")


if __name__ == "__main__":
    unittest.main()
