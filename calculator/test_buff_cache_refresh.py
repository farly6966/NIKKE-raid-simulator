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


if __name__ == "__main__":
    unittest.main()
