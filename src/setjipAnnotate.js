// 설정집 xlsx에 검수 결과를 직접 써 넣는다 — 우측 「AI検収」 열에 일본어 지적, 지적 셀만 노란색.
// ★ExcelJS로 재직렬화하면 이미지·도형이 날아간다(설정집은 SS 이미지가 수십 장).
//   그래서 xlsxRowHeight.js와 같은 방식으로 JSZip으로 풀어 sheet XML을 직접 고친다.
import JSZip from "jszip";

const COMMENT_HEADER = "AI検収";
const YELLOW = "FFFFFF00";

const colLetter = (n) => { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
const colIndex = (s) => [...s.toUpperCase()].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── 워크북에서 시트명 → sheetN.xml 경로 ────────────────────────
async function sheetPathMap(zip) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap[m[1]] = m[2].replace(/^\/?xl\//, "").replace(/^\.\//, "");
  }
  const out = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = (m[0].match(/name="([^"]*)"/) || [])[1];
    const rid = (m[0].match(/r:id="([^"]*)"/) || [])[1];
    if (name && rid && relMap[rid]) out[name] = "xl/" + relMap[rid];
  }
  return out;
}

async function sharedStrings(zip) {
  const f = zip.file("xl/sharedStrings.xml");
  if (!f) return [];
  const xml = await f.async("string");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

// ── styles.xml: 노란 fill 1개 + 원본 서식을 보존한 파생 스타일 ──
function addYellowStyles(stylesXml, srcIdxSet) {
  let xml = stylesXml;

  // fills 끝에 노란 solid 하나 추가
  const fillsM = xml.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/);
  if (!fillsM) throw new Error("styles.xml에 <fills>가 없다");
  const newFillId = Number(fillsM[1]);
  const fillsNew = `<fills count="${newFillId + 1}">${fillsM[2]}<fill><patternFill patternType="solid"><fgColor rgb="${YELLOW}"/><bgColor indexed="64"/></patternFill></fill></fills>`;
  xml = xml.replace(fillsM[0], fillsNew);

  // cellXfs — 원본 xf를 복제해 fill만 노랗게 바꾼다(글꼴·테두리·줄바꿈 유지)
  const xfsM = xml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!xfsM) throw new Error("styles.xml에 <cellXfs>가 없다");
  // ★자식(<alignment/>)이 있는 xf를 lazy 매칭하면 그 `/>`에서 끊겨 태그가 안 닫힌다.
  //   자기닫힘과 자식 있는 경우를 따로 매칭한다.
  const xfs = [...xfsM[2].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
  let count = Number(xfsM[1]);
  const map = {};              // 원본 s → 노란 s
  let added = "";
  for (const src of srcIdxSet) {
    const base = xfs[src] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    let cloned = base.replace(/\sfillId="\d+"/, ` fillId="${newFillId}"`);
    if (!/fillId=/.test(cloned)) cloned = cloned.replace(/<xf\b/, `<xf fillId="${newFillId}"`);
    cloned = /applyFill=/.test(cloned)
      ? cloned.replace(/applyFill="[01]"/, 'applyFill="1"')
      : cloned.replace(/<xf\b/, "<xf applyFill=\"1\"");
    added += cloned;
    map[src] = count++;
  }
  // 코멘트 셀용 — 줄바꿈 + 위 정렬
  const commentStyle = count++;
  added += '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>';
  xml = xml.replace(xfsM[0], `<cellXfs count="${count}">${xfsM[2]}${added}</cellXfs>`);
  return { xml, map, commentStyle };
}

// ── 시트 XML 한 장 수정 ────────────────────────────────────────
const COMMENT_WIDTH = 60;

function patchSheet(xml, { headerRow, commentCol, comments, highlights, yellowMap, commentStyle }) {
  const ref = (r, c) => `${colLetter(c)}${r}`;

  // 0) 코멘트 열 폭 — 기본 폭(8.43)이면 일본어 지적문이 거의 안 보인다.
  const colDef = `<col min="${commentCol}" max="${commentCol}" width="${COMMENT_WIDTH}" customWidth="1"/>`;
  if (/<cols>/.test(xml)) {
    xml = xml.replace("</cols>", `${colDef}</cols>`);
  } else {
    // <cols>는 sheetData 바로 앞에 와야 한다(스키마 순서 고정)
    xml = xml.replace("<sheetData>", `<cols>${colDef}</cols><sheetData>`);
  }

  // 1) 지적 셀 노란색 — 기존 <c>의 s= 교체
  for (const [key, srcS] of highlights) {
    const re = new RegExp(`(<c\\b[^>]*\\br="${key}")([^>]*)(/?>)`);
    xml = xml.replace(re, (full, head, attrs, close) => {
      const next = yellowMap[srcS];
      if (next == null) return full;
      const a = /\bs="\d+"/.test(attrs) ? attrs.replace(/\bs="\d+"/, `s="${next}"`) : `${attrs} s="${next}"`;
      return `${head}${a}${close}`;
    });
  }

  // 2) 코멘트 셀 추가 — 각 행 끝에 inlineStr로 붙인다
  const want = new Map(comments);                 // row → text
  want.set(headerRow, COMMENT_HEADER);
  xml = xml.replace(/<row\b([^>]*)\br="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (full, a1, rNum, a2, body) => {
    const r = Number(rNum);
    if (!want.has(r)) return full;
    const text = want.get(r);
    want.delete(r);
    const cell = `<c r="${ref(r, commentCol)}" s="${commentStyle}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    // spans 속성이 있으면 범위를 넓혀 준다(없어도 엑셀은 연다)
    let attrs = a1 + ` r="${rNum}"` + a2;
    attrs = attrs.replace(/spans="(\d+):(\d+)"/, (_m, s, e) => `spans="${s}:${Math.max(Number(e), commentCol)}"`);
    return `<row${attrs}>${body}${cell}</row>`;
  });

  // 자기 닫는 <row .../> (빈 행)에는 안 붙인다 — 지적 대상이 아니므로 무시
  return xml;
}

/**
 * @param {Buffer} buffer      원본 설정집 xlsx
 * @param {Array}  findings    [{sheet, row, column, text}] — column은 열 번호(1-based), 없으면 색칠 생략
 * @returns {{buffer: Buffer, annotated: number, sheets: string[]}}
 */
export async function annotateSetjip(buffer, findings) {
  const zip = await JSZip.loadAsync(buffer);
  const paths = await sheetPathMap(zip);
  const sst = await sharedStrings(zip);

  // 시트별로 모은다
  const bySheet = new Map();
  for (const f of findings) {
    if (!paths[f.sheet]) continue;
    if (!bySheet.has(f.sheet)) bySheet.set(f.sheet, []);
    bySheet.get(f.sheet).push(f);
  }
  if (!bySheet.size) return { buffer, annotated: 0, sheets: [] };

  // 1차 패스 — 색칠 대상 셀의 기존 스타일 인덱스를 모은다
  const plan = [];
  const srcStyles = new Set();
  for (const [sheet, items] of bySheet) {
    const path = paths[sheet];
    const xml = await zip.file(path).async("string");

    // 헤더 행 = 처음 12행 중 **값이 있는** 셀이 3개 이상인 첫 행.
    // ★빈 <c>까지 세면 서식만 깔린 1행이 헤더로 잡힌다(실측: 01.Character Name은 6행이 헤더).
    let headerRow = 0, maxCol = 1;
    for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const r = Number(m[1]);
      const cells = [...m[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)].map((c) => colIndex(c[1]));
      if (cells.length) maxCol = Math.max(maxCol, ...cells);
      // ★공유 문자열을 풀어 실제 내용이 있는 셀만 센다. 빈 문자열("")도 <v>로 들어와서
      //   풀지 않으면 서식만 깔린 1행이 헤더로 잡힌다(실측: 1행 filled 9 vs 진짜 헤더 6행).
      const filled = [...m[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].filter((c) => {
        const body = c[2];
        if (/t="s"/.test(c[1])) return String(sst[Number((body.match(/<v>(\d+)<\/v>/) || [])[1])] ?? "").trim() !== "";
        const inline = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        if (inline != null) return inline.trim() !== "";
        return String((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? "").trim() !== "";
      }).length;
      if (r <= 12 && !headerRow && filled >= 3) headerRow = r;
    }
    if (!headerRow) headerRow = 1;
    const commentCol = maxCol + 1;

    const highlights = [];
    const comments = new Map();
    for (const f of items) {
      const prev = comments.get(f.row);
      comments.set(f.row, prev ? `${prev}\n\n${f.text}` : f.text);
      if (!f.column) continue;
      const key = `${colLetter(f.column)}${f.row}`;
      const cm = xml.match(new RegExp(`<c\\b[^>]*\\br="${key}"[^>]*`));
      const s = cm ? Number((cm[0].match(/\bs="(\d+)"/) || [])[1] ?? 0) : 0;
      srcStyles.add(s);
      highlights.push([key, s]);
    }
    plan.push({ sheet, path, xml, headerRow, commentCol, comments, highlights });
  }

  // 스타일 추가
  const stylesXml = await zip.file("xl/styles.xml").async("string");
  const { xml: newStyles, map: yellowMap, commentStyle } = addYellowStyles(stylesXml, srcStyles);
  zip.file("xl/styles.xml", newStyles);

  // 2차 패스 — 실제 수정
  for (const p of plan) {
    zip.file(p.path, patchSheet(p.xml, { ...p, yellowMap, commentStyle }));
  }

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: out, annotated: findings.length, sheets: [...bySheet.keys()] };
}

export { colLetter, colIndex };
