"""格拉維「過熱 II·III」的 30 次·60 次是**區域計數器**。

原文是「未來預知狀態適用**後**普攻命中時」，也就是每次未來預知都重新數。
舊寫法用全域 `hit_count:30/60` 搭配 `event:미래 예지`，兩個增益又是 `duration: -1`，
結果**和未來預知同一瞬間一起開**，30·60 次完全是裝飾。

上游 Jgaram/nikke-calc `b3ec538`。
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["그레이브", "크라운", "리타", "도로시", "네온"]


class GraveOverheatCounterTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        squad = build_squad(SQUAD)
        cfg = build_config(squad, {"duration": 120, "rng_mode": "expected"})
        cls.res = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0},
                           verbose=True, seed=1)

    def _first(self, name: str) -> float:
        for e in self.res.log.buff_events:
            if e.name == name and e.target == "그레이브" and e.kind == "activate":
                return e.t
        self.fail(f"{name} 一次都沒發動")

    def test_stages_do_not_open_at_the_same_instant(self):
        """三段不能同時開 —— 同時開就代表 30·60 次沒有作用。"""
        foresight = self._first("미래 예지")
        stage2 = self._first("과열 II")
        stage3 = self._first("과열 III")
        self.assertGreater(stage2, foresight, "과열 II 和未來預知同時開了")
        self.assertGreater(stage3, stage2, "과열 III 沒有晚於 과열 II")

    def _uptime(self, name: str) -> float:
        total, start = 0.0, None
        for e in self.res.log.buff_events:
            if e.target != "그레이브" or e.name != name:
                continue
            if e.kind == "activate":
                start = e.t
            elif e.kind == "expire" and start is not None:
                total += e.t - start
                start = None
        if start is not None:
            total += 120.0 - start
        return total

    def test_uptime_strictly_decreases_by_stage(self):
        """三段的啟動率必須逐段遞減。

        舊寫法下三個效果的啟動時刻一模一樣 —— 那就是 30·60 次沒有作用的證據。
        現在 30 次要花時間打，60 次更久，所以 미래 예지 > 과열 II > 과열 III。
        """
        fore = self._uptime("미래 예지")
        st2 = self._uptime("과열 II")
        st3 = self._uptime("과열 III")
        self.assertGreater(fore, st2, f"미래 예지 {fore:.2f}s vs 과열 II {st2:.2f}s")
        self.assertGreater(st2, st3, f"과열 II {st2:.2f}s vs 과열 III {st3:.2f}s")

    def test_gauge_effects_are_wired(self):
        """計數器本身要動 —— 累積在跑、每次未來預知重置一次。"""
        charge = [e for e in self.res.log.instant_events
                  if e.name == "과열 명중 누적"]
        reset = [e for e in self.res.log.instant_events
                 if e.name == "과열 명중 초기화"]
        self.assertGreater(len(charge), 100, "計數器沒有在累積")
        self.assertGreater(len(reset), 0, "計數器沒有被重置過")


if __name__ == "__main__":
    unittest.main()
