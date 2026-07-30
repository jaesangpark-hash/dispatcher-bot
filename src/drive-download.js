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
// 폴더 하위 목록(파일+폴더 섞여서 나옴). type===2가 파일, 그 외는 폴더로 추정(실사용하며 보정 필요).
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
  return { url, expiresInSec: item.expire || 1200 }; // 20분 정도로 짧음 — 발급 즉시 사용할 것
}

// ── 회차 매칭 공통 ───────────────────────────────────────
// 이름 맨 앞의 0채움 숫자를 회차/페이지 번호로 보고 매칭
// (Kuaikan "022第二十二话", arthub "04" 등 접미사 유무와 무관하게 동작)
function findByLeadingNumber(items, targetNum, nameKey = "name") {
  const target = String(Number(targetNum));
  return items.find((it) => {
    const name = String(it[nameKey] || "");
    const m = name.match(/^0*(\d+)/);
    return m && String(Number(m[1])) === target;
  });
}

export {
  detectDrivePlatform,
  parseDriveUrl,
  kuaikanListChildren,
  kuaikanGetDownloadUrl,
  arthubListChildren,
  arthubGetDownloadSignature,
  findByLeadingNumber,
  KuaikanSessionExpiredError,
  DriveFileUnsupportedError,
};
