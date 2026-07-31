// TOTUS 원본 파일 순서 판정 로직 — inquiry-bot(slack-inquiry-botV2)의 fileOrderFlow.js 포팅.
// 순수 판정 함수만 담음(API 호출은 totus.js: episodeSourceGroups/reorderFiles/completeSourceGroups 사용).

// 파일명에서 [주번호, 부번호, 서브페이지] 추출 — 원본(fileOrderFlow.js) 로직 그대로.
//   36-9.2.psd  → [36, 9, 2]   36-9.psd → [36, 9, 0]   龙头44-1.psd → [44, 1, 0]   001.psd → [1, 0, 0]
function extractSeqFromFilename(filename) {
  const p0 = filename.match(/(\d+)[_\-](\d+)\.(\d+)/);
  if (p0) return [parseInt(p0[1], 10), parseInt(p0[2], 10), parseInt(p0[3], 10)];
  const p1 = filename.match(/(\d+)[_\-](\d+)/);
  if (p1) return [parseInt(p1[1], 10), parseInt(p1[2], 10), 0];
  const p2 = filename.match(/(\d+)/);
  if (p2) return [parseInt(p2[1], 10), 0, 0];
  return [9999, 9999, 9999];
}

// 수정본/교체본 표시(改·修·replace·수정·교체·copy·v2 등)가 붙어있으면 "복잡한 케이스"로 분류 —
// 이런 건 순서 문제가 아니라 "어느 파일을 지워야 하는지"의 별개 판단이 필요해서 이 도구 범위 밖(건너뛰고 보고만).
const REVISION_MARK_RE = /(_|-|\()(改|修|replace|new|수정|교체|copy|v\d+)(\)|$|[_\-.])/i;
function looksLikeRevisionVariant(name) {
  return REVISION_MARK_RE.test(String(name || ""));
}

/**
 * 파일 목록을 분석 — 제안 순서 + 애매한 그룹(동률)을 함께 반환.
 * 동률 그룹 중 수정본 표시가 하나라도 섞여있으면 complexGroups(건너뛰고 보고),
 * 아니면 simpleAmbiguousGroups(모달로 순서 확인 필요).
 * 반환된 simpleAmbiguousGroups/complexGroups의 각 그룹은 fileNames 안에서 연속된 인덱스 블록
 * (suggested 배열 기준 startIndex)을 갖는다 — 사용자가 순서를 확정하면 그 위치에 그대로 끼워넣는다.
 */
function analyzeOrder(fileNames) {
  const seqOf = new Map(fileNames.map((f) => [f, extractSeqFromFilename(f)]));
  const keyOf = (f) => seqOf.get(f).join(",");

  const suggested = [...fileNames].sort((a, b) => {
    const [a1, a2, a3] = seqOf.get(a), [b1, b2, b3] = seqOf.get(b);
    if (a1 !== b1) return a1 - b1;
    if (a2 !== b2) return a2 - b2;
    return a3 - b3;
  });

  // suggested(정렬 후) 배열에서 같은 키를 가진 연속 블록을 찾아 그룹화 — 이러면 startIndex가 바로 나옴
  const groups = [];
  let i = 0;
  while (i < suggested.length) {
    const k = keyOf(suggested[i]);
    let j = i;
    while (j + 1 < suggested.length && keyOf(suggested[j + 1]) === k) j++;
    if (j > i) groups.push({ startIndex: i, files: suggested.slice(i, j + 1) });
    i = j + 1;
  }
  const complexGroups = groups.filter((g) => g.files.some(looksLikeRevisionVariant));
  const simpleAmbiguousGroups = groups.filter((g) => !g.files.some(looksLikeRevisionVariant));

  return {
    suggested,
    isDifferent: fileNames.some((f, idx) => f !== suggested[idx]),
    complexGroups,
    simpleAmbiguousGroups,
  };
}

export { extractSeqFromFilename, looksLikeRevisionVariant, analyzeOrder };
