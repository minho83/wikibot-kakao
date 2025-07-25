# KakaoTalk Bot 코드 매뉴얼

## 프로젝트 개요
KakaoTalk 챗봇과 n8n을 통한 LOD Wiki 검색 시스템 통합 서비스

## 프로젝트 구조

```
src/
├── index.js                    # 메인 서버 엔트리포인트
├── controllers/
│   └── webhookController.js    # KakaoTalk 웹훅 처리
├── middleware/
│   ├── index.js               # 미들웨어 모듈 내보내기
│   ├── errorHandler.js        # 에러 처리 미들웨어
│   └── rateLimiter.js         # 요청 제한 미들웨어
├── services/
│   └── wikiService.js         # Wiki 검색 서비스
└── utils/
    ├── messageParser.js       # 메시지 파싱 유틸리티
    └── responseFormatter.js   # 응답 포매팅 유틸리티
```

## 주요 기능

### 1. 서버 설정 (src/index.js:1-31)
- Express 서버 초기화
- CORS, body-parser 미들웨어 설정
- 웹훅 엔드포인트 등록
- 헬스체크 엔드포인트 제공

### 2. 웹훅 처리
- `/webhook` 엔드포인트로 KakaoTalk 메시지 수신
- Rate limiting 적용
- 에러 핸들링

### 3. 미들웨어
- **rateLimiter**: API 요청 제한
- **errorHandler**: 전역 에러 처리

## 환경 설정

### 필수 환경변수
```
PORT=3000
NODE_ENV=development
```

### 의존성
- **express**: 웹 프레임워크
- **axios**: HTTP 클라이언트
- **cors**: CORS 처리
- **dotenv**: 환경변수 관리

## 실행 방법

```bash
# 개발 모드
npm run dev

# 프로덕션 모드
npm start

# 테스트
npm test
```

## API 엔드포인트

### GET /health
시스템 상태 확인
```json
{
  "status": "ok",
  "timestamp": "2025-07-25T...",
  "uptime": 1234.56
}
```

### POST /webhook
KakaoTalk 메시지 처리 엔드포인트

## 개발 가이드

### 새로운 기능 추가 시
1. `src/services/`에 비즈니스 로직 구현
2. `src/controllers/`에 컨트롤러 추가
3. `src/utils/`에 공통 유틸리티 함수 작성
4. 필요시 `src/middleware/`에 미들웨어 추가

### 코드 스타일
- ES6+ 문법 사용
- CommonJS 모듈 시스템
- 에러 처리는 미들웨어로 위임
- 환경변수 활용

## n8n 통합
- n8n 워크플로우를 통한 Wiki 검색 처리
- `n8n/workflows/kakao-chatbot-workflow.json` 파일 참조