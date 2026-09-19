"""런타임 컨트롤 조건 둘 — 확정된 사이클 사용자(`gate`)와 본인 버프 만료(`own_buff_end`).

上游 Jgaram/nikke-calc `cf8c9ec`의 **남은 두 건** 이식.
(같은 commit의 `burst_chain` + `hold_until_close`는 앵커에 기대지 않아 먼저 갔다 —
`calculator/test_burst_chain_hold.py`.)

둘 다 「언제」를 넓히지만 **관찰이 전투를 바꾸지 않는 선**을 지킨다:

`gate`          자유 조건식이 아니다. **이미 확정된** 이번 사이클의 단계별 버스트
                사용자를 보는 닫힌 어휘 하나다. 앞으로 누가 쓸지를 예측하지 않으므로
                이 게이트가 사이클을 바꿀 수 없다.
`own_buff_end`  **효과의 대상을 조회하지 않는다.** 지연 resolve 버프의 대상을 미리
                확정하면 「컨트롤이 들여다봤다」는 이유만으로 결과가 달라진다. 본인이
                발동한 이름과 확정된 만료 시각만 읽는다.

이 편성의 B3는 사이클마다 레이와 앨리스가 번갈아 간다 —— 게이트가 실제로 거르는지
재기에 딱 맞는 자리다.
"""
import math
import unittest

from calculator.buff_manager import BuffManager
from calculator.timeline import (_RELOAD_POLICIES, CharState, _build_reload_when,
                                 _norm_click_entry, _when_label, simulate)
from context.spec import build_config, build_squad

SQUAD = ["리타", "그레이브", "레이", "앨리스", "모더니아"]
WHO = "앨리스"
OWN_BUFF = "신기하고 이상한 나라"      # 앨리스 버스트. 유한(10초)이고 본인이 발동한다
NEVER_B3 = "리타"                      # 이 편성에서 리타는 언제나 B1이다


def _run(control=None, duration=180.0):
    squad = build_squad(SQUAD, chars={WHO: {"control": control}} if control else None,
                        no_layer={WHO})
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    return simulate(squad, config=cfg, enemy={"code": "풍압", "core_px": 0}, verbose=True)


def _covers(result):
    return [e.t for e in result.log.reload_log
            if e.caster == WHO and e.event == "엄폐 시작(장전컨)"]


def _cycles(result):
    """`[(풀버스트 시작, 풀버스트 종료, 그 사이클의 B3 사용자), …]`."""
    out, b3 = [], ""
    for e in result.log.burst_log:
        if e.event == "stage:3 사용":
            b3 = e.caster
        elif e.event == "full_burst 시작":
            out.append([e.t, math.inf, b3])
        elif e.event == "full_burst 종료" and out:
            out[-1][1] = e.t
    return [tuple(c) for c in out]


class GateOnlyOpensOnMatchingCyclesTest(unittest.TestCase):
    """**입력한 사용자가 맞는 사이클만 통과시킨다.**

    사용자를 보고 최적 운용을 고르는 기능이 아니다 —— 결정론적 필터다.
    """

    POLICY = {"policy": "finish_by_fb_end", "margin": 0.1}

    def test_every_cover_lands_in_a_cycle_whose_b3_matches(self):
        gated = _run({"reload": dict(self.POLICY,
                                     gate={"burst_stage": 3, "burst_user": WHO})})
        covers, cycles = _covers(gated), _cycles(gated)
        self.assertTrue(covers, "게이트를 걸었더니 엄폐가 한 번도 안 열렸다")
        for t in covers:
            cyc = next((c for c in cycles if c[0] <= t <= c[1]), None)
            self.assertIsNotNone(cyc, f"엄폐 {t:.3f}가 풀버스트 밖이다")
            self.assertEqual(cyc[2], WHO,
                             f"엄폐 {t:.3f}의 사이클 B3가 {cyc[2]!r}인데 게이트는 {WHO!r}다")

    def test_the_gate_actually_removes_cycles(self):
        """게이트가 **거르고 있다**는 증거 — 안 걸면 더 많은 사이클에서 열린다.

        이게 없으면 위 테스트는 「마침 전부 맞았다」로도 통과한다.
        """
        plain = _covers(_run({"reload": self.POLICY}))
        gated = _covers(_run({"reload": dict(self.POLICY,
                                             gate={"burst_stage": 3, "burst_user": WHO})}))
        self.assertGreater(len(plain), len(gated), "게이트가 아무것도 안 걸렀다")
        self.assertTrue(set(gated) <= set(plain), "게이트가 없던 엄폐를 새로 만들었다")

    def test_a_stage_the_user_never_takes_closes_it_completely(self):
        """리타는 이 편성에서 언제나 B1이다 — `3/리타` 게이트는 영영 안 열린다.

        그리고 **총딜이 컨트롤을 안 켠 것과 같다** —— 게이트가 닫혔을 때 다른 경로로
        새지 않는다는 뜻이다.
        """
        closed = _run({"reload": dict(self.POLICY,
                                      gate={"burst_stage": 3, "burst_user": NEVER_B3})})
        self.assertEqual(_covers(closed), [], "일어나지 않는 조합인데 엄폐가 열렸다")
        self.assertEqual(closed.squad_total, _run().squad_total,
                         "게이트가 닫혔는데 총딜이 컨트롤 없는 경우와 다르다")

    def test_the_record_survives_full_burst_end(self):
        """기록은 **다음 1단계 진입 때** 비운다.

        풀버스트 종료 **전**에 걸리는 장전컨과 종료 **후** 충전 창에서 걸리는 클릭이
        같은 B3 사용자를 봐야 하기 때문이다. 종료 틱에 비우면 둘이 다른 답을 본다.
        """
        result = _run()
        cycles = _cycles(result)
        self.assertGreaterEqual(len(cycles), 2, "사이클이 둘은 있어야 잰다")
        squad = build_squad(SQUAD)
        state = CharState(next(c for c in squad if c["name"] == WHO), 100000.0, "")
        bm = BuffManager(squad)
        spec = {"gate": {"burst_stage": "3", "burst_user": WHO}}
        bm.state["burst_cycle_users"] = {"1": set(), "2": set(), "3": {WHO}}
        self.assertTrue(state._gate_open(spec, bm))
        bm.state["burst_cycle_users"] = {"1": set(), "2": set(), "3": set()}
        self.assertFalse(state._gate_open(spec, bm),
                         "새 사이클로 비운 뒤에도 게이트가 열려 있다")

    def test_before_the_first_burst_it_is_shut(self):
        squad = build_squad(SQUAD)
        state = CharState(next(c for c in squad if c["name"] == WHO), 100000.0, "")
        bm = BuffManager(squad)
        self.assertFalse(
            state._gate_open({"gate": {"burst_stage": "3", "burst_user": WHO}}, bm),
            "아직 아무도 버스트를 안 썼는데 게이트가 열렸다")

    def test_a_click_window_takes_the_same_gate(self):
        """클릭과 장전컨이 **같은 형태**를 쓴다 — 축마다 다른 이름을 두지 않는다."""
        e = _norm_click_entry({"window": "burst_charge", "mode": "tap", "rate": 4.0,
                               "gate": {"burst_stage": 3, "burst_user": WHO}}, "t")
        squad = build_squad(SQUAD)
        state = CharState(next(c for c in squad if c["name"] == WHO), 100000.0, "")
        bm = BuffManager(squad)
        bm.state["burst_gauge_charging"] = True
        self.assertFalse(state._when_open(e, 5.0, bm), "게이트가 닫혔는데 창이 열렸다")
        bm.state["burst_cycle_users"] = {"1": set(), "2": set(), "3": {WHO}}
        self.assertTrue(state._when_open(e, 5.0, bm))


class OwnBuffEndAnchorTest(unittest.TestCase):
    """정책 D `finish_by_own_buff_end` — 본인이 발동한 버프가 끝나기 전에 재장전을 끝낸다."""

    def test_the_desugar_is_what_the_doc_says(self):
        when, prio = _build_reload_when(
            {"policy": "finish_by_own_buff_end", "buff": OWN_BUFF, "margin": 0.1}, "t")
        self.assertEqual(when["anchor"], "own_buff_end")
        self.assertEqual(when["buff"], OWN_BUFF)
        self.assertAlmostEqual(when["offset"], -0.1, places=9)
        self.assertEqual(when["minus"], "reload_total")
        # 등급 중 — 버프 만료를 놓치면 그 순간부터 버프가 샌다(C처럼 사이클이 밀리지는 않는다).
        self.assertEqual(prio, _RELOAD_POLICIES["finish_by_own_buff_end"][4])

    def test_the_anchor_form_is_the_same_run(self):
        legacy = _run({"reload": {"policy": "finish_by_own_buff_end",
                                  "buff": OWN_BUFF, "margin": 0.1}})
        anchor = _run({"reload": {"anchor": "own_buff_end", "buff": OWN_BUFF,
                                  "offset": -0.1, "minus": "reload_total"}})
        self.assertEqual(legacy.squad_total, anchor.squad_total)
        self.assertEqual(_covers(legacy), _covers(anchor))

    def test_every_cover_precedes_an_expiry_of_that_buff(self):
        result = _run({"reload": {"policy": "finish_by_own_buff_end",
                                  "buff": OWN_BUFF, "margin": 0.1}})
        covers = _covers(result)
        self.assertTrue(covers, "정책 D를 걸었는데 엄폐가 한 번도 안 열렸다")
        expiries = [e.t for e in result.log.buff_events
                    if e.caster == WHO and e.name == OWN_BUFF and e.kind == "expire"]
        self.assertTrue(expiries, "그 버프가 한 번도 안 끝났다 — 이 테스트의 전제가 깨졌다")
        for t in covers:
            nxt = next((x for x in expiries if x >= t - 1e-6), None)
            self.assertIsNotNone(nxt, f"엄폐 {t:.3f} 뒤에 버프 만료가 없다")
            # 재장전 시간 + margin 안쪽에서 열렸다 — 「끝나기 전에 끝내 둔다」는 뜻이다
            self.assertLess(nxt - t, 4.0,
                            f"엄폐 {t:.3f}가 만료 {nxt:.3f}보다 너무 이르다")

    def test_it_does_not_look_at_who_the_buff_landed_on(self):
        """**대상을 조회하지 않는다** — 지연 resolve의 결정 시점을 앞당기지 않는 근거다.

        묻는 것은 「본인에게 걸렸나」가 아니라 「본인이 발동한 이름 있는 효과가 지금
        살아 있나」다.
        """
        squad = build_squad(SQUAD)
        bm = BuffManager(squad)
        self.assertIsNone(bm.own_buff_expires_at(WHO, OWN_BUFF, 0.0),
                          "아직 안 걸린 버프가 만료 시각을 내놓는다")
        # 무한지속(장비·큐브)은 만료 시각이 없다 — 앵커가 될 수 없다.
        self.assertIsNone(bm.own_buff_expires_at(WHO, "장비 옵션", 5.0))

    def test_an_unknown_buff_name_fails_at_assembly(self):
        """오타가 살아남으면 앵커가 영영 안 열려 「켰는데 아무 일도 안 함」이 된다."""
        with self.assertRaises(ValueError) as cm:
            _run({"reload": {"policy": "finish_by_own_buff_end",
                             "buff": "그런 이름의 효과는 없다", "margin": 0.1}})
        self.assertIn("스킬 효과에 없다", str(cm.exception))

    def test_a_gate_user_outside_the_squad_fails_at_assembly(self):
        with self.assertRaises(ValueError) as cm:
            _run({"reload": {"policy": "finish_by_fb_end",
                             "gate": {"burst_stage": 3, "burst_user": "홍련"}}})
        self.assertIn("스쿼드에 없다", str(cm.exception))


class TheVocabularyStaysClosedTest(unittest.TestCase):
    def _click(self, entry):
        with self.assertRaises(ValueError) as cm:
            _norm_click_entry(entry, "누구")
        return str(cm.exception)

    def _reload(self, rl):
        with self.assertRaises(ValueError) as cm:
            _build_reload_when(rl, "누구")
        return str(cm.exception)

    def test_gate_needs_both_halves(self):
        """단계만 주면 「누구든」, 사람만 주면 「어느 단계든」으로 읽힌다 —
        둘 다 이 게이트가 답할 수 없는 질문이다."""
        self.assertIn("모두 필요하다", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6, "gate": {"burst_stage": 3}}))
        self.assertIn("모두 필요하다", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6, "gate": {"burst_user": WHO}}))

    def test_gate_unknown_key_and_bad_stage(self):
        self.assertIn("모르는 키", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6,
             "gate": {"burst_stage": 3, "burst_user": WHO, "when": "지금"}}))
        self.assertIn("1·2·3", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6,
             "gate": {"burst_stage": 4, "burst_user": WHO}}))
        self.assertIn("빈 이름", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6,
             "gate": {"burst_stage": 1, "burst_user": "  "}}))

    def test_gate_must_be_an_object(self):
        self.assertIn("객체여야", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6, "gate": "3/앨리스"}))

    def test_buff_only_on_its_own_anchor(self):
        self.assertIn("own_buff_end", self._reload(
            {"anchor": "fb_end", "offset": -0.1, "buff": OWN_BUFF}))
        self.assertIn("`buff`", self._reload(
            {"anchor": "own_buff_end", "offset": -0.1, "minus": "reload_total"}))
        self.assertIn("앵커 구간 전용", self._click(
            {"window": "always", "mode": "tap", "rate": 3.6, "buff": OWN_BUFF}))

    def test_policy_d_still_requires_its_buff(self):
        """종전 이름으로 들어온 길도 **같은 정규화**를 거친다 — 정본이 둘이 되지 않는다."""
        self.assertIn("own_buff_end", self._reload({"policy": "finish_by_own_buff_end"}))

    def test_gate_without_a_policy_is_meaningless(self):
        self.assertIn("엄폐 정책", self._reload({"gate": {"burst_stage": 3,
                                                      "burst_user": WHO}}))
        self.assertIn("엄폐 정책", self._reload({"buff": OWN_BUFF}))

    def test_if_dry_still_refuses_the_new_anchor(self):
        """`if_dry`의 기준은 이번 풀버스트 종료 시각이다 — 버프 만료에는 그게 없다."""
        self.assertIn("if_dry", self._reload(
            {"policy": "finish_by_own_buff_end", "buff": OWN_BUFF, "if_dry": True}))

    def test_label_shows_both(self):
        self.assertEqual(
            _when_label(_norm_click_entry(
                {"window": "burst_charge", "mode": "tap", "rate": 4.0,
                 "gate": {"burst_stage": 3, "burst_user": WHO}}, "t")),
            f"burst_charge[B3={WHO}]")
        self.assertEqual(
            _when_label(_build_reload_when(
                {"policy": "finish_by_own_buff_end", "buff": OWN_BUFF, "margin": 0.1}, "t")[0]),
            f"own_buff_end@-0.1({OWN_BUFF})-reload_total")


if __name__ == "__main__":
    unittest.main()
