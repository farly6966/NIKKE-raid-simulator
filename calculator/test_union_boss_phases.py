"""회차 보스 구간: 기존 전투 불변, 전체 무적, 속성 관문, 부위별 파괴."""
import unittest
from unittest.mock import patch

from calculator.timeline import BuffManager, DT, simulate
from context.spec import build_config, build_squad


class UnionBossPhasesTest(unittest.TestCase):
    NAMES = ["리타", "크라운", "레이븐", "앨리스"]

    def run_battle(self, **enemy):
        squad = build_squad(self.NAMES)
        return simulate(squad, config=build_config(squad, {
            "duration": 30, "rng_mode": "expected",
        }), enemy={"code": "전격", "core_px": 0, **enemy})

    def test_empty_phases_preserve_existing_results(self):
        self.assertEqual(self.run_battle().char_total,
                         self.run_battle(boss_phases=[]).char_total)

    def test_core_window_has_no_core_hits_outside_its_half_open_interval(self):
        result = self.run_battle(core_px=1000, boss_phases=[{"kind": "core", "from": 5, "to": 10}])
        aiming = [ev for ev in result.hits if ev.core_frac is not None]
        self.assertTrue(any(ev.core_frac > 0 for ev in aiming if 5 <= round(ev.t, 9) < 10))
        self.assertTrue(all(ev.core_frac == 0 for ev in aiming if not 5 <= round(ev.t, 9) < 10))

    def test_full_duration_range_matches_static_and_expired_range_does_not_leak(self):
        weapons = ["AR", "SMG", "SG", "MG", "SR"]
        continuous = self.run_battle(boss_phases=[{"kind": "optimal_range", "from": 0, "to": 180, "weapons": weapons}])
        self.assertEqual(continuous.char_total, self.run_battle(optimal_range_weapons=weapons).char_total)
        partial = self.run_battle(boss_phases=[{"kind": "optimal_range", "from": 0, "to": 5, "weapons": weapons}])
        self.assertLess(sum(partial.char_total.values()), sum(continuous.char_total.values()))

    def test_pierce_gate_only_retains_hits_marked_at_attack_time(self):
        result = self.run_battle(boss_phases=[{"kind": "pierce_gate", "from": 0, "to": 180}])
        self.assertGreater(sum(result.char_total.values()), 0)
        self.assertTrue(all(ev.is_pierce or ev.hit_tag.startswith("pierce:") or ev.hit_tag == "pierce_damage" for ev in result.hits))

    def test_vanish_blocks_only_normal_attacks_inside_its_window(self):
        # 頭目消失（聯盟 S45 推薦設定新增）：普攻落空，技能傷害照常。
        from calculator.boss_pattern import _is_normal
        base = self.run_battle()
        full = self.run_battle(boss_phases=[{"kind": "vanish", "from": 0, "to": 180}])
        self.assertGreater(sum(full.char_total.values()), 0)
        self.assertLess(sum(full.char_total.values()), sum(base.char_total.values()))
        self.assertFalse(any(_is_normal(ev) for ev in full.hits))
        part = self.run_battle(boss_phases=[{"kind": "vanish", "from": 5, "to": 10}])
        self.assertFalse(any(_is_normal(ev) for ev in part.hits if 5 <= round(ev.t, 9) < 10))
        self.assertTrue(any(_is_normal(ev) for ev in part.hits if round(ev.t, 9) < 5))
        self.assertTrue(any(_is_normal(ev) for ev in part.hits if round(ev.t, 9) >= 10))

    def test_rocket_launchers_are_rejected_from_optimal_range_lists(self):
        # RL 沒有適正距離；收進清單會替 RL 普攻加上遊戲裡不存在的 ③ +30%（上游 f6bcbe9）。
        with self.assertRaises(ValueError):
            self.run_battle(optimal_range_weapons=["RL"])
        with self.assertRaises(ValueError):
            self.run_battle(boss_phases=[{"kind": "optimal_range", "from": 0, "to": 5, "weapons": ["RL"]}])
        with self.assertRaises(ValueError):
            self.run_battle(optimal_range_weapons=["Sg"])   # 不認得的名字同樣擋下
        # 有適正距離的五種照常通過。
        self.run_battle(optimal_range_weapons=["AR", "SMG", "SG", "MG", "SR"])

    def test_recommended_stage_delay_does_not_add_extra_reaction(self):
        squad = build_squad(self.NAMES)
        result = simulate(squad, config=build_config(squad, {
            "duration": 10, "rng_mode": "expected",
            "burst_switch_delay": 0.1, "burst_reaction": 0,
        }), verbose=True)
        casts = [entry for entry in result.log.burst_log
                 if entry.event in ("stage:1 사용", "stage:2 사용", "stage:3 사용")][:3]
        self.assertEqual([entry.event for entry in casts],
                         ["stage:1 사용", "stage:2 사용", "stage:3 사용"])
        self.assertEqual([round(entry.t, 9) for entry in casts], [3.0, 3.1, 3.2])

    def test_immunity_blocks_skills_and_normal_damage(self):
        base = self.run_battle()
        self.assertGreater(sum(base.char_total.values()), 0)
        blocked = self.run_battle(boss_phases=[{"kind": "immune", "from": 0, "to": 180}])
        self.assertEqual(sum(blocked.char_total.values()), 0)

    def test_element_gate_uses_enemy_code_not_weakness(self):
        result = self.run_battle(boss_phases=[{"kind": "element_gate", "from": 0, "to": 180}])
        self.assertGreater(result.char_total["리타"], 0)
        self.assertEqual(result.char_total["앨리스"], 0)

    def test_queued_skill_damage_uses_hit_time_at_phase_boundaries(self):
        # 템페스트는 발동 프레임 뒤에 수거되는 스킬이다. 작열 적이면 레이븐은
        # 우월 코드가 아니므로 두 관문 모두 막혀야 한다.
        baseline = self.run_battle(code="작열")
        hit = next(ev for ev in baseline.hits if ev.skill_name == "템페스트")
        self.assertGreater(hit.damage, 0)
        boundary = hit.t + DT / 2

        def same_hit(result):
            return [ev for ev in result.hits if ev.caster == hit.caster
                    and ev.skill_name == hit.skill_name and abs(ev.t - hit.t) < 1e-9]

        for kind in ("immune", "element_gate"):
            with self.subTest(kind=kind, boundary="end"):
                blocked = self.run_battle(code="작열", boss_phases=[
                    {"kind": kind, "from": 0, "to": boundary},
                ])
                self.assertEqual(same_hit(blocked), [])
            with self.subTest(kind=kind, boundary="start"):
                allowed = self.run_battle(code="작열", boss_phases=[
                    {"kind": kind, "from": boundary, "to": 180},
                ])
                self.assertEqual([ev.damage for ev in same_hit(allowed)], [hit.damage])

    def test_continuous_parts_match_static_parts(self):
        phase = [{"kind": "parts", "from": 0, "to": 180}]
        self.assertEqual(self.run_battle(has_parts=True).char_total,
                         self.run_battle(boss_phases=phase).char_total)
        self.assertGreater(self.run_battle(boss_phases=phase).char_total["레이븐"],
                           self.run_battle().char_total["레이븐"])

    def test_overlaps_do_not_stack_damage_but_each_part_breaks(self):
        phase = {"kind": "parts", "from": 0, "to": 5}
        single = self.run_battle(boss_phases=[phase])
        original = BuffManager.notify
        with patch.object(BuffManager, "notify", autospec=True, side_effect=original) as notify:
            double = self.run_battle(boss_phases=[phase, phase])
        self.assertEqual(single.char_total, double.char_total)
        destroyed = [call for call in notify.call_args_list if call.args[1] == "event:part_destroy"]
        self.assertEqual(len(destroyed), 2 * len(self.NAMES))
        self.assertTrue(all(abs(call.args[2] - 5) < .02 for call in destroyed))
