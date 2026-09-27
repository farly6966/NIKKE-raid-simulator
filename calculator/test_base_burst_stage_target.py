"""基本爆裂階段的目標判定不能被暫時替代的爆裂位置覆蓋。"""

import unittest

from calculator.buff_manager import BuffManager
from context.spec import build_squad


class BaseBurstStageTargetTest(unittest.TestCase):
    def test_rapi_as_b1_still_receives_base_b3_target(self):
        rapi = "라피 : 레드 후드"
        crown = "크라운"
        manager = BuffManager(
            build_squad([rapi, crown]),
            state={"burst_stages": {rapi: "1", crown: "2"},
                   "burst_casted": {rapi: True, crown: True}},
        )

        self.assertEqual([rapi], manager._resolve_target("allies_burst3", crown))
        self.assertEqual([rapi], manager._resolve_target("allies_burst_casted_burst3", crown))

        manager.state["burst_casted"][rapi] = False
        self.assertEqual([], manager._resolve_target("allies_burst_casted_burst3", crown))


if __name__ == "__main__":
    unittest.main()
