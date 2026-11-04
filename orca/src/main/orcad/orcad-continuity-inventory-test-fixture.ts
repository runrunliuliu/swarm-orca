import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function continuityInventoryFixture(root: string) {
  const scope = {
    monitorStateRoot: join(root, 'monitor'),
    continuationStateRoot: join(root, 'continuation'),
    files: [join(root, 'head.json')]
  }
  for (const path of [scope.monitorStateRoot, scope.continuationStateRoot]) {
    mkdirSync(path, { mode: 0o700 })
  }
  for (const path of [
    ...scope.files,
    join(scope.monitorStateRoot, 'monitor-stop.json'),
    join(scope.monitorStateRoot, 'state.json'),
    join(scope.continuationStateRoot, 'outbox.json')
  ]) {
    writeFileSync(path, '{}\n', { mode: 0o600 })
  }
  return scope
}
