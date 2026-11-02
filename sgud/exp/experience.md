# 累積經驗

本檔為執行工作時特有之累積經驗,留給後續之嘗試、執行與判斷,由agent自行編列、擴充與維護.

## 集合層(src/dedup/openCollection.mjs)

- **w-orm-lmdb 的 save/del 單筆失敗不 reject,以 `{ok:0, err}` 回報**;要在測試製造「真實」的 ok:0,不必替身:`save([{id, bad: Symbol('x')}])` 回 `ok:0, err:'Unknown type: symbol'`(原記錄不變);`fn`/`undefined` 值不會失敗(被編碼丟棄,且是整筆覆寫的一部分).巢狀函數值會被吞成缺鍵,別拿來當失敗輸入.
- **w-orm-lmdb 每個 cl 是獨立的 LMDB 環境資料夾** `${url}/${db}/${cl}`(見 WOrmLmdb.mjs `storage`),不是同一環境內的子庫.故「探針集合」= 多一個空資料夾,不是同庫多一個命名空間.
- **`insert(..., {returnList:true})` 的逐筆結果恆 `ok:1`**(錯誤皆整批 reject),所以 `insertNew` 目前不會把失敗誤算成重複;換後端才有此風險.
- **`merge:false` 無法由版本號判斷**(WOrm 為呼叫端傳入),w-orm-lmdb 實例也沒有能力旗標;只能看行為.自檢探針放隔離集合,以 WOrm 建構函數為鍵(WeakMap)快取.
- 測試替身寫法:包一層真實 `WOrm(opt)`,依 `opt.cl` 只覆寫目標集合的實例,其餘(含自檢實例)原樣;不要依賴探針集合名稱.「不支援 merge」的替身則要讓**所有**實例的 save 都忽略第二參數.
- 替身若覆寫了 `insert`,別用 `insertNew` 種資料(會一起壞);先種資料再「武裝」(armed 旗標).
- 變異驗證腳本模式:把修正版備份到 `tmp/`、逐個變異後跑單檔 mocha、`finally` 一律由備份還原,最後 `diff -q` 回驗(禁用 git checkout/stash 時的做法).

## 預設實作(執行鎖／截止／預算／日誌,Gitea #39)

- **主入口不可同時有 default 與具名 export**:實驗(rollup via w-package-tools)證實 UMD `require()` 會變 `{ default, 具名… }`,`require(...).definePipeline` 變 `undefined`.新增名稱一律加進預設匯出物件;要具名匯入走深層路徑.
- **同一行程第二次取鎖的訊息是「本行程已持有此鎖…」,不是「另一個執行中（pid」**:後者只在持鎖者為他行程時出現.整合測試要驗「略過本輪：另一個執行中（pid X」須以真子行程持鎖(`child_process.spawn` + stdin 關閉才釋放);同行程案驗「略過本輪：本行程已持有此鎖」.建議檔 §7-2 把兩者混寫.
- **變異點挑選**:`EMPTY_GRACE_MS = 0` 這類「改常數」的變異可能存活(NTFS 的 mtime 可略大於 `Date.now()`,`diff < 0` 仍為真);改為直接取消分支才穩定轉紅.`release` 不自 `HELD` 註銷是**等價變異**(鎖檔已刪、nonce 每次隨機,僅差記憶體),要抓 `HELD.delete` 的守衛須變異為「無條件清除」並由「晚到的舊持有者 release 不清現持有者登記」案抓住.
- **變異腳本(26 個)模式**:備份 → 取代恰 1 處 → 跑相關 mocha → `finally` 還原 → sha256 回驗;整批經 `quiet-run --lock` 只取一次鎖;`PL39_ONLY=M07,M09` 可只跑指定變異.
- **「修前紅」對新增模組**:`git archive HEAD src` 解到 `./tmp/<夾>/before/` 再把新測試複製進去,import 缺模組即紅(夾在 repo 內,`node_modules` 靠往上層解析,不需連結).
- **srcRunner 原測試之案數以原檔為準**:`unit-budget.test.mjs` 實有 6 個 `it`(單據稱 7 案).
- **UMD 建置驗證**:以腳本呼叫 `w-package-tools/src/rollupFiles.mjs`,`fdTar` 指向 `./tmp/<夾>/dist`(不動 `./dist`),再 `createRequire` 載入驗證建置與 `require` 形狀(腳本樣例存主控任務夾證據 `pl39-evidence/build.mjs`);預設實作引入 `fs`／`path` 會得到「browser bundle depends on Node.js built-in modules」警告(Node 內建模組被視為外部,功能無礙).
- **npm i 副作用**:`npm i wsemi@^…` 會補 `package.json` 檔尾換行、並把 `package-lock.json` 自身版號同步為 `package.json` 的 version;非 version 變更.

## 下游先行(wsemi 第 221 項第 3 輪:strTruncate 等改嚴格,2026-11-02 r3pl)

- **「改用 iseint 取代舊判定」不是逐字等價,先量測再下結論**:舊 `oneline` 靠 wsemi `isp0int`／`cint` 判 `n`,實測接受 `'0x10'`(截於 16)、`'0b11'`(3)、`new Number(5)`、`new String('5')`(5),`iseint(count)` 全拒;其餘 58 種 `n` 新舊相同。派工單曾假設包裝物件「改前改後逐字相同」,量測推翻——寬鬆行為要用 s×n 矩陣探針(輸出 JSON 前後 diff)找,不憑文件推論。
- **差分基準不可依賴待改的 wsemi 函數**:`test/tools/legacyOneline.mjs` 自帶寬鬆版 `strTruncate` 複本(只用 `isestr`／`isp0int`／`cint`／`strleft`),否則 wsemi 第 3 輪後基準跟著變嚴格、差分失去「改前」的意義。
- **把替身換進「src 原檔」而非複本**:`module.register` 掛 `resolve` 鉤子,僅在父模組 URL 帶 `?strictWsemi=<序號>` 時把 `wsemi/src/strTruncate.mjs` 導向替身,再以 `import(url + '?strictWsemi=1')` 載入原檔;替身模組 URL 與測試匯入者相同,故其 `calls` 紀錄陣列為同一份,可斷言「實際轉給 wsemi 之值」(型別 number、無效 `n` 根本不抵達)。mocha `--parallel`(子行程)下可用。
- **只靠「不拋錯」抓不到轉傳原值**:`n='200'` 原樣轉傳給嚴格替身也不拋(替身自己會判 count),須用紀錄陣列斷言 `typeof maxLen === 'number'` 才殺得掉「不轉數字」變異(M04)。
- **`-0` 是有效 count**:`iseint(-0)` 為真,`Number(-0)` 為 `-0`;`assert.equal`(strict)用 `Object.is`,比 `-0` 與 `0` 要用 `===`。
- **ESLint**:repo 有 `.eslintrc.js`(`brace-style` stroustrup、`quotes` single 且 `allowTemplateLiterals`),含單引號之標籤字串用樣板字串;單行物件方法 `{ f() { … } }` 會違規須展開;刻意用包裝物件的測試以檔頭 `/* eslint-disable no-new-wrappers */`。
- **暫存 UMD 建置驗證**:`tmp/r3pl/build.mjs` 呼叫 `rollupFiles`(`fdTar: './tmp/r3pl/dist'`,不動 `./dist`),`createRequire` 載入後 `W.oneline(…)` 行為與 ESM 相同;新增 `iseint` import 不引入新警告(`fs`／`path` 外部化警告為既有)。
- **npm 11 `install-scripts` 警告**:`npm i` 末尾列 5 個套件(lmdb 等)之安裝腳本被擋,不影響測試(lmdb 走預編譯)——150 案全綠為證。
