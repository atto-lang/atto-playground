// Cross-repository source-compiled keyed actor integration.
// Intentionally NOT part of the packaged public asset or npm test: the public
// vendored compiler is separately pinned and does not yet include this PR.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames, guestImports } from '../src/guest.js';
import { requireGuestAbiV2 } from '../src/actor-abi-version.js';
import { createTenantActorHost } from '../src/tenant-actor-host.js';

const path = process.env.ATTO_KEYED_COMPILER_WASM;
if (!path) throw new Error('ATTO_KEYED_COMPILER_WASM must pin a compiler artifact built from the tested source');
const compiler = await createCompiler(await readFile(path));

const header = `define serial actor Queue as
    let int total = 0;
    receive(msg: int): void {
        self.total = self.total + msg;
        match self.total over
            on 40 -> { stdio.println(40); }
            on _ -> { stdio.println(self.total); }
        end
        return;
    }
end
`;

async function run(source) {
  const compiled = compiler.compile(source);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
  const module = await WebAssembly.compile(compiled.wasm);
  requireGuestAbiV2(module);
  const out = { text: '', truncated: false };
  const names = actorNames(module);
  assert.deepEqual(names, ['Queue']);
  const host = createTenantActorHost({ module, names, out });
  const { imports, bind } = guestImports(module, out, host);
  const instance = await WebAssembly.instantiate(module, imports);
  bind(instance);
  let result, fault;
  try {
    result = instance.exports.main();
    fault = await host.drain();
    return { result, fault, stdout: out.text, actors: host.count };
  } finally {
    host.close();
  }
}

const duplicate = await run(header + `
pub fnc main(): int {
    val first = ActorRegistry.get_or_create<Queue>("vhost", "payments");
    val second = ActorRegistry.get_or_create<Queue>("vhost", "payments");
    first.send(40);
    second.send(2);
    return 0;
}`);
assert.deepEqual(duplicate, { result: 0n, fault: null, stdout: '40\n42\n', actors: 1 });
console.log('PASS compiled keyed registry: one Wasm actor, one typed receive, two on-arm messages');

const separated = await run(header + `
pub fnc main(): int {
    val first = ActorRegistry.get_or_create<Queue>("vhost-1", "payments");
    val second = ActorRegistry.get_or_create<Queue>("vhost-2", "payments");
    first.send(40);
    second.send(2);
    return 0;
}`);
assert.deepEqual(separated, { result: 0n, fault: null, stdout: '40\n2\n', actors: 2 });
console.log('PASS compiled keyed registry: tenant namespace isolation');

for (const [label, source, expected] of [
  ['wrong message type', header + `
pub fnc main(): int {
  val q = ActorRegistry.get_or_create<Queue>("vhost", "payments");
  q.send(true);
  return 0;
}`, 'E_TYPE'],
  ['missing on', `define serial actor Queue as
  receive(msg: int): void {
    match msg over
      40 -> { stdio.println(40); }
      on _ -> { stdio.println(0); }
    end
    return;
  }
end
pub fnc main(): int { return 0; }`, 'E_SYNTAX'],
]) {
  const res = compiler.compile(source);
  assert.equal(res.ok, false, label);
  assert.equal('wasm' in res, false, label + ': no artifact');
  assert.ok(res.diagnostics[0].message.includes(expected), JSON.stringify(res.diagnostics));
  console.log('PASS compiled keyed registry rejection: ' + label);
}
