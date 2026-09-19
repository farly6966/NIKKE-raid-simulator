"""무기 변경 중에도 조작은 돈다 — 모드 분기가 컨트롤층보다 위에서 return했다.

上游 Jgaram/nikke-calc `ec774c7`의 이식.

`CharState.tick()`의 무기 변경 분기가 컨트롤 실행층 **앞에서** `return`해, 모드가 켜진
동안(벨벳 MG 모드 10초) 조작이 통째로 멈췄다. 게다가 시각을 지정한 명시 시퀀스는
버려지지도 않는다 — `_pump_ctrl_seq`가 지나간 항목을 그대로 들고 있다가 조작 처리가
다시 도는 첫 틱에 꺼내 쓰므로, **지정 시각이 모드 종료 프레임으로 밀린다.**

baseline은 29/29 그대로다. 하네스 편성 중 무기 변경 구간에 조작을 지정한 것이 없어서 ——
그래서 회귀가 못 잡던 자리다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

# 벨벳은 버스트로 MG 모드에 들어간다(10초). 첫 풀버스트가 t≈3.9라 모드는 대략 3.9~13.9.
SQUAD = ["미란다", "벨벳", "라피", "에이다", "아인"]
INSIDE_MODE = 6.0     # 모드 한가운데
OUTSIDE_MODE = 20.0   # 모드 밖
COVER = 2.0


def _fire_gaps(cover_at, threshold=1.6):
    squad = build_squad(SQUAD, chars={"벨벳": {"control": {"sequence": [
        {"t": cover_at, "action": "cover", "duration": COVER}]}}})
    cfg = build_config(squad, {"duration": 30, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    shots = sorted(h.t for h in result.hits if h.caster == "벨벳")
    return [(a, b - a) for a, b in zip(shots, shots[1:]) if b - a > threshold]


class CoverHappensOnTimeInsideWeaponChangeTest(unittest.TestCase):
    def test_cover_inside_the_mode_is_not_pushed_to_mode_end(self):
        gaps = _fire_gaps(INSIDE_MODE)
        self.assertTrue(gaps, "엄폐로 생긴 사격 공백이 아예 없다")
        start, _length = gaps[0]
        self.assertAlmostEqual(
            start, INSIDE_MODE, delta=0.1,
            msg=f"엄폐가 지정 시각 {INSIDE_MODE}이 아니라 {start:.3f}에 걸렸다 — "
                "모드 종료 프레임으로 밀렸는지 확인하라")

    def test_cover_outside_the_mode_is_unchanged(self):
        """모드 밖 경로는 한 자리도 건드리지 않았다는 대조군."""
        gaps = _fire_gaps(OUTSIDE_MODE)
        self.assertTrue(gaps)
        start, _length = gaps[0]
        self.assertAlmostEqual(start, OUTSIDE_MODE, delta=0.3)

    def test_the_mode_really_is_running_at_that_moment(self):
        """이 테스트의 전제 — `INSIDE_MODE`가 정말 무기 변경 구간 안이다.

        전제가 깨지면 위 두 테스트는 아무것도 증명하지 않는다.
        """
        squad = build_squad(SQUAD)
        cfg = build_config(squad, {"duration": 30, "rng_mode": "expected",
                                   "first_burst_time": 3.0})
        result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
        modes = [e for e in result.log.buff_events
                 if e.caster == "벨벳" and e.kind == "activate"]
        self.assertTrue(modes, "벨벳이 아무 버프도 안 걸었다")
        bursts = [e.t for e in result.log.burst_log if e.caster == "벨벳"]
        self.assertTrue(bursts, "벨벳이 버스트를 안 썼다 — 이 편성으로는 모드가 안 열린다")
        self.assertLess(bursts[0], INSIDE_MODE,
                        "버스트가 엄폐 지정 시각보다 늦다 — 그 시각은 모드 밖이다")
        self.assertGreater(bursts[0] + 10.0, INSIDE_MODE,
                           "모드(10초)가 엄폐 지정 시각 전에 끝난다")


if __name__ == "__main__":
    unittest.main()
