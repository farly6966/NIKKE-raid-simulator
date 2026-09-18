"""원문에 적힌 것이 파싱에서 빠지거나 규약을 벗어난 자리 — 셋.

上游 Jgaram/nikke-calc `fb37191`의 이식(둘) + 같은 결함을 원문 전수로 훑어 나온 하나.

세 자리 모두 **원문이 증인**이다. 테스트가 `scraper/nikke_scraped.json`을 직접 읽어
대조하므로, 나중에 다시 파싱하다 같은 실수를 해도 여기서 걸린다.
"""
import json
from pathlib import Path
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

ROOT = Path(__file__).resolve().parents[1]


def _parsed():
    return json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))


def _raw():
    return json.loads((ROOT / "scraper/nikke_scraped.json").read_text(encoding="utf-8"))


class ChargeTimeFixedNeedsItsValueTest(unittest.TestCase):
    """`charge_time_fixed`에 값이 없으면 **단축이 통째로 사라진다**.

    `_fixed_charge_time()`이 후보가 없을 때 `charge_time_base`로 폴백하기 때문이다.
    그 폴백은 「차지 속도 버프를 무시하고 표기 시간으로 고정」을 뜻하는 자리용이고,
    원문에 초 수치가 적혀 있으면 해당하지 않는다.
    """

    def test_every_charge_time_fixed_with_a_number_in_the_text_carries_it(self):
        raw, parsed = _raw(), _parsed()
        missing = []
        for name, effects in parsed.items():
            if not isinstance(effects, list):
                continue
            for effect in effects:
                if effect.get("stat") != "charge_time_fixed":
                    continue
                if effect.get("fixed_value") is not None:
                    continue
                text = json.dumps(raw.get(name, {}), ensure_ascii=False)
                # `차지 시간 N초로 고정` — 숫자가 적혀 있으면 값이 있어야 한다
                if "차지 시간" in text and "초로 고정" in text:
                    missing.append(f"{name} / {effect.get('name')}")
        self.assertEqual(missing, [], f"원문에 초 수치가 있는데 fixed_value가 없다: {missing}")

    def test_anis_star_shooting_star_is_0_7(self):
        effects = {e.get("name"): e for e in _parsed()["아니스 : 스타"]}
        self.assertEqual(effects["슈팅 스타2"]["fixed_value"], 0.7)

    def test_it_actually_shortens_the_charge(self):
        """값이 없던 시절엔 base(1.0초)로 폴백해 사격이 그만큼 느렸다."""
        squad = build_squad(["아니스 : 스타", "타키나", "라피", "에이다", "아인"])
        cfg = build_config(squad, {"duration": 60, "rng_mode": "expected"})
        result = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
        shots = [h.t for h in result.hits if h.caster == "아니스 : 스타"]
        self.assertGreater(len(shots), 0)
        # 버프가 걸린 10초 구간의 사격 간격이 base(1.0초 + 후딜)보다 짧아야 한다.
        gaps = sorted(b - a for a, b in zip(shots, shots[1:]) if 0 < b - a < 3)
        self.assertLess(gaps[len(gaps) // 2], 1.0,
                        f"중앙 사격 간격이 base 이상이다 — 고정값이 안 먹었다: {gaps[:8]}")


class CasterBasedHpStatTest(unittest.TestCase):
    """`시전자 기준`이 붙은 최대 체력 버프는 `hp_only_caster_based_pct`다.

    `max_hp_only_pct`(수령자 기준)로 적으면 아군이 **자기** 최대 체력의 비율을 받는다 —
    원문이 말하는 것과 기준이 다르다. `context/PARSING.md`가 둘을 따로 적고 있다.
    """

    def test_no_caster_based_text_is_parsed_as_receiver_based(self):
        raw, parsed = _raw(), _parsed()
        wrong = []
        for name, effects in parsed.items():
            if not isinstance(effects, list):
                continue
            has_receiver_based = any(e.get("stat") == "max_hp_only_pct" for e in effects)
            if not has_receiver_based:
                continue
            text = json.dumps(raw.get(name, {}), ensure_ascii=False)
            if "시전자 기준 최대 체력만" in text and "[최대 체력만" not in text:
                wrong.append(name)
        self.assertEqual(wrong, [],
                         f"원문이 「시전자 기준」인데 수령자 기준으로 파싱돼 있다: {wrong}")

    def test_the_two_known_ones(self):
        parsed = _parsed()
        for name, effect_name in (("솔린 : 프로스트 티켓", "티켓 효과"),
                                  ("드레이크 : 그레이트 빌런", "빌런, 지각하다")):
            with self.subTest(name=name):
                effect = next(e for e in parsed[name] if e.get("name") == effect_name)
                self.assertEqual(effect["stat"], "hp_only_caster_based_pct")


if __name__ == "__main__":
    unittest.main()
