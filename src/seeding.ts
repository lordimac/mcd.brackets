import type { StageType } from 'brackets-model';

export const STAGE_TYPES: readonly StageType[] = ['single_elimination', 'double_elimination', 'round_robin'];

export function isStageType(value: unknown): value is StageType {
  return STAGE_TYPES.includes(value as StageType);
}

// Fisher-Yates shuffle, returns a new array
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function nextPowerOfTwo(n: number): number {
  let power = 2;
  while (power < n) power *= 2;
  return power;
}

// Trimmed, non-empty participant names, or null if the input is not a string array
export function normalizeNames(input: unknown): string[] | null {
  if (!Array.isArray(input) || !input.every(name => typeof name === 'string')) return null;
  return input.map(name => name.trim()).filter(name => name.length > 0);
}

// Random seeding; elimination brackets are filled with BYEs (null) up to the next power of 2
export function buildSeeding(names: readonly string[], type: StageType, random: () => number = Math.random): (string | null)[] {
  const seeding: (string | null)[] = shuffle(names, random);
  if (type !== 'round_robin') {
    const size = nextPowerOfTwo(names.length);
    while (seeding.length < size) seeding.push(null);
  }
  return seeding;
}
