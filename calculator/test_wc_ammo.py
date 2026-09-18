"""武器變更模式的實效彈藥：何時量測、結束時填回多少。

上游 Jgaram/nikke-calc `d5ab3d0`（鎖存）與 `4f144d7`（結束時填滿彈）。
"""
import unittest

from calculator.timeline import CharState
from context.spec import build_squad


class _FakeBM:
    """`_full_ammo()` / `_buffed_ammo()` 只會碰到這兩個方法。"""

    def __init__(self, wc: dict | None, buffs: dict | None = None):
        self.wc = wc
        self.buffs = buffs or {}

    def get_weapon_change(self, name):
        return self.wc

    def get_buffs(self, name, target, t):
        return self.buffs


def _cs(name: str = "라플라스 : 얼티밋 히어로") -> CharState:
    return CharState(build_squad([name])[0], 100000.0, "")


class WcAmmoFullLatchTest(unittest.TestCase):
    """實效最大彈藥**只在填彈事件重新量測**。

    每個 tick 重量的話，模式進行中彈藥增益一掛上一掉，就只有結束條件
    （「發射所有彈藥時」）在晃，於是會生出彈藥打光卻結束不了的模式。
    """

    WC = {"max_ammo": 120, "max_ammo_buff_applies": True}

    def test_latched_until_a_refill_event(self):
        cs = _cs()
        bm = _FakeBM(self.WC)
        self.assertEqual(120, cs._full_ammo(bm, 0.0))

        # 模式進行中掛上彈藥增益 —— 實效值不動。
        bm.buffs = {"max_ammo_pct": 100.0}
        self.assertEqual(120, cs._full_ammo(bm, 1.0),
                         "模式中途重新量測了（鎖存失效）")

        # 填彈事件（進入模式 / 裝填完成）才重量。
        cs._wc_ammo_full = None
        self.assertEqual(240, cs._full_ammo(bm, 2.0))
        # 重量之後同樣鎖住。
        bm.buffs = {}
        self.assertEqual(240, cs._full_ammo(bm, 3.0))

    def test_no_bracket_phrase_means_printed_ammo_is_fixed(self):
        """沒有「使用武器變更時最大彈藥數效果更新」這句的模式，表記彈藥固定。"""
        cs = _cs()
        bm = _FakeBM({"max_ammo": 120}, {"max_ammo_pct": 100.0})
        self.assertEqual(120, cs._full_ammo(bm, 0.0))
        self.assertIsNone(cs._wc_ammo_full, "不該鎖存沒在算增益的路徑")

    def test_gauge_linked_mode_uses_its_entry_snapshot(self):
        """E.H.「인 투 더 헤븐」：表記 4 發是上限，實際是進入當下持有的量表數。"""
        cs = _cs("E.H.")
        bm = _FakeBM({"max_ammo": 4, "max_ammo_gauge_ref": "사제 탄창"})
        # 快照之前 → 表記值（維持舊行為）
        self.assertEqual(4, cs._full_ammo(bm, 0.0))
        cs._wc_dynamic_ammo = 1
        self.assertEqual(1, cs._full_ammo(bm, 0.1))


class BuffedAmmoTest(unittest.TestCase):
    """`_buffed_ammo()` 不看武器變更模式 —— 模式結束填回原武器滿彈時要用它。"""

    def test_ignores_the_active_weapon_change(self):
        cs = _cs()
        base = cs.weapon["max_ammo"]
        bm = _FakeBM({"max_ammo": 120, "max_ammo_buff_applies": True})
        self.assertEqual(base, cs._buffed_ammo(bm, 0.0))
        self.assertEqual(120, cs._full_ammo(bm, 0.0), "同一時刻 `_full_ammo` 才給模式彈藥")

    def test_applies_ammo_buffs(self):
        cs = _cs()
        bm = _FakeBM(None, {"max_ammo_pct": 50.0, "max_ammo_flat": 3.0})
        base = cs.weapon["max_ammo"]
        self.assertEqual(int(base * 1.5) + 3, cs._buffed_ammo(bm, 0.0))

    def test_never_drops_below_one(self):
        cs = _cs()
        bm = _FakeBM(None, {"max_ammo_pct": -999.0})
        self.assertEqual(1, cs._buffed_ammo(bm, 0.0))


if __name__ == "__main__":
    unittest.main()
