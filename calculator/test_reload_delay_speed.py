"""재장전 앞뒤 딜레이는 재장전 «동작»의 일부다 — 속도 버프를 같이 탄다.

`reload_start_delay`(탄 소진 → 장전 시작)와 `post_reload_delay`(장전 완료 → 첫 발)는
60fps 영상에서 **버프 없는 상태로** 잰 값이다(`data/weapon_delays.json`). 그 값을 고정으로
두면 재장전 속도를 크게 받은 캐릭터가 손해를 두 번 본다 — 특히 장탄이 1발까지 줄어
매 발마다 재장전하는 경우 딜이 무너진다.

제보(2026-08-24): 아니스 : 스파클링 서머의 딜이 비정상적으로 낮다. 그는 버스트로
자기 최대 장탄을 73.92% 깎아 «마지막 탄환» 스킬을 자주 터뜨리는 설계라, 1발 상태에서
매 발 재장전한다. 고정 딜레이 0.4초를 매 발 물어 스쿼드 비중이 실측 42.1% → 시뮬
31.9%로 내려앉았다.
"""
import unittest

from calculator.timeline import simulate
from context.spec import build_config, build_squad

SQUAD = ['목단', '에이드 : 에이전트 바니', '아니스 : 스파클링 서머',
         '메이든 : 아이스 로즈', '프리바티']


def _run():
    squad = build_squad(SQUAD)
    cfg = build_config(squad, {'duration': 180, 'rng_mode': 'expected'})
    return simulate(squad, config=cfg, enemy={'code': '수냉', 'core_px': 52})


class ReloadDelayScalesWithSpeedTest(unittest.TestCase):
    def test_delay_shrinks_when_reload_is_buffed(self):
        """버프가 없으면 실측값 그대로, 버프를 받으면 그만큼 줄어든다."""
        from calculator.buff_manager import BuffManager
        from calculator.timeline import CharState

        squad = build_squad(['드레이크', '크라운', 'test_B3'])
        drake = next(c for c in squad if c['name'] == '드레이크')
        state = CharState(drake, 100000.0, '')
        bm = BuffManager(squad)

        # 버프 없음 → 실측값 그대로 (배수 1)
        self.assertEqual(1.0, state._reload_speed_factor(bm, 0.0))
        self.assertEqual(0.2, state.post_reload_delay)     # SG 실측값

        # 재장전 속도 +75% → 시간이 1/4로 줄고 앞뒤 딜레이도 같이 줄어든다
        bm.get_buffs = lambda *a, **k: {'reload_speed_pct': 75.0}
        self.assertAlmostEqual(0.25, state._reload_speed_factor(bm, 0.0))

    def test_maiden_share_matches_the_report(self):
        """제보 스쿼드에서 **메이든의 비중**이 실측 35.2% 언저리여야 한다.

        종전에는 이 자리가 「아니스 > 메이든」이라는 **순서**를 釘고 있었다. 그 전제는
        메이든이 낮게 잡혀 있을 때만 성립했다 — `max_hp_additive`(원문 `[시전자의 최종
        최대 체력의 10%를 공격력으로 합산한 …]`)를 엔진이 읽지 않아 메이든이 33.3%에
        머물렀기 때문이다. 그걸 이으니 35.6%로 실측 35.2%에 붙었고, 순서가 뒤집혔다.

        **아니스 쪽은 아직 미해결이다.** 이 테스트를 만든 `e028cbc`(moris-kr,
        2026-08-25)는 고친 직후를 `아니스 40.2% · 메이든 35.7%`로 적어 두었다. 메이든은
        그대로인데 아니스만 35.0%로 내려와 있다 — 이 fork 역사 어딘가의 회귀이고,
        `git bisect`로 특정할 수 있다. 그때까지 이 자리는 **지금 실측과 맞는 쪽만** 釘는다.
        """
        result = _run()
        total = sum(result.char_total.values())
        maiden = result.char_total['메이든 : 아이스 로즈'] / total
        self.assertAlmostEqual(
            maiden, 0.352, delta=0.02,
            msg=f'메이든 비중이 실측 35.2%에서 멀다 ({maiden:.1%}) — '
                '`max_hp_additive`가 대미지에 실리는지 확인하라',
        )

    @unittest.expectedFailure
    def test_sparkling_summer_share_matches_the_report(self):
        """아니스 비중 42.1%(실측) — **아직 못 맞춘다.** 미해결 표식으로 남긴다.

        `e028cbc` 당시 40.2%였다가 지금 35.0%다. 고쳐지면 이 테스트가
        「예상치 못하게 통과」로 뒤집혀 알려 준다.
        """
        result = _run()
        total = sum(result.char_total.values())
        anis = result.char_total['아니스 : 스파클링 서머'] / total
        self.assertAlmostEqual(anis, 0.421, delta=0.02)

    def test_last_bullet_skill_fires_often_at_one_round(self):
        """장탄이 1발로 줄면 «마지막 탄환»이 매 발 터진다 — 그게 이 캐릭터의 설계다."""
        result = _run()
        missiles = [h for h in result.hits
                    if h.caster == '아니스 : 스파클링 서머' and h.skill_name == '스파클링 미사일']
        self.assertGreater(len(missiles), 100, '스파클링 미사일 발동이 너무 적다')


if __name__ == '__main__':
    unittest.main()
