import { ValidationError } from './lan';

// Championship points by placement, the same for all tournaments. Adjustable in the web interface;
// standings compute the points on every request, so a change applies to all tournaments at once.
export interface PointsConfig {
  places: number[]; // points for 1st to 10th place (index 0 = 1st place)
  rest: number;     // points for 11th place and below
}

export const POINT_PLACES = 10;
const MAX_POINTS = 1000;

export const DEFAULT_POINTS: PointsConfig = {
  places: [30, 22, 16, 12, 9, 7, 5, 3, 2, 2],
  rest: 1,
};

export function pointsForPlacement(placement: number, config: PointsConfig = DEFAULT_POINTS): number {
  return config.places[placement - 1] ?? config.rest;
}

function points(value: unknown, label: string): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > MAX_POINTS) {
    throw new ValidationError(`${label}: ganze Zahl von 0 bis ${MAX_POINTS} erwartet`);
  }
  return number;
}

export function validatePoints(input: { places?: unknown; rest?: unknown }): PointsConfig {
  if (!Array.isArray(input.places) || input.places.length !== POINT_PLACES) {
    throw new ValidationError(`Es werden Punkte für genau ${POINT_PLACES} Plätze erwartet`);
  }
  return {
    places: input.places.map((value, i) => points(value, `Platz ${i + 1}`)),
    rest: points(input.rest, `Ab Platz ${POINT_PLACES + 1}`),
  };
}

// Stored record → config; anything broken (e.g. from a hand-edited backup) falls back to the defaults
export function pointsFromRecord(record: { places?: unknown; rest?: unknown } | null | undefined): PointsConfig {
  if (!record) return DEFAULT_POINTS;
  try {
    return validatePoints(record);
  } catch {
    return DEFAULT_POINTS;
  }
}
