// xlsx 셀(행) 높이 최소값 강제 — ZIP 내부 worksheet XML만 문자열 치환으로 패치.
// SheetJS(xlsx 패키지) 전체 재작성은 이미지 등 임베드 콘텐츠를 손실시킴(확인됨, 98.8% 데이터 손실).
// 이 방식은 xl/worksheets/sheetN.xml의 <row> 태그만 건드리고 xl/media, xl/drawings 등은 그대로 두므로 안전.
import JSZip from "jszip";

// buffer: xlsx 바이너리, minHeight: 포인트 단위 최소 행 높이(엑셀 기본 15pt)
export async function patchMinRowHeight(buffer, minHeight = 20) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetPaths = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  let changedRows = 0;

  for (const path of sheetPaths) {
    let xml = await zip.file(path).async("string");
    xml = xml.replace(/<row ([^>]*?)(\/?)>/g, (full, attrs, selfClose) => {
      const htMatch = attrs.match(/ht="([\d.]+)"/);
      const curHt = htMatch ? parseFloat(htMatch[1]) : null;
      if (curHt !== null && curHt >= minHeight) return full;
      changedRows++;
      let newAttrs = htMatch ? attrs.replace(/ht="[\d.]+"/, `ht="${minHeight}"`) : `${attrs.trim()} ht="${minHeight}"`;
      newAttrs = /customHeight="/.test(newAttrs)
        ? newAttrs.replace(/customHeight="[01]"/, `customHeight="1"`)
        : `${newAttrs.trim()} customHeight="1"`;
      return `<row ${newAttrs.trim()}${selfClose}>`;
    });
    zip.file(path, xml);
  }

  const out = await zip.generateAsync({ type: "nodebuffer" });
  return { buffer: out, changedRows, sheetsPatched: sheetPaths.length };
}
