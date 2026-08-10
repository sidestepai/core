/**
 * GeoJSON → WKT at the write boundary (issue #208).
 *
 * Three shapes exist for one geo column, and until now the SDK declared the one
 * the engine refuses. Verified live against a fresh ephemeral:
 *
 * | shape | on write |
 * |---|---|
 * | `{ type, coordinates }` (GeoJSON, what the SDK declared) | `400 Only strings are supported for: POINT` |
 * | `"POINT(1 2)"` (WKT text) | `200` |
 *
 * The engine takes WKT text and nothing else. Every piece of information needed
 * to produce it is present at build time, so {@link geo} does the conversion
 * rather than making each author hand-build a string — which is where
 * coordinate-order and ring-closure bugs come from.
 *
 * ## Reads are a separate, engine-side problem
 *
 * The `db.add` response echoes `{ type: "point", data: { lng, lat } }`, but a
 * subsequent read of the same row returns **`null`** — `db.get` and `db.query`
 * alike, with or without the column named in `output`. So a stored geo value is
 * currently unreadable through any documented path, and nothing here can change
 * that. See {@link import("../fields/value-types.js").XanoGeoRead}.
 *
 * ## Coordinate order
 *
 * WKT is `(x y)` = `(lng lat)`, matching GeoJSON's `[lng, lat]` — confirmed
 * live: `POINT(1 2)` reads back as `{ lng: 1, lat: 2 }`. Latitude-first is the
 * single most common geo bug, so every position goes through one function.
 */
import { c } from "./value.js";
import type { Value } from "./value.js";

/** A single `[lng, lat]` position. */
export type Position = readonly [number, number];

/** A GeoJSON geometry, typed per kind so the coordinate nesting is checked. */
export type GeoJsonGeometry =
  | { readonly type: "Point"; readonly coordinates: Position }
  | { readonly type: "MultiPoint"; readonly coordinates: readonly Position[] }
  | { readonly type: "LineString"; readonly coordinates: readonly Position[] }
  | { readonly type: "MultiLineString"; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: "Polygon"; readonly coordinates: readonly (readonly Position[])[] }
  | {
      readonly type: "MultiPolygon";
      readonly coordinates: readonly (readonly (readonly Position[])[])[];
    };

/** GeoJSON `type` → the WKT keyword the engine parses. */
const WKT_KEYWORD: Record<GeoJsonGeometry["type"], string> = {
  Point: "POINT",
  MultiPoint: "MULTIPOINT",
  LineString: "LINESTRING",
  MultiLineString: "MULTILINESTRING",
  Polygon: "POLYGON",
  MultiPolygon: "MULTIPOLYGON",
};

function fail(message: string): never {
  throw new Error(`geo(): ${message}`);
}

/** One `lng lat` pair. The single place coordinate ORDER is decided. */
function position(value: unknown, where: string): string {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(
      `${where} must be a [lng, lat] pair, got ${JSON.stringify(value)}. GeoJSON is ` +
        `longitude-FIRST; a [lat, lng] pair silently places the point somewhere else.`,
    );
  }
  const [lng, lat] = value as [unknown, unknown];
  for (const [label, n] of [
    ["lng", lng],
    ["lat", lat],
  ] as const) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      fail(`${where} ${label} must be a finite number, got ${JSON.stringify(n)}.`);
    }
  }
  return `${lng as number} ${lat as number}`;
}

/** A comma-joined run of positions: `x y, x y`. */
function positions(value: unknown, where: string, min: number): string {
  if (!Array.isArray(value) || value.length < min) {
    fail(`${where} must be an array of at least ${min} [lng, lat] pairs.`);
  }
  return (value as unknown[]).map((p, i) => position(p, `${where}[${i}]`)).join(", ");
}

/**
 * One polygon ring. A ring must be CLOSED — first position equal to last — which
 * is the other classic geo bug and one the engine reports only as a parse
 * failure at write time.
 */
function ring(value: unknown, where: string): string {
  if (!Array.isArray(value) || value.length < 4) {
    fail(`${where} must be a closed ring of at least 4 [lng, lat] pairs.`);
  }
  const list = value as unknown[];
  const first = position(list[0], `${where}[0]`);
  const last = position(list[list.length - 1], `${where}[${list.length - 1}]`);
  if (first !== last) {
    fail(
      `${where} is not closed: it starts at (${first}) and ends at (${last}). A polygon ring ` +
        `must repeat its first position as its last.`,
    );
  }
  return `(${positions(list, where, 4)})`;
}

/** `(ring), (ring)` — one polygon's outer ring plus any holes. */
function rings(value: unknown, where: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} must be an array of at least one ring.`);
  }
  return (value as unknown[]).map((r, i) => ring(r, `${where}[${i}]`)).join(", ");
}

/** The WKT body for a geometry, without its keyword. */
function body(geometry: GeoJsonGeometry): string {
  switch (geometry.type) {
    case "Point":
      return `(${position(geometry.coordinates, "coordinates")})`;
    case "MultiPoint":
    case "LineString":
      return `(${positions(geometry.coordinates, "coordinates", 2)})`;
    case "MultiLineString":
      return `(${(geometry.coordinates as unknown[])
        .map((l, i) => `(${positions(l, `coordinates[${i}]`, 2)})`)
        .join(", ")})`;
    case "Polygon":
      return `(${rings(geometry.coordinates, "coordinates")})`;
    case "MultiPolygon":
      return `(${(geometry.coordinates as unknown[])
        .map((p, i) => `(${rings(p, `coordinates[${i}]`)})`)
        .join(", ")})`;
    default:
      return fail(
        `unknown geometry type ${JSON.stringify((geometry as { type: unknown }).type)}. ` +
          `Expected one of ${Object.keys(WKT_KEYWORD).join(", ")}.`,
      );
  }
}

/** The WKT text for a GeoJSON geometry — the string the engine accepts. */
export function geoToWkt(geometry: GeoJsonGeometry): string {
  if (!geometry || typeof geometry !== "object") {
    fail(`expected a GeoJSON geometry object, got ${JSON.stringify(geometry)}.`);
  }
  const keyword = WKT_KEYWORD[geometry.type];
  if (keyword === undefined) {
    fail(
      `unknown geometry type ${JSON.stringify((geometry as { type: unknown }).type)}. ` +
        `Expected one of ${Object.keys(WKT_KEYWORD).join(", ")}.`,
    );
  }
  return `${keyword}${body(geometry)}`;
}

/**
 * A value for an `f.geo.*` column, written as GeoJSON.
 *
 * ```ts
 * s.db.add({ table: places, row: { at: geo({ type: "Point", coordinates: [1, 2] }) } })
 * ```
 *
 * The engine accepts only WKT text on write, so this converts and hands back an
 * ordinary text value — there is no separate geo tag on the wire. Coordinates
 * are longitude-first, matching GeoJSON; polygon rings must be closed. Both
 * mistakes are refused here, named, rather than surfacing as an engine parse
 * error after deploy.
 *
 * Raw WKT is still accepted anywhere a value is: `c.text("POINT(1 2)")`. Use
 * that for a form the SDK does not model.
 *
 * ⚠ Reading a geo column back currently returns `null` on every documented path
 * — that is engine-side and this cannot fix it (see the module note).
 */
export function geo(geometry: GeoJsonGeometry): Value {
  return c.text(geoToWkt(geometry));
}
