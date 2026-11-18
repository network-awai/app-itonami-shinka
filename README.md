# app-itonami-shinka — Shinka

進化 — 歴史上の出来事のカタログと、actor ごとの情緒（joucho）の評価を記録します。推論・クレジット精算・投稿の実行は含みません。

Tauri **3.0.0-alpha.6** の独立 app（`tauri-runtime-wry`、OS の WebView）と、同じファイルの static Web ビルドです。記録はすべてこの端末の中（localStorage、key `itonami.shinka.v1`）に保存し、外部へは通信しません。外部操作の宣言もありません（`dist/descriptor.json` の `operations: []`）。保存に失敗したときは画面に表示します。

## できること

| 操作 | 内容 |
| --- | --- |
| 出来事を登録 (seedEvent) | — |
| 出来事の一覧 (listEvents) | — |
| 情緒を記録 (recordJoucho) | — |
| 情緒の一覧 (listJoucho) | — |
| 情緒を見る (getJoucho) | — |
| 記録の数 (coverage) | — |

記録（collection）: `cloud.itonami.apps.shinka.historicalEvent`、`sealed:cloud.itonami.apps.shinka.jouchoAssessment`

## 補足

- 情緒の評価は sealed record として、この端末の中で **AES-GCM-256 で暗号化して** 保存します。
  - 鍵: 「操作」タブの最初の欄で決めるパスフレーズから PBKDF2-SHA256（60 万回、ランダムな salt）で鍵を作り、それで暗号化用のランダムな鍵を包んで保存します。パスフレーズと包む前の鍵は保存しません。開いている間だけ、取り出せない（non-extractable）鍵としてメモリに置き、「鍵をかける」か画面を閉じると消えます。
  - **パスフレーズを忘れると、評価は誰にも読めなくなります。** 「記録をすべて消す」は鍵も消します。
  - 書いた本人・受け手の DID・日時は、read-cap の判定のため暗号化せずに残します。これらは暗号文に AES-GCM の追加データとして結び付けてあり、書き換えると復号に失敗します。
  - read-cap（書いた本人と、明示した受け手の DID）に入っていない DID には返しません。ただし鍵の受け渡しはしないので、受け手もこの端末で同じパスフレーズを使って開く必要があります（app は外部と通信しません）。旧 SDK のような別の端末への E2E 共有はありません。
  - 以前の版で平文のまま保存した評価は、最初にパスフレーズを設定するか開いたときに暗号化し直します。
  - 守れるもの: localStorage の中身（バックアップや複製を含む）だけを見た人には、評価の中身は読めません。守れないもの: 開いている間にこの app の中で動くコードからは読めます。また、弱いパスフレーズは総当たりで破られえます。
- 旧 appview の cron Worker（actor ごとの進化の scheduler、fleet 推論、PDS への投稿）は削除しました。推論・クレジット精算・投稿の実行は含みません。

## 構成

| パス | 役割 |
| --- | --- |
| `src/domain/` | domain logic（TypeScript）。ビルド時に Node の type stripping で JS にします（bundler・依存なし） |
| `src/local-store.js` | この端末内の record store。domain が使う `read` / `write` を localStorage で実装 |
| `src/app-def.js` | 画面の操作と domain 関数・collection の対応 |
| `src/ui/` | 依存なしの UI。DOM はテキストノードだけで組み、HTML 文字列を使いません（CSP `style-src 'self'`） |
| `vendor/` | kotoba-lang/kotoba の `kotoba-client-runtime.js` / consent CSS と `PINS.json`。`scripts/build.mjs` が digest のずれで失敗します |
| `src-tauri/` | Tauri v3 host。read-only command は `awai_host_info` の 1 つだけ。filesystem・network・shell・installer 権限なし |


## コマンド

```sh
npm ci
npm test              # build してから domain と local-only のテスト（local-only.test.mjs, shinka.test.ts）
npm run build         # dist/ と SHA-256 の release.json
npm run build:desktop # native desktop 実行ファイル（bundle・署名なし）
```

## 状態と制限（AWAI-3079, 2026-11-17）

- 旧構成（Cloudflare Worker の XRPC dispatcher / adapter、`wrangler.jsonc`、`@etzhayyim/sdk`）は削除しました。履歴は git にあります。
- 検証済み: `npm test`、`npm run build`、`cargo check`（Tauri 3.0.0-alpha.6）。
- 未検証: native window の起動、`tauri build`、Android、署名、配布。アイコンは app-soshiki の仮アイコンです。

## Android（Itonami Store）

AWAI-3502 で Android 版を加えました。Store の ID は `network.itonami.shinka` です。

- `npm run build:android`（`scripts/android-apk.sh`）が、`tauri android build --debug --apk --target aarch64` で APK を作り、SHA-256 を表示します。Android SDK・NDK 27・JDK 21・Rust の `aarch64-linux-android` が要ります。
- 出力は `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（約 20 MB、手元の Android debug 鍵で署名）です。
- manifest に `INTERNET` 権限はありません。OS が app の通信をすべて止めます。
- ネイティブライブラリは 16 KB 境界にそろえ（Android 15 以降の 16 KB ページ）、debug 情報を除いています。画面はシステムバーと切り欠きを避け、明暗の配色に合わせます。
- Store への掲載は network-awai/awai-os の `android/local-apps.json` と `build.py --local-apps-dir` で行います。
- 確認済み: APK の作成、パッケージ名・権限・署名・16 KB 境界の確認。エミュレータでの起動は awai-os 側の記録を見てください。実機・署名済みの配布は未確認です。
