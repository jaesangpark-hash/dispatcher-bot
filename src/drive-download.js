// 재수급 원본 드라이브 자동 다운로드 — Kuaikan Drive / arthub.qq.com (baidu는 앱 전용이라 미지원)
// 파일 바이트 자체를 여기서 받지 않고, 각 플랫폼이 주는 COS 서명URL을 그대로 반환한다.
// 호출부(게이트웨이 릴레이)가 그 URL을 그대로 넘기면 되므로 우리 서버를 거치지 않음.

const KUAIKAN_BASE = "https://pan.kuaikanmanhua.com/v1/kkftp/entry";
const ARTHUB_BASE = "https://service.arthub.qq.com/tencentcomics/data/openapi/v2/core";

// zip처럼 안에 여러 파일이 압축돼 있는 건 개별 페이지 자동 추출을 지원하지 않음(사람이 직접 처리).
// 크기도 이 이상이면(서버 과부하 위험) 자동 처리 대신 에러만 던지고 멈춤.
const UNSUPPORTED_ARCHIVE_EXT = /\.(zip|rar|7z)$/i;
const MAX_SAFE_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

class DriveFileUnsupportedError extends Error {
  constructor(reason, fileInfo) {
    super(`자동 처리 불가(사람 확인 필요): ${reason} — ${fileInfo?.name || "?"}`);
    this.name = "DriveFileUnsupportedError";
    this.fileInfo = fileInfo;
  }
}

// 페이지로 특정한 파일이 실제로 자동 처리 가능한지 확인. zip류거나 너무 크면 여기서 막음.
function assertFileIsSafeToProcess(fileInfo) {
  const name = String(fileInfo?.name || "");
  if (UNSUPPORTED_ARCHIVE_EXT.test(name)) {
    throw new DriveFileUnsupportedError("압축파일(zip 등)로 묶여있어 개별 페이지 자동 추출 불가", fileInfo);
  }
  const size = fileInfo?.size ?? fileInfo?.capacity ?? null;
  if (size != null && size > MAX_SAFE_FILE_SIZE_BYTES) {
    const gb = (size / (1024 * 1024 * 1024)).toFixed(1);
    throw new DriveFileUnsupportedError(`파일 크기가 비정상적으로 큼(${gb}GB) — 서버 부하 방지를 위해 자동 처리 생략`, fileInfo);
  }
}

// Kuaikan은 ID/PW 로그인 세션(쿠키)이 계속 유지되는 방식이라, 최초 1회 사람이 로그인해서 얻은
// 쿠키를 .env에 저장해두고 재사용한다. 세션이 끊기면(쿠키 무효화) 이 함수가 에러를 던짐.
function kuaikanCookie() {
  const c = process.env.KUAIKAN_SESSION_COOKIE;
  if (!c) {
    throw new Error(
      "KUAIKAN_SESSION_COOKIE 없음 — .env에 'ftp_session=...; ftp_mail=...; uid=...' 형태로 추가 필요(브라우저에서 로그인 후 쿠키 복사)"
    );
  }
  return c;
}

// 세션 만료를 별도로 식별할 수 있게 커스텀 에러 타입 사용 — 호출부(app.js)가 이걸 잡아서
// dmOwner()로 "재로그인 필요" 알림을 보낼 수 있도록. drive-download.js는 app.js를 모르는
// 순수 모듈로 유지(Slack 발송은 호출부 책임).
class KuaikanSessionExpiredError extends Error {
  constructor(detail) {
    super(`Kuaikan 세션 만료(재로그인 필요): ${detail}`);
    this.name = "KuaikanSessionExpiredError";
  }
}

// HTTP 상태나 응답 형태로 "로그인 페이지로 튕겼다/세션이 죽었다"를 판별.
// 정확한 만료 응답 코드를 아직 실측 못 했으니, 확실한 신호(401/403·JSON 아님·code 누락)만 우선 잡음.
function assertKuaikanSessionAlive(res, rawText) {
  if (res.status === 401 || res.status === 403) {
    throw new KuaikanSessionExpiredError(`HTTP ${res.status}`);
  }
  let j;
  try {
    j = JSON.parse(rawText);
  } catch {
    throw new KuaikanSessionExpiredError("응답이 JSON이 아님(로그인 페이지로 리다이렉트된 것으로 추정)");
  }
  return j;
}

// ── 플랫폼 판별 & URL 파싱 ──────────────────────────────────────────
function detectDrivePlatform(url) {
  if (/pan\.kuaikanmanhua\.com/.test(url)) return "kuaikan";
  if (/arthub\.qq\.com/.test(url)) return "arthub";
  if (/pan\.baidu\.com/.test(url)) return "baidu"; // 자동 다운로드 미지원(앱 전용) — 사람이 처리
  return null;
}

function parseDriveUrl(url) {
  const platform = detectDrivePlatform(url);
  if (platform === "kuaikan") {
    const m = url.match(/fileId=(\d+)/);
    if (!m) throw new Error("Kuaikan URL에서 fileId를 못 찾음: " + url);
    return { platform, rootId: m[1] };
  }
  if (platform === "arthub") {
    const nodeM = url.match(/node=(\d+)/);
    const tokenM = url.match(/token=([^&]+)/);
    if (!nodeM || !tokenM) throw new Error("arthub URL에서 node/token을 못 찾음: " + url);
    return { platform, rootId: nodeM[1], token: tokenM[1] };
  }
  return { platform, rootId: null };
}

// ── Kuaikan ──────────────────────────────────────────────
// 폴더 하위 목록(파일+폴더 섞여서 나옴). 실측 확인: type:1=폴더, type:2=파일.
async function kuaikanListChildren(folderId, page = 1, limit = 50) {
  const url = `${KUAIKAN_BASE}/list/new?id=${encodeURIComponent(folderId)}&page=${page}&limit=${limit}`;
  const r = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: kuaikanCookie(),
      language: "korean",
      logintype: "web",
      systemtype: "web",
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  const j = assertKuaikanSessionAlive(r, text);
  if (j.code === 401 || j.code === 403) throw new KuaikanSessionExpiredError(`응답 code=${j.code}`);
  if (j.code !== 200) throw new Error(`Kuaikan list 실패: ${text.slice(0, 200)}`);
  return (j.data && j.data.sub_dirs) || [];
}

async function kuaikanGetDownloadUrl(fileId) {
  const r = await fetch(`${KUAIKAN_BASE}/download`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json, text/plain, */*",
      cookie: kuaikanCookie(),
      language: "korean",
      logintype: "web",
      systemtype: "web",
    },
    body: JSON.stringify({ id: Number(fileId) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  const j = assertKuaikanSessionAlive(r, text);
  if (j.code === 401 || j.code === 403) throw new KuaikanSessionExpiredError(`응답 code=${j.code}`);
  const item = j.data && j.data.downloads && j.data.downloads[0];
  if (!item) throw new Error(`Kuaikan download 실패: ${text.slice(0, 200)}`);
  assertFileIsSafeToProcess({ name: item.name, size: item.size });
  const dlUrl = item.store_location.startsWith("//") ? "https:" + item.store_location : item.store_location;
  return { name: item.name, url: dlUrl, size: item.size || null };
}

// Kuaikan은 arthub처럼 작품별 공유링크가 없고, 하나의 드라이브(id=0) 안에 작품 폴더가 다 들어있음.
// 우리 시트에 그 작품의 드라이브 링크가 비어있을 때, 원제(중국어)로 루트에서 이름 검색해 폴더를 찾는 용도.
// 검색 결과가 1건이 아니면(0건 또는 여러 건) 호출부가 사람 확인으로 넘겨야 함 — 여기서 추측 안 함.
async function kuaikanSearchRoot(query, page = 1, limit = 50) {
  const url = `${KUAIKAN_BASE}/list/new?id=0&page=${page}&limit=${limit}&fuzzy_name=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: kuaikanCookie(),
      language: "korean",
      logintype: "web",
      systemtype: "web",
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  const j = assertKuaikanSessionAlive(r, text);
  if (j.code === 401 || j.code === 403) throw new KuaikanSessionExpiredError(`응답 code=${j.code}`);
  if (j.code !== 200) throw new Error(`Kuaikan 검색 실패: ${text.slice(0, 200)}`);
  return (j.data && j.data.sub_dirs) || [];
}

// ── arthub (로그인 불필요, publictoken=공유링크의 token 값) ──────────
async function arthubListChildIds(parentId, token, offset = 0, count = 50) {
  const r = await fetch(`${ARTHUB_BASE}/get-child-node-id-in-range`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      publictoken: token,
      origin: "https://arthub.qq.com",
      referer: "https://arthub.qq.com/",
    },
    body: JSON.stringify({
      parent_id: Number(parentId),
      offset,
      count,
      filter: [],
      order: { meta: "updated_date", type: "descend" },
      is_recursive: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`arthub 목록 실패: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.result && j.result.nodes) || [];
}

async function arthubGetNodeBriefs(ids, token) {
  if (!ids.length) return [];
  const r = await fetch(`${ARTHUB_BASE}/get-node-brief-by-id`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      publictoken: token,
      origin: "https://arthub.qq.com",
      referer: "https://arthub.qq.com/",
    },
    body: JSON.stringify({ ids: ids.map(Number) }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`arthub 상세조회 실패: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.result && j.result.items) || [];
}

// parentId 하위의 폴더/파일 상세 목록(이름·타입·크기 포함) 한 번에 반환
async function arthubListChildren(parentId, token) {
  const ids = await arthubListChildIds(parentId, token);
  return arthubGetNodeBriefs(ids, token);
}

// knownSize: get-node-brief-by-id의 capacity 값을 호출부가 미리 알고 있으면 넘겨줄 것
// (이 서명 발급 API 자체 응답엔 크기가 없어서, 사전 체크하려면 listing 단계 값을 재사용해야 함)
async function arthubGetDownloadSignature(objectId, token, downloadName, knownSize) {
  assertFileIsSafeToProcess({ name: downloadName, size: knownSize });
  const r = await fetch(`${ARTHUB_BASE}/get-download-signature`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      publictoken: token,
      origin: "https://arthub.qq.com",
      referer: "https://arthub.qq.com/",
    },
    body: JSON.stringify([
      {
        object_id: Number(objectId),
        object_meta: "origin_url",
        content_type: "application%2Foctet-stream",
        download_name: downloadName || String(objectId),
      },
    ]),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  const item = j.result && j.result.items && j.result.items[0];
  if (!item) throw new Error(`arthub 서명URL 발급 실패: ${JSON.stringify(j).slice(0, 200)}`);
  const url = item.signed_url.startsWith("//") ? "https:" + item.signed_url : item.signed_url;
  return { name: item.download_name || downloadName || String(objectId), url, expiresInSec: item.expire || 1200 }; // 20분 정도로 짧음 — 발급 즉시 사용할 것
}

// ── 회차/페이지 매칭 공통 ───────────────────────────────────────
// "폴더마다 명명 규칙이 같을 것"이라고 가정하지 않는다. 대신 파일명 안에 그 번호가
// "독립된 숫자 토큰"으로 정확히 몇 군데 나오는지 세서, 유일하게 하나에서만 나오면
// 그때만 확정(confident:true)하고, 없거나 여러 곳에서 나오면 확정하지 않는다
// (호출부가 candidates를 사람에게 보여주고 확인받아야 함 — 추측으로 고르지 않음).
// 앞자리 0은 허용(01=1), "11"·"21" 같은 다른 숫자 안에 낀 건 매칭 안 됨.
function matchByNumber(items, targetNum, nameKey = "name") {
  const target = String(Number(targetNum));
  const re = new RegExp(`(?<!\\d)0*${target}(?!\\d)`);
  const candidates = items.filter((it) => re.test(String(it[nameKey] || "")));
  return { confident: candidates.length === 1, item: candidates.length === 1 ? candidates[0] : null, candidates };
}

// 하위 호환용 — 맨 앞자리 숫자만 보는 단순 매칭(패턴이 명확히 확인된 상황에서만 쓸 것).
// 새 코드는 matchByNumber를 우선 쓰고, confident:false면 사람 확인으로 넘길 것.
function findByLeadingNumber(items, targetNum, nameKey = "name") {
  const target = String(Number(targetNum));
  return items.find((it) => {
    const name = String(it[nameKey] || "");
    const m = name.match(/^0*(\d+)/);
    return m && String(Number(m[1])) === target;
  });
}

// 카테고리 폴더(PSD/JPG 등) 찾기. 두 단계로:
// ① 이름이 정확히 일치(대소문자 무관, 예 "PSD")하는 것부터 우선 찾음
// ② ①이 하나도 없을 때만 느슨한 포함 매칭으로 폴백(예 "본문_PSD 원파일_최종안")
// "横竖封jpg+psd"처럼 표지용 소규모 폴더가 느슨한 매칭에 같이 걸려버리는 걸 막기 위함 —
// 정확히 일치하는 폴더가 있으면 그게 항상 우선.
const CATEGORY_EXACT = { psd: /^psd$/i, jpg: /^jpe?g$/i };
const CATEGORY_LOOSE = { psd: /psd/i, jpg: /jpe?g/i };
function findCategoryFolders(items, category, isDirFn) {
  const exact = CATEGORY_EXACT[category], loose = CATEGORY_LOOSE[category];
  if (!exact || !loose) throw new Error(`알 수 없는 카테고리: ${category}`);
  const exactHits = items.filter((it) => isDirFn(it) && exact.test(String(it.name || "").trim()));
  if (exactHits.length) return exactHits;
  return items.filter((it) => isDirFn(it) && loose.test(String(it.name || "")));
}

// 플랫폼별 "이 항목이 폴더인가" 판별(실측 기준: Kuaikan은 type:1=폴더/2=파일, arthub는 type:"directory"/"asset")
const isKuaikanDir = (it) => it?.type === 1;
const isArthubDir = (it) => it?.type === "directory";

// 회차 폴더를 찾는다. 최우선은 "이 레벨 자체가 회차 폴더 집합인가"(직접 매칭) —
// 폴더명에 "psd"/"jpg"가 접미사로 들어있어도(예: "哥哥第1话psd") 회차 매칭이 우선이라
// 카테고리 폴더로 오인하지 않는다. 직접 매칭이 안 될 때만 카테고리 폴더/래퍼 폴더로 내려가며
// 재시도(최대 2단계). 그래도 안 되면 절대 추측하지 않고 needsHuman으로 후보를 그대로 반환.
async function findEpisodeFolder(listChildren, isDirFn, containerId, episode, fileType, depth = 0) {
  const list = await listChildren(containerId);
  const dirs = list.filter(isDirFn);

  const direct = matchByNumber(dirs, episode);
  if (direct.confident) return { ok: true, folder: direct.item };

  if (depth >= 2) return { ok: false, needsHuman: true, reason: "회차 폴더를 특정 못 함(구조가 예상보다 깊거나 다름)", candidates: list };

  const cat = findCategoryFolders(list, fileType, isDirFn);
  if (cat.length === 1) return findEpisodeFolder(listChildren, isDirFn, cat[0].id, episode, fileType, depth + 1);
  if (cat.length > 1) {
    // 카테고리 후보들 중에 혹시 회차번호로 바로 매칭되는 게 있으면(폴더명에 psd/jpg가 접미사로만 붙은 경우) 그걸 채택
    const among = matchByNumber(cat, episode);
    if (among.confident) return { ok: true, folder: among.item };
    return { ok: false, needsHuman: true, reason: `"${fileType}" 카테고리 폴더가 여러 개 걸림 — 확인 필요`, candidates: cat };
  }

  // 카테고리도 없고 회차도 안 보이면, 하위 폴더가 딱 하나(래퍼, 예: "온라인 원고")일 때만 한 단계 더 내려가봄
  if (dirs.length === 1) return findEpisodeFolder(listChildren, isDirFn, dirs[0].id, episode, fileType, depth + 1);

  return { ok: false, needsHuman: true, reason: "회차 폴더를 특정 못 함(최상위 구조 확인 필요)", candidates: list };
}

/**
 * PIVO/작품 진입 링크부터 특정 회차+페이지 파일까지 자동 탐색(플랫폼 공통 로직).
 * adapter: { listChildren(id) => Promise<items[]>, isDir(item) => bool, getFile(item) => Promise<{name,url,size}> }
 * 확신 없는 단계(카테고리 폴더 여러 개, 회차/페이지 매칭 애매)에서는 절대 추측하지 않고
 * { ok:false, needsHuman:true, reason, candidates } 형태로 그대로 반환 — 호출부(Slack)가 사람에게 보여주고 확인받아야 함.
 */
async function resolveEpisodePage(adapter, rootId, episode, page, fileType = "psd") {
  const { listChildren, isDir, getFile } = adapter;

  const epResult = await findEpisodeFolder(listChildren, isDir, rootId, episode, fileType);
  if (!epResult.ok) return epResult;

  const pages = await listChildren(epResult.folder.id);
  const pgMatch = matchByNumber(pages.filter((it) => !isDir(it)), page);
  if (!pgMatch.confident) {
    return { ok: false, needsHuman: true, reason: `${page}페이지 매칭 애매/실패`, candidates: pgMatch.candidates.length ? pgMatch.candidates : pages };
  }

  const file = await getFile(pgMatch.item);
  return { ok: true, name: file.name, url: file.url, size: file.size ?? null, expiresInSec: file.expiresInSec ?? null };
}

function makeArthubAdapter(token) {
  return {
    listChildren: (id) => arthubListChildren(id, token),
    isDir: isArthubDir,
    getFile: (item) => arthubGetDownloadSignature(item.id, token, item.name, item.capacity),
  };
}

function makeKuaikanAdapter() {
  return {
    listChildren: (id) => kuaikanListChildren(id),
    isDir: isKuaikanDir,
    getFile: (item) => kuaikanGetDownloadUrl(item.id),
  };
}

export {
  detectDrivePlatform,
  parseDriveUrl,
  kuaikanListChildren,
  kuaikanGetDownloadUrl,
  kuaikanSearchRoot,
  arthubListChildren,
  arthubGetDownloadSignature,
  findByLeadingNumber,
  matchByNumber,
  findCategoryFolders,
  isKuaikanDir,
  isArthubDir,
  findEpisodeFolder,
  resolveEpisodePage,
  makeArthubAdapter,
  makeKuaikanAdapter,
  KuaikanSessionExpiredError,
  DriveFileUnsupportedError,
};
