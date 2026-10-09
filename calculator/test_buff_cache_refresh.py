"""既有增益在同一影格更新後，下一次傷害查詢應讀到新層數。"""

import unittest

from calculator.buff_manager import BuffManager
from context.spec import build_squad


class BuffCacheRefreshTest(unittest.TestCase):
    def test_enemy_debuff_stack_is_visible_in_the_same_frame(self):
        name = "아스카 : WILLE"
        manager = BuffManager(build_squad([name]))
        effect = next(e for e in manager.char_effects(name)
                      if e.get("name") == "안티 AT 필드")

        manager._activate(effect, name, 1.0)
        self.assertAlmostEqual(
            manager.get_buffs(name, "__enemy__", 1.0)["received_dmg"], 0.83)

        manager._activate(effect, name, 1.0)
        self.assertAlmostEqual(
            manager.get_buffs(name, "__enemy__", 1.0)["received_dmg"], 1.66)

    def test_gauge_changes_drop_the_same_frame_cache(self):
        # `gauge_above:` 這類條件每次查詢都會讀量表 —— 量表一動，同一幀先算好的彙總就不能再用
        # （上游 a01402e；fork 原本只在增益重新觸發時丟快取）。
        name = "맥스웰 : 오디너리 미케닉"
        manager = BuffManager(build_squad([name]))
        charge = next(e for e in manager.char_effects(name)
                      if e.get("stat") == "gauge_charge" and e.get("gauge_id") == "과전류")
        manager.get_buffs(name, "__enemy__", 1.0)
        self.assertTrue(manager._buffs_cache)
        manager._activate(charge, name, 1.0)
        self.assertFalse(manager._buffs_cache)


if __name__ == "__main__":
    unittest.main()
