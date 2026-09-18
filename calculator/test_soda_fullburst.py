"""소다 : 트윙클링 바니 한 자리에서 만난 결함 둘 — 연장이 짧고, 문턱이 낮았다.

上游 Jgaram/nikke-calc `c882541`의 이식.

둘은 서로를 가린다. 연장이 짧아 골든 칩이 마르고, 문턱이 한 칸 낮아 **마른 것을
못 잡았다** — 열려서는 안 될 단계가 열리니 수치가 그럴듯해 보인다.
"""
import json
from pathlib import Path
import re
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

ROOT = Path(__file__).resolve().parents[1]
SODA = "소다 : 트윙클링 바니"
SQUAD = ["토브", "나유타", SODA, "도로시 : 세렌디피티", "드레이크"]


def _run(duration=90):
    squad = build_squad(SQUAD)
    cfg = build_config(squad, {"duration": duration, "rng_mode": "expected",
                               "first_burst_time": 3.0})
    return simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)


class FullburstDurationDedupTest(unittest.TestCase):
    """중복 제거 키가 caster 하나면 **한 캐릭터의 서로 다른 두 효과**가 뭉개진다.

    all_allies로 N명에게 등록되는 같은 효과를 한 번만 세려던 키인데, 소다의
    `시간 연장 I`(+2)·`시간 연장 II`(+3)는 원문이 `[하위 효과 중복 적용]`이라
    둘 다 붙어야 한다. caster로 접으면 먼저 만난 하나만 남아 +2에서 그친다.
    """

    def test_both_extensions_stack_to_fifteen_seconds(self):
        result = _run()
        log = result.log.burst_log
        starts = [e.t for e in log if e.event == "full_burst 시작"]
        ends = [e.t for e in log if e.event == "full_burst 종료"]
        lengths = [round(b - a, 2) for a, b in zip(starts, ends)]
        self.assertTrue(lengths, "풀버스트가 한 번도 안 돌았다")
        self.assertEqual(set(lengths), {15.0},
                         f"10 + 2 + 3 = 15초여야 한다 (12초면 하나로 뭉개진 것): {lengths}")

    def test_the_two_extensions_are_separate_effects(self):
        """이 테스트가 지키는 전제 — 둘은 같은 caster·같은 스킬의 다른 효과다."""
        parsed = json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))
        exts = [e for e in parsed[SODA] if e.get("stat") == "fullburst_duration"]
        self.assertEqual(len(exts), 2)
        self.assertEqual({e["name"] for e in exts}, {"시간 연장 I", "시간 연장 II"})
        self.assertEqual(len({e.get("source") for e in exts}), 1,
                         "같은 스킬이어야 caster 키가 둘을 접는다 — 전제가 깨졌다")


class StackThresholdTest(unittest.TestCase):
    """`N 중첩 이상`은 `self_stack_above:…:N`이다 — N-1이 아니다.

    `self_stack_above`는 두 판정 지점 모두 `현재 < 문턱이면 거짓`이므로 이미
    「이상」이다. 문턱을 한 칸 내리면 한 중첩 일찍 열린다.
    `context/PARSING.md` §`[스택명] N 중첩 이상이라면`가 정본이다.
    """

    def test_no_character_has_an_off_by_one_threshold(self):
        parsed = json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))
        raw = json.loads((ROOT / "scraper/nikke_scraped.json").read_text(encoding="utf-8"))
        bad = []
        for name, effects in parsed.items():
            if not isinstance(effects, list):
                continue
            text = json.dumps(raw.get(name, {}), ensure_ascii=False)
            in_text = {int(m.group(1)) for m in re.finditer(r"(\d+) 중첩 이상", text)}
            if not in_text:
                continue
            parsed_thresholds = {
                int(m.group(2))
                for effect in effects
                for cond in (effect.get("trigger") or {}).get("condition") or []
                for m in [re.match(r"self_stack_above:(.+):(\d+)$", cond)] if m
            }
            if parsed_thresholds and not parsed_thresholds <= in_text:
                bad.append(f"{name}: 원문 {sorted(in_text)} / 파싱 {sorted(parsed_thresholds)}")
        self.assertEqual(bad, [], f"원문에 없는 문턱으로 파싱돼 있다: {bad}")

    def test_soda_thresholds_are_ten_twenty_thirty(self):
        parsed = json.loads((ROOT / "data/parsed_skills.json").read_text(encoding="utf-8"))
        got = {
            effect["name"]: cond
            for effect in parsed[SODA]
            for cond in (effect.get("trigger") or {}).get("condition") or []
            if cond.startswith("self_stack_above:골든 칩:")
        }
        self.assertEqual(got, {
            "시간 연장 I": "self_stack_above:골든 칩:10",
            "시간 연장 II": "self_stack_above:골든 칩:20",
            "고 어헤드, 소다! 2": "self_stack_above:골든 칩:20",
            "고 어헤드, 소다! 3": "self_stack_above:골든 칩:30",
        })


if __name__ == "__main__":
    unittest.main()
