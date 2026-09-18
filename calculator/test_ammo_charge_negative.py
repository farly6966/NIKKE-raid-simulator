"""「彈藥 N% 移除」不會把彈匣打成負數。

上游 Jgaram/nikke-calc `93ec10a` 的殘留項之一（`context/UPSTREAM-MAPPING.md` A 區）。

`ammo_charge_pct` 扣的是**最大裝彈**的比例，不是彈匣裡現有的彈。所以半滿的彈匣
吃到 -100% 會變成負數，接下來的裝填得先從負的爬回 0 —— 那幾發是白丟的，
而且「彈藥打光」類的結束條件會跟著晚到。彈匣沒有負數這回事。

fork 裡吃到 -100 的有五個：그레이브「방열」· 라플라스 : 얼티밋 히어로
「일렉트릭 파워 풀 풀 차지 5」· 밀크 : 블루밍 바니「부끄러움 3」· 질「슈퍼 캅 2」·
드레이크 : 그레이트 빌런「오버 오버 드라이브 2」。

用 질 釘住：牠的「슈퍼 캅 2」掛在 `burst_cast`，每個循環都必定發生，不必湊條件。
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["질", "크라운", "리타", "노아"]


def _ammo_log(name: str, duration: float = 120.0):
    squad = build_squad(SQUAD)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected"})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    return [e for e in result.log.ammo_log if e.caster == name]


class AmmoChargeNegativeTest(unittest.TestCase):
    def test_removal_does_not_go_below_zero(self):
        log = _ammo_log("질")
        self.assertTrue(log, "질의 탄창 기록이 비었다 — 하네스가 바뀌었는지 본다")
        worst = min(e.ammo for e in log)
        self.assertGreaterEqual(
            worst, 0,
            f"「탄환 100% 제거」가 탄창을 {worst}까지 내렸다 — 클램프가 빠졌다",
        )

    def test_removal_actually_fires(self):
        """釘住這個測試真的走過移除路徑 —— 不是因為沒發動才沒有負數。

        `슈퍼 캅 2`는 버스트마다 최대 장탄 100%를 뺀다. 클램프가 있어도 탄창은
        0까지는 내려가야 한다. 한 번도 0이 안 나오면 이 시나리오는 아무것도 안 지킨다.
        """
        log = _ammo_log("질")
        self.assertIn(0, [e.ammo for e in log],
                      "탄창이 한 번도 0이 되지 않았다 — 제거 효과가 발동하지 않는 시나리오다")


if __name__ == "__main__":
    unittest.main()
