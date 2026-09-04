// 穿成孩子妈，奋斗成赢家 1화 전체 — Kuaikan → PIVO 이관 테스트
import "dotenv/config";
import {
  kuaikanSearchRoot, kuaikanListChildren, kuaikanGetDownloadUrl,
  findEpisodeFolder, isKuaikanDir, matchByNumber,
} from "./src/drive-download.js";
import { pivoUploadSourceFile, pivoEpisodeSourceFiles, getPreprocessingStatus, projectByPivo, episodeSourceGroups, completeSourceGroups } from "./src/totus.js";

const SEARCH  = "穿成孩子妈，奋斗成赢家";
const PIVO    = "210017";
const EPISODE = "1";

console.log(`\n=== ${SEARCH} ${EPISODE}화 전체 이관 테스트 ===\n`);

// 1. Kuaikan 검색
const hits = await kuaikanSearchRoot(SEARCH);
console.log(`[1] 검색 결과 ${hits.length}건:`, hits.map(h => `${h.name}(${h.id})`).join(", "));
if (hits.length !== 1) { console.error("❌ 검색 결과 1건이 아님"); process.exit(1); }
const rootId = hits[0].id;

// 2. 1화 폴더 탐색
const adapter = { listChildren: (id) => kuaikanListChildren(id), isDir: isKuaikanDir };
const epResult = await findEpisodeFolder(adapter.listChildren, isKuaikanDir, rootId, EPISODE, "psd");
if (!epResult.ok) { console.error(`[2] ❌ ${EPISODE}화 폴더 탐색 실패:`, epResult.reason); process.exit(1); }
console.log(`[2] ${EPISODE}화 폴더: ${epResult.folder.name} (id=${epResult.folder.id})`);

// 3. PSD 파일 목록
const allItems = await kuaikanListChildren(epResult.folder.id);
const psdFiles = allItems.filter(it => !isKuaikanDir(it) && /\.psd$/i.test(it.name || ""));
console.log(`[3] PSD 파일 ${psdFiles.length}개:`, psdFiles.map(f => f.name).join(", "));
if (!psdFiles.length) { console.error("❌ PSD 파일 없음"); process.exit(1); }

// 4. PIVO 기존 파일 목록
const existingRes = await pivoEpisodeSourceFiles(PIVO, EPISODE).catch(() => null);
const existingFiles = existingRes?.data?.파일목록 || [];
console.log(`[4] PIVO 기존 파일 ${existingFiles.length}개\n`);

// 파일 다운로드(스트리밍 진행률 표시, 실패 시 최대 2회 재시도) → Buffer 반환
async function downloadWithProgress(item, label, maxRetry = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry + 1; attempt++) {
    if (attempt > 1) process.stdout.write(`\n     ↩️ 재시도 ${attempt - 1}/${maxRetry}...\n`);
    try {
      const fileInfo = await kuaikanGetDownloadUrl(item.id);  // 재시도마다 URL 새로 받음
      const dlStart = Date.now();
      const dlRes = await fetch(fileInfo.url, { signal: AbortSignal.timeout(600000) });
      if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
      const totalBytes = parseInt(dlRes.headers.get("content-length") || "0", 10);
      const totalMb = totalBytes ? `/${(totalBytes/1024/1024).toFixed(1)}MB` : "";
      process.stdout.write(`  ⬇ ${label} ${fileInfo.name}  0.0MB${totalMb}`);
      const reader = dlRes.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        process.stdout.write(`\r  ⬇ ${label} ${fileInfo.name}  ${(received/1024/1024).toFixed(1)}MB${totalMb}`);
      }
      const buffer = Buffer.concat(chunks);
      const dlSec = ((Date.now() - dlStart) / 1000).toFixed(1);
      process.stdout.write(`\r  ⬇ ${label} ${fileInfo.name}  ${(buffer.length/1024/1024).toFixed(1)}MB 완료 (${dlSec}s)\n`);
      return { buffer, fileInfo };
    } catch (e) {
      lastErr = e;
      process.stdout.write(`\r  ⬇ ${label} ${item.name}  실패: ${e.message}\n`);
    }
  }
  throw lastErr;
}

// 5. 파이프라인: 파일 N 다운 완료 → 업로드N + 다운N+1 동시 진행
const allFileIds = [];
let ok = 0, fail = 0;
const totalStart = Date.now();

// 첫 번째 파일 다운로드(순차 — 아직 업로드할 것 없음)
let currentDl = await downloadWithProgress(psdFiles[0], `(1/${psdFiles.length})`).catch(e => ({ error: e }));

for (let i = 0; i < psdFiles.length; i++) {
  const label = `(${i + 1}/${psdFiles.length})`;

  if (currentDl.error) {
    console.error(`  ❌ ${label} ${psdFiles[i].name} 다운로드 실패: ${currentDl.error.message}\n`);
    fail++;
    // 다음 파일 다운로드(에러 복구)
    if (i + 1 < psdFiles.length) {
      currentDl = await downloadWithProgress(psdFiles[i + 1], `(${i + 2}/${psdFiles.length})`).catch(e => ({ error: e }));
    }
    continue;
  }

  const { buffer, fileInfo } = currentDl;
  try {
    if (buffer.length < 100 * 1024) console.warn(`     ⚠️ 파일 크기 의심스러움 (${(buffer.length/1024).toFixed(0)}KB)`);

    const pageNum = (fileInfo.name.match(/(\d+)/) || [])[1] || String(i + 1);
    const m = matchByNumber(existingFiles, pageNum, "파일명");
    const targetName = m.confident ? m.item.파일명 : fileInfo.name;
    if (!m.confident) console.warn(`     ⚠️ 파일명 매칭 실패 — ${fileInfo.name} 그대로 사용`);

    // 업로드 시작 + 동시에 다음 파일 다운로드
    console.log(`  ⬆ ${label} ${targetName} 업로드 중...`);
    const upStart = Date.now();
    const [uploadRes, nextDl] = await Promise.all([
      pivoUploadSourceFile(PIVO, EPISODE, buffer, targetName),
      i + 1 < psdFiles.length
        ? downloadWithProgress(psdFiles[i + 1], `(${i + 2}/${psdFiles.length})`).catch(e => ({ error: e }))
        : Promise.resolve(null),
    ]);
    const upSec = ((Date.now() - upStart) / 1000).toFixed(1);
    const fileId = uploadRes?.data?.fileId || uploadRes?.data?.파일Id || uploadRes?.파일Id;
    if (fileId) allFileIds.push(fileId);
    console.log(`  ✅ ${label} 완료 (업로드 ${upSec}s) — fileId: ${fileId ?? "(없음)"}\n`);
    ok++;
    currentDl = nextDl;
  } catch (e) {
    console.error(`  ❌ ${label} ${fileInfo.name} 업로드 실패: ${e.message}\n`);
    fail++;
    if (i + 1 < psdFiles.length) {
      currentDl = await downloadWithProgress(psdFiles[i + 1], `(${i + 2}/${psdFiles.length})`).catch(e => ({ error: e }));
    }
  }
}

const totalMin = ((Date.now() - totalStart) / 60000).toFixed(1);
console.log(`\n=== 업로드 완료: ${ok}건 성공, ${fail}건 실패 (총 ${totalMin}분) ===\n`);
if (!allFileIds.length) { console.error("❌ fileId 없음 — 전처리/확정 스킵"); process.exit(1); }

// 6. 전처리 대기
console.log(`[6] 전처리 대기 (${allFileIds.length}개 파일, 최대 10분)...`);
const maxWait = 10 * 60 * 1000;
const ppStart = Date.now();
let ppDone = false;
while (Date.now() - ppStart < maxWait) {
  const s = await getPreprocessingStatus(allFileIds).catch(() => null);
  if (s?.meta?.오류있음) { console.error("❌ 전처리 오류"); break; }
  if (s?.meta?.전체완료) { ppDone = true; break; }
  console.log("    전처리 중... 30초 후 재확인");
  await new Promise(r => setTimeout(r, 30000));
}
console.log(ppDone ? "✅ 전처리 완료\n" : "⚠️ 전처리 시간 초과 또는 오류\n");

// 7. 소스그룹 확정
if (ppDone) {
  console.log(`[7] 소스그룹 확정...`);
  const proj = await projectByPivo(PIVO);
  const projectUuid = proj?.data?.[0]?.uuid;
  if (!projectUuid) { console.error("❌ 프로젝트 UUID 없음"); process.exit(1); }
  const sgs = await episodeSourceGroups(projectUuid, EPISODE);
  const sgIds = (sgs?.data || []).map(sg => sg.id).filter(Boolean);
  console.log(`    소스그룹 ${sgIds.length}개:`, sgIds.join(", "));
  if (sgIds.length) {
    await completeSourceGroups(sgIds);
    console.log("✅ 소스그룹 확정 완료");
  }
}
