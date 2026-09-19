"""클립 재장전 — 1회가 채우는 양은 CDN이 말하고, 「재장전 비율」이 그것을 깎는다.

上游 `dfadc9a`(발사 메카닉 CDN 유도) + `93ec10a`(A 區 `clip_count`·`reload_ratio_pct`).
둘은 같은 아이템이었다 —— CDN `shot_detail`을 다시 받는 것 하나로 같이 풀린다.

두 축을 갈라 둔다:

  `reload_speed_pct`  1회에 걸리는 **시간**
  `reload_ratio_pct`  1회가 채우는 **양** → 깎으면 **횟수**가 는다

아군 재장전 속도 버프 `a`가 붙으면 두 모델은 `2×(1.5−a)` vs `4×(1−a)`로 `a=50%`에서만
우연히 같아진다 —— 그래서 종전의 `reload_speed_pct: -50` 오등록이 오래 안 드러났다.
"""
import json
from pathlib import Path
import unittest

from calculator.buff_manager import BuffManager
from calculator.timeline import CharState, simulate
from context.spec import build_config, build_squad

ROOT = Path(__file__).resolve().parents[1]
RAW = json.loads((ROOT / "scraper/nikke_scraped.json").read_text(encoding="utf-8"))
NIKKE = json.loads((ROOT / "data/parsed_nikke.json").read_text(encoding="utf-8"))


class ClipRatioComesFromCdnTest(unittest.TestCase):
    """`clip_ratio_pct`의 정본은 CDN `reload_bullet`이다(최대 장탄 대비 ×10000)."""

    def test_derivation_matches_the_raw_field(self):
        for name, entry in NIKKE.items():
            raw = RAW.get(name)
            if not raw:
                continue                      # 더미(test_B1 등)
            reload_bullet = raw["무기상세"].get("재장전 탄수") or 0
            with self.subTest(name=name):
                if reload_bullet in (0, 10000):
                    self.assertNotIn("clip_ratio_pct", entry,
                                     "탄창 전체를 채우는데 클립으로 잡혔다")
                else:
                    self.assertAlmostEqual(entry["clip_ratio_pct"], reload_bullet / 100.0)

    def test_the_hand_written_list_is_reproduced(self):
        """종전의 손 목록 14명을 한 명도 빠뜨리지 않고, 그레이브가 하나 더 붙는다.

        손 목록은 SG·RL만 보고 있어서 AR인 그레이브(60발을 30발씩)를 볼 일이 없었다.
        """
        hand = {"누아르", "드레이크", "바이퍼", "네온", "페퍼", "슈가", "메이든",
                "프로덕트 23", "소다 : 트윙클링 바니",           # SG
                "센티", "루마니", "아니스", "자칼", "트리나"}     # RL
        derived = {n for n, e in NIKKE.items() if "clip_ratio_pct" in e}
        self.assertEqual(hand - derived, set(), "손 목록에 있던 사람이 빠졌다")
        self.assertEqual(derived - hand, {"그레이브"},
                         "손 목록과 CDN의 차이는 그레이브 하나여야 한다")

    def test_shots_per_clip(self):
        for name, expected in (("드레이크", 3), ("트리나", 2), ("그레이브", 30)):
            with self.subTest(name=name):
                self.assertEqual(NIKKE[name]["clip_count"], expected)


class ReloadRatioBuffSplitsTheMagazineTest(unittest.TestCase):
    """그레이브 `방열` —— 원문 `[방열 : 재장전 비율 50% ▼]`.

    기본 50%(2분할)에서 다시 절반이 깎여 **25%, 4분할**이 된다. 上游가 적어 둔
    유저 확인(「버스트 종료 후 4분할」)과 같은 수다.
    """

    SQUAD = ["미란다", "그레이브", "라피", "에이다", "아인"]   # 그레이브가 유일한 B2

    def test_parsed_as_ratio_not_speed(self):
        skills = json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))
        effect = next(e for e in skills["그레이브"] if e.get("name") == "방열 2")
        self.assertEqual(effect["stat"], "reload_ratio_pct",
                         "재장전 «비율»을 «속도»로 적으면 시간이 늘고 횟수는 그대로다")
        self.assertEqual(effect["fixed_value"], -50)

    def test_ratio_halves_when_the_buff_is_on(self):
        squad = build_squad(self.SQUAD)
        state = CharState(next(c for c in squad if c["name"] == "그레이브"), 100000.0, "")
        bm = BuffManager(squad)
        self.assertEqual(state._effective_clip_ratio(bm), 50.0)
        self.assertEqual(state._clip_gain(60, bm), 30)

        bm.get_buffs = lambda *a, **k: {"reload_ratio_pct": -50.0}
        self.assertEqual(state._effective_clip_ratio(bm), 25.0)
        self.assertEqual(state._clip_gain(60, bm), 15)

    def test_the_magazine_is_quartered_in_a_real_run(self):
        squad = build_squad(self.SQUAD)
        cfg = build_config(squad, {"duration": 90, "rng_mode": "expected",
                                   "first_burst_time": 3.0})
        result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
        log = [e for e in result.log.reload_log if e.caster == "그레이브"]
        self.assertTrue(any(e.name == "방열 2" for e in result.log.buff_events
                            if e.caster == "그레이브"),
                        "`방열`이 한 번도 안 걸렸다 — 이 편성의 전제가 깨졌다")

        # `재장전 시작` ~ `재장전 완료` 사이의 «클립 재장전» 수 + 1 = 분할 수
        splits, cur = [], None
        for entry in log:
            if entry.event == "재장전 시작":
                cur = 1
            elif entry.event == "클립 재장전" and cur:
                cur += 1
            elif entry.event == "재장전 완료" and cur:
                splits.append(cur)
                cur = None
        self.assertIn(2, splits, "방열이 없는 구간은 2분할이어야 한다")
        self.assertIn(4, splits, "방열 구간은 4분할이어야 한다")
        self.assertEqual(set(splits), {2, 4}, f"2·4 말고 다른 분할이 나왔다: {splits}")


if __name__ == "__main__":
    unittest.main()
