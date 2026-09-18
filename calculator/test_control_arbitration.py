"""조작자는 한 명 — 카메라가 하나뿐이라는 제약.

上游 Jgaram/nikke-calc `8d16ea5`의 「조작 모드」 부분.

실제 조작은 **한 니케를 선택한 상태에서** 좌클릭·shift다. 계산기는 여러 니케에 컨트롤을
켜면 그걸 그대로 통과시켰고, `context/CONTROL.md` §미구현·보류가 그것을 「동시 컨트롤
1명 제약 — 검사하지 않음」으로 기록해 두고 있었다. `레이드_라피앨리스` baseline의 주석도
스스로를 「낙관적인 상한」이라고 적었다.

`_arbitrate_control()`이 **char tick 이전에** 카메라 주인을 정한다. 정책에는 부작용
없이 묻고(`_wants_control()`), 승자만 실제로 조작한다(`_owns()`). 뺏긴 쪽은 조작이
풀린다 — 엄폐가 해제되고 들고 있던 풀차지가 나간다.

`control_mode`:
  solo   (기본) 직렬화한다. 실제 조작에 가장 가깝다
  warn   전원 실행하고 겹침을 센다. **비현실적 상한**
  strict 겹치는 순간 실패. 유저가 시각을 갈라 적는다
"""
import collections
import unittest

import calculator.timeline as TL
from context.spec import build_config, build_squad

# `레이드_라피앨리스`와 같은 편성 — 컨트롤 둘이 실제로 겹치는 유일한 harness 편성이다.
SQUAD = ["리틀 머메이드", "크라운", "라피 : 레드 후드", "앨리스", "프리바티"]
RAPI_CTRL = {"reload": {"policy": "before_fb_end", "lead": 0.3}}


def _run(control_mode=None, duration=60.0, spy=False):
    squad = build_squad(SQUAD, chars={"라피 : 레드 후드": {"control": RAPI_CTRL}})
    extra = {"duration": duration, "rng_mode": "expected", "first_burst_time": 3.0}
    if control_mode is not None:
        extra["control_mode"] = control_mode
    cfg = build_config(squad, extra)

    owners = collections.Counter()
    if spy:
        orig = TL._arbitrate_control

        def _spy(t, bm, sq, cs, cam):
            orig(t, bm, sq, cs, cam)
            owners[bm.state.get("ctrl_owner") or ""] += 1

        TL._arbitrate_control = _spy
        try:
            result = TL.simulate(squad, config=cfg,
                                 enemy={"code": "풍압", "core_px": 0}, verbose=True)
        finally:
            TL._arbitrate_control = orig
        return result, owners
    return TL.simulate(squad, config=cfg,
                       enemy={"code": "풍압", "core_px": 0}, verbose=True), owners


class SoloArbitrationTest(unittest.TestCase):
    def test_at_most_one_operator_per_tick(self):
        """`ctrl_owner`는 언제나 0명 또는 1명이다 — 그게 이 제약의 전부다."""
        _, owners = _run(spy=True)
        self.assertTrue(owners, "조율이 한 번도 돌지 않았다")
        # Counter의 키가 곧 「그 틱의 주인」이므로 1명 초과가 구조적으로 불가능하다.
        # 여기서는 두 캐릭터가 **실제로 번갈아** 잡았는지를 본다.
        holders = {k for k in owners if k}
        self.assertEqual({"앨리스", "라피 : 레드 후드"}, holders,
                         f"두 조작자가 번갈아 잡아야 한다: {dict(owners)}")

    def test_the_constant_tapper_holds_it_most_of_the_time(self):
        """앨리스는 전투 내내 톡톡이라 계속 요청한다 — 라피는 장전컨 순간에만 가져간다.

        **에지 판정**이 없으면 이 비율이 무너진다: 계속 원하는 쪽이 매 틱 새 요청으로
        세어져 서로 끝없이 뺏는다.
        """
        _, owners = _run(spy=True)
        total = sum(owners.values())
        alice = owners["앨리스"] / total
        rapi = owners["라피 : 레드 후드"] / total
        self.assertGreater(alice, 0.8, f"앨리스 점유 {alice:.1%} — 너무 낮다")
        self.assertGreater(rapi, 0.0, "라피가 장전컨을 한 번도 못 걸었다")
        self.assertLess(rapi, 0.2, f"라피 점유 {rapi:.1%} — 장전컨치고 너무 길다")

    def test_camera_follows_the_operator(self):
        """카메라가 조작 주인을 따라간다.

        종전에는 컨트롤이 2명이면 `_resolve_cameras()`가 **3번 자리**로 떨어졌다.
        이 편성에서 3번 자리는 라피(MG) —— 논차지라 풀차지 게이지 배율을 **쓸 수 없는
        사람**에게 카메라가 180초 내내 묶여 있었다.
        """
        squad = build_squad(SQUAD, chars={"라피 : 레드 후드": {"control": RAPI_CTRL}})
        cfg = build_config(squad, {"duration": 60, "rng_mode": "expected"})
        self.assertEqual({"라피 : 레드 후드"}, set(TL._resolve_cameras(squad, cfg)),
                         "정적 유도가 3번 자리로 떨어지는 전제가 바뀌었다")
        _, owners = _run(spy=True)
        self.assertGreater(owners["앨리스"], owners["라피 : 레드 후드"],
                           "카메라가 실제 조작자를 따라가지 않는다")


class ControlModeTest(unittest.TestCase):
    def test_strict_fails_on_overlap(self):
        with self.assertRaises(ValueError) as cm:
            _run("strict")
        self.assertIn("여러 니케를 조작할 수 없다", str(cm.exception))

    def test_warn_runs_everyone_and_differs_from_solo(self):
        """`warn`은 상한이다 — 직렬화하지 않으므로 solo와 결과가 달라야 한다."""
        (warn, _), (solo, _) = _run("warn"), _run("solo")
        self.assertNotEqual(warn.char_total["앨리스"], solo.char_total["앨리스"],
                            "warn과 solo가 같다 — 직렬화가 아무것도 안 하고 있다")

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(Exception):
            _run("nope")


if __name__ == "__main__":
    unittest.main()
