# Video Topic Finder

유튜브 채널의 업로드 영상을 한 번에 가져와 자막을 45초 단위로 쪼개고, Gemini Embeddings로 색인한 뒤 자연어로 "어디에서 어떤 주제를 다뤘는지" 찾는 로컬 웹앱입니다.

## 핵심 구조

```text
YouTube channel
  -> YouTube Data API: channel / uploads playlist / video metadata
  -> transcript: YouTube captions when available
  -> 45초 단위 chunk
  -> Gemini Embedding 2 (768 dimensions)
  -> local JSON vector index
  -> query embedding + cosine similarity
  -> timestamped YouTube links
```

전체 자막을 검색할 때마다 Gemini 생성 모델에 보내지 않습니다. 자막은 로컬 인덱스에 저장하고, 검색어만 임베딩해서 의미적으로 가까운 구간을 찾습니다. 필요하면 이후 상위 결과에만 Gemini 생성 모델을 붙여 "왜 관련 있는지" 설명하도록 확장할 수 있습니다.

Google의 현재 문서 기준으로 Gemini Embedding 2는 텍스트/이미지/비디오/오디오/PDF를 지원하고, 기본 3072 차원이며 768/1536/3072 차원을 권장합니다. 이 프로젝트는 저장공간을 줄이기 위해 768 차원을 사용합니다.

YouTube Data API는 채널의 `contentDetails.relatedPlaylists.uploads`로 업로드 영상 플레이리스트를 얻은 뒤 `playlistItems.list`로 업로드 목록을 가져오는 방식이 공식 문서에 설명되어 있습니다. 채널 URL의 `@handle`은 `channels.list`의 `forHandle`로 해석합니다.

## 1. 설치

Node.js 22 이상을 권장합니다.

```bash
npm install
```

## 2. API 키

`.env.example`을 `.env`로 복사합니다.

```env
GEMINI_API_KEY=...
YOUTUBE_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash
EMBEDDING_MODEL=gemini-embedding-2
TRANSCRIPT_LANG=ko
PORT=3000
```

- Gemini API key: Google AI Studio에서 발급
- YouTube Data API v3 key: Google Cloud Console에서 YouTube Data API v3 활성화 후 발급

## 3. 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## 사용법

1. `https://www.youtube.com/@채널명` 입력
2. 채널 가져오기
3. 영상 목록 수집 → 자막 추출 → 45초 구간 분할 → 임베딩 생성 → `data/index.json`에 저장
4. 검색창에 `파리가 시간을 느끼는 방식`, `스타링크 발사`, `블랙홀` 등 입력
5. 결과 카드에서 관련 구간과 타임스탬프 확인
6. `이 구간에서 영상 보기`를 누르면 해당 시간으로 유튜브가 열림

## 비용을 줄이는 설계

- 채널 영상 메타데이터 수집: YouTube Data API
- 자막: 가능한 경우 기존 자막을 가져옴
- 자막 전체를 Gemini 생성 모델에 매번 전송하지 않음
- 색인할 때만 임베딩 생성
- 검색할 때는 검색어 1개만 임베딩하고 로컬에서 cosine similarity 계산
- 같은 영상을 다시 색인하지 않도록 기본적으로 신규 영상만 처리

Gemini Embeddings API는 `embedContent`와 batch embedding을 제공하며, 임베딩 결과에는 입력 토큰 사용량도 포함될 수 있습니다. 지연보다 처리량이 중요하면 Batch API를 사용하는 방법도 공식 문서에 안내되어 있습니다.

## 자막에 대한 주의

이 프로젝트의 `youtube-transcript-plus`는 YouTube의 비공식 내부 API를 이용하는 방식이라 YouTube 변경에 따라 깨질 수 있습니다. 패키지 문서에도 이 점이 명시되어 있습니다.

YouTube Data API의 공식 `captions.download`는 권한이 필요한 캡션 다운로드 기능이므로, 일반 공개 채널의 자막을 모두 공식 API만으로 가져오는 방식과는 차이가 있습니다.

따라서 운영 환경에서는 자막 공급 방식을 별도의 provider로 분리하는 것을 권장합니다.

## 현재 MVP에서 다음으로 추가하기 좋은 기능

- 색인 작업을 중단/재개하는 큐
- SQLite/Postgres/pgvector 저장소
- 영상별 키워드 자동 태깅
- 검색 결과를 Gemini가 한 번 더 검증해 "실제로 해당 주제를 다룬 구간"만 남기기
- 여러 채널 동시 관리
- 새 영상 자동 동기화(cron)
- 결과 CSV/Excel 내보내기
- 타임스탬프 주변 문맥 30초/60초 확장
