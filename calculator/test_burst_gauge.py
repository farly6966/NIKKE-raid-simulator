"""버스트 게이지 실누적 모델.

풀버스트 종료 후 무조건 `burst_regen_time`(2.0초)이던 사이클을, 실제로 명중한
히트가 만든 게이지로 판정할 수 있게 한다. 두 모델은 `burst_gauge_mode`로 갈리고
기본값은 `"fixed"` — 종전 baseline이 한 줄도 움직이지 않는다.

식은 CDN 값만으로 닫힌다(자유 파라미터 0):

    히트당 게이지 = burst_energy            (parsed_nikke, `target_burst_energy_pershot`/10000)
    발당 게이지   = burst_energy × pellets × muzzles
    풀차지        = × full_charge_mult/100  (**카메라가 그 니케를 볼 때만**, 2024-04-25 패치)
    충전 속도 %   = × (1 + burst_charge_speed_pct/100)   — **쏜 사람** 기준

아래 발수는 전부 유저 인게임 실측이 근거다 — 크라운(MG) 1000발 · 목단(AR) 200발 ·
루주(SR) 카메라 有 7발 / 無 18발.
"""
import unittest

from calculator.timeline import simulate, _resolve_cameras
from context.spec import build_config, build_squad


def _run(names, cfg=None, chars=None, enemy=None):
    squad = build_squad(names, chars=chars)
    config = build_config(squad, {
        "duration": 60,
        "rng_mode": "expected",
        "burst_gauge_mode": "accumulate",
        **(cfg or {}),
    })
    return simulate(squad, config=config,
                    enemy={"code": "", "core_px": 0, **(enemy or {})}, verbose=True)


def _first_cycle(result):
    """첫 만충까지의 게이지 가산 내역. 게이지가 줄어드는 순간에서 끊는다."""
    out, prev = [], 0.0
    for e in result.log.gauge_log:
        if e.gauge < prev - 1e-9:
            break
        out.append(e)
        prev = e.gauge
    return out


# 풀버스트가 실제로 도는 5인 편성 (snapshot `레이드_이브레이븐`과 같은 구성).
# 1인·4인 스쿼드는 1~3단계가 다 차지 않아 풀버스트에 이르지 못한다.
FULL_SQUAD = ["목단", "민트", "프리카", "이브", "레이븐"]


def _shots_to_full(result):
    """첫 만충까지 걸린 **발수**. 같은 시각의 가산은 한 발로 센다(총구·펠릿 분리 방지)."""
    return len({round(e.t, 6) for e in _first_cycle(result) if e.source.startswith("weapon")})


class BurstEnergyDataTest(unittest.TestCase):
    """히트당 게이지는 3계층 해석(_pick)으로 캐릭터별 실값이 잡힌다."""

    def test_per_character_value_wins_over_weapon_type_default(self):
        from calculator.timeline import CharState, _NIKKE

        # 목단은 AR이지만 무기군 기본값 0.4가 아니라 자기 값 0.5다.
        self.assertEqual(_NIKKE["목단"]["weapon_type"], "AR")
        cs = CharState(build_squad(["목단"])[0], 100000.0, "")
        self.assertAlmostEqual(cs.burst_energy, 0.5)

    def test_dummy_falls_back_to_weapon_type_default(self):
        """CDN 레코드가 없는 더미는 무기군 기본값으로 떨어진다."""
        from calculator.timeline import CharState, _NIKKE, _MECHANICS

        wt = _NIKKE["test_B1"]["weapon_type"]
        self.assertNotIn("burst_energy", _NIKKE["test_B1"])
        cs = CharState(build_squad(["test_B1"])[0], 100000.0, "")
        self.assertAlmostEqual(
            cs.burst_energy,
            _MECHANICS["weapon_type_defaults"][wt]["burst_energy"])


class AccumulateCycleTest(unittest.TestCase):
    """실측 발수와 맞는가 — 모델 전체를 한 줄로 검산하는 자리다."""

    def test_mg_needs_1000_shots(self):
        # 크라운 0.1%/히트 → 1000발.
        self.assertEqual(_shots_to_full(_run(["크라운"])), 1000)

    def test_ar_needs_200_shots(self):
        # 목단 0.5%/히트 → 200발.
        self.assertEqual(_shots_to_full(_run(["목단"])), 200)

    def test_full_charge_multiplier_needs_camera(self):
        """루주 5.8%/히트, 풀차지 배율 250%는 **카메라가 볼 때만** 붙는다."""
        # 1인 스쿼드라 `_resolve_camera`가 그 한 명을 고른다 → 14.5%/발 → 7발.
        self.assertEqual(_shots_to_full(_run(["루주"])), 7)
        # 카메라를 명시적으로 비우면 배율이 없다 → 5.8%/발 → 18발.
        self.assertEqual(_shots_to_full(_run(["루주"], {"camera": ""})), 18)

    def test_muzzles_multiply_the_gain(self):
        """총구 2개는 한 발에 히트가 둘이라 게이지도 두 배다 (노아 RL 3.0 × 2총구)."""
        from calculator.timeline import CharState

        cs = CharState(build_squad(["노아"])[0], 100000.0, "")
        self.assertEqual(cs.muzzles, 2)
        per_shot = cs._burst_gain({}, cs.pellets * cs.muzzles)
        self.assertAlmostEqual(per_shot, 6.0)

    def test_pellets_multiply_the_gain(self):
        """SG는 펠릿마다 히트다 (네온 0.9 × 10펠릿 = 발당 9%)."""
        from calculator.timeline import CharState

        cs = CharState(build_squad(["네온"])[0], 100000.0, "")
        self.assertEqual(cs.pellets, 10)
        self.assertAlmostEqual(cs._burst_gain({}, cs.pellets * cs.muzzles), 9.0)


class ChargingWindowTest(unittest.TestCase):
    """충전 창·상한·소모 규칙은 `BuffManager.add_burst_gauge()` 한 곳에 있다."""

    def test_gauge_never_exceeds_100(self):
        result = _run(FULL_SQUAD)
        self.assertTrue(result.log.gauge_log)
        self.assertLessEqual(max(e.gauge for e in result.log.gauge_log), 100.0 + 1e-9)

    def test_gauge_is_consumed_at_stage_one(self):
        """만충 뒤 첫 가산은 다시 바닥에서 출발한다 — 초과분은 이월되지 않는다."""
        result = _run(FULL_SQUAD)
        log = result.log.gauge_log
        drops = [i for i in range(1, len(log)) if log[i].gauge < log[i - 1].gauge - 1e-9]
        self.assertTrue(drops, "사이클이 한 번도 안 돌았다")
        first = log[drops[0]]
        self.assertAlmostEqual(first.gauge, first.amount)

    def test_no_charging_during_burst(self):
        """풀버스트가 끝나기 전까지는 한 푼도 안 찬다."""
        result = _run(FULL_SQUAD)
        windows = [(e.t, e.event) for e in result.log.burst_log]
        starts = [t for t, ev in windows if "full_burst 시작" in ev]
        ends = [t for t, ev in windows if "full_burst 종료" in ev]
        self.assertTrue(starts and ends, "풀버스트가 없다")
        for lo, hi in zip(starts, ends):
            inside = [e for e in result.log.gauge_log if lo + 1e-9 < e.t < hi - 1e-9]
            self.assertEqual(inside, [], f"풀버스트 {lo}~{hi} 중에 게이지가 찼다")

    def test_immune_window_blocks_charging(self):
        """족자 중에는 평타가 빗나가니 게이지도 안 찬다 (`immune_blocks_burst`)."""
        result = _run(["목단"], enemy={"immune_windows": [[5.0, 15.0]]})
        inside = [e for e in result.log.gauge_log if 5.0 <= e.t < 15.0]
        self.assertEqual(inside, [])

    def test_option_off_keeps_charging_in_immune_window(self):
        result = _run(["목단"], {"immune_blocks_burst": False},
                      enemy={"immune_windows": [[5.0, 15.0]]})
        inside = [e for e in result.log.gauge_log if 5.0 <= e.t < 15.0]
        self.assertTrue(inside)


class ChargeSpeedTest(unittest.TestCase):
    def test_burst_charge_speed_pct_scales_the_gain(self):
        """충전 속도 %는 가산 전체에 곱연산이다."""
        from calculator.timeline import CharState

        cs = CharState(build_squad(["목단"])[0], 100000.0, "")
        self.assertAlmostEqual(cs._burst_gain({}, 1), 0.5)
        self.assertAlmostEqual(cs._burst_gain({"burst_charge_speed_pct": 50.0}, 1), 0.75)

    def test_relic_quantum_cube_is_no_longer_unsupported(self):
        """렐릭 퀀텀 큐브가 실제 버프로 등록된다 — `unsupported`가 떨어졌다."""
        from calculator.buff_manager import BuffManager

        squad = build_squad(["목단"], chars={
            "목단": {"cube": {"name": "렐릭 퀀텀 큐브", "level": 15}},
        })
        bm = BuffManager(squad)
        bm.battle_start(0.0)
        self.assertGreater(
            bm.get_buffs("목단", "__enemy__", 1.0)["burst_charge_speed_pct"], 0.0)


class CameraResolutionTest(unittest.TestCase):
    """카메라는 버충 담당 → 명시 → 컨트롤 → 3번 자리 순으로 정해진다."""

    def _squad(self, controlled=(), burst_charge=()):
        out = []
        for n in ("A", "B", "C", "D", "E"):
            ctrl = {}
            if n in controlled:
                ctrl = {"tap_fire": {"rate": 3.0}}
            if n in burst_charge:
                ctrl = {"tap_fire": {"rate": 3.0, "window": "burst_charge"}}
            out.append({"name": n, **({"control": ctrl} if ctrl else {})})
        return out

    def test_explicit_name_wins(self):
        self.assertEqual(_resolve_cameras(self._squad(), {"camera": "D"}), frozenset({"D"}))

    def test_empty_string_means_nobody(self):
        """빈 문자열은 «아무도 안 본다»는 뜻이다 — 유도로 떨어지지 않는다."""
        self.assertEqual(_resolve_cameras(self._squad(("B",)), {"camera": ""}), frozenset())

    def test_single_control_takes_the_camera(self):
        self.assertEqual(_resolve_cameras(self._squad(("B",)), {}), frozenset({"B"}))

    def test_two_controls_fall_back_to_slot_three(self):
        self.assertEqual(_resolve_cameras(self._squad(("B", "D")), {}), frozenset({"C"}))

    def test_no_control_falls_back_to_slot_three(self):
        self.assertEqual(_resolve_cameras(self._squad(), {}), frozenset({"C"}))

    def test_shared_mode_gives_every_controlled_nikke(self):
        self.assertEqual(
            _resolve_cameras(self._squad(("B", "D")), {"camera_mode": "shared"}),
            frozenset({"B", "D"}))

    def test_shared_mode_without_control_still_falls_back(self):
        self.assertEqual(
            _resolve_cameras(self._squad(), {"camera_mode": "shared"}), frozenset({"C"}))

    def test_burst_charge_carrier_takes_the_camera_alone(self):
        """버충 담당이 있으면 `camera_mode`도 명시 카메라도 보지 않는다."""
        squad = self._squad(controlled=("D",), burst_charge=("B",))
        self.assertEqual(_resolve_cameras(squad, {}), frozenset({"B"}))
        self.assertEqual(
            _resolve_cameras(squad, {"camera_mode": "shared"}), frozenset({"B"}))
        self.assertEqual(_resolve_cameras(squad, {"camera": "E"}), frozenset({"B"}))

    def test_two_burst_charge_carriers_fail_loudly(self):
        with self.assertRaises(ValueError):
            _resolve_cameras(self._squad(burst_charge=("B", "D")), {})

    def test_single_mode_rejects_a_list_of_two(self):
        with self.assertRaises(ValueError):
            _resolve_cameras(self._squad(), {"camera": ["B", "D"]})

    def test_shared_mode_accepts_a_list(self):
        self.assertEqual(
            _resolve_cameras(self._squad(), {"camera": ["B", "D"], "camera_mode": "shared"}),
            frozenset({"B", "D"}))

    def test_unknown_camera_mode_fails_loudly(self):
        with self.assertRaises(ValueError):
            _resolve_cameras(self._squad(), {"camera_mode": "nope"})


class BurstChargeControlTest(unittest.TestCase):
    """버충 컨트롤 — 톡톡이를 **충전 창 안에서만** 건다.

    실전 조작 그대로다: 충전 창에서는 톡톡이로 발수를 벌어 사이클을 당기고, 창 밖에서는
    풀차지로 배율을 챙긴다. 창 구분 없이 톡톡이만 켜면 풀차지 게이지 배율(×2.5)이
    통째로 죽어 사이클이 오히려 느려진다 — 아래 세 갈래가 그것을 보인다.
    """

    SQUAD = ["루주", "크라운", "마스트 : 로망틱 메이드", "신데렐라", "메이든 : 아이스 로즈"]

    def _run(self, tap):
        chars = {"루주": {"control": {"tap_fire": tap}}} if tap else None
        return _run(self.SQUAD, {"duration": 180, "first_burst_time": 3.0}, chars=chars)

    @staticmethod
    def _bursts(result):
        return sum(1 for e in result.log.burst_log if "full_burst 시작" in e.event)

    def test_window_beats_both_extremes(self):
        plain = self._run(None)
        always = self._run({"rate": 3.0})
        windowed = self._run({"rate": 3.0, "window": "burst_charge"})

        # 창 구분 없는 톡톡이는 **손해다** — 풀차지 배율을 버리는 만큼 사이클이 느려진다.
        self.assertLess(self._bursts(always), self._bursts(plain))
        self.assertLess(always.squad_total, plain.squad_total)
        # 창을 가르면 둘 다 이긴다.
        self.assertGreater(self._bursts(windowed), self._bursts(plain))
        self.assertGreater(windowed.squad_total, plain.squad_total)

    def test_window_mixes_both_shot_kinds(self):
        """창 안은 논차지, 창 밖은 풀차지 — 한 전투에 둘 다 나온다."""
        windowed = self._run({"rate": 3.0, "window": "burst_charge"})
        rouge = [e for e in windowed.log.gauge_log if e.caster == "루주"]
        kinds = {e.source for e in rouge}
        self.assertIn("weapon", kinds, "충전 창 안에서 톡톡이가 안 걸렸다")
        self.assertIn("weapon:full_charge", kinds, "창 밖 풀차지가 게이지에 안 잡혔다")

        # 창 구분 없는 톡톡이는 풀차지가 한 발도 없다.
        always = self._run({"rate": 3.0})
        self.assertEqual(
            {e.source for e in always.log.gauge_log if e.caster == "루주"}, {"weapon"})

    def test_carrier_takes_the_camera_from_slot_three(self):
        """컨트롤이 없으면 카메라는 3번 자리, 버충 담당이 생기면 그 사람에게 간다."""
        plain = self._run(None)
        windowed = self._run({"rate": 3.0, "window": "burst_charge"})

        def focus(result):
            return next(e.event for e in result.log.burst_log if "카메라 초점" in e.event)

        self.assertIn(self.SQUAD[2], focus(plain))
        self.assertIn("루주", focus(windowed))

    def test_unknown_window_fails_loudly(self):
        from calculator.timeline import CharState

        char = build_squad(["루주"], chars={
            "루주": {"control": {"tap_fire": {"rate": 3.0, "window": "nope"}}},
        })[0]
        with self.assertRaises(ValueError):
            CharState(char, 100000.0, "")


class ReloadPolicyCTest(unittest.TestCase):
    """장전컨 정책 C `finish_by_fb_end` — 충전 창을 **만탄으로** 연다.

    버충 컨트롤의 나머지 절반이다. 창은 2~5초뿐이라 거기서 재장전이 걸리면 그 사이클의
    버충이 통째로 날아간다. A(`before_fb_end`)와 목적이 다르다 — A는 재장 0초 구간을
    노리는 정책이라 `lead`가 상수여도 되지만, 이쪽은 **재장전을 실제로 끝내야** 하므로
    진입 시각이 그 시점의 재장전 시간에서 나온다.
    """

    SQUAD = ["루주", "크라운", "마스트 : 로망틱 메이드", "신데렐라", "메이든 : 아이스 로즈"]

    def _run(self, ctrl, duration=180):
        chars = {"루주": {"control": ctrl}} if ctrl else None
        return _run(self.SQUAD, {"duration": duration, "first_burst_time": 3.0}, chars=chars)

    def test_unknown_policy_fails_loudly(self):
        from calculator.timeline import CharState

        char = build_squad(["루주"], chars={
            "루주": {"control": {"reload": {"policy": "nope"}}},
        })[0]
        with self.assertRaises(ValueError):
            CharState(char, 100000.0, "")

    def test_reload_finishes_before_the_window_opens(self):
        """재장전 **완료**가 풀버스트 종료보다 앞서야 정책이 제 일을 한 것이다."""
        result = self._run({"reload": {"policy": "finish_by_fb_end"}}, duration=60)
        ends = [e.t for e in result.log.burst_log if "full_burst 종료" in e.event]
        self.assertTrue(ends)
        starts = [e.t for e in result.log.reload_log
                  if e.caster == "루주" and e.event == "엄폐 시작(장전컨)"]
        dones = [e.t for e in result.log.reload_log
                 if e.caster == "루주" and e.event == "재장전 완료"]
        self.assertTrue(starts, "정책 C가 한 번도 안 걸렸다")

        first_end = ends[0]
        # 이 사이클의 엄폐는 풀버스트 종료 전에 시작하고,
        entered = [t for t in starts if t < first_end]
        self.assertTrue(entered, "풀버스트 종료 전에 엄폐하지 않았다")
        # 재장전도 종료 전에 끝나 있어야 한다.
        self.assertTrue(any(entered[0] <= t < first_end for t in dones),
                        "창이 열리기 전에 재장전이 안 끝났다")

    def test_policy_c_adds_a_full_burst_in_accumulate(self):
        """만탄으로 창을 여는 만큼 사이클이 당겨진다."""
        plain = self._run(None)
        policy_c = self._run({"reload": {"policy": "finish_by_fb_end"}})

        def bursts(r):
            return sum(1 for e in r.log.burst_log if "full_burst 시작" in e.event)

        self.assertGreater(bursts(policy_c), bursts(plain))
        self.assertGreater(policy_c.squad_total, plain.squad_total)

    def test_policy_c_is_opt_in(self):
        """정책을 안 주면 아무 일도 일어나지 않는다 — 기존 baseline이 안 움직이는 근거다."""
        plain = self._run(None)
        self.assertEqual(
            [e for e in plain.log.reload_log if e.event == "엄폐 시작(장전컨)"], [])


class FixedModeTest(unittest.TestCase):
    """기본 모드는 종전 그대로다 — 게이지는 계산·기록만 하고 사이클을 판정하지 않는다."""

    def test_fixed_mode_ignores_the_gauge(self):
        squad = build_squad(FULL_SQUAD)
        cfg = build_config(squad, {"duration": 60, "rng_mode": "expected"})
        fixed = simulate(squad, config=cfg, enemy={"code": "", "core_px": 0}, verbose=True)
        self.assertEqual(cfg.get("burst_gauge_mode", "fixed"), "fixed")
        # 게이지 로그는 두 모드 모두 남는다.
        self.assertTrue(fixed.log.gauge_log)
        # 첫 풀버스트는 `first_burst_time` 기준이라 200발을 기다리지 않는다.
        acc = _run(FULL_SQUAD)
        fixed_first = min(e.t for e in fixed.log.burst_log if "full_burst 시작" in e.event)
        acc_first = min(e.t for e in acc.log.burst_log if "full_burst 시작" in e.event)
        self.assertLess(fixed_first, acc_first)

    def test_unknown_mode_fails_loudly(self):
        squad = build_squad(["목단"])
        with self.assertRaises(ValueError):
            simulate(squad, config={"duration": 5, "burst_gauge_mode": "nope"})


if __name__ == "__main__":
    unittest.main()
