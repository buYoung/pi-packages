# 변경 이력

## [Unreleased]

## [0.1.2] - 2026-11-11

### 달라진 것

- `background_exec` 안내가 빌드, 테스트 묶음, 타입 검사, lint, 의존성 설치, 시뮬레이션에는 무엇이 실패하는지 처음 확인하는 실행까지 `bash` 대신 `background_exec`를 쓰고, 짧게 살펴보는 명령에만 `bash`를 쓰라고 모델에게 알려 줍니다. 이전에는 언제 `bash` 대신 `background_exec`를 골라야 하는지 말하지 않아서, AGENTS.md에서 `background-exec` 스킬을 읽으라고 지시하지 않으면 모델이 긴 테스트도 `bash`로 실행하는 일이 많았습니다.

## [0.1.1] - 2026-11-10

### 새로워진 것

- `background_exec`가 오래 걸리는 셸 명령을 백그라운드에서 실행하고 job ID를 바로 돌려줍니다. job이 끝나면 상태, 종료 코드, 로그 끝부분과 함께 에이전트를 깨웁니다. `background_job`은 job 상태를 보여 주거나 job을 취소하고, `background-exec` 스킬은 모델에게 두 도구의 사용법을 알려 줍니다.
- Herdr 안에서는 백그라운드 job이 끝나고 에이전트가 그 결과를 처리할 때까지 Pi pane이 `working`으로 남습니다. 이 기능은 Herdr 기본 Pi 통합을 대신하며, 그 통합이 설치되어 있는 동안에는 꺼져 있습니다.
- 에이전트가 쉬고 있을 때 job이 끝나면 `background-job-finished` 메시지와 함께 새 턴이 시작됩니다. 턴 도중에 끝난 job은 모아 두었다가 다음 턴 경계에서 `background-jobs-finished`로 한꺼번에 보내며, `remainingJobs`로 아직 실행 중인 job 수를 알려 줍니다.
- `background_exec`에 초 단위 `timeout`을 선택해서 줄 수 있습니다. 주지 않으면 job에 시간 제한이 없습니다.
- job마다 `<세션 디렉터리>/background-exec/<세션 ID>/<job ID>/`에 `output.log`와 `result.json`이 남습니다. 이 파일은 본인만 읽을 수 있고, 자동으로 지워지지 않습니다.
- 세션을 바꾸거나 다시 불러오거나 끝내면 실행 중인 job이 취소됩니다. 턴을 마치는 것으로는 취소되지 않습니다.
- 이 패키지가 Herdr에 보고할 때 Escape로 실행을 멈추면 job이 남아 있어도 pane이 바로 `idle`이 됩니다.
- 다른 확장도 처리할 작업이 남아 있는 동안 `background-work:query-pending` 이벤트에 응답하면 Herdr pane을 `working`으로 둘 수 있습니다. pi-notify도 "Ready for input" 알림을 보내기 전에 같은 이벤트로 확인합니다.
