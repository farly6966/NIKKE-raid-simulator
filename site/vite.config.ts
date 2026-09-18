import { defineConfig } from 'vitest/config';

// 빌드마다 바뀌는 ID. calculator.worker.js는 해시가 없는 public 자산이라
// 이 값을 쿼리로 붙여 새 배포 때 옛 워커가 캐시에서 재사용되지 않게 한다.
const buildId = JSON.stringify(Date.now().toString(36));

export default defineConfig({
  base: '/NIKKE-raid-simulator/',
  define: {
    __BUILD_ID__: buildId,
  },
  test: {
    environment: 'node',
    // 기본 5초는 이 저장소에는 너무 빡빡하다. 화면 시험 하나가 계산기를 통째로 올리고
    // 모의 요청을 수십 개 돌리는데, 바쁜 기계(특히 CI)에서는 그 한 판이 10초를 넘긴다 —
    // 깨진 곳은 없는데 배포가 막히는 일이 이것 때문에 났다.
    //
    // 상류는 느려진 시험마다 `}, 20_000)`을 하나씩 붙여 왔다. 같은 값을 여기 한 번만
    // 적어 둔다 — 시험이 늘 때마다 잊고 안 붙이는 자리를 만들지 않으려는 것이다.
    // (진짜로 멈춘 시험은 20초에 걸리므로 «영원히 안 끝남»은 그대로 잡힌다.)
    testTimeout: 20_000,
    hookTimeout: 20_000,

    // 測試檔**不併行**。預設會照 CPU 數同時開 40 個 fork，而這個 repo 的畫面測試
    // 每一件都把計算器整個掛起來跑 jsdom —— 互相搶 CPU 的結果是同一件測試的耗時
    // 在單跑與全套之間差到 2.5 倍，於是「預算夠不夠」變成一個隨機變數：
    // 同一份程式碼連跑三次，失敗 5 → 2 → 1 件，而且每次壞的不是同一批。
    //
    // 併行關掉之後 wall clock 反而更短（576 秒 → 見下方實測），因為省下的是搶資源
    // 的浪費，不是真正的工作。時間可預測也讓 `waitFor` 的預算可以照實測值給，
    // 不必為了最壞情況一路往上加。
    fileParallelism: false,
  },
});
