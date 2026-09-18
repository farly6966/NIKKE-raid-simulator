"""첫 사이클에도 「다음 풀버스트 시작」 예측이 있다 — 장전컨 정책 B가 1사이클부터 걸린다.

上游 Jgaram/nikke-calc `c751e2a` + `54e30af`。

정책 B(`into_fb`)와 `if_dry`는 "다음 풀버스트가 언제 시작하나"를 **직전 사이클 주기
관측**으로 답한다. 관측치가 없는 첫 사이클에는 값이 아예 없어 정책이 통째로 안 걸렸다
(`context/CONTROL.md` §미구현·보류의 「정책 B 첫 사이클」).

남은 버스트 쿨타임으로 단계 사슬(1→2→3)을 굴리면 그 구멍이 메워진다. **관측이 있으면
관측이 이긴다** — 사슬은 앞으로 들어올 쿨감(`burst_cooldown_reduce`, 스킬이 뿌리는
즉시 효과)을 볼 수 없어 체계적으로 늦기 때문이다.

그리고 그 사슬 값은 **풀버스트가 끝나는 순간 한 번만** 잡아야 한다. 매 틱 다시 내면
정책의 앵커가 계속 바뀌어 「사이클당 1회」 가드가 무력화되고 같은 엄폐가 연달아 열린다.

`레이드_작열짬`(`context/snapshot.py`)의 앨리스가 이 repo에서 정책 B를 쓰는 유일한 자리다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["리타", "그레이브", "레이", "앨리스", "모더니아"]
CONTROL = {"reload": {"policy": "into_fb", "margin": 0.43}}


def _run(duration: float = 180.0):
    squad = build_squad(SQUAD, chars={"앨리스": {"control": CONTROL}})
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    return simulate(squad, config=cfg, enemy={"code": "풍압", "core_px": 0}, verbose=True)


def _covers(result):
    return [e for e in result.log.reload_log
            if e.caster == "앨리스" and "엄폐" in e.event]


def _fb_starts(result):
    return [e.t for e in result.log.burst_log if e.event == "full_burst 시작"]


class NextFbPredictionTest(unittest.TestCase):
    def test_policy_b_bites_in_the_first_cycle(self):
        """1번째 풀버스트 종료 ~ 2번째 시작 사이에 엄폐가 **있다**."""
        result = _run()
        starts = _fb_starts(result)
        self.assertGreaterEqual(len(starts), 2, "풀버스트가 두 번은 돌아야 판정이 된다")
        first_cycle = [c for c in _covers(result) if c.t < starts[1]]
        self.assertTrue(
            first_cycle,
            "첫 사이클에 장전컨이 안 걸렸다 — 관측치가 없을 때의 폴백이 빠졌다")

    def test_one_cover_per_cycle_not_a_chatter(self):
        """사슬 값이 사이클 내내 고정이라 「사이클당 1회」 가드가 살아 있다.

        매 틱 다시 예측하면 앵커가 매번 달라져 같은 엄폐가 연달아 열린다
        (상류 실측: t=0.25 · 1.92 · 3.58에 세 번 연속).
        """
        result = _run()
        covers = _covers(result)
        starts = _fb_starts(result)
        self.assertLessEqual(
            len(covers), len(starts),
            f"엄폐 {len(covers)}회 > 풀버스트 {len(starts)}회 — 사이클당 1회가 깨졌다")
        gaps = [b.t - a.t for a, b in zip(covers, covers[1:])]
        self.assertTrue(all(g > 1.0 for g in gaps),
                        f"엄폐가 1초 안에 연달아 열렸다: {[round(g, 3) for g in gaps]}")

    def test_reload_lands_where_margin_aims(self):
        """`margin`은 "재장전 완료가 풀버스트 시작 몇 초 뒤인가"다.

        첫 사이클의 예측이 맞는지를 이 한 값으로 잰다 — 예측이 틀리면 완료가
        margin에서 벗어난다.
        """
        result = _run()
        starts = _fb_starts(result)
        cover = next(c for c in _covers(result) if c.t < starts[1])
        done = next(e.t for e in result.log.reload_log
                    if e.caster == "앨리스" and e.t > cover.t and e.event == "재장전 완료")
        self.assertAlmostEqual(
            0.43, done - starts[1], delta=0.15,
            msg=f"재장전 완료가 풀버스트 시작 {done - starts[1]:+.3f}초 — margin 0.43에서 벗어났다")

    def test_observation_wins_once_it_exists(self):
        """관측이 생긴 뒤에는 사슬을 쓰지 않는다.

        2사이클 이후의 엄폐 시각은 이 이식 전과 **한 칸도 달라지지 않아야** 한다
        (첫 사이클이 만든 0.1초 연쇄 이동은 제외하고 본다). 여기서는 그 대리로
        「엄폐가 풀버스트 시작 직전에 온다」는 관계를 釘는다.
        """
        result = _run()
        starts = _fb_starts(result)
        for cover in _covers(result)[1:]:
            nxt = next((s for s in starts if s > cover.t), None)
            if nxt is None:
                continue
            self.assertLess(nxt - cover.t, 3.0,
                            f"엄폐 {cover.t:.3f} 뒤 풀버스트가 {nxt - cover.t:.3f}초 뒤 — 너무 이르다")


if __name__ == "__main__":
    unittest.main()
