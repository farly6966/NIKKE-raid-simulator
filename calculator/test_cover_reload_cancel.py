"""有限掩體到期時，進行中的裝填當場收掉 —— 1/3·2/3 出掩體的操作。

上游 Jgaram/nikke-calc `35d8c20` 的掩體那一半（`infinite_ammo` 那一半 fork 早就有了，
叫 `max_ammo_infinite`）。

掩體是**指定時刻**結束的，裝填跑完了沒有不影響它。原本 `_finish_reload` 的 docstring
自己記著「엄폐를 끊어 1/3·2/3만 채우고 나오는 컨트롤은 아직 표현하지 않는다」——
就是這裡補的。

彈夾武器（SG·RL 一部分）一次裝填只填最大裝彈的 1/3，自動會連續跑三次填滿。掩體中途
結束時：

- 彈匣還有彈 → 當場切掉裝填，直接回去射擊。
- 彈匣是 0 → 沒得射，等下一個彈夾進來的那一刻再切（連續填彈就此停在 1/3）。

用 네온（SG，`data/weapon_mechanics.json` 的 `clip_characters`）釘住。
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ["네온", "크라운", "리타", "노아"]


def _reload_log(sequence=None):
    chars = {"네온": {"control": {"sequence": sequence}}} if sequence else None
    squad = build_squad(SQUAD, chars=chars, no_layer={"네온"} if sequence else None)
    cfg = build_config(squad, {"duration": 40, "rng_mode": "expected"})
    result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
    return [e for e in result.log.reload_log if e.caster == "네온"]


def _events(log):
    return [e.event for e in log]


class CoverReloadCancelTest(unittest.TestCase):
    def test_no_control_runs_all_three_clips(self):
        """對照組：沒有掩體操作時，彈夾裝填照樣連跑到滿。"""
        events = _events(_reload_log())
        self.assertIn("재장전 완료", events)
        self.assertNotIn("재장전 취소(엄폐 해제)", events,
                         "沒下掩體操作卻切了裝填")
        self.assertGreaterEqual(events.count("클립 재장전"), 2,
                                "彈夾武器應該連續填彈 —— 하네스가 바뀌었는지 본다")

    def test_cover_end_with_ammo_cancels_at_once(self):
        """彈匣還有彈：掩體一到期就切掉裝填。

        t=10 進掩體（此時彈匣未滿，進掩體會掛上裝填），0.4 秒後到期 —— 三段彈夾
        填不完，所以切點必定落在裝填中途。
        """
        log = _reload_log([{"t": 10.0, "action": "cover", "duration": 0.4}])
        cancels = [e for e in log if e.event == "재장전 취소(엄폐 해제)"]
        self.assertTrue(cancels, "掩體到期沒有切掉進行中的裝填")
        self.assertAlmostEqual(10.4, cancels[0].t, places=1,
                               msg="切點不在掩體到期的那一刻")

    def test_cover_end_on_empty_waits_for_one_clip(self):
        """彈匣是 0：等一個彈夾進來再切，不是到期就切。

        0 發當場切掉毫無意義 —— 自動裝填會立刻再掛上，這個操作等於沒表現出來。
        """
        log = _reload_log([{"t": 14.0, "action": "cover", "duration": 0.2}])
        cancels = [e for e in log if e.event == "재장전 취소(엄폐 해제)"]
        self.assertTrue(cancels, "空彈匣掩體到期後沒有切掉裝填")
        self.assertGreater(
            cancels[0].t, 14.2,
            "0 發就當場切了 —— 應該等下一個彈夾進來（連續填彈停在 1/3）")


if __name__ == "__main__":
    unittest.main()
