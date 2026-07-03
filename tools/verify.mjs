// index.html の動作検証 + スクリーンショット取得 + 出力フォーマット回帰チェック。
// 使い方: cd tools && node verify.mjs
// システムの Chrome を playwright-core で起動する（追加ダウンロードなし）。
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const indexUrl = "file:///" + path.join(root, "index.html").replace(/\\/g, "/");
const oldPath = path.join(here, "old_index.html");
const oldUrl = "file:///" + oldPath.replace(/\\/g, "/");
const imagesDir = path.join(root, "images");
fs.mkdirSync(imagesDir, { recursive: true });

// 回帰比較の基準として、最後にコミットされた index.html を書き出す
fs.writeFileSync(
  oldPath,
  execFileSync("git", ["show", "HEAD:index.html"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

try {
  // ---- 1) 出力フォーマット回帰チェック（旧版 vs 新版・同一状態で比較） ----
  const grab = async (url) => {
    const page = await browser.newPage();
    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(300);
    const out = await page.evaluate(() => ({
      markdown: buildMarkdown(),
      json: buildJson(),
    }));
    await page.close();
    return out;
  };
  const oldOut = await grab(oldUrl);
  const newOut = await grab(indexUrl);
  check("Markdown 指示書が旧版と一致", oldOut.markdown === newOut.markdown);
  check("作業内容 JSON が旧版と一致", oldOut.json === newOut.json);

  // ---- 2) 削除した UI が存在しないこと ----
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.5,
  });
  const page = await context.newPage();
  await page.goto(indexUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(400);

  const removed = await page.evaluate(() => ({
    saveChart: document.getElementById("saveChart") === null,
    exportText: document.getElementById("exportText") === null,
    chartFn: typeof buildChartTemplate === "undefined",
  }));
  check("チャート雛形ボタンが存在しない", removed.saveChart);
  check("AI指示プレビュー(textarea)が存在しない", removed.exportText);
  check("buildChartTemplate が存在しない", removed.chartFn);

  // ---- 3) 初回訪問: 使い方モーダルが自動表示される ----
  const helpVisibleFirstRun = await page.isVisible("#helpModal .modal");
  check("初回訪問で使い方モーダルが自動表示", helpVisibleFirstRun);
  await page.screenshot({ path: path.join(imagesDir, "screenshot-help.png") });

  // ---- 4) Esc で閉じ、? で再度開く ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Esc でモーダルが閉じる", !(await page.isVisible("#helpModal .modal")));
  await page.screenshot({ path: path.join(imagesDir, "screenshot-empty.png") });
  await page.keyboard.press("?");
  await page.waitForTimeout(150);
  check("? キーでモーダルが開く", await page.isVisible("#helpModal .modal"));

  // ---- 5) ガイドツアー開始（モーダルの「ガイドツアーで始める」） ----
  const tourStep = () => page.evaluate(() => document.getElementById("tourCount").textContent);
  await page.click("#helpTour");
  await page.waitForTimeout(200);
  check("ツアー開始でモーダルが閉じる", !(await page.isVisible("#helpModal .modal")));
  check("ツアーの吹き出しが表示される", await page.isVisible("#tourBalloon"));
  check("ステップ1（音源読み込み）から始まる", (await tourStep()).startsWith("ステップ 1"));
  await page.screenshot({ path: path.join(imagesDir, "screenshot-tour.png") });

  // ---- 6) デモ音源読み込み → ステップ2 へ自動前進 ----
  await page.click("#demoAudio");
  await page.waitForFunction(
    () => document.getElementById("tourCount").textContent.startsWith("ステップ 2"),
    null,
    { timeout: 15000 },
  );
  const fileName = await page.textContent("#fileName");
  check("デモ音源が読み込まれツアーがステップ2へ", fileName.includes("デモ音源"), fileName.trim());

  // ---- 7) Space 再生 → ステップ3、K 打刻 → ステップ4 ----
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => document.getElementById("tourCount").textContent.startsWith("ステップ 3"),
    null,
    { timeout: 5000 },
  );
  const playing = await page.evaluate(() => {
    const audio = document.getElementById("audio");
    return !audio.paused && audio.currentTime > 0;
  });
  check("Space で再生が始まりツアーがステップ3へ", playing);

  const before = await page.evaluate(() => markers.length);
  await page.keyboard.press("k");
  await page.waitForFunction(
    () => document.getElementById("tourCount").textContent.startsWith("ステップ 4"),
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => document.activeElement.blur());
  const after = await page.evaluate(() => markers.length);
  check("K でマーカーが追加されツアーがステップ4へ", after === before + 1, `${before} -> ${after}`);

  // ---- 8) 微調整 → ステップ5、Esc 中断 → ? から再開（済みステップは飛ばす） ----
  await page.click("#nudgeForward");
  await page.waitForFunction(
    () => document.getElementById("tourCount").textContent.startsWith("ステップ 5"),
    null,
    { timeout: 5000 },
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Esc でツアーを中断できる", !(await page.isVisible("#tourBalloon")));
  await page.keyboard.press("?");
  await page.waitForTimeout(150);
  await page.click("#helpTour");
  await page.waitForTimeout(300);
  check("再開時は済みステップを飛ばしてステップ5", (await tourStep()).startsWith("ステップ 5"));

  // ---- 9) AI用指示を保存 → ステータス更新 & ツアー完了 ----
  // (file:// の headless Chrome では download イベントが取れないため、ステータス文言で確認する)
  await page.click("#saveInstructions");
  await page.waitForFunction(
    () => document.getElementById("tourBalloon").classList.contains("hidden"),
    null,
    { timeout: 5000 },
  );
  const statusText = await page.textContent("#status");
  check("AI用指示の保存でツアーが完了する", statusText.includes("ガイドツアー完了"), statusText.trim());
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);

  // ---- 10) 指示書 Markdown の内容（曲名反映） ----
  await page.fill("#trackName", "サンプル曲");
  await page.fill("#composer", "デモ");
  const markdown = await page.evaluate(() => buildMarkdown());
  check("指示書 Markdown に曲名が反映される", markdown.startsWith("# サンプル曲 音ハメ指示書"));

  // ---- 11) メイン画面スクリーンショット（曲名入力 + 波形 + マーカー） ----
  await page.evaluate(() => {
    // 追加した検証用マーカーを消し、見栄えのため 8 秒付近を表示
    markers = markers.filter((m) => m.label !== "メモ");
    selectedId = markers[2]?.id ?? markers[0]?.id ?? null;
    if (selectedId != null) selectMarker(selectedId, true);
    setAudioTime(8.75, true);
    centerTimelineOn(10, false);
    ui.status.textContent = "デモ音源（144BPM クリック） / 00:30.500";
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(imagesDir, "screenshot-main.png") });

  // ---- 12) 右パネル（編集 + 書き出し）の部分スクリーンショット ----
  await page.locator(".side").screenshot({ path: path.join(imagesDir, "screenshot-side.png") });

  // ---- 13) 2回目の訪問ではモーダルが出ない（自動保存の復元が優先） ----
  await page.reload();
  await page.waitForTimeout(500);
  check("再訪問時はモーダル非表示", !(await page.isVisible("#helpModal .modal")));

  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
