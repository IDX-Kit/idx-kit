import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export const contract = parse(
  await readFile(
    new URL("../../openapi/v1/openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
const dereference = (value: any): any =>
  value.$ref
    ? dereference(
        value.$ref
          .slice(2)
          .split("/")
          .reduce((object: any, name: string) => object[name], contract),
      )
    : value;
const validators = new Map();
export function valid(schema: any, value: unknown) {
  const key = JSON.stringify(schema);
  if (!validators.has(key))
    validators.set(
      key,
      ajv.compile({ ...schema, components: contract.components }),
    );
  const validate = validators.get(key);
  assert.ok(validate(value), JSON.stringify(validate.errors));
}
export function validateResponse(
  path: string,
  response: Response,
  body: unknown,
  headersOnly = false,
) {
  const operation = contract.paths[path]?.get;
  const definition = dereference(
    operation?.responses[response.status] ??
      operation?.responses.default ??
      contract.components.responses.Problem,
  );
  for (const [name, value] of Object.entries(definition.headers)) {
    const header = dereference(value);
    const actual = response.headers.get(name);
    if (header.required)
      assert.notEqual(actual, null, `Required header: ${name}`);
    if (actual !== null) valid(header.schema, actual);
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  assert.ok(
    mediaType && Object.hasOwn(definition.content, mediaType),
    "Documented response media type",
  );
  if (!headersOnly) valid(definition.content[mediaType].schema, body);
}
