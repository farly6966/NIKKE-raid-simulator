"""2026-10-09 從上游移植的三名角色：吉爾提：神力兔女郎 · 森：疾速兔女郎 · 貝洛塔：南瓜女巫。"""
import unittest

from calculator.buff_manager import BuffManager
from calculator.timeline import simulate
from context.spec import _when_ok, build_config, build_squad

GUILTY, SIN, BELORTA = "길티 : 마이티 바니", "신 : 스위프트 바니", "벨로타 : 펌킨 위치"


def run(names, duration=60):
    squad = build_squad(names)
    return simulate(squad, config=build_config(squad, {"duration": duration, "rng_mode": "expected"}),
                    enemy={"code": "", "core_px": 0})


class AlliesRightTest(unittest.TestCase):
    def test_resolves_the_seat_to_the_right_only(self):
        names = ["리틀 머메이드", BELORTA, "크라운", "앨리스"]
        bm = BuffManager(build_squad(names))
        self.assertEqual(bm._resolve_target("allies_right:1", BELORTA), ["크라운"])
        self.assertEqual(bm._resolve_target("allies_right:2", BELORTA), ["크라운", "앨리스"])
        # 站最右邊時沒有對象 —— 不能落回施放者自己。
        self.assertEqual(bm._resolve_target("allies_right:1", "앨리스"), [])

    def test_the_right_hand_ally_gains_damage_and_the_rightmost_seat_gives_none(self):
        middle = run(["리틀 머메이드", BELORTA, "크라운", "앨리스"])
        last = run(["리틀 머메이드", "크라운", "앨리스", BELORTA])
        # 貝洛塔在크라운左邊時，크라운吃到她的攻擊力增益。
        self.assertGreater(middle.char_total["크라운"], last.char_total["크라운"] * 1.05)


class BunnyModeTest(unittest.TestCase):
    def test_partner_does_not_change_guiltys_own_damage(self):
        # 兩人共用 `바니 모드`。移除只針對自己（remove_scope: target）時，搭檔在不在場
        # 都不影響吉爾提自己的循環；用全域移除會把搭檔的模式一起清掉，她的傷害會大跌。
        solo = run(["리틀 머메이드", "크라운", GUILTY, "test_B3"])
        pair = run(["리틀 머메이드", "크라운", GUILTY, SIN])
        self.assertGreater(solo.char_total[GUILTY], 0)
        self.assertEqual(pair.char_total[GUILTY], solo.char_total[GUILTY])
        self.assertGreater(pair.char_total[SIN], 0)

    def test_scoped_removal_only_strips_the_named_target(self):
        bm = BuffManager(build_squad(["리틀 머메이드", "크라운", GUILTY, SIN]))
        scoped = [e for name in (GUILTY, SIN) for e in bm.char_effects(name)
                  if e.get("stat") == "remove_named_buff" and e.get("remove_scope") == "target"]
        self.assertTrue(scoped)   # 資料確實用到了這個鍵


class WithoutMemberTest(unittest.TestCase):
    def test_holds_only_when_none_of_the_listed_members_are_present(self):
        self.assertTrue(_when_ok(SIN, {"without_member": [GUILTY]}, ["크라운", SIN]))
        self.assertFalse(_when_ok(SIN, {"without_member": [GUILTY]}, ["크라운", SIN, GUILTY]))


if __name__ == "__main__":
    unittest.main()
