"""`[N발 유지]` 버프는 런타임 조건을 다시 보지 않는다.

스킬 텍스트 문법상 조건은 **발동 시점 게이트**이고 유지 표기는 버프 자체의 수명이다.
`[N초 유지]`는 그렇게 처리돼 있었는데 `[N발 유지]`는 아니었다 — 눈금이 초가 아니어서
`expires_at`이 `inf`로 남는 탓에 «지속·영구 버프만 재평가» 게이트를 그냥 통과했다.

그 결과 **자기 상태 이름을 `not_self_state:`로 막는 재부여 게이트가 스스로를 꺼 버렸다.**
베스티 : 택티컬 업 `미사일 가이드`는 차지 속도 100%·차지 대미지 58.5를 들고 있는데
실측 기여가 0이었다.

상류 Jgaram/nikke-calc `927a613`.
"""
import math
import unittest

from calculator.buff_manager import BuffManager, _has_runtime_cond
from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["베스티 : 택티컬 업", "크라운", "리타", "도로시", "네온"]


class HasRuntimeCondTest(unittest.TestCase):
    """게이트 자체의 단위 시험 — 세 수명 표기를 나란히 놓는다."""

    COND = ["not_self_state:미사일 가이드"]

    def test_finite_seconds_is_not_reevaluated(self):
        self.assertFalse(_has_runtime_cond(self.COND, 10.0))

    def test_permanent_is_reevaluated(self):
        """조건이 곧 유효 구간인 지속·영구 버프는 그대로 재평가한다."""
        self.assertTrue(_has_runtime_cond(self.COND, math.inf))

    def test_finite_bullets_is_not_reevaluated(self):
        """발수 만료도 유한 수명이다 — 초가 아닐 뿐이다."""
        self.assertFalse(_has_runtime_cond(self.COND, math.inf, 3))

    def test_no_runtime_prefix_is_never_reevaluated(self):
        self.assertFalse(_has_runtime_cond(["during_burst"], math.inf, -1))


class MissileGuideTest(unittest.TestCase):
    """베스티 : 택티컬 업 `미사일 가이드` — 자기 이름을 막는 게이트가 자기를 안 끈다."""

    def _sim(self):
        squad = build_squad(SQUAD)
        cfg = build_config(squad, {"duration": 120, "rng_mode": "expected"})
        return simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)

    def test_buff_actually_lands(self):
        """발동 직후 조회에서 차지 속도·차지 대미지가 실제로 실린다."""
        squad = build_squad(SQUAD)
        bm = BuffManager(squad)
        bm.battle_start(0.0)
        name = "베스티 : 택티컬 업"
        self.assertEqual(bm.get_buffs(name, "__enemy__", 1.0)["charge_speed_pct"], 0.0)

        # `미사일 가이드`는 `full_charge_hit`에 `not_self_state:미사일 가이드` 게이트로 붙는다.
        bm.notify("full_charge_hit", 1.0, name)
        buffs = bm.get_buffs(name, "__enemy__", 1.0)
        self.assertAlmostEqual(buffs["charge_speed_pct"], 100.0)
        self.assertGreater(buffs["charge_dmg_pct"], 0.0)

        # 같은 게이트를 공유하는 형제 효과가 **둘 다** 붙는다. 한 문장이 두 스탯을
        # 주는 버프를 파서가 둘로 가른 것이라, 게이트는 이 발동 **전** 상태를 가리킨다.
        self.assertAlmostEqual(buffs["charge_dmg_pct"], 58.5)

        # 한 번 걸린 뒤에는 게이트가 재부여만 막는다 — 값이 두 배가 되지 않는다.
        bm.notify("full_charge_hit", 1.1, name)
        self.assertAlmostEqual(
            bm.get_buffs(name, "__enemy__", 1.1)["charge_speed_pct"], 100.0)

    def test_buff_is_worth_real_damage(self):
        """실측 0이었던 버프다 — 살아나면 본인 딜이 배 이상 움직인다."""
        result = self._sim()
        bestie = result.char_total["베스티 : 택티컬 업"]
        # 수정 전 67,061,050 → 수정 후 154,708,726. 회귀 감지용 하한만 둔다.
        self.assertGreater(bestie, 120_000_000)

    def test_buff_expires_by_bullets_not_by_condition(self):
        """수명은 발수다 — 조건이 계속 거짓이어도 남은 발수까지는 살아 있다."""
        squad = build_squad(SQUAD)
        bm = BuffManager(squad)
        bm.battle_start(0.0)
        name = "베스티 : 택티컬 업"
        bm.notify("full_charge_hit", 1.0, name)
        self.assertAlmostEqual(
            bm.get_buffs(name, "__enemy__", 1.0)["charge_speed_pct"], 100.0)
        # `duration_bullets: 3` — 세 발까지는 살아 있고 네 번째 소모에서 사라진다.
        for i in range(3):
            bm.consume_bullet_buffs(name, 1.0 + i * 0.1)
            self.assertAlmostEqual(
                bm.get_buffs(name, "__enemy__", 1.0 + i * 0.1)["charge_speed_pct"], 100.0,
                msg=f"{i + 1}번째 소모에서 이미 사라졌다")
        bm.consume_bullet_buffs(name, 2.0)
        self.assertAlmostEqual(
            bm.get_buffs(name, "__enemy__", 2.0)["charge_speed_pct"], 0.0)


if __name__ == "__main__":
    unittest.main()
