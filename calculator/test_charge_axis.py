"""「是否蓄力」是和武器類型獨立的一個軸。

不是 SR/RL 就一定蓄力，反過來也一樣。正本是 CDN `조작 타입`（武器說明文裡有沒有
`{charge_time}` 的位置），推導成 `parsed_nikke.json` 的 `is_charge`。

RL 的 파스칼 是 `일반형` —— 武器技能原文就寫著「無法蓄力攻擊的武器」。以前因為
它是 RL 就被當成蓄力，結果拿不到 `charge_time`，把它放進隊伍時組 `CharState`
的當下就死掉。

上游 Jgaram/nikke-calc `8fd9963`。
"""
import json
import pathlib
import unittest

from calculator.timeline import _MECHANICS, CharState
from context.spec import build_squad

_ROOT = pathlib.Path(__file__).resolve().parent.parent
_NIKKE = json.loads((_ROOT / "data" / "parsed_nikke.json").read_text(encoding="utf-8"))
_SCRAPED = json.loads(
    (_ROOT / "scraper" / "nikke_scraped.json").read_text(encoding="utf-8"))
_CHARS = _SCRAPED.get("characters", _SCRAPED)


class ChargeAxisTest(unittest.TestCase):

    def test_every_character_carries_the_cdn_flag(self):
        """CDN 有給就要落到 `parsed_nikke.json`，不能只靠武器類型猜。"""
        missing = [n for n, c in _CHARS.items()
                   if (c.get("무기상세") or {}).get("조작 타입")
                   and "is_charge" not in _NIKKE.get(n, {})]
        self.assertEqual([], missing, f"{len(missing)} 人沒有 is_charge")

    def test_pascal_is_not_a_charge_weapon(self):
        """RL 但不能蓄力 —— 這是兩個軸會分開的唯一實例。"""
        self.assertEqual("RL", _NIKKE["파스칼"]["weapon_type"])
        self.assertFalse(_NIKKE["파스칼"]["is_charge"])
        cs = CharState(build_squad(["파스칼"])[0], 100000.0, "")
        self.assertEqual("auto", cs.fire_mode)

    def test_pascal_no_longer_needs_a_hand_written_exception(self):
        """資料自己會講，`_MANUAL_OVERRIDES` 不必再擋這一個。"""
        from scraper.parse_nikke import _MANUAL_OVERRIDES
        self.assertNotIn("파스칼", _MANUAL_OVERRIDES)
        self.assertNotIn("fire_mode", _NIKKE["파스칼"])

    def test_cdn_and_weapon_type_disagree_exactly_once(self):
        """全量比對 —— 兩個軸目前只在 파스칼 身上分開。

        這一條同時是「移植沒有改變行為」的證據：其餘 199 人兩種推導同值。
        """
        defaults = _MECHANICS["weapon_type_defaults"]
        disagree = []
        for name, char in _CHARS.items():
            w = char.get("무기상세") or {}
            kind = w.get("조작 타입")
            if kind is None:
                continue
            by_type = defaults.get(w.get("무기유형"), {}).get("type") == "charge"
            if (kind == "차지형") != by_type:
                disagree.append(name)
        self.assertEqual(["파스칼"], disagree)


if __name__ == "__main__":
    unittest.main()
