# 프로젝트 뷰어 플러그인 재설계 명세

## 1. 개요
기존 단일 패키지 구조를 모노레포로 전환하여 의존성 분리, 타입 공유, 테스트 용이성을 확보하고, 실시간 통신을 WebSocket으로 표준화함.

## 2. 프로젝트 구조 (pnpm workspace)
```
/
├── package.json (workspace)
├── apps/
│   ├── server/      # Express API Server
│   └── client/      # Vite/React SPA
├── packages/
│   ├── shared/      # Common types, constants, utilities
│   └── renderers/   # Plugin-style renderer registry
└── plugin.ts        # OpenCode entry point
```

## 3. 핵심 기술 변경
- **통신**: 폴링/SSE → `Socket.io` (양방향 이벤트 중심)
- **타입 공유**: `packages/shared`를 통해 서버/클라이언트/플러그인 간 타입 안전성 확보
- **플러그인 구조**: 렌더러 로직을 `RendererRegistry`와 개별 Renderer 클래스/모듈로 분리

## 4. 로드맵 상세
- [ ] API Contract 명세화
- [ ] 모노레포 환경 설정
- [ ] 각 패키지 로직 마이그레이션 (테스트 동반)
- [ ] WebSocket 통신 구현
- [ ] 통합 테스트 및 배포
