"""딜레이 버스트 — 차례가 와도 유저가 바로 누르지는 않는다.

上游 Jgaram/nikke-calc `544adeb` 중 **기제 부분**의 이식.

`544adeb`은 둘을 함께 한다 —— `burst_pattern`을 `control["burst"]["pattern"]`으로
옮기는 스키마 통합과, 사이클 안에서 언제 누르나(`delay`). **스키마 쪽은 옮기지
않았다**: 이 fork에는 `context/spec.py`가 관리하는 `_burst_patterns` 카탈로그와
사이트 저장 형식이 걸려 있어 호환 부담만 남고 얻는 것이 없다. 기제만 가져온다.

세 가지를 釘는다:

1. 지정한 만큼 **밀린다**
2. 뒷사람이 **대신 누르지 않는다** — 단계 전체가 밀릴 뿐 건너뛰지 않는다
3. 장전컨이 쓰는 **다음 풀버스트 예측**도 같은 식을 쓴다
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["미란다", "타키나", "라피", "에이다", "아인"]   # B1 · B2 · B3 셋
DELAYED = "타키나"


def _burst_log(delay=0.0, duration=60):
    chars = {DELAYED: {"control": {"burst": {"delay": delay}}}} if delay else None
    squad = build_squad(SQUAD, chars=chars)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    return [(e.t, e.event, e.caster) for e in result.log.burst_log]


def _first(log, event):
    return next(t for t, ev, _ in log if ev == event)


class DelayPushesThePressTest(unittest.TestCase):
    def test_no_delay_is_unchanged(self):
        """기본은 0이다 — 안 주면 종전과 한 자리도 다르지 않다."""
        self.assertEqual(_burst_log(0.0), _burst_log())

    def test_the_stage_is_pushed_by_exactly_the_delay(self):
        base = _burst_log(0.0)
        for delay in (2.0, 5.0):
            with self.subTest(delay=delay):
                log = _burst_log(delay)
                # 앞 단계(1단계)는 안 움직인다 — 딜레이는 그 사람 차례부터다
                self.assertAlmostEqual(_first(log, "stage:1 사용"),
                                       _first(base, "stage:1 사용"), places=6)
                # 딜레이 당사자의 단계와 그 뒤가 통째로 밀린다
                self.assertAlmostEqual(_first(log, "stage:2 사용"),
                                       _first(base, "stage:2 사용") + delay, places=6)
                self.assertAlmostEqual(_first(log, "full_burst 시작"),
                                       _first(base, "full_burst 시작") + delay, places=6)

    def test_nobody_presses_instead(self):
        """**뒷사람이 대신 나가지 않는다.**

        조작자가 한 명이라 버튼을 늦게 누르면 그 단계 전체가 밀린다. 여기서 다음 후보로
        넘기면 「미룬 것」이 아니라 「건너뛴 것」이 되어 조작이 표현되지 않는다.
        """
        log = _burst_log(5.0)
        casters = [c for _t, ev, c in log if ev == "stage:2 사용"]
        self.assertTrue(casters, "2단계가 한 번도 안 나갔다")
        self.assertEqual(set(casters), {DELAYED},
                         "딜레이를 준 사람 대신 동료가 눌렀다")


class PredictionUsesTheSameFormulaTest(unittest.TestCase):
    """장전컨의 «다음 풀버스트 시작» 예측도 딜레이를 더한다.

    예측식과 집행식이 어긋나면 정책 B·`if_dry`가 딜레이가 걸린 조합에서만 조용히
    빗나간다 —— 예측이 이른 쪽으로 틀려 장전이 풀버스트 안으로 못 들어간다.
    """

    def test_predicted_start_moves_with_the_delay(self):
        from calculator.timeline import BurstController, CharState

        def predicted(delay):
            chars = {DELAYED: {"control": {"burst": {"delay": delay}}}} if delay else None
            squad = build_squad(SQUAD, chars=chars)
            cfg = build_config(squad, {"duration": 60, "rng_mode": "expected"})
            states = {c["name"]: CharState(c, 100000.0, "") for c in squad}
            bc = BurstController(squad, cfg, states, {"code": "", "core_px": 0})
            return bc._predict_next_fb_start(0.0)

        base = predicted(0.0)
        self.assertGreater(base, 0.0, "첫 사이클 예측이 아예 안 나온다")
        for delay in (2.0, 5.0):
            with self.subTest(delay=delay):
                self.assertAlmostEqual(predicted(delay), base + delay, places=6)


if __name__ == "__main__":
    unittest.main()
