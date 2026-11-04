// Offline adapter only: no provider, no Orca, no session attestation.
const fs = require('node:fs');
const cp = require('node:child_process');
const bundle = JSON.parse(fs.readFileSync(0, 'utf8'));
const mode = process.argv[2];
const calls = [];
let patches = 0;
let pending;
const realDate = Date;
const at = mode === 'expired' ? '2026-10-15T12:00:00Z' : bundle.plan.session.observed_at;
global.Date = class extends realDate {
  constructor(...args) { super(...(args.length ? args : [at])); }
  static now() { return new realDate(at).getTime(); }
};
const tools = {
  async apply_patch(body) {
    calls.push('patch');
    patches++;
    if (mode === 'denied' || (mode === 'rename-denied' && patches === 2))
      return {isError:true, content:[{type:'text', text:'permission denied'}]};
    if (mode === 'no-write') return {};
    const lines = body.split('\n');
    for (let i = 1; i < lines.length - 1;) {
      const line = lines[i++];
      if (line.startsWith('*** Add File: ')) {
        const p = line.slice(14);
        let data = '';
        while (lines[i]?.startsWith('+')) data += lines[i++].slice(1) + '\n';
        fs.writeFileSync(p, data, {flag:'wx'});
      } else if (line.startsWith('*** Update File: ')) {
        const src = line.slice(17);
        const dst = lines[i++].slice(13);
        if (lines[i++] !== '@@') throw Error('bad patch');
        const old = lines[i++].slice(1) + '\n';
        const next = lines[i++].slice(1) + '\n';
        if (fs.readFileSync(src, 'utf8') !== old) throw Error('bad source');
        fs.renameSync(src, dst);
        fs.writeFileSync(dst, next);
      } else throw Error('unsupported patch: ' + line);
    }
    if (mode === 'corrupt-read' && patches === 1)
      fs.appendFileSync(Object.keys(bundle.plan.created_files)[0], 'wrong');
    return mode === 'empty-receipt' ? {} : 'Success. Updated the following files:';
  },
  async exec_command({cmd}) {
    calls.push('read');
    const r = cp.spawnSync('/bin/sh', ['-c', cmd], {encoding:'utf8'});
    const output = r.stdout + r.stderr;
    if (mode === 'chunked') {
      const split = Math.floor(output.length / 2);
      pending = {exit_code:r.status, output:output.slice(split)};
      return {session_id:42, output:output.slice(0, split)};
    }
    return {exit_code:r.status, output};
  },
  async write_stdin() { calls.push('wait'); return pending; },
};
new Function('tools', 'plan', bundle.executor)(tools, bundle.plan).then(receipt => {
  process.stdout.write(JSON.stringify({receipt, calls}));
}).catch(e => { process.stderr.write(String(e)); process.exitCode = 1; });
