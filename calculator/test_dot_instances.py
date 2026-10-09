"""持續傷害：同名單一實例、重新施加接續 tick 節拍（上游 197e91a · 129ace4，2026-10-09 移植）。"""
import collections
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad


def run(names, duration=60):
    squad = build_squad(names)
    return simulate(squad, config=build_config(squad, {"duration": duration, "rng_mode": "expected"}),
                    enemy={"code": "", "core_px": 0})


def dot_ticks(result, caster, skill):
    return sorted(round(ev.t, 6) for ev in result.hits
                  if ev.caster == caster and ev.hit_tag == "dot_damage" and ev.skill_name == skill)


class DotInstanceTest(unittest.TestCase):
    def test_same_named_dot_from_two_triggers_ticks_once_per_beat(self):
        # 胡桃 `해킹` 由「命中 36 次」與「爆裂」兩條路徑施加 —— 同一時刻不能有兩跳。
        ticks = dot_ticks(run(["리타", "크라운", "쿠루미", "앨리스", "나가"]), "쿠루미", "해킹")
        self.assertGreater(len(ticks), 30)
        self.assertEqual([t for t, n in collections.Counter(ticks).items() if n > 1], [])

    def test_reapplying_a_running_dot_keeps_the_one_second_beat(self):
        # 重新施加比節拍密集時，tick 間隔不能被拉開：跑起來之後相鄰兩跳都是 1 秒。
        for names, who, skill in ((["리타", "크라운", "쿠루미", "앨리스", "나가"], "쿠루미", "해킹"),
                                  (["리타", "크라운", "질", "앨리스", "나가"], "질", "산성탄 2")):
            with self.subTest(who=who):
                ticks = dot_ticks(run(names), who, skill)
                gaps = [round(b - a, 3) for a, b in zip(ticks, ticks[1:])]
                self.assertGreater(len(gaps), 30)
                # 中途到期後再掛會重新起拍，允許少數較長的間隔；但不能有明顯比 1 秒短的
                # （60 FPS 的量化誤差約 ±1 幀），而且絕大多數必須是 1 秒。
                self.assertGreaterEqual(min(gaps), 0.96)
                self.assertGreater(sum(1 for g in gaps if abs(g - 1.0) < 0.03) / len(gaps), 0.9)


if __name__ == "__main__":
    unittest.main()
