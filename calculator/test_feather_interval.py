"""新生羽翼（니어 페더）攻擊週期：加算（上游 9db2b71，2026-10-09 移植）。"""
import json
import os
import unittest

from calculator.buff_manager import _feather_interval


class FeatherIntervalTest(unittest.TestCase):
    def test_each_extra_feather_removes_a_fixed_share_of_the_base(self):
        # 8 秒基本週期，每多一支少 16% —— 不是連乘 0.84。
        self.assertAlmostEqual(_feather_interval(8.0, 16.0, 1), 8.0)
        self.assertAlmostEqual(_feather_interval(8.0, 16.0, 4), 8.0 * 0.52)
        self.assertAlmostEqual(_feather_interval(8.0, 16.0, 6), 1.6)
        # 乘算會是 8 × 0.84^5 ≈ 3.35 秒；兩者差一倍以上，這條釘住「不是乘算」。
        self.assertLess(_feather_interval(8.0, 16.0, 6), 8.0 * 0.84 ** 5 / 2)

    def test_a_non_positive_interval_is_a_data_error(self):
        with self.assertRaises(ValueError):
            _feather_interval(8.0, 16.0, 8)     # 1 − 0.16×7 < 0
        with self.assertRaises(ValueError):
            _feather_interval(8.0, 20.0, 6)     # 剛好 0

    def test_roster_data_uses_the_additive_key(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, "data", "parsed_skills.json"), encoding="utf-8") as f:
            skills = json.load(f)
        refresh = [e for e in skills["아인"] if e.get("stat") == "feather_refresh"]
        self.assertEqual(len(refresh), 2)
        for eff in refresh:
            self.assertNotIn("feather_interval_mult", eff)
            self.assertEqual(eff["feather_interval_step_pct"], 16.0)
            # 槽位全滿時也必須是正的週期
            self.assertGreater(_feather_interval(eff["feather_interval_base"], 16.0,
                                                 len(eff["feather_slots"])), 0)


if __name__ == "__main__":
    unittest.main()
