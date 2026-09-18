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


class ModeEndRestoresFullAmmoTest(unittest.TestCase):
    """模式結束 → 原武器回到滿彈（上游 `4f144d7`）。

    原本是還原成 `orig_ammo`，而那個值在「有發射的 tick」抓到的是**模式的剩餘
    彈藥**（1 發模式打完就是 0）。츠바이 因此每個循環帶著空彈匣出來，又在下一格
    打出一發**空彈匣的幽靈射擊**才開始裝填。
    """

    MEMBERS = ["츠바이", "나유타", "프리바티", "스노우 화이트 : 헤비암즈", "리틀 머메이드"]

    def _run(self):
        from calculator.timeline import simulate
        from context.spec import build_config

        squad = build_squad(self.MEMBERS)
        cfg = build_config(squad, {
            "no_burst_char": "리틀 머메이드",
            "first_burst_time": 3.0,
            "rng_mode": "expected",
        })
        return simulate(squad, config=cfg, enemy={}, verbose=True, seed=42)

    def test_mode_end_leaves_a_full_magazine(self):
        """模式結束的那一刻，原武器的彈匣就是滿的 —— 不是 0，也不用先裝填。"""
        import calculator.buff_manager as BM
        from calculator.timeline import simulate
        from context.spec import build_config

        seen: list[tuple[float, int]] = []
        squad = build_squad(self.MEMBERS)
        states: dict = {}

        original = BM.BuffManager.end_weapon_change

        def spy(self, name, t):
            original(self, name, t)
            cs = states.get(name)
            if cs is not None:
                seen.append((t, cs.ammo))

        BM.BuffManager.end_weapon_change = spy
        try:
            import calculator.timeline as TL
            made = TL.CharState.__init__

            def capture(cs, char, *a, **kw):
                made(cs, char, *a, **kw)
                states[cs.name] = cs

            TL.CharState.__init__ = capture
            try:
                cfg = build_config(squad, {
                    "no_burst_char": "리틀 머메이드",
                    "first_burst_time": 3.0,
                    "rng_mode": "expected",
                })
                simulate(squad, config=cfg, enemy={}, verbose=True, seed=42)
            finally:
                TL.CharState.__init__ = made
        finally:
            BM.BuffManager.end_weapon_change = original

        zwei = [(t, ammo) for t, ammo in seen if ammo is not None]
        self.assertTrue(zwei, "模式一次都沒結束過")
        empty = [(t, ammo) for t, ammo in zwei if ammo <= 1]
        self.assertEqual([], empty,
                         f"模式結束時彈匣是空的（會多打一發幽靈射擊）：{empty[:5]}")


if __name__ == "__main__":
    unittest.main()
