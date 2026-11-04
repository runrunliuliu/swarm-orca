# Native timeout fixture

`terminal-idle-timeout.json` preserves the response and returncode from the
read-only 2026-10-27T08:32:08.958034+00:00 capture, Server/CLI 1.4.219:

`swarm-artifacts/bootstrap/rsi-scheduler-live-20261027-UzAziq/native/busy-timeout-native.json`

Command: fixed independent Server CLI, `terminal wait --terminal <explicit bound
handle> --for tui-idle --timeout-ms 1000 --json`. The native error contains no
terminal handle; attribution must also use the command and post-wait fence.
No credentials or terminal content are included. Tests replay the unchanged
envelope for decoder coverage; pipeline tests replace only runtimeId with their
isolated fixture binding. Structured approval results are synthetic, based on
`RuntimeTerminalWait` and the CLI's satisfied:false → exit 1 contract.

This is a regression replay, not a new live scheduler acceptance result.
