# OpenCode Global Viewer 설치

## 1. 압축 해제

Windows:
C:\opencode-viewer

Linux/macOS:
~/opencode-viewer

---

## 2. Viewer 실행

Windows:
run.bat

Linux/macOS:
chmod +x run.sh
./run.sh

---

## 3. 브라우저 열기

http://localhost:5173

---

## 4. 글로벌 Plugin 설치

plugins/project-viewer.ts

복사 위치:

Windows:
%USERPROFILE%/.config/opencode/plugins/

Linux/macOS:
~/.config/opencode/plugins/

---

## 5. OpenCode에서 프로젝트 열기

자동으로:
- viewer 연결
- 현재 프로젝트 root 변경
- 파일 트리 표시

지원:
- C#
- C
- C++
- ObjC
- ObjC++
- Python
- TXT
- Markdown
- Mermaid
- PlantUML(raw)
