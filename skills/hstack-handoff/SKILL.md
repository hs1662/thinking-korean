---
name: hstack-handoff
description: 현재 세션의 검증된 팩트와 남은 작업을 기계 근거와 결합해 저장하거나, 새 세션에서 복원하거나, 스냅샷 목록을 조회하거나, 격리 작업자에게 위임합니다. 사용자가 /hstack-handoff 또는 핸드오프 저장·불러오기·목록·위임을 요청할 때 사용합니다.
---

# 팩트 증류 컨텍스트 핸드오프

세션 컨텍스트가 길어지거나 다른 세션으로 작업을 넘길 때, 추측을 배제한 핵심 팩트와 작업 공간의 기계 근거만 압축해 저장·복원한다.

## 지원 하위 모드

1. **`save` (기본값)**:
   - 지금까지 직접 읽거나 실행해 확인한 사실(`verified_facts`), 시도했으나 실패·폐기한 접근(`failed_approaches`), 남은 작업(`remaining_tasks`), 목표(`objective`), 필요 시 열린 위험(`open_risks`)을 정리한다.
   - 내장 MCP 도구 `manage_handoff`를 `action: "save"`로 호출해 작업 공간별 스냅샷을 저장한다.
   - 반환된 스냅샷 식별자와 미확인 경고(있을 경우)를 한국어로 간결하게 안내한다.
2. **`load [snapshot_id]`**:
   - 내장 MCP 도구 `manage_handoff`를 `action: "load"`로 호출한다(`snapshot_id` 생략 시 최신 스냅샷 자동 로드).
   - `[작업 트리 변동 감지]` 경고가 포함되면 현재 작업 공간의 변경 파일부터 `read_file`이나 `git status`로 다시 확인한다.
   - 복원된 목표와 남은 작업 목록을 기준으로 후속 작업을 이어간다.
3. **`list`**:
   - 내장 MCP 도구 `manage_handoff`를 `action: "list"`로 호출해 현재 작업 공간에 저장된 최근 스냅샷 목록을 확인한다.
4. **`delegate`**:
   - 먼저 `manage_handoff`로 최신 스냅샷을 저장하거나 불러와 핵심 팩트와 남은 작업을 확보한다.
   - `invoke_subagent` 도구로 `TypeName: "hstack-worker"`, `Role: "팩트 기반 격리 작업자"`를 지정해 압축된 인수인계서와 구체적인 작업 범위만 넘긴다.
   - 작업자 완료 후 변경된 파일과 검증 결과를 직접 확인한다.
