export type ParsedVersion = {
  /** Normalized version string, for example `2.1.317` or `0.167.0-alpha.1`. */
  version: string;
  core: readonly [number, number, number];
  prerelease: string | null;
};

const semverPattern = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** Parses the first line of `--version` output with a runtime-specific line pattern. */
export const parseVersionOutput = (output: string, linePattern: RegExp): ParsedVersion | null => {
  const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? '';
  const line = linePattern.exec(firstLine.trim());
  const candidate = line?.[1];
  if (candidate === undefined) {
    return null;
  }
  const match = semverPattern.exec(candidate);
  if (match === null || match[0] !== candidate) {
    return null;
  }
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!core.every((part) => Number.isSafeInteger(part))) {
    return null;
  }
  return { version: candidate, core, prerelease: match[4] ?? null };
};

/** Compares versions; a pre-release sorts before its release. Pre-release tags compare as text. */
export const compareVersions = (left: ParsedVersion, right: ParsedVersion): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === null) {
    return 1;
  }
  if (right.prerelease === null) {
    return -1;
  }
  return left.prerelease < right.prerelease ? -1 : 1;
};
