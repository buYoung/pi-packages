# 변경 이력

## [Unreleased]

### 새로워진 것

- `background_exec`가 오래 걸리는 셸 명령을 백그라운드에서 실행하고 job ID를 바로 돌려줍니다. job이 끝나면 상태, 종료 코드, 로그 끝부분과 함께 에이전트를 깨웁니다. `background_job`은 job 상태를 보여 주거나 job을 취소하고, `background-exec` 스킬은 모델에게 두 도구의 사용법을 알려 줍니다.
- Herdr 안에서는 백그라운드 job이 끝나고 에이전트가 그 결과를 처리할 때까지 Pi pane이 `working`으로 남습니다. 이 기능은 Herdr 기본 Pi 통합을 대신하며, 그 통합이 설치되어 있는 동안에는 꺼져 있습니다.
