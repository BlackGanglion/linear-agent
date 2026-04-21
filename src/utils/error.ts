export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    const name = current.name && current.name !== "Error" ? `${current.name}: ` : "";
    parts.push(code ? `${name}${current.message} (${code})` : `${name}${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}
