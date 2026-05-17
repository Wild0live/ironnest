// Minimal inputSchema validator. Covers the JSON Schema subset our tool
// catalog actually uses (type, enum, pattern, min/maxLength, exclusiveMinimum,
// items, maxItems, required, additionalProperties:false). Runs against the
// per-client inputSchema that toolsList already builds, so an LLM cannot get
// the worker to attempt a request with an out-of-enum site, a malformed
// receipt path, or an extra property the schema doesn't allow. Avoids
// pulling in `ajv` for a 60-line job; tradeoff is we have to extend this
// helper when ACTIONS grows new property types — the drift guard below
// catches that at startup.

function validateValue(value, schema, location) {
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`invalid type for ${location}: expected string`);
    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`invalid value for ${location}: not in allowed enum`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`invalid value for ${location}: does not match pattern`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`invalid value for ${location}: too short (< ${schema.minLength})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`invalid value for ${location}: too long (> ${schema.maxLength})`);
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`invalid type for ${location}: expected number`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`invalid value for ${location}: below minimum ${schema.minimum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      throw new Error(`invalid value for ${location}: must be > ${schema.exclusiveMinimum}`);
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`invalid type for ${location}: expected boolean`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`invalid type for ${location}: expected array`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`invalid value for ${location}: too many items (> ${schema.maxItems})`);
    }
    if (schema.items) {
      value.forEach((item, idx) => validateValue(item, schema.items, `${location}[${idx}]`));
    }
  }
  // Unknown types pass through: this catalog doesn't use them; if a future
  // ACTIONS entry adds one, extend here before relying on enforcement.
}

function validateArgs(args, schema, toolName) {
  if (!schema || schema.type !== "object") {
    throw new Error(`internal: schema for ${toolName} is not an object schema`);
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`invalid arguments for ${toolName}: expected an object`);
  }
  for (const req of schema.required || []) {
    if (args[req] === undefined) {
      throw new Error(`missing required argument '${req}' for ${toolName}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, k)) {
        throw new Error(`unknown argument '${k}' for ${toolName}`);
      }
    }
  }
  for (const [k, v] of Object.entries(args)) {
    const propSchema = schema.properties && schema.properties[k];
    if (!propSchema) continue;
    validateValue(v, propSchema, `${toolName}.${k}`);
  }
}

// Allowlist of types and keywords the validator above actually enforces.
// Anything outside this set would silently pass through unvalidated — the
// documented contract "validated at the MCP schema layer" would quietly
// become a lie. The startup self-check walks every ACTIONS schema and
// fails fast on drift, so a future ACTIONS entry declaring `format`,
// `oneOf`, `integer`, etc. crashes the container with a clear message
// rather than shipping a hole.
const SUPPORTED_VALIDATOR_TYPES = new Set(["string", "number", "boolean", "array", "object"]);
const SUPPORTED_KEYWORDS = {
  object: new Set(["type", "required", "properties", "additionalProperties", "description"]),
  string: new Set(["type", "enum", "pattern", "minLength", "maxLength", "description"]),
  number: new Set(["type", "minimum", "exclusiveMinimum", "description"]),
  boolean: new Set(["type", "description"]),
  array: new Set(["type", "items", "maxItems", "description"])
};

function assertSchemaIsValidatorCompatible(schema, location) {
  if (!schema || typeof schema !== "object") return;
  const t = schema.type;
  if (!SUPPORTED_VALIDATOR_TYPES.has(t)) {
    throw new Error(`unsupported schema type at ${location}: '${t}' (validator handles ${[...SUPPORTED_VALIDATOR_TYPES].join("/")})`);
  }
  const allowed = SUPPORTED_KEYWORDS[t];
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported schema keyword at ${location}: '${key}' on a ${t} schema (validator does not enforce this)`);
    }
  }
  if (t === "object" && schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      assertSchemaIsValidatorCompatible(propSchema, `${location}.${propName}`);
    }
  } else if (t === "array" && schema.items) {
    assertSchemaIsValidatorCompatible(schema.items, `${location}[]`);
  }
}

// Walks a catalog of {name → spec} entries (e.g. ACTIONS) and asserts every
// `spec.extra.properties` schema is something the validator above can
// enforce. Call from the boot block; throws fast on drift.
function assertCatalogSchemasValidatorCompatible(catalog) {
  for (const [name, spec] of Object.entries(catalog)) {
    const extra = spec.extra || {};
    if (!extra.properties) continue;
    for (const [propName, propSchema] of Object.entries(extra.properties)) {
      assertSchemaIsValidatorCompatible(propSchema, `${name}.${propName}`);
    }
  }
}

module.exports = {
  validateValue,
  validateArgs,
  SUPPORTED_VALIDATOR_TYPES,
  SUPPORTED_KEYWORDS,
  assertSchemaIsValidatorCompatible,
  assertCatalogSchemasValidatorCompatible
};
