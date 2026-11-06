export function logLine(fields: Record<string, unknown>) {
  return JSON.stringify(fields, (_key, value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/idx_secret_[^\s"'\\,;)}\]]*/gi, "[redacted]")
          .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s"'<>\\]+/gi, "[redacted]")
          .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
      : value,
  );
}

export function failureFields(error: unknown) {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : null,
  };
}

export function logFailure(operation: string, error: unknown) {
  console.error(logLine({ operation, ...failureFields(error), message: error instanceof Error ? error.message : "Unknown failure" }));
}
