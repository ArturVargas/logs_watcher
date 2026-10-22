const PATTERNS = [
  [/github_pat_[A-Za-z0-9_]+/g, '[redacted]'],
  [/\bgh[pours]_[A-Za-z0-9_]+/g, '[redacted]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted]'],
  [/AKIA[A-Z0-9]{16}/g, '[redacted]'],
  [/Bearer\s+[^\s"]+/g, 'Bearer [redacted]'],
  [/https:\/\/[a-fA-F0-9]+@[A-Za-z0-9.-]+\/\d+/g, '[redacted]'],
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted]'],
  [/\?[^"\s<]*/g, '?[redacted]'],
];

export function scrub(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function scrubJson(value) {
  const encoded = scrub(JSON.stringify(value));
  return JSON.parse(encoded);
}
