"""재진입은 단계마다 사이클당 한 번이다 — 두 번째 재진입이 슬롯을 다시 열면 갇힌다.

上游 Jgaram/nikke-calc `ffb1a6e`의 이식. 上游에서는 재진입 니케가 아니스 : 스타
하나뿐이라 **잠복 상태**였지만, 이 fork의 데이터에는 셋이 있다 —
아니스 : 스타 · 루피 : 윈터 쇼퍼 · 티아. 둘을 한 스쿼드에 넣는 순간 열린다.

증상은 조용하고 크다. 재진입 자리에서 뽑힌 동료가 **또** 재진입 니케면
`_try_use_stage`가 `advanced=False`로 돌아오고, 종전 코드는 그것을 「아무도 안 썼다」로
읽어 `_phase`를 `reenter:1`에 그대로 둔다. 되돌릴 길이 없다 — 2단계·3단계·풀버스트가
한 번도 오지 않고, 딜만 낮게 나온다(실측 60초 59.8M 대 346.1M).
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

# 셋 다 1단계다. 2·3단계를 채워야 사이클이 도는지 볼 수 있다.
_B2, _B3, _FILL = "타키나", "라피", "에이다"
REENTER_PAIR = ["아니스 : 스타", "루피 : 윈터 쇼퍼", _B2, _B3, _FILL]
SINGLE_REENTER = ["아니스 : 스타", "도로시", _B2, _B3, _FILL]   # 도로시는 재진입이 없다


def _burst_log(names, duration=60):
    squad = build_squad(names)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected"})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    return [(e.t, e.event, e.caster) for e in result.log.burst_log], result


class ReenterDoesNotLockStageTest(unittest.TestCase):
    def test_two_reenter_chars_still_reach_full_burst(self):
        log, _ = _burst_log(REENTER_PAIR)
        events = [e for _, e, _ in log]
        self.assertIn("stage:2 사용", events,
                      f"2단계가 오지 않았다 — 1단계에 갇혔다: {events}")
        self.assertIn("stage:3 사용", events)
        self.assertIn("full_burst 시작", events)

    def test_reenter_opens_once_per_stage_per_cycle(self):
        """한 사이클 = `stage:1`부터 다음 `stage:1` 직전까지. 그 안에 재진입은 1회."""
        log, _ = _burst_log(REENTER_PAIR)
        cycles, cur = [], None
        for _, event, _c in log:
            if event == "stage:1 사용":
                cur = []
                cycles.append(cur)
            elif cur is not None and event.startswith("reenter:1"):
                cur.append(event)
        self.assertTrue(cycles, "1단계가 한 번도 안 돌았다")
        for i, c in enumerate(cycles):
            self.assertLessEqual(len(c), 1, f"{i + 1}번째 사이클에 재진입이 {len(c)}회 열렸다")

    def test_lock_would_cost_most_of_the_damage(self):
        """갇히면 딜이 통째로 낮아진다 — 고쳤다는 것은 이 격차가 사라졌다는 뜻이다.

        재진입 하나짜리 스쿼드(도로시)와 비교한다. 둘은 2번 슬롯만 다르고
        나머지 넷이 같으니, 정상이라면 같은 자릿수여야 한다.
        """
        _, pair = _burst_log(REENTER_PAIR)
        _, single = _burst_log(SINGLE_REENTER)
        pair_total = sum(pair.char_total.values())
        single_total = sum(single.char_total.values())
        self.assertGreater(
            pair_total, single_total * 0.5,
            f"재진입 둘이면 딜이 반토막 이하다 ({pair_total:,.0f} vs {single_total:,.0f}) "
            "— 풀버스트가 안 돈다는 뜻이다")


class SingleReenterUnchangedTest(unittest.TestCase):
    """재진입이 하나뿐인 종전 경로는 한 자리도 움직이면 안 된다."""

    def test_single_reenter_cycle_shape(self):
        log, _ = _burst_log(SINGLE_REENTER, duration=20)
        shape = [e for _, e, _ in log][:5]
        self.assertEqual(shape, ["stage:1 사용", "reenter:1 사용", "stage:2 사용",
                                 "stage:3 사용", "full_burst 시작"])


if __name__ == "__main__":
    unittest.main()
