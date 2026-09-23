# 換一台電腦，從這裡接續開發

程式、決策與交接紀錄以 [GitHub 專案](https://github.com/farly6966/NIKKE-raid-simulator) 為共同來源。每台電腦各有一份 checkout，透過 GitHub 推送／拉取接續；不需要原本的電腦開機，也不需要原本的對話才能理解進度。

## 直接貼給另一台電腦的 Codex

```text
我要接續開發 https://github.com/farly6966/NIKKE-raid-simulator。
請先找這台電腦是否已有此 repo；沒有就 clone，有則先檢查未提交變更與目前分支，再 fetch 更新，不要覆蓋本機工作。
讀取 AGENTS.md、START_HERE.md，以及 docs/聯盟突襲-交接筆記.md 最上方最新段落；需要校正規格再讀 docs/實戰傷害校正.md。
確認 GitHub 最新進度、接手分支、已完成項目及未完成工作，再接著處理我這次的需求。
請用繁體中文回覆。階段結束要更新交接紀錄，提交並推送本次變更到 GitHub；未完成工作留在功能分支，記錄分支名稱與下一步，讓另一台電腦可接續。
```

## 第一次使用這台電腦

需要 Git、Node.js 24（或 22.13 以上的 22.x）、Python 3，以及可推送本專案的 GitHub 登入權限。Node 版本須符合 `site/package-lock.json` 內 Vite／Vitest／jsdom 的需求；套件依照 lockfile 安裝，不必搬移另一台電腦的 `node_modules`。

在想放專案的目錄執行（也可以請 Codex 代做）：

```sh
git clone https://github.com/farly6966/NIKKE-raid-simulator.git
cd NIKKE-raid-simulator
```

把這個 **repo 根目錄** 加為 Codex 本機專案的主要資料夾，從專案開始工作。若使用 CLI，可在根目錄執行 `codex`。本機專案提供資料夾存取，長期規則保存在 `AGENTS.md` 與已提交文件；參見 [OpenAI 官方專案說明](https://learn.chatgpt.com/docs/projects)。

啟動網站：

```sh
cd site
npm ci
npm run dev
```

開啟終端機顯示的網址，路徑為 `/NIKKE-raid-simulator/`。建置會呼叫 Python：Windows 需可執行 `python`，macOS／Linux 需可執行 `python3`；安裝後若找不到，重新開啟終端機。初次安裝與下載 Pyodide 需要網路。

若 Windows 的 Python 安裝管理器被 Codex 沙箱擋住，可請 Codex 查詢這台電腦的內建 workspace dependencies，將可用 Python 的目錄加入本次命令的 `PATH` 後重試；不要照搬其他電腦的使用者路徑。

## 每天換機的交接方式

1. **離開前**：請 Codex 更新 [交接筆記](docs/聯盟突襲-交接筆記.md) 的最新狀態，檢查本次檔案、提交並推送；確認遠端已有該 commit。只有本機 commit 還不算同步。
2. **另一台開工前**：檢查 `git status`、目前分支及交接日誌，先 fetch。工作目錄乾淨且要接續已合併版本時，可執行下列指令；有未提交內容或分歧時先保留並整理，不能強制覆蓋。

   ```sh
   git fetch origin
   git switch master
   git pull --ff-only origin master
   ```

3. **有未完成工作**：從交接記載的功能分支接手。先 fetch；本機尚無該分支時用 `git switch --track origin/分支名稱`，已有則切到該分支並 `git pull --ff-only`。不要只看 `master` 而漏掉尚未合併的進度。
4. **做完後**：執行變更需要的驗證，更新交接、提交並推送。`master` 推送會觸發正式網站部署；尚未完成的變更只推功能分支，不為了同步而部署。

這是每次工作階段執行的同步流程，不是背景自動同步服務。兩台電腦避免同時修改同一分支；若已分歧，保留雙方提交再處理衝突。

## 接手時讀哪些資料

| 需要知道什麼 | 入口 |
|---|---|
| 專案規則、使用者習慣、驗證與發布規範 | [AGENTS.md](AGENTS.md) |
| 最新完成項目、部署證據、待辦與接手分支 | [聯盟突襲交接筆記](docs/聯盟突襲-交接筆記.md) 的最新段落 |
| 實戰校正、備份、修改傷害及成效判定 | [實戰傷害校正](docs/實戰傷害校正.md) |
| 上游移植進度 | [上游移植交接筆記](docs/上游移植-交接筆記.md) |
| 依賴、完整驗證命令與專案結構 | [README.md](README.md)、[部署 workflow](.github/workflows/pages.yml) |

交接至少記下：需求與已接受決策、完成／未完成內容、接手分支與 commit、驗證結果、下一步。不要只記在 Codex 對話或機器專屬的絕對路徑。

## 哪些資料不會隨 GitHub 搬過去

- 未提交／未推送的檔案，以及 Git 忽略的本機內容。
- 個人帳號資料 `profiles/`、成員匯出 `exports/`、報告 `out/`、登入 cookie 與憑證；依專案規則不提交這些資料。一般功能開發可用 repo 測試資料；需要真實資料時在新機器另外安全匯入。
- 網站的瀏覽器儲存。需要接續實戰盤面時，先用「匯出實戰進度」，另一台再匯入該 JSON。
- 本文件沒有搬移 Codex 對話或電腦設定；新的工作階段透過上述文件取得必要脈絡。
