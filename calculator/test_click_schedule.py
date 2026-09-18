"""클릭 스케줄 — 톡톡이와 홀드는 같은 좌클릭에 실린 두 행위다.

上游 Jgaram/nikke-calc `8d16ea5`의 「클릭 스케줄」 부분.

종전에는 `tap_fire`·`hold`가 따로 있어서 「어느 구간에서 무엇을 하는가」를 적을 수 없었고,
실행층이 둘의 우선순위를 떠안았다. `control.click` 한 리스트로 합치고 **먼저 매치되는
항목이 이긴다** — 코드가 판정하지 않고 입력이 정한다.

두 가지를 나눠서 釘는다:

1. **종전 키는 그대로 돈다.** `tap_fire`·`hold`를 적으면 desugar가 같은 스케줄로 펴고,
   결과가 한 자리도 달라지지 않는다(baseline 29/29가 그 증인이고, 여기서는 직접 대조한다).
2. **새 표현이 실제로 늘었다.** 종전에 적을 수 없던 창(`own_full_burst` 톡톡이)이
   동작한다 — 이게 없으면 이 변경은 이득 없는 리팩터링이다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["미란다", "에이다", "아인", "타키나", "홍련"]
TAP = {"rate": 3.6, "release": 0.03}
HOLD_LEAD = 0.5


def _run(control):
    squad = build_squad(SQUAD, chars={"아인": {"control": control}}, no_layer={"아인"})
    cfg = build_config(squad, {"duration": 30, "rng_mode": "expected"})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    shots = sum(1 for hit in result.hits if hit.caster == "아인")
    return result.char_total["아인"], shots


class DesugarEquivalenceTest(unittest.TestCase):
    """종전 키와 그것을 편 스케줄은 **같은 결과**여야 한다."""

    def test_tap_only(self):
        legacy = _run({"tap_fire": dict(TAP)})
        explicit = _run({"click": [{"window": "always", "mode": "tap", **TAP}]})
        self.assertEqual(legacy, explicit)

    def test_hold_only(self):
        legacy = _run({"hold": {"policy": "own_full_burst", "lead": HOLD_LEAD}})
        explicit = _run({"click": [
            {"window": "own_full_burst", "mode": "hold", "lead": HOLD_LEAD}]})
        self.assertEqual(legacy, explicit)

    def test_tap_and_hold_together_keeps_hold_first(self):
        """**hold가 tap 앞에 온다.** 순서가 뒤집히면 홀드가 통째로 죽는다.

        유저 운용이 「본인 버스트 동안엔 들고 있다가 밖에서는 끊어친다」이기 때문이다
        (`calculator/test_tap_hold.py`가 釘고 있는 아인 + 에이다 조합).
        """
        legacy = _run({"tap_fire": dict(TAP),
                       "hold": {"policy": "own_full_burst", "lead": HOLD_LEAD}})
        explicit = _run({"click": [
            {"window": "own_full_burst", "mode": "hold", "lead": HOLD_LEAD},
            {"window": "always", "mode": "tap", **TAP},
        ]})
        self.assertEqual(legacy, explicit)

        # 순서를 뒤집으면 tap이 always로 다 먹어 홀드가 사라진다 — 같으면 안 된다.
        tap_first = _run({"click": [
            {"window": "always", "mode": "tap", **TAP},
            {"window": "own_full_burst", "mode": "hold", "lead": HOLD_LEAD},
        ]})
        self.assertNotEqual(explicit, tap_first,
                            "순서를 뒤집었는데 결과가 같다 — 「먼저 매치되는 항목이 이긴다」가 안 지켜진다")
        self.assertEqual(tap_first, _run({"tap_fire": dict(TAP)}),
                         "tap이 먼저면 톡톡이만 켠 것과 같아야 한다")


class NewExpressivenessTest(unittest.TestCase):
    def test_tap_can_be_scoped_to_own_full_burst(self):
        """종전 `tap_fire.window`는 `always`·`burst_charge` 둘뿐이었다.

        「본인 풀버스트 동안에만 끊어친다」는 적을 수 없던 조작이다.
        """
        scoped = _run({"click": [{"window": "own_full_burst", "mode": "tap", **TAP}]})
        always = _run({"click": [{"window": "always", "mode": "tap", **TAP}]})
        none = _run({})
        self.assertNotEqual(scoped, always, "창을 좁혔는데 전투 내내 톡톡이와 같다")
        self.assertNotEqual(scoped, none, "창 안에서 톡톡이가 전혀 안 걸렸다")


class SchemaGuardTest(unittest.TestCase):
    """닫힌 어휘 — 오타가 조용히 「아무 일도 안 함」이 되지 않는다."""

    def test_click_and_legacy_keys_cannot_mix(self):
        with self.assertRaises(ValueError) as cm:
            _run({"click": [{"mode": "tap", **TAP}], "tap_fire": dict(TAP)})
        self.assertIn("함께 쓸 수 없다", str(cm.exception))

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "always", "mode": "nope"}]})

    def test_unknown_window_is_rejected(self):
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "nope", "mode": "tap", **TAP}]})

    def test_unknown_entry_key_is_rejected(self):
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "always", "mode": "tap", "rat": 3.6}]})

    def test_after_own_fb_pairs_only_with_hold_judge(self):
        """역산 전용 슬롯이라 짝이 어긋나면 **조용히 평범한 홀드**가 된다."""
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "after_own_fb", "mode": "hold"}]})
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "own_full_burst", "mode": "hold_judge"}]})

    def test_tap_needs_a_rate(self):
        with self.assertRaises(ValueError):
            _run({"click": [{"window": "always", "mode": "tap"}]})


if __name__ == "__main__":
    unittest.main()
