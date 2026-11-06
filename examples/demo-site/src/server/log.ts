export function writeLog(fields: Record<string, unknown>) {
  console.error(
    JSON.stringify(fields, (_key, value: unknown) =>
      typeof value === "string"
        ? value
            .replace(/idx_secret_[^\s"'\\,;)}\]]*/gi, "[redacted]")
            .replace(
              /\b(?:postgres(?:ql)?|mysql):\/\/[^\s"'<>\\]+/gi,
              "[redacted]",
            )
            .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
        : value,
    ),
  );
}
