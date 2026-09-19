"""`burst_chain` + `hold_until_close` — 풀버스트용 한 발 저장.

上游 Jgaram/nikke-calc `cf8c9ec` 중 **앵커에 기대지 않는 부분**의 이식.
(`own_buff_end` 앵커와 `gate` 키는 `ac8fe2a`의 앵커 문법이 먼저 들어와야 한다.)

차지형 니케는 게이지를 채우는 동안에는 평소대로 즉시 쏜다. 게이지가 충족돼 1단계
버튼이 열린 뒤에는 **게이지가 더 이상 차지 않으므로**, 단계 버튼과 쿨을 기다리는 동안
다음 한 발을 들고 있다가 풀버스트 시작과 동시에 놓는다.

떼는 시각이 **상수가 아니다** —— 사이클이 언제 넘어갈지는 단계 버튼과 쿨이 정하므로
미리 계산할 수 없다. 그래서 「창이 닫히는 틱에 뗀다」는 모드가 따로 있다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["미란다", "타키나", "에이다", "라피", "아인"]
HOLDER = "에이다"                       # RL 차지형
TAP = {"window": "always", "mode": "tap", "rate": 3.6}
CHAIN = {"window": "burst_chain", "mode": "hold_until_close"}


def _run(click, duration=60):
    chars = {HOLDER: {"control": {"click": click}}} if click else None
    squad = build_squad(SQUAD, chars=chars, no_layer={HOLDER})
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    return simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)


def _shots(result):
    return sorted(h.t for h in result.hits
                  if h.caster == HOLDER and h.skill_name == "기본 공격")


class HeldShotLandsAtFullBurstStartTest(unittest.TestCase):
    def test_the_shot_is_released_on_the_frame_the_window_closes(self):
        result = _run([CHAIN, TAP])
        starts = [e.t for e in result.log.burst_log if e.event == "full_burst 시작"]
        shots = _shots(result)
        self.assertGreaterEqual(len(starts), 2, "풀버스트가 두 번은 돌아야 잰다")

        # 첫 사이클은 전투 시작 직후라 차지가 아직 안 섰다 — 두 번째부터 본다.
        for start in starts[1:]:
            with self.subTest(start=round(start, 3)):
                after = next(x for x in shots if x >= start - 1e-6)
                self.assertLess(after - start, 0.05,
                                f"풀버스트 시작 {start:.3f}인데 첫 사격이 {after:.3f}다 — "
                                "들고 있던 한 발이 그 틱에 안 나갔다")

    def test_the_chain_window_suppresses_tap(self):
        """창이 열린 동안에는 톡톡이가 멈춘다 — 먼저 매치되는 항목이 이긴다."""
        tap_only = _shots(_run([TAP]))
        chained = _shots(_run([CHAIN, TAP]))
        self.assertLess(len(chained), len(tap_only),
                        "체인 창에서도 톡톡이가 계속 나갔다")
        self.assertGreater(len(chained), len(_shots(_run(None))),
                           "창 밖에서 톡톡이가 안 걸렸다")


class PairingIsClosedTest(unittest.TestCase):
    """`burst_chain`과 `hold_until_close`는 **서로만** 짝짓는다.

    `always`에 잘못 걸면 창이 안 닫혀 **한 발을 영원히 들고 있는** 입력이 된다.
    조용히 무시되는 대신 조립에서 실패해야 한다.
    """

    def test_hold_until_close_needs_burst_chain(self):
        with self.assertRaises(ValueError) as cm:
            _run([{"window": "always", "mode": "hold_until_close"}])
        self.assertIn("서로만 짝짓는다", str(cm.exception))

    def test_burst_chain_needs_hold_until_close(self):
        with self.assertRaises(ValueError):
            _run([{"window": "burst_chain", "mode": "hold", "lead": 0.5}])


class WindowMatchesTheStateMachineTest(unittest.TestCase):
    """창은 단계 버튼을 기다리는 구간에서만 열린다 —— `full_burst` 진입 틱에 닫힌다."""

    def test_phase_is_published_for_the_window(self):
        from calculator.buff_manager import BuffManager
        from calculator.timeline import BurstController, CharState
        squad = build_squad(SQUAD)
        states = {c["name"]: CharState(c, 100000.0, "") for c in squad}
        cfg = build_config(squad, {"duration": 30, "rng_mode": "expected"})
        bm = BuffManager(squad)
        bc = BurstController(squad, cfg, states, {"code": "", "core_px": 0})
        state = dict(bm.state)
        state.setdefault("burst_stages", {})
        bc.tick(0.0, bm, state)
        self.assertIn("burst_phase", state,
                      "창 판정이 읽을 단계 상태가 state에 안 올라온다")

    def test_open_only_between_stage_one_and_full_burst(self):
        from calculator.buff_manager import BuffManager
        from calculator.timeline import CharState
        squad = build_squad(SQUAD, chars={HOLDER: {"control": {"click": [CHAIN, TAP]}}},
                            no_layer={HOLDER})
        state = CharState(next(c for c in squad if c["name"] == HOLDER), 100000.0, "")
        bm = BuffManager(squad)
        entry = {"window": "burst_chain", "mode": "hold_until_close"}
        for phase, expected in (("idle", False), ("stage:1", True), ("stage:2", True),
                                ("reenter:1", True), ("switching", True),
                                ("full_burst", False), ("", False)):
            with self.subTest(phase=phase):
                bm.state["burst_phase"] = phase
                self.assertIs(state._when_open(entry, 0.0, bm), expected)


if __name__ == "__main__":
    unittest.main()
