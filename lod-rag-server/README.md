# LOD RAG Server

어둠의전설 게임 정보를 크롤링하고 책갈피 2단계 RAG로 검색/답변하는 FastAPI 서버.

## 아키텍처

```
!검색 → iris-kakao-bot → wikibot /ask/search → lod-rag-server /search → Qdrant
```

### 책갈피 2단계 RAG + 이미지 하이브리드

1. **크롤링**: LOD 공홈 + 네이버 카페 게시글 수집 → `data/*.json` + 이미지 다운로드
2. **책갈피 생성**: GPT-4o-mini (Vision) 가 원본 + 이미지를 읽고 요약/키워드/태그/이미지설명 추출
3. **임베딩**: 책갈피 텍스트 + 이미지 설명 → Qdrant 벡터 저장
4. **검색**: 질문 → Qdrant에서 유사 책갈피 Top-3 → 원본 전체 내용 + 이미지 로드 → GPT Vision 답변

## 서버 초기 설치

### 1. Qdrant 실행

```bash
docker run -d --name qdrant \
  -p 6333:6333 \
  -v ~/wikibot-data/qdrant:/qdrant/storage \
  --restart unless-stopped \
  qdrant/qdrant
```

### 2. Python 환경 설정

```bash
cd lod-rag-server

# 가상환경 (권장)
python3 -m venv venv
source venv/bin/activate

# 의존성 설치
pip install -r requirements.txt

# Playwright Chromium 설치 (네이버 카페 크롤링용)
playwright install chromium
playwright install-deps chromium
```

### 3. 환경변수 설정

```bash
cp .env.example .env
nano .env
```

**필수 설정:**
- `OPENAI_API_KEY` — OpenAI API 키
- `QDRANT_HOST` — Docker compose 사용 시 `qdrant`, 단독 실행 시 `localhost`
- `ADMIN_SECRET_KEY` — /crawl API 인증 키

**이미지 처리 설정 (선택):**
- `IMAGE_ENABLED` — 이미지 다운로드/Vision 활성화 (기본: `true`)
- `IMAGE_MAX_PER_POST` — 게시글당 최대 이미지 수 (기본: 10)
- `IMAGE_MAX_FOR_BOOKMARK` — 책갈피 생성 시 Vision에 전달할 이미지 수 (기본: 5)
- `IMAGE_MAX_FOR_ANSWER` — 답변 생성 시 Vision에 전달할 이미지 수 (기본: 6)
- `IMAGE_VISION_DETAIL_BOOKMARK` — 책갈피 Vision detail (기본: `low`, 이미지당 85토큰)
- `IMAGE_VISION_DETAIL_ANSWER` — 답변 Vision detail (기본: `auto`)

### 4. 네이버 카페 쿠키 준비

**로컬 PC에서 (브라우저 GUI 필요):**
```bash
pip install playwright
playwright install chromium
python save_cookies_local.py
# → 브라우저에서 네이버 로그인 → naver_cookies.json 생성
```

**서버로 업로드:**
```bash
scp naver_cookies.json user@서버IP:~/wikibot-kakao/lod-rag-server/
```

**또는 서버에서 수동 입력:**
```bash
python import_cookies_manual.py
# → 브라우저 개발자 도구에서 복사한 쿠키값 입력
```

> 쿠키 만료 주기: 약 3~6개월. 만료 시 카카오톡 알림 자동 발송됨.

### 5. 초기 데이터 수집

```bash
# 데이터 디렉토리 생성
mkdir -p data/lod_nexon data/naver_cafe data/bookmarks

# LOD 공홈 크롤링 (현자의 마을 전체 100페이지, 약 1500건)
python main.py crawl-lod --pages 100

# 네이버 카페 크롤링 (4개 게시판, 게시판당 10페이지)
python main.py crawl-cafe --pages 10

# 책갈피 생성 (GPT-4o-mini)
python main.py create-bookmarks

# 임베딩 → Qdrant 저장
python main.py embed-all

# 데이터 현황 확인
python main.py stats
```

### 6. RAG 서버 실행

**단독 실행:**
```bash
uvicorn app:app --host 0.0.0.0 --port 8100
```

**docker-compose (wikibot과 함께):**
```bash
cd ~/wikibot-kakao
docker compose up -d
```

### 7. 검증

```bash
# 헬스체크
curl http://localhost:8100/health

# 검색 테스트
curl -X POST http://localhost:8100/search \
  -H "Content-Type: application/json" \
  -d '{"query": "성기사 스킬트리"}'

# CLI로 검색 테스트
python main.py search "성기사 스킬트리"

# wikibot 경유 테스트
curl -X POST http://localhost:8214/ask/search \
  -H "Content-Type: application/json" \
  -d '{"query": "성기사 스킬트리"}'
```

## CLI 명령어

```bash
python main.py crawl-lod [--pages 100]    # LOD 공홈 크롤링 (전체: 100페이지)
python main.py crawl-cafe [--pages 10]     # 네이버 카페 크롤링
python main.py create-bookmarks            # 책갈피 생성 (GPT)
python main.py embed-all                   # 임베딩 → Qdrant
python main.py search "검색어"              # 검색 테스트
python main.py stats                       # 데이터 현황
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/search` | RAG 검색 + 답변 생성 |
| POST | `/add` | 수동 데이터 추가 |
| GET | `/health` | 헬스체크 + Qdrant 상태 |
| GET | `/stats` | 수집 현황 |
| POST | `/crawl` | 관리자 수동 크롤링 (X-Admin-Key 헤더 필요) |

## 자동 스케줄

서버 실행 시 자동 등록:

| 주기 | 작업 |
|------|------|
| 매 1시간 | 신규 게시글 크롤링 + 책갈피 + 임베딩 |
| 매일 03:00 | 미처리분 책갈피/임베딩 보정 |
| 매주 일 02:00 | 전체 재크롤링 (LOD 100페이지, 카페 10페이지) |

## Docker Compose 배포

프로젝트 루트의 `docker-compose.yml`로 3개 서비스 동시 실행:

```bash
cd ~/wikibot-kakao

# 전체 빌드 & 실행
docker compose up -d --build

# 로그 확인
docker compose logs -f lod-rag-server

# RAG 서버만 재시작
docker compose restart lod-rag-server

# 전체 중지
docker compose down
```

### 데이터 볼륨

| 호스트 경로 | 컨테이너 경로 | 내용 |
|-------------|---------------|------|
| `~/wikibot-data/qdrant` | `/qdrant/storage` | Qdrant 벡터 DB |
| `~/wikibot-data/rag_data` | `/app/data` | 크롤링 원본 + 책갈피 JSON |

## 문제 해결

### Qdrant 연결 실패
```bash
# Qdrant 컨테이너 상태 확인
docker ps | grep qdrant
# 재시작
docker restart qdrant
```

### 네이버 카페 쿠키 만료
카카오톡으로 자동 알림이 오면:
1. 로컬 PC에서 `python save_cookies_local.py` 실행
2. `scp naver_cookies.json user@서버IP:~/wikibot-kakao/lod-rag-server/`
3. RAG 서버 재시작: `docker compose restart lod-rag-server`

### 검색 결과 품질이 낮을 때
```bash
# 전체 재크롤링 + 재임베딩
python main.py crawl-lod --pages 100
python main.py crawl-cafe --pages 10
python main.py create-bookmarks
python main.py embed-all
```

### 수동 크롤링 트리거 (API)
```bash
curl -X POST http://localhost:8100/crawl \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-secret-key" \
  -d '{"source": "all", "pages": 5}'
```
