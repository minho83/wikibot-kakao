# 🏰 어둠의전설 RAG 봇 시스템 — Claude Code 작업 명세서 v2

> **프로젝트명**: `lod-rag-server`  
> **목적**: 어둠의전설 게임 정보를 크롤링·책갈피 벡터화하여 카카오톡 `!검색` 명령으로 RAG 답변  
> **서버 환경**: Linux (UI 없는 headless 서버)  
> **GitHub 기존 레포**: https://github.com/minho83/wikibot-kakao  
> **v2 변경 핵심**:
> - 기존 `!현자` 명령 및 wikibot communityService.js → **완전 유지 (수정 없음)**
> - 신규 `!검색` 명령어 하나로 LOD 공홈 + 네이버 카페 **통합 검색**
> - RAG DB를 **책갈피(Bookmark) 2단계 방식**으로 설계

---

## 0. 책갈피 방식 RAG 개념 설명

기존 단순 RAG와의 차이점:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[기존 단순 RAG 방식]
  게시글 전체 본문 → 임베딩 → 벡터DB 저장
  질문 → 유사 본문 검색 → GPT 답변
  문제: 긴 본문 임베딩 시 노이즈 多, 검색 정확도 낮음
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[신규 책갈피 방식 (2단계 RAG)]

  [단계 1 — 크롤링 & 책갈피 생성]
  게시글 원본 크롤링
      ↓
  GPT로 요약 + 키워드 + 카테고리 태그 생성 → 책갈피(Bookmark)
      ↓
  책갈피 텍스트만 임베딩 → Qdrant 저장
  (원본 전체 내용은 data/*.json 파일로 별도 보존)

  [단계 2 — 검색 & 답변]
  사용자 질문
      ↓
  질문 임베딩 → Qdrant에서 유사 책갈피 Top-3 검색
      ↓
  책갈피의 content_path로 원본 JSON 파일 로드
      ↓
  원본 전체 내용 + 질문 → GPT-4o-mini → 최종 답변

  장점:
  ✅ 임베딩 정확도 향상 (짧은 키워드/요약 기반)
  ✅ 답변 품질 향상 (원본 전체 내용 기반으로 답변)
  ✅ 비용 효율적 (임베딩 토큰 대폭 감소)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 1. 전체 시스템 아키텍처

```
카카오톡 사용자
    │
    │  !현자 [검색어]    ← 기존 유지 (수정 없음)
    │  !검색 [검색어]    ← 신규 통합 명령어
    ▼
[Iris 앱] :3000                     ← 카카오톡 브릿지 (기존, 수정 없음)
    │ POST /webhook
    ▼
[iris-kakao-bot] Flask :5000        ← 명령어 처리 허브 (기존 + !검색 추가)
    │
    ├─ !현자  → /ask/community      ← 기존 wikibot 경로 (수정 없음)
    │
    └─ !검색  → /ask/search         ← 신규 (RAG 서버 직접 호출)
    │
    ▼
[wikibot-kakao] Node.js :8214       ← /ask/search 엔드포인트 추가
    │
    ├─ /ask/community → 기존 communityService.js (수정 없음)
    │
    └─ /ask/search    → RAG 서버 :8100/search 호출 (신규)
    │
    ▼
[lod-rag-server] FastAPI :8100      ← 신규 구축 핵심
    │
    │  [책갈피 검색 - 1단계]
    ├─ POST /search → Qdrant 책갈피 검색 (Top-3)
    │                    ↓
    │  [원본 내용 로드 - 2단계]
    └─────────────────→ data/*.json 원본 파일 로드 → GPT 답변
    │
    ▼
[Qdrant] :6333                      ← 책갈피 벡터 저장소
    └── collection: lod_bookmarks
          ├── source: "lod_nexon"   (LOD 공홈 현자의마을)
          └── source: "naver_cafe"  (네이버 카페 4개 게시판)

[data/ 디렉토리]                    ← 원본 게시글 전체 내용 보존
    ├── lod_nexon/{post_id}.json
    └── naver_cafe/{article_id}.json
```

---

## 2. 데이터 소스 정보

### 2-1. LOD 공식 홈페이지 (기존 !현자와 별개로 신규 크롤링)

| 항목 | 내용 |
|------|------|
| 대상 게시판 | 현자의 마을 (SearchBoard=1) |
| 목록 URL | `https://lod.nexon.com/Community/game?SearchBoard=1&Page={n}&Category2=1` |
| 상세 URL | `https://lod.nexon.com/Community/game/{post_id}?SearchBoard=1` |
| 목록 선택자 | `ul.community_s1 > li > a` |
| 본문 선택자 | `.board_text` |
| 로그인 필요 | ❌ 불필요 |
| 크롤링 방식 | `requests` + `BeautifulSoup4` |

### 2-2. 네이버 카페 (성천직자의 어둠의전설)

| 항목 | 내용 |
|------|------|
| 카페 ID | `13434008` |
| 카페 구조 | React SPA (`f-e` 경로) |
| 로그인 필요 | ✅ 본문 접근 시 필수 |
| 크롤링 방식 | `Playwright` async (headless + 쿠키 세션) |

**크롤링 대상 게시판 4개:**

| 게시판명 | 메뉴 ID | URL |
|---------|---------|-----|
| 팁과 정보 | `12` | `/menus/12` |
| 퀘스트 공략 | `11` | `/menus/11` |
| 아이템 정보 | `131` | `/menus/131` |
| 스킬 정보 | `132` | `/menus/132` |

**URL 패턴:**
```
목록: https://cafe.naver.com/f-e/cafes/13434008/menus/{menu_id}?page={n}
상세: https://cafe.naver.com/f-e/cafes/13434008/articles/{article_id}?menuid={menu_id}
```

**HTML 선택자 (실제 확인됨):**
```
게시글 목록 링크:  a.article
본문 (최신):       .se-viewer 또는 .se-main-container
본문 (구버전):     #postViewArea
레이아웃 구조:     .Layout_content__pUOz1 > .article-board > .board-list
```

---

## 3. 핵심 데이터 구조: 책갈피(Bookmark)

### 3-1. 원본 게시글 JSON (크롤링 직후 저장)

```json
// data/lod_nexon/{post_id}.json
// data/naver_cafe/{article_id}.json
{
  "id": "7832",
  "title": "원본 게시글 제목",
  "author": "작성자",
  "date": "2026.01.29",
  "views": 7461,
  "content": "게시글 본문 전체 텍스트 (수천 자 가능)",
  "url": "https://lod.nexon.com/Community/game/7832?SearchBoard=1",
  "source": "lod_nexon",
  "board_name": "현자의 마을",
  "crawled_at": "2026-02-23T00:00:00",
  "bookmark_created": false
}
```

### 3-2. 책갈피 JSON (GPT가 원본을 읽고 생성)

```json
// data/bookmarks/{source}_{id}.json
{
  "bookmark_id": "lod_nexon_7832",
  "title": "원본 게시글 제목",
  "summary": "3문장 이내 핵심 요약. 게임 용어 그대로 유지.",
  "keywords": ["성기사", "2차전직", "스킬트리", "SP분배"],
  "category_tags": ["직업정보", "스킬", "육성"],
  "source": "lod_nexon",
  "board_name": "현자의 마을",
  "date": "2026.01.29",
  "views": 7461,
  "url": "https://lod.nexon.com/Community/game/7832?SearchBoard=1",
  "content_path": "./data/lod_nexon/7832.json",
  "created_at": "2026-02-23T00:00:00"
}
```

### 3-3. Qdrant 저장 구조

```
컬렉션명: lod_bookmarks
벡터 크기: 1536 (text-embedding-3-small)
거리 측정: Cosine

임베딩 텍스트 (짧고 정확하게):
"제목: {title}
요약: {summary}
키워드: {keywords 쉼표 연결}
카테고리: {category_tags 쉼표 연결}
게시판: {board_name}"

페이로드 (검색 후 원본 로드에 사용):
{
  "bookmark_id":  "lod_nexon_7832",
  "title":        "원본 제목",
  "summary":      "요약 텍스트",
  "keywords":     ["성기사", "스킬트리"],
  "source":       "lod_nexon",
  "board_name":   "현자의 마을",
  "date":         "2026.01.29",
  "url":          "원본 URL",
  "content_path": "./data/lod_nexon/7832.json"  ← 원본 로드 경로
}
```

---

## 4. 기존 시스템 API 명세 (변경 없는 부분)

> ⚠️ **아래 항목들은 기존 코드 그대로 유지. 절대 수정하지 않음.**

### 4-1. Iris API — 수정 없음

```
POST http://192.168.0.80:3000/reply
  Body: { "type": "text", "room": "{chat_id}", "data": "메시지" }
  Body: { "type": "image", "room": "{chat_id}", "data": "{base64}" }
```

### 4-2. iris-kakao-bot /webhook — !현자 로직 수정 없음

```python
# 기존 코드 그대로 유지
elif msg_stripped.startswith("!현자"):
    query = msg_stripped[3:].strip()
    result = ask_wikibot("/ask/community", query)
    reply = format_search_result(result, sender)
    send_reply(chat_id, reply)
```

### 4-3. wikibot /ask/community — 수정 없음

```javascript
// communityService.js 기존 코드 그대로 유지
// lod.nexon.com 실시간 검색 방식 유지
```

---

## 5. 신규 구축: lod-rag-server

### 5-1. 프로젝트 디렉토리 구조

```
lod-rag-server/
│
├── app.py                          # FastAPI 메인 서버 (:8100)
│
├── crawler/
│   ├── __init__.py
│   ├── lod_crawler.py              # LOD 공홈 크롤러 (requests + BS4)
│   └── naver_cafe_crawler.py       # 네이버 카페 크롤러 (Playwright)
│
├── rag/
│   ├── __init__.py
│   ├── bookmark_creator.py         # 핵심: GPT로 책갈피 생성
│   ├── embedder.py                 # 책갈피 임베딩 → Qdrant 저장
│   └── retriever.py                # 2단계 검색 (책갈피→원본→답변)
│
├── scheduler/
│   ├── __init__.py
│   └── job.py                      # APScheduler 자동 크롤링
│
├── utils/
│   ├── __init__.py
│   └── notify.py                   # 카카오톡 알림 (쿠키 만료 등)
│
├── data/
│   ├── lod_nexon/                  # LOD 원본 게시글 JSON
│   │     └── {post_id}.json
│   ├── naver_cafe/                 # 네이버 카페 원본 게시글 JSON
│   │     └── {article_id}.json
│   └── bookmarks/                  # 생성된 책갈피 JSON
│         └── {source}_{id}.json
│
├── save_cookies_local.py           # [로컬 PC 전용] 네이버 쿠키 저장
├── import_cookies_manual.py        # [서버] 수동 쿠키값 입력 변환기
├── setup_server.sh                 # 리눅스 서버 초기 설치 스크립트
│
├── naver_cookies.json              # ← gitignore 필수!
├── .env
├── .env.example
├── requirements.txt
└── README.md
```

### 5-2. 환경변수 (.env)

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Qdrant
QDRANT_HOST=localhost
QDRANT_PORT=6333
QDRANT_COLLECTION=lod_bookmarks

# RAG 설정
EMBEDDING_MODEL=text-embedding-3-small
LLM_MODEL=gpt-4o-mini
BOOKMARK_TOP_K=3          # 책갈피 검색 수
MAX_ANSWER_LENGTH=300      # 카카오톡 메시지 최대 길이
SCORE_THRESHOLD=0.50       # 최소 유사도 임계값

# 크롤링 딜레이
LOD_DELAY_MIN=1
LOD_DELAY_MAX=3
NAVER_DELAY_MIN=3
NAVER_DELAY_MAX=5

# 데이터 경로
DATA_LOD_PATH=./data/lod_nexon
DATA_CAFE_PATH=./data/naver_cafe
DATA_BOOKMARK_PATH=./data/bookmarks
NAVER_COOKIES_PATH=./naver_cookies.json

# 기존 시스템 연동
IRIS_URL=http://192.168.0.80:3000
NOTIFY_ROOM_ID=            # 쿠키 만료 알림 받을 채팅방 ID

# 서버 설정
API_HOST=0.0.0.0
API_PORT=8100
ADMIN_SECRET_KEY=your-secret-key
```

---

## 6. 파일별 구현 명세

### 6-1. `crawler/lod_crawler.py`

```python
class LodCrawler:
    BASE_URL  = "https://lod.nexon.com"
    LIST_URL  = "/Community/game"
    PARAMS    = {"SearchBoard": 1, "Category2": 1}

    def crawl_list(self, page: int) -> list[dict]:
        """
        목록 페이지 파싱
        선택자: ul.community_s1 > li > a
        반환: [{"post_id": "7832", "title": "...", "url": "..."}]
        """

    def crawl_post(self, post_id: str) -> dict:
        """
        상세 페이지 본문 파싱
        선택자: .board_text (br→\n, script/style 제거)
        저장: ./data/lod_nexon/{post_id}.json
        중복: 파일 존재 시 스킵
        """

    def crawl_all(self, start_page=1, end_page=20):
        """전체 페이지 순회 크롤링"""

    def crawl_new(self):
        """1페이지만 (스케줄러용, 신규 게시글만 수집)"""
```

**저장 JSON:**
```json
{
  "id": "7832",
  "title": "3차 승급 지그프리트 관련",
  "author": "세오 안녕",
  "date": "2026.01.29",
  "views": 7461,
  "content": "1월 22일 패치로 지그프리트의 기능이...",
  "url": "https://lod.nexon.com/Community/game/7832?SearchBoard=1",
  "source": "lod_nexon",
  "board_name": "현자의 마을",
  "crawled_at": "2026-02-23T12:00:00",
  "bookmark_created": false
}
```

---

### 6-2. `crawler/naver_cafe_crawler.py`

```python
BOARDS = [
    {"menu_id": 12,  "name": "팁과 정보"},
    {"menu_id": 11,  "name": "퀘스트 공략"},
    {"menu_id": 131, "name": "아이템 정보"},
    {"menu_id": 132, "name": "스킬 정보"},
]

class NaverCafeCrawler:
    CAFE_ID  = "13434008"
    BASE_URL = "https://cafe.naver.com/f-e"

    async def load_session(self) -> BrowserContext:
        """
        naver_cookies.json 로드 → headless=True Playwright context 생성
        로그인 확인: #gnb_login_button 없으면 정상
        만료 시: CookieExpiredException 발생 → notify.py 알림
        """

    async def crawl_list(self, menu_id: int, page: int) -> list[dict]:
        """
        선택자: a.article (href에서 article_id 추출, 정규식: /articles/(\d+))
        waitForSelector('a.article', timeout=10000) 대기
        """

    async def crawl_post(self, article_id: str, menu_id: int, board_name: str) -> dict:
        """
        본문 선택자 우선순위:
          1순위: .se-viewer         (스마트에디터 최신)
          2순위: .se-main-container
          3순위: #postViewArea      (구버전)
        저장: ./data/naver_cafe/{article_id}.json
        """

    async def crawl_all_boards(self, pages_per_board=10):
        """4개 게시판 전체 크롤링"""

    async def crawl_new(self):
        """각 게시판 1페이지 (스케줄러용)"""
```

**저장 JSON:**
```json
{
  "id": "495676",
  "menu_id": 12,
  "title": "발록과 바실리스크 초고수들도 모르는 팁",
  "author": "날뛰는고라니",
  "date": "2026.02.16",
  "views": 1234,
  "content": "게시글 본문 전체 텍스트...",
  "url": "https://cafe.naver.com/f-e/cafes/13434008/articles/495676?menuid=12",
  "source": "naver_cafe",
  "board_name": "팁과 정보",
  "crawled_at": "2026-02-23T12:00:00",
  "bookmark_created": false
}
```

---

### 6-3. `rag/bookmark_creator.py` ← 핵심 파일

```python
class BookmarkCreator:
    """
    원본 게시글 JSON을 읽어 책갈피를 생성하는 핵심 클래스
    GPT-4o-mini를 사용하여 요약, 키워드, 카테고리 태그 추출
    """

    # 책갈피 생성 GPT 프롬프트
    BOOKMARK_PROMPT = """
    다음은 어둠의전설 게임 관련 게시글입니다.
    아래 JSON 형식으로 책갈피를 생성해주세요.
    게임 고유 용어(직업명, 스킬명, 아이템명 등)는 절대 바꾸지 마세요.

    출력 형식 (JSON만 출력):
    {
      "summary": "핵심 내용 3문장 이내 요약",
      "keywords": ["키워드1", "키워드2", "키워드3", ...],
      "category_tags": ["직업정보|스킬|아이템|퀘스트|던전|시스템|이벤트|기타 중 해당하는 것"]
    }

    제목: {title}
    게시판: {board_name}
    본문: {content}
    """

    def create_bookmark(self, raw_post: dict) -> dict:
        """
        단일 게시글 → 책갈피 생성
        GPT 호출하여 summary, keywords, category_tags 추출
        책갈피 JSON 저장: ./data/bookmarks/{source}_{id}.json
        원본 JSON의 bookmark_created → True 업데이트
        """

    def create_all(self):
        """bookmark_created=false 파일 전체 처리"""

    def create_new(self):
        """최근 크롤링된 신규 파일만 처리"""
```

**생성되는 책갈피 JSON:**
```json
{
  "bookmark_id": "lod_nexon_7832",
  "title": "3차 승급 지그프리트 관련",
  "summary": "1월 22일 패치로 지그프리트 NPC 기능이 변경되었습니다. 기존 용자의공원 지그프리트는 반응하지 않으며, 루어스성의 원본 NPC를 통해 3차 승급을 진행해야 합니다.",
  "keywords": ["지그프리트", "3차승급", "용자의공원", "루어스성", "1월22일패치"],
  "category_tags": ["시스템", "NPC"],
  "source": "lod_nexon",
  "board_name": "현자의 마을",
  "date": "2026.01.29",
  "views": 7461,
  "url": "https://lod.nexon.com/Community/game/7832?SearchBoard=1",
  "content_path": "./data/lod_nexon/7832.json",
  "created_at": "2026-02-23T12:00:00"
}
```

---

### 6-4. `rag/embedder.py`

```python
class Embedder:
    """
    책갈피 JSON을 읽어 임베딩 후 Qdrant에 저장
    """
    COLLECTION  = "lod_bookmarks"
    VECTOR_SIZE = 1536    # text-embedding-3-small
    DISTANCE    = "Cosine"

    def build_embed_text(self, bookmark: dict) -> str:
        """
        임베딩할 텍스트 구성 (짧고 정확하게)
        
        "제목: {title}
        요약: {summary}
        키워드: {keywords 쉼표 연결}
        카테고리: {category_tags 쉼표 연결}
        게시판: {board_name}"
        """

    def embed_and_save(self, bookmark: dict):
        """
        OpenAI text-embedding-3-small 호출
        Qdrant upsert (bookmark_id를 point ID로 사용)
        페이로드: bookmark 전체 (content_path 포함)
        """

    def process_all(self):
        """data/bookmarks/*.json 중 Qdrant에 없는 것 전체 처리"""

    def process_new(self):
        """신규 책갈피 파일만 처리"""
```

---

### 6-5. `rag/retriever.py` ← 2단계 검색 핵심

```python
class Retriever:
    """
    2단계 RAG 검색:
    1단계: 질문 → Qdrant 책갈피 검색 (Top-3)
    2단계: 책갈피 → 원본 JSON 로드 → GPT 답변 생성
    """

    SYSTEM_PROMPT = """
    당신은 어둠의전설 게임 전문 도우미입니다.
    아래에 제공되는 게시글 내용을 꼼꼼히 읽고 사용자 질문에 답변해주세요.
    게시글에 없는 내용은 절대 추측하지 마세요.
    답변은 핵심만, 300자 이내로 간결하게 작성하세요.
    """

    def search(self, question: str, source_filter: str = None) -> dict:
        """
        ── 1단계: 책갈피 검색 ──
        1. 질문 → OpenAI 임베딩
        2. Qdrant 유사도 검색 (top-3, source_filter 적용 가능)
           필터: source = "lod_nexon" | "naver_cafe" | None(전체)
        3. 책갈피 목록 반환 (score 포함)

        ── 2단계: 원본 내용 로드 ──
        4. 책갈피의 content_path → 원본 JSON 파일 로드
        5. 원본 content 전체 텍스트 추출

        ── 3단계: GPT 답변 생성 ──
        6. 시스템 프롬프트 + 원본 내용 + 질문 → GPT-4o-mini
        7. 응답 반환

        반환 형식:
        {
          "answer": "AI 답변 텍스트",
          "sources": [
            {
              "title": "게시글 제목",
              "url": "원본 URL",
              "board_name": "팁과 정보",
              "date": "2026.02.16",
              "score": 0.87
            }
          ],
          "confidence": "high" | "medium" | "low" | "not_found"
        }
        """

    def _load_original_content(self, content_path: str) -> str:
        """
        책갈피의 content_path로 원본 JSON 로드
        → content 필드 반환 (전체 본문)
        파일 없으면 summary로 대체
        """

    def _build_context(self, bookmarks: list, originals: list) -> str:
        """
        GPT에 전달할 컨텍스트 구성:
        
        [게시글 1] {board_name} | {date}
        제목: {title}
        내용: {original_content}
        출처: {url}
        ────────────
        [게시글 2] ...
        """

    def _get_confidence(self, top_score: float) -> str:
        """
        score >= 0.70 → "high"   (확신 있는 답변)
        score >= 0.55 → "medium" (관련 있으나 불확실)
        score >= 0.45 → "low"    (⚠️ 경고 문구 추가)
        score <  0.45 → "not_found" (검색 결과 없음 메시지)
        """
```

---

### 6-6. `app.py` (FastAPI 메인)

```python
# POST /search  ← 메인 엔드포인트 (wikibot /ask/search에서 호출)
@app.post("/search")
async def search(query: str, source_filter: str = None):
    """
    책갈피 2단계 RAG 검색 + 답변 생성
    source_filter: "lod_nexon" | "naver_cafe" | None(전체)
    
    응답:
    {
      "answer": "답변 텍스트",
      "sources": [{"title","url","board_name","date","score"}],
      "confidence": "high|medium|low|not_found"
    }
    """

# POST /add  ← 수동 데이터 추가
@app.post("/add")
async def add(title: str, content: str, board_name: str, 
              source_url: str, source: str):
    """
    수동으로 원본 저장 → 책갈피 생성 → 임베딩 전 과정 자동 처리
    """

# GET /health
@app.get("/health")
async def health():
    """
    {
      "status": "healthy",
      "qdrant": "connected",
      "total_bookmarks": 1234,
      "lod_nexon": 890,
      "naver_cafe": 344
    }
    """

# GET /stats
@app.get("/stats")
async def stats():
    """수집 현황, 마지막 크롤링 시간 등"""

# POST /crawl  ← 관리자 수동 트리거 (X-Admin-Key 헤더 인증)
@app.post("/crawl")
async def crawl(source: str = "all", pages: int = 5):
    """크롤링 → 책갈피 생성 → 임베딩 전 과정 실행"""
```

---

### 6-7. `scheduler/job.py`

```python
# APScheduler (AsyncIOScheduler)
# FastAPI lifespan으로 서버 시작 시 자동 등록

스케줄 설정:
  매 1시간        → crawl_new()        : LOD + 카페 각 1페이지
                   create_new()        : 신규 책갈피 생성
                   embed_new()         : 신규 임베딩
                   
  매일 새벽 03:00 → create_all()       : 미처리 책갈피 전체 생성
                   embed_all()         : 미처리 임베딩 전체 처리
                   
  매주 일요일 02:00 → crawl_all()      : 전체 재크롤링
                      (LOD 20페이지, 카페 각 10페이지)
```

---

### 6-8. `utils/notify.py`

```python
def send_kakao_notify(message: str):
    """
    Iris API POST /reply 재활용
    NOTIFY_ROOM_ID 채팅방으로 알림 발송
    """

# 알림 상황:
# 1. 쿠키 만료 감지 시
COOKIE_EXPIRED_MSG = """
🚨 네이버 카페 쿠키가 만료되었습니다.

[로컬 PC에서 실행]
python save_cookies_local.py

[서버 업로드]
scp naver_cookies.json user@서버IP:프로젝트경로/
"""

# 2. 크롤링/임베딩 완료 리포트
CRAWL_COMPLETE_MSG = """
✅ 크롤링 완료
LOD 공홈: {lod_count}건
네이버 카페: {cafe_count}건
신규 책갈피: {bookmark_count}건 생성
"""
```

---

## 7. 신규 API 연동 명세 (wikibot + iris-kakao-bot)

### 7-1. wikibot에 추가할 엔드포인트

**추가 파일: `src/services/searchService_rag.js`**

```javascript
// RAG 서버 /search 호출 후 wikibot 표준 형식으로 변환

class SearchRagService {
  async search(query) {
    // POST http://localhost:8100/search
    // Body: { query, source_filter: null }  // 전체 검색

    // RAG 응답 → wikibot 표준 형식 변환
    return {
      success: true,
      data: {
        title:        sources[0]?.title,
        date:         sources[0]?.date,
        content:      answer,               // GPT 생성 답변
        link:         sources[0]?.url,
        board_name:   sources[0]?.board_name,
        confidence:   confidence,           // high|medium|low|not_found
        otherResults: sources.slice(1).map(s => ({
          title: s.title,
          link:  s.url,
          date:  s.date,
          board: s.board_name
        }))
      }
    };
  }
}
```

**`src/index.js`에 추가:**

```javascript
app.post('/ask/search', async (req, res) => {
    const { query, max_length = 500 } = req.body;
    const result = await searchRagService.search(query);
    res.json(result);
});
```

### 7-2. iris-kakao-bot app.py에 추가

```python
# !검색 명령어 추가 (기존 !현자 로직 바로 아래에 추가)
elif msg_stripped.startswith("!검색"):
    query = msg_stripped[3:].strip()
    if not query:
        send_reply(chat_id, "검색어를 입력해주세요.\n예) !검색 성기사 스킬트리")
        return jsonify({"status": "ok"})

    result = ask_wikibot("/ask/search", query, max_length=300)
    reply  = format_search_result_v2(result, sender)
    send_reply(chat_id, reply)


def format_search_result_v2(result: dict, sender: str) -> str:
    """
    책갈피 RAG 결과 포맷팅 (카카오톡 메시지 형식)
    confidence에 따라 다른 접두사 표시
    """
    if result is None:
        return f"{sender}님, 서버 연결에 실패했습니다."

    data       = result.get("data", {})
    answer     = data.get("content", "검색 결과가 없습니다.")
    confidence = data.get("confidence", "low")
    sources    = data.get("otherResults", [])
    link       = data.get("link", "")
    board_name = data.get("board_name", "")

    # confidence별 접두사
    prefix = {
        "high":      "✅",
        "medium":    "🔍",
        "low":       "⚠️ 유사한 내용이 있으나 정확하지 않을 수 있습니다.\n",
        "not_found": "❌ 관련 내용을 찾지 못했습니다.\n👉 직접 확인: https://lod.nexon.com/community/game"
    }.get(confidence, "🔍")

    if confidence == "not_found":
        return prefix

    response = f"{prefix} {answer}"

    # 출처 링크 (최대 2개)
    if link:
        response += f"\n\n📋 [{board_name}] {data.get('title','')}\n🔗 {link}"

    for s in sources[:1]:
        if s.get("link"):
            response += f"\n📋 [{s.get('board','')}] {s.get('title','')}\n🔗 {s['link']}"

    return response.strip()
```

---

## 8. 명령어 최종 정리

| 명령어 | 기능 | 검색 방식 | 변경 여부 |
|--------|------|----------|----------|
| `!현자 [검색어]` | LOD 공홈 실시간 검색 | wikibot → 실시간 크롤링 | ✅ 기존 유지 |
| `!아이템 [이름]` | 아이템 정보 | LOD DB | ✅ 기존 유지 |
| `!스킬 [이름]` | 스킬/마법 정보 | LOD DB | ✅ 기존 유지 |
| `!공지 [검색어]` | 공지사항 검색 | 기존 | ✅ 기존 유지 |
| `!가격 [아이템]` | 거래 시세 | 기존 | ✅ 기존 유지 |
| `!파티 [던전]` | 파티 모집 | 기존 | ✅ 기존 유지 |
| `!검색 [검색어]` | **LOD 공홈 + 네이버 카페 통합 RAG** | **책갈피 2단계 RAG** | 🆕 **신규** |

---

## 9. 기술 스택

### 신규 구축 (lod-rag-server)

| 분류 | 기술 | 버전 | 용도 |
|------|------|------|------|
| 언어 | Python | 3.11 | 전체 |
| 웹 프레임워크 | FastAPI | 0.109 | RAG API 서버 (:8100) |
| 크롤러 (LOD) | requests + BeautifulSoup4 | 2.31 / 4.12 | LOD 공홈 크롤링 |
| 크롤러 (카페) | Playwright | 1.40 (async) | 네이버 카페 크롤링 |
| 벡터 DB | Qdrant | latest | 책갈피 임베딩 저장 (:6333) |
| 임베딩 모델 | text-embedding-3-small | - | 책갈피 벡터화 |
| LLM (책갈피 생성) | gpt-4o-mini | - | 요약 + 키워드 + 태그 추출 |
| LLM (답변 생성) | gpt-4o-mini | - | 원본 내용 기반 답변 |
| 스케줄러 | APScheduler | 3.10 | 자동 크롤링 |
| 비동기 | asyncio + httpx | - | 동시 처리 |

### 기존 시스템 (수정 없음)

| 분류 | 기술 | 용도 |
|------|------|------|
| 봇 서버 | Python Flask | iris-kakao-bot (:5000) |
| 검색 서버 | Node.js Express | wikibot-kakao (:8214) |
| 카카오 브릿지 | Iris 앱 | 카카오톡 송수신 (:3000) |
| DB (기존) | SQLite | 닉네임, 공지, 거래, 파티 |

### requirements.txt

```
# Web
fastapi==0.109.0
uvicorn==0.27.0
httpx==0.26.0

# 크롤링
requests==2.31.0
beautifulsoup4==4.12.3
playwright==1.40.0

# 벡터 DB
qdrant-client==1.7.0

# OpenAI
openai==1.12.0

# 스케줄러
APScheduler==3.10.4

# 유틸
python-dotenv==1.0.1
pydantic==2.6.0
pydantic-settings==2.2.1
aiofiles==23.2.1
loguru==0.7.2
```

---

## 10. 네이버 쿠키 관리 전략

### 최초 설정 — 로컬 PC에서 1회 실행

```python
# save_cookies_local.py (로컬 PC 전용, headless=False)
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    context = browser.new_context()
    page    = context.new_page()

    page.goto("https://nid.naver.com/nidlogin.login")
    print("브라우저에서 로그인하세요 (로그인 상태 유지 체크 권장)")
    input("완료 후 Enter: ")

    # Playwright storage_state = 쿠키 + 로컬스토리지 전체 저장
    context.storage_state(path="naver_cookies.json")
    print("✅ naver_cookies.json 저장 완료")
    browser.close()
```

```bash
# 서버 업로드
scp naver_cookies.json user@서버IP:/프로젝트경로/lod-rag-server/
```

### 쿠키 만료 처리

| 항목 | 내용 |
|------|------|
| 일반 만료 주기 | 약 3~6개월 |
| 만료 감지 | `#gnb_login_button` 요소 존재 확인 |
| 만료 시 처리 | CookieExpiredException → 카카오톡 알림 자동 발송 |
| 대안 (서버에서 직접) | `python import_cookies_manual.py` 실행 후 쿠키값 붙여넣기 |

---

## 11. Docker Compose

```yaml
version: '3.8'
services:

  qdrant:
    image: qdrant/qdrant:latest
    container_name: qdrant
    ports:
      - "6333:6333"
    volumes:
      - ~/wikibot-data/qdrant:/qdrant/storage
    restart: unless-stopped

  lod-rag-server:
    build: ./lod-rag-server
    container_name: lod-rag-server
    ports:
      - "8100:8100"
    volumes:
      - ~/wikibot-data/rag_data:/app/data
      - ./lod-rag-server/naver_cookies.json:/app/naver_cookies.json:ro
    env_file:
      - ./lod-rag-server/.env
    depends_on:
      - qdrant
    restart: unless-stopped
```

---

## 12. 서버 초기 설치 순서

```bash
# ── 1. Playwright headless 설치 (Ubuntu 기준) ──
pip install playwright
playwright install chromium
playwright install-deps chromium

apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2

# ── 2. Qdrant 실행 ──
docker run -d --name qdrant \
  -p 6333:6333 \
  -v ~/wikibot-data/qdrant:/qdrant/storage \
  qdrant/qdrant

# ── 3. 환경 설정 ──
cp .env.example .env
# OPENAI_API_KEY 등 편집

# ── 4. 네이버 쿠키 업로드 (로컬PC에서 생성 후) ──
scp naver_cookies.json user@서버IP:프로젝트경로/lod-rag-server/

# ── 5. 초기 전체 크롤링 ──
python main.py crawl-lod          # LOD 공홈 크롤링
python main.py crawl-cafe         # 네이버 카페 크롤링

# ── 6. 책갈피 생성 ──
python main.py create-bookmarks   # GPT로 책갈피 생성

# ── 7. 임베딩 ──
python main.py embed-all          # Qdrant에 저장

# ── 8. RAG 서버 실행 ──
uvicorn app:app --host 0.0.0.0 --port 8100

# ── 9. 검증 ──
curl -X POST http://localhost:8100/search \
  -H "Content-Type: application/json" \
  -d '{"query": "성기사 스킬트리"}'
```

---

## 13. 작업 우선순위 체크리스트

```
Phase 1 — lod-rag-server 기반 구축
  [ ] setup_server.sh 작성 (Playwright headless 설치 포함)
  [ ] .env / .env.example 작성
  [ ] lod_crawler.py 구현
  [ ] bookmark_creator.py 구현 ← 핵심
  [ ] embedder.py 구현 (Qdrant lod_bookmarks 컬렉션)
  [ ] retriever.py 구현 (2단계 검색 로직) ← 핵심
  [ ] app.py FastAPI 서버 구현 (/search 엔드포인트)

Phase 2 — LOD 공홈 데이터 수집 및 검증
  [ ] LOD 공홈 크롤링 실행
  [ ] 책갈피 생성 실행 (GPT)
  [ ] 임베딩 저장 실행 (Qdrant)
  [ ] /search 엔드포인트 테스트

Phase 3 — 네이버 카페 크롤러 연동
  [ ] save_cookies_local.py 작성 (로컬 PC용)
  [ ] import_cookies_manual.py 작성 (서버 수동 입력)
  [ ] naver_cafe_crawler.py 구현
  [ ] notify.py 구현 (쿠키 만료 알림)
  [ ] 네이버 카페 크롤링 + 책갈피 생성 + 임베딩 검증

Phase 4 — 스케줄러
  [ ] scheduler/job.py 구현
  [ ] FastAPI lifespan 통합 테스트

Phase 5 — 기존 시스템 연동 (!검색 명령어)
  [ ] wikibot searchService_rag.js 추가
  [ ] wikibot index.js /ask/search 엔드포인트 추가
  [ ] iris-kakao-bot app.py !검색 명령어 추가
  [ ] format_search_result_v2() 구현
  [ ] 카카오톡 !검색 명령 엔드-투-엔드 테스트

Phase 6 — 배포
  [ ] Dockerfile 작성
  [ ] docker-compose.yml 작성
  [ ] 전체 통합 테스트
```

---

## 14. 책갈피 방식 처리 흐름 요약

```
[크롤링 단계]
게시글 원본 수집
    │
    ▼
data/lod_nexon/{id}.json      bookmark_created: false
data/naver_cafe/{id}.json     bookmark_created: false

[책갈피 생성 단계]
GPT-4o-mini가 원본 읽고 생성
    │
    ▼
data/bookmarks/lod_nexon_{id}.json
  summary:       "3문장 요약"
  keywords:      ["키워드들"]
  category_tags: ["카테고리들"]
  content_path:  "./data/lod_nexon/{id}.json"  ← 원본 경로 저장

[임베딩 단계]
책갈피 텍스트(짧고 정확) → OpenAI 임베딩 → Qdrant 저장

[검색 & 답변 단계]
사용자: "!검색 성기사 스킬트리"
    ↓
질문 임베딩 → Qdrant 책갈피 검색 (Top-3)
    ↓
책갈피 content_path → 원본 JSON 로드 (전체 본문)
    ↓
원본 전체 내용 + 질문 → GPT-4o-mini
    ↓
카카오톡 답변 전송
"✅ 성기사 스킬트리는 ...
 📋 [팁과 정보] 성기사 완벽 육성 가이드
 🔗 https://cafe.naver.com/..."
```

---

*문서 버전: v2.0*  
*최종 수정: 2026-02-23*  
*기준 레포: https://github.com/minho83/wikibot-kakao*
