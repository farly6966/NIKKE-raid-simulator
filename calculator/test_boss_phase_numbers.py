"""`boss_phases` 여섯 종의 **숫자를 못으로 박는다** — 통일 전후가 같아야 한다.

이 fork 고유의 `enemy["boss_phases"]`(평평한 시간 창)를 上游 `b67e366`의
`enemy["patterns"]` 스케줄러 위로 옮기는 작업의 **합격 기준**이다.

`calculator/test_union_boss_phases.py`가 이미 의미를 釘고 있지만(경계·겹침·이벤트
시각 게이팅·정적 동치), 그건 **성질**이지 숫자가 아니다. 구현을 갈아끼우면서
「의미는 같은데 값이 조금 달라졌다」를 잡으려면 값 자체를 박아 둬야 한다.

아래 숫자는 **통일 전 구현**에서 뽑았다(2026-09-19). 통일 뒤에도 한 자리도 달라지면
안 된다. 값이 바뀌어야 하는 이유가 생기면 그 이유를 여기 적고 함께 고친다 ——
`context/baseline`과 같은 규약이다.

편성·조건은 `test_union_boss_phases.py`와 같다(전격 적, 25초, 기대값).
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

NAMES = ["리타", "크라운", "레이븐", "앨리스"]
WEAPONS = ["AR", "SMG", "SG", "MG", "SR"]

# 라벨 → 적 설정
CASES: dict[str, dict] = {
    "없음": {},
    "코어 창": {"core_px": 1000, "boss_phases": [{"kind": "core", "from": 5, "to": 10}]},
    "코어 창 둘": {"core_px": 1000, "boss_phases": [
        {"kind": "core", "from": 2, "to": 6}, {"kind": "core", "from": 12, "to": 18}]},
    "적정거리 일부": {"boss_phases": [
        {"kind": "optimal_range", "from": 0, "to": 5, "weapons": WEAPONS}]},
    # 겹치면 **먼저 시작한 쪽이 이긴다**(종전 `_range_windows`의 `next()` 규약).
    "적정거리 겹침": {"boss_phases": [
        {"kind": "optimal_range", "from": 0, "to": 12, "weapons": ["SR"]},
        {"kind": "optimal_range", "from": 4, "to": 20, "weapons": WEAPONS}]},
    # 창 안에서는 **정적 목록과 합집합**이고, 창 밖에서는 정적 목록만 남는다.
    "적정거리 + 정적": {"optimal_range_weapons": ["SR"], "boss_phases": [
        {"kind": "optimal_range", "from": 3, "to": 9, "weapons": ["SG", "SMG"]}]},
    "관통 관문": {"boss_phases": [{"kind": "pierce_gate", "from": 0, "to": 12}]},
    "무적 일부": {"boss_phases": [{"kind": "immune", "from": 4, "to": 11}]},
    "속성 관문 일부": {"boss_phases": [{"kind": "element_gate", "from": 0, "to": 13}]},
    "부위 일부": {"boss_phases": [{"kind": "parts", "from": 2, "to": 9}]},
    # 겹쳐도 파츠 보너스는 한 번, 파괴 이벤트는 창마다 한 번씩.
    "부위 겹침": {"boss_phases": [
        {"kind": "parts", "from": 2, "to": 9}, {"kind": "parts", "from": 5, "to": 14}]},
    "부위 + 정적": {"has_parts": True, "boss_phases": [{"kind": "parts", "from": 2, "to": 9}]},
    "섞음": {"core_px": 600, "boss_phases": [
        {"kind": "core", "from": 3, "to": 11},
        {"kind": "parts", "from": 0, "to": 6},
        {"kind": "immune", "from": 13, "to": 15},
        {"kind": "optimal_range", "from": 8, "to": 20, "weapons": ["SR", "MG"]}]},
}

# 라벨 → (총딜, 히트 수, {캐릭터: 딜})
EXPECTED: dict[str, tuple[int, int, dict[str, int]]] = {
    '없음': (231047851, 1985, {
        '레이븐': 100412647,
        '리타': 40496453,
        '앨리스': 40588313,
        '크라운': 49550438,
    }),
    '코어 창': (252400611, 1985, {
        '레이븐': 103354769,
        '리타': 47505851,
        '앨리스': 43278813,
        '크라운': 58261178,
    }),
    '코어 창 둘': (265313971, 1985, {
        '레이븐': 105960764,
        '리타': 52175783,
        '앨리스': 44665872,
        '크라운': 62511552,
    }),
    '적정거리 일부': (234121026, 1985, {
        '레이븐': 100412647,
        '리타': 41837050,
        '앨리스': 41145763,
        '크라운': 50725566,
    }),
    '적정거리 겹침': (238455945, 1985, {
        '레이븐': 100412647,
        '리타': 42907625,
        '앨리스': 42940667,
        '크라운': 52195006,
    }),
    '적정거리 + 정적': (241690038, 1985, {
        '레이븐': 100412647,
        '리타': 43150132,
        '앨리스': 48576821,
        '크라운': 49550438,
    }),
    '관통 관문': (142904194, 1121, {
        '레이븐': 56023711,
        '리타': 20584108,
        '앨리스': 40588313,
        '크라운': 25708062,
    }),
    '무적 일부': (159997577, 1369, {
        '레이븐': 68864665,
        '리타': 25222117,
        '앨리스': 35354361,
        '크라운': 30556434,
    }),
    '속성 관문 일부': (222927460, 1946, {
        '레이븐': 100412647,
        '리타': 40496453,
        '앨리스': 32467922,
        '크라운': 49550438,
    }),
    '부위 일부': (231560407, 1985, {
        '레이븐': 100925203,
        '리타': 40496453,
        '앨리스': 40588313,
        '크라운': 49550438,
    }),
    '부위 겹침': (245583369, 1985, {
        '레이븐': 114948165,
        '리타': 40496453,
        '앨리스': 40588313,
        '크라운': 49550438,
    }),
    '부위 + 정적': (231560407, 1985, {
        '레이븐': 100925203,
        '리타': 40496453,
        '앨리스': 40588313,
        '크라운': 49550438,
    }),
    '섞음': (259079428, 1841, {
        '레이븐': 100951530,
        '리타': 48971327,
        '앨리스': 44613197,
        '크라운': 64543374,
    }),
}


class BossPhaseNumbersAreNailedDownTest(unittest.TestCase):
    def _run(self, enemy):
        squad = build_squad(NAMES)
        cfg = build_config(squad, {"duration": 25, "rng_mode": "expected"})
        return simulate(squad, config=cfg,
                        enemy={"code": "전격", "core_px": 0, **enemy}, verbose=True)

    def test_every_case_matches(self):
        for label, enemy in CASES.items():
            total, hits, chars = EXPECTED[label]
            with self.subTest(label=label):
                r = self._run(enemy)
                self.assertEqual(r.squad_total, total, "총딜이 달라졌다")
                self.assertEqual(len(r.hits), hits, "히트 수가 달라졌다")
                self.assertEqual({k: v for k, v in sorted(r.char_total.items())}, chars,
                                 "캐릭터별 딜이 달라졌다")

    def test_the_table_covers_every_kind(self):
        """여섯 종이 **하나도 빠짐없이** 표에 있다 — 빠진 종류는 이 못이 안 박힌다."""
        used = {w["kind"] for e in CASES.values() for w in e.get("boss_phases", [])}
        self.assertEqual(used, {"core", "optimal_range", "pierce_gate", "immune",
                                "element_gate", "parts"}, sorted(used))

    def test_the_expected_table_is_complete(self):
        self.assertEqual(set(CASES), set(EXPECTED))


if __name__ == "__main__":
    unittest.main()
