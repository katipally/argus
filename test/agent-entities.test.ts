import { describe, it, expect } from "vitest";
import { matchEntity, describeEntity, type EntityRow } from "@/src/agent/entities";

describe("matchEntity (filter-any-data predicate)", () => {
  const cargo = { cat: "Cargo", sog: 12.4, dest: "INBOM", mil: 0 };
  const jet = { craft: "F16", alt: 34000, mil: 1, flight: "VIPER1" };

  it("string condition is a case-insensitive substring", () => {
    expect(matchEntity(cargo, { cat: "cargo" })).toBe(true);
    expect(matchEntity(cargo, { dest: "in" })).toBe(true);
    expect(matchEntity(cargo, { cat: "tanker" })).toBe(false);
  });
  it("number condition is loose equality; boolean maps 0/1", () => {
    expect(matchEntity(jet, { mil: 1 })).toBe(true);
    expect(matchEntity(jet, { mil: true })).toBe(true);
    expect(matchEntity(cargo, { mil: true })).toBe(false);
  });
  it("object condition does min/max/eq/contains", () => {
    expect(matchEntity(jet, { alt: { min: 30000 } })).toBe(true);
    expect(matchEntity(jet, { alt: { min: 40000 } })).toBe(false);
    expect(matchEntity(cargo, { sog: { min: 10, max: 15 } })).toBe(true);
    expect(matchEntity(cargo, { dest: { contains: "bom" } })).toBe(true);
  });
  it("ANDs all conditions", () => {
    expect(matchEntity(jet, { mil: 1, alt: { min: 30000 } })).toBe(true);
    expect(matchEntity(jet, { mil: 1, alt: { min: 40000 } })).toBe(false);
  });
});

describe("describeEntity (live panel content)", () => {
  it("formats a plane with route + altitude", () => {
    const e: EntityRow = { id: "abc123", title: "VIPER1", center: [10, 50], props: { flight: "VIPER1", craft: "F16", alt: 34000, gs: 450, track: 90, mil: 1, from: "DE", to: "IN" } };
    const info = describeEntity("planes", e);
    expect(info.title).toBe("VIPER1");
    expect(info.rows).toContainEqual(["Route", "DE → IN"]);
    expect(info.rows.find((r) => r[0] === "Altitude")?.[1]).toContain("34,000");
    expect(info.subtitle).toContain("MIL");
  });
  it("formats a ship with type + destination", () => {
    const e: EntityRow = { id: "412", title: "EVER GIVEN", center: [32, 30], props: { name: "EVER GIVEN", cat: "Cargo", sog: 11.2, cog: 145, dest: "NLRTM" } };
    const info = describeEntity("ships", e);
    expect(info.rows).toContainEqual(["Destination", "NLRTM"]);
    expect(info.rows.find((r) => r[0] === "Speed")?.[1]).toContain("11.2");
  });
});
