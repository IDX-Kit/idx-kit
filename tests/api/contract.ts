import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { execute } from "./runtime.ts";

export const contract = parse(
  await readFile(
    new URL("../../openapi/v1/openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const directory = await mkdtemp(`${tmpdir()}/idx-contract-`);
let bundled;
try {
  const output = `${directory}/contract.json`;
  await execute(process.execPath, [
    "node_modules/@redocly/cli/bin/cli.js",
    "bundle",
    "openapi/v1/openapi.yaml",
    "--dereferenced",
    "--output",
    output,
  ]);
  bundled = JSON.parse(await readFile(output, "utf8"));
} finally {
  await rm(directory, { recursive: true, force: true });
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(bundled, "urn:idx-kit:contract");
const pointer = (name: string) =>
  name.replaceAll("~", "~0").replaceAll("/", "~1");
export function valid(reference: string, value: unknown) {
  const validate = ajv.getSchema(`urn:idx-kit:contract#${reference}`);
  assert.ok(validate, `Documented schema: ${reference}`);
  assert.ok(validate(value), JSON.stringify(validate.errors));
}
export function validateResponse(
  path: string,
  response: Response,
  body: unknown,
  headersOnly = false,
) {
  const operation = bundled.paths[path]?.get;
  const status = Object.hasOwn(operation?.responses ?? {}, response.status)
    ? response.status
    : "default";
  const reference = operation
    ? `/paths/${pointer(path)}/get/responses/${status}`
    : "/components/responses/Problem";
  const definition =
    operation?.responses[status] ?? bundled.components.responses.Problem;
  for (const [name, header] of Object.entries(definition.headers)) {
    const actual = response.headers.get(name);
    if ((header as { required?: boolean }).required)
      assert.notEqual(actual, null, `Required header: ${name}`);
    if (actual !== null)
      valid(`${reference}/headers/${pointer(name)}/schema`, actual);
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  assert.ok(
    mediaType && Object.hasOwn(definition.content, mediaType),
    "Documented response media type",
  );
  if (!headersOnly)
    valid(`${reference}/content/${pointer(mediaType)}/schema`, body);
}
