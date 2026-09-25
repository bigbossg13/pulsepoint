import assert from "node:assert/strict";
import { test } from "node:test";
import { selection } from "../lib/ftcscout.js";

const schema = new Map([
  ["Team", new Map([["number", "Int"], ["name", "String"], ["location", "Location"], ["quickStats", "QuickStats"]])],
  ["Location", new Map([["city", "String"], ["state", "String"], ["country", "String"]])],
  ["QuickStats", new Map([["tot", "QuickStat"], ["count", "Int"]])],
  ["QuickStat", new Map([["value", "Float"], ["rank", "Int"]])],
]);

test("selection keeps only fields that exist in the schema", () => {
  const sel = selection(schema, "Team", [
    "number", "name", "city", ["location", ["venue", "city", "state"]],
    ["quickStats", [["tot", ["value", "rank"]], ["auto", ["value"]], "count"], "(season: 2025)"],
  ]);
  assert.equal(sel, "number name location { city state } quickStats(season: 2025) { tot { value rank } count }");
});

test("selection drops object fields whose sub-selection would be empty", () => {
  assert.equal(selection(schema, "Team", ["number", ["location", ["zip"]]]), "number");
});
