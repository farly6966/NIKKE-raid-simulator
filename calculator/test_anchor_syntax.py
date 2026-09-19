"""컨트롤의 「언제」를 앵커 문법으로 연다 — 창 열거형과 장전컨 3정책이 한 줄로.

上游 Jgaram/nikke-calc `ac8fe2a`의 이식.

종전에는 「언제」가 다섯 벌로 흩어져 있었다 — 장전컨 정책 A·B·C, 홀드컨, `hold_judge`.
모양은 전부 같았다: **무엇을 기준으로 몇 초**. 열거형 이름을 하나씩 늘리는 대신 그
모양을 그대로 적는다.

    시각 = anchor + offset − minus
    클릭: [시각, 시각+len) 구간   /   엄폐: t >= 시각 진입 트리거

**상태 창을 없애지 않는 것이 핵심이다.** `burst_charge`는 앵커+오프셋이 아니라 상태다 ——
판정이 `state["burst_gauge_charging"]`이고 이건 게이지 가산이 충전 여부를 판정하는 바로
그 값이라, 시각으로 환산하면 톡톡이 구간과 충전 구간이 어긋날 수 없다는 보장이 사라진다.

이 파일이 釘는 것 셋:

1. **종전 표기와 앵커 표기가 1원도 다르지 않다** (정책 A·B·C 각각)
2. 앵커가 **자기 게이트를 함께 든다** — 그게 위 등가성의 근거다
3. 어휘가 **닫혀 있다** — 넓어진 오타 지면이 조용히 「아무 일도 안 함」이 되지 않는다
"""
import unittest

from calculator.timeline import (_RELOAD_POLICIES, CharState, _build_reload_when,
                                 _norm_click_entry, _when_label, simulate,
                                 validate_control)
from calculator.buff_manager import BuffManager
from context.spec import build_config, build_squad

# `test_next_fb_prediction.py`와 같은 편성 — 이 repo에서 앨리스가 장전컨을 쓰는 자리다.
SQUAD = ["리타", "그레이브", "레이", "앨리스", "모더니아"]
WHO = "앨리스"

# 종전 정책 ↔ 같은 뜻의 앵커 표기. `_RELOAD_POLICIES`의 desugar가 이 표와 같아야 한다.
EQUIVALENT = (
    ({"policy": "before_fb_end", "lead": 0.3},
     {"anchor": "fb_end", "offset": -0.3}),
    ({"policy": "into_fb", "margin": 0.43},
     {"anchor": "next_fb_start", "offset": 0.43, "minus": "reload_total"}),
    ({"policy": "finish_by_fb_end", "margin": 0.1},
     {"anchor": "fb_end", "offset": -0.1, "minus": "reload_total"}),
)


def _run(control, duration=180.0, bare=False):
    # `bare`: 캐릭터 기본 레이어(앨리스의 `tap_fire`)를 끈다 — `click`과 종전 키를 함께
    # 적는 것은 조립이 막으므로, 클릭 스케줄을 직접 주는 쪽에서만 쓴다.
    squad = build_squad(SQUAD, chars={WHO: {"control": control}},
                        no_layer={WHO} if bare else None)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    return simulate(squad, config=cfg, enemy={"code": "풍압", "core_px": 0}, verbose=True)


def _covers(result):
    return [(round(e.t, 6), e.event) for e in result.log.reload_log
            if e.caster == WHO and "엄폐" in e.event]


class LegacyPolicyAndAnchorAreTheSameRunTest(unittest.TestCase):
    """**1원도 다르지 않다.** 총딜과 엄폐 시각 양쪽을 본다.

    총딜만 보면 엄폐가 한 번 밀려도 소수점 아래에서 묻힐 수 있다 — 그래서 장전컨이
    실제로 언제 열렸는지(`reload_log`)를 함께 釘는다.
    """

    def test_each_policy_matches_its_anchor_form(self):
        for legacy, anchor in EQUIVALENT:
            with self.subTest(policy=legacy["policy"]):
                a = _run({"reload": legacy})
                b = _run({"reload": anchor})
                self.assertEqual(a.squad_total, b.squad_total,
                                 f"{legacy['policy']}: 총딜이 갈렸다")
                self.assertEqual(_covers(a), _covers(b),
                                 f"{legacy['policy']}: 엄폐가 열린 시각이 갈렸다")

    def test_the_desugar_table_is_what_the_test_claims(self):
        """위 표가 코드의 desugar와 같은지 — 표가 낡으면 등가성 테스트가 헛돈다."""
        for legacy, anchor in EQUIVALENT:
            with self.subTest(policy=legacy["policy"]):
                when, _prio = _build_reload_when(dict(legacy), "t")
                self.assertEqual(when["anchor"], anchor["anchor"])
                self.assertAlmostEqual(when["offset"], anchor["offset"], places=9)
                self.assertEqual(when.get("minus"), anchor.get("minus"))

    def test_policy_c_keeps_its_high_priority(self):
        """등급은 **정책 이름에 붙어 있던 것**이다 — desugar가 그것까지 옮긴다.

        앵커 표기를 직접 쓰면 그 이름이 없으므로 기본 하이고, 급하면 `priority`를 적는다.
        """
        self.assertEqual(_build_reload_when({"policy": "finish_by_fb_end"}, "t")[1],
                         _RELOAD_POLICIES["finish_by_fb_end"][4])
        self.assertEqual(_build_reload_when({"anchor": "fb_end", "offset": -0.1,
                                             "minus": "reload_total"}, "t")[1],
                         _RELOAD_POLICIES["before_fb_end"][4])


class AnchorCarriesItsGateTest(unittest.TestCase):
    """**앵커가 자기 게이트를 함께 든다** — 등가성의 근거가 이것이다.

    `full_burst_end_t`는 풀버스트가 끝나도 state에 남는다. 게이트 없이 시각만 보면
    풀버스트가 끝난 뒤에도 「종료 0.3초 전」이 영원히 참이라 창이 계속 열린다 ——
    종전 정책 A가 `full_burst`를 따로 물어보던 그 조건이 앵커 정의 안으로 들어갔다.
    """

    def _state(self, control):
        squad = build_squad(SQUAD, chars={WHO: {"control": control}})
        char = next(c for c in squad if c["name"] == WHO)
        return CharState(char, 100000.0, ""), BuffManager(squad)

    def test_fb_end_is_shut_outside_full_burst(self):
        state, bm = self._state({"reload": {"anchor": "fb_end", "offset": -0.3}})
        bm.state["full_burst_end_t"] = 10.0
        bm.state["full_burst"] = False
        self.assertIsNone(state._anchor_at(state.reload_when, 20.0, bm),
                          "풀버스트가 끝났는데도 앵커가 시각을 내놓는다")
        bm.state["full_burst"] = True
        self.assertIsNotNone(state._anchor_at(state.reload_when, 9.9, bm))

    def test_own_fb_end_also_needs_the_caster_to_have_burst(self):
        state, bm = self._state({"reload": {"anchor": "own_fb_end", "offset": -0.3}})
        bm.state["full_burst"], bm.state["full_burst_end_t"] = True, 10.0
        bm.state["burst_casted"] = {}
        self.assertIsNone(state._anchor_at(state.reload_when, 9.9, bm),
                          "본인이 버스트를 안 썼는데 `own_fb_end`가 열렸다")
        bm.state["burst_casted"] = {WHO: True}
        self.assertIsNotNone(state._anchor_at(state.reload_when, 9.9, bm))

    def test_next_fb_start_needs_an_observation(self):
        state, bm = self._state(
            {"reload": {"anchor": "next_fb_start", "offset": 0.1, "minus": "reload_total"}})
        bm.state["next_fb_start_pred"] = -1.0
        self.assertIsNone(state._anchor_at(state.reload_when, 5.0, bm),
                          "관측치가 없는 첫 사이클에 예측 앵커가 열렸다")

    def test_combat_start_has_no_gate(self):
        e = _norm_click_entry({"anchor": "combat_start", "offset": 45.0, "len": 5.0,
                               "mode": "tap", "rate": 3.6}, "t")
        state, bm = self._state({})
        self.assertFalse(state._when_open(e, 44.9, bm))
        self.assertTrue(state._when_open(e, 45.0, bm))
        self.assertTrue(state._when_open(e, 49.9, bm))
        self.assertFalse(state._when_open(e, 50.0, bm), "구간 끝이 닫힌 구간이 아니다")


class TheTwoGapsAreExpressibleNowTest(unittest.TestCase):
    """§미구현·보류에 적혀 있던 둘이 이 문법으로 적힌다.

    조립을 통과하는 것만으로는 부족하다 — **실제로 그 구간에서만** 조작이 걸려야 한다.
    """

    def test_tap_on_an_arbitrary_window(self):
        """톡톡이 임의 시각 구간 — `combat_start@45+5`."""
        plain = _run({}, duration=60.0, bare=True)
        windowed = _run({"click": [{"anchor": "combat_start", "offset": 20.0, "len": 10.0,
                                    "mode": "tap", "rate": 4.0}]},
                        duration=60.0, bare=True)
        shots = lambda r: sorted(h.t for h in r.hits
                                 if h.caster == WHO and h.skill_name == "기본 공격")
        a, b = shots(plain), shots(windowed)
        self.assertNotEqual(a, b, "지정 구간을 줬는데 사격이 한 자리도 안 변했다")
        # 구간 **밖**은 건드리지 않는다 — 20초 전은 그대로여야 한다.
        self.assertEqual([x for x in a if x < 20.0], [x for x in b if x < 20.0],
                         "구간 밖(0~20초)의 사격이 움직였다")
        # 구간 **안**은 더 촘촘해진다 (톡톡이가 걸렸다).
        self.assertGreater(len([x for x in b if 20.0 <= x < 30.0]),
                           len([x for x in a if 20.0 <= x < 30.0]),
                           "지정 구간 안에서 톡톡이가 안 걸렸다")

    def test_full_charge_timing_tied_to_a_cycle_event(self):
        """구간별 풀차지 시점 — `own_fb_end@-6+6`은 조립을 통과하고 창이 그 구간이다."""
        e = _norm_click_entry({"anchor": "own_fb_end", "offset": -6.0, "len": 6.0,
                               "mode": "tap", "rate": 4.0}, "t")
        squad = build_squad(SQUAD)
        state = CharState(next(c for c in squad if c["name"] == WHO), 100000.0, "")
        bm = BuffManager(squad)
        bm.state["full_burst"], bm.state["full_burst_end_t"] = True, 30.0
        bm.state["burst_casted"] = {WHO: True}
        self.assertFalse(state._when_open(e, 23.9, bm))
        self.assertTrue(state._when_open(e, 24.0, bm))
        self.assertTrue(state._when_open(e, 29.9, bm))
        self.assertFalse(state._when_open(e, 30.0, bm))


class TheVocabularyIsClosedTest(unittest.TestCase):
    """넓어진 표현력만큼 오타 지면도 넓어졌다 — 조용히 무시되는 입력을 만들지 않는다."""

    def _click(self, entry):
        with self.assertRaises(ValueError) as cm:
            _norm_click_entry(entry, "누구")
        return str(cm.exception)

    def _reload(self, rl):
        with self.assertRaises(ValueError) as cm:
            _build_reload_when(rl, "누구")
        return str(cm.exception)

    def test_window_and_anchor_are_exclusive(self):
        self.assertIn("정확히 하나", self._click(
            {"window": "always", "anchor": "fb_end", "offset": 0, "len": 1, "mode": "hold"}))

    def test_state_window_refuses_anchor_keys(self):
        self.assertIn("앵커 구간 전용", self._click(
            {"window": "always", "offset": 2.0, "mode": "tap", "rate": 3.6}))

    def test_unknown_anchor(self):
        self.assertIn("모르는 앵커", self._click(
            {"anchor": "fb_start", "len": 1.0, "mode": "tap", "rate": 3.6}))

    def test_span_needs_a_length(self):
        """길이 없는 구간은 **한 프레임도 열리지 않는다** — 조립에서 끊는다."""
        self.assertIn("`len`", self._click(
            {"anchor": "fb_end", "offset": -2.0, "mode": "tap", "rate": 3.6}))
        self.assertIn("0보다", self._click(
            {"anchor": "fb_end", "len": 0, "mode": "tap", "rate": 3.6}))

    def test_cover_is_a_trigger_not_a_span(self):
        self.assertIn("진입 트리거", self._reload(
            {"anchor": "fb_end", "offset": -0.3, "len": 2.0}))

    def test_unknown_dynamic_offset(self):
        self.assertIn("모르는 동적 오프셋", self._reload(
            {"anchor": "fb_end", "minus": "charge_time"}))

    def test_policy_and_anchor_are_exclusive(self):
        self.assertIn("같이 줄 수 없다", self._reload(
            {"policy": "into_fb", "anchor": "fb_end"}))

    def test_a_policy_that_does_not_read_the_key(self):
        """정책 A는 `margin`을 읽지 않는다 — 주면 조용히 무시되므로 끊는다."""
        self.assertIn("읽지 않는다", self._reload({"policy": "before_fb_end", "margin": 0.5}))
        self.assertIn("읽지 않는다", self._reload({"policy": "into_fb", "lead": 0.5}))

    def test_unknown_reload_key(self):
        self.assertIn("모르는 키", self._reload({"policy": "into_fb", "leed": 0.5}))

    def test_if_dry_needs_an_fb_end_anchor(self):
        """`if_dry`의 기준은 **이번 풀버스트 종료 시각**이다 — 다른 앵커에는 그게 없다."""
        self.assertIn("if_dry", self._reload(
            {"anchor": "next_fb_start", "offset": 0.1, "if_dry": True}))
        self.assertIn("if_dry", self._reload({"if_dry": True}))

    def test_hold_modes_refuse_combat_start(self):
        """떼기 모드의 사이클당 1회 가드는 **앵커 기준값**으로 판정한다.

        `combat_start`는 기준값이 전투 내내 0.0 하나뿐이라 「사이클당 1회」가 곧
        「전투당 1회」가 된다 — 켠 줄 알고 결과를 읽게 되므로 조립에서 끊는다.
        """
        self.assertIn("combat_start", self._click(
            {"anchor": "combat_start", "offset": 10.0, "len": 5.0, "mode": "hold"}))

    def test_validate_control_is_the_same_vocabulary(self):
        """doclint가 부르는 입구와 조립이 부르는 입구가 **같은 함수**다."""
        with self.assertRaises(ValueError):
            validate_control({"click": [{"anchor": "nope", "len": 1, "mode": "hold"}]}, "t")
        with self.assertRaises(ValueError):
            validate_control({"reload": {"policy": "nope"}}, "t")
        with self.assertRaises(ValueError):
            validate_control({"cover": {"policy": "nope"}}, "t")
        validate_control({"reload": {"policy": "into_fb"},
                          "click": [{"window": "always", "mode": "tap", "rate": 3.6}]}, "t")


class LabelRoundTripsTest(unittest.TestCase):
    """로그·스쿼드 표기의 정본이 한 곳이다 — CLI가 받는 표기와 같은 모양으로 찍는다."""

    def test_label(self):
        self.assertEqual(_when_label({"window": "burst_charge"}), "burst_charge")
        self.assertEqual(
            _when_label(_norm_click_entry({"anchor": "own_fb_end", "offset": -6.0,
                                           "len": 6.0, "mode": "tap", "rate": 4.0}, "t")),
            "own_fb_end@-6+6")
        self.assertEqual(
            _when_label(_build_reload_when({"policy": "into_fb", "margin": 0.1}, "t")[0]),
            "next_fb_start@+0.1-reload_total")


if __name__ == "__main__":
    unittest.main()
