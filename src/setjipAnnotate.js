// 설정집 xlsx에 검수 결과를 직접 써 넣는다 — 우측 「AI検収」 열에 일본어 지적, 지적 셀만 색칠.
// ★ExcelJS로 재직렬화하면 이미지·도형이 날아간다(설정집은 SS 이미지가 수십 장).
//   그래서 xlsxRowHeight.js와 같은 방식으로 JSZip으로 풀어 sheet XML을 직접 고친다.
import JSZip from "jszip";

const COMMENT_HEADER = "AI検収";
// ★주황이다. 노랑으로 칠하던 걸 바꿨다(2026-10-08) — 설정집 원본에 작업자가 칠해둔 노란 셀이
//   이미 있어서 AI가 지적한 셀과 구분이 안 됐다.
const HILITE = "FFFFC000";
// ★코멘트 열은 M(13) 고정(재상 님 지시 2026-10-05). 종전엔 '마지막으로 쓰인 열+1'이라
//   서식만 깔린 빈 열이 Z까지 이어진 파일에서 AA열에 붙어 안 보였다.
//   단 실제 데이터가 M을 넘어가면 그 뒤로 밀어 덮어쓰기를 막는다.
const COMMENT_COL_FIXED = 13;
// 엔진이 검수 대상에서 빼는 시트 — 여기엔 색칠도 코멘트도 하지 않는다
const EXCLUDED_SHEETS = /^(03\.Font|04\.Cover|05\.Confirm)/i;

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
  const fillsNew = `<fills count="${newFillId + 1}">${fillsM[2]}<fill><patternFill patternType="solid"><fgColor rgb="${HILITE}"/><bgColor indexed="64"/></patternFill></fill></fills>`;
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
    // 검수 대상이 아닌 시트에는 손대지 않는다 — 실측에서 05.Confirm에 노란 셀 6개가 칠해졌다
    if (EXCLUDED_SHEETS.test(f.sheet)) continue;
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
      // 값이 든 셀만 센다 — 서식만 깔린 빈 열까지 세면 코멘트가 한참 오른쪽에 붙는다
      const cells = [...m[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>[\s\S]*?<\/c>/g)]
        .filter((c) => /<v>[^<]/.test(c[0]) || /<t[^>]*>[^<]/.test(c[0]))
        .map((c) => colIndex(c[0].match(/\br="([A-Z]+)\d+"/)[1]));
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
    const commentCol = Math.max(COMMENT_COL_FIXED, maxCol + 1);

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

// ── 워크북 색인 — 시트별 헤더 행·열 라벨·전체 셀 값 ───────────────
export async function readWorkbookIndex(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const paths = await sheetPathMap(zip);
  const sst = await sharedStrings(zip);
  const out = {};
  for (const [name, path] of Object.entries(paths)) {
    const xml = await zip.file(path).async("string");
    const cells = {};
    let headerRow = 0;
    for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const r = Number(rm[1]);
      const row = {};
      for (const cm of rm[2].matchAll(/<c\b([^>]*)\br="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] + cm[3];
        const body = cm[4] || "";
        let v = null;
        if (/t="s"/.test(attrs)) v = sst[Number((body.match(/<v>(\d+)<\/v>/) || [])[1])];
        else if (/t="inlineStr"/.test(attrs)) v = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        else v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null && String(v).trim()) row[colIndex(cm[2])] = String(v);
      }
      if (Object.keys(row).length) cells[r] = row;
      if (!headerRow && r <= 12 && Object.keys(row).length >= 3) headerRow = r;
    }
    out[name] = { headerRow: headerRow || 1, cols: cells[headerRow] || {}, cells };
  }
  return out;
}

// ── 지적문에서 '어느 칸'인지 ─────────────────────────────────────
const ALIAS_COL = [
  [/JP名前|JA名前|名前欄|日本語名/, ["JA", "JA名", "日本語"]],
  [/CH欄|ZH|中国語/, ["ZH-CN", "ZH", "中国語"]],
  [/設定及び特徴|設定および特徴|設定・特徴|特徴欄/, ["設定及び特徴", "設定および特徴"]],
  [/語尾|口調/, ["語尾"]],
  [/一人称|1人称/, ["1人称"]],
  [/呼び方|呼称/, ["呼び方"]],
  [/説明欄|説明文/, ["説明"]],
  [/登場話数|話数/, ["登場話数"]],
  [/性別/, ["性別"]],
  [/年齢/, ["年齢"]],
];
function pickCol(cols, text) {
  if (!text) return null;
  for (const [re, labels] of ALIAS_COL) {
    if (!re.test(text)) continue;
    for (const [idx, label] of cols) {
      const key = String(label).split("\n")[0].trim();
      if (labels.some((l) => key === l || key.startsWith(l))) return Number(idx);
    }
  }
  for (const [idx, label] of cols) {
    const key = String(label).split("\n")[0].replace(/\(.*$/s, "").trim();
    if (key.length >= 2 && text.includes(key)) return Number(idx);
  }
  return null;
}

// 행이 안 적힌 지적(횡단·공통)은 그 용어가 **처음 나오는 행**에 붙인다(재상 님 지시 2026-10-05)
function firstRowOf(sheet, text) {
  const cands = [];
  for (const m of String(text).matchAll(/[「『"']([^」』"']{2,30})["'」』]/g)) cands.push(m[1]);
  for (const m of String(text).matchAll(/[゠-ヿ一-鿿]{2,}/g)) cands.push(m[0]);
  const seen = new Set();
  const uniq = cands.map((c) => c.trim()).filter((c) => c.length >= 2 && !seen.has(c) && seen.add(c))
    .sort((a, b) => b.length - a.length);   // 긴 후보부터 — 짧은 조각이 엉뚱한 행에 걸리는 걸 줄인다
  const rows = Object.keys(sheet.cells).map(Number).filter((r) => r > sheet.headerRow).sort((a, b) => a - b);
  for (const term of uniq) {
    for (const r of rows) {
      for (const [col, val] of Object.entries(sheet.cells[r])) {
        if (String(val).includes(term)) return { row: r, column: Number(col) };
      }
    }
  }
  return null;
}

const SHEET_ALIAS = [
  [/システムメッセージ|システムメッセ|SystemMessage/i, /SystemMessage/i],
  [/Character|人物|登場人物|あらすじ|줄거리/i, /Character/i],
  [/Term|用語/i, /Term/i],
];

/** 엔진 reviews → annotateSetjip 이 받는 findings */
export function mapFindings(index, reviews) {
  const keys = Object.keys(index);
  const out = [];
  const skipped = [];
  for (const v of reviews || []) {
    const loc = String(v.locator || "");
    const detail = String(v.issue_detail || "");
    const sugg = String(v.suggestion || "");
    // 엔진 시트명엔 「シート」「★最優先」 같은 꼬리표가 붙는다
    let sheet = String(v.sheet || "").replace(/★.*$/, "").replace(/シート$/, "").trim();
    if (!index[sheet]) {
      const flat = (t) => t.replace(/\s/g, "");
      let hit = keys.find((k) => flat(k).startsWith(flat(sheet)) || flat(sheet).startsWith(flat(k)));
      if (!hit) for (const [re, target] of SHEET_ALIAS) if (re.test(sheet)) { hit = keys.find((k) => target.test(k)); break; }
      if (hit) sheet = hit;
    }
    let row = Number((loc.match(/(\d+)\s*行/) || [])[1]) || 0;
    // 「その他・共通」처럼 실제 시트가 아니면 locator에서 시트+행을 건진다
    if (!index[sheet] || !row) {
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const name of keys) {
        for (const pat of [esc(name), esc(name.split(/\s+/)[0])]) {
          const m = loc.match(new RegExp(`${pat}[^\\d]{0,6}(\\d+)\\s*行`));
          if (m) { sheet = name; row = Number(m[1]); break; }
        }
        if (index[sheet] && row) break;
      }
    }
    if (!index[sheet] || EXCLUDED_SHEETS.test(sheet)) { skipped.push(v); continue; }

    const cols = Object.entries(index[sheet].cols);
    // 지적문이 '무엇이 문제인가'를 가리킨다. 수정안은 고칠 자리를 다른 칸으로 안내하는 일이 많아 뒤로 민다.
    let column = pickCol(cols, detail) ?? pickCol(cols, sugg);
    if (!row) {
      const f = firstRowOf(index[sheet], `${loc} ${detail} ${sugg}`);
      if (!f) { skipped.push(v); continue; }
      row = f.row;
      column = column ?? f.column;
    }
    out.push({ sheet, row, column, text: `【${v.severity}】${detail}${sugg ? `\n→ ${sugg}` : ""}` });
  }
  return { findings: out, skipped };
}

export { colLetter, colIndex };
