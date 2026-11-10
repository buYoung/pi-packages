# pi-background-exec

[English](README.md) | **한국어**

빌드, 테스트, 시뮬레이션처럼 오래 걸리는 셸 명령을 백그라운드에서 실행합니다. 에이전트는 명령이 끝나기를 기다리지 않고 턴을 마칠 수 있습니다. job이 끝나면 이 패키지가 job 상태와 로그 끝부분을 담아 에이전트를 다시 깨웁니다. [Herdr](https://herdr.dev) 안에서는 job이 끝나고 에이전트가 그 결과를 처리할 때까지 Pi pane이 `working`으로 남습니다.

## 요구 사항

- Pi 1.5.0 이상, Node.js 22.19 이상
- `background_exec`는 대화형(TUI) 세션과 RPC 세션에서만 동작합니다.
- Herdr 상태 보고는 Herdr 0.9.5(Pi 통합 버전 9)의 규칙을 따르고, TUI에서만 동작합니다.

## 설치

```sh
pi install npm:@buyong/pi-background-exec
```

아직 npm에 올라가지 않았습니다. 그전까지는 이 저장소에서 설치합니다.

```sh
pi install /absolute/path/to/pi-packages/apps/pi-background-exec
```

`~/.pi/agent/extensions/background-exec.ts`처럼 `background_exec`를 등록하는 확장을 따로 쓰고 있다면 먼저 지우세요. 같은 도구 이름을 등록하는 확장이 둘이면 충돌합니다.

## 제공하는 것

| 이름 | 종류 | 하는 일 |
| --- | --- | --- |
| `background_exec` | 도구 | 세션의 작업 디렉터리에서 셸 명령을 시작하고 `jobId`를 바로 돌려줍니다. `timeout`(초)은 선택입니다. |
| `background_job` | 도구 | job의 상태를 보여 주거나 job을 취소합니다. |
| `background-exec` | 스킬 | 모델에게 이 도구를 언제 쓰고 결과를 어떻게 처리할지 알려 줍니다. |
| Herdr 에이전트 상태 | 확장 | Herdr에 `working`, `blocked`, `idle`을 보고합니다. |

에이전트가 쉬고 있을 때 job이 끝나면 `background-job-finished` 메시지와 함께 새 턴이 시작됩니다. 턴 도중에 끝난 job은 모아 두었다가 다음 턴 경계에서 `background-jobs-finished`로 한꺼번에 보냅니다. 메시지에는 상태, 종료 코드, 로그 마지막 1 KiB 또는 12줄, `remainingJobs`가 들어 있습니다.

세션을 바꾸거나 다시 불러오거나 끝내면 실행 중인 job이 취소됩니다. 턴을 마치는 것으로는 취소되지 않습니다. job마다 `<세션 디렉터리>/background-exec/<세션 ID>/<job ID>/`에 `output.log`와 `result.json`이 남습니다. 이 파일은 본인만 읽을 수 있고, 자동으로 지워지지 않습니다.

## Herdr와 함께 쓰기

Herdr는 Pi pane 하나의 상태 보고를 보고자 하나에게서만 받습니다. Herdr 기본 Pi 통합을 이 패키지의 보고로 바꾸세요.

1. `herdr integration uninstall pi`를 실행합니다.
2. 실행 중인 job이 끝난 뒤 Pi에서 `/reload`를 실행합니다. 다시 불러오면 실행 중인 job이 취소됩니다.

Herdr 기본 Pi 통합이 설치되어 있는 동안(Pi의 `extensions` 디렉터리에 `herdr-agent-state.ts`가 있는 동안)은 이 패키지가 Herdr에 보고하지 않고, Herdr 통합만 보고합니다. 되돌리려면 `herdr integration install pi`와 `/reload`를 실행하세요.

이 패키지가 보고하면 다음처럼 동작합니다.

- job이 아직 실행 중인 채로 에이전트가 턴을 마치면 pane은 `working`으로 남습니다. 에이전트가 마지막 결과를 처리하면 `done`이 되고, `herdr agent prompt --wait`도 이때 반환됩니다.
- Escape로 실행을 멈추면 job이 남아 있어도 pane은 바로 `idle`이 됩니다.
- 다른 확장도 자기 작업이 남아 있을 때 `background-work:query-pending` 이벤트에 응답하면 pane을 `working`으로 둘 수 있습니다. pi-notify도 "Ready for input" 알림을 보내기 전에 같은 이벤트로 확인합니다.

Herdr 보고 없이 백그라운드 job만 쓰려면 Pi 설정에서 확장을 고르세요.

```json
{
  "packages": [
    {
      "source": "npm:@buyong/pi-background-exec",
      "extensions": ["src/background-exec.ts"]
    }
  ]
}
```

## 확인

이 저장소의 `apps/pi-background-exec`에서 실행합니다.

```sh
pnpm run lint
pnpm run typecheck
pnpm run test:unit
```

실행 중인 Pi로 확인하려면 저장소 루트에서 이 패키지의 확장만 켜고 Pi를 시작한 뒤(`pi --no-extensions -e ./apps/pi-background-exec`) 다음처럼 요청하세요. `Use background_exec to run "sleep 5 && echo done", then end your turn.` 약 5초 뒤 `"status":"succeeded"`와 로그 끝부분 `done`이 담긴 `background-job-finished` 메시지가 와야 합니다. 이 확인에는 모델이 필요합니다.

## 라이선스

Apache-2.0입니다. Herdr 보고 확장은 Herdr의 Pi 통합에서 파생했습니다. [NOTICE](NOTICE)를 보세요.
